import * as vscode from "vscode";

let channel: vscode.OutputChannel | undefined;

export function initLog(): vscode.OutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel("Claude Control Center");
  }
  return channel;
}

export function log(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}`;
  (channel ?? initLog()).appendLine(line);
}

// Verbose, high-volume diagnostics (e.g. per-session status decisions on every
// refresh). Off by default so the channel stays readable; flip on via the
// `claudeControlCenter.debugLogging` setting when investigating a misclassified
// session, reproduce, then read the channel via "Show Logs".
export function debugEnabled(): boolean {
  return vscode.workspace
    .getConfiguration("claudeControlCenter")
    .get<boolean>("debugLogging", false);
}

export function debug(msg: string): void {
  if (debugEnabled()) {
    log(msg);
  }
}
