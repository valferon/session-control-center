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
}

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
  private merged = new Map<string, number>();
  // Just this window's shard; what we persist.
  private own = new Map<string, number>();
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
        if ((this.merged.get(id) ?? 0) < m) {
          this.own.set(id, m);
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
      if ((this.merged.get(id) ?? 0) < m) {
        this.merged.set(id, m);
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
    return atMs <= (this.merged.get(sessionId) ?? 0);
  }

  // Record that you've checked this session at its current watermark.
  async markSeen(sessionId: string, atMs: number): Promise<void> {
    if ((this.own.get(sessionId) ?? 0) >= atMs && (this.merged.get(sessionId) ?? 0) >= atMs) {
      return;
    }
    this.own.set(sessionId, Math.max(this.own.get(sessionId) ?? 0, atMs));
    this.merged.set(sessionId, Math.max(this.merged.get(sessionId) ?? 0, atMs));
    await this.writeOwn();
    this._onDidChange.fire();
  }

  // Mark a batch of sessions checked in one write/event. Used by "mark all as
  // read". No-ops (single persist) if nothing actually changed.
  async markAllSeen(items: ReadonlyArray<{ sessionId: string; atMs: number }>): Promise<void> {
    let changed = false;
    for (const { sessionId, atMs } of items) {
      if ((this.own.get(sessionId) ?? 0) < atMs) {
        this.own.set(sessionId, atMs);
        changed = true;
      }
      if ((this.merged.get(sessionId) ?? 0) < atMs) {
        this.merged.set(sessionId, atMs);
        changed = true;
      }
    }
    if (!changed) {
      return;
    }
    await this.writeOwn();
    this._onDidChange.fire();
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
    const payload: SeenFile = { version: 1, seen: Object.fromEntries(this.own) };
    await vscode.workspace.fs.createDirectory(this.storageUri);
    await vscode.workspace.fs.writeFile(
      this.ownUri(),
      Buffer.from(JSON.stringify(payload), "utf8")
    );
  }

  // Read + union-merge every shard on disk into a fresh map.
  private async readAllShards(): Promise<Map<string, number>> {
    const out = new Map<string, number>();
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
        for (const [id, m] of Object.entries(parsed.seen ?? {})) {
          if ((out.get(id) ?? 0) < m) {
            out.set(id, m);
          }
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

  private mergeInto(src: Map<string, number>): void {
    for (const [id, m] of src) {
      if ((this.merged.get(id) ?? 0) < m) {
        this.merged.set(id, m);
      }
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
