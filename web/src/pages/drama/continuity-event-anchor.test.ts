import assert from "node:assert/strict";
import test from "node:test";
import { continuityEventAnchor, continuityEventFrame } from "./continuity-event-anchor";

const shots = [{ id: "S1", timeline_id: "main", start_frame: 4224, end_frame: 4320, duration_frames: 96 }, { id: "S2", timeline_id: "main", start_frame: 4320, end_frame: 4536, duration_frames: 216 }];
const ledger = { initial: [{ timeline_id: "main", fact_id: "egg", value: "nest" }], events: [{ id: "E1", timeline_id: "main", fact_id: "egg", shot_id: "S2", local_frame: 150, before: "nest", after: "swallowed" }] };
test("an earlier event in a Shot reads the initial state instead of the future event", () => {
    assert.deepEqual(continuityEventAnchor(ledger, shots, "S2", "egg", 30, true), { before: "nest", globalFrame: 4350, anchor: { local_frame: 30 } });
    assert.equal(continuityEventAnchor(ledger, shots, "S2", "egg", 180, true).before, "swallowed");
});
test("local anchors move with Shot duration changes without rewriting the event", () => {
    const retimed = [{ ...shots[0], end_frame: 4272, duration_frames: 48 }, { ...shots[1], start_frame: 4272, end_frame: 4488 }];
    assert.equal(continuityEventFrame(ledger.events[0], shots), 4470);
    assert.equal(continuityEventFrame(ledger.events[0], retimed), 4422);
    assert.equal(ledger.events[0].local_frame, 150);
});
test("invalid and occupied anchors are rejected and legacy frames remain global", () => {
    assert.throws(() => continuityEventAnchor(ledger, shots, "S2", "egg", 216, true), /INVALID_EVENT_FRAME/);
    assert.throws(() => continuityEventAnchor(ledger, shots, "S2", "egg", 150, true), /EVENT_ANCHOR_OCCUPIED/);
    assert.deepEqual(continuityEventAnchor(ledger, shots, "S2", "egg", 4350, false).anchor, { frame: 4350 });
    assert.throws(() => continuityEventAnchor({}, shots, "S2", "egg", 30, true), /EVENT_INITIAL_STATE_MISSING/);
});
