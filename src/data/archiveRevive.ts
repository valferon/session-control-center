import { SessionStatus } from "../model/types";

// Statuses that mean the conversation is live again (working, or blocked on
// you). Anything else is a resting state and leaves the archive flag alone.
const LIVE_STATUSES: ReadonlySet<SessionStatus> = new Set<SessionStatus>(["active", "awaiting"]);

export interface StatusSnapshot {
  sessionId: string;
  status: SessionStatus;
}

// Archived sessions that just came back to life: their status crossed from a
// resting state into a live one since the previous snapshot.
//
// Edge-triggered on purpose (resting -> live), never level-triggered:
// archiving a session that is active RIGHT NOW must stick, and a level test
// would immediately undo it. Its status is already live when you archive, so
// no edge fires until it goes quiet and starts up again.
//
// Lives outside ArchiveStore (which needs `vscode` for its Memento and event
// emitter) so the rule itself is testable in plain node.
export function pickRevived(
  prevStatus: ReadonlyMap<string, SessionStatus>,
  sessions: readonly StatusSnapshot[],
  isArchived: (sessionId: string) => boolean
): string[] {
  const out: string[] = [];
  for (const s of sessions) {
    const prev = prevStatus.get(s.sessionId);
    if (prev === undefined || LIVE_STATUSES.has(prev) || !LIVE_STATUSES.has(s.status)) {
      continue;
    }
    if (isArchived(s.sessionId)) {
      out.push(s.sessionId);
    }
  }
  return out;
}

// Current statuses keyed by session id. Rebuilt wholesale so entries for
// sessions that are gone can't accumulate across a long-running window.
export function snapshotStatuses(sessions: readonly StatusSnapshot[]): Map<string, SessionStatus> {
  const next = new Map<string, SessionStatus>();
  for (const s of sessions) {
    next.set(s.sessionId, s.status);
  }
  return next;
}
