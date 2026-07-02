import * as vscode from "vscode";
import { Session } from "../model/types";

const KEY = "claudeControlCenter.seenSessions";
const FILE_NAME = "seen-sessions.json";

interface SeenFile {
  version: 1;
  seen: Record<string, number>; // sessionId -> mtimeMs last opened at
}

// Persistent map of sessionId -> the session mtimeMs at the moment you last
// opened it. Drives the finished (reviewed) vs pendingReview overlay.
//
// Stored in a JSON file under globalStorageUri (NOT globalState) so it can be
// watched: globalState is a per-window in-memory Memento with no cross-window
// change event, so a session marked seen in one window would stay pendingReview
// in every other open window. The file + FileSystemWatcher makes every window
// react the moment any window records a "seen".
export class SeenStore {
  private seen = new Map<string, number>();
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;
  private watcher?: vscode.FileSystemWatcher;
  // Serialized snapshot of our last write, so the watcher can ignore the event
  // caused by our own persist() and only react to other windows' writes.
  private lastWritten = "";

  constructor(
    private readonly storageUri: vscode.Uri,
    private readonly legacyState?: vscode.Memento
  ) {}

  // Load from disk (migrating one-time from the old globalState location) and
  // start watching the file for writes from other windows.
  async load(): Promise<void> {
    let loaded = false;
    try {
      const buf = await vscode.workspace.fs.readFile(this.fileUri());
      const parsed = JSON.parse(Buffer.from(buf).toString("utf8")) as SeenFile;
      if (parsed.version === 1 && parsed.seen) {
        this.seen = new Map(Object.entries(parsed.seen));
        loaded = true;
      }
    } catch {
      // no file yet or corrupt
    }
    // One-time migration: seed from the legacy globalState map so existing
    // "checked" marks aren't lost on upgrade, then persist to the file.
    if (!loaded && this.legacyState) {
      const legacy = this.legacyState.get<Record<string, number>>(KEY, {});
      if (Object.keys(legacy).length > 0) {
        this.seen = new Map(Object.entries(legacy));
        await this.write();
      }
    }
    this.startWatching();
  }

  private startWatching(): void {
    // Pattern-scoped watcher for just our file inside the storage dir.
    this.watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(this.storageUri, FILE_NAME)
    );
    const reload = () => void this.reloadFromDisk();
    this.watcher.onDidChange(reload);
    this.watcher.onDidCreate(reload);
    this.watcher.onDidDelete(reload);
  }

  private async reloadFromDisk(): Promise<void> {
    let text = "";
    try {
      const buf = await vscode.workspace.fs.readFile(this.fileUri());
      text = Buffer.from(buf).toString("utf8");
    } catch {
      // deleted: fall through to empty map
    }
    // Ignore the change event triggered by our own write.
    if (text === this.lastWritten) {
      return;
    }
    try {
      const parsed = JSON.parse(text) as SeenFile;
      this.seen = new Map(Object.entries(parsed.seen ?? {}));
    } catch {
      this.seen = new Map();
    }
    this._onDidChange.fire();
  }

  // A finished session is "unseen" when it has been written (finished) more
  // recently than the last time you opened it. Only finished/pending-review
  // sessions count — active/awaiting are self-evidently your move.
  isUnseen(s: Session): boolean {
    if (s.status !== "finished" && s.status !== "pendingReview") {
      return false;
    }
    return s.mtimeMs > (this.seen.get(s.sessionId) ?? 0);
  }

  // Have you opened this session at or after its current mtime? Drives the
  // finished (reviewed) vs pendingReview overlay in SessionStore. Independent of
  // Session.status so it can be consulted while status is still being computed.
  isReviewed(sessionId: string, mtimeMs: number): boolean {
    return mtimeMs <= (this.seen.get(sessionId) ?? 0);
  }

  // Record that you've checked this session at its current mtime.
  async markSeen(sessionId: string, mtimeMs: number): Promise<void> {
    if (this.seen.get(sessionId) === mtimeMs) {
      return;
    }
    this.seen.set(sessionId, mtimeMs);
    await this.write();
    this._onDidChange.fire();
  }

  // Mark a batch of sessions checked in one write/event. Used by "mark all as
  // read". No-ops (single persist) if nothing actually changed.
  async markAllSeen(items: ReadonlyArray<{ sessionId: string; mtimeMs: number }>): Promise<void> {
    let changed = false;
    for (const { sessionId, mtimeMs } of items) {
      if (this.seen.get(sessionId) !== mtimeMs) {
        this.seen.set(sessionId, mtimeMs);
        changed = true;
      }
    }
    if (!changed) {
      return;
    }
    await this.write();
    this._onDidChange.fire();
  }

  dispose(): void {
    this.watcher?.dispose();
    this._onDidChange.dispose();
  }

  private fileUri(): vscode.Uri {
    return vscode.Uri.joinPath(this.storageUri, FILE_NAME);
  }

  private async write(): Promise<void> {
    const payload: SeenFile = { version: 1, seen: Object.fromEntries(this.seen) };
    const text = JSON.stringify(payload);
    this.lastWritten = text;
    await vscode.workspace.fs.createDirectory(this.storageUri);
    await vscode.workspace.fs.writeFile(this.fileUri(), Buffer.from(text, "utf8"));
  }
}
