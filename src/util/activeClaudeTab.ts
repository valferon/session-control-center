import * as vscode from "vscode";
import { Session } from "../model/types";
import { SessionStore } from "../data/sessionStore";

// viewType of the Claude plugin's session editor tabs (same constant as
// sessionActions.revealExistingClaudeTab — a webview tab exposes no session id,
// so the tab LABEL vs session TITLE is the only join key available).
const CLAUDE_PANEL_VIEW_TYPE = "claudeVSCodePanel";

// The session shown in the currently focused editor tab, if that tab is a
// Claude conversation panel whose label matches a known session title.
// Best-effort by design: untitled sessions and renamed tabs return undefined.
// Ties (same title reused across sessions) resolve to the most recently
// written session — overwhelmingly the one you actually have open.
export function findActiveClaudeSession(store: SessionStore): Session | undefined {
  const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
  const input = tab?.input;
  if (!(input instanceof vscode.TabInputWebview) || !input.viewType.includes(CLAUDE_PANEL_VIEW_TYPE)) {
    return undefined;
  }
  const label = tab!.label.trim();
  if (!label) {
    return undefined;
  }
  // Exact title match first (the pre-existing join; unchanged semantics).
  let exact: Session | undefined;
  const fuzzy: Session[] = [];
  const prefix = truncatedPrefix(label);
  for (const g of store.getGroups()) {
    for (const s of g.sessions) {
      const title = s.title?.trim();
      if (!title) {
        continue;
      }
      if (title === label) {
        if (!exact || s.mtimeMs > exact.mtimeMs) {
          exact = s;
        }
      } else if (prefix !== undefined && title.startsWith(prefix)) {
        fuzzy.push(s);
      }
    }
  }
  if (exact) {
    return exact;
  }
  // Fuzzy (ellipsis-truncated label) is a weaker signal — generated titles
  // share long prefixes ("Fix …", "Refactor …"), so guard it twice: the
  // session must live in THIS window's workspace (a Claude tab always belongs
  // to the window's repo), and the surviving candidates must agree on a single
  // title. Ambiguity means bail: auto-marking the WRONG session reviewed is
  // strictly worse than requiring an explicit click.
  const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => normPath(f.uri.fsPath));
  const inWorkspace = fuzzy.filter((s) => s.cwd && folders.some((f) => pathRelated(normPath(s.cwd!), f)));
  const titles = new Set(inWorkspace.map((s) => s.title!.trim()));
  if (titles.size !== 1) {
    return undefined;
  }
  let best: Session | undefined;
  for (const s of inWorkspace) {
    if (!best || s.mtimeMs > best.mtimeMs) {
      best = s;
    }
  }
  return best;
}

// Prefix carried by an ellipsis-truncated tab label (long titles get cut in
// tab labels; an exact-only compare silently broke the tab↔session join for
// them, so those sessions never auto-marked reviewed). Must be long enough
// that a stub like "New c…" can't match; undefined = label is not truncated.
const MIN_PREFIX_MATCH = 12;

function truncatedPrefix(label: string): string | undefined {
  let prefix: string | undefined;
  if (label.endsWith("…")) {
    prefix = label.slice(0, -1).trimEnd();
  } else if (label.endsWith("...")) {
    prefix = label.slice(0, -3).trimEnd();
  }
  return prefix !== undefined && prefix.length >= MIN_PREFIX_MATCH ? prefix : undefined;
}

function normPath(p: string): string {
  return vscode.Uri.file(p).fsPath.replace(/\/+$/, "");
}

// Same dir or one contains the other, on path-segment boundaries.
function pathRelated(a: string, b: string): boolean {
  if (a === b) {
    return true;
  }
  const [shorter, longer] = a.length < b.length ? [a, b] : [b, a];
  return longer.startsWith(shorter + "/");
}

// Stable key of the active tab, used to skip refreshes when tab focus events
// fire without the active tab actually changing.
export function activeTabKey(): string {
  const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
  const input = tab?.input;
  if (!(input instanceof vscode.TabInputWebview)) {
    return "";
  }
  return `${input.viewType}|${tab!.label}`;
}
