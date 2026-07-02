import * as vscode from "vscode";
import { Session } from "../model/types";

interface CacheEntry {
  mtimeMs: number;
  sizeBytes: number;
  session: Session;
}

interface CacheFile {
  version: 3;
  entries: Record<string, CacheEntry>; // key = filePath
}

const CACHE_NAME = "session-cache.json";
// v2: aggregates gained `awaitingInput`; discard v1 entries so status recomputes.
// v3: cwd is now resolved to the git repo root (subdirs collapse onto the repo);
//     discard v2 entries so cwd/grouping is recomputed.
const CACHE_VERSION = 3 as const;

// Persisted per-session aggregate cache, keyed by file path + (mtime,size).
// Lives in globalStorageUri so it survives reloads and is trivially nukable.
export class SessionCache {
  private entries = new Map<string, CacheEntry>();
  private dirty = false;

  constructor(private readonly storageUri: vscode.Uri) {}

  async load(): Promise<void> {
    try {
      const buf = await vscode.workspace.fs.readFile(this.fileUri());
      const parsed = JSON.parse(Buffer.from(buf).toString("utf8")) as CacheFile;
      if (parsed.version === CACHE_VERSION && parsed.entries) {
        for (const [k, v] of Object.entries(parsed.entries)) {
          this.entries.set(k, v);
        }
      }
    } catch {
      // no cache yet or corrupt: start empty
    }
  }

  get(filePath: string, mtimeMs: number, sizeBytes: number): Session | undefined {
    const e = this.entries.get(filePath);
    if (e && e.mtimeMs === mtimeMs && e.sizeBytes === sizeBytes) {
      return e.session;
    }
    return undefined;
  }

  set(session: Session): void {
    this.entries.set(session.filePath, {
      mtimeMs: session.mtimeMs,
      sizeBytes: session.sizeBytes,
      session,
    });
    this.dirty = true;
  }

  prune(livePaths: Set<string>): void {
    for (const k of [...this.entries.keys()]) {
      if (!livePaths.has(k)) {
        this.entries.delete(k);
        this.dirty = true;
      }
    }
  }

  async flush(): Promise<void> {
    if (!this.dirty) {
      return;
    }
    // Clear BEFORE the async write so a set() during the write re-marks dirty
    // and isn't lost when we'd otherwise clear the flag afterwards.
    this.dirty = false;
    const data: CacheFile = {
      version: CACHE_VERSION,
      entries: Object.fromEntries(this.entries),
    };
    try {
      await vscode.workspace.fs.createDirectory(this.storageUri);
      await vscode.workspace.fs.writeFile(
        this.fileUri(),
        Buffer.from(JSON.stringify(data), "utf8")
      );
    } catch {
      this.dirty = true; // retry on next flush
    }
  }

  private fileUri(): vscode.Uri {
    return vscode.Uri.joinPath(this.storageUri, CACHE_NAME);
  }
}
