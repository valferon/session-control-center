import * as vscode from "vscode";
import * as crypto from "crypto";
import { SessionStore } from "../data/sessionStore";
import { UsageService } from "../data/usageService";
import { ActivityBucket, FromWebview, ToWebview } from "./protocol";

// Hosts the dashboard webview (one singleton panel) and the messaging bridge.
export class DashboardPanel {
  private static current?: DashboardPanel;
  private readonly disposables: vscode.Disposable[] = [];

  static show(
    extensionUri: vscode.Uri,
    store: SessionStore,
    usage: UsageService,
    handlers: PanelHandlers
  ): void {
    const column = vscode.ViewColumn.Active;
    if (DashboardPanel.current) {
      DashboardPanel.current.panel.reveal(column);
      DashboardPanel.current.postSnapshot();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "claudeControlCenterDashboard",
      "Claude Control Center",
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, "dist", "webview")],
      }
    );
    DashboardPanel.current = new DashboardPanel(panel, extensionUri, store, usage, handlers);
  }

  static refreshIfOpen(): void {
    DashboardPanel.current?.postSnapshot();
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
    private readonly store: SessionStore,
    private readonly usage: UsageService,
    private readonly handlers: PanelHandlers
  ) {
    this.panel.webview.html = this.html();

    this.panel.webview.onDidReceiveMessage(
      (msg: FromWebview) => this.onMessage(msg),
      undefined,
      this.disposables
    );
    this.store.onDidChange(() => this.postSnapshot(), undefined, this.disposables);
    this.usage.onDidChange(() => this.postSnapshot(), undefined, this.disposables);
    this.panel.onDidChangeViewState(
      (e) => {
        if (e.webviewPanel.visible) {
          this.postSnapshot();
        }
      },
      undefined,
      this.disposables
    );
    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);
  }

  private onMessage(msg: FromWebview): void {
    switch (msg.kind) {
      case "ready":
        this.postSnapshot();
        break;
      case "requestRefresh":
        void this.store.refresh();
        break;
      case "openSession":
        this.handlers.openSession(msg.sessionId, msg.newWindow);
        break;
      case "startClaude":
        this.handlers.startClaude(msg.sessionId);
        break;
      case "copySessionId":
        void vscode.env.clipboard.writeText(msg.sessionId);
        void vscode.window.showInformationMessage(`Copied session id ${msg.sessionId}`);
        break;
    }
  }

  private postSnapshot(): void {
    const groups = this.store.getGroups();
    const metrics = this.store.getMetrics();
    const activity = computeActivity(groups);
    const message: ToWebview = {
      kind: "snapshot",
      projects: groups,
      metrics,
      activity,
      usage: this.usage.getCurrent(),
      generatedAt: Date.now(),
    };
    void this.panel.webview.postMessage(message);
  }

  private html(): string {
    const webview = this.panel.webview;
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "webview", "main.js")
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "webview", "main.css")
    );
    const nonce = makeNonce();
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} https: data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>Claude Control Center</title>
</head>
<body>
  <div id="app"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  private disposed = false;
  private dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    DashboardPanel.current = undefined;
    for (const d of this.disposables) {
      d.dispose();
    }
    // Note: when this runs from onDidDispose the panel is already gone; calling
    // dispose() again is a no-op but we guard with `disposed` regardless.
    this.panel.dispose();
  }
}

export interface PanelHandlers {
  openSession(sessionId: string, newWindow: boolean): void;
  startClaude(sessionId: string): void;
}

// Build 24h activity histogram from session last-activity times (mtime).
function computeActivity(groups: import("../model/types").ProjectGroup[]): ActivityBucket[] {
  const now = Date.now();
  const bucketMs = 3_600_000; // 1h
  const buckets = 24;
  const start = now - buckets * bucketMs;
  const out: ActivityBucket[] = [];
  for (let i = 0; i < buckets; i++) {
    out.push({ startMs: start + i * bucketMs, count: 0 });
  }
  for (const g of groups) {
    for (const s of g.sessions) {
      if (s.mtimeMs < start) {
        continue;
      }
      const idx = Math.min(buckets - 1, Math.floor((s.mtimeMs - start) / bucketMs));
      out[idx].count++;
    }
  }
  return out;
}

function makeNonce(): string {
  // Cryptographically random nonce for the CSP script-src.
  return crypto.randomBytes(16).toString("base64").replace(/[^A-Za-z0-9]/g, "");
}
