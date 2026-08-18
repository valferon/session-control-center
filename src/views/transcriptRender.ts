import * as fs from "fs";
import * as path from "path";
import { pathToFileURL } from "url";
import { fmtNum } from "../util/fmt";

// Pure jsonl -> markdown rendering for a subagent's sidechain log. No vscode
// dependency, so it runs under the plain-node test runner (like jsonlParser).

// Per-block truncation keeps even multi-MB logs skimmable; the tail cap keeps
// the preview responsive on agents with thousands of tool calls.
const MAX_RESULT_CHARS = 1600;
const MAX_INPUT_CHARS = 700;
const MAX_PROMPT_VISIBLE = 2500;
const MAX_RENDERED_RECORDS = 500;

// An agent whose log went quiet longer than this (and never wrote a terminal
// stop_reason) is shown as ended-without-answer instead of running.
const RUNNING_WINDOW_MS = 5 * 60_000;

interface ToolCall {
  name: string;
  input: unknown;
}

export async function renderTranscript(fsPath: string, now = Date.now()): Promise<string> {
  const raw = await fs.promises.readFile(fsPath, "utf8");
  const meta = await readMeta(fsPath);
  const lines = raw.split("\n").filter((l) => l.trim());
  const records: any[] = [];
  for (const line of lines) {
    try {
      records.push(JSON.parse(line));
    } catch {
      // partial line mid-write / corrupt — skip
    }
  }

  // Pass 1: aggregates for the header + tool_use id -> name for pairing results.
  const toolById = new Map<string, ToolCall>();
  const seenUsageIds = new Set<string>();
  let model: string | undefined;
  let toolCalls = 0;
  let inTok = 0;
  let outTok = 0;
  let firstTs: string | undefined;
  let lastTs: string | undefined;
  let lastStop: string | undefined;
  for (const r of records) {
    if (r.timestamp && (r.type === "user" || r.type === "assistant")) {
      firstTs = firstTs ?? r.timestamp;
      lastTs = r.timestamp;
    }
    if (r.type !== "assistant" || !r.message) {
      continue;
    }
    const msg = r.message;
    if (typeof msg.stop_reason === "string" && msg.stop_reason) {
      lastStop = msg.stop_reason;
    }
    if (typeof msg.model === "string" && msg.model && msg.model !== "<synthetic>") {
      model = msg.model;
    }
    const usageKey = typeof msg.id === "string" && msg.id ? msg.id : r.uuid;
    if (msg.usage && (!usageKey || !seenUsageIds.has(usageKey))) {
      if (usageKey) {
        seenUsageIds.add(usageKey);
      }
      const u = msg.usage;
      inTok +=
        num(u.input_tokens) + num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens);
      outTok += num(u.output_tokens);
    }
    if (Array.isArray(msg.content)) {
      for (const b of msg.content) {
        if (b && b.type === "tool_use") {
          toolCalls++;
          if (typeof b.id === "string") {
            toolById.set(b.id, { name: String(b.name ?? "tool"), input: b.input });
          }
        }
      }
    }
  }

  const out: string[] = [];
  const title = meta?.description || meta?.agentType || path.basename(fsPath, ".jsonl");
  out.push(`# 🤖 ${mdEscape(title)}`);
  out.push("");

  const stat = await fs.promises.stat(fsPath).catch(() => undefined);
  const finished = lastStop === "end_turn" || lastStop === "stop_sequence";
  const status = meta?.stoppedByUser
    ? "🛑 stopped by user"
    : finished
      ? "✅ finished"
      : stat && now - stat.mtimeMs < RUNNING_WINDOW_MS
        ? "⚡ running"
        : "⚠️ ended without a final answer";
  const facts: string[] = [status];
  if (meta?.agentType) {
    facts.push(`type \`${meta.agentType}\``);
  }
  if (model) {
    facts.push(`model \`${model}\``);
  }
  facts.push(`${toolCalls} tool call${toolCalls === 1 ? "" : "s"}`);
  if (inTok + outTok > 0) {
    facts.push(`tokens ${fmtNum(inTok)} in / ${fmtNum(outTok)} out`);
  }
  const dur = duration(firstTs, lastTs);
  if (dur) {
    facts.push(dur);
  }
  out.push(facts.join(" · "));
  out.push("");
  out.push(`[Open raw JSONL](${pathToFileURL(fsPath).toString()})`);
  out.push("");
  out.push("---");
  out.push("");

  // Pass 2: the conversation. Keep only the tail when enormous.
  let body = records.filter((r) => r.type === "user" || r.type === "assistant");
  let omitted = 0;
  if (body.length > MAX_RENDERED_RECORDS) {
    // Always keep the first record (the task prompt) plus the tail.
    omitted = body.length - MAX_RENDERED_RECORDS;
    body = [body[0], ...body.slice(body.length - (MAX_RENDERED_RECORDS - 1))];
  }

  // Locate the final answer: last assistant text block. Rendered as its own
  // section because it IS the agent's return value to the main conversation.
  let resultIdx = -1;
  for (let i = body.length - 1; i >= 0; i--) {
    if (body[i].type === "assistant" && textOf(body[i].message).trim()) {
      resultIdx = i;
      break;
    }
  }

  let firstUserDone = false;
  for (let i = 0; i < body.length; i++) {
    const r = body[i];
    const msg = r.message;
    if (!msg) {
      continue;
    }
    if (i === 1 && omitted > 0) {
      out.push(`_… ${omitted} earlier records omitted (open the raw JSONL for the full log) …_`);
      out.push("");
    }
    if (r.type === "user") {
      const content = msg.content;
      if (typeof content === "string") {
        if (!firstUserDone) {
          out.push("## Task");
          out.push("");
          out.push(collapsibleText(content, MAX_PROMPT_VISIBLE, "full prompt"));
          out.push("");
          firstUserDone = true;
        } else if (content.trim()) {
          out.push(`**➡️ User:**`);
          out.push("");
          out.push(collapsibleText(content, MAX_PROMPT_VISIBLE, "full message"));
          out.push("");
        }
        continue;
      }
      if (Array.isArray(content)) {
        for (const b of content) {
          if (b && b.type === "tool_result") {
            out.push(renderToolResult(b, toolById));
            out.push("");
          } else if (b && b.type === "text" && typeof b.text === "string" && b.text.trim()) {
            if (!firstUserDone) {
              out.push("## Task");
              out.push("");
              out.push(collapsibleText(b.text, MAX_PROMPT_VISIBLE, "full prompt"));
              out.push("");
              firstUserDone = true;
            } else {
              out.push(`**➡️ User:**`);
              out.push("");
              out.push(collapsibleText(b.text, MAX_PROMPT_VISIBLE, "full message"));
              out.push("");
            }
          }
        }
      }
      continue;
    }
    // assistant
    const content = msg.content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (const b of content) {
      if (!b) {
        continue;
      }
      if (b.type === "thinking" && typeof b.thinking === "string" && b.thinking.trim()) {
        out.push(details("💭 thinking", fence(truncate(b.thinking, MAX_RESULT_CHARS))));
        out.push("");
      } else if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
        if (i === resultIdx) {
          out.push("## ✅ Result");
          out.push("");
          out.push(b.text.trim());
          out.push("");
        } else {
          out.push(b.text.trim());
          out.push("");
        }
      } else if (b.type === "tool_use") {
        out.push(renderToolUse(b));
        out.push("");
      }
    }
  }

  if (!finished && !meta?.stoppedByUser) {
    out.push("---");
    out.push("");
    out.push("_No final answer yet — this transcript refreshes automatically while the agent writes._");
    out.push("");
  }
  return out.join("\n");
}

interface AgentMeta {
  agentType?: string;
  description?: string;
  stoppedByUser?: boolean;
}

async function readMeta(fsPath: string): Promise<AgentMeta | undefined> {
  const metaPath = path.join(
    path.dirname(fsPath),
    `${path.basename(fsPath, ".jsonl")}.meta.json`
  );
  try {
    const meta = JSON.parse(await fs.promises.readFile(metaPath, "utf8"));
    return {
      agentType: typeof meta.agentType === "string" ? meta.agentType : undefined,
      description: typeof meta.description === "string" ? meta.description : undefined,
      stoppedByUser: meta.stoppedByUser === true,
    };
  } catch {
    return undefined;
  }
}

// One line per tool call: the name plus its most telling parameter, with the
// full input a click away when there's more to it.
function renderToolUse(b: any): string {
  const name = String(b.name ?? "tool");
  const gist = toolGist(name, b.input);
  const head = `**🔧 ${mdEscape(name)}**${gist ? ` — ${gist}` : ""}`;
  const json = safeJson(b.input);
  // Inline gist covers trivial inputs; anything meatier gets a collapsible.
  if (json && json.length > 80) {
    return `${head}\n${details("input", fence(truncate(json, MAX_INPUT_CHARS), "json"))}`;
  }
  return head;
}

function renderToolResult(b: any, toolById: Map<string, ToolCall>): string {
  const call = typeof b.tool_use_id === "string" ? toolById.get(b.tool_use_id) : undefined;
  const label = call ? mdEscape(call.name) : "tool";
  const text = toolResultText(b.content);
  const icon = b.is_error ? "❌" : "↩️";
  const suffix = b.is_error ? " (error)" : "";
  if (!text.trim()) {
    return `${icon} _${label}: empty result_`;
  }
  return details(
    `${icon} ${label} result${suffix} · ${fmtNum(text.length)} chars`,
    fence(truncate(text, MAX_RESULT_CHARS))
  );
}

// Flatten a tool_result content payload (string, or blocks) to plain text.
function toolResultText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return content == null ? "" : safeJson(content) ?? "";
  }
  const parts: string[] = [];
  for (const c of content) {
    if (c && typeof c === "object" && (c as any).type === "text" && typeof (c as any).text === "string") {
      parts.push((c as any).text);
    } else if (c && typeof c === "object" && (c as any).type === "image") {
      parts.push("[image]");
    } else {
      const j = safeJson(c);
      if (j) {
        parts.push(j);
      }
    }
  }
  return parts.join("\n");
}

// The one parameter worth showing inline, per tool. Falls back to the first
// string-ish value so unknown/MCP tools still get a hint.
const GIST_KEYS = [
  "command",
  "file_path",
  "pattern", // before "path": Grep/Glob carry both, pattern is the telling one
  "path",
  "query",
  "url",
  "prompt",
  "description",
  "skill",
];

function toolGist(name: string, input: unknown): string {
  if (!input || typeof input !== "object") {
    return "";
  }
  const obj = input as Record<string, unknown>;
  for (const k of GIST_KEYS) {
    const v = obj[k];
    if (typeof v === "string" && v.trim()) {
      return inlineCode(v);
    }
  }
  for (const v of Object.values(obj)) {
    if (typeof v === "string" && v.trim()) {
      return inlineCode(v);
    }
  }
  return "";
}

// Single-line inline code span (truncate() would inject a newline that breaks
// the span across lines in the preview).
function inlineCode(v: string): string {
  const flat = v.replace(/\s+/g, " ").trim();
  const cut = flat.length > 110 ? flat.slice(0, 110) + "…" : flat;
  return "`" + codeEscape(cut) + "`";
}

// ---------------------------------------------------------------------------
// Markdown helpers
// ---------------------------------------------------------------------------

// Long text renders its head, with the rest collapsed. Short text passes through.
function collapsibleText(text: string, visible: number, moreLabel: string): string {
  const t = text.trim();
  if (t.length <= visible) {
    return blockquote(t);
  }
  return (
    blockquote(t.slice(0, visible) + " …") +
    "\n\n" +
    details(`${moreLabel} (${fmtNum(t.length)} chars)`, fence(t))
  );
}

function blockquote(text: string): string {
  return text
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");
}

function details(summary: string, body: string): string {
  // Blank lines around the body are what make markdown render inside <details>.
  return `<details><summary>${htmlEscape(summary)}</summary>\n\n${body}\n\n</details>`;
}

// Fence with more backticks than any run inside the content, so embedded
// code fences can't break out.
function fence(text: string, lang = ""): string {
  const runs = text.match(/`+/g);
  const longest = runs ? Math.max(...runs.map((r) => r.length)) : 0;
  const ticks = "`".repeat(Math.max(3, longest + 1));
  return `${ticks}${lang}\n${text}\n${ticks}`;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + `\n… [truncated, ${fmtNum(s.length)} chars total]` : s;
}

function safeJson(v: unknown): string | undefined {
  try {
    return JSON.stringify(v, null, 1)?.replace(/\n\s*/g, " ");
  } catch {
    return undefined;
  }
}

function textOf(message: any): string {
  const c = message?.content;
  if (typeof c === "string") {
    return c;
  }
  if (!Array.isArray(c)) {
    return "";
  }
  return c
    .filter((b: any) => b && b.type === "text" && typeof b.text === "string")
    .map((b: any) => b.text)
    .join("\n");
}

function mdEscape(s: string): string {
  return s.replace(/([\\`*_{}[\]<>])/g, "\\$1");
}

function htmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function codeEscape(s: string): string {
  return s.replace(/`/g, "'");
}

function num(v: unknown): number {
  return typeof v === "number" && isFinite(v) ? v : 0;
}

function duration(a?: string, b?: string): string | undefined {
  if (!a || !b) {
    return undefined;
  }
  const ms = Date.parse(b) - Date.parse(a);
  if (Number.isNaN(ms) || ms <= 0) {
    return undefined;
  }
  const s = Math.round(ms / 1000);
  if (s < 60) {
    return `${s}s`;
  }
  const m = Math.floor(s / 60);
  if (m < 60) {
    return `${m}m${String(s % 60).padStart(2, "0")}s`;
  }
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}
