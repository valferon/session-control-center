import * as vscode from "vscode";

const FILE = "titles.json";

interface TitleFile {
  version: 1;
  titles: Record<string, string>; // sessionId -> user-chosen title
}

// User-chosen session titles (manual rename). Claude Code's own title
// generation isn't tunable and /rename only works from inside a live session,
// so renames live here as a display overlay — sessionId -> title — and never
// touch Claude's jsonl files (their format is internal/unsupported to edit).
//
// File-backed in globalStorage rather than globalState: Memento values are NOT
// reliably propagated across open windows (the exact staleness SeenStore's
// sharding exists to dodge), while a file re-read from disk always is. Renames
// are rare, human-paced actions, so a single file with read-fresh-merge-write
// is enough — no shard machinery needed. A watcher plus the same focus/tick
// sync() hooks as SeenStore converge other windows within seconds.
export class TitleStore {
  private titles = new Map<string, string>();
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;
  private watcher?: vscode.FileSystemWatcher;

  constructor(private readonly storageUri: vscode.Uri) {}

  async load(): Promise<void> {
    try {
      await vscode.workspace.fs.createDirectory(this.storageUri);
    } catch {
      // read-only storage: renames degrade to this window's memory only
    }
    this.titles = (await this.readDisk()) ?? new Map();
    this.watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(this.storageUri, FILE)
    );
    const reload = () => void this.sync();
    this.watcher.onDidChange(reload);
    this.watcher.onDidCreate(reload);
    this.watcher.onDidDelete(reload);
  }

  get(sessionId: string): string | undefined {
    return this.titles.get(sessionId);
  }

  // Set (or clear, with undefined/empty) the custom title for a session.
  // Reads the file fresh first so a rename made in another window moments ago
  // isn't clobbered by this window's stale in-memory copy.
  async rename(sessionId: string, title: string | undefined): Promise<void> {
    const next = (await this.readDisk()) ?? new Map(this.titles);
    const trimmed = title?.trim();
    if (trimmed) {
      next.set(sessionId, trimmed);
    } else {
      next.delete(sessionId);
    }
    this.titles = next;
    await this.writeDisk();
    this._onDidChange.fire();
  }

  // Re-read from disk (watcher event, window focus, periodic tick). Replaces
  // the map wholesale so cross-window CLEARS propagate too — but only from a
  // successfully parsed file; a torn/unreadable read must not wipe titles.
  async sync(): Promise<void> {
    const disk = await this.readDisk();
    if (!disk || mapsEqual(disk, this.titles)) {
      return;
    }
    this.titles = disk;
    this._onDidChange.fire();
  }

  dispose(): void {
    this.watcher?.dispose();
    this._onDidChange.dispose();
  }

  private uri(): vscode.Uri {
    return vscode.Uri.joinPath(this.storageUri, FILE);
  }

  // undefined = missing or unreadable (caller decides; sync() keeps current).
  private async readDisk(): Promise<Map<string, string> | undefined> {
    try {
      const buf = await vscode.workspace.fs.readFile(this.uri());
      const parsed = JSON.parse(Buffer.from(buf).toString("utf8")) as TitleFile;
      const out = new Map<string, string>();
      for (const [id, t] of Object.entries(parsed.titles ?? {})) {
        if (typeof t === "string" && t) {
          out.set(id, t);
        }
      }
      return out;
    } catch {
      return undefined;
    }
  }

  private async writeDisk(): Promise<void> {
    const payload: TitleFile = { version: 1, titles: Object.fromEntries(this.titles) };
    await vscode.workspace.fs.createDirectory(this.storageUri);
    await vscode.workspace.fs.writeFile(this.uri(), Buffer.from(JSON.stringify(payload), "utf8"));
  }
}

function mapsEqual(a: Map<string, string>, b: Map<string, string>): boolean {
  if (a.size !== b.size) {
    return false;
  }
  for (const [k, v] of a) {
    if (b.get(k) !== v) {
      return false;
    }
  }
  return true;
}
