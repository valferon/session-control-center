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
  const label = tab!.label;
  if (!label) {
    return undefined;
  }
  let best: Session | undefined;
  for (const g of store.getGroups()) {
    for (const s of g.sessions) {
      if (s.title === label && (!best || s.mtimeMs > best.mtimeMs)) {
        best = s;
      }
    }
  }
  return best;
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
