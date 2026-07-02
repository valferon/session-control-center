import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { SessionStore } from "../data/sessionStore";
import { SeenStore } from "../data/seenStore";
import { lastActivityMs } from "../data/jsonlParser";
import { dirExists } from "../data/paths";
import { Session } from "../model/types";
import { log } from "../util/log";

type OpenMode = "newWindow" | "currentWindow" | "prompt";

// The Claude Code extension command that opens a session as an editor tab,
// taking a session id (this is what its `vscode://anthropic.claude-code/open
// ?session=<id>` deep link invokes under the hood). Falls back to the deep link.
// Called with NO session id it opens a brand-new conversation panel — which is
// also how "new conversation" is started here: `claude-vscode.newConversation`
// only notifies already-connected Claude webviews and silently no-ops when none
// is open (fresh window, panel never opened), which made the button look dead.
const OPEN_SESSION_CMD = "claude-vscode.primaryEditor.open";
const NEW_CONVERSATION_CMD = "claude-vscode.newConversation";
// viewType of the plugin's session editor tabs (as seen via the tab API).
const CLAUDE_PANEL_VIEW_TYPE = "claudeVSCodePanel";
const PENDING_OPEN_KEY = "claudeControlCenter.pendingOpenSession";
const PENDING_TTL_MS = 120_000;

// A session action argument: the exact Session (from a tree node — never
// ambiguous) or a bare id (from the dashboard). Ids are resolved via the store,
// which prefers the most recently written copy when the same conversation
// exists under multiple project dirs.
export type SessionRef = Session | string;

function resolveSession(store: SessionStore, ref: SessionRef): Session | undefined {
  return typeof ref === "string" ? store.getSession(ref) : ref;
}

function norm(p: string): string {
  return vscode.Uri.file(p).fsPath.replace(/\/+$/, "");
}

function inCurrentWorkspace(cwd: string): boolean {
  const target = norm(cwd);
  return (vscode.workspace.workspaceFolders ?? []).some((f) => norm(f.uri.fsPath) === target);
}

// Editor-group focus commands by visual group index (tabGroups.all order).
const FOCUS_GROUP_CMDS = [
  "workbench.action.focusFirstEditorGroup",
  "workbench.action.focusSecondEditorGroup",
  "workbench.action.focusThirdEditorGroup",
  "workbench.action.focusFourthEditorGroup",
  "workbench.action.focusFifthEditorGroup",
  "workbench.action.focusSixthEditorGroup",
  "workbench.action.focusSeventhEditorGroup",
  "workbench.action.focusEighthEditorGroup",
];

// The plugin dedups open-session calls against panels it has REGISTERED, but a
// panel restored on window reload registers only once its webview boots (the
// serializer restores it without a session id), so a restored tab that hasn't
// been focused since the reload is invisible to that dedup and the open command
// would spawn a DUPLICATE tab of the same session. Best-effort guard: find an
// existing Claude panel tab whose label matches the session title and focus it
// instead. The label is the only handle the tab API exposes (a webview tab
// carries no session id), so an untitled session simply falls through to the
// plugin call — same behavior as before, no worse.
async function revealExistingClaudeTab(session: Session): Promise<boolean> {
  const title = session.title;
  if (!title) {
    return false;
  }
  const groups = vscode.window.tabGroups.all;
  for (let g = 0; g < groups.length; g++) {
    const tabs = groups[g].tabs;
    for (let i = 0; i < tabs.length; i++) {
      const input = tabs[i].input;
      if (
        !(input instanceof vscode.TabInputWebview) ||
        !input.viewType.includes(CLAUDE_PANEL_VIEW_TYPE) ||
        tabs[i].label !== title
      ) {
        continue;
      }
      // No direct "activate tab" API: focus the group, then select the tab by
      // index. The index commands only cover the first 9 tabs / 8 groups;
      // anything deeper falls through to the plugin (worst case: old behavior).
      if (g >= FOCUS_GROUP_CMDS.length || i >= 9) {
        return false;
      }
      try {
        await vscode.commands.executeCommand(FOCUS_GROUP_CMDS[g]);
        await vscode.commands.executeCommand(`workbench.action.openEditorAtIndex${i + 1}`);
        log(`revealExistingClaudeTab: focused existing tab "${title}"`);
        return true;
      } catch {
        return false;
      }
    }
  }
  return false;
}

// Open a session as a tab via the Claude plugin (resolves by id within the
// current window's project). Falls back to the deep link.
async function openSessionIdInPlugin(sessionId: string): Promise<void> {
  try {
    await vscode.commands.executeCommand(OPEN_SESSION_CMD, sessionId);
    log(`openInPlugin: opened ${sessionId} via ${OPEN_SESSION_CMD}`);
  } catch (e) {
    log(`openInPlugin: cmd failed (${e instanceof Error ? e.message : e}); deep link`);
    const ok = await vscode.env.openExternal(
      vscode.Uri.parse(`vscode://anthropic.claude-code/open?session=${encodeURIComponent(sessionId)}`)
    );
    if (!ok) {
      void vscode.window.showWarningMessage("Couldn't open the session. Is the Claude Code extension installed?");
    }
  }
}

async function openInPlugin(session: Session): Promise<void> {
  if (await revealExistingClaudeTab(session)) {
    return;
  }
  await openSessionIdInPlugin(session.sessionId);
}

// Row click: reopen THIS session. The plugin can only resolve a session within
// its own repo, so if the session lives in a different repo than the current
// window (or the caller explicitly asked for a new window), open that repo's
// window and reopen the session there on load/focus.
export async function openSession(
  store: SessionStore,
  context: vscode.ExtensionContext,
  ref: SessionRef,
  seen?: SeenStore,
  opts?: { forceNewWindow?: boolean }
): Promise<void> {
  const session = resolveSession(store, ref);
  if (!session) {
    void vscode.window.showWarningMessage("Session not found (it may have been removed).");
    return;
  }
  // Opening = checking it: clear the "new since finished" mark at the current
  // conversational watermark. NOT file mtime: non-conversational rewrites
  // (ai-title regen, history snapshots) bump mtime and would flip an already
  // reviewed session back to pendingReview.
  void seen?.markSeen(session.sessionId, lastActivityMs(session.aggregates, session.mtimeMs));
  const cwd = session.cwd;
  const forceNew = opts?.forceNewWindow ?? false;
  if (!forceNew && (!cwd || inCurrentWorkspace(cwd))) {
    await openInPlugin(session);
    return;
  }
  if (!cwd) {
    // A new window was asked for but there's no repo path to open one on;
    // opening the session here beats doing nothing.
    await openInPlugin(session);
    return;
  }
  if (!dirExists(cwd)) {
    void vscode.window.showWarningMessage(`Repo path no longer exists: ${cwd}`);
    return;
  }
  log(`openSession: opening window for ${cwd} then reopening session there`);
  await context.globalState.update(PENDING_OPEN_KEY, {
    action: "open",
    sessionId: session.sessionId,
    cwd,
    ts: Date.now(),
    srcWindow: vscode.env.sessionId,
  });
  await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(cwd), { forceNewWindow: true });
}

interface PendingAction {
  action: "open" | "new";
  cwd: string;
  sessionId?: string;
  ts: number;
  // Window that queued the action. That window must never consume its own
  // marker: a same-repo "open in new window" would otherwise be swallowed by
  // the requesting window (its workspace matches cwd) before the new window
  // ever appears.
  srcWindow?: string;
}

// Called on activation AND whenever this window gains focus: if a window was
// just opened (or focused — VS Code reuses an existing window when the folder
// is already open, so activation alone never fires there) to act on a
// session/repo, do it now.
export async function consumePendingOpenSession(context: vscode.ExtensionContext): Promise<void> {
  const p = context.globalState.get<PendingAction>(PENDING_OPEN_KEY);
  if (!p) {
    return;
  }
  if (Date.now() - p.ts > PENDING_TTL_MS) {
    await context.globalState.update(PENDING_OPEN_KEY, undefined);
    return;
  }
  if (p.srcWindow && p.srcWindow === vscode.env.sessionId) {
    return; // our own request; the target window consumes it
  }
  if (inCurrentWorkspace(p.cwd)) {
    await context.globalState.update(PENDING_OPEN_KEY, undefined);
    log(`consumePendingOpenSession: action=${p.action} cwd=${p.cwd}`);
    void runWhenReady(p);
  }
  // else: leave the marker for the window whose workspace matches.
}

// On a fresh window the Claude extension may not be active yet; wait for the
// needed command to register (up to ~10s) before acting. Both actions go
// through OPEN_SESSION_CMD (see its comment for why not NEW_CONVERSATION_CMD).
async function runWhenReady(p: PendingAction): Promise<void> {
  for (let i = 0; i < 20; i++) {
    const cmds = await vscode.commands.getCommands(true);
    if (cmds.includes(OPEN_SESSION_CMD)) {
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (p.action === "open" && p.sessionId) {
    await openSessionIdInPlugin(p.sessionId);
  } else {
    await newConversation();
  }
}

// "Start Claude here" (✦ on a session) — new conversation in the session's repo.
export async function newConversationForSession(
  store: SessionStore,
  context: vscode.ExtensionContext,
  ref: SessionRef
): Promise<void> {
  const session = resolveSession(store, ref);
  if (!session) {
    return;
  }
  await startClaudeInCwd(context, session.cwd);
}

// Project "+" button — new conversation in that project's repo. Opens the repo's
// window first if it isn't the current one, so the chat starts in the right place.
export async function startClaudeInCwd(context: vscode.ExtensionContext, cwd?: string): Promise<void> {
  if (!cwd || inCurrentWorkspace(cwd)) {
    await newConversation();
    return;
  }
  if (!dirExists(cwd)) {
    void vscode.window.showWarningMessage(`Repo path no longer exists: ${cwd}`);
    return;
  }
  log(`startClaudeInCwd: opening ${cwd} then starting a new conversation there`);
  await context.globalState.update(PENDING_OPEN_KEY, {
    action: "new",
    cwd,
    ts: Date.now(),
    srcWindow: vscode.env.sessionId,
  });
  await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(cwd), { forceNewWindow: true });
}

async function newConversation(): Promise<void> {
  log(`newConversation: opening a new conversation panel via ${OPEN_SESSION_CMD}`);
  try {
    // No session id = brand-new conversation panel. Deliberately NOT
    // NEW_CONVERSATION_CMD: that only notifies already-connected Claude
    // webviews and silently does nothing when none is open.
    await vscode.commands.executeCommand(OPEN_SESSION_CMD);
  } catch (e) {
    log(`newConversation: ${OPEN_SESSION_CMD} failed (${e instanceof Error ? e.message : e}); trying ${NEW_CONVERSATION_CMD}`);
    try {
      await vscode.commands.executeCommand(NEW_CONVERSATION_CMD);
    } catch (e2) {
      log(`newConversation failed: ${e2 instanceof Error ? e2.message : e2}`);
      void vscode.window.showWarningMessage("Couldn't start a Claude conversation. Is the Claude Code extension installed?");
    }
  }
}

// Permanently delete a session: removes its .jsonl log AND the sidecar dir
// (<projectDir>/<sessionId>/ — subagents, memory, file-history snapshots) from
// the Claude projects dir. Irreversible, so it always asks for a modal confirm.
// Takes the exact Session from the clicked tree row when available, so a
// conversation duplicated across project dirs never deletes the wrong copy.
export async function purgeSession(store: SessionStore, ref: SessionRef): Promise<void> {
  const session = resolveSession(store, ref);
  if (!session) {
    void vscode.window.showWarningMessage("Session not found (it may already be gone).");
    return;
  }
  const label = session.title || session.lastPrompt?.slice(0, 60) || session.sessionId.slice(0, 8);
  const choice = await vscode.window.showWarningMessage(
    `Permanently delete this session?\n\n"${label}"`,
    {
      modal: true,
      detail: `This deletes the log file from disk and cannot be undone.\n${session.filePath}`,
    },
    "Delete"
  );
  if (choice !== "Delete") {
    return;
  }
  try {
    await fs.promises.rm(session.filePath, { force: true });
    const sidecar = path.join(path.dirname(session.filePath), session.sessionId);
    await fs.promises.rm(sidecar, { recursive: true, force: true });
    log(`purgeSession: deleted ${session.filePath}`);
    await store.refresh();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`purgeSession failed: ${msg}`);
    void vscode.window.showErrorMessage(`Couldn't delete session: ${msg}`);
  }
}

// Explicit "open repo" action (folder icon) — opens the repo as a window.
export async function openSessionFolder(
  store: SessionStore,
  ref: SessionRef,
  modeOverride?: OpenMode
): Promise<void> {
  const session = resolveSession(store, ref);
  const cwd = session?.cwd;
  if (!cwd) {
    void vscode.window.showWarningMessage("No verified repo path for this session.");
    return;
  }
  if (!dirExists(cwd)) {
    void vscode.window.showWarningMessage(`Repo path no longer exists: ${cwd}`);
    return;
  }
  const mode =
    modeOverride ??
    vscode.workspace.getConfiguration("claudeControlCenter").get<OpenMode>("openFolderMode", "newWindow");
  let forceNewWindow = mode === "newWindow";
  if (mode === "prompt") {
    const pick = await vscode.window.showQuickPick(["New Window", "This Window"], { placeHolder: `Open ${cwd}` });
    if (!pick) {
      return;
    }
    forceNewWindow = pick === "New Window";
  }
  await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(cwd), { forceNewWindow });
}
