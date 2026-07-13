import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import {
  Aggregates,
  emptyAggregates,
  PrLink,
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

// Parse a single session .jsonl file in one streaming pass. Never loads the
// whole file into memory (some are >10MB). Returns a fully-populated Session.
export async function parseSessionFile(
  filePath: string,
  encodedDir: string,
  mtimeMs: number,
  sizeBytes: number,
  thresholds: StatusThresholds,
  now: number
): Promise<Session> {
  const sessionId = path.basename(filePath, ".jsonl");
  const agg = emptyAggregates();
  const cwdCounts = new Map<string, number>();
  const modelCounts = new Map<string, number>(); // distinct-message count per real model
  const filesTouched = new Set<string>();
  const seenUsageIds = new Set<string>(); // dedup multi-line messages sharing one usage object
  // Maps an in-flight tool_use id to its tool name so the matching tool_result
  // (a later user record) can attribute its payload size to the right tool.
  // Entries are deleted once consumed, so the map stays small.
  const pendingToolUse = new Map<string, string>();
  const prUrls = new Set<string>(); // dedup repeated pr-link records
  let title: string | undefined;
  let lastPrompt: string | undefined;
  let gitBranch: string | undefined;
  let version: string | undefined;
  let firstTs: string | undefined;
  let lastTs: string | undefined;

  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  let streamErr: Error | undefined;
  stream.on("error", (e) => {
    streamErr = e instanceof Error ? e : new Error(String(e));
  });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line) {
      continue;
    }
    let rec: any;
    try {
      rec = JSON.parse(line);
    } catch {
      continue; // skip malformed / binary-ish lines
    }
    const type = rec.type;
    // Only records that mark REAL liveness define activity time. Conversation
    // (user/assistant) obviously; queue-operation = the human queued/removed a
    // prompt; system = the harness did something (api_error retries, hook runs)
    // proving the process is alive. Non-conversational REWRITES
    // (file-history-snapshot, ai-title) carry timestamps too and would
    // otherwise push endedAt forward, causing false "active" status.
    const ts: string | undefined = rec.timestamp;
    if (ts && (type === "user" || type === "assistant" || type === "system" || type === "queue-operation")) {
      if (!firstTs) {
        firstTs = ts;
      }
      lastTs = ts;
    }

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
        const firstSeen = !usageKey || !seenUsageIds.has(usageKey);
        if (usageKey) {
          seenUsageIds.add(usageKey);
        }
        if (firstSeen) {
          const u = msg.usage;
          if (u) {
            agg.tokens.inputTokens += num(u.input_tokens);
            agg.tokens.outputTokens += num(u.output_tokens);
            agg.tokens.cacheCreationInputTokens += num(u.cache_creation_input_tokens);
            agg.tokens.cacheReadInputTokens += num(u.cache_read_input_tokens);
          }
          // Skip the placeholder "<synthetic>" model (zero-usage, never selected).
          if (typeof msg.model === "string" && msg.model && msg.model !== "<synthetic>") {
            modelCounts.set(msg.model, (modelCounts.get(msg.model) ?? 0) + 1);
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
                pendingToolUse.set(c.id, n);
              }
              if (INPUT_PROMPT_TOOLS.has(n)) {
                blockedOnUser = true;
              }
            }
          }
        }
        agg.awaitingInput = blockedOnUser;
      }
      collectContext(rec, cwdCounts, (b) => (gitBranch = b ?? gitBranch), (v) => (version = v ?? version));
    } else if (type === "user") {
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
            const name = pendingToolUse.get(c.tool_use_id);
            if (name) {
              pendingToolUse.delete(c.tool_use_id);
              agg.toolCharsByName[name] = (agg.toolCharsByName[name] ?? 0) + jsonChars(c.content);
            }
          }
        }
      }
      collectContext(rec, cwdCounts, (b) => (gitBranch = b ?? gitBranch), (v) => (version = v ?? version));
    } else if (type === "attachment") {
      collectContext(rec, cwdCounts, (b) => (gitBranch = b ?? gitBranch), (v) => (version = v ?? version));
    } else if (type === "ai-title") {
      if (typeof rec.aiTitle === "string" && rec.aiTitle.trim()) {
        title = rec.aiTitle.trim();
      }
    } else if (type === "last-prompt") {
      if (typeof rec.lastPrompt === "string" && rec.lastPrompt.trim()) {
        lastPrompt = rec.lastPrompt.trim();
      }
    } else if (type === "pr-link") {
      const prUrl = String(rec.prUrl ?? "");
      // The same PR is re-emitted many times; keep one entry per URL.
      if (prUrl && !prUrls.has(prUrl)) {
        prUrls.add(prUrl);
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
          filesTouched.add(k);
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

  if (streamErr) {
    throw streamErr; // disk error / file removed mid-read — caller skips this file
  }

  // Most-used real model first → models[0] drives display + cost rate.
  agg.models = [...modelCounts.entries()].sort((a, b) => b[1] - a[1]).map(([m]) => m);
  agg.filesTouched = filesTouched.size;
  agg.startedAt = firstTs;
  agg.endedAt = lastTs;

  // Collapse every recorded cwd onto its enclosing git repo root before picking
  // the winner. Without this, a session whose agent `cd`'d into a subdir (e.g.
  // ./backend) can have MORE records under the subdir than the repo root, so the
  // raw most-frequent cwd points at the subfolder — spawning a phantom project
  // group named after it. Summing counts per root makes repo-root selection
  // robust to mid-session directory changes.
  const rootCounts = new Map<string, number>();
  for (const [c, n] of cwdCounts) {
    const root = resolveRepoRoot(c);
    rootCounts.set(root, (rootCounts.get(root) ?? 0) + n);
  }
  const cwd = mostFrequent(rootCounts);
  const cwdVerified = cwd !== undefined;
  const costUsd = estimateCost(agg.tokens, agg.models);
  const subagents = await readSubagents(filePath, sessionId);
  agg.hasSidechain = subagents.length > 0;
  const status = computeStatus(lastActivityMs(agg, mtimeMs), agg, thresholds, now);

  return {
    sessionId,
    filePath,
    encodedDir,
    cwd,
    cwdVerified,
    gitBranch,
    version,
    title,
    lastPrompt,
    status,
    mtimeMs,
    sizeBytes,
    aggregates: agg,
    subagents,
    costUsd,
  };
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
  now: number
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
    // still queued: the harness is about to dequeue the next one, so the
    // session is mid-flight, not "your move". Without this, every turn boundary
    // of a queued-up session flashes pendingReview until the dequeue lands.
    // Depth is only trusted while recent: if the harness were alive it would
    // have dequeued within seconds, so an old positive depth is stale noise.
    if (cleanEnd) {
      return agg.queueDepth > 0 ? "active" : "finished";
    }
    // Dangling turn = still actively working (a tool is running / mid-stream).
    return "active";
  }
  if (cleanEnd) {
    return "finished";
  }
  // Dangling and quiet past activeMs. If the tail is an unanswered tool_use,
  // a tool is (very likely) still executing — tool calls append nothing while
  // they run, so silence here is normal. Stay active within the tool grace
  // window instead of flapping to interrupted at activeMs.
  const toolInFlight = agg.lastConvRole === "assistant" && agg.lastStopReason === "tool_use";
  if (toolInFlight && age <= Math.max(TOOL_RUNNING_GRACE_MS, thresholds.activeMs)) {
    return "active";
  }
  // A dangling turn that truly stopped getting written: window died, API error,
  // or an ESC with no marker — incomplete, resumable.
  return "interrupted";
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

function collectContext(
  rec: any,
  cwdCounts: Map<string, number>,
  setBranch: (b?: string) => void,
  setVersion: (v?: string) => void
): void {
  if (typeof rec.cwd === "string" && rec.cwd) {
    cwdCounts.set(rec.cwd, (cwdCounts.get(rec.cwd) ?? 0) + 1);
  }
  if (typeof rec.gitBranch === "string" && rec.gitBranch) {
    setBranch(rec.gitBranch);
  }
  if (typeof rec.version === "string" && rec.version) {
    setVersion(rec.version);
  }
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
