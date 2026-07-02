import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { SessionStore } from "../data/sessionStore";
import { SeenStore } from "../data/seenStore";
import { dirExists } from "../data/paths";
import { log } from "../util/log";

type OpenMode = "newWindow" | "currentWindow" | "prompt";

// The Claude Code extension command that opens a session as an editor tab,
// taking a session id (this is what its `vscode://anthropic.claude-code/open
// ?session=<id>` deep link invokes under the hood). Falls back to the deep link.
const OPEN_SESSION_CMD = "claude-vscode.primaryEditor.open";
const NEW_CONVERSATION_CMD = "claude-vscode.newConversation";
const PENDING_OPEN_KEY = "claudeControlCenter.pendingOpenSession";
const PENDING_TTL_MS = 120_000;

function norm(p: string): string {
  return vscode.Uri.file(p).fsPath.replace(/\/+$/, "");
}

function inCurrentWorkspace(cwd: string): boolean {
  const target = norm(cwd);
  return (vscode.workspace.workspaceFolders ?? []).some((f) => norm(f.uri.fsPath) === target);
}

// Open a session as a tab via the Claude plugin (resolves by id within the
// current window's project). Falls back to the deep link.
async function openInPlugin(sessionId: string): Promise<void> {
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

// Row click: reopen THIS session. The plugin can only resolve a session within
// its own repo, so if the session lives in a different repo than the current
// window, open that repo in a new window and reopen the session there on load.
export async function openSession(
  store: SessionStore,
  context: vscode.ExtensionContext,
  sessionId: string,
  seen?: SeenStore
): Promise<void> {
  const session = store.getSession(sessionId);
  if (!session) {
    void vscode.window.showWarningMessage("Session not found (it may have been removed).");
    return;
  }
  // Opening = checking it: clear the "new since finished" mark at current mtime.
  void seen?.markSeen(sessionId, session.mtimeMs);
  const cwd = session.cwd;
  if (!cwd || inCurrentWorkspace(cwd)) {
    await openInPlugin(sessionId);
    return;
  }
  if (!dirExists(cwd)) {
    void vscode.window.showWarningMessage(`Repo path no longer exists: ${cwd}`);
    return;
  }
  log(`openSession: session in other repo (${cwd}); opening that window then reopening session`);
  await context.globalState.update(PENDING_OPEN_KEY, { action: "open", sessionId, cwd, ts: Date.now() });
  await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(cwd), { forceNewWindow: true });
}

interface PendingAction {
  action: "open" | "new";
  cwd: string;
  sessionId?: string;
  ts: number;
}

// On activation: if we just opened a window to act on a session/repo, do it now.
export async function consumePendingOpenSession(context: vscode.ExtensionContext): Promise<void> {
  const p = context.globalState.get<PendingAction>(PENDING_OPEN_KEY);
  if (!p) {
    return;
  }
  if (Date.now() - p.ts > PENDING_TTL_MS) {
    await context.globalState.update(PENDING_OPEN_KEY, undefined);
    return;
  }
  if (inCurrentWorkspace(p.cwd)) {
    await context.globalState.update(PENDING_OPEN_KEY, undefined);
    log(`consumePendingOpenSession: action=${p.action} cwd=${p.cwd}`);
    void runWhenReady(p);
  }
  // else: leave the marker for the window whose workspace matches.
}

// On a fresh window the Claude extension may not be active yet; wait for the
// needed command to register (up to ~10s) before acting.
async function runWhenReady(p: PendingAction): Promise<void> {
  const needed = p.action === "open" ? OPEN_SESSION_CMD : NEW_CONVERSATION_CMD;
  for (let i = 0; i < 20; i++) {
    const cmds = await vscode.commands.getCommands(true);
    if (cmds.includes(needed)) {
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (p.action === "open" && p.sessionId) {
    await openInPlugin(p.sessionId);
  } else {
    await newConversation();
  }
}

// "Start Claude here" (✦ on a session) — new conversation in the session's repo.
export async function newConversationForSession(
  store: SessionStore,
  context: vscode.ExtensionContext,
  sessionId: string
): Promise<void> {
  const session = store.getSession(sessionId);
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
  await context.globalState.update(PENDING_OPEN_KEY, { action: "new", cwd, ts: Date.now() });
  await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(cwd), { forceNewWindow: true });
}

async function newConversation(): Promise<void> {
  log(`newConversation: executing ${NEW_CONVERSATION_CMD}`);
  try {
    await vscode.commands.executeCommand(NEW_CONVERSATION_CMD);
  } catch (e) {
    log(`newConversation failed: ${e instanceof Error ? e.message : e}`);
    void vscode.window.showWarningMessage("Couldn't start a Claude conversation. Is the Claude Code extension installed?");
  }
}

// Permanently delete a session: removes its .jsonl log AND the sidecar dir
// (<projectDir>/<sessionId>/ — subagents, memory, file-history snapshots) from
// the Claude projects dir. Irreversible, so it always asks for a modal confirm.
export async function purgeSession(store: SessionStore, sessionId: string): Promise<void> {
  const session = store.getSession(sessionId);
  if (!session) {
    void vscode.window.showWarningMessage("Session not found (it may already be gone).");
    return;
  }
  const label = session.title || session.lastPrompt?.slice(0, 60) || sessionId.slice(0, 8);
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
    const sidecar = path.join(path.dirname(session.filePath), sessionId);
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
  sessionId: string,
  modeOverride?: OpenMode
): Promise<void> {
  const session = store.getSession(sessionId);
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
