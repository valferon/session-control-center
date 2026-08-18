import * as vscode from "vscode";
import { WINDOW_ID } from "../util/windowId";

const KEY = "claudeControlCenter.seenSessions";
// This window's own shard. Every window writes ONLY its own shard, so two
// windows never write the same file and can never clobber each other. The
// truth is the union of all shards, merged per-session by max(mtimeMs).
// Keyed on WINDOW_ID, NOT vscode.env.sessionId: VSCodium returns the literal
// placeholder "someValue.sessionId" in every window, which collapsed all
// windows onto ONE shard file and reintroduced the exact lost-update clobber
// this sharding exists to prevent.
const OWN_FILE = `seen-${WINDOW_ID}.json`;
// Matches OWN_FILE for every window AND the legacy single-file location
// (seen-sessions.json), so old data folds into the union for free.
const SHARD_GLOB = "seen-*.json";
const LEGACY_FILE = "seen-sessions.json";
// Prune shards from windows that haven't written in this long, so dead
// windows' files don't accumulate forever.
const STALE_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

interface SeenFile {
  version: 1;
  seen: Record<string, number>; // sessionId -> activity watermark last opened at
  // Wall clocks behind the read/unread last-write-wins pair. Optional: shards
  // written by older versions carry only `seen`, which reads back as "never
  // explicitly marked either way" (both clocks 0 = reviewed, old behaviour).
  seenAt?: Record<string, number>; // sessionId -> when the "seen" mark was made
  unread?: Record<string, number>; // sessionId -> when "mark as unread" was made
}

// One session's marks. Every field is grow-only (merged per-field by max), so
// the union of shards still converges regardless of write order. The read vs
// unread flip is therefore a last-write-wins register decided by COMPARING the
// two clocks — never by lowering the watermark or deleting an entry, which the
// grow-only merge would resurrect from another window's shard.
interface Mark {
  w: number; // activity watermark you last checked this session at
  seenAt: number; // wall clock of the newest "seen" mark
  unread: number; // wall clock of the newest explicit "mark as unread"
}

const EMPTY: Mark = { w: 0, seenAt: 0, unread: 0 };

// Persistent map of sessionId -> the session's conversational watermark
// (lastActivityMs) at the moment you last opened it. Drives the finished
// (reviewed) vs pendingReview overlay.
//
// Sharded per window (seen-<sessionId>.json under globalStorageUri) rather than
// a single shared file. A single shared file lost updates: every window kept
// its own in-memory copy and wrote the WHOLE map back, so a window writing from
// a stale copy would clobber another window's just-recorded "seen". With one
// shard per window there is exactly one writer per file, so writes never race;
// the merged truth is the union of all shards (per-session max mtimeMs), which
// is a grow-only CRDT and converges regardless of write order. A
// FileSystemWatcher over every shard makes each window re-merge the instant any
// window records a "seen".
export class SeenStore {
  // Union of all shards; what every query reads.
  private merged = new Map<string, Mark>();
  // Just this window's shard; what we persist.
  private own = new Map<string, Mark>();
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;
  private watcher?: vscode.FileSystemWatcher;

  constructor(
    private readonly storageUri: vscode.Uri,
    private readonly legacyState?: vscode.Memento
  ) {}

  // Load our own shard + merge every shard on disk, migrate one-time from the
  // old globalState location, then watch all shards for cross-window writes.
  async load(): Promise<void> {
    // Ensure the watch base exists BEFORE creating the watcher: a watcher on a
    // not-yet-existing directory never delivers events, so a window that hadn't
    // written its own shard yet would never see other windows' marks.
    try {
      await vscode.workspace.fs.createDirectory(this.storageUri);
    } catch {
      // read-only storage: shards degrade to this window's memory only
    }
    await this.mergeAllShards();
    // `own` starts EMPTY: this window persists only the marks it makes itself.
    // Seeding it from the union made every window rewrite the whole union into
    // a fresh per-reload shard (the shard name embeds WINDOW_ID, which changes
    // on every reload), growing storage O(reloads × sessions).

    // One-time migration: seed from the legacy globalState map so existing
    // "checked" marks aren't lost on upgrade. Compared against the merged
    // union — once any shard carries the legacy values, later loads no-op
    // instead of re-writing the legacy map into every new window's shard.
    if (this.legacyState) {
      const legacy = this.legacyState.get<Record<string, number>>(KEY, {});
      let changed = false;
      for (const [id, m] of Object.entries(legacy)) {
        if (this.get(id).w < m) {
          this.own.set(id, { ...EMPTY, w: m });
          changed = true;
        }
      }
      if (changed) {
        await this.writeOwn();
        this.mergeInto(this.own);
      }
    }

    await this.pruneStaleShards();
    this.startWatching();
  }

  private startWatching(): void {
    this.watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(this.storageUri, SHARD_GLOB)
    );
    const reload = () => void this.reloadFromDisk();
    this.watcher.onDidChange(reload);
    this.watcher.onDidCreate(reload);
    this.watcher.onDidDelete(reload);
  }

  // Re-merge every shard from disk and notify if the union grew. GROW-ONLY:
  // disk entries are merged INTO the in-memory union, never replace it. A
  // shard read mid-write (writeFile isn't atomic) parses as garbage and gets
  // skipped; replacing the union would drop that shard's marks and flip
  // reviewed sessions back to pendingReview until the next event. Monotonic
  // merge makes a torn read a harmless no-op. (Stale-shard pruning still
  // takes effect at next window load, which rebuilds from disk.)
  private async reloadFromDisk(): Promise<void> {
    const disk = await this.readAllShards();
    let changed = false;
    for (const [id, m] of disk) {
      const prev = this.get(id);
      const next = merge(prev, m);
      if (grew(prev, next)) {
        this.merged.set(id, next);
        changed = true;
      }
    }
    // Skip the event when nothing actually grew so we don't churn listeners
    // on our own writes (already reflected in this.merged).
    if (changed) {
      this._onDidChange.fire();
    }
  }

  // Poll-merge fallback for cross-window sync. The FileSystemWatcher over
  // globalStorage is best-effort (out-of-workspace watchers can silently miss
  // events); callers invoke this on the periodic tick and on window focus so a
  // missed event costs seconds, not a window reload.
  async sync(): Promise<void> {
    await this.reloadFromDisk();
  }

  // Have you opened this session at or after this conversational watermark
  // (lastActivityMs)? Drives the finished (reviewed) vs pendingReview overlay
  // in SessionStore. Independent of Session.status so it can be consulted
  // while status is still being computed.
  isReviewed(sessionId: string, atMs: number): boolean {
    const m = this.get(sessionId);
    return atMs <= m.w && m.unread <= m.seenAt;
  }

  // Have you explicitly flagged this session to come back to? Overrides the
  // watermark: a session you already checked reads as unreviewed (orange,
  // pendingReview) until an EXPLICIT read action clears it. Passive auto-marks
  // ("its tab is focused, so you must have read it") deliberately don't.
  isMarkedUnread(sessionId: string): boolean {
    const m = this.get(sessionId);
    return m.unread > m.seenAt;
  }

  // Record that you've checked this session at its current watermark.
  // `passive` marks come from focus/tab heuristics rather than a deliberate
  // open, so they leave an explicit "mark as unread" standing.
  async markSeen(sessionId: string, atMs: number, opts?: { passive?: boolean }): Promise<void> {
    if (opts?.passive && this.isMarkedUnread(sessionId)) {
      return;
    }
    if (this.applyOwn(sessionId, { ...EMPTY, w: atMs, seenAt: this.nextSeenAt(sessionId) })) {
      await this.writeOwn();
      this._onDidChange.fire();
    }
  }

  // Flag an already-checked session as unread again so it goes back to
  // pendingReview (orange) and you can return to it later.
  async markUnread(sessionId: string): Promise<void> {
    // Strictly above the newest seen clock, so a mark made in the same
    // millisecond as one still wins — the action you just took decides.
    const unread = Math.max(Date.now(), this.get(sessionId).seenAt + 1);
    if (this.applyOwn(sessionId, { ...EMPTY, unread })) {
      await this.writeOwn();
      this._onDidChange.fire();
    }
  }

  // Mark a batch of sessions checked in one write/event. Used by "mark all as
  // read". No-ops (single persist) if nothing actually changed.
  async markAllSeen(items: ReadonlyArray<{ sessionId: string; atMs: number }>): Promise<void> {
    let changed = false;
    for (const { sessionId, atMs } of items) {
      const mark: Mark = { ...EMPTY, w: atMs, seenAt: this.nextSeenAt(sessionId) };
      if (this.applyOwn(sessionId, mark)) {
        changed = true;
      }
    }
    if (!changed) {
      return;
    }
    await this.writeOwn();
    this._onDidChange.fire();
  }

  // --- mark bookkeeping ---

  private get(sessionId: string): Mark {
    return this.merged.get(sessionId) ?? EMPTY;
  }

  // Clock to stamp a "seen" mark with. Zero unless there's a standing unread
  // mark to beat: a clock that grew on every open would make each open (and
  // each passive auto-mark) a shard write, where re-marking the same watermark
  // used to be a no-op. When it does stamp, it lands at or above the unread
  // clock so a mark placed in the same millisecond doesn't outlive the open.
  private nextSeenAt(sessionId: string): number {
    const m = this.get(sessionId);
    return m.unread > m.seenAt ? Math.max(Date.now(), m.unread) : 0;
  }

  // Merge a mark into this window's shard AND the union. Returns whether
  // anything actually grew; nothing grew = nothing to persist or fire.
  private applyOwn(sessionId: string, mark: Mark): boolean {
    const ownPrev = this.own.get(sessionId) ?? EMPTY;
    const mergedPrev = this.get(sessionId);
    const own = merge(ownPrev, mark);
    const merged = merge(mergedPrev, mark);
    if (!grew(ownPrev, own) && !grew(mergedPrev, merged)) {
      return false;
    }
    this.own.set(sessionId, own);
    this.merged.set(sessionId, merged);
    return true;
  }

  dispose(): void {
    this.watcher?.dispose();
    this._onDidChange.dispose();
  }

  // --- shard IO ---

  private ownUri(): vscode.Uri {
    return vscode.Uri.joinPath(this.storageUri, OWN_FILE);
  }

  private async writeOwn(): Promise<void> {
    const payload: SeenFile = { version: 1, seen: {}, seenAt: {}, unread: {} };
    for (const [id, m] of this.own) {
      payload.seen[id] = m.w;
      // Skip zero clocks: an untouched field is indistinguishable from absent
      // on read, and shards stay as small as the pre-clock ones for the common
      // case (opened, never flagged).
      if (m.seenAt) {
        payload.seenAt![id] = m.seenAt;
      }
      if (m.unread) {
        payload.unread![id] = m.unread;
      }
    }
    await vscode.workspace.fs.createDirectory(this.storageUri);
    await vscode.workspace.fs.writeFile(
      this.ownUri(),
      Buffer.from(JSON.stringify(payload), "utf8")
    );
  }

  // Read + union-merge every shard on disk into a fresh map.
  private async readAllShards(): Promise<Map<string, Mark>> {
    const out = new Map<string, Mark>();
    let entries: [string, vscode.FileType][] = [];
    try {
      entries = await vscode.workspace.fs.readDirectory(this.storageUri);
    } catch {
      return out; // storage dir not created yet
    }
    for (const [name, type] of entries) {
      if (type !== vscode.FileType.File || !isShard(name)) {
        continue;
      }
      try {
        const buf = await vscode.workspace.fs.readFile(
          vscode.Uri.joinPath(this.storageUri, name)
        );
        const parsed = JSON.parse(Buffer.from(buf).toString("utf8")) as SeenFile;
        const ids = new Set([
          ...Object.keys(parsed.seen ?? {}),
          ...Object.keys(parsed.seenAt ?? {}),
          ...Object.keys(parsed.unread ?? {}),
        ]);
        for (const id of ids) {
          const mark: Mark = {
            w: parsed.seen?.[id] ?? 0,
            seenAt: parsed.seenAt?.[id] ?? 0,
            unread: parsed.unread?.[id] ?? 0,
          };
          out.set(id, merge(out.get(id) ?? EMPTY, mark));
        }
      } catch {
        // missing/corrupt shard: skip it, other shards still count
      }
    }
    return out;
  }

  private async mergeAllShards(): Promise<void> {
    this.merged = await this.readAllShards();
  }

  private mergeInto(src: Map<string, Mark>): void {
    for (const [id, m] of src) {
      this.merged.set(id, merge(this.get(id), m));
    }
  }

  // Delete other windows' shards not modified within STALE_MS. Never touches
  // our own shard or the legacy file (legacy has no window to rewrite it, but
  // it's small and harmless to keep).
  private async pruneStaleShards(): Promise<void> {
    let entries: [string, vscode.FileType][] = [];
    try {
      entries = await vscode.workspace.fs.readDirectory(this.storageUri);
    } catch {
      return;
    }
    const cutoff = Date.now() - STALE_MS;
    for (const [name, type] of entries) {
      if (type !== vscode.FileType.File || !isShard(name)) {
        continue;
      }
      if (name === OWN_FILE || name === LEGACY_FILE) {
        continue;
      }
      const uri = vscode.Uri.joinPath(this.storageUri, name);
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.mtime < cutoff) {
          await vscode.workspace.fs.delete(uri);
        }
      } catch {
        // racing another window's prune/write: ignore
      }
    }
  }
}

function isShard(name: string): boolean {
  return /^seen-.*\.json$/.test(name);
}

// Per-field max. Grow-only, commutative, idempotent — the property the whole
// shard union rests on.
function merge(a: Mark, b: Mark): Mark {
  return {
    w: Math.max(a.w, b.w),
    seenAt: Math.max(a.seenAt, b.seenAt),
    unread: Math.max(a.unread, b.unread),
  };
}

function grew(prev: Mark, next: Mark): boolean {
  return next.w > prev.w || next.seenAt > prev.seenAt || next.unread > prev.unread;
}
