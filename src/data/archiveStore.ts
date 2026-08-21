import * as vscode from "vscode";
import { Session, SessionStatus } from "../model/types";
import { pickRevived, snapshotStatuses } from "./archiveRevive";

const FILE = "archived.json";
// globalState key the archive USED to live in. Read once at load() and folded
// into the file, then left in place: an older build sharing the same install
// still reads it, and a stale extra id is harmless next to the file's set.
const LEGACY_KEY = "claudeControlCenter.archivedSessions";

interface ArchiveFile {
  version: 1;
  ids: string[];
}

// Persistent set of archived (hidden) session ids. Sessions are rebuilt from the
// jsonl files on every scan, so the archive flag has to live outside the Session
// objects.
//
// File-backed in globalStorage rather than globalState, for the same reason as
// SeenStore and TitleStore: Memento values are NOT reliably propagated to other
// ALREADY-OPEN windows, so archiving (or auto-unarchiving) in one window left
// every other window's sidebar showing the opposite until a reload. A file
// re-read from disk always converges. Archives are rare, human-paced actions,
// so read-fresh-merge-write on a single file is enough — no shard machinery.
export class ArchiveStore {
  private ids: ReadonlySet<string> = new Set();
  // Last seen status per session, for the came-back-to-life edge detection in
  // syncLiveSessions. Seeded (without unarchiving) on the first call.
  private prevStatus = new Map<string, SessionStatus>();
  private seeded = false;
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;
  private watcher?: vscode.FileSystemWatcher;

  constructor(
    private readonly storageUri: vscode.Uri,
    private readonly legacyState?: vscode.Memento
  ) {}

  async load(): Promise<void> {
    try {
      await vscode.workspace.fs.createDirectory(this.storageUri);
    } catch {
      // read-only storage: archiving degrades to this window's memory only
    }
    const disk = await this.readDisk();
    const legacy = this.legacyState?.get<string[]>(LEGACY_KEY, []) ?? [];
    if (!disk) {
      // First run on the file-backed store: adopt whatever globalState holds so
      // an existing archive isn't silently emptied by the upgrade.
      this.ids = new Set(legacy);
      if (this.ids.size > 0) {
        await this.writeDisk();
      }
    } else {
      // The file is authoritative once it exists — a later unarchive must not
      // be resurrected by the frozen legacy list. Union only on the very first
      // migration, above.
      this.ids = disk;
    }
    this.watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(this.storageUri, FILE)
    );
    const reload = () => void this.sync();
    this.watcher.onDidChange(reload);
    this.watcher.onDidCreate(reload);
    this.watcher.onDidDelete(reload);
  }

  isArchived(sessionId: string): boolean {
    return this.ids.has(sessionId);
  }

  hasAny(): boolean {
    return this.ids.size > 0;
  }

  async archive(sessionId: string): Promise<void> {
    await this.mutate((next) => next.add(sessionId));
  }

  async unarchive(sessionId: string): Promise<void> {
    await this.mutate((next) => next.delete(sessionId));
  }

  // Re-read from disk (watcher event, window focus, periodic tick). Replaces
  // the set wholesale so cross-window UNARCHIVES propagate too — but only from
  // a successfully parsed file; a torn/unreadable read keeps the current set.
  async sync(): Promise<void> {
    const disk = await this.readDisk();
    if (!disk || setsEqual(disk, this.ids)) {
      return;
    }
    this.ids = disk;
    this._onDidChange.fire();
  }

  // Un-hide archived sessions that came back to life (resumed from the
  // dashboard, from a terminal `claude --resume`, or by any other route).
  // Archiving is "I'm done with this"; a session that starts working again
  // isn't done, and leaving it hidden means the sidebar shows the active dot
  // on some OTHER session while the one you're in is invisible.
  // The edge rule itself lives in archiveRevive.pickRevived.
  async syncLiveSessions(sessions: readonly Session[]): Promise<void> {
    // Seed only once there is actually data, so a transient empty/partial scan
    // doesn't leave sessions un-seeded and then unarchive a backlog of them.
    if (!this.seeded) {
      if (sessions.length === 0) {
        return;
      }
      this.prevStatus = snapshotStatuses(sessions);
      this.seeded = true;
      return;
    }
    const revive = pickRevived(this.prevStatus, sessions, (id) => this.ids.has(id));
    this.prevStatus = snapshotStatuses(sessions);
    if (revive.length === 0) {
      return;
    }
    await this.mutate((next) => {
      for (const id of revive) {
        next.delete(id);
      }
    });
  }

  dispose(): void {
    this.watcher?.dispose();
    this._onDidChange.dispose();
  }

  // Read the file fresh before applying the change, so an archive made in
  // another window moments ago isn't clobbered by this window's stale copy.
  private async mutate(apply: (next: Set<string>) => void): Promise<void> {
    const next = new Set((await this.readDisk()) ?? this.ids);
    apply(next);
    if (setsEqual(next, this.ids)) {
      return;
    }
    this.ids = next;
    await this.writeDisk();
    this._onDidChange.fire();
  }

  private uri(): vscode.Uri {
    return vscode.Uri.joinPath(this.storageUri, FILE);
  }

  // undefined = missing or unreadable (caller decides; sync() keeps current).
  private async readDisk(): Promise<Set<string> | undefined> {
    try {
      const buf = await vscode.workspace.fs.readFile(this.uri());
      const parsed = JSON.parse(Buffer.from(buf).toString("utf8")) as ArchiveFile;
      const out = new Set<string>();
      for (const id of parsed.ids ?? []) {
        if (typeof id === "string" && id) {
          out.add(id);
        }
      }
      return out;
    } catch {
      return undefined;
    }
  }

  private async writeDisk(): Promise<void> {
    const payload: ArchiveFile = { version: 1, ids: [...this.ids] };
    await vscode.workspace.fs.createDirectory(this.storageUri);
    await vscode.workspace.fs.writeFile(this.uri(), Buffer.from(JSON.stringify(payload), "utf8"));
  }
}

function setsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) {
    return false;
  }
  for (const v of a) {
    if (!b.has(v)) {
      return false;
    }
  }
  return true;
}
