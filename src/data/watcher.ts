import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

type FileEvent = (filePath: string) => void;
type RescanEvent = () => void;

// Watches ~/.claude/projects with node fs.watch. On Linux fs.watch is not
// recursive, so we watch the root (for new/removed project dirs) plus one
// watcher per project dir (for .jsonl changes). Events are debounced.
export class ProjectsWatcher {
  private rootWatcher?: fs.FSWatcher;
  private dirWatchers = new Map<string, fs.FSWatcher>();
  private fileTimers = new Map<string, { timer: NodeJS.Timeout; firstAt: number }>();
  private rootTimer?: NodeJS.Timeout;

  private readonly fileDebounceMs = 500;
  // Trailing debounce alone starves under a sustained write stream (an active
  // session appends every few hundred ms, resetting the timer forever, so the
  // UI freezes until the writes pause). Cap the total wait: once a file's
  // events have been coalescing this long, fire even though writes continue.
  private readonly fileMaxWaitMs = 2_000;
  private readonly rootDebounceMs = 800;
  private warnedLimit = false;

  // Surface inotify-limit exhaustion once, instead of silently giving up on
  // live updates (the view would appear frozen with no explanation).
  private handleWatchError(e: unknown): void {
    const code = (e as NodeJS.ErrnoException)?.code;
    if ((code === "ENOSPC" || code === "EMFILE") && !this.warnedLimit) {
      this.warnedLimit = true;
      void vscode.window.showWarningMessage(
        "Claude Control Center: hit the system file-watch limit; live updates are degraded. " +
          "Increase fs.inotify.max_user_watches, or use the Refresh button. " +
          "(sudo sysctl fs.inotify.max_user_watches=524288)"
      );
    }
  }

  constructor(
    private readonly root: string,
    private readonly onFileChanged: FileEvent,
    private readonly onStructureChanged: RescanEvent
  ) {}

  start(): void {
    this.watchRoot();
    this.attachDirWatchers();
  }

  dispose(): void {
    this.rootWatcher?.close();
    for (const w of this.dirWatchers.values()) {
      w.close();
    }
    this.dirWatchers.clear();
    for (const t of this.fileTimers.values()) {
      clearTimeout(t.timer);
    }
    this.fileTimers.clear();
    if (this.rootTimer) {
      clearTimeout(this.rootTimer);
    }
  }

  private watchRoot(): void {
    try {
      this.rootWatcher = fs.watch(this.root, () => {
        // A project dir may have been added/removed: re-attach and rescan.
        if (this.rootTimer) {
          clearTimeout(this.rootTimer);
        }
        this.rootTimer = setTimeout(() => {
          this.attachDirWatchers();
          this.onStructureChanged();
        }, this.rootDebounceMs);
      });
    } catch (e) {
      this.handleWatchError(e); // root not watchable; rely on manual refresh
    }
  }

  private attachDirWatchers(): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.root, { withFileTypes: true });
    } catch {
      return;
    }
    const live = new Set<string>();
    for (const e of entries) {
      if (!e.isDirectory()) {
        continue;
      }
      const dirPath = path.join(this.root, e.name);
      live.add(dirPath);
      if (this.dirWatchers.has(dirPath)) {
        continue;
      }
      try {
        const w = fs.watch(dirPath, (_event, filename) => {
          if (!filename || !String(filename).endsWith(".jsonl")) {
            return;
          }
          const filePath = path.join(dirPath, String(filename));
          this.debounceFile(filePath);
        });
        this.dirWatchers.set(dirPath, w);
      } catch (e) {
        this.handleWatchError(e); // skip unwatchable dir
      }
    }
    // Drop watchers for removed dirs.
    for (const [p, w] of [...this.dirWatchers.entries()]) {
      if (!live.has(p)) {
        w.close();
        this.dirWatchers.delete(p);
      }
    }
  }

  private debounceFile(filePath: string): void {
    const now = Date.now();
    const existing = this.fileTimers.get(filePath);
    if (existing) {
      clearTimeout(existing.timer);
      // Coalescing too long already — fire now instead of resetting again.
      if (now - existing.firstAt >= this.fileMaxWaitMs) {
        this.fileTimers.delete(filePath);
        this.onFileChanged(filePath);
        return;
      }
    }
    this.fileTimers.set(filePath, {
      firstAt: existing?.firstAt ?? now,
      timer: setTimeout(() => {
        this.fileTimers.delete(filePath);
        this.onFileChanged(filePath);
      }, this.fileDebounceMs),
    });
  }
}
