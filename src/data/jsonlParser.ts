import * as fs from "fs";
import * as path from "path";
import {
  Aggregates,
  emptyAggregates,
  RunningAgent,
  RunningWorkflow,
  Session,
  SessionStatus,
  SubagentInfo,
} from "../model/types";
import { estimateCost } from "../model/pricing";
import { resolveRepoRoot } from "./paths";

export interface StatusThresholds {
  activeMs: number;
  idleMs: number;
}

// Cap on the consumed-bytes signature used to detect in-place rewrites (see
// SessionParser.tail). The verified window is the LAST CONSUMED LINE (capped
// here): jsonl line endings are near-constant ("}]}}"-style suffixes), so a
// short fixed window can collide across same-length records — a full line
// carries timestamp/message-id and only matches if the same record still ends
// at the same offset. The cap bounds the re-read when the last line is a huge
// tool_result.
const TAIL_SIG_BYTES = 4096;

// Incremental streaming parser for a session .jsonl file. Never loads the whole
// file into memory (some are >10MB) AND never re-reads bytes it has already
// consumed: feed() picks up at the byte offset where the previous feed()
// stopped, so a live session that appends a few KB between watcher events costs
// a few KB of parsing, not a full multi-MB re-parse. finalize() can be called
// after every feed() and produces an independent Session snapshot.
//
// Only COMPLETE (newline-terminated) lines are consumed; a partial line at EOF
// (a record mid-write) stays unconsumed and is re-read by the next feed(), so
// no record is ever lost or double-counted across incremental feeds.
export class SessionParser {
  private readonly agg = emptyAggregates();
  private readonly cwdCounts = new Map<string, number>();
  private readonly modelCounts = new Map<string, number>(); // distinct-message count per real model
  private readonly filesTouched = new Set<string>();
  private readonly seenUsageIds = new Set<string>(); // dedup multi-line messages sharing one usage object
  // Maps an in-flight tool_use id to its tool name so the matching tool_result
  // (a later user record) can attribute its payload size to the right tool.
  // Entries are deleted once consumed, so the map stays small.
  private readonly pendingToolUse = new Map<string, string>();
  private readonly prUrls = new Set<string>(); // dedup repeated pr-link records
  private title: string | undefined;
  private lastPrompt: string | undefined;
  private gitBranch: string | undefined;
  private version: string | undefined;
  private firstTs: string | undefined;
  private lastTs: string | undefined;
  private offset = 0; // absolute file offset of the first unconsumed byte
  // Last ≤TAIL_SIG_BYTES consumed bytes (always ends on the '\n' that closed
  // the last consumed line). tailIntact() re-reads these bytes from disk to
  // detect a file that was REWRITTEN in place (e.g. /rewind truncates and
  // re-appends): offset/size checks miss a shrink-then-regrow between watcher
  // events, and feeding from a stale offset would parse garbage — worse, the
  // garbage aggregates get cached by (mtime,size) and the wrong status sticks.
  private tail = Buffer.alloc(0);
  // Byte length (incl. '\n') of the last fully consumed line — the verified
  // window is min(this, tail length): one whole line, not a fixed suffix.
  private lastLineBytes = 0;

  constructor(
    readonly filePath: string,
    readonly encodedDir: string
  ) {}

  get byteOffset(): number {
    return this.offset;
  }

  // True when the on-disk bytes immediately before `offset` still match what
  // this parser consumed — i.e. the file only grew by appends. False means the
  // file was rewritten and the parser state is invalid (caller starts fresh).
  async tailIntact(): Promise<boolean> {
    const sigLen = Math.min(this.lastLineBytes, this.tail.length);
    if (this.offset === 0 || sigLen === 0) {
      return true;
    }
    const sig = this.tail.subarray(this.tail.length - sigLen);
    let fh: fs.promises.FileHandle | undefined;
    try {
      fh = await fs.promises.open(this.filePath, "r");
      const buf = Buffer.alloc(sigLen);
      const { bytesRead } = await fh.read(buf, 0, sigLen, this.offset - sigLen);
      return bytesRead === sigLen && buf.equals(sig);
    } catch {
      return false; // unreadable right now — treat as rewritten, full reparse
    } finally {
      await fh?.close().catch(() => undefined);
    }
  }

  // Keep the rolling last-consumed-bytes signature current. Copies (never
  // subarray-views) so a 32-byte signature doesn't pin a whole stream chunk.
  private pushTail(consumed: Buffer): void {
    if (consumed.length === 0) {
      return;
    }
    if (consumed.length >= TAIL_SIG_BYTES) {
      this.tail = Buffer.from(consumed.subarray(consumed.length - TAIL_SIG_BYTES));
      return;
    }
    const joined = Buffer.concat([this.tail, consumed]);
    this.tail = Buffer.from(joined.subarray(Math.max(0, joined.length - TAIL_SIG_BYTES)));
  }

  // Consume everything appended since the last feed(). Throws on stream errors
  // (disk error / file removed mid-read) — caller drops this parser.
  async feed(): Promise<void> {
    const stream = fs.createReadStream(this.filePath, { start: this.offset });
    let pos = this.offset; // absolute offset of buf[0]
    let leftover: Buffer | undefined;
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      const buf = leftover?.length ? Buffer.concat([leftover, chunk]) : chunk;
      let lineStart = 0;
      let nl: number;
      while ((nl = buf.indexOf(0x0a, lineStart)) !== -1) {
        this.processLine(buf.subarray(lineStart, nl).toString("utf8"));
        this.lastLineBytes = nl - lineStart + 1; // leftover was prepended, so this spans the whole line
        lineStart = nl + 1;
      }
      this.pushTail(buf.subarray(0, lineStart));
      pos += lineStart;
      leftover = lineStart < buf.length ? buf.subarray(lineStart) : undefined;
    }
    this.offset = pos;
  }

  private processLine(raw: string): void {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (!line) {
      return;
    }
    let rec: any;
    try {
      rec = JSON.parse(line);
    } catch {
      return; // skip malformed / binary-ish lines
    }
    const type = rec.type;
    // Synthetic user records (command echoes, task notifications, IDE context
    // injections — see isSyntheticEcho) opened no conversational turn. They
    // must not touch role/stop/awaiting/interrupted state (a tail echo
    // otherwise reads as a dangling turn -> false interrupted, and it clears a
    // pending "awaiting") nor move the activity watermark (which would flip a
    // reviewed session back to pendingReview).
    const syntheticEcho = type === "user" && isSyntheticEcho(rec.message);
    // Only records that mark REAL liveness define activity time. Conversation
    // (user/assistant) obviously; queue-operation = the human queued/removed a
    // prompt; system records only for subtypes that prove a turn is in flight
    // (see LIVENESS_SYSTEM_SUBTYPES — post-hoc annotations like away_summary
    // are written minutes AFTER the turn ended and must not count).
    // Non-conversational REWRITES (file-history-snapshot, ai-title) carry
    // timestamps too and would otherwise push endedAt forward, causing false
    // "active" status.
    const ts: string | undefined = rec.timestamp;
    const isLive =
      type === "user"
        ? !syntheticEcho
        : type === "assistant" || type === "queue-operation"
          ? true
          : type === "system" && LIVENESS_SYSTEM_SUBTYPES.has(String(rec.subtype));
    if (ts && isLive) {
      if (!this.firstTs) {
        this.firstTs = ts;
      }
      this.lastTs = ts;
    }

    const agg = this.agg;
    if (type === "assistant") {
      agg.assistantTurns++;
      agg.lastConvRole = "assistant";
      // The agent spoke again, so any earlier interrupt was resumed past.
      agg.interrupted = false;
      const msg = rec.message;
      if (msg) {
        // stop_reason on the final assistant record tells working vs finished.
        agg.lastStopReason = typeof msg.stop_reason === "string" ? msg.stop_reason : undefined;
        // A multi-block assistant message is written as N lines sharing ONE
        // message.id with an IDENTICAL usage object — count usage/model once.
        const usageKey = typeof msg.id === "string" && msg.id ? msg.id : rec.uuid;
        const firstSeen = !usageKey || !this.seenUsageIds.has(usageKey);
        if (usageKey) {
          this.seenUsageIds.add(usageKey);
        }
        if (firstSeen) {
          const u = msg.usage;
          if (u) {
            agg.tokens.inputTokens += num(u.input_tokens);
            agg.tokens.outputTokens += num(u.output_tokens);
            agg.tokens.cacheCreationInputTokens += num(u.cache_creation_input_tokens);
            agg.tokens.cacheReadInputTokens += num(u.cache_read_input_tokens);
            // Live context = the latest call's full prompt + its output.
            // Last-write-wins across usage-bearing records; zero-usage
            // records (synthetic placeholders) must not wipe it.
            const ctx =
              num(u.input_tokens) +
              num(u.cache_read_input_tokens) +
              num(u.cache_creation_input_tokens) +
              num(u.output_tokens);
            if (ctx > 0) {
              agg.lastContextTokens = ctx;
            }
          }
          // Skip the placeholder "<synthetic>" model (zero-usage, never selected).
          if (typeof msg.model === "string" && msg.model && msg.model !== "<synthetic>") {
            this.modelCounts.set(msg.model, (this.modelCounts.get(msg.model) ?? 0) + 1);
            // Last-write-wins: the session's CURRENT model (tracks /model switches).
            agg.lastModel = msg.model;
          }
        }
        // tool_use blocks ARE genuinely one-per-line — count every line.
        // Also note if this turn ended by blocking on the user (a question /
        // plan approval). Such a tool_use is the last block of the turn and is
        // followed by a user tool_result once answered, so last-write-wins on
        // `awaitingInput` across assistant records is correct: it stays true
        // only while the prompt sits unanswered at the conversation tail.
        let blockedOnUser = false;
        if (Array.isArray(msg.content)) {
          for (const c of msg.content) {
            if (c && c.type === "tool_use") {
              agg.toolCalls++;
              const n = typeof c.name === "string" ? c.name : "unknown";
              agg.toolCallsByName[n] = (agg.toolCallsByName[n] ?? 0) + 1;
              agg.toolCharsByName[n] = (agg.toolCharsByName[n] ?? 0) + jsonChars(c.input);
              if (typeof c.id === "string" && c.id) {
                this.pendingToolUse.set(c.id, n);
              }
              if (INPUT_PROMPT_TOOLS.has(n)) {
                blockedOnUser = true;
              }
            }
          }
        }
        agg.awaitingInput = blockedOnUser;
      }
      this.collectContext(rec);
    } else if (type === "user") {
      if (syntheticEcho) {
        // Still worth harvesting cwd/branch, but none of the conversational
        // state below may change: the session is exactly as finished /
        // awaiting / interrupted as it was before the command ran.
        this.collectContext(rec);
        return;
      }
      agg.lastConvRole = "user";
      agg.lastStopReason = undefined;
      // A user record after a prompt = the prompt was answered (or a new human
      // turn began); either way the agent is no longer blocked on you.
      agg.awaitingInput = false;
      // An interrupt marker ("[Request interrupted by user]") is the synthetic
      // record Claude Code writes when you hit ESC mid-turn. Last-write-wins, so
      // this stays true only while it sits at the conversation tail; a real
      // prompt or assistant reply after it clears the flag.
      const interrupt = isInterruptMarker(rec.message);
      agg.interrupted = interrupt;
      // Only count real human prompts — most user records are tool_result echoes,
      // and the interrupt marker isn't a prompt either.
      if (!interrupt && isRealPrompt(rec.message)) {
        agg.turns++;
      }
      // tool_result echoes carry the tool's output back into context — that
      // payload is what actually costs input tokens. Attribute its size to the
      // tool that produced it via the pending tool_use id.
      const uc = rec.message?.content;
      if (Array.isArray(uc)) {
        for (const c of uc) {
          if (c && c.type === "tool_result" && typeof c.tool_use_id === "string") {
            const name = this.pendingToolUse.get(c.tool_use_id);
            if (name) {
              this.pendingToolUse.delete(c.tool_use_id);
              agg.toolCharsByName[name] = (agg.toolCharsByName[name] ?? 0) + jsonChars(c.content);
            }
          }
        }
      }
      this.collectContext(rec);
    } else if (type === "attachment") {
      this.collectContext(rec);
    } else if (type === "ai-title") {
      if (typeof rec.aiTitle === "string" && rec.aiTitle.trim()) {
        this.title = rec.aiTitle.trim();
      }
    } else if (type === "last-prompt") {
      if (typeof rec.lastPrompt === "string" && rec.lastPrompt.trim()) {
        this.lastPrompt = rec.lastPrompt.trim();
      }
    } else if (type === "pr-link") {
      const prUrl = String(rec.prUrl ?? "");
      // The same PR is re-emitted many times; keep one entry per URL.
      if (prUrl && !this.prUrls.has(prUrl)) {
        this.prUrls.add(prUrl);
        agg.prLinks.push({
          prNumber: num(rec.prNumber),
          prUrl,
          prRepository: String(rec.prRepository ?? ""),
          timestamp: String(rec.timestamp ?? ""),
        });
      }
    } else if (type === "file-history-snapshot") {
      const backups = rec.snapshot?.trackedFileBackups;
      if (backups && typeof backups === "object") {
        for (const k of Object.keys(backups)) {
          this.filesTouched.add(k);
        }
      }
    } else if (type === "queue-operation") {
      if (typeof rec.operation === "string") {
        agg.lastQueueOp = rec.operation;
        // Net queued-prompt depth. A clean-ended turn with prompts still queued
        // is NOT "your move" — the harness will dequeue and keep working, so
        // computeStatus treats depth > 0 as still active. Clamped: dequeue and
        // remove balance enqueue, and a lost/duplicated record must not wedge
        // the depth negative or permanently positive.
        if (rec.operation === "enqueue") {
          agg.queueDepth++;
        } else if (rec.operation === "dequeue" || rec.operation === "remove") {
          agg.queueDepth = Math.max(0, agg.queueDepth - 1);
        }
      }
    }
  }

  private collectContext(rec: any): void {
    if (typeof rec.cwd === "string" && rec.cwd) {
      this.cwdCounts.set(rec.cwd, (this.cwdCounts.get(rec.cwd) ?? 0) + 1);
    }
    if (typeof rec.gitBranch === "string" && rec.gitBranch) {
      this.gitBranch = rec.gitBranch;
    }
    if (typeof rec.version === "string" && rec.version) {
      this.version = rec.version;
    }
  }

  // Produce a Session snapshot from the state accumulated so far. Does NOT
  // mutate parser state (the aggregates are deep-cloned), so feed()/finalize()
  // can keep alternating on a live file.
  async finalize(
    mtimeMs: number,
    sizeBytes: number,
    thresholds: StatusThresholds,
    now: number
  ): Promise<Session> {
    const sessionId = path.basename(this.filePath, ".jsonl");
    const agg = structuredClone(this.agg);

    // Most-used real model first → models[0] drives display + cost rate.
    agg.models = [...this.modelCounts.entries()].sort((a, b) => b[1] - a[1]).map(([m]) => m);
    agg.filesTouched = this.filesTouched.size;
    agg.startedAt = this.firstTs;
    agg.endedAt = this.lastTs;

    // Collapse every recorded cwd onto its enclosing git repo root before picking
    // the winner. Without this, a session whose agent `cd`'d into a subdir (e.g.
    // ./backend) can have MORE records under the subdir than the repo root, so the
    // raw most-frequent cwd points at the subfolder — spawning a phantom project
    // group named after it. Summing counts per root makes repo-root selection
    // robust to mid-session directory changes.
    const rootCounts = new Map<string, number>();
    for (const [c, n] of this.cwdCounts) {
      const root = resolveRepoRoot(c);
      rootCounts.set(root, (rootCounts.get(root) ?? 0) + n);
    }
    const cwd = mostFrequent(rootCounts);
    const cwdVerified = cwd !== undefined;
    const costUsd = estimateCost(agg.tokens, agg.models);
    const subagents = await readSubagents(this.filePath, sessionId);
    agg.hasSidechain = subagents.length > 0;
    const status = computeStatus(lastActivityMs(agg, mtimeMs), agg, thresholds, now);

    return {
      sessionId,
      filePath: this.filePath,
      encodedDir: this.encodedDir,
      cwd,
      cwdVerified,
      gitBranch: this.gitBranch,
      version: this.version,
      title: this.title,
      lastPrompt: this.lastPrompt,
      status,
      mtimeMs,
      sizeBytes,
      aggregates: agg,
      subagents,
      // Live sidechain state is the store's business (status-time probe);
      // a bare parse carries none.
      runningAgents: [],
      runningWorkflows: [],
      costUsd,
    };
  }
}

// Parse a session .jsonl file in one full streaming pass (cold-scan path).
export async function parseSessionFile(
  filePath: string,
  encodedDir: string,
  mtimeMs: number,
  sizeBytes: number,
  thresholds: StatusThresholds,
  now: number
): Promise<Session> {
  const parser = new SessionParser(filePath, encodedDir);
  await parser.feed();
  return parser.finalize(mtimeMs, sizeBytes, thresholds, now);
}

// Effective last-activity time: prefer the last record that carried a real
// timestamp (a conversation/queue event). Falls back to file mtime only when no
// timestamped record was seen. This avoids false "active" when a file's mtime is
// bumped by non-conversational rewrites (title regen, history snapshots).
export function lastActivityMs(agg: Aggregates, mtimeMs: number): number {
  if (agg.endedAt) {
    const t = Date.parse(agg.endedAt);
    if (!Number.isNaN(t)) {
      return t;
    }
  }
  return mtimeMs;
}

// system-record subtypes that prove a turn is IN FLIGHT (api retry loops write
// only these between attempts) and so count as liveness. Everything else is a
// post-hoc annotation written AFTER the turn ended — stop_hook_summary /
// turn_duration land ms after end_turn (harmless but useless), and
// away_summary lands MINUTES later (observed 3+ min: it's generated when you
// come back to the session), which moved the activity watermark past the
// user's "seen" mark and flipped reviewed sessions back to pendingReview.
// Whitelist, not blacklist: an unknown future subtype defaulting to liveness
// would reintroduce that bug class, while defaulting to non-liveness costs at
// worst a slightly early interrupted flag (already cushioned by the tool-run
// grace below).
const LIVENESS_SYSTEM_SUBTYPES = new Set(["api_error", "model_refusal_fallback"]);

// stop_reason values that mean the assistant turn ended on its own (task done,
// ball in the user's court). Anything else recent = a turn is still in flight.
// Deliberately NOT here: "max_tokens" (output truncated — incomplete, so the
// dangling path's recent=active → quiet=interrupted is the honest read) and
// "pause_turn" (server paused a long turn; the harness auto-continues, so it
// should read active while recent).
const FINISHED_STOP_REASONS = new Set(["end_turn", "stop_sequence", "refusal"]);

// How long a tail-of-file tool_use may sit unanswered before we stop believing
// a tool is still running and call the session interrupted. Tool calls write
// NOTHING to the jsonl while they run (a build, a subagent, a long MCP call can
// legitimately take tens of minutes), so the ordinary activeMs window (default
// 5 min) is far too eager — this was the main source of working sessions
// mislabelled interrupted. Bounded so a window killed mid-tool still degrades
// to interrupted rather than showing active for the whole idle window.
const TOOL_RUNNING_GRACE_MS = 30 * 60_000;

// Tool calls that pause the agent ON the user: it asked a question or requested
// plan approval and cannot proceed until you respond. This is a genuine
// "awaiting input", distinct from a turn that simply finished.
const INPUT_PROMPT_TOOLS = new Set(["AskUserQuestion", "ExitPlanMode"]);

export function computeStatus(
  lastActivityMs: number,
  agg: Pick<Aggregates, "lastConvRole" | "lastStopReason" | "awaitingInput" | "interrupted" | "queueDepth">,
  thresholds: StatusThresholds,
  now: number,
  // Newest mtime among the session's subagent sidechain logs (0 = none). NOT
  // part of the cached aggregates: sidechains change without the main jsonl
  // moving, so callers probe it fresh (probeSidechain) per evaluation.
  sidechainActivityMs = 0
): SessionStatus {
  const age = now - lastActivityMs;
  // Stale: no conversational activity for longer than the idle window (default
  // 24h). Hidden by default in the sidebar.
  if (age > thresholds.idleMs) {
    return "idle";
  }
  // Explicitly interrupted (user hit ESC): definitive, surface it at any recency
  // so it doesn't masquerade as "active" for the first few minutes.
  if (agg.interrupted) {
    return "interrupted";
  }
  // Blocked on you (it asked a question / wants plan approval): surface as
  // "awaiting" regardless of recency — it needs you until answered or stale.
  if (agg.awaitingInput && agg.lastConvRole === "assistant") {
    return "awaiting";
  }
  // Background subagents write ONLY their sidechain logs while the main jsonl
  // sits at a clean turn end (the harness re-invokes the conversation via a
  // task notification when they finish). A sidechain written more recently
  // than the conversation, and recently in absolute terms, means work is still
  // in flight — without this the session reads finished/pendingReview while
  // its agents are visibly running.
  const sidechainBusy =
    sidechainActivityMs > lastActivityMs && now - sidechainActivityMs <= thresholds.activeMs;
  // A cleanly-ended turn = the last conversational record is an assistant
  // message with a terminal stop_reason. Anything else means the turn never
  // closed: a tool_use awaiting its result, a cut-off stream, an API error, or
  // a user record with no assistant reply.
  const cleanEnd =
    agg.lastConvRole === "assistant" &&
    !!agg.lastStopReason &&
    FINISHED_STOP_REASONS.has(agg.lastStopReason);
  if (age <= thresholds.activeMs) {
    // Recent. A clean end normally means finished — EXCEPT when prompts are
    // still queued (the harness is about to dequeue the next one) or subagents
    // are still writing: the session is mid-flight, not "your move". Without
    // this, every turn boundary of a queued-up session flashes pendingReview
    // until the dequeue lands. Depth is only trusted while recent: if the
    // harness were alive it would have dequeued within seconds, so an old
    // positive depth is stale noise.
    if (cleanEnd) {
      return agg.queueDepth > 0 || sidechainBusy ? "active" : "finished";
    }
    // Dangling turn = still actively working (a tool is running / mid-stream).
    return "active";
  }
  if (cleanEnd) {
    return sidechainBusy ? "active" : "finished";
  }
  // Dangling and quiet past activeMs. If the tail is an unanswered tool_use,
  // a tool is (very likely) still executing — tool calls append nothing while
  // they run, so silence here is normal. Stay active within the tool grace
  // window instead of flapping to interrupted at activeMs. Freshly written
  // sidechains extend the grace indefinitely: a foreground agent fan-out
  // (workflows) legitimately runs for hours, and its sidechain writes prove
  // the tool call is still alive.
  const toolInFlight = agg.lastConvRole === "assistant" && agg.lastStopReason === "tool_use";
  if (toolInFlight && (age <= Math.max(TOOL_RUNNING_GRACE_MS, thresholds.activeMs) || sidechainBusy)) {
    return "active";
  }
  // A dangling turn that truly stopped getting written: window died, API error,
  // or an ESC with no marker — incomplete, resumable.
  return "interrupted";
}

export interface SidechainProbe {
  // Newest mtime among the session's agent-*.jsonl logs (Agent-tool AND live
  // workflow runs); 0 when none exist.
  newestMtimeMs: number;
  // Agents whose logs were written within the active window (and not marked
  // stoppedByUser in their meta), newest first — "running right now".
  // Workflow agents are NOT in here; they're grouped under `workflows`.
  running: RunningAgent[];
  // Workflow-tool runs with agents writing within the active window,
  // newest first.
  workflows: RunningWorkflow[];
}

// Probe a session's subagent sidechain (<projectDir>/<sessionId>/subagents/).
// Runs at STATUS time, not parse time: sidechains change while the main jsonl
// (whose mtime+size keys the parse cache) doesn't move at all. Meta files are
// read only for agents that look live — a handful of ~150-byte reads.
//
// Workflow-tool agents live ONE LEVEL DEEPER than Agent-tool ones:
// <sessionId>/subagents/workflows/<runId>/agent-*.jsonl. A flat readdir missed
// them entirely, so a workflow past the tool grace window flipped its session
// to "interrupted" while dozens of agents were still writing.
export async function probeSidechain(
  filePath: string,
  sessionId: string,
  thresholds: StatusThresholds,
  now: number
): Promise<SidechainProbe> {
  const sessionDir = path.join(path.dirname(filePath), sessionId);
  const dir = path.join(sessionDir, "subagents");
  const top = await scanAgentDir(dir, thresholds, now);
  let newest = top.newestMtimeMs;
  const workflows: RunningWorkflow[] = [];

  let runIds: string[] = [];
  try {
    runIds = await fs.promises.readdir(path.join(dir, "workflows"));
  } catch {
    // no workflows subdir — the common case
  }
  await Promise.all(
    runIds.map(async (runId) => {
      const scan = await scanAgentDir(path.join(dir, "workflows", runId), thresholds, now);
      if (scan.newestMtimeMs === 0) {
        return; // empty run dir
      }
      // The sibling run record knows the run's fate. A terminal run's fresh
      // agent mtimes are just the final flush — counting them as liveness
      // would hold the session "active" for a whole activeMs window after the
      // workflow finished. Missing/unreadable record = assume live (older
      // harnesses may write it only at completion).
      const rec = await readWorkflowRecord(path.join(sessionDir, "workflows", `${runId}.json`));
      if (rec && TERMINAL_WORKFLOW_STATUSES.has(rec.status ?? "")) {
        return;
      }
      if (scan.newestMtimeMs > newest) {
        newest = scan.newestMtimeMs;
      }
      if (scan.running.length === 0) {
        return; // agents all quiet: nothing to show (newest still counted above)
      }
      // Workflow agent metas carry no description; the run record's progress
      // entries do (per-agent labels like "verify:auth.ts").
      for (const a of scan.running) {
        const label = rec?.labels.get(a.id.replace(/^agent-/, ""));
        if (label && !a.description) {
          a.description = label;
        }
      }
      workflows.push({
        runId,
        name: rec?.name,
        status: rec?.status,
        phase: rec?.phase,
        agentCount: rec?.agentCount,
        newestMtimeMs: scan.newestMtimeMs,
        agents: scan.running,
        jsonPath: rec?.jsonPath,
      });
    })
  );
  workflows.sort((a, b) => b.newestMtimeMs - a.newestMtimeMs);
  return { newestMtimeMs: newest, running: top.running, workflows };
}

// One flat directory of agent-*.jsonl logs (+ optional *.meta.json): newest
// mtime across ALL logs, plus the agents still writing within the active
// window, newest first.
async function scanAgentDir(
  dir: string,
  thresholds: StatusThresholds,
  now: number
): Promise<{ newestMtimeMs: number; running: RunningAgent[] }> {
  let entries: string[];
  try {
    entries = await fs.promises.readdir(dir);
  } catch {
    return { newestMtimeMs: 0, running: [] };
  }
  let newest = 0;
  const running: RunningAgent[] = [];
  await Promise.all(
    entries
      .filter((e) => e.endsWith(".jsonl"))
      .map(async (e) => {
        const agentPath = path.join(dir, e);
        let st: fs.Stats;
        try {
          st = await fs.promises.stat(agentPath);
        } catch {
          return; // agent log vanished mid-probe
        }
        if (st.mtimeMs > newest) {
          newest = st.mtimeMs;
        }
        if (now - st.mtimeMs > thresholds.activeMs) {
          return; // quiet: finished (or dead) agent
        }
        const id = path.basename(e, ".jsonl");
        let agentType = "agent";
        let description = "";
        try {
          const meta = JSON.parse(await fs.promises.readFile(path.join(dir, `${id}.meta.json`), "utf8"));
          if (meta.stoppedByUser === true) {
            return; // killed: fresh mtime is just the final flush
          }
          agentType = typeof meta.agentType === "string" && meta.agentType ? meta.agentType : agentType;
          description = typeof meta.description === "string" ? meta.description : "";
        } catch {
          // no/corrupt meta: still show the agent, with placeholder labels
        }
        running.push({ id, agentType, description, filePath: agentPath, mtimeMs: st.mtimeMs });
      })
  );
  running.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return { newestMtimeMs: newest, running };
}

// Run-record statuses that mean "over": agents may have flushed a moment ago,
// but nothing is running. Unknown/missing statuses are treated as live —
// worst case is a stale node that ages out with the active window.
const TERMINAL_WORKFLOW_STATUSES = new Set(["completed", "failed", "error", "cancelled", "killed", "stopped"]);

interface WorkflowRecord {
  jsonPath: string;
  name?: string;
  status?: string;
  phase?: string;
  agentCount?: number;
  labels: Map<string, string>; // agentId (no "agent-" prefix) -> progress label
}

// Best-effort read of a Workflow run record (<sessionId>/workflows/<runId>.json).
// Can be a few hundred KB (embeds the script and result) — read only for runs
// whose agent dir shows recent writes.
async function readWorkflowRecord(jsonPath: string): Promise<WorkflowRecord | undefined> {
  let rec: any;
  try {
    rec = JSON.parse(await fs.promises.readFile(jsonPath, "utf8"));
  } catch {
    return undefined; // not written yet, or torn mid-write — retry next probe
  }
  const labels = new Map<string, string>();
  let phase: string | undefined;
  if (Array.isArray(rec.workflowProgress)) {
    for (const p of rec.workflowProgress) {
      if (!p || typeof p !== "object") {
        continue;
      }
      if (p.type === "workflow_phase" && typeof p.title === "string") {
        phase = p.title; // last one wins = current phase
      } else if (p.type === "workflow_agent" && typeof p.agentId === "string" && typeof p.label === "string") {
        labels.set(p.agentId, p.label);
      }
    }
  }
  return {
    jsonPath,
    name: typeof rec.workflowName === "string" && rec.workflowName ? rec.workflowName : undefined,
    status: typeof rec.status === "string" ? rec.status : undefined,
    phase,
    agentCount: typeof rec.agentCount === "number" ? rec.agentCount : undefined,
    labels,
  };
}

// Claude Code writes a synthetic user text block when a turn is aborted. The
// exact text varies ("[Request interrupted by user]", "...for tool use]"), so
// match the stable prefix.
const INTERRUPT_PREFIX = "[Request interrupted by user";

function isInterruptMarker(message: any): boolean {
  if (!message) {
    return false;
  }
  const content = message.content;
  if (typeof content === "string") {
    return content.trimStart().startsWith(INTERRUPT_PREFIX);
  }
  if (Array.isArray(content)) {
    return content.some(
      (c) =>
        c &&
        c.type === "text" &&
        typeof c.text === "string" &&
        c.text.trimStart().startsWith(INTERRUPT_PREFIX)
    );
  }
  return false;
}

// Synthetic user records Claude Code writes on its own — no human turn opened:
//  - UI command echoes (/model, /mcp …): tag blobs like
//    <command-name>…</command-name><command-message>…, <local-command-stdout>,
//    <local-command-caveat>. Multi-tag, so corroborated by the matching
//    closing tag appearing anywhere in the text.
//  - Standalone notices: <task-notification> (background task finished),
//    <ide_opened_file>/<ide_selection> (IDE context injections). These arrive
//    at arbitrary times AFTER a turn ended (a notification can land hours
//    later; opening files in the IDE writes ide_opened_file records while the
//    session just sits there), so treating them as conversation flipped
//    finished sessions to interrupted/active and reviewed back to
//    pendingReview. Corroborated as the ENTIRE text (closing tag with nothing
//    but whitespace after) so a real prompt that merely pastes such a block
//    and adds commentary still counts as a prompt.
// A record is synthetic only if it has at least one text payload and EVERY
// text payload matches (an ide_selection block bundled with a real typed
// prompt block must count as a real prompt).
const COMMAND_ECHO_FAMILIES = ["command-", "local-command"];
const STANDALONE_SYNTHETIC_TAGS = ["task-notification", "ide_opened_file", "ide_selection"];

function isSyntheticEcho(message: any): boolean {
  const texts = textPayloads(message);
  return texts.length > 0 && texts.every(isSyntheticText);
}

function isSyntheticText(text: string): boolean {
  const t = text.trim();
  if (!t.startsWith("<")) {
    return false;
  }
  for (const fam of COMMAND_ECHO_FAMILIES) {
    if (t.startsWith(`<${fam}`) && t.includes(`</${fam}`)) {
      return true;
    }
  }
  for (const tag of STANDALONE_SYNTHETIC_TAGS) {
    if (t.startsWith(`<${tag}`)) {
      const close = `</${tag}>`;
      const idx = t.indexOf(close);
      if (idx !== -1 && t.slice(idx + close.length).trim() === "") {
        return true;
      }
    }
  }
  return false;
}

// All text payloads of a user message (string content or text blocks).
function textPayloads(message: any): string[] {
  if (!message) {
    return [];
  }
  const content = message.content;
  if (typeof content === "string") {
    return [content];
  }
  const out: string[] = [];
  if (Array.isArray(content)) {
    for (const c of content) {
      if (c && c.type === "text" && typeof c.text === "string") {
        out.push(c.text);
      }
    }
  }
  return out;
}

// A user record is a real human prompt only if it isn't a tool_result echo.
function isRealPrompt(message: any): boolean {
  if (!message) {
    return false;
  }
  const content = message.content;
  if (typeof content === "string") {
    return content.trim().length > 0;
  }
  if (Array.isArray(content)) {
    // Real prompt = has text/image, no tool_result block.
    return !content.some((c) => c && c.type === "tool_result");
  }
  return false;
}

async function readSubagents(filePath: string, sessionId: string): Promise<SubagentInfo[]> {
  const dir = path.join(path.dirname(filePath), sessionId, "subagents");
  const out: SubagentInfo[] = [];
  let entries: string[];
  try {
    entries = await fs.promises.readdir(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.endsWith(".meta.json")) {
      continue;
    }
    try {
      const meta = JSON.parse(await fs.promises.readFile(path.join(dir, e), "utf8"));
      out.push({
        agentType: String(meta.agentType ?? "agent"),
        description: String(meta.description ?? ""),
        file: e,
      });
    } catch {
      // ignore unreadable meta
    }
  }
  return out;
}

function mostFrequent(counts: Map<string, number>): string | undefined {
  let best: string | undefined;
  let bestN = -1;
  for (const [k, n] of counts) {
    if (n > bestN) {
      best = k;
      bestN = n;
    }
  }
  return best;
}

function num(v: unknown): number {
  return typeof v === "number" && isFinite(v) ? v : 0;
}

// Size of a tool payload in characters. Strings are taken as-is; anything else
// (input objects, tool_result block arrays) is measured as serialized JSON,
// skipping base64 image blocks so a screenshot doesn't dwarf every text tool
// (image tokens don't scale with base64 length anyway).
function jsonChars(v: unknown): number {
  if (v === undefined || v === null) {
    return 0;
  }
  if (typeof v === "string") {
    return v.length;
  }
  if (Array.isArray(v)) {
    let total = 0;
    for (const b of v) {
      if (b && typeof b === "object" && (b as any).type === "image") {
        continue;
      }
      total += jsonChars(typeof (b as any)?.text === "string" ? (b as any).text : b);
    }
    return total;
  }
  try {
    return JSON.stringify(v)?.length ?? 0;
  } catch {
    return 0;
  }
}
