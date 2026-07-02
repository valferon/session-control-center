import * as vscode from "vscode";
import { SessionStore } from "../data/sessionStore";
import { Session } from "../model/types";

interface Seen {
  status: string;
  prCount: number;
}

// Watches session state transitions and surfaces VS Code notifications when an
// agent appears to have finished a piece of work:
//   - active -> finished/awaiting  (session went quiet — likely waiting on you / done)
//   - a new pr-link appears    (something shipped)
// First snapshot only seeds state (no burst of notifications on startup).
//
// `seen` is keyed by filePath, NOT sessionId: the same conversation can exist
// under multiple project dirs (a session moved/copied between repos), giving
// the store two Session objects that share a sessionId but carry different
// aggregates. Keying by sessionId let those two clobber each other's prCount,
// oscillating it (e.g. 4 <-> 0) and re-firing a stale PR toast every refresh.
export class SessionNotifier {
  private seen = new Map<string, Seen>();
  private seeded = false;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly store: SessionStore,
    private readonly openRepo: (sessionId: string) => void
  ) {
    this.store.onDidChange(() => this.evaluate(), undefined, this.disposables);
  }

  private cfg() {
    const c = vscode.workspace.getConfiguration("claudeControlCenter");
    return {
      enabled: c.get<boolean>("notifications.enabled", true),
      onIdle: c.get<boolean>("notifications.onFinish", true),
      onPr: c.get<boolean>("notifications.onPr", true),
      maxAgeMs: c.get<number>("notifications.maxAgeMinutes", 120) * 60_000,
    };
  }

  private lastActivity(s: Session): number {
    const e = s.aggregates.endedAt ? Date.parse(s.aggregates.endedAt) : NaN;
    return Number.isNaN(e) ? s.mtimeMs : e;
  }

  private evaluate(): void {
    const cfg = this.cfg();
    const sessions = this.allSessions();

    // Seed only once we actually have data, so a transient empty/partial scan
    // doesn't leave old sessions un-seeded and fire a backlog of stale events.
    if (!this.seeded) {
      if (sessions.length === 0) {
        return;
      }
      this.snapshotAll(sessions);
      this.seeded = true;
      return;
    }

    if (!cfg.enabled) {
      this.snapshotAll(sessions);
      return;
    }

    const now = Date.now();
    for (const s of sessions) {
      const prev = this.seen.get(s.filePath);
      const prCount = s.aggregates.prLinks.length;
      const recent = now - this.lastActivity(s) <= cfg.maxAgeMs;
      if (prev) {
        // "Finished/your turn": agent was working and just completed its turn
        // (active -> awaiting / finished). Age-gated so a host restart seeing a
        // long-stale transition won't fire a bogus toast.
        if (cfg.onIdle && prev.status === "active" && s.status !== "active" && recent) {
          this.notifyFinished(s);
        }
        // New PR: prLinks are deduped in the parser, so a count increase is a
        // genuinely new PR. PRs are often filed long after the conversation, so
        // no recency gate — notify whenever a new distinct PR appears.
        if (cfg.onPr && prCount > prev.prCount) {
          this.notifyPr(s);
        }
      }
      this.seen.set(s.filePath, { status: s.status, prCount });
    }

    // Evict entries for sessions no longer present so `seen` can't grow forever.
    if (this.seen.size > sessions.length) {
      const live = new Set(sessions.map((s) => s.filePath));
      for (const id of [...this.seen.keys()]) {
        if (!live.has(id)) {
          this.seen.delete(id);
        }
      }
    }
  }

  private snapshotAll(sessions: Session[]): void {
    for (const s of sessions) {
      this.seen.set(s.filePath, { status: s.status, prCount: s.aggregates.prLinks.length });
    }
  }

  private notifyFinished(s: Session): void {
    const name = s.title || s.lastPrompt?.slice(0, 50) || s.sessionId.slice(0, 8);
    const project = s.cwd ? s.cwd.split("/").pop() : "session";
    const verb =
      s.status === "awaiting"
        ? "is waiting for your input"
        : s.status === "finished" || s.status === "pendingReview"
          ? "finished its turn"
          : s.status === "interrupted"
            ? "was interrupted (unfinished)"
            : "went quiet";
    void vscode.window
      .showInformationMessage(`✓ Claude ${verb}: "${name}" (${project})`, "Open session")
      .then((choice) => {
        if (choice === "Open session") {
          this.openRepo(s.sessionId);
        }
      });
  }

  private notifyPr(s: Session): void {
    const pr = s.aggregates.prLinks[s.aggregates.prLinks.length - 1];
    const name = s.title || s.sessionId.slice(0, 8);
    void vscode.window
      .showInformationMessage(`🔗 PR #${pr.prNumber} linked: "${name}"`, "Open PR")
      .then((choice) => {
        if (choice === "Open PR" && pr.prUrl) {
          void vscode.env.openExternal(vscode.Uri.parse(pr.prUrl));
        }
      });
  }

  private allSessions(): Session[] {
    const out: Session[] = [];
    for (const g of this.store.getGroups()) {
      for (const s of g.sessions) {
        out.push(s);
      }
    }
    return out;
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
