import "./styles.css";
import type { FromWebview, ToWebview, ActivityBucket } from "../../src/webview/protocol";
import type { ProjectGroup, Session, DashboardMetrics, ClaudeUsage, UsageWindow } from "../../src/model/types";

declare function acquireVsCodeApi(): {
  postMessage(msg: FromWebview): void;
  getState(): unknown;
  setState(s: unknown): void;
};

const vscode = acquireVsCodeApi();

type SortKey = "activity" | "title" | "project" | "tokens" | "cost" | "tools" | "status";
type StatusFilter = "all" | "active" | "awaiting" | "pendingReview" | "finished" | "interrupted" | "idle";
type TimeRange = "24h" | "7d" | "30d" | "all";

interface State {
  projects: ProjectGroup[];
  metrics?: DashboardMetrics;
  activity: ActivityBucket[];
  updatedAt: number;
  filter: string;
  sortKey: SortKey;
  sortDir: 1 | -1;
  statusFilter: StatusFilter;
  range: TimeRange;
  usage?: ClaudeUsage;
}

const RANGE_MS: Record<TimeRange, number> = {
  "24h": 86_400_000,
  "7d": 7 * 86_400_000,
  "30d": 30 * 86_400_000,
  all: Infinity,
};

const state: State = {
  projects: [],
  activity: [],
  updatedAt: 0,
  filter: "",
  sortKey: "activity",
  sortDir: -1,
  statusFilter: "all",
  range: "7d",
};

const root = document.getElementById("app")!;
render();
vscode.postMessage({ kind: "ready" });

window.addEventListener("message", (ev) => {
  const msg = ev.data as ToWebview;
  if (msg.kind === "snapshot") {
    state.projects = msg.projects;
    state.metrics = msg.metrics;
    state.activity = msg.activity;
    state.usage = msg.usage;
    state.updatedAt = msg.generatedAt;
    render();
  }
});

// ---- data shaping ----

function activityMs(s: Session): number {
  const e = s.aggregates.endedAt ? Date.parse(s.aggregates.endedAt) : NaN;
  return Number.isNaN(e) ? s.mtimeMs : e;
}

function allRows(): Array<{ s: Session; project: ProjectGroup }> {
  const out: Array<{ s: Session; project: ProjectGroup }> = [];
  for (const p of state.projects) {
    for (const s of p.sessions) {
      out.push({ s, project: p });
    }
  }
  return out;
}

function filteredSorted(): Array<{ s: Session; project: ProjectGroup }> {
  const f = state.filter.toLowerCase().trim();
  const cutoff = Date.now() - RANGE_MS[state.range];
  let rows = allRows();
  rows = rows.filter((r) => activityMs(r.s) >= cutoff);
  if (state.statusFilter !== "all") {
    rows = rows.filter((r) => r.s.status === state.statusFilter);
  }
  if (f) {
    rows = rows.filter((r) => haystack(r.s, r.project).includes(f));
  }
  const dir = state.sortDir;
  rows.sort((a, b) => {
    const va = sortVal(a.s, a.project, state.sortKey);
    const vb = sortVal(b.s, b.project, state.sortKey);
    if (va < vb) return -1 * dir;
    if (va > vb) return 1 * dir;
    return 0;
  });
  return rows;
}

// Metrics that honor the selected time range: every tile is summed over the
// sessions visible in that range, so the tiles agree with the table below.
// Active/awaiting sessions always have recent activity (that's what makes them
// live), so scoping them to the range never hides a genuinely live session.
function rangeMetrics(): DashboardMetrics {
  const cutoff = Date.now() - RANGE_MS[state.range];
  let tokensSum = 0;
  let totalCostUsd = 0;
  let openPrs = 0;
  let totalSessions = 0;
  let activeSessions = 0;
  let awaitingSessions = 0;
  let pendingReviewSessions = 0;
  let finishedSessions = 0;
  const projects = new Set<string>();
  for (const { s, project } of allRows()) {
    if (activityMs(s) < cutoff) {
      continue;
    }
    if (s.status === "active") {
      activeSessions++;
    } else if (s.status === "awaiting") {
      awaitingSessions++;
    } else if (s.status === "pendingReview") {
      pendingReviewSessions++;
    } else if (s.status === "finished") {
      finishedSessions++;
    }
    totalSessions++;
    tokensSum += totalTokens(s);
    totalCostUsd += s.costUsd;
    openPrs += s.aggregates.prLinks.length;
    projects.add(project.key);
  }
  return { totalSessions, activeSessions, awaitingSessions, pendingReviewSessions, finishedSessions, totalProjects: projects.size, totalTokens: tokensSum, totalCostUsd, openPrs };
}

function haystack(s: Session, p: ProjectGroup): string {
  return [s.title, s.lastPrompt, s.gitBranch, s.cwd, s.sessionId, p.label, s.aggregates.models.join(" ")]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function sortVal(s: Session, p: ProjectGroup, key: SortKey): number | string {
  switch (key) {
    case "activity": return activityMs(s);
    case "title": return (s.title || s.lastPrompt || s.sessionId).toLowerCase();
    case "project": return p.label.toLowerCase();
    case "tokens": return totalTokens(s);
    case "cost": return s.costUsd;
    case "tools": return s.aggregates.toolCalls;
    case "status": return s.status;
  }
}

// ---- render ----

let searchInputEl: HTMLInputElement | undefined;
let restoreSearchCaret: number | null = null;

function render(): void {
  const m = rangeMetrics(); // compute once per render, shared by topbar + tiles
  const rows = filteredSorted();
  root.replaceChildren(
    topbar(m),
    usageStrip(),
    tiles(m),
    topProjectsPanel(),
    toolUsagePanel(),
    controls(rows.length),
    tableWrap(rows)
  );
  // Restore focus + caret to the search box after a keystroke-triggered render.
  if (restoreSearchCaret !== null && searchInputEl) {
    const pos = restoreSearchCaret;
    searchInputEl.focus();
    try {
      searchInputEl.setSelectionRange(pos, pos);
    } catch {
      /* non-text input */
    }
    restoreSearchCaret = null;
  }
}

// Real Claude subscription usage (same data as the /usage command).
function usageStrip(): HTMLElement {
  const wrap = el("div", "usage-strip");
  const u = state.usage;
  if (!u) {
    return wrap; // not loaded yet
  }
  const hasWindows = !!(u.fiveHour || u.sevenDay);
  if (!hasWindows && u.error) {
    const note = el("div", "usage-note");
    note.textContent = "Plan usage: " + u.error;
    wrap.append(note);
    return wrap;
  }
  if (u.fiveHour) wrap.append(usageBar("Session (5h)", u.fiveHour));
  if (u.sevenDay) wrap.append(usageBar("Weekly (7d)", u.sevenDay));
  if (u.sevenDayOpus) wrap.append(usageBar("Weekly (Opus)", u.sevenDayOpus));
  if (u.sevenDaySonnet) wrap.append(usageBar("Weekly (Sonnet)", u.sevenDaySonnet));
  if (u.sevenDayFable) wrap.append(usageBar("Weekly (Fable)", u.sevenDayFable));
  if (u.error) {
    const note = el("div", "usage-note");
    note.textContent = u.error;
    wrap.append(note);
  }
  return wrap;
}

function usageBar(label: string, w: UsageWindow): HTMLElement {
  const pct = clampPct(w.percent);
  const sev = w.severity === "critical" || pct >= 90 ? "crit" : w.severity === "warning" || pct >= 70 ? "warn" : "normal";
  const box = el("div", "ubar");
  const head = el("div", "ubar-head");
  const reset = w.resetsAt ? `resets ${relReset(w.resetsAt)}` : "";
  head.append(spanText("ubar-label", label), spanText("ubar-reset", reset), spanText("ubar-pct", `${pct}%`));
  const track = el("div", "ubar-track");
  const fill = el("div", "ubar-fill sev-" + sev);
  fill.style.width = pct + "%";
  track.append(fill);
  box.append(head, track);
  return box;
}

function clampPct(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

function relReset(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "?";
  const diff = t - Date.now();
  if (diff <= 0) return "soon";
  const h = Math.floor(diff / 3_600_000);
  if (h < 1) return `in ${Math.ceil(diff / 60_000)}m`;
  if (h < 24) return `in ${h}h`;
  return `in ${Math.floor(h / 24)}d`;
}

function spanText(cls: string, t: string): HTMLElement {
  const s = el("span", cls);
  s.textContent = t;
  return s;
}

function topbar(m: DashboardMetrics): HTMLElement {
  const bar = el("div", "topbar");

  const brand = el("div", "brand");
  const brow = el("div", "brand-row");
  const title = el("div", "brand-title");
  title.textContent = "Claude Control Center";
  const live = el("span", "live");
  const liveText = m.awaitingSessions > 0 ? `${m.activeSessions} active · ${m.awaitingSessions} awaiting` : `${m.activeSessions} active`;
  live.append(el("span", "pulse"), text(liveText));
  brow.append(title, live);
  const sub = el("div", "brand-sub");
  sub.textContent = "local Claude Code sessions across all repos";
  brand.append(brow, sub);
  bar.append(brand);

  const tabs = el("div", "tabs");
  for (const r of ["24h", "7d", "30d", "all"] as TimeRange[]) {
    const b = button(r, () => { state.range = r; render(); });
    if (state.range === r) b.classList.add("active");
    tabs.append(b);
  }
  bar.append(tabs);

  if (state.updatedAt) {
    const u = el("div", "updated");
    u.textContent = "updated " + new Date(state.updatedAt).toLocaleTimeString();
    bar.append(u);
  }

  const refresh = button("⟳ Refresh", () => vscode.postMessage({ kind: "requestRefresh" }));
  refresh.className = "btn";
  bar.append(refresh);
  return bar;
}

function tiles(m: DashboardMetrics): HTMLElement {
  const row = el("div", "tiles");
  const defs: Array<{ label: string; value: string; cls: string; hot?: boolean }> = [
    { label: "Active now", value: String(m?.activeSessions ?? 0), cls: "green", hot: (m?.activeSessions ?? 0) > 0 },
    { label: "Awaiting", value: String(m?.awaitingSessions ?? 0), cls: "blue", hot: (m?.awaitingSessions ?? 0) > 0 },
    { label: "To review", value: String(m?.pendingReviewSessions ?? 0), cls: "yellow", hot: (m?.pendingReviewSessions ?? 0) > 0 },
    { label: "Finished", value: String(m?.finishedSessions ?? 0), cls: "purple" },
    { label: "Sessions", value: String(m?.totalSessions ?? 0), cls: "blue" },
    { label: "Projects", value: String(m?.totalProjects ?? 0), cls: "purple" },
    { label: "Tokens", value: fmtNum(m?.totalTokens ?? 0), cls: "blue" },
    { label: "Est. cost", value: "$" + fmtMoney(m?.totalCostUsd ?? 0), cls: "yellow" },
    { label: "PR links", value: String(m?.openPrs ?? 0), cls: "purple" },
  ];
  for (const d of defs) {
    const t = el("div", "tile " + d.cls);
    const v = el("div", "tile-value" + (d.hot ? " hot" : ""));
    v.textContent = d.value;
    const l = el("div", "tile-label");
    l.textContent = d.label;
    t.append(v, l);
    row.append(t);
  }
  return row;
}

// Top projects by token volume within the selected range — horizontal bars.
// Actionable for context-switching: where the work (and spend) actually is.
function topProjectsPanel(): HTMLElement {
  const panel = el("div", "panel");
  const head = el("div", "panel-head");
  const t = el("div", "panel-title");
  t.textContent = "Top projects by tokens";
  const meta = el("div", "panel-meta");
  meta.textContent = rangeLabel();
  head.append(t, meta);
  panel.append(head);

  const cutoff = Date.now() - RANGE_MS[state.range];
  const agg = new Map<string, { label: string; tokens: number; cost: number; sessions: number; active: number }>();
  for (const { s, project } of allRows()) {
    if (activityMs(s) < cutoff) continue;
    let e = agg.get(project.key);
    if (!e) {
      e = { label: project.label, tokens: 0, cost: 0, sessions: 0, active: 0 };
      agg.set(project.key, e);
    }
    e.tokens += totalTokens(s);
    e.cost += s.costUsd;
    e.sessions++;
    if (s.status === "active") e.active++;
  }
  const rows = [...agg.values()].sort((a, b) => b.tokens - a.tokens).slice(0, 8);

  if (rows.length === 0) {
    const empty = el("div", "panel-empty");
    empty.textContent = "No activity in this range.";
    panel.append(empty);
    return panel;
  }

  const max = Math.max(1, ...rows.map((r) => r.tokens));
  const list = el("div", "hbars");
  for (const r of rows) {
    const row = el("div", "hbar-row");
    const name = el("div", "hbar-name");
    name.textContent = r.label;
    if (r.active > 0) {
      const d = el("span", "hbar-active");
      d.title = `${r.active} active`;
      name.append(d);
    }
    const track = el("div", "hbar-track");
    const fill = el("div", "hbar-fill");
    fill.style.width = Math.max(3, Math.round((r.tokens / max) * 100)) + "%";
    track.append(fill);
    const val = el("div", "hbar-val");
    val.textContent = `${fmtNum(r.tokens)} · $${fmtMoney(r.cost)} · ${r.sessions}s`;
    row.append(name, track, val);
    list.append(row);
  }
  panel.append(list);
  return panel;
}

// Tool & MCP usage within the selected range. MCP tools (mcp__server__tool)
// are grouped per server so you can see how much context each MCP eats.
// Token numbers are ESTIMATES from payload size (chars/4): the jsonl only has
// per-message usage, never per-tool, and MCP tool-definition overhead in the
// system prompt is invisible here.
function toolUsagePanel(): HTMLElement {
  const panel = el("div", "panel");
  const head = el("div", "panel-head");
  const t = el("div", "panel-title");
  t.textContent = "Tool & MCP usage";
  const meta = el("div", "panel-meta");
  meta.textContent = `${rangeLabel()} · est. tokens from payload size`;
  head.append(t, meta);
  panel.append(head);

  const cutoff = Date.now() - RANGE_MS[state.range];
  const agg = new Map<string, { calls: number; chars: number; mcp: boolean }>();
  for (const { s } of allRows()) {
    if (activityMs(s) < cutoff) continue;
    const calls = s.aggregates.toolCallsByName ?? {};
    const chars = s.aggregates.toolCharsByName ?? {};
    for (const name of new Set([...Object.keys(calls), ...Object.keys(chars)])) {
      const { key, mcp } = toolGroup(name);
      let e = agg.get(key);
      if (!e) {
        e = { calls: 0, chars: 0, mcp };
        agg.set(key, e);
      }
      e.calls += calls[name] ?? 0;
      e.chars += chars[name] ?? 0;
    }
  }
  const rows = [...agg.entries()]
    .map(([name, e]) => ({ name, ...e, tokens: Math.round(e.chars / 4) }))
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 12);

  if (rows.length === 0) {
    const empty = el("div", "panel-empty");
    empty.textContent = "No tool activity in this range.";
    panel.append(empty);
    return panel;
  }

  const totalTok = Math.max(1, [...agg.values()].reduce((n, e) => n + e.chars, 0) / 4);
  const max = Math.max(1, ...rows.map((r) => r.tokens));
  const list = el("div", "hbars");
  for (const r of rows) {
    const row = el("div", "hbar-row");
    const name = el("div", "hbar-name");
    name.textContent = r.name;
    name.title = r.name;
    if (r.mcp) {
      const tag = el("span", "model-tag");
      tag.textContent = "mcp";
      name.append(tag);
    }
    const track = el("div", "hbar-track");
    const fill = el("div", "hbar-fill" + (r.mcp ? " mcp" : ""));
    fill.style.width = Math.max(3, Math.round((r.tokens / max) * 100)) + "%";
    track.append(fill);
    const val = el("div", "hbar-val");
    const share = Math.round((r.tokens / totalTok) * 100);
    val.textContent = `~${fmtNum(r.tokens)} tok · ${fmtNum(r.calls)} calls · ${share}%`;
    row.append(name, track, val);
    list.append(row);
  }
  panel.append(list);
  return panel;
}

// mcp__linear__create_issue → { key: "linear (MCP)", mcp: true };
// built-ins keep their own name so heavy ones (Read, Bash) stay visible.
function toolGroup(name: string): { key: string; mcp: boolean } {
  const m = /^mcp__(.+?)__/.exec(name);
  if (m) {
    return { key: m[1], mcp: true };
  }
  return { key: name, mcp: false };
}

function rangeLabel(): string {
  const labels: Record<TimeRange, string> = {
    "24h": "last 24h",
    "7d": "last 7 days",
    "30d": "last 30 days",
    all: "all time",
  };
  return labels[state.range] ?? "";
}

function controls(count: number): HTMLElement {
  const bar = el("div", "controls");

  const sw = el("div", "search-wrap");
  const ico = el("span", "ico");
  ico.textContent = "⌕";
  const input = document.createElement("input");
  input.type = "text";
  input.className = "search";
  input.placeholder = "Search title, prompt, branch, repo, model, id…";
  input.value = state.filter;
  input.addEventListener("input", () => {
    state.filter = input.value;
    restoreSearchCaret = input.selectionStart ?? input.value.length;
    render();
  });
  searchInputEl = input;
  sw.append(ico, input);
  bar.append(sw);

  const seg = el("div", "segmented");
  const filterLabels: Record<StatusFilter, string> = {
    all: "all",
    active: "active",
    awaiting: "awaiting",
    pendingReview: "review",
    finished: "finished",
    interrupted: "interrupted",
    idle: "idle",
  };
  for (const f of ["all", "active", "awaiting", "pendingReview", "finished", "interrupted", "idle"] as StatusFilter[]) {
    const b = button(filterLabels[f], () => {
      state.statusFilter = f;
      render();
    });
    if (state.statusFilter === f) b.classList.add("active");
    seg.append(b);
  }
  bar.append(seg);

  const countEl = el("div", "count");
  countEl.textContent = `${count} shown`;
  bar.append(countEl);
  return bar;
}

function tableWrap(rows: Array<{ s: Session; project: ProjectGroup }>): HTMLElement {
  const wrap = el("div", "table-wrap");
  const t = document.createElement("table");

  const cols: Array<[string, SortKey | null]> = [
    ["Status", "status"],
    ["Session", "title"],
    ["Project", "project"],
    ["Branch", null],
    ["Model", null],
    ["Tokens", "tokens"],
    ["Cost", "cost"],
    ["Tools", "tools"],
    ["Activity", "activity"],
    ["", null],
  ];
  const thead = document.createElement("thead");
  const htr = document.createElement("tr");
  for (const [label, key] of cols) {
    const th = document.createElement("th");
    th.textContent = label;
    if (key) {
      th.classList.add("sortable");
      if (state.sortKey === key) th.textContent = label + (state.sortDir === 1 ? " ▲" : " ▼");
      th.addEventListener("click", () => {
        if (state.sortKey === key) {
          state.sortDir = (state.sortDir * -1) as 1 | -1;
        } else {
          state.sortKey = key;
          state.sortDir = key === "title" || key === "project" ? 1 : -1;
        }
        render();
      });
    }
    htr.append(th);
  }
  thead.append(htr);
  t.append(thead);

  const tbody = document.createElement("tbody");
  if (rows.length === 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = cols.length;
    td.className = "empty";
    td.textContent = "No sessions match this filter.";
    tr.append(td);
    tbody.append(tr);
  }
  for (const { s, project } of rows) tbody.append(sessionRow(s, project));
  t.append(tbody);
  wrap.append(t);
  return wrap;
}

function sessionRow(s: Session, project: ProjectGroup): HTMLElement {
  const tr = document.createElement("tr");
  tr.classList.add("clickable");
  if (s.cwd) {
    tr.title = "Click to open repo in new window";
    tr.addEventListener("click", () =>
      vscode.postMessage({ kind: "openSession", sessionId: s.sessionId, newWindow: true })
    );
  }

  const statusTd = document.createElement("td");
  const allowed = ["active", "awaiting", "pendingReview", "finished", "interrupted", "idle"];
  const safeStatus = allowed.includes(s.status) ? s.status : "idle";
  const label = safeStatus === "pendingReview" ? "pending review" : safeStatus;
  const pill = el("span", "pill " + safeStatus);
  pill.append(el("span", "dot"), text(label));
  statusTd.append(pill);
  tr.append(statusTd);

  const titleTd = document.createElement("td");
  titleTd.className = "title-cell";
  const rt = el("div", "row-title");
  rt.textContent = s.title || s.lastPrompt?.slice(0, 90) || s.sessionId.slice(0, 8);
  titleTd.append(rt);
  if (s.lastPrompt && s.title) {
    const sub = el("div", "row-sub");
    sub.textContent = s.lastPrompt.slice(0, 110);
    titleTd.append(sub);
  }
  tr.append(titleTd);

  tr.append(cellHtml((td) => { td.className = "proj"; td.textContent = project.label; }));
  tr.append(cellHtml((td) => { td.className = "branch"; td.textContent = s.gitBranch || "—"; }));
  tr.append(cellHtml((td) => {
    // lastModel first: current model of the session (tracks /model switches);
    // models[] is most-used-first and lags after a switch.
    const m = shortModel(s.aggregates.lastModel ? [s.aggregates.lastModel] : s.aggregates.models);
    if (m === "—") { td.textContent = "—"; return; }
    const tag = el("span", "model-tag");
    tag.textContent = m;
    td.append(tag);
  }));
  tr.append(numCell(fmtNum(totalTokens(s))));
  tr.append(numCell("$" + fmtMoney(s.costUsd)));
  tr.append(numCell(String(s.aggregates.toolCalls)));
  tr.append(numCell(relTime(activityMs(s))));

  const actions = document.createElement("td");
  actions.className = "actions";
  const open = iconBtn("⧉", "Open repo in new window", () =>
    vscode.postMessage({ kind: "openSession", sessionId: s.sessionId, newWindow: true })
  );
  if (!s.cwd) { open.classList.add("disabled"); open.title = "No verified repo path"; }
  const claude = iconBtn("✦", "Open repo + start Claude", () =>
    vscode.postMessage({ kind: "startClaude", sessionId: s.sessionId })
  );
  const copy = iconBtn("⎘", "Copy session id", () =>
    vscode.postMessage({ kind: "copySessionId", sessionId: s.sessionId })
  );
  actions.append(open, claude, copy);
  tr.append(actions);
  return tr;
}

// ---- helpers ----

function totalTokens(s: Session): number {
  const t = s.aggregates.tokens;
  return t.inputTokens + t.outputTokens + t.cacheCreationInputTokens + t.cacheReadInputTokens;
}

function shortModel(models: string[]): string {
  if (models.length === 0) return "—";
  const m = models[0].toLowerCase();
  if (m.includes("opus")) return "opus";
  if (m.includes("sonnet")) return "sonnet";
  if (m.includes("haiku")) return "haiku";
  if (m.includes("fable")) return "fable";
  return models[0];
}

function numCell(t: string): HTMLElement {
  const td = document.createElement("td");
  td.className = "num";
  td.textContent = t;
  return td;
}
function cellHtml(fn: (td: HTMLElement) => void): HTMLElement {
  const td = document.createElement("td");
  fn(td);
  return td;
}
function el(tag: string, cls?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}
function text(t: string): Text {
  return document.createTextNode(t);
}
function button(t: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.textContent = t;
  b.addEventListener("click", onClick);
  return b;
}
function iconBtn(glyph: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.textContent = glyph;
  b.title = title;
  b.className = "icon-btn";
  b.addEventListener("click", (e) => {
    e.stopPropagation(); // don't trigger the row's open handler
    onClick();
  });
  return b;
}
function fmtNum(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(n);
}
function fmtMoney(n: number): string {
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return n.toFixed(2);
}
function relTime(ms: number): string {
  const diff = Date.now() - ms;
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
