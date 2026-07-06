import * as vscode from "vscode";

// Custom URI scheme used purely to tag a project tree row so a
// FileDecorationProvider can color it. Not a real file — never opened.
const SCHEME = "claude-project";

// Stable resourceUri for a project row. Equality of this URI is how the
// decoration provider knows which row to tint. The group key is a filesystem
// path (or an "enc:" fallback), so carry it in the query to avoid any path
// normalization the Uri machinery might apply.
export function projectUri(groupKey: string): vscode.Uri {
  return vscode.Uri.from({ scheme: SCHEME, path: "/", query: groupKey });
}

// Tints the project row(s) whose repo is open in THIS window.
//
// This replaced a per-SESSION highlight that guessed "the session open in this
// window" by ranking the repo's sessions (live > done > idle, then recency).
// That guess was inherently unreliable — nothing in the jsonl says which
// session tab a given window actually has open, so with several recent
// sessions in one repo the highlight jumped between rows as statuses flipped.
// Which REPO this window has open is a fact, not a guess: workspace folders.
// Deterministic, stable, and correct in every window.
export class WindowRepoDecorations implements vscode.FileDecorationProvider {
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this._onDidChange.event;
  private currentKeys = new Set<string>();

  // Update which project groups are "this window's" (a multi-root window can
  // legitimately match several) and repaint the affected rows.
  setCurrent(groupKeys: ReadonlySet<string>): void {
    if (setsEqual(this.currentKeys, groupKeys)) {
      return;
    }
    const changed = [...this.currentKeys, ...groupKeys].map(projectUri);
    this.currentKeys = new Set(groupKeys);
    this._onDidChange.fire(changed.length ? changed : undefined);
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== SCHEME || !this.currentKeys.has(uri.query)) {
      return undefined;
    }
    return {
      badge: "❯",
      color: new vscode.ThemeColor("textLink.foreground"),
      tooltip: "This window's repo",
    };
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}

function setsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) {
    return false;
  }
  for (const k of a) {
    if (!b.has(k)) {
      return false;
    }
  }
  return true;
}
