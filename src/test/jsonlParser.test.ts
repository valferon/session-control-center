import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  computeStatus,
  lastActivityMs,
  parseSessionFile,
  probeSidechain,
  SessionParser,
  StatusThresholds,
} from "../data/jsonlParser";

const THRESHOLDS: StatusThresholds = { activeMs: 5 * 60_000, idleMs: 24 * 3_600_000 };

// Fixed reference clock; every timestamp in a fixture is expressed relative to
// it so tests are deterministic.
const NOW = Date.parse("2026-01-10T12:00:00.000Z");
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

// --- record builders -------------------------------------------------------

function userPrompt(ts: number, text = "do the thing"): string {
  return JSON.stringify({
    type: "user",
    timestamp: iso(ts),
    message: { role: "user", content: [{ type: "text", text }] },
  });
}

function userToolResult(ts: number, toolUseId = "tu_1"): string {
  return JSON.stringify({
    type: "user",
    timestamp: iso(ts),
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: "ok" }] },
  });
}

function userInterrupt(ts: number): string {
  return JSON.stringify({
    type: "user",
    timestamp: iso(ts),
    message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] },
  });
}

function commandEcho(ts: number, body: string): string {
  return JSON.stringify({
    type: "user",
    timestamp: iso(ts),
    message: { role: "user", content: body },
  });
}

function assistantText(
  ts: number,
  opts: { id?: string; stop?: string | null; usage?: Record<string, number>; model?: string } = {}
): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: iso(ts),
    message: {
      id: opts.id ?? `msg_${ts}`,
      role: "assistant",
      model: opts.model ?? "claude-sonnet-5",
      stop_reason: opts.stop === undefined ? "end_turn" : opts.stop,
      usage: opts.usage ?? { input_tokens: 10, output_tokens: 5 },
      content: [{ type: "text", text: "done" }],
    },
  });
}

function assistantToolUse(ts: number, name: string, opts: { id?: string; toolId?: string; stop?: string | null } = {}): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: iso(ts),
    message: {
      id: opts.id ?? `msg_${ts}`,
      role: "assistant",
      model: "claude-sonnet-5",
      stop_reason: opts.stop === undefined ? "tool_use" : opts.stop,
      usage: { input_tokens: 10, output_tokens: 5 },
      content: [{ type: "tool_use", id: opts.toolId ?? "tu_1", name, input: { q: 1 } }],
    },
  });
}

function systemRec(ts: number, subtype: string): string {
  return JSON.stringify({ type: "system", subtype, timestamp: iso(ts), content: `${subtype} content` });
}

function queueOp(ts: number, operation: string): string {
  return JSON.stringify({ type: "queue-operation", operation, timestamp: iso(ts) });
}

// --- helpers ----------------------------------------------------------------

let tmpRoot: string;
function tmpFile(lines: string[]): string {
  tmpRoot ??= fs.mkdtempSync(path.join(os.tmpdir(), "rooster-test-"));
  const f = path.join(tmpRoot, `${Math.random().toString(36).slice(2)}.jsonl`);
  fs.writeFileSync(f, lines.map((l) => l + "\n").join(""));
  return f;
}

async function parse(lines: string[], now = NOW) {
  const f = tmpFile(lines);
  const st = fs.statSync(f);
  return parseSessionFile(f, "-enc-dir", st.mtimeMs, st.size, THRESHOLDS, now);
}

// --- liveness watermark ------------------------------------------------------

test("post-hoc system records (stop_hook_summary, turn_duration, away_summary) do not move endedAt", async () => {
  const s = await parse([
    userPrompt(-10 * 60_000),
    assistantText(-9 * 60_000),
    systemRec(-9 * 60_000 + 100, "stop_hook_summary"),
    systemRec(-9 * 60_000 + 150, "turn_duration"),
    systemRec(-6 * 60_000, "away_summary"), // 3 min after end — the reviewed->pendingReview flipper
  ]);
  assert.equal(s.aggregates.endedAt, iso(-9 * 60_000));
  // Clean end, quiet past activeMs -> finished (not re-activated by the summary).
  assert.equal(s.status, "finished");
});

test("api_error system records DO move endedAt (retry storm keeps session active)", async () => {
  const s = await parse([
    userPrompt(-10 * 60_000),
    assistantToolUse(-9 * 60_000, "Bash", { stop: null }),
    systemRec(-60_000, "api_error"), // still retrying a minute ago
  ]);
  assert.equal(s.aggregates.endedAt, iso(-60_000));
  assert.equal(s.status, "active"); // dangling + recent
});

// --- local-command echoes -----------------------------------------------------

test("command echo after a clean end keeps the session finished (was: interrupted)", async () => {
  const s = await parse([
    userPrompt(-30 * 60_000),
    assistantText(-29 * 60_000),
    commandEcho(-20 * 60_000, "<command-name>/mcp</command-name><command-message>mcp</command-message>"),
    commandEcho(-20 * 60_000 + 50, "<local-command-stdout>Failed to reconnect: -32000</local-command-stdout>"),
  ]);
  assert.equal(s.aggregates.lastConvRole, "assistant");
  assert.equal(s.aggregates.endedAt, iso(-29 * 60_000));
  assert.equal(s.status, "finished");
  assert.equal(s.aggregates.turns, 1); // echoes are not prompts
});

test("command echo does not clear awaiting", async () => {
  const s = await parse([
    userPrompt(-4 * 60_000),
    assistantToolUse(-3 * 60_000, "AskUserQuestion"),
    commandEcho(-2 * 60_000, "<command-name>/model</command-name>"),
  ]);
  assert.equal(s.aggregates.awaitingInput, true);
  assert.equal(s.status, "awaiting");
});

test("command echo does not clear an interrupt marker", async () => {
  const s = await parse([
    userPrompt(-10 * 60_000),
    assistantToolUse(-9 * 60_000, "Bash", { stop: null }),
    userInterrupt(-8 * 60_000),
    commandEcho(-7 * 60_000, "<command-name>/caveman-stats</command-name>"),
  ]);
  assert.equal(s.aggregates.interrupted, true);
  assert.equal(s.status, "interrupted");
});

test("command echo as text block (not plain string) is also skipped", async () => {
  const f = tmpFile([
    userPrompt(-10 * 60_000),
    assistantText(-9 * 60_000),
    JSON.stringify({
      type: "user",
      timestamp: iso(-5 * 60_000),
      message: { role: "user", content: [{ type: "text", text: "<local-command-caveat>Caveat: local commands</local-command-caveat>" }] },
    }),
  ]);
  const st = fs.statSync(f);
  const s = await parseSessionFile(f, "-enc", st.mtimeMs, st.size, THRESHOLDS, NOW);
  assert.equal(s.aggregates.lastConvRole, "assistant");
  assert.equal(s.status, "finished");
});

test("task-notification / ide_opened_file / ide_selection records do not open a turn", async () => {
  const s = await parse([
    userPrompt(-30 * 60_000),
    assistantText(-29 * 60_000),
    commandEcho(-20 * 60_000, "<task-notification>Background task finished: build ok</task-notification>"),
    commandEcho(-10 * 60_000, "<ide_opened_file>The user opened /a/b.ts in the IDE.</ide_opened_file>"),
    commandEcho(-9 * 60_000, "<ide_selection>lines 1-4 selected</ide_selection>"),
  ]);
  assert.equal(s.aggregates.lastConvRole, "assistant");
  assert.equal(s.aggregates.endedAt, iso(-29 * 60_000));
  assert.equal(s.status, "finished");
  assert.equal(s.aggregates.turns, 1);
});

test("pasting a synthetic-looking block WITH commentary still counts as a real prompt", async () => {
  const s = await parse([
    userPrompt(-30 * 60_000),
    assistantText(-29 * 60_000),
    commandEcho(
      -60_000,
      "<task-notification>copied from logs</task-notification>\n\nwhy did this notification fire twice?"
    ),
  ]);
  assert.equal(s.aggregates.lastConvRole, "user");
  assert.equal(s.aggregates.turns, 2);
  assert.equal(s.status, "active"); // real prompt, awaiting the reply
});

test("prompt merely starting with <command- but lacking a closing tag is a real prompt", async () => {
  const s = await parse([
    userPrompt(-30 * 60_000),
    assistantText(-29 * 60_000),
    commandEcho(-60_000, "<command-line arguments in my CLI are parsed wrong, can you look?"),
  ]);
  assert.equal(s.aggregates.lastConvRole, "user");
  assert.equal(s.status, "active");
});

test("ide_selection block bundled with a typed prompt block is a real prompt", async () => {
  const f = tmpFile([
    userPrompt(-30 * 60_000),
    assistantText(-29 * 60_000),
    JSON.stringify({
      type: "user",
      timestamp: iso(-60_000),
      message: {
        role: "user",
        content: [
          { type: "text", text: "<ide_selection>foo()</ide_selection>" },
          { type: "text", text: "rename this function" },
        ],
      },
    }),
  ]);
  const st = fs.statSync(f);
  const s = await parseSessionFile(f, "-enc", st.mtimeMs, st.size, THRESHOLDS, NOW);
  assert.equal(s.aggregates.lastConvRole, "user");
  assert.equal(s.status, "active");
});

// --- conversational status transitions ---------------------------------------

test("AskUserQuestion answered via tool_result clears awaiting", async () => {
  const s = await parse([
    userPrompt(-4 * 60_000),
    assistantToolUse(-3 * 60_000, "AskUserQuestion", { toolId: "tu_q" }),
    userToolResult(-60_000, "tu_q"),
  ]);
  assert.equal(s.aggregates.awaitingInput, false);
  assert.equal(s.status, "active"); // answered, next assistant record pending
});

test("assistant reply after an interrupt clears interrupted", async () => {
  const s = await parse([
    userPrompt(-10 * 60_000),
    userInterrupt(-9 * 60_000),
    userPrompt(-8 * 60_000),
    assistantText(-7 * 60_000),
  ]);
  assert.equal(s.aggregates.interrupted, false);
  assert.equal(s.status, "finished");
});

test("queued prompts keep a clean turn end active while recent", async () => {
  const s = await parse([
    queueOp(-4 * 60_000, "enqueue"),
    queueOp(-4 * 60_000 + 10, "enqueue"),
    queueOp(-4 * 60_000 + 20, "dequeue"),
    userPrompt(-3 * 60_000),
    assistantText(-60_000),
  ]);
  assert.equal(s.aggregates.queueDepth, 1);
  assert.equal(s.status, "active");
});

// --- computeStatus matrix ------------------------------------------------------

const baseAgg = {
  lastConvRole: "assistant" as const,
  lastStopReason: "end_turn" as string | undefined,
  awaitingInput: false,
  interrupted: false,
  queueDepth: 0,
};

test("computeStatus matrix", () => {
  // clean end, recent -> finished
  assert.equal(computeStatus(NOW - 60_000, baseAgg, THRESHOLDS, NOW), "finished");
  // clean end, quiet -> finished
  assert.equal(computeStatus(NOW - 60 * 60_000, baseAgg, THRESHOLDS, NOW), "finished");
  // dangling recent -> active
  assert.equal(computeStatus(NOW - 60_000, { ...baseAgg, lastStopReason: undefined }, THRESHOLDS, NOW), "active");
  // tool_use tail within 30min grace -> active
  assert.equal(computeStatus(NOW - 10 * 60_000, { ...baseAgg, lastStopReason: "tool_use" }, THRESHOLDS, NOW), "active");
  // tool_use tail past grace -> interrupted
  assert.equal(computeStatus(NOW - 40 * 60_000, { ...baseAgg, lastStopReason: "tool_use" }, THRESHOLDS, NOW), "interrupted");
  // dangling user tail past activeMs -> interrupted
  assert.equal(
    computeStatus(NOW - 10 * 60_000, { ...baseAgg, lastConvRole: "user", lastStopReason: undefined }, THRESHOLDS, NOW),
    "interrupted"
  );
  // awaiting beats recency
  assert.equal(computeStatus(NOW - 10 * 60_000, { ...baseAgg, awaitingInput: true }, THRESHOLDS, NOW), "awaiting");
  // explicit interrupt beats recency
  assert.equal(computeStatus(NOW - 30_000, { ...baseAgg, interrupted: true }, THRESHOLDS, NOW), "interrupted");
  // idle wins past the idle window
  assert.equal(computeStatus(NOW - 25 * 3_600_000, baseAgg, THRESHOLDS, NOW), "idle");
});

test("sidechain activity: background subagents keep a cleanly-ended session active", () => {
  // clean end 10min ago, agent log written 30s ago -> still working
  assert.equal(computeStatus(NOW - 10 * 60_000, baseAgg, THRESHOLDS, NOW, NOW - 30_000), "active");
  // agent logs stale (older than activeMs) -> finished
  assert.equal(computeStatus(NOW - 20 * 60_000, baseAgg, THRESHOLDS, NOW, NOW - 10 * 60_000), "finished");
  // agent logs older than the conversation (foreground agents from an earlier
  // turn) -> finished
  assert.equal(computeStatus(NOW - 60_000, baseAgg, THRESHOLDS, NOW, NOW - 2 * 60_000), "finished");
  // tool_use tail past the 30min grace but agents still writing -> active
  // (long foreground workflow, previously flipped to interrupted)
  assert.equal(
    computeStatus(NOW - 40 * 60_000, { ...baseAgg, lastStopReason: "tool_use" }, THRESHOLDS, NOW, NOW - 10_000),
    "active"
  );
  // awaiting-your-input still outranks running subagents
  assert.equal(
    computeStatus(NOW - 60_000, { ...baseAgg, awaitingInput: true }, THRESHOLDS, NOW, NOW - 10_000),
    "awaiting"
  );
});

test("probeSidechain: fresh agents are running, quiet/killed ones are not", async () => {
  const now = Date.now();
  const f = tmpFile([userPrompt(-10 * 60_000), assistantText(-9 * 60_000)]);
  const sessionId = path.basename(f, ".jsonl");
  const empty = await probeSidechain(f, sessionId, THRESHOLDS, now);
  assert.equal(empty.newestMtimeMs, 0);
  assert.deepEqual(empty.running, []);

  const dir = path.join(path.dirname(f), sessionId, "subagents");
  fs.mkdirSync(dir, { recursive: true });
  // finished long ago: not running
  fs.writeFileSync(path.join(dir, "agent-old.jsonl"), "{}\n");
  const past = (now - 3_600_000) / 1000;
  fs.utimesSync(path.join(dir, "agent-old.jsonl"), past, past);
  // actively writing, with meta labels
  fs.writeFileSync(path.join(dir, "agent-live.jsonl"), "{}\n");
  fs.writeFileSync(
    path.join(dir, "agent-live.meta.json"),
    JSON.stringify({ agentType: "code-reviewer", description: "Review batch A", toolUseId: "t1" })
  );
  // fresh mtime but user-killed: excluded
  fs.writeFileSync(path.join(dir, "agent-killed.jsonl"), "{}\n");
  fs.writeFileSync(
    path.join(dir, "agent-killed.meta.json"),
    JSON.stringify({ agentType: "general-purpose", description: "Doomed", stoppedByUser: true })
  );

  const probe = await probeSidechain(f, sessionId, THRESHOLDS, now);
  // newest spans ALL agent logs (incl. the killed one, written last here)
  assert.ok(probe.newestMtimeMs >= fs.statSync(path.join(dir, "agent-live.jsonl")).mtimeMs);
  assert.equal(probe.running.length, 1);
  assert.equal(probe.running[0].id, "agent-live");
  assert.equal(probe.running[0].agentType, "code-reviewer");
  assert.equal(probe.running[0].description, "Review batch A");
});

// --- incremental parsing ---------------------------------------------------------

test("incremental feeds equal a full parse", async () => {
  const first = [userPrompt(-10 * 60_000), assistantToolUse(-9 * 60_000, "Bash", { toolId: "tu_b" })];
  const rest = [userToolResult(-8 * 60_000, "tu_b"), assistantText(-7 * 60_000)];
  const f = tmpFile(first);

  const inc = new SessionParser(f, "-enc");
  await inc.feed();
  fs.appendFileSync(f, rest.map((l) => l + "\n").join(""));
  await inc.feed();
  const st = fs.statSync(f);
  const viaIncremental = await inc.finalize(st.mtimeMs, st.size, THRESHOLDS, NOW);
  const viaFull = await parseSessionFile(f, "-enc", st.mtimeMs, st.size, THRESHOLDS, NOW);

  assert.deepEqual(viaIncremental.aggregates, viaFull.aggregates);
  assert.equal(viaIncremental.status, viaFull.status);
});

test("partial line at EOF is not consumed until its newline arrives", async () => {
  const f = tmpFile([userPrompt(-10 * 60_000)]);
  const full = assistantText(-9 * 60_000);
  fs.appendFileSync(f, full.slice(0, 40)); // mid-record, no newline
  const p = new SessionParser(f, "-enc");
  await p.feed();
  let st = fs.statSync(f);
  let s = await p.finalize(st.mtimeMs, st.size, THRESHOLDS, NOW);
  assert.equal(s.aggregates.assistantTurns, 0);

  fs.appendFileSync(f, full.slice(40) + "\n");
  await p.feed();
  st = fs.statSync(f);
  s = await p.finalize(st.mtimeMs, st.size, THRESHOLDS, NOW);
  assert.equal(s.aggregates.assistantTurns, 1); // consumed exactly once
});

test("tailIntact: true for append-only growth, false for in-place rewrite", async () => {
  const f = tmpFile([userPrompt(-10 * 60_000), assistantText(-9 * 60_000)]);
  const p = new SessionParser(f, "-enc");
  await p.feed();
  assert.equal(await p.tailIntact(), true);

  fs.appendFileSync(f, systemRec(-60_000, "api_error") + "\n");
  assert.equal(await p.tailIntact(), true, "append must not invalidate");

  // Rewrite in place: different content, final size larger than the parser's
  // offset — exactly the shrink-then-regrow shape offset/mtime checks miss.
  const rewritten = [userPrompt(-5 * 60_000), assistantText(-4 * 60_000), assistantText(-3 * 60_000), assistantText(-2 * 60_000)];
  fs.writeFileSync(f, rewritten.map((l) => l + "\n").join(""));
  assert.equal(fs.statSync(f).size > p.byteOffset, true, "fixture must regrow past the old offset");
  assert.equal(await p.tailIntact(), false, "rewrite must invalidate");
});

test("multi-line assistant message shares one usage object — counted once", async () => {
  const usage = { input_tokens: 100, output_tokens: 50 };
  const s = await parse([
    userPrompt(-10 * 60_000),
    assistantToolUse(-9 * 60_000, "Read", { id: "msg_same", toolId: "tu_a" }),
    JSON.stringify({
      type: "assistant",
      timestamp: iso(-9 * 60_000 + 10),
      message: {
        id: "msg_same",
        role: "assistant",
        model: "claude-sonnet-5",
        stop_reason: "end_turn",
        usage,
        content: [{ type: "text", text: "and done" }],
      },
    }),
  ]);
  assert.equal(s.aggregates.tokens.inputTokens, 10 + 0); // tool-use line counted once (builder default 10)
  assert.equal(s.aggregates.toolCalls, 1);
  assert.equal(s.aggregates.assistantTurns, 2);
});

test("lastActivityMs prefers endedAt over mtime", async () => {
  const agg = (await parse([userPrompt(-10 * 60_000), assistantText(-9 * 60_000)])).aggregates;
  assert.equal(lastActivityMs(agg, NOW), NOW - 9 * 60_000);
  assert.equal(lastActivityMs({ ...agg, endedAt: undefined }, 12345), 12345);
});
