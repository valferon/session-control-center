import * as vscode from "vscode";

const KEY = "claudeControlCenter.archivedSessions";

// Persistent set of archived (hidden) session ids. Sessions are rebuilt from the
// jsonl files on every scan, so the archive flag has to live outside the Session
// objects. globalState survives reloads and is shared per extension install.
export class ArchiveStore {
  private ids: ReadonlySet<string>;
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor(private readonly state: vscode.Memento) {
    this.ids = new Set(state.get<string[]>(KEY, []));
  }

  isArchived(sessionId: string): boolean {
    return this.ids.has(sessionId);
  }

  hasAny(): boolean {
    return this.ids.size > 0;
  }

  async archive(sessionId: string): Promise<void> {
    if (this.ids.has(sessionId)) {
      return;
    }
    const next = new Set(this.ids);
    next.add(sessionId);
    await this.persist(next);
  }

  async unarchive(sessionId: string): Promise<void> {
    if (!this.ids.has(sessionId)) {
      return;
    }
    const next = new Set(this.ids);
    next.delete(sessionId);
    await this.persist(next);
  }

  dispose(): void {
    this._onDidChange.dispose();
  }

  private async persist(next: ReadonlySet<string>): Promise<void> {
    this.ids = next;
    await this.state.update(KEY, [...next]);
    this._onDidChange.fire();
  }
}
