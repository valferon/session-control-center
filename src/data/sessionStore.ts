import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import {
  DashboardMetrics,
  ProjectGroup,
  Session,
  SessionStatus,
} from "../model/types";
import {
  computeStatus,
  lastActivityMs,
  parseSessionFile,
  probeSidechain,
  SessionParser,
  SidechainProbe,
  StatusThresholds,
} from "./jsonlParser";
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

// How many recently-appended files keep a live incremental parser in memory.
// Only actively-written sessions benefit (the watcher fires on them every few
// seconds); parsers for files that went quiet are evicted LRU. Each parser
// retains per-session dedup sets that grow with the session's length (roughly
// one small entry per assistant message — a few hundred KB for a 10MB session),
// so the cap bounds the parser COUNT; per-parser size is bounded by the size
// of the session itself.
const HOT_PARSER_MAX = 16;

// Cold-scan parse parallelism. Parsing is stream-I/O bound; a small pool keeps
// the disk busy without starving the extension host event loop.
const SCAN_PARSE_CONCURRENCY = 8;

// Owns the in-memory session index, drives (cached) parsing, and exposes the
// grouped/aggregated view plus a change event for the UI.
export class SessionStore {
  private sessions = new Map<string, Session>(); // key = filePath
  // Live incremental parsers for hot (actively appended) files, LRU by last use.
  // Lets refreshFile parse only the appended tail instead of re-streaming the
  // whole multi-MB file on every watcher event. mtimeMs is the file mtime at
  // the last successful feed — a later stat with an OLDER mtime means the file
  // was replaced (e.g. restored from backup), so the parser must be dropped.
  private hotParsers = new Map<string, { parser: SessionParser; mtimeMs: number }>();
  // Serializes refreshFile per path: watcher events can outpace a slow feed and
  // two concurrent feeds on one parser would corrupt its accumulators.
  private fileOps = new Map<string, Promise<void>>();
  // One-shot settle timers (see scheduleSettle).
  private settleTimers = new Map<string, NodeJS.Timeout>();
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;
  private refreshing = false;
  private rerunRequested = false;
  // Set by dispose(): in-flight async work must not re-arm timers or fire the
  // (already disposed) change emitter afterwards.
  private disposed = false;

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
      // Holding a live status is only safe if SOMETHING re-evaluates after the
      // grace expires. A real finish stops the writes, so no watcher event is
      // coming — without this timer the downgrade waited for the 30s tick,
      // leaving a finished session showing "active" for up to grace+30s.
      this.scheduleSettle(filePath);
      return prev;
    }
    return overlaid;
  }

  // Sidechain probe (newest agent-log mtime + currently running agents),
  // gated to sessions that aren't idle anyway (readdir + a few stats per
  // session per evaluation; an idle session can't be flipped by sidechain
  // activity, so don't pay for it).
  private async sidechainActivity(
    filePath: string,
    sessionId: string,
    activityMs: number,
    now: number,
    thresholds: StatusThresholds
  ): Promise<SidechainProbe> {
    if (now - activityMs > thresholds.idleMs) {
      return { newestMtimeMs: 0, running: [], workflows: [] };
    }
    return probeSidechain(filePath, sessionId, thresholds, now);
  }

  // One-shot re-check of a file shortly after its downgrade grace expires.
  // Deduped per path; cleared when it fires (refreshFile recomputes and, if
  // the grace still applies, re-arms).
  private scheduleSettle(filePath: string): void {
    if (this.disposed || this.settleTimers.has(filePath)) {
      return;
    }
    this.settleTimers.set(
      filePath,
      setTimeout(() => {
        this.settleTimers.delete(filePath);
        void this.refreshFile(filePath);
      }, HOT_FILE_GRACE_MS + 1_000)
    );
  }

  dispose(): void {
    this.disposed = true;
    for (const t of this.settleTimers.values()) {
      clearTimeout(t);
    }
    this.settleTimers.clear();
    this._onDidChange.dispose();
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
    if (this.disposed) {
      return;
    }
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
      projectDirs = await fs.promises.readdir(root, { withFileTypes: true });
    } catch {
      this.sessions = next;
      this._onDidChange.fire();
      return;
    }

    // Enumerate + stat everything first (async, so hundreds of stats don't
    // block the extension host), splitting cache hits from files to parse.
    interface Candidate {
      filePath: string;
      encodedDir: string;
      st: fs.Stats;
    }
    const toParse: Candidate[] = [];
    await Promise.all(
      projectDirs
        .filter((pd) => pd.isDirectory())
        .map(async (pd) => {
          const encodedDir = pd.name;
          const dirPath = path.join(root, encodedDir);
          let files: string[];
          try {
            files = await fs.promises.readdir(dirPath);
          } catch {
            return;
          }
          await Promise.all(
            files
              .filter((f) => f.endsWith(".jsonl"))
              .map(async (f) => {
                const filePath = path.join(dirPath, f);
                let st: fs.Stats;
                try {
                  st = await fs.promises.stat(filePath);
                } catch {
                  return;
                }
                if (!st.isFile()) {
                  return;
                }
                livePaths.add(filePath);

                const cached = this.cache.get(filePath, st.mtimeMs, st.size);
                if (cached) {
                  // Reuse parse result; status depends on `now` and on
                  // sidechain freshness (both move without the file changing),
                  // so recompute it.
                  const activity = lastActivityMs(cached.aggregates, st.mtimeMs);
                  const sidechain = await this.sidechainActivity(filePath, cached.sessionId, activity, now, cfg.thresholds);
                  next.set(filePath, {
                    ...cached,
                    runningAgents: sidechain.running,
                    runningWorkflows: sidechain.workflows,
                    status: this.finalStatus(
                      filePath,
                      computeStatus(activity, cached.aggregates, cfg.thresholds, now, sidechain.newestMtimeMs),
                      cached.sessionId,
                      activity,
                      st.mtimeMs,
                      now
                    ),
                  });
                  return;
                }
                toParse.push({ filePath, encodedDir, st });
              })
          );
        })
    );

    // Parse cache misses with bounded parallelism (cold start parses everything;
    // steady state this is only files that changed since the last scan).
    await mapLimit(toParse, SCAN_PARSE_CONCURRENCY, async ({ filePath, encodedDir, st }) => {
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
        const activity = lastActivityMs(parsed.aggregates, st.mtimeMs);
        const sidechain = await this.sidechainActivity(filePath, parsed.sessionId, activity, now, cfg.thresholds);
        next.set(filePath, {
          ...parsed,
          runningAgents: sidechain.running,
          runningWorkflows: sidechain.workflows,
          status: this.finalStatus(
            filePath,
            computeStatus(activity, parsed.aggregates, cfg.thresholds, now, sidechain.newestMtimeMs),
            parsed.sessionId,
            activity,
            st.mtimeMs,
            now
          ),
        });
      } catch {
        // skip unreadable file
      }
    });

    // Drop incremental parsers for files that no longer exist. livePaths is a
    // snapshot from the enumeration phase — a parser created by refreshFile for
    // a file born mid-scan isn't in it, so double-check the disk before evicting.
    for (const p of [...this.hotParsers.keys()]) {
      if (!livePaths.has(p) && !fs.existsSync(p)) {
        this.hotParsers.delete(p);
      }
    }
    this.cache.prune(livePaths);
    void this.cache.flush();

    // Merge instead of wholesale replace: scan() enumerated/statted files at
    // its start, and a concurrent refreshFile() may have written a FRESHER
    // parse into this.sessions while we were parsing. Overwriting it with the
    // older snapshot would revert a live status until the next tick. Keep the
    // live entry when it reflects a newer file version; keep entries for files
    // born after the scan's enumeration pass (fresh mtime but absent from
    // next); genuinely deleted files (old mtime, not re-added) drop out.
    for (const [p, live] of this.sessions) {
      const scanned = next.get(p);
      if (scanned) {
        if (live.mtimeMs > scanned.mtimeMs) {
          next.set(p, live);
        }
      } else if (!livePaths.has(p) && live.mtimeMs >= now) {
        next.set(p, live);
      }
    }
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
  // Serialized per path: a second call for the same file waits for the first,
  // so two feeds never run on one incremental parser concurrently.
  async refreshFile(filePath: string): Promise<void> {
    const prev = this.fileOps.get(filePath) ?? Promise.resolve();
    const run = prev.then(() => this.doRefreshFile(filePath)).catch(() => undefined);
    this.fileOps.set(filePath, run);
    await run;
    if (this.fileOps.get(filePath) === run) {
      this.fileOps.delete(filePath);
    }
  }

  private async doRefreshFile(filePath: string): Promise<void> {
    if (this.disposed) {
      return;
    }
    const cfg = SessionStore.readConfig();
    const now = Date.now();
    let st: fs.Stats;
    try {
      st = await fs.promises.stat(filePath);
    } catch {
      // deleted
      this.hotParsers.delete(filePath);
      if (this.sessions.delete(filePath)) {
        this._onDidChange.fire();
      }
      return;
    }
    // A concurrent scan (or an earlier queued refresh) may have already stored
    // a parse of a NEWER file version; recomputing from this older stat and
    // unconditionally storing it would clobber the fresher status until the
    // next event. Equal mtime still refreshes (time-based status recompute).
    const existing = this.sessions.get(filePath);
    if (existing && existing.mtimeMs > st.mtimeMs) {
      return;
    }
    const encodedDir = path.basename(path.dirname(filePath));
    // Watcher can double-fire with unchanged mtime/size; reuse cache to avoid
    // re-parsing a multi-MB file needlessly.
    const before = this.sessions.get(filePath)?.status;
    const cached = this.cache.get(filePath, st.mtimeMs, st.size);
    if (cached) {
      const activity = lastActivityMs(cached.aggregates, st.mtimeMs);
      const sidechain = await this.sidechainActivity(filePath, cached.sessionId, activity, now, cfg.thresholds);
      const session: Session = {
        ...cached,
        runningAgents: sidechain.running,
        runningWorkflows: sidechain.workflows,
        status: this.finalStatus(
          filePath,
          computeStatus(activity, cached.aggregates, cfg.thresholds, now, sidechain.newestMtimeMs),
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
    // Incremental fast path: reuse the live parser for this file and consume
    // only the appended tail. Falls back to a fresh parser (full parse) when
    // there is none, the file shrank/was rewritten (offset past EOF), its
    // mtime went backwards (same-size replacement), or the bytes just before
    // the parser's offset no longer match what it consumed (in-place rewrite
    // that shrank AND regrew between watcher events — e.g. /rewind — which the
    // size/mtime checks cannot see and would corrupt the incremental parse).
    const hot = this.hotParsers.get(filePath);
    let parser = hot?.parser;
    if (
      !parser ||
      st.size < parser.byteOffset ||
      (hot && st.mtimeMs < hot.mtimeMs) ||
      !(await parser.tailIntact())
    ) {
      parser = new SessionParser(filePath, encodedDir);
    }
    try {
      await parser.feed();
      // Re-verify AFTER consuming: a rewrite that lands between the pre-check
      // and the read stream (or during it) leaves the parser holding garbage.
      // Detected now, it costs one clean full parse instead of a wrong status
      // cached under the current (mtime,size).
      if (!(await parser.tailIntact())) {
        parser = new SessionParser(filePath, encodedDir);
        await parser.feed();
      }
      const parsed = await parser.finalize(st.mtimeMs, st.size, cfg.thresholds, now);
      this.hotParserTouch(filePath, parser, st.mtimeMs);
      this.cache.set(parsed);
      const activity = lastActivityMs(parsed.aggregates, st.mtimeMs);
      const sidechain = await this.sidechainActivity(filePath, parsed.sessionId, activity, now, cfg.thresholds);
      const session: Session = {
        ...parsed,
        runningAgents: sidechain.running,
        runningWorkflows: sidechain.workflows,
        status: this.finalStatus(
          filePath,
          computeStatus(activity, parsed.aggregates, cfg.thresholds, now, sidechain.newestMtimeMs),
          parsed.sessionId,
          activity,
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
      // Read failed mid-stream: the parser state may be partial — drop it so
      // the next event does a clean full parse.
      this.hotParsers.delete(filePath);
    }
  }

  // LRU insert/refresh for the incremental-parser pool.
  private hotParserTouch(filePath: string, parser: SessionParser, mtimeMs: number): void {
    this.hotParsers.delete(filePath);
    this.hotParsers.set(filePath, { parser, mtimeMs });
    while (this.hotParsers.size > HOT_PARSER_MAX) {
      const oldest = this.hotParsers.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.hotParsers.delete(oldest);
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

// Run fn over items with at most `limit` in flight. Individual failures are
// the callback's business (callers catch inside fn); rejections propagate.
async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const item = items[i++];
      await fn(item);
    }
  });
  await Promise.all(workers);
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
