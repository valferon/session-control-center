import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import {
  DashboardMetrics,
  ProjectGroup,
  Session,
  SessionStatus,
} from "../model/types";
import { computeStatus, lastActivityMs, parseSessionFile, StatusThresholds } from "./jsonlParser";
import { decodeEncodedDir, resolveProjectsDir } from "./paths";
import { SessionCache } from "./cache";
import { SeenStore } from "./seenStore";
import { debug, debugEnabled, log } from "../util/log";

export interface StoreConfig {
  projectsDir: string;
  thresholds: StatusThresholds;
}

// How recently the file must have been written for the downgrade grace to
// apply (see finalStatus). Long enough to ride out a turn boundary (end_turn
// written, next record lands a moment later); short enough that a genuinely
// finished session settles by the next periodic re-scan.
const HOT_FILE_GRACE_MS = 10_000;

// Owns the in-memory session index, drives (cached) parsing, and exposes the
// grouped/aggregated view plus a change event for the UI.
export class SessionStore {
  private sessions = new Map<string, Session>(); // key = filePath
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;
  private refreshing = false;
  private rerunRequested = false;

  constructor(
    private readonly cache: SessionCache,
    private readonly seen: SeenStore
  ) {}

  // Split a clean-end "finished" into "pendingReview" (not opened since its last
  // change) vs "finished" (already reviewed). This is a SeenStore overlay on top
  // of the jsonl-derived status; every place that stores/reads a Session status
  // goes through here so the tree, metrics and filters stay consistent.
  //
  // Keyed on the CONVERSATIONAL watermark (lastActivityMs), not raw file mtime:
  // non-conversational rewrites (ai-title regen, file-history snapshots) bump
  // mtime and were flipping already-reviewed sessions back to pendingReview.
  private applySeenOverlay(status: SessionStatus, sessionId: string, activityMs: number): SessionStatus {
    if (status === "finished" && !this.seen.isReviewed(sessionId, activityMs)) {
      return "pendingReview";
    }
    return status;
  }

  // Seen overlay + downgrade grace, applied to every freshly computed status.
  //
  // The grace kills turn-boundary flicker: at the instant a turn's end_turn is
  // the tail of the file (the next user/queue record is milliseconds away, or
  // mid-write and skipped as a partial JSON line), a scan computes
  // finished/pendingReview even though the session is mid-conversation. If the
  // session was live a moment ago (prev active/awaiting) and the file is still
  // hot (written < HOT_FILE_GRACE_MS ago), hold the previous live status; a
  // real finish stops the writes, the file cools, and the very next re-scan
  // (watcher event or the 30s tick) lets the downgrade through.
  private finalStatus(
    filePath: string,
    computed: SessionStatus,
    sessionId: string,
    activityMs: number,
    mtimeMs: number,
    now: number
  ): SessionStatus {
    const overlaid = this.applySeenOverlay(computed, sessionId, activityMs);
    const prev = this.sessions.get(filePath)?.status;
    if (
      (prev === "active" || prev === "awaiting") &&
      (overlaid === "finished" || overlaid === "pendingReview") &&
      now - mtimeMs < HOT_FILE_GRACE_MS
    ) {
      return prev;
    }
    return overlaid;
  }

  static readConfig(): StoreConfig {
    const cfg = vscode.workspace.getConfiguration("claudeControlCenter");
    const activeMin = cfg.get<number>("activeThresholdMinutes", 5);
    const idleHours = cfg.get<number>("idleThresholdHours", 24);
    return {
      projectsDir: resolveProjectsDir(cfg.get<string>("projectsDir", "")),
      thresholds: {
        activeMs: activeMin * 60_000,
        idleMs: idleHours * 3_600_000,
      },
    };
  }

  getProjectsDir(): string {
    return SessionStore.readConfig().projectsDir;
  }

  // The same conversation can exist under multiple project dirs (a session
  // moved/copied between repos), giving two Session objects with one sessionId.
  // Prefer the most recently written copy so id-based actions (open, mark seen,
  // delete-by-id from the dashboard) land on the live one, not whichever copy
  // map iteration happens to yield first.
  getSession(sessionId: string): Session | undefined {
    let best: Session | undefined;
    for (const s of this.sessions.values()) {
      if (s.sessionId === sessionId && (!best || s.mtimeMs > best.mtimeMs)) {
        best = s;
      }
    }
    return best;
  }

  // Full reconcile of the projects dir. Coalesces concurrent calls.
  async refresh(): Promise<void> {
    if (this.refreshing) {
      this.rerunRequested = true;
      return;
    }
    this.refreshing = true;
    try {
      await this.scan();
      // Loop instead of recursing: coalesce any requests that arrived mid-scan
      // into exactly one trailing scan, with no concurrent-scan window.
      while (this.rerunRequested) {
        this.rerunRequested = false;
        await this.scan();
      }
    } finally {
      this.refreshing = false;
    }
  }

  private async scan(): Promise<void> {
    const cfg = SessionStore.readConfig();
    const now = Date.now();
    const root = cfg.projectsDir;
    const livePaths = new Set<string>();
    const next = new Map<string, Session>();

    let projectDirs: fs.Dirent[];
    try {
      projectDirs = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      this.sessions = next;
      this._onDidChange.fire();
      return;
    }

    for (const pd of projectDirs) {
      if (!pd.isDirectory()) {
        continue;
      }
      const encodedDir = pd.name;
      const dirPath = path.join(root, encodedDir);
      let files: string[];
      try {
        files = fs.readdirSync(dirPath);
      } catch {
        continue;
      }
      for (const f of files) {
        if (!f.endsWith(".jsonl")) {
          continue;
        }
        const filePath = path.join(dirPath, f);
        let st: fs.Stats;
        try {
          st = fs.statSync(filePath);
        } catch {
          continue;
        }
        if (!st.isFile()) {
          continue;
        }
        livePaths.add(filePath);

        const cached = this.cache.get(filePath, st.mtimeMs, st.size);
        if (cached) {
          // Reuse parse result; status depends on `now`, so recompute it.
          const activity = lastActivityMs(cached.aggregates, st.mtimeMs);
          const session: Session = {
            ...cached,
            status: this.finalStatus(
              filePath,
              computeStatus(activity, cached.aggregates, cfg.thresholds, now),
              cached.sessionId,
              activity,
              st.mtimeMs,
              now
            ),
          };
          next.set(filePath, session);
          continue;
        }

        try {
          const parsed = await parseSessionFile(
            filePath,
            encodedDir,
            st.mtimeMs,
            st.size,
            cfg.thresholds,
            now
          );
          this.cache.set(parsed);
          const session: Session = {
            ...parsed,
            status: this.finalStatus(
              filePath,
              parsed.status,
              parsed.sessionId,
              lastActivityMs(parsed.aggregates, st.mtimeMs),
              st.mtimeMs,
              now
            ),
          };
          next.set(filePath, session);
        } catch {
          // skip unreadable file
        }
      }
    }

    this.cache.prune(livePaths);
    void this.cache.flush();
    this.logStatusChanges(this.sessions, next, cfg.thresholds, now);
    this.sessions = next;
    this._onDidChange.fire();
  }

  // Diagnostics for the "status is unreliable" reports: always log a session
  // whose status flipped (low volume, the interesting events), and dump every
  // session's decision inputs when debugLogging is on (high volume, opt-in).
  // Point me at the "Claude Control Center" output channel after reproducing.
  private logStatusChanges(
    prev: Map<string, Session>,
    next: Map<string, Session>,
    thresholds: StatusThresholds,
    now: number
  ): void {
    const verbose = debugEnabled();
    for (const [filePath, s] of next) {
      const before = prev.get(filePath)?.status;
      if (before !== s.status) {
        log(`status ${before ?? "new"} -> ${s.status}  ${statusFactors(s, thresholds, now)}`);
      } else if (verbose) {
        debug(`status = ${s.status}  ${statusFactors(s, thresholds, now)}`);
      }
    }
  }

  // Re-parse a single file (used by the watcher for targeted updates).
  async refreshFile(filePath: string): Promise<void> {
    const cfg = SessionStore.readConfig();
    const now = Date.now();
    let st: fs.Stats;
    try {
      st = fs.statSync(filePath);
    } catch {
      // deleted
      if (this.sessions.delete(filePath)) {
        this._onDidChange.fire();
      }
      return;
    }
    const encodedDir = path.basename(path.dirname(filePath));
    // Watcher can double-fire with unchanged mtime/size; reuse cache to avoid
    // re-parsing a multi-MB file needlessly.
    const before = this.sessions.get(filePath)?.status;
    const cached = this.cache.get(filePath, st.mtimeMs, st.size);
    if (cached) {
      const activity = lastActivityMs(cached.aggregates, st.mtimeMs);
      const session: Session = {
        ...cached,
        status: this.finalStatus(
          filePath,
          computeStatus(activity, cached.aggregates, cfg.thresholds, now),
          cached.sessionId,
          activity,
          st.mtimeMs,
          now
        ),
      };
      this.sessions.set(filePath, session);
      if (before !== session.status) {
        log(`status ${before ?? "new"} -> ${session.status}  ${statusFactors(session, cfg.thresholds, now)}`);
      }
      this._onDidChange.fire();
      return;
    }
    try {
      const parsed = await parseSessionFile(
        filePath,
        encodedDir,
        st.mtimeMs,
        st.size,
        cfg.thresholds,
        now
      );
      this.cache.set(parsed);
      const session: Session = {
        ...parsed,
        status: this.finalStatus(
          filePath,
          parsed.status,
          parsed.sessionId,
          lastActivityMs(parsed.aggregates, st.mtimeMs),
          st.mtimeMs,
          now
        ),
      };
      this.sessions.set(filePath, session);
      if (before !== session.status) {
        log(`status ${before ?? "new"} -> ${session.status}  ${statusFactors(session, cfg.thresholds, now)}`);
      }
      void this.cache.flush();
      this._onDidChange.fire();
    } catch {
      // ignore
    }
  }

  getGroups(): ProjectGroup[] {
    const byKey = new Map<string, ProjectGroup>();
    for (const s of this.sessions.values()) {
      const key = s.cwd ?? `enc:${s.encodedDir}`;
      let g = byKey.get(key);
      if (!g) {
        const label = s.cwd
          ? path.basename(s.cwd)
          : path.basename(decodeEncodedDir(s.encodedDir));
        g = {
          key,
          label: label || key,
          cwd: s.cwd,
          cwdVerified: s.cwdVerified,
          sessions: [],
          activeCount: 0,
          awaitingCount: 0,
          pendingReviewCount: 0,
          finishedCount: 0,
          interruptedCount: 0,
          idleCount: 0,
          lastActivityMs: 0,
        };
        byKey.set(key, g);
      }
      g.sessions.push(s);
      if (s.status === "active") {
        g.activeCount++;
      } else if (s.status === "awaiting") {
        g.awaitingCount++;
      } else if (s.status === "pendingReview") {
        g.pendingReviewCount++;
      } else if (s.status === "finished") {
        g.finishedCount++;
      } else if (s.status === "interrupted") {
        g.interruptedCount++;
      } else if (s.status === "idle") {
        g.idleCount++;
      }
      // Sort by real conversational activity, consistent with status logic.
      g.lastActivityMs = Math.max(g.lastActivityMs, lastActivityMs(s.aggregates, s.mtimeMs));
    }

    const groups = [...byKey.values()];
    for (const g of groups) {
      g.sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
    }
    // Alphabetical by label so repos hold a stable position and don't jump
    // around as activity changes. Case-insensitive; ties broken by key.
    groups.sort(
      (a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }) || a.key.localeCompare(b.key)
    );
    return groups;
  }

  getMetrics(): DashboardMetrics {
    let totalTokens = 0;
    let totalCost = 0;
    let active = 0;
    let awaiting = 0;
    let pendingReview = 0;
    let finished = 0;
    let openPrs = 0;
    const projects = new Set<string>();
    for (const s of this.sessions.values()) {
      const t = s.aggregates.tokens;
      totalTokens += t.inputTokens + t.outputTokens + t.cacheCreationInputTokens + t.cacheReadInputTokens;
      totalCost += s.costUsd;
      if (s.status === "active") {
        active++;
      } else if (s.status === "awaiting") {
        awaiting++;
      } else if (s.status === "pendingReview") {
        pendingReview++;
      } else if (s.status === "finished") {
        finished++;
      }
      openPrs += s.aggregates.prLinks.length; // prLinks already deduped in parser
      projects.add(s.cwd ?? `enc:${s.encodedDir}`);
    }
    return {
      totalSessions: this.sessions.size,
      activeSessions: active,
      awaitingSessions: awaiting,
      pendingReviewSessions: pendingReview,
      finishedSessions: finished,
      totalProjects: projects.size,
      totalTokens,
      totalCostUsd: totalCost,
      openPrs,
    };
  }
}

// One-line dump of everything that fed computeStatus, so a wrong status in the
// log can be traced to its cause without re-reading the jsonl by hand.
function statusFactors(s: Session, thresholds: StatusThresholds, now: number): string {
  const a = s.aggregates;
  const last = lastActivityMs(a, s.mtimeMs);
  const endedOk = a.endedAt && !Number.isNaN(Date.parse(a.endedAt));
  const ageS = Math.round((now - last) / 1000);
  const id = s.sessionId.slice(0, 8);
  const title = (s.title || s.lastPrompt || "").slice(0, 40);
  return (
    `${id} "${title}" | age=${ageS}s via=${endedOk ? "endedAt" : "mtime"} ` +
    `role=${a.lastConvRole ?? "-"} stop=${a.lastStopReason ?? "-"} awaiting=${a.awaitingInput} interrupted=${a.interrupted} qd=${a.queueDepth} ` +
    `activeMs=${thresholds.activeMs} idleMs=${thresholds.idleMs} ` +
    `endedAt=${a.endedAt ?? "-"} mtime=${new Date(s.mtimeMs).toISOString()}`
  );
}
