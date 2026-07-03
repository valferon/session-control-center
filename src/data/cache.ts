import * as vscode from "vscode";
import { Session } from "../model/types";

interface CacheEntry {
  mtimeMs: number;
  sizeBytes: number;
  session: Session;
}

interface CacheFile {
  version: 5;
  entries: Record<string, CacheEntry>; // key = filePath
}

const CACHE_NAME = "session-cache.json";
// v2: aggregates gained `awaitingInput`; discard v1 entries so status recomputes.
// v3: cwd is now resolved to the git repo root (subdirs collapse onto the repo);
//     discard v2 entries so cwd/grouping is recomputed.
// v4: aggregates gained `queueDepth` (and lastTs counts system/queue records);
//     discard v3 entries so status inputs are re-derived.
// v5: aggregates gained `toolCharsByName` (per-tool payload sizes for the
//     tool/MCP usage panel); discard v4 entries so they get populated.
const CACHE_VERSION = 5 as const;

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
      // Write-temp-then-rename so the cache file is swapped atomically. The
      // cache is shared by every VS Code window; two windows flushing at once
      // must never leave a torn/interleaved file behind (a torn file is
      // recoverable — load() starts empty — but forces a full re-parse). The
      // temp name embeds this window's id so concurrent flushes can't collide
      // on the temp file either.
      const tmp = vscode.Uri.joinPath(this.storageUri, `${CACHE_NAME}.tmp-${windowId()}`);
      await vscode.workspace.fs.writeFile(tmp, Buffer.from(JSON.stringify(data), "utf8"));
      await vscode.workspace.fs.rename(tmp, this.fileUri(), { overwrite: true });
    } catch {
      this.dirty = true; // retry on next flush
    }
  }

  private fileUri(): vscode.Uri {
    return vscode.Uri.joinPath(this.storageUri, CACHE_NAME);
  }
}

// Filesystem-safe id for this window (vscode.env.sessionId is unique per
// window but its format is unspecified — strip anything path-hostile).
function windowId(): string {
  return vscode.env.sessionId.replace(/[^a-zA-Z0-9._-]/g, "");
}
