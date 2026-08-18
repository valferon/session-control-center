import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { renderTranscript } from "../views/transcriptRender";

const NOW = Date.parse("2026-01-10T12:00:00.000Z");
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

function writeAgentLog(lines: string[], meta?: object): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "transcript-test-"));
  const file = path.join(dir, "agent-abc123.jsonl");
  fs.writeFileSync(file, lines.join("\n") + "\n");
  if (meta) {
    fs.writeFileSync(path.join(dir, "agent-abc123.meta.json"), JSON.stringify(meta));
  }
  return file;
}

function rec(o: object): string {
  return JSON.stringify(o);
}

test("renders task, tool calls, results and final answer", async () => {
  const file = writeAgentLog(
    [
      rec({
        type: "user",
        timestamp: iso(0),
        message: { role: "user", content: "Find the bug in auth.ts" },
      }),
      rec({ type: "attachment", attachment: { type: "skill_listing" } }),
      rec({
        type: "assistant",
        timestamp: iso(1000),
        uuid: "u1",
        message: {
          id: "m1",
          model: "claude-sonnet-5",
          stop_reason: "tool_use",
          usage: { input_tokens: 100, output_tokens: 20 },
          content: [
            { type: "tool_use", id: "tu_1", name: "Grep", input: { pattern: "expiry", path: "src" } },
          ],
        },
      }),
      rec({
        type: "user",
        timestamp: iso(2000),
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tu_1", content: "auth.ts:42: expiry check" }],
        },
      }),
      rec({
        type: "assistant",
        timestamp: iso(3000),
        uuid: "u2",
        message: {
          id: "m2",
          model: "claude-sonnet-5",
          stop_reason: "end_turn",
          usage: { input_tokens: 200, output_tokens: 50 },
          content: [{ type: "text", text: "The bug is an off-by-one in the expiry check." }],
        },
      }),
    ],
    { agentType: "general-purpose", description: "Find auth bug" }
  );

  const md = await renderTranscript(file, NOW);
  assert.match(md, /# 🤖 Find auth bug/);
  assert.match(md, /✅ finished/);
  assert.match(md, /type `general-purpose`/);
  assert.match(md, /model `claude-sonnet-5`/);
  assert.match(md, /1 tool call/);
  assert.match(md, /## Task/);
  assert.match(md, /> Find the bug in auth\.ts/);
  assert.match(md, /\*\*🔧 Grep\*\* — `expiry`/);
  assert.match(md, /Grep result/);
  assert.match(md, /auth\.ts:42: expiry check/);
  assert.match(md, /## ✅ Result/);
  assert.match(md, /off-by-one in the expiry check/);
  assert.match(md, /Open raw JSONL/);
  // Attachments (skill_listing etc.) never leak into the transcript.
  assert.ok(!md.includes("skill_listing"));
});

test("running agent (fresh mtime, no terminal stop) shows as running", async () => {
  const file = writeAgentLog([
    rec({
      type: "user",
      timestamp: iso(0),
      message: { role: "user", content: "long task" },
    }),
    rec({
      type: "assistant",
      timestamp: iso(1000),
      uuid: "u1",
      message: {
        id: "m1",
        model: "claude-sonnet-5",
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "tu_1", name: "Bash", input: { command: "make build" } }],
      },
    }),
  ]);
  // mtime is "now" (just written) => running.
  const md = await renderTranscript(file, Date.now());
  assert.match(md, /⚡ running/);
  assert.match(md, /refreshes automatically/);
});

test("stoppedByUser meta wins over everything", async () => {
  const file = writeAgentLog(
    [
      rec({
        type: "user",
        timestamp: iso(0),
        message: { role: "user", content: "task" },
      }),
    ],
    { agentType: "Explore", description: "Scan repo", stoppedByUser: true }
  );
  const md = await renderTranscript(file, NOW);
  assert.match(md, /🛑 stopped by user/);
});

test("embedded code fences cannot break out of result blocks", async () => {
  const evil = "```\ninjected\n```\n# not a heading";
  const file = writeAgentLog([
    rec({
      type: "user",
      timestamp: iso(0),
      message: { role: "user", content: "task" },
    }),
    rec({
      type: "assistant",
      timestamp: iso(500),
      uuid: "u1",
      message: {
        id: "m1",
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "tu_1", name: "Bash", input: { command: "cat x" } }],
      },
    }),
    rec({
      type: "user",
      timestamp: iso(1000),
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tu_1", content: evil }],
      },
    }),
  ]);
  const md = await renderTranscript(file, NOW);
  // The wrapping fence must be longer than the 3-backtick run inside.
  assert.match(md, /````\n```\ninjected/);
});

test("tolerates a torn (partial) last line", async () => {
  const file = writeAgentLog([
    rec({
      type: "user",
      timestamp: iso(0),
      message: { role: "user", content: "task" },
    }),
    '{"type":"assistant","message":{"content":[{"type":"te', // mid-write
  ]);
  const md = await renderTranscript(file, NOW);
  assert.match(md, /## Task/);
});
