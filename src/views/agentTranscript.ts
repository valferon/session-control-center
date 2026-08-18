import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { renderTranscript } from "./transcriptRender";
import { log } from "../util/log";

// Readable transcript view for a subagent's sidechain log. The raw
// agent-*.jsonl is one JSON blob per line — useless to skim — so the sidebar's
// agent rows open THIS instead: a virtual markdown document rendered from the
// jsonl (prompt, tool calls, results, final answer) shown in the built-in
// markdown preview. The doc re-renders live while the agent keeps writing.
// The raw file stays one context-menu click away.

export const OPEN_TRANSCRIPT_CMD = "claudeControlCenter.openAgentTranscript";
export const OPEN_RAW_LOG_CMD = "claudeControlCenter.openAgentRawLog";

const SCHEME = "claude-agent-transcript";

export function registerAgentTranscript(context: vscode.ExtensionContext): void {
  const provider = new AgentTranscriptProvider();
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, provider),
    { dispose: () => provider.dispose() },
    vscode.commands.registerCommand(OPEN_TRANSCRIPT_CMD, async (filePath: unknown) => {
      if (typeof filePath !== "string" || !filePath) {
        return;
      }
      const uri = transcriptUri(filePath);
      try {
        // Preview only — the markdown source is an intermediate artifact; the
        // reader wants the rendered conversation.
        await vscode.commands.executeCommand("markdown.showPreview", uri);
      } catch (e) {
        log(`openAgentTranscript: preview failed (${e instanceof Error ? e.message : e}); opening as text`);
        await vscode.window.showTextDocument(uri, { preview: true });
      }
    }),
    vscode.commands.registerCommand(OPEN_RAW_LOG_CMD, (arg: unknown) => {
      const p = typeof arg === "string" ? arg : (arg as { agentFilePath?: string })?.agentFilePath;
      if (p) {
        void vscode.commands.executeCommand("vscode.open", vscode.Uri.file(p));
      }
    })
  );
}

// The jsonl path travels in the query (encoded) so the visible path segment is
// free to be a friendly tab label ("agent-ab12….md").
function transcriptUri(fsPath: string): vscode.Uri {
  const base = path.basename(fsPath, ".jsonl");
  return vscode.Uri.from({
    scheme: SCHEME,
    path: `/${base}.md`,
    query: encodeURIComponent(fsPath),
  });
}

class AgentTranscriptProvider implements vscode.TextDocumentContentProvider {
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;
  // One fs watcher per open transcript so the preview refreshes while the
  // agent is still writing. Bounded: previews linger, so evict oldest instead
  // of trusting onDidCloseTextDocument (markdown preview may never close the
  // backing doc promptly).
  private readonly watchers = new Map<string, { watcher: fs.FSWatcher; timer?: NodeJS.Timeout }>();
  private readonly closeSub: vscode.Disposable;

  constructor() {
    this.closeSub = vscode.workspace.onDidCloseTextDocument((doc) => {
      if (doc.uri.scheme === SCHEME) {
        this.unwatch(doc.uri.toString());
      }
    });
  }

  dispose(): void {
    for (const key of [...this.watchers.keys()]) {
      this.unwatch(key);
    }
    this.closeSub.dispose();
    this._onDidChange.dispose();
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const fsPath = decodeURIComponent(uri.query);
    this.ensureWatch(uri, fsPath);
    try {
      return await renderTranscript(fsPath);
    } catch (e) {
      return `# Agent transcript\n\nCouldn't read \`${fsPath}\`:\n\n\`\`\`\n${e instanceof Error ? e.message : String(e)}\n\`\`\`\n`;
    }
  }

  private ensureWatch(uri: vscode.Uri, fsPath: string): void {
    const key = uri.toString();
    if (this.watchers.has(key)) {
      return;
    }
    // Cap concurrent watchers; oldest transcript stops live-updating (a manual
    // reopen re-renders it), which beats leaking fs.watch handles.
    if (this.watchers.size >= 8) {
      const oldest = this.watchers.keys().next().value;
      if (oldest) {
        this.unwatch(oldest);
      }
    }
    let entry: { watcher: fs.FSWatcher; timer?: NodeJS.Timeout };
    try {
      const watcher = fs.watch(fsPath, () => {
        // Debounce: a flush writes several lines in quick succession.
        if (entry.timer) {
          clearTimeout(entry.timer);
        }
        entry.timer = setTimeout(() => {
          entry.timer = undefined;
          this._onDidChange.fire(uri);
        }, 400);
      });
      entry = { watcher };
      watcher.on("error", () => this.unwatch(key));
      this.watchers.set(key, entry);
    } catch {
      // File gone or unwatchable — render once, no live updates.
    }
  }

  private unwatch(key: string): void {
    const e = this.watchers.get(key);
    if (e) {
      if (e.timer) {
        clearTimeout(e.timer);
      }
      e.watcher.close();
      this.watchers.delete(key);
    }
  }
}
