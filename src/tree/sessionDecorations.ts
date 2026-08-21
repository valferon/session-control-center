import * as vscode from "vscode";

// Custom URI schemes used purely to tag a tree row so a
// FileDecorationProvider can color it. Not real files — never opened.
const SCHEME = "claude-project";
const SESSION_SCHEME = "claude-session";

// Stable resourceUri for a project row. Equality of this URI is how the
// decoration provider knows which row to tint. The group key is a filesystem
// path (or an "enc:" fallback), so carry it in the query to avoid any path
// normalization the Uri machinery might apply.
export function projectUri(groupKey: string): vscode.Uri {
  return vscode.Uri.from({ scheme: SCHEME, path: "/", query: groupKey });
}

// Stable resourceUri for a session row, same trick as projectUri.
export function sessionUri(sessionId: string): vscode.Uri {
  return vscode.Uri.from({ scheme: SESSION_SCHEME, path: "/", query: sessionId });
}

// How many heat steps the recency ramp has. Level 0 is the hottest (just
// worked in); the last level is "cold" and is left unmarked, so the bulk of
// the tree stays quiet and only the recent handful carry a square.
export const HEAT_LEVELS = 4;

// Square per step, shrinking with age. Deliberately a SIZE ramp and not a
// colour one: a FileDecoration colour is applied to the whole row label, so
// tinting turned every recent row's title green and the steps were
// indistinguishable. The badge slot is right-aligned and has no alignment to
// protect, which is exactly what lets the glyph vary. Index = heat level; the
// final (cold) step has no entry and so gets no badge.
const HEAT_BADGES = ["■", "▪", "▫"];

// Hover text per step, so the ramp is self-explaining.
const HEAT_TOOLTIPS = ["Worked in just now", "Worked in recently", "Worked in earlier today"];

// Marks session rows by how recently you actually worked in them, so "where
// was I" is answered by a glance down the badge column instead of by reading
// every timestamp. Uses the badge slot rather than the icon, which already
// carries status, and leaves the label untouched.
export class SessionHeatDecorations implements vscode.FileDecorationProvider {
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this._onDidChange.event;
  private levels = new Map<string, number>();

  // Replace the whole ranking and repaint. Called on every tree refresh; a
  // no-op when nothing moved, so a 30s tick on a quiet machine paints nothing.
  setLevels(next: ReadonlyMap<string, number>): void {
    if (mapsEqual(this.levels, next)) {
      return;
    }
    const changed = new Set([...this.levels.keys(), ...next.keys()]);
    this.levels = new Map(next);
    this._onDidChange.fire([...changed].map(sessionUri));
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== SESSION_SCHEME) {
      return undefined;
    }
    const level = this.levels.get(uri.query);
    const badge = level === undefined ? undefined : HEAT_BADGES[level];
    // No `color`: it would repaint the row label, not just the badge.
    return badge ? { badge, tooltip: HEAT_TOOLTIPS[level!] } : undefined;
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
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

function mapsEqual(a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>): boolean {
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
