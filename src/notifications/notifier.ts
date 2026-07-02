import * as vscode from "vscode";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { SessionStore } from "../data/sessionStore";
import { Session } from "../model/types";

interface Seen {
  status: string;
  prCount: number;
}

// Claim files older than this are pruned; long past any dedup relevance.
const CLAIM_TTL_MS = 7 * 24 * 3_600_000;
// How long an unfocused window waits before trying to claim an event, so the
// window the user is actually looking at wins the claim and shows the toast.
const UNFOCUSED_CLAIM_DELAY_MS = 1_500;

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
//
// Cross-window dedup: every VS Code window runs its own notifier over the same
// files, so each transition would toast N times for N windows. Before showing,
// a notifier must CLAIM the event by exclusively creating a claim file
// (O_CREAT|O_EXCL — atomic on the local fs) named after a key that every
// window derives identically from the jsonl (sessionId + the finishing
// record's timestamp / the PR url). Exactly one window wins; focused windows
// try first so the toast lands where the user is looking.
export class SessionNotifier {
  private seen = new Map<string, Seen>();
  private seeded = false;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly claimsDir: string;

  constructor(
    private readonly store: SessionStore,
    storageUri: vscode.Uri,
    private readonly openRepo: (sessionId: string) => void
  ) {
    this.claimsDir = path.join(storageUri.fsPath, "notify-claims");
    this.store.onDidChange(() => this.evaluate(), undefined, this.disposables);
    void this.pruneClaims();
  }

  // Exclusively create the claim file for this event. True = we own the toast.
  private async claim(eventKey: string): Promise<boolean> {
    if (!vscode.window.state.focused) {
      await new Promise((r) => setTimeout(r, UNFOCUSED_CLAIM_DELAY_MS));
    }
    const file = path.join(
      this.claimsDir,
      crypto.createHash("sha1").update(eventKey).digest("hex") + ".json"
    );
    try {
      await fs.promises.mkdir(this.claimsDir, { recursive: true });
      await fs.promises.writeFile(file, JSON.stringify({ key: eventKey, at: Date.now() }), {
        flag: "wx", // fail if it exists: another window claimed first
      });
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === "EEXIST") {
        return false;
      }
      return true; // fs trouble — fail open: a duplicate toast beats a missing one
    }
  }

  private async pruneClaims(): Promise<void> {
    let entries: string[];
    try {
      entries = await fs.promises.readdir(this.claimsDir);
    } catch {
      return; // dir doesn't exist yet
    }
    const cutoff = Date.now() - CLAIM_TTL_MS;
    for (const e of entries) {
      const p = path.join(this.claimsDir, e);
      try {
        const st = await fs.promises.stat(p);
        if (st.mtimeMs < cutoff) {
          await fs.promises.rm(p, { force: true });
        }
      } catch {
        // racing another window's prune: ignore
      }
    }
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
          void this.notifyFinished(s);
        }
        // New PR: prLinks are deduped in the parser, so a count increase is a
        // genuinely new PR. PRs are often filed long after the conversation, so
        // no recency gate — notify whenever a new distinct PR appears.
        if (cfg.onPr && prCount > prev.prCount) {
          void this.notifyPr(s);
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

  private async notifyFinished(s: Session): Promise<void> {
    // Key on the finishing record's timestamp: every window parses the same
    // file, so they all derive the same key for the same turn end. Falls back
    // to mtime when the file had no timestamped records.
    const key = `${s.sessionId}:turn-end:${s.aggregates.endedAt ?? s.mtimeMs}`;
    if (!(await this.claim(key))) {
      return; // another window is showing this one
    }
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

  private async notifyPr(s: Session): Promise<void> {
    const pr = s.aggregates.prLinks[s.aggregates.prLinks.length - 1];
    // Keyed by PR url — stable and identical across windows.
    if (!(await this.claim(`${s.sessionId}:pr:${pr.prUrl}`))) {
      return;
    }
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
