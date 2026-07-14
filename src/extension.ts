import * as vscode from "vscode";
import { SessionCache } from "./data/cache";
import { SessionStore } from "./data/sessionStore";
import { ArchiveStore } from "./data/archiveStore";
import { SeenStore } from "./data/seenStore";
import { ProjectsWatcher } from "./data/watcher";
import { ProjectNode, SessionNode, SessionTreeProvider } from "./tree/sessionTreeProvider";
import { DashboardPanel } from "./webview/dashboardPanel";
import {
  consumePendingOpenSession,
  newConversationForSession,
  openSession,
  openSessionFolder,
  purgeSession,
  SessionRef,
  startClaudeInCwd,
} from "./actions/sessionActions";
import { SessionNotifier } from "./notifications/notifier";
import { UsageService } from "./data/usageService";
import { lastActivityMs } from "./data/jsonlParser";
import { modelSettingsFile, readModelSettings, writeModelSetting } from "./data/paths";
import { activeTabKey, findActiveClaudeSession } from "./util/activeClaudeTab";
import { initLog, log } from "./util/log";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  context.subscriptions.push(initLog());
  const cache = new SessionCache(context.globalStorageUri);
  await cache.load();

  const seen = new SeenStore(context.globalStorageUri, context.globalState);
  await seen.load();
  context.subscriptions.push({ dispose: () => seen.dispose() });
  const store = new SessionStore(cache, seen);
  const usage = new UsageService(context.globalStorageUri);
  context.subscriptions.push({ dispose: () => usage.dispose() });
  const archive = new ArchiveStore(context.globalState);
  context.subscriptions.push({ dispose: () => archive.dispose() });
  const treeProvider = new SessionTreeProvider(store, usage, archive, seen, context.extensionUri);

  // Opening a session marks it seen; re-scan so its status flips
  // pendingReview -> finished (cached parse, cheap).
  context.subscriptions.push(seen.onDidChange(() => void store.refresh()));

  const treeView = vscode.window.createTreeView("claudeControlCenter.sessions", {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
  });
  treeProvider.attachView(treeView);
  context.subscriptions.push(
    treeView,
    vscode.window.registerFileDecorationProvider(treeProvider.decorations),
    { dispose: () => treeProvider.dispose() }
  );

  // Initial scan + usage fetch. Jitter the usage fetch so multiple windows
  // restoring at once don't all hit the API before the shared claim is visible.
  void store.refresh();
  setTimeout(() => void usage.refresh(), Math.floor(Math.random() * 3000));

  // Live file watching.
  const watcher = new ProjectsWatcher(
    store.getProjectsDir(),
    (filePath) => void store.refreshFile(filePath),
    () => void store.refresh()
  );
  watcher.start();
  context.subscriptions.push({ dispose: () => watcher.dispose() });

  // Notifications on "finished work" transitions (active -> idle, new PR).
  const notifier = new SessionNotifier(store, context.globalStorageUri, (id) => void openSession(store, context, id, seen));
  context.subscriptions.push({ dispose: () => notifier.dispose() });

  // React immediately when the opt-in usage panel is toggled, instead of waiting
  // for the next poll: enabling fetches now, disabling clears the panel.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("claudeControlCenter.usage.enabled")) {
        void usage.refresh(true);
      }
      if (e.affectsConfiguration("claudeControlCenter.sidebarTitleMaxLength")) {
        treeProvider.refresh();
      }
    })
  );

  // Periodic re-scan so time-based status flips (active -> idle) are detected
  // even when a session simply went quiet (no file event to wake us). Cheap:
  // re-stat + cached parse. Drives both the notifier and live status.
  // seen.sync() first: poll-merge other windows' seen shards in case the
  // globalStorage watcher missed a write (out-of-workspace watchers are
  // best-effort), so cross-window "reviewed" marks converge within a tick.
  const tick = setInterval(() => {
    void seen.sync();
    void store.refresh();
  }, 30_000);
  context.subscriptions.push({ dispose: () => clearInterval(tick) });

  // Poll Claude subscription usage infrequently (remote API, rate-limited;
  // multiple windows compound, so keep this gentle). Backoff handles 429s.
  const usageTick = setInterval(() => void usage.refresh(), 300_000);
  context.subscriptions.push({ dispose: () => clearInterval(usageTick) });

  // Looking at a session IS reviewing it: when this window is focused and the
  // active editor tab is a Claude conversation panel showing a pendingReview
  // session, mark it seen — no sidebar click required. Covers the "alt-tab to
  // the window where the finished session's tab is already open" gap: that
  // switch fires no sidebar action, only window/tab events. Best-effort like
  // every tab↔session join here (matches by tab label vs session title, so
  // untitled sessions still need an explicit open).
  //
  // Re-entry is bounded, not looping: markSeen -> seen change -> store.refresh
  // -> store change -> here again, but by then the overlay reads "finished" and
  // the status gate skips. lastAutoMark additionally dedups the window BETWEEN
  // the (unawaited) markSeen and that refresh landing, where extra watcher
  // events would otherwise re-mark the same session+watermark with an ever-
  // higher Date.now() and write a shard each time.
  let lastAutoMark = "";
  const markFocusedSessionSeen = () => {
    if (!vscode.window.state.focused) {
      return; // tab may be "active" in an unfocused background window
    }
    const s = findActiveClaudeSession(store);
    if (!s || s.status !== "pendingReview") {
      return;
    }
    const markKey = `${s.sessionId}:${lastActivityMs(s.aggregates, s.mtimeMs)}`;
    if (markKey === lastAutoMark) {
      return; // already marked at this watermark; refresh hasn't landed yet
    }
    lastAutoMark = markKey;
    log(`auto-mark reviewed (focused tab): ${s.sessionId.slice(0, 8)} "${s.title ?? ""}"`);
    // Same watermark semantics as openSession: wall-clock now, floored at the
    // parsed watermark — the parse can lag the file, and marking at a stale
    // watermark would leave the session pendingReview on the next re-scan.
    void seen.markSeen(s.sessionId, Math.max(lastActivityMs(s.aggregates, s.mtimeMs), Date.now()));
  };
  // A session that flips to pendingReview WHILE its tab is focused (you watched
  // it finish) is also instantly reviewed.
  context.subscriptions.push(store.onDidChange(markFocusedSessionSeen));

  // The "model (focused session)" stat in the tree follows the focused editor
  // tab; refresh the tree when the active tab changes so it tracks what you're
  // actually looking at. Keyed so tab events that don't move focus (e.g. a
  // background tab closing) don't trigger pointless re-renders.
  let lastTabKey = activeTabKey();
  const onTabsChanged = () => {
    const key = activeTabKey();
    if (key !== lastTabKey) {
      lastTabKey = key;
      markFocusedSessionSeen();
      treeProvider.refresh();
    }
  };
  context.subscriptions.push(
    vscode.window.tabGroups.onDidChangeTabs(onTabsChanged),
    vscode.window.tabGroups.onDidChangeTabGroups(onTabsChanged)
  );

  // Resolve a session reference from a tree node or raw arg. A tree node
  // yields the exact Session object (unambiguous even when the same session id
  // exists under two project dirs); the dashboard sends bare ids.
  const sessionFrom = (arg: unknown): SessionRef | undefined => {
    if (arg instanceof SessionNode) {
      return arg.session;
    }
    if (typeof arg === "string") {
      return arg;
    }
    return undefined;
  };
  const sessionIdFrom = (arg: unknown): string | undefined => {
    const ref = sessionFrom(arg);
    return typeof ref === "string" ? ref : ref?.sessionId;
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("claudeControlCenter.refresh", () => {
      void store.refresh();
      void usage.refresh(true); // manual: bypass backoff
    }),
    vscode.commands.registerCommand("claudeControlCenter.search", async () => {
      const text = await vscode.window.showInputBox({
        prompt: "Filter sessions",
        placeHolder: "title, prompt, branch, repo, model, id…",
        value: treeProvider.getState().filter,
      });
      if (text !== undefined) {
        treeProvider.setFilter(text);
      }
    }),
    vscode.commands.registerCommand("claudeControlCenter.filterStatus", async () => {
      const pick = await vscode.window.showQuickPick(
        [
          { label: "All", value: "all" },
          { label: "Active", value: "active" },
          { label: "Awaiting input", value: "awaiting" },
          { label: "Pending review", value: "pendingReview" },
          { label: "Finished", value: "finished" },
          { label: "Interrupted", value: "interrupted" },
          { label: "Idle", value: "idle" },
        ],
        { placeHolder: "Show sessions with status…" }
      );
      if (pick) {
        treeProvider.setStatusFilter(pick.value as any);
      }
    }),
    vscode.commands.registerCommand("claudeControlCenter.markAllReviewed", async () => {
      const pending = store
        .getGroups()
        .flatMap((g) => g.sessions)
        .filter((s) => s.status === "pendingReview")
        // "Reviewed as of now": wall clock, floored at the parsed watermark
        // (same reasoning as openSession — the parse can lag the file, and
        // marking at a stale watermark leaves the session pendingReview).
        .map((s) => ({
          sessionId: s.sessionId,
          atMs: Math.max(lastActivityMs(s.aggregates, s.mtimeMs), Date.now()),
        }));
      if (pending.length === 0) {
        void vscode.window.showInformationMessage("No sessions pending review.");
        return;
      }
      await seen.markAllSeen(pending);
    }),
    vscode.commands.registerCommand("claudeControlCenter.toggleHideIdle", () => {
      treeProvider.toggleHideIdle();
    }),
    vscode.commands.registerCommand("claudeControlCenter.toggleShowArchived", () => {
      treeProvider.toggleShowArchived();
    }),
    vscode.commands.registerCommand("claudeControlCenter.archiveSession", (arg) => {
      const id = sessionIdFrom(arg);
      if (id) {
        void archive.archive(id);
      }
    }),
    vscode.commands.registerCommand("claudeControlCenter.unarchiveSession", (arg) => {
      const id = sessionIdFrom(arg);
      if (id) {
        void archive.unarchive(id);
      }
    }),
    vscode.commands.registerCommand("claudeControlCenter.clearFilters", () => {
      treeProvider.clearFilters();
    }),
    vscode.commands.registerCommand("claudeControlCenter.openDashboard", () => {
      DashboardPanel.show(context.extensionUri, store, usage, {
        openSession: (id, newWindow) =>
          void openSession(store, context, id, seen, { forceNewWindow: newWindow }),
        startClaude: (id) => void newConversationForSession(store, context, id),
      });
    }),
    vscode.commands.registerCommand("claudeControlCenter.openSession", (arg) => {
      const ref = sessionFrom(arg);
      if (ref) {
        void openSession(store, context, ref, seen);
      }
    }),
    vscode.commands.registerCommand("claudeControlCenter.newSessionInProject", (arg) => {
      if (arg instanceof ProjectNode) {
        void startClaudeInCwd(context, arg.group.cwd);
      } else {
        void vscode.window.showWarningMessage("No repo path for this project group.");
      }
    }),
    vscode.commands.registerCommand("claudeControlCenter.showLogs", () => {
      initLog().show();
    }),
    vscode.commands.registerCommand("claudeControlCenter.openSessionFolderNewWindow", (arg) => {
      const ref = sessionFrom(arg);
      if (ref) {
        void openSessionFolder(store, ref, "newWindow");
      }
    }),
    vscode.commands.registerCommand("claudeControlCenter.openSessionFolderHere", (arg) => {
      const ref = sessionFrom(arg);
      if (ref) {
        void openSessionFolder(store, ref, "currentWindow");
      }
    }),
    vscode.commands.registerCommand("claudeControlCenter.newConversationHere", (arg) => {
      const ref = sessionFrom(arg);
      if (ref) {
        void newConversationForSession(store, context, ref);
      }
    }),
    vscode.commands.registerCommand("claudeControlCenter.copySessionId", (arg) => {
      const id = sessionIdFrom(arg);
      if (id) {
        void vscode.env.clipboard.writeText(id);
        void vscode.window.showInformationMessage(`Copied session id ${id}`);
      }
    }),
    vscode.commands.registerCommand("claudeControlCenter.setModel", async () => {
      await setModel(treeProvider);
    }),
    vscode.commands.registerCommand("claudeControlCenter.deleteSession", (arg) => {
      // Exact Session from the clicked row — a duplicated conversation must
      // delete the copy the user pointed at, not whichever id lookup finds.
      const ref = sessionFrom(arg);
      if (ref) {
        void purgeSession(store, ref);
      }
    })
  );

  // Auto-open the view on startup (reveals it wherever it's docked — left
  // activity bar or, if you've moved it, the right/secondary side bar).
  if (vscode.workspace.getConfiguration("claudeControlCenter").get<boolean>("openOnStartup", true)) {
    setTimeout(() => {
      void vscode.commands.executeCommand("claudeControlCenter.sessions.focus");
    }, 800);
  }

  // If we just opened this window to reopen a session from another repo, do it.
  void consumePendingOpenSession(context);

  // Also consume on focus: when the target repo is ALREADY open in another
  // window, vscode.openFolder focuses that window instead of opening a new one,
  // so no activation ever fires there and the pending action would rot.
  context.subscriptions.push(
    vscode.window.onDidChangeWindowState((e) => {
      if (e.focused) {
        void consumePendingOpenSession(context);
        // Catch up on marks made in other windows the instant you switch back,
        // instead of waiting for the watcher (best-effort) or the 30s tick.
        void seen.sync();
        // Alt-tabbing into this window with a session's tab already active
        // counts as reviewing it — no tab event fires on a plain window switch.
        markFocusedSessionSeen();
      }
    })
  );
}

// Change the default model for NEW Claude conversations by writing the `model`
// key into Claude's own settings.json (global) or the repo's
// .claude/settings.local.json. Cannot retarget an already-running session —
// only /model inside the conversation can do that — so say so.
async function setModel(treeProvider: SessionTreeProvider): Promise<void> {
  const projectDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const current = readModelSettings(projectDir).model;

  const CUSTOM = "Custom model id…";
  const CLEAR = "Clear (let Claude Code pick)";
  const pick = await vscode.window.showQuickPick(
    [
      { label: "opus", description: "highest capability" },
      { label: "sonnet", description: "balanced (default)" },
      { label: "haiku", description: "fastest / cheapest" },
      { label: CUSTOM, description: "full id, e.g. claude-sonnet-5" },
      { label: CLEAR },
    ],
    { placeHolder: `Default model for new conversations${current ? ` (currently: ${current})` : ""}` }
  );
  if (!pick) {
    return;
  }
  let model: string | undefined;
  if (pick.label === CLEAR) {
    model = undefined;
  } else if (pick.label === CUSTOM) {
    const typed = await vscode.window.showInputBox({
      prompt: "Model id or alias to write into Claude settings",
      placeHolder: "claude-sonnet-5, claude-opus-4-8, …",
      value: current ?? "",
    });
    if (typed === undefined || !typed.trim()) {
      return;
    }
    model = typed.trim();
  } else {
    model = pick.label;
  }

  const scopeItems: Array<{ label: string; description: string; scope: "global" | "projectLocal" }> = [
    { label: "Globally", description: "~/.claude/settings.json — every project", scope: "global" },
  ];
  if (projectDir) {
    scopeItems.push({
      label: "This project",
      description: ".claude/settings.local.json — this repo only",
      scope: "projectLocal",
    });
  }
  const scopePick =
    scopeItems.length === 1
      ? scopeItems[0]
      : await vscode.window.showQuickPick(scopeItems, { placeHolder: "Where should this apply?" });
  if (!scopePick) {
    return;
  }
  const file = modelSettingsFile(scopePick.scope, projectDir);
  if (!file) {
    return;
  }
  try {
    writeModelSetting(file, model);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`setModel failed: ${msg}`);
    void vscode.window.showErrorMessage(`Couldn't update ${file}: ${msg}`);
    return;
  }
  log(`setModel: model=${model ?? "(cleared)"} scope=${scopePick.scope} file=${file}`);
  treeProvider.refresh();
  void vscode.window.showInformationMessage(
    model
      ? `Default model set to "${model}" for new conversations. Running sessions keep theirs — use /model inside a session to switch it.`
      : "Model cleared — Claude Code will pick the default for new conversations."
  );
}

export function deactivate(): void {
  // watchers disposed via context.subscriptions
}
