import * as vscode from "vscode";

// Custom URI scheme used purely to tag a session tree row so a
// FileDecorationProvider can color it. Not a real file — never opened.
const SCHEME = "claude-session";

// Stable resourceUri for a session row. Equality of this URI is how the
// decoration provider knows which row to tint.
export function sessionUri(sessionId: string): vscode.Uri {
  return vscode.Uri.from({ scheme: SCHEME, path: "/" + sessionId });
}

// Tints ONE row — the session belonging to this window's repo — without
// touching the tree's selection. Selection is user-driven (clicking around) and
// per-window, so reusing it to mark "the current repo's session" fought the
// user and synced unreliably across windows. A decoration is computed locally,
// is deterministic, and never moves when you click another row.
export class CurrentSessionDecorations implements vscode.FileDecorationProvider {
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this._onDidChange.event;
  private currentId?: string;

  // Update which session is "this window's" and repaint the affected rows.
  setCurrent(sessionId: string | undefined): void {
    if (sessionId === this.currentId) {
      return;
    }
    const changed: vscode.Uri[] = [];
    if (this.currentId) {
      changed.push(sessionUri(this.currentId));
    }
    if (sessionId) {
      changed.push(sessionUri(sessionId));
    }
    this.currentId = sessionId;
    this._onDidChange.fire(changed.length ? changed : undefined);
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== SCHEME || !this.currentId) {
      return undefined;
    }
    if (uri.path !== "/" + this.currentId) {
      return undefined;
    }
    return {
      badge: "❯",
      color: new vscode.ThemeColor("textLink.foreground"),
      tooltip: "Session for this window's repo",
    };
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}
