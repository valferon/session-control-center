import * as crypto from "crypto";

// Unique, filesystem-safe id for THIS extension host (= this window).
//
// Deliberately NOT vscode.env.sessionId: VSCodium (and other telemetry-off
// builds) replace it with the literal placeholder "someValue.sessionId" in
// EVERY window. Anything keyed on it silently loses its uniqueness there —
// observed in the wild as every window writing the SAME seen-marks shard
// (each overwrote the file with only its own marks, so other windows' marks
// kept vanishing and reviewed sessions flipped back to pending review), and
// as cross-repo "open in new window" never firing (the requesting-window
// check matched in every window).
//
// pid + random suffix: unique per extension host, stable for its lifetime,
// nothing else required.
export const WINDOW_ID = `${process.pid.toString(36)}-${crypto.randomBytes(6).toString("hex")}`;
