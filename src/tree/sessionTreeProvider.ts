import * as vscode from "vscode";
import { ProjectGroup, RunningAgent, RunningWorkflow, Session, SessionStatus, UsageWindow } from "../model/types";
import { SessionStore } from "../data/sessionStore";
import { UsageService } from "../data/usageService";
import { ArchiveStore } from "../data/archiveStore";
import { SeenStore } from "../data/seenStore";
import { readModelSettings } from "../data/paths";
import { findSessionForActiveTab } from "../util/activeClaudeTab";
import { projectUri, WindowRepoDecorations } from "./sessionDecorations";

export class ProjectNode extends vscode.TreeItem {
  constructor(public readonly group: ProjectGroup) {
    super(group.label, vscode.TreeItemCollapsibleState.Expanded);
    this.id = "proj:" + group.key; // stable id so TreeView.reveal can match
    // Tag for the FileDecorationProvider so this window can tint its own
    // repo's row (custom scheme — not a real file, never opened).
    this.resourceUri = projectUri(group.key);
    // Compact: count first, then only the nonzero states in short words —
    // long descriptions get clipped by the sidebar before the useful bits.
    const parts = [`${group.sessions.length}`];
    if (group.activeCount > 0) {
      parts.push(`${group.activeCount} active`);
    }
    if (group.awaitingCount > 0) {
      parts.push(`${group.awaitingCount} awaiting`);
    }
    if (group.pendingReviewCount > 0) {
      parts.push(`${group.pendingReviewCount} review`);
    }
    if (group.finishedCount > 0) {
      parts.push(`${group.finishedCount} done`);
    }
    this.description = parts.join(" · ");
    // Namespaced so other extensions' menus (e.g. Mermaid's "Add Diagram",
    // scoped to viewItem == "project") don't leak onto our rows.
    this.contextValue = "ccProject";
    this.iconPath = new vscode.ThemeIcon("repo");
    this.tooltip = new vscode.MarkdownString(
      `**${group.label}**\n\n` +
        (group.cwd ? `\`${group.cwd}\`${group.cwdVerified ? "" : " (unverified)"}\n\n` : "") +
        `Active ${group.activeCount} · Awaiting ${group.awaitingCount} · To review ${group.pendingReviewCount} · Finished ${group.finishedCount} · Interrupted ${group.interruptedCount} · Idle ${group.idleCount}`
    );
  }
}

export class SessionNode extends vscode.TreeItem {
  constructor(
    public readonly session: Session,
    public readonly archived = false,
    public readonly iconsBase?: vscode.Uri,
    revision = 0
  ) {
    // Sessions are leaves EXCEPT while subagents or workflows are running:
    // those get an indented child row per live agent / workflow run. Expanded
    // (not Collapsed) because the whole point is seeing them without a click;
    // the id is revision-salted anyway, so VS Code can't persist a manual
    // collapse across refreshes.
    super(
      SessionNode.label(session),
      session.runningAgents.length > 0 || session.runningWorkflows.length > 0
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.None
    );
    const s = session;
    // Salted with the provider's refresh revision ON PURPOSE: the native tree
    // restores selection/focus by id across refreshes, so a stable id kept the
    // last-clicked session row grey-highlighted indefinitely — it read as a
    // stale "current session" marker. A fresh id every refresh means no
    // session row ever stays highlighted: clicking a row opens it, the open
    // marks it seen, and the resulting refresh sheds the selection right away.
    // Session rows are leaves (no collapse state) and are never reveal()ed by
    // id, so nothing else keys off id stability.
    this.id = `${s.filePath}@${revision}`;
    this.description = (archived ? "archived · " : "") + SessionNode.describe(s);
    // Suffix order matters: the `archived` token drives the archive/unarchive
    // menu split via regex in package.json. Keep "session" as the prefix so the
    // shared session menus still match.
    this.contextValue =
      `session-${s.status}` + (s.cwd ? "" : "-nocwd") + (archived ? "-archived" : "");
    this.iconPath = archived
      ? new vscode.ThemeIcon("archive", new vscode.ThemeColor("disabledForeground"))
      : SessionNode.icon(s.status, iconsBase);
    this.tooltip = SessionNode.tooltip(s);
    // Default click: smart open — opens the repo, or starts Claude if you're
    // already in that repo's window (where opening again would be a no-op).
    this.command = {
      command: "claudeControlCenter.openSession",
      title: "Open Session",
      arguments: [this],
    };
  }

  private static label(s: Session): string {
    const max = vscode.workspace
      .getConfiguration("claudeControlCenter")
      .get<number>("sidebarTitleMaxLength", 40);
    const raw = s.title || s.lastPrompt || s.sessionId.slice(0, 8);
    return max > 0 ? truncate(raw, max) : raw;
  }

  // Deliberately minimal — time and live agents only. Branch, model and
  // context size live in the tooltip and, for the focused session, in the
  // "Current session" section at the top of the tree; putting them on every
  // row just got clipped by the sidebar width.
  private static describe(s: Session): string {
    const bits: string[] = [relTime(s.mtimeMs)];
    // One count covering loose agents AND workflow agents — the tree below
    // the row shows the split.
    const live =
      s.runningAgents.length + s.runningWorkflows.reduce((n, w) => n + w.agents.length, 0);
    if (live > 0) {
      bits.push(`${live}⚡`);
    }
    return bits.join(" · ");
  }

  private static icon(
    status: SessionStatus,
    iconsBase?: vscode.Uri
  ): vscode.ThemeIcon | vscode.Uri {
    // Attention states use SVG-file icons with SMIL (<animate>) animations —
    // Chromium runs SMIL even for images used as CSS backgrounds, which is how
    // the tree renders file icons, so these genuinely move (codicons only
    // offer `~spin` rotation, which reads as noise at 16px). Quiet states stay
    // plain themed codicons.
    //   active       = green dot sweeping left<->right (working)
    //   awaiting     = exploding blue dot / radar ping (blocked on your input)
    //   pendingReview = pulsing orange dot (done, but you haven't checked it
    //                  since it last changed — your move)
    //   finished     = dim outline check (done AND reviewed)
    //   idle         = faint grey dot (stale: quiet > idle window)
    if (iconsBase) {
      if (status === "active") {
        return vscode.Uri.joinPath(iconsBase, "icons", "status-active.svg");
      }
      if (status === "awaiting") {
        return vscode.Uri.joinPath(iconsBase, "icons", "status-awaiting.svg");
      }
      if (status === "pendingReview") {
        return vscode.Uri.joinPath(iconsBase, "icons", "status-review.svg");
      }
    }
    // Codicon fallbacks (also used if no extensionUri was provided).
    if (status === "active") {
      return new vscode.ThemeIcon("loading~spin", new vscode.ThemeColor("charts.green"));
    }
    if (status === "awaiting") {
      return new vscode.ThemeIcon("bell~spin", new vscode.ThemeColor("charts.blue"));
    }
    if (status === "pendingReview") {
      return new vscode.ThemeIcon("pass-filled", new vscode.ThemeColor("charts.yellow"));
    }
    if (status === "finished") {
      // Dim outline check — done and you've already checked it.
      return new vscode.ThemeIcon("pass", new vscode.ThemeColor("disabledForeground"));
    }
    if (status === "interrupted") {
      // Unfinished turn (ESC / window died / API error) — orange stop sign.
      return new vscode.ThemeIcon("stop-circle", new vscode.ThemeColor("charts.orange"));
    }
    return new vscode.ThemeIcon("circle-outline", new vscode.ThemeColor("disabledForeground"));
  }

  private static tooltip(s: Session): vscode.MarkdownString {
    const a = s.aggregates;
    const tk = a.tokens;
    const total = tk.inputTokens + tk.outputTokens + tk.cacheCreationInputTokens + tk.cacheReadInputTokens;
    const md = new vscode.MarkdownString(undefined, true);
    md.appendMarkdown(`**${s.title || "(untitled session)"}**\n\n`);
    if (s.lastPrompt) {
      md.appendMarkdown(`_${truncate(s.lastPrompt, 140)}_\n\n`);
    }
    const label =
      s.status === "pendingReview"
        ? "pending review"
        : s.status === "finished"
          ? "finished · checked"
          : s.status;
    md.appendMarkdown(`Status: **${label}** · ${relTime(s.mtimeMs)}\n\n`);
    if (s.cwd) {
      md.appendMarkdown(`Repo: \`${s.cwd}\`${s.cwdVerified ? "" : " (unverified)"}\n\n`);
    }
    if (s.gitBranch) {
      md.appendMarkdown(`Branch: \`${s.gitBranch}\`\n\n`);
    }
    const modelLine = a.lastModel
      ? a.lastModel + (a.models.length > 1 ? ` (earlier: ${a.models.filter((m) => m !== a.lastModel).join(", ")})` : "")
      : a.models.join(", ") || "?";
    md.appendMarkdown(`Model: ${modelLine} · Turns: ${a.turns} · Tools: ${a.toolCalls}\n\n`);
    md.appendMarkdown(`Tokens: ${fmtNum(total)} · ~$${s.costUsd.toFixed(2)}\n\n`);
    if (a.lastContextTokens > 0) {
      md.appendMarkdown(
        `Context now: ~${fmtNum(a.lastContextTokens)} tokens (last call)` +
          (a.lastContextTokens >= CTX_WARN_TOKENS
            ? ` — **large**: sessions past ${fmtNum(CTX_WARN_TOKENS)} cost noticeably more per turn; consider /compact or /clear before the next task\n\n`
            : `\n\n`)
      );
    }
    if (a.filesTouched > 0) {
      md.appendMarkdown(`Files touched: ${a.filesTouched}\n\n`);
    }
    if (a.prLinks.length > 0) {
      md.appendMarkdown(`PRs: ${a.prLinks.map((p) => `[#${p.prNumber}](${p.prUrl})`).join(", ")}\n\n`);
    }
    if (a.hasSidechain || s.subagents.length > 0) {
      md.appendMarkdown(`Subagents: ${s.subagents.length || "yes"}\n\n`);
    }
    for (const w of s.runningWorkflows) {
      md.appendMarkdown(
        `Workflow: **${w.name ?? w.runId}** — ${w.agents.length} agent${w.agents.length === 1 ? "" : "s"} running` +
          (w.phase ? ` · ${w.phase}` : "") +
          `\n\n`
      );
    }
    md.appendMarkdown(`Session: \`${s.sessionId}\``);
    return md;
  }
}

// Indented child row under a session: one live Workflow-tool run, grouping
// its agents. Click opens the run record json (progress, results, script path).
export class WorkflowNode extends vscode.TreeItem {
  constructor(
    public readonly workflow: RunningWorkflow,
    public readonly iconsBase?: vscode.Uri
  ) {
    // Expanded for the same reason session rows with agents are: the point is
    // seeing the fan-out without a click.
    super(workflow.name ?? workflow.runId, vscode.TreeItemCollapsibleState.Expanded);
    const w = workflow;
    const bits = [`${w.agents.length}⚡`];
    if (w.phase) {
      bits.push(w.phase);
    }
    if (w.agentCount) {
      bits.push(`${w.agentCount} spawned`);
    }
    this.description = bits.join(" · ");
    this.contextValue = "ccWorkflow";
    this.iconPath = new vscode.ThemeIcon("type-hierarchy-sub", new vscode.ThemeColor("charts.purple"));
    this.tooltip = new vscode.MarkdownString(
      `**Workflow ${w.name ?? ""}** \`${w.runId}\`\n\n` +
        (w.phase ? `Phase: ${w.phase}\n\n` : "") +
        `${w.agents.length} agent${w.agents.length === 1 ? "" : "s"} writing now` +
        (w.agentCount ? ` · ${w.agentCount} spawned over the run` : "") +
        `\n\nLast write ${relTime(w.newestMtimeMs)}`
    );
    if (w.jsonPath) {
      this.command = {
        command: "vscode.open",
        title: "Open Workflow Run Record",
        arguments: [vscode.Uri.file(w.jsonPath)],
      };
    }
  }
}

// Indented child row under a session: one live subagent, purple sweeping dot.
// Click opens the agent's raw sidechain log.
export class AgentNode extends vscode.TreeItem {
  constructor(agent: RunningAgent, iconsBase?: vscode.Uri) {
    super(agent.description || agent.agentType, vscode.TreeItemCollapsibleState.None);
    this.description = agent.description ? agent.agentType : relTime(agent.mtimeMs);
    this.contextValue = "ccAgent";
    this.iconPath = iconsBase
      ? vscode.Uri.joinPath(iconsBase, "icons", "status-agents.svg")
      : new vscode.ThemeIcon("robot", new vscode.ThemeColor("charts.purple"));
    this.tooltip = new vscode.MarkdownString(
      `**${agent.description || "(no description)"}**\n\n` +
        `Type: \`${agent.agentType}\` · last write ${relTime(agent.mtimeMs)}\n\n` +
        `\`${agent.filePath}\``
    );
    this.command = {
      command: "vscode.open",
      title: "Open Agent Log",
      arguments: [vscode.Uri.file(agent.filePath)],
    };
  }
}

// A pinned "Usage" summary at the top of the tree.
export class UsageNode extends vscode.TreeItem {
  constructor() {
    super("Usage", vscode.TreeItemCollapsibleState.Expanded);
    this.contextValue = "usage";
    this.iconPath = new vscode.ThemeIcon("graph");
  }
}

// Pinned section for the session shown in the focused Claude tab: the
// per-session detail (model, branch, context) that used to crowd every row.
export class FocusedNode extends vscode.TreeItem {
  constructor(public readonly session: Session) {
    super("Current session", vscode.TreeItemCollapsibleState.Expanded);
    this.description = truncate(session.title ?? session.sessionId.slice(0, 8), 30);
    this.contextValue = "ccFocused";
    this.iconPath = new vscode.ThemeIcon("target");
  }
}

export class StatNode extends vscode.TreeItem {
  constructor(label: string, value: string, icon: string, color?: string, command?: vscode.Command) {
    super(value, vscode.TreeItemCollapsibleState.None);
    this.description = label;
    this.contextValue = "stat";
    this.iconPath = color
      ? new vscode.ThemeIcon(icon, new vscode.ThemeColor(color))
      : new vscode.ThemeIcon(icon);
    this.command = command;
  }
}

type TreeNode = UsageNode | FocusedNode | StatNode | ProjectNode | SessionNode | WorkflowNode | AgentNode;
export type SidebarStatusFilter = "all" | "active" | "awaiting" | "pendingReview" | "finished" | "interrupted" | "idle";

export class SessionTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private filter = "";
  private statusFilter: SidebarStatusFilter = "all";
  private hideIdle = true;
  private showArchived = false;
  private view?: vscode.TreeView<TreeNode>;
  // Bumped every refresh; salts session row ids so selection never survives a
  // refresh (see SessionNode id comment).
  private revision = 0;
  // Tints this window's own repo row (instead of hijacking selection).
  readonly decorations = new WindowRepoDecorations();

  constructor(
    private readonly store: SessionStore,
    private readonly usage: UsageService,
    private readonly archive: ArchiveStore,
    private readonly seen: SeenStore,
    private readonly extensionUri: vscode.Uri
  ) {
    this.hideIdle = vscode.workspace
      .getConfiguration("claudeControlCenter")
      .get<boolean>("sidebarHideIdle", true);
    store.onDidChange(() => this.fire());
    usage.onDidChange(() => this.fire());
    archive.onDidChange(() => this.fire());
    seen.onDidChange(() => this.fire());
  }

  attachView(view: vscode.TreeView<TreeNode>): void {
    this.view = view;
    this.updateMessage();
    this.decorations.setCurrent(this.currentGroupKeys());
  }

  refresh(): void {
    this.fire();
  }

  setFilter(text: string): void {
    this.filter = text.toLowerCase().trim();
    this.fire();
  }

  setStatusFilter(f: SidebarStatusFilter): void {
    this.statusFilter = f;
    this.fire();
  }

  toggleHideIdle(): void {
    this.hideIdle = !this.hideIdle;
    this.fire();
  }

  toggleShowArchived(): void {
    this.showArchived = !this.showArchived;
    this.fire();
  }

  clearFilters(): void {
    this.filter = "";
    this.statusFilter = "all";
    this.showArchived = false;
    this.fire();
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
    this.decorations.dispose();
  }

  getState(): {
    filter: string;
    statusFilter: SidebarStatusFilter;
    hideIdle: boolean;
    showArchived: boolean;
  } {
    return {
      filter: this.filter,
      statusFilter: this.statusFilter,
      hideIdle: this.hideIdle,
      showArchived: this.showArchived,
    };
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: TreeNode): TreeNode[] {
    if (!element) {
      const projects = this.store
        .getGroups()
        .map((g) => this.filtered(g))
        .filter((g): g is ProjectGroup => g !== undefined)
        .map((g) => new ProjectNode(g));
      // "Current session" only when the focused editor tab resolves to a
      // known session — the Claude panel (best-effort title join) or one of
      // the session's own files (agent log / workflow record, exact by path).
      const focused = findSessionForActiveTab(this.store);
      return [new UsageNode(), ...(focused ? [new FocusedNode(focused)] : []), ...projects];
    }
    if (element instanceof UsageNode) {
      return this.usageStats();
    }
    if (element instanceof FocusedNode) {
      return this.focusedStats(element.session);
    }
    if (element instanceof ProjectNode) {
      return element.group.sessions
        .filter((s) => this.matches(s))
        .map(
          (s) =>
            new SessionNode(
              s,
              this.archive.isArchived(s.sessionId),
              this.extensionUri,
              this.revision
            )
        );
    }
    if (element instanceof SessionNode) {
      // Workflow fan-outs first (grouped), then loose Agent-tool agents.
      return [
        ...element.session.runningWorkflows.map((w) => new WorkflowNode(w, element.iconsBase)),
        ...element.session.runningAgents.map((a) => new AgentNode(a, element.iconsBase)),
      ];
    }
    if (element instanceof WorkflowNode) {
      return element.workflow.agents.map((a) => new AgentNode(a, element.iconsBase));
    }
    return [];
  }

  // The project group(s) whose repo is open in THIS window. Match by
  // containment (either direction): a group's cwd is the repo root while a
  // workspace folder may be a subdir of it (or vice-versa), so exact equality
  // misses the common case and nothing gets highlighted. A multi-root window
  // matches every folder's group.
  //
  // Deliberately repo-level, not session-level: which SESSION is open in this
  // window is a guess (nothing in the jsonl says which tab a window shows, so
  // a ranking heuristic jumped between rows as statuses flipped). Which repo
  // this window has open is a fact — workspace folders — so the highlight is
  // deterministic and never moves on its own.
  private currentGroupKeys(): Set<string> {
    const keys = new Set<string>();
    const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => normPath(f.uri.fsPath));
    if (folders.length === 0) {
      return keys;
    }
    for (const g of this.store.getGroups()) {
      if (g.cwd && folders.some((f) => pathRelated(normPath(g.cwd!), f))) {
        keys.add(g.key);
      }
    }
    return keys;
  }

  private usageStats(): StatNode[] {
    const nodes: StatNode[] = [];

    // Real Claude subscription usage is opt-in (it reads the OAuth token and
    // hits the network). When off, show only local log-derived stats below.
    if (this.usage.isEnabled()) {
    // Real Claude subscription usage (same as the /usage command).
    const u = this.usage.getCurrent();
    const hasWindows = !!(u && (u.fiveHour || u.sevenDay));
    if (!u) {
      nodes.push(new StatNode("plan usage", "loading…", "loading~spin"));
    } else if (!hasWindows && u.error) {
      const n = new StatNode("plan usage", "unavailable", "warning", "charts.yellow");
      n.tooltip = u.error; // surface the real reason (no token in it)
      nodes.push(n);
    } else if (u) {
      // Show last-good windows even if the latest refresh errored (e.g. 429).
      if (u.fiveHour) {
        nodes.push(usageNode("Session", "5h", u.fiveHour));
      }
      if (u.sevenDay) {
        nodes.push(usageNode("Weekly", "7d", u.sevenDay));
      }
      if (u.sevenDayOpus) {
        nodes.push(usageNode("Opus weekly", "7d", u.sevenDayOpus));
      }
      if (u.sevenDaySonnet) {
        nodes.push(usageNode("Sonnet weekly", "7d", u.sevenDaySonnet));
      }
      if (u.sevenDayFable) {
        nodes.push(usageNode("Fable weekly", "7d", u.sevenDayFable));
      }
      if (u.error) {
        const n = new StatNode("usage", "stale", "warning", "charts.yellow");
        n.tooltip = u.error;
        nodes.push(n);
      }
    }
    }

    // Currently selected model + reasoning effort (from settings.json). This is
    // the WINDOW's default for new conversations — NOT per-session; each session
    // row shows its own model in its description/tooltip. There is no API to
    // set the model of an existing session from outside Claude Code; use
    // /model inside the conversation.
    const setModelCmd: vscode.Command = {
      command: "claudeControlCenter.setModel",
      title: "Set Claude Model",
    };
    const sel = readModelSettings(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);
    if (sel.model) {
      const n = new StatNode("default model (new sessions)", sel.model, "chip", "charts.blue", setModelCmd);
      n.tooltip =
        "Model selected in Claude settings.json — the default for NEW conversations in this window. " +
        "Click to change it. Per-session models are shown on each session row; change a running session's model with /model inside it.";
      nodes.push(n);
    } else {
      const n = new StatNode("default model (new sessions)", "auto", "chip", undefined, setModelCmd);
      n.tooltip = "No model pinned in Claude settings.json (Claude Code picks). Click to pin one.";
      nodes.push(n);
    }
    if (sel.effort) {
      nodes.push(new StatNode("effort", sel.effort, "settings-gear"));
    }

    // Local log-derived stats.
    const m = this.store.getMetrics();
    nodes.push(new StatNode("active now", String(m.activeSessions), "pulse", "charts.green"));
    if (m.awaitingSessions > 0) {
      nodes.push(new StatNode("awaiting input", String(m.awaitingSessions), "circle-filled", "charts.blue"));
    }
    if (m.pendingReviewSessions > 0) {
      nodes.push(new StatNode("to review", String(m.pendingReviewSessions), "pass-filled", "charts.yellow"));
    }
    if (m.finishedSessions > 0) {
      nodes.push(new StatNode("finished", String(m.finishedSessions), "pass", "charts.purple"));
    }
    return nodes;
  }

  // Detail rows for the focused tab's session — model, branch, live context.
  // This is where the per-row clutter moved: one place, only for the session
  // you're actually looking at.
  private focusedStats(s: Session): StatNode[] {
    const nodes: StatNode[] = [];
    const a = s.aggregates;

    const model = a.lastModel ?? a.models[0];
    if (model) {
      const n = new StatNode("model", shortModel([model]), "chip", "charts.green", {
        command: "claudeControlCenter.setModel",
        title: "Set Claude Model",
      });
      n.tooltip =
        `${model} — model of the focused Claude tab. Change a RUNNING session's model ` +
        "with /model inside it; click to change the default for new conversations.";
      nodes.push(n);
    }

    if (s.gitBranch) {
      nodes.push(new StatNode("branch", s.gitBranch, "git-branch"));
    }

    const ctx = a.lastContextTokens;
    if (ctx > 0) {
      const color =
        ctx >= CTX_WARN_TOKENS ? "charts.red" : ctx >= CTX_WARN_TOKENS * 0.66 ? "charts.yellow" : "charts.green";
      const n = new StatNode("context", `${fmtNum(ctx)} tokens`, "layers", color);
      n.tooltip =
        `Live context of this session (last call's prompt + output). ` +
        (ctx >= CTX_WARN_TOKENS
          ? `Past ${fmtNum(CTX_WARN_TOKENS)} every turn costs noticeably more — /compact or /clear before the next task.`
          : `Sessions past ${fmtNum(CTX_WARN_TOKENS)} land in the expensive bucket; /compact between tasks keeps this down.`);
      nodes.push(n);
    }

    const t = a.tokens;
    const total = t.inputTokens + t.outputTokens + t.cacheCreationInputTokens + t.cacheReadInputTokens;
    if (total > 0) {
      nodes.push(new StatNode("total spend", `${fmtNum(total)} · ~$${s.costUsd.toFixed(2)}`, "flame"));
    }
    return nodes;
  }

  private fire(): void {
    this.revision++;
    this.updateMessage();
    this._onDidChangeTreeData.fire();
    // Recompute which project row is this window's repo; no-ops if unchanged.
    this.decorations.setCurrent(this.currentGroupKeys());
  }

  private updateMessage(): void {
    if (!this.view) {
      return;
    }
    const parts: string[] = [];
    if (this.statusFilter !== "all") {
      parts.push(`status: ${this.statusFilter}`);
    }
    if (this.filter) {
      parts.push(`search: "${this.filter}"`);
    }
    if (this.showArchived) {
      parts.push("showing archived");
    }
    this.view.message = parts.length ? parts.join("  ·  ") : undefined;
  }

  private filtered(g: ProjectGroup): ProjectGroup | undefined {
    const sessions = g.sessions.filter((s) => this.matches(s));
    if (sessions.length === 0) {
      return undefined;
    }
    return { ...g, sessions };
  }

  private matches(s: Session): boolean {
    if (this.archive.isArchived(s.sessionId) && !this.showArchived) {
      return false;
    }
    if (this.statusFilter !== "all") {
      if (s.status !== this.statusFilter) {
        return false;
      }
    } else if (this.hideIdle && s.status === "idle") {
      return false;
    }
    if (this.filter) {
      const hay = [s.title, s.lastPrompt, s.gitBranch, s.cwd, s.sessionId, s.aggregates.models.join(" ")]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      if (!hay.includes(this.filter)) {
        return false;
      }
    }
    return true;
  }
}

// Context size where a session lands in the usage panel's ">150k context"
// bucket — the point where per-turn cost climbs even with caching.
const CTX_WARN_TOKENS = 150_000;

// Compact by design ("2h", not "2h ago") — session rows have ~30 chars of
// description before the sidebar clips them.
function relTime(ms: number): string {
  const diff = Date.now() - ms;
  const s = Math.floor(diff / 1000);
  if (s < 60) {
    return `${s}s`;
  }
  const m = Math.floor(s / 60);
  if (m < 60) {
    return `${m}m`;
  }
  const h = Math.floor(m / 60);
  if (h < 24) {
    return `${h}h`;
  }
  const d = Math.floor(h / 24);
  return `${d}d`;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

// Compact family name of the session's most-used model ("" when unknown).
function shortModel(models: string[]): string {
  if (models.length === 0) {
    return "";
  }
  const m = models[0].toLowerCase();
  for (const fam of ["opus", "sonnet", "haiku", "fable"]) {
    if (m.includes(fam)) {
      return fam;
    }
  }
  return models[0];
}

function normPath(p: string): string {
  return vscode.Uri.file(p).fsPath.replace(/\/+$/, "");
}

// True when two normalized paths are the same dir or one contains the other,
// matching on path-segment boundaries so "/a/foo" never matches "/a/foobar".
function pathRelated(a: string, b: string): boolean {
  if (a === b) {
    return true;
  }
  const [shorter, longer] = a.length < b.length ? [a, b] : [b, a];
  return longer.startsWith(shorter + "/");
}

function usageNode(label: string, span: string | undefined, w: UsageWindow): StatNode {
  const pct = Math.max(0, Math.min(100, Math.round(w.percent)));
  const filled = Math.round(pct / 10);
  const bar = "█".repeat(filled) + "░".repeat(10 - filled);
  const color =
    w.severity === "critical" || pct >= 90
      ? "charts.red"
      : w.severity === "warning" || pct >= 70
        ? "charts.yellow"
        : "charts.green";
  const icon = pct >= 90 ? "error" : pct >= 70 ? "warning" : "pass";
  const reset = w.resetsAt ? ` ${elapsedOf(w.resetsAt, span)}` : "";
  return new StatNode(label, `${bar} ${pct}%${reset}`, icon, color);
}

// Show time ELAPSED into the window over its total span, e.g. "4h07m/5h".
// resetsAt is when the window rolls over, so remaining = resetsAt - now and
// elapsed = span - remaining. Falls back to bare remaining if span unparseable.
function elapsedOf(iso: string, span?: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) {
    return "?";
  }
  const remaining = t - Date.now();
  const spanMs = span ? parseSpanMs(span) : undefined;
  if (!span || spanMs === undefined) {
    return remaining <= 0 ? "soon" : compactDur(remaining);
  }
  const elapsed = Math.max(0, Math.min(spanMs, spanMs - Math.max(0, remaining)));
  return `${compactDur(elapsed)}/${span}`;
}

function parseSpanMs(span: string): number | undefined {
  const m = span.match(/^(\d+)([mhdw])$/i);
  if (!m) {
    return undefined;
  }
  const n = Number(m[1]);
  const unit: Record<string, number> = {
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
    w: 604_800_000,
  };
  return n * unit[m[2].toLowerCase()];
}

function compactDur(ms: number): string {
  const totalMin = Math.floor(ms / 60_000);
  const d = Math.floor(totalMin / 1440);
  if (d >= 1) {
    return `${d}d`;
  }
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h >= 1) {
    return `${h}h${String(m).padStart(2, "0")}m`;
  }
  return `${m}m`;
}

function fmtNum(n: number): string {
  if (n >= 1_000_000) {
    return (n / 1_000_000).toFixed(2) + "M";
  }
  if (n >= 1_000) {
    return (n / 1_000).toFixed(1) + "k";
  }
  return String(n);
}
