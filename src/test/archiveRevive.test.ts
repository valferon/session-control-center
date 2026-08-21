import test from "node:test";
import * as assert from "node:assert";
import { pickRevived, snapshotStatuses, StatusSnapshot } from "../data/archiveRevive";

const s = (sessionId: string, status: StatusSnapshot["status"]): StatusSnapshot => ({
  sessionId,
  status,
});

const archivedSet = (...ids: string[]) => {
  const set = new Set(ids);
  return (id: string) => set.has(id);
};

test("archived session that starts working again is revived", () => {
  const prev = snapshotStatuses([s("a", "finished")]);
  assert.deepEqual(pickRevived(prev, [s("a", "active")], archivedSet("a")), ["a"]);
});

test("awaiting counts as live too", () => {
  const prev = snapshotStatuses([s("a", "idle")]);
  assert.deepEqual(pickRevived(prev, [s("a", "awaiting")], archivedSet("a")), ["a"]);
});

test("archiving a session that is ALREADY active sticks", () => {
  // No edge: prev is live, current is live. A level test would unarchive here
  // on the very next scan and make the archive command look broken.
  const prev = snapshotStatuses([s("a", "active")]);
  assert.deepEqual(pickRevived(prev, [s("a", "active")], archivedSet("a")), []);
});

test("un-archived sessions are never touched", () => {
  const prev = snapshotStatuses([s("a", "finished")]);
  assert.deepEqual(pickRevived(prev, [s("a", "active")], archivedSet()), []);
});

test("resting -> resting is not an edge", () => {
  const prev = snapshotStatuses([s("a", "finished")]);
  assert.deepEqual(pickRevived(prev, [s("a", "interrupted")], archivedSet("a")), []);
});

test("unknown session (no previous status) is not revived", () => {
  // Guards the seeding path: a first sighting must not unarchive a backlog.
  assert.deepEqual(pickRevived(new Map(), [s("a", "active")], archivedSet("a")), []);
});

test("snapshot drops sessions that disappeared", () => {
  const first = snapshotStatuses([s("a", "active"), s("b", "idle")]);
  assert.equal(first.size, 2);
  const second = snapshotStatuses([s("a", "finished")]);
  assert.equal(second.size, 1);
  assert.equal(second.get("a"), "finished");
});
