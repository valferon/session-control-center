import * as vscode from "vscode";
import * as path from "path";
import { Session } from "../model/types";
import { SessionStore } from "../data/sessionStore";
import { normPath, pathRelated } from "./pathMatch";

// viewType of the Claude plugin's session editor tabs (same constant as
// sessionActions.revealExistingClaudeTab — a webview tab exposes no session id,
// so the tab LABEL vs session TITLE is the only join key available).
const CLAUDE_PANEL_VIEW_TYPE = "claudeVSCodePanel";

// Session for the focused tab, for DISPLAY purposes (the "Current session"
// tree section): a Claude conversation panel (title join, below) — or a text
// tab showing one of the session's own files (main jsonl, agent sidechain
// log, workflow run record), whose path carries the session id and so
// resolves deterministically. Clicking an agent/workflow row opens exactly
// such a file; without this branch the section vanished the moment you looked
// at what an agent was doing.
//
// NOT used by the auto-mark-reviewed path (extension.ts): peeking at a raw
// sidechain log is not reviewing the conversation, and must not flip a
// pendingReview session to reviewed. That path stays on
// findActiveClaudeSession (webview tabs only).
export function findSessionForActiveTab(store: SessionStore): Session | undefined {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  if (input instanceof vscode.TabInputText) {
    return sessionFromLogPath(input.uri.fsPath, store);
  }
  return findActiveClaudeSession(store);
}

// Resolve a file under the projects dir to its session. Path shapes:
//   <root>/<encodedDir>/<sessionId>.jsonl                          (main log)
//   <root>/<encodedDir>/<sessionId>/subagents/agent-*.jsonl        (agent log)
//   <root>/<encodedDir>/<sessionId>/subagents/workflows/<run>/...  (wf agent)
//   <root>/<encodedDir>/<sessionId>/workflows/<run>.json           (run record)
function sessionFromLogPath(fsPath: string, store: SessionStore): Session | undefined {
  const root = normPath(store.getProjectsDir());
  const p = normPath(fsPath);
  if (!p.startsWith(root + path.sep)) {
    return undefined;
  }
  const segs = p.slice(root.length + 1).split(path.sep);
  if (segs.length < 2) {
    return undefined;
  }
  const sessionId =
    segs.length === 2
      ? segs[1].endsWith(".jsonl")
        ? segs[1].slice(0, -".jsonl".length)
        : undefined
      : segs[1];
  return sessionId ? store.getSession(sessionId) : undefined;
}

// The session shown in the currently focused editor tab, if that tab is a
// Claude conversation panel whose label matches a known session — by ai-title,
// by a rename, or (for untitled sessions, which Claude labels with a prompt)
// by the session's remembered prompts. Best-effort by design: an ambiguous
// label returns undefined rather than a guess. Ties on the strong keys resolve
// to the most recently written session — overwhelmingly the one you have open.
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
  // Three exact-match passes, strongest first. They never blend: a weaker
  // pass is consulted only when the stronger one found nothing at all.
  //   1. ai-title    — Claude's own label for a titled session (the original
  //                    join; unchanged semantics).
  //   2. customTitle — a rename here can't change Claude's tab label, so this
  //                    only fires when you renamed the session to what the tab
  //                    already says. Must never outrank a real ai-title match.
  //   3. promptIndex — an UNTITLED session's panel is labelled with the first
  //                    prompt typed in it, which is no field of its own. This
  //                    is the only way such a session joins at all, and it is
  //                    the loosest key (short prompts like "go" recur across
  //                    sessions), so it carries the fuzzy pass's guards:
  //                    in-workspace, and unambiguous.
  let exact: Session | undefined;
  let exactCustom: Session | undefined;
  const byPrompt: Session[] = [];
  const fuzzy: Session[] = [];
  const prefix = truncatedPrefix(label);
  for (const g of store.getGroups()) {
    for (const s of g.sessions) {
      const title = s.title?.trim();
      const custom = s.customTitle?.trim();
      if (title === label) {
        if (!exact || s.mtimeMs > exact.mtimeMs) {
          exact = s;
        }
      } else if (custom === label) {
        if (!exactCustom || s.mtimeMs > exactCustom.mtimeMs) {
          exactCustom = s;
        }
      } else if (
        prefix !== undefined &&
        ((title && title.startsWith(prefix)) || (custom && custom.startsWith(prefix)))
      ) {
        fuzzy.push(s);
      } else if (matchesPrompt(s, label, prefix)) {
        byPrompt.push(s);
      }
    }
  }
  if (exact ?? exactCustom) {
    return exact ?? exactCustom;
  }
  // Fuzzy (ellipsis-truncated label) is a weaker signal — generated titles
  // share long prefixes ("Fix …", "Refactor …"), so guard it twice: the
  // session must live in THIS window's workspace (a Claude tab always belongs
  // to the window's repo), and the surviving candidates must agree on a single
  // title. Ambiguity means bail: auto-marking the WRONG session reviewed is
  // strictly worse than requiring an explicit click.
  const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => normPath(f.uri.fsPath));
  const inWorkspace = fuzzy.filter((s) => s.cwd && folders.some((f) => pathRelated(normPath(s.cwd!), f)));
  const titles = new Set(inWorkspace.map((s) => (s.customTitle ?? s.title ?? "").trim()));
  if (titles.size === 1) {
    let best: Session | undefined;
    for (const s of inWorkspace) {
      if (!best || s.mtimeMs > best.mtimeMs) {
        best = s;
      }
    }
    return best;
  }
  // Prompt-keyed fallback, same reasoning as the fuzzy pass and then some: the
  // label must belong to exactly ONE in-workspace session, or we bail. Nothing
  // else identifies an untitled session, so "no answer" is the alternative,
  // not a better answer.
  const promptCandidates = byPrompt.filter(
    (s) => s.cwd && folders.some((f) => pathRelated(normPath(s.cwd!), f))
  );
  const ids = new Set(promptCandidates.map((s) => s.sessionId));
  return ids.size === 1 ? promptCandidates[0] : undefined;
}

// Does one of the session's remembered prompts equal the tab label (or, for an
// ellipsis-truncated label, start with it)? Guarded by a minimum length so a
// one-word prompt ("go", "yes") — which every session has — can't join.
const MIN_PROMPT_MATCH = 4;

function matchesPrompt(s: Session, label: string, prefix?: string): boolean {
  if (!s.promptIndex || label.length < MIN_PROMPT_MATCH) {
    return false;
  }
  return s.promptIndex.some((p) => p === label || (prefix !== undefined && p.startsWith(prefix)));
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

// Stable key of the active tab, used to skip refreshes when tab focus events
// fire without the active tab actually changing. Text tabs key only when the
// file lives under the projects dir (a session/agent/workflow file the
// "Current session" section follows); switching between ordinary editors
// keeps the "" key and triggers no tree re-render.
export function activeTabKey(projectsDir?: string): string {
  const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
  const input = tab?.input;
  if (input instanceof vscode.TabInputText) {
    const p = normPath(input.uri.fsPath);
    if (projectsDir && p.startsWith(normPath(projectsDir) + path.sep)) {
      return `text|${p}`;
    }
    return "";
  }
  if (!(input instanceof vscode.TabInputWebview)) {
    return "";
  }
  return `${input.viewType}|${tab!.label}`;
}
