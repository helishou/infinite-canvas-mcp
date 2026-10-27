import assert from "node:assert/strict";
import test from "node:test";
import { continuityReadProjection, continuityEventPositionIssues, continuityBlocksForShot, continuityDefaultEvidenceBlockId, continuitySourceBlocks, continuityEntityKey, continuityLocalFrame, continuityMarkerLanes, continuityPreviewStatus, continuityPriorState, continuityTimelineShots, continuityUsage, continuityWorkbenchSource, orderedContinuityShots, replayContinuityFact, visibleContinuityTrack } from "./continuity-timeline-model";
import { continuityEventAnchor, continuityEventFrame, continuityEventPositionPatch } from "./continuity-event-anchor";
import { appendContinuityChange } from "./continuity-event-draft";

const fixture = () => ({ version: 2, prompt_assembly: { version: 2 }, subject_registry: [{ id: "SUB", entityRef: { kind: "asset", id: "KEY" } }],
    shots: [{ id: "S2", timeline_id: "main", story_order: 2, duration_frames: 72, source_scene_id: "return", scene_id: "room", subject_usages: [{ subjectId: "SUB", presentation: "visible", localStartFrame: 12, localEndFrame: 60 }] },
        { id: "S1", timeline_id: "main", story_order: 1, duration_frames: 72, source_scene_id: "first", scene_id: "room", subject_usages: [{ subjectId: "SUB", presentation: "visible" }] },
        { id: "S3", timeline_id: "main", story_order: 3, duration_frames: 96, source_scene_id: "return", scene_id: "room", subject_usages: [{ subjectId: "SUB", presentation: "visible" }] },
        { id: "R1", timeline_id: "memory", story_order: 1, duration_frames: 48, subject_usages: [{ subjectId: "SUB", presentation: "visible" }] }],
    ledger: { contract_version: 2, facts: [{ id: "F", object_kind: "asset", object_id: "KEY", allowed_values: ["a", "b", "c"], value_descriptions: { a: "阿澄持有", b: "小林持有", c: "袋中" } }], timelines: [{ id: "main", start_frame: 100 }, { id: "memory" }], initial: [{ timeline_id: "main", fact_id: "F", value: "a" }, { timeline_id: "memory", fact_id: "F", value: "c" }], events: [{ id: "E", timeline_id: "main", shot_id: "S2", fact_id: "F", local_frame: 36, before: "a", after: "b" }], requirements: [], coverage: [] } });
function setup() { const source = fixture(), ledger = source.ledger, shots = continuityTimelineShots(source, ledger); return { source, ledger, shots }; }

test("v2 windows derive per timeline without mutating source; story order and occurrences remain distinct", () => {
    const { source, ledger, shots } = setup(), original = structuredClone(source);
    assert.equal(shots.find(row => row.id === "S1")?.start_frame, 100);
    assert.equal(shots.find(row => row.id === "S2")?.start_frame, 172);
    assert.equal(shots.find(row => row.id === "R1")?.start_frame, 0);
    assert.deepEqual(orderedContinuityShots(shots, "main").map(row => row.id), ["S1", "S2", "S3"]);
    assert.notEqual(shots[0].source_scene_id, shots[1].source_scene_id);
    assert.deepEqual(source, original); assert.equal(source.ledger, ledger);
});
test("event f36 splits the actual Shot at 50%, not its end", () => {
    const { ledger, shots } = setup(), track = replayContinuityFact(ledger, shots, "main", "F")[1];
    assert.deepEqual(track.segments, [{ start: 0, end: 36, value: "a" }, { start: 36, end: 72, value: "b" }]);
    assert.equal(track.markers[0].position, .5);
});
test("before mismatch preserves the known prefix; explicit unknown/unknown can restore known state", () => {
    const { ledger, shots } = setup(); ledger.events[0].before = "c";
    ledger.events.push({ id: "E2", timeline_id: "main", shot_id: "S2", fact_id: "F", local_frame: 60, before: "unknown", after: "c" });
    const tracks = replayContinuityFact(ledger, shots, "main", "F");
    assert.deepEqual(tracks[1].segments.map(row => [row.start, row.end, row.value]), [[0, 36, "a"], [36, 60, "unknown"], [60, 72, "c"]]);
    assert.equal(tracks[1].markers[0].conflict, true); assert.equal(tracks[1].markers[1].conflict, false); assert.equal(tracks[2].before, "c");
});
test("unknown initial accepts an explicit recovery, while a normal mismatched event stays unknown", () => {
    const { ledger, shots } = setup(); ledger.initial[0].value = "unknown"; ledger.events[0].before = "unknown";
    assert.equal(replayContinuityFact(ledger, shots, "main", "F")[1].after, "b");
    assert.equal(continuityEventAnchor(ledger, shots, "S1", "F", 0, true).before, "unknown");
});
test("usage intervals clip presentation only; hidden changes still replay", () => {
    const { ledger, shots } = setup(); ledger.events.push({ id: "OUT", timeline_id: "main", shot_id: "S2", fact_id: "F", local_frame: 65, before: "b", after: "c" });
    const tracks = replayContinuityFact(ledger, shots, "main", "F"), view = visibleContinuityTrack(tracks[1], "SUB", tracks[0], true);
    assert.deepEqual(view.segments.map(row => [row.start, row.end, row.value]), [[12, 36, "a"], [36, 60, "b"]]);
    assert.deepEqual(view.markers.map(row => row.event.id), ["E"]); assert.deepEqual(view.hiddenEvents.map(row => row.id), ["OUT"]);
    assert.equal(tracks[2].before, "c"); assert.equal(view.continuous, false);
});
test("no usage means no state or marker, not a ledger deletion", () => {
    const { ledger, shots } = setup(); shots[0].subject_usages = [];
    const tracks = replayContinuityFact(ledger, shots, "main", "F"), view = visibleContinuityTrack(tracks[1], "SUB");
    assert.equal(view.segments.length, 0); assert.equal(view.markers.length, 0); assert.equal(view.hiddenEvents.length, 1);
    assert.equal(tracks[2].before, "b"); assert.equal(ledger.events.length, 1);
});
test("voice/context are lightweight and never implicitly visible", () => {
    const { shots } = setup(); shots[0].subject_usages = [{ subjectId: "SUB", presentation: "offscreen_voice" }, { subjectId: "SUB", presentation: "state_context" }];
    assert.equal(continuityUsage(shots[0], "SUB").windows.length, 0); assert.deepEqual(continuityUsage(shots[0], "SUB").light, ["offscreen_voice", "state_context"]);
});
test("local first/final frames retain correct half-open intervals", () => {
    const { ledger, shots } = setup(); ledger.events[0].local_frame = 0;
    assert.deepEqual(replayContinuityFact(ledger, shots, "main", "F")[1].segments, [{ start: 0, end: 72, value: "b" }]);
    ledger.events[0].local_frame = 71; assert.deepEqual(replayContinuityFact(ledger, shots, "main", "F")[1].segments.map(row => [row.start, row.end]), [[0, 71], [71, 72]]);
});
test("same-frame malformed data preserves both events and diagnostic flags in deterministic id order", () => {
    const { ledger, shots } = setup(); ledger.events.unshift({ id: "Z", timeline_id: "main", shot_id: "S2", fact_id: "F", local_frame: 36, before: "b", after: "c" });
    const track = replayContinuityFact(ledger, shots, "main", "F")[1]; assert.deepEqual(track.markers.map(row => row.event.id), ["E", "Z"]); assert.equal(track.markers[1].duplicate, true);
});
test("invalid edited frames stay discoverable without a made-up timeline position", () => {
    const { ledger, shots } = setup(); (ledger.events[0] as Record<string, any>).local_frame = "";
    const track = replayContinuityFact(ledger, shots, "main", "F")[1]; assert.equal(track.markers.length, 0); assert.equal(track.invalidEvents[0].id, "E"); assert.ok(track.segments.every(segment => segment.value === "unknown")); assert.equal(track.after, "unknown");
});
test("legacy absolute frames remain usable and local anchors follow derived shot windows", () => {
    const { shots } = setup(); assert.equal(continuityLocalFrame({ frame: 208 }, shots.find(row => row.id === "S2")!), 36);
    assert.equal(continuityLocalFrame({ frame: 9999, local_frame: 36 }, shots[0]), 36);
});
test("filter/presence gaps break display connections without breaking state inheritance", () => {
    const { ledger, shots } = setup(), tracks = replayContinuityFact(ledger, shots, "main", "F");
    const view = visibleContinuityTrack(tracks[2], "SUB", tracks[0], false); assert.equal(view.continuous, false); assert.equal(view.before, "b");
    assert.equal(replayContinuityFact(ledger, shots, "memory", "F")[0].before, "c");
});
test("event creation replays conflicts rather than blindly trusting previous after", () => {
    const { ledger, shots } = setup(); ledger.events[0].before = "c";
    assert.equal(continuityPriorState(ledger, shots, "S3", "F", 0), "unknown");
    assert.equal(continuityEventAnchor(ledger, shots, "S3", "F", 0, true).before, "unknown");
});
test("entity kind participates in ownership and dense targets get separate vertical lanes", () => {
    assert.notEqual(continuityEntityKey("scene", "same"), continuityEntityKey("asset", "same"));
    assert.deepEqual(continuityMarkerLanes([{ position: .5 }, { position: 37 / 72 }, { position: 38 / 72 }]), [0, 1, 2]);
});
test("unsaved editor state cannot borrow a passed report, and a clean published snapshot remains independent", () => {
    const report = { status: "passed", sourceHash: "published" };
    assert.equal(continuityPreviewStatus(report, "published", true), "unsaved");
    assert.equal(continuityPreviewStatus(report, "draft", false), "stale");
    assert.equal(continuityPreviewStatus(report, "published", false), "passed");
    assert.equal(continuityPreviewStatus(undefined, "draft", false), "unchecked");
});

test("out-of-range event frames never turn after into a full-Shot known state", () => {
    const { ledger, shots } = setup(); ledger.events[0].local_frame = 999;
    const tracks = replayContinuityFact(ledger, shots, "main", "F");
    assert.ok(tracks[1].segments.every(segment => segment.value === "unknown")); assert.equal(tracks[2].before, "unknown");
    assert.throws(() => continuityPriorState(ledger, shots, "S3", "F", 0), /INVALID_EVENT_FRAME/);
});
test("evidence selection respects explicit scene occurrences sharing one environment", () => {
    const scenes = [{ id: "O1", scene_id: "ROOM", blocks: [{ id: "B1", text: "first" }] }, { id: "O2", scene_id: "ROOM", blocks: [{ id: "B2", text: "return" }] }];
    const source = { script_scenes: scenes, shots: [{ id: "S1", source_scene_id: "O1", scene_id: "ROOM" }, { id: "S2", source_scene_id: "O2", scene_id: "ROOM" }] };
    const blocks = continuitySourceBlocks(scenes);
    assert.deepEqual(continuityBlocksForShot(source, blocks, source.shots[0]).map(block => block.id), ["B1"]);
    assert.deepEqual(continuityBlocksForShot(source, blocks, source.shots[1]).map(block => block.id), ["B2"]);
    assert.equal(continuityDefaultEvidenceBlockId(continuityBlocksForShot(source, blocks, source.shots[0])), "B1");
    assert.equal(continuityDefaultEvidenceBlockId(blocks), "", "multiple candidate blocks require the user to choose");
    assert.deepEqual(continuitySourceBlocks([{ id: "flat", scene_id: "ROOM", text: "not a nested evidence block" }]), []);
});

test("invalid-anchor contamination cannot be bypassed by a later same-Shot recovery during event creation", () => {
    const { ledger, shots } = setup(); ledger.events[0].local_frame = -1;
    ledger.events.push({ id: "LATER", timeline_id: "main", shot_id: "S2", fact_id: "F", local_frame: 60, before: "unknown", after: "c" });
    assert.equal(replayContinuityFact(ledger, shots, "main", "F")[2].before, "unknown");
    assert.throws(() => continuityPriorState(ledger, shots, "S3", "F", 0), /INVALID_EVENT_FRAME/);
});

test("formal frame diagnostics reject invalid drafts across every event without gating unknown quality states", () => {
 const { source, ledger } = setup();
 for (const value of ["", -1, 1.5, 72, 999]) {
  ledger.events[0].local_frame = value as any;
  assert.ok(continuityEventPositionIssues(source, ledger).length, String(value));
 }
 ledger.events[0].local_frame = 71; ledger.events[0].after = "unknown";
 assert.equal(continuityEventPositionIssues(source, ledger).length, 0);
});

test("all v2 read views share conflict and explicit unknown recovery with the track replay", () => {
 const { source, ledger, shots } = setup(); ledger.events[0].before = "c";
 ledger.events.push({ id: "RECOVER", timeline_id: "main", shot_id: "S3", fact_id: "F", local_frame: 10, before: "unknown", after: "a" });
 const view = continuityReadProjection(source, ledger, shots), tracks = replayContinuityFact(ledger, shots, "main", "F");
 assert.equal(view.eventStates.E, "unknown"); assert.equal(view.eventStates.RECOVER, "a");
 for (const track of tracks) { assert.equal(view.trajectories[track.shot.id].start.F, track.before); assert.equal(view.trajectories[track.shot.id].end.F, track.after); }
});

test("legacy v1 Shots project v2 ledger facts into explicit unknown-presence context without changing source", () => {
 const source: any = { prompt_assembly: { version: 1 }, character_registry: [{ id: "CHAR_A", name: "Ari" }], scene_registry: [{ id: "ROOM", name: "Room" }], asset_plan: [],
  shots: [
   { id: "S1", timeline_id: "main", start_frame: 148, end_frame: 220, duration_frames: 72, scene_id: "ROOM", characters: [{ id: "CHAR_A" }], required_assets: [] },
   { id: "S2", timeline_id: "main", start_frame: 220, end_frame: 300, duration_frames: 80, scene_id: "OTHER", characters: [], required_assets: [] },
   { id: "S3", timeline_id: "main", start_frame: 300, end_frame: 360, duration_frames: 60, scene_id: "OTHER", characters: [], required_assets: [] },
  ] };
 const ledger: any = { contract_version: 2,
  facts: [
   { id: "F_CHAR", object_kind: "character", object_id: "CHAR_A", allowed_values: ["a", "b"] },
   { id: "F_SCENE", object_kind: "scene", object_id: "ROOM", allowed_values: ["a", "b"] },
   { id: "F_MISSING", object_kind: "asset", object_id: "ORPHAN", allowed_values: ["a", "b"] },
   { id: "F_UNREFERENCED", object_kind: "character", object_id: "NO_SHOT_REF", allowed_values: ["a", "b"] },
  ], timelines: [{ id: "main", start_frame: 148 }],
  initial: ["F_CHAR", "F_SCENE", "F_MISSING", "F_UNREFERENCED"].map(fact_id => ({ timeline_id: "main", fact_id, value: "a" })),
  events: [{ id: "E_CHAR", timeline_id: "main", shot_id: "S2", fact_id: "F_CHAR", frame: 230, before: "a", after: "b" },
   { id: "E_MISSING", timeline_id: "main", shot_id: "S2", fact_id: "F_MISSING", frame: 240, before: "a", after: "b" }], requirements: [], coverage: [] };
 const original = structuredClone(source), projected = continuityWorkbenchSource(source, ledger), shots = continuityTimelineShots(projected, ledger);
 const charSubject = projected.subject_registry.find((row: any) => row.entityRef.id === "CHAR_A"), missingSubject = projected.subject_registry.find((row: any) => row.entityRef.id === "ORPHAN"), unreferencedSubject = projected.subject_registry.find((row: any) => row.entityRef.id === "NO_SHOT_REF");
 assert.equal(charSubject.display_name, "Ari"); assert.equal(charSubject.legacyUnregistered, false);
 assert.equal(missingSubject.legacyUnregistered, true); assert.equal(unreferencedSubject.legacyUnregistered, true);
 assert.equal(continuityUsage(shots.find(row => row.id === "S1")!, charSubject.id).windows.length, 0);
 assert.equal(continuityUsage(shots.find(row => row.id === "S1")!, charSubject.id).contextual.length, 1);
 assert.equal(continuityUsage(shots.find(row => row.id === "S3")!, charSubject.id).contextual.length, 0);
 assert.equal(continuityUsage(shots.find(row => row.id === "S2")!, missingSubject.id).contextual.length, 1);
 assert.equal(continuityUsage(shots.find(row => row.id === "S3")!, unreferencedSubject.id).contextual.length, 0);
 const charTracks = replayContinuityFact(ledger, shots, "main", "F_CHAR"), view = visibleContinuityTrack(charTracks[1], charSubject.id, charTracks[0], true);
 assert.equal(view.contextOnly, true); assert.equal(view.markers[0].frame, 10); assert.equal(view.markers[0].position, .125);
 assert.deepEqual(source, original); assert.equal(source.subject_registry, undefined); assert.equal(source.shots[0].subject_usages, undefined);
});

test("legacy absolute event frames edit in local coordinates and remain within half-open Shot boundaries", () => {
 const source: any = { prompt_assembly: { version: 1 }, shots: [
  { id: "S1", timeline_id: "main", start_frame: 148, end_frame: 220, duration_frames: 72 },
  { id: "S2", timeline_id: "main", start_frame: 220, end_frame: 300, duration_frames: 80 },
 ] };
 const shots = source.shots, ledger: any = { contract_version: 2, facts: [{ id: "F", object_kind: "character", object_id: "C", allowed_values: ["a", "b"] }], timelines: [{ id: "main" }],
  initial: [{ timeline_id: "main", fact_id: "F", value: "a" }],
  events: [{ id: "E", timeline_id: "main", shot_id: "S2", fact_id: "F", frame: 230, before: "a", after: "b" }], requirements: [], coverage: [] };
 assert.equal(continuityLocalFrame(ledger.events[0], shots[1]), 10);
 assert.equal(continuityEventFrame(ledger.events[0], shots), 230);
 assert.deepEqual(continuityEventPositionPatch(ledger.events[0], shots[1], 20, false), { frame: 240, local_frame: undefined });
 assert.deepEqual(continuityEventPositionPatch(ledger.events[0], shots[1], 20, true), { local_frame: 20 });
 assert.deepEqual(continuityEventAnchor(ledger, shots, "S2", "F", 20, true, false).anchor, { frame: 240 });
 const next = appendContinuityChange(ledger, shots, { shotId: "S2", factId: "F", frame: "20", after: "a", reason: "Returns to baseline", sourceBlockId: "B" }, "digest", () => "E2", true, false);
 assert.equal(next.ledger.events[1].frame, 240); assert.equal("local_frame" in next.ledger.events[1], false);
 assert.equal(next.ledger.events[1].before, "b"); assert.equal(continuityLocalFrame(next.ledger.events[1], shots[1]), 20);
 ledger.events.push({ id: "AT_BOUNDARY", timeline_id: "main", shot_id: "S1", fact_id: "F", frame: 220, before: "b", after: "a" });
 assert.equal(continuityEventPositionIssues(source, ledger).some(issue => issue.path.at(-1) === "frame"), true);
 ledger.events.at(-1).shot_id = "S2"; ledger.events.at(-1).frame = 220;
 assert.equal(continuityLocalFrame(ledger.events.at(-1), shots[1]), 0);
 assert.equal(continuityEventPositionIssues(source, ledger).length, 0);
});
