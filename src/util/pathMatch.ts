import * as vscode from "vscode";

// Shared path-matching helpers (previously copy-pasted in three files, which
// let their semantics drift — sessionActions' equality-only variant was one of
// the cross-window "+" bugs).

// Normalize to a platform fsPath without trailing slashes.
export function normPath(p: string): string {
  return vscode.Uri.file(p).fsPath.replace(/\/+$/, "");
}

// True when two normalized paths are the same dir or one contains the other,
// matching on path-segment boundaries so "/a/foo" never matches "/a/foobar".
export function pathRelated(a: string, b: string): boolean {
  if (a === b) {
    return true;
  }
  const [shorter, longer] = a.length < b.length ? [a, b] : [b, a];
  return longer.startsWith(shorter + "/");
}
