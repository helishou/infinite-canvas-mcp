import assert from "node:assert/strict";
import test from "node:test";
import { productionSceneEntries, productionScriptGroups } from "./production-directory.js";

test("action/dialogue beats form one scene and one shot entry without losing source blocks", () => {
    const blocks = [
        { id: "a", scene_id: "hall", scene_name: "Hall", kind: "action", beat_ids: ["a"], text: "She enters." },
        { id: "b", scene_id: "hall", kind: "dialogue", beat_ids: ["b"], text: "Hello." },
        { id: "c", scene_id: "street", kind: "action", beat_ids: ["c"], text: "He runs." },
        { id: "d", scene_id: "hall", kind: "action", beat_ids: ["d"], text: "She returns." },
    ];
    const source = { script_scenes: blocks, shots: [{ id: "shot-1", story_beat_ids: ["a", "b"] }, { id: "shot-2", story_beat_ids: ["c"] }, { id: "shot-3", story_beat_ids: ["d"] }] };
    const original = JSON.stringify(source);
    assert.deepEqual(productionScriptGroups(blocks).map(group => group.blocks.map(block => block.id)), [["a", "b"], ["c"], ["d"]]);
    assert.equal(productionScriptGroups(blocks)[0].blocks[1], blocks[1]);
    const scenes = productionSceneEntries(source);
    assert.deepEqual(scenes.map(scene => scene.id), ["a", "c", "d"]);
    assert.deepEqual(scenes.map(scene => scene.shotIds), [["shot-1"], ["shot-2"], ["shot-3"]]);
    assert.equal(scenes[0].text, "She enters.\n\nHello.");
    assert.equal(JSON.stringify(source), original);
});

test("whole scene occurrences and distinct scene headings retain narrative identity", () => {
    const blocks = [
        { id: "morning", scene_id: "hall", beat_ids: ["morning"] },
        { id: "night", scene_id: "hall", beat_ids: ["night"] },
        { id: "action", scene_id: "street", kind: "action", scene_name: "Morning", beat_ids: ["action"] },
        { id: "later", scene_id: "street", kind: "action", scene_name: "Night", beat_ids: ["later"] },
    ];
    assert.deepEqual(productionScriptGroups(blocks).map(group => group.key), blocks.map(block => block.id));
});

test("shots are never attributed by environment alone, because one environment carries several occurrences", () => {
    // Two occurrences share one environment, as in the real SCRIPT_CASTING / SCRIPT_GAZE pair.
    const occurrences = [
        { id: "casting", scene_id: "gray", scene_name: "选角", thread: "t1", kind: "action" },
        { id: "gaze", scene_id: "gray", scene_name: "凝视", thread: "t2", kind: "action" },
    ];
    const source = { script_scenes: occurrences, shots: [{ id: "shot", scene_id: "gray" }] };
    // The environment cannot say which occurrence a shot belongs to, so nothing is attributed.
    assert.deepEqual(productionSceneEntries(source).map(scene => scene.shotIds), [[], []]);
    // Naming the occurrence directly is the only way an unannotated shot is associated.
    assert.deepEqual(productionSceneEntries({ ...source, shots: [{ id: "shot", scene_id: "gray", source_scene_id: "gaze" }] }).map(scene => scene.shotIds), [[], ["shot"]]);
    // Story beats remain an equally explicit mapping.
    assert.deepEqual(productionSceneEntries({ ...source, script_scenes: occurrences.map(o => ({ ...o, beat_ids: [o.id] })), shots: [{ id: "shot", scene_id: "gray", story_beat_ids: ["casting"] }] }).map(scene => scene.shotIds), [["shot"], []]);
});

test("a single-occurrence environment attributes its unannotated shots, because no other occurrence can own them", () => {
    // Real single-scene shape: one script occurrence per environment, shots carry only the environment id.
    const source = {
        script_scenes: [{ id: "scene", scene_id: "yard", text: "Three characters in the courtyard" }],
        shots: [{ id: "SH001", scene_id: "yard" }, { id: "SH002", scene_id: "yard" }],
    };
    assert.deepEqual(productionSceneEntries(source).map(scene => scene.shotIds), [["SH001", "SH002"]]);
    // An unrelated environment's shots must not be swept into the only occurrence.
    assert.deepEqual(productionSceneEntries({ ...source, shots: [{ id: "SH001", scene_id: "yard" }, { id: "SH003", scene_id: "street" }] }).map(scene => scene.shotIds), [["SH001"]]);
});

test("an explicitly named occurrence keeps its shots even when the environment registry disagrees", () => {
    // Real production shape: script occurrences are SC01..SC06 while shots reference ENV_YARD/ENV_ROOM.
    const blocks = ["SC01", "SC02", "SC03"].map(id => ({ id, scene_id: id, heading: id, location: "", time_of_day: "", blocks: [] }));
    const shots = [
        { id: "SH001", scene_id: "ENV_YARD", source_scene_id: "SC01" },
        { id: "SH002", scene_id: "ENV_ROOM", source_scene_id: "SC03" },
        { id: "SH003", scene_id: "ENV_YARD", source_scene_id: "SC01" },
    ];
    const scenes = productionSceneEntries({ script_scenes: blocks, shots, scene_registry: [{ id: "ENV_YARD", name: "院子" }, { id: "ENV_ROOM", name: "堂屋" }] });
    assert.deepEqual(scenes.map(scene => scene.shotIds), [["SH001", "SH003"], [], ["SH002"]]);
    assert.deepEqual(scenes.map(scene => scene.environmentId), ["SC01", "SC02", "SC03"]);
    assert.deepEqual(scenes.flatMap(scene => scene.shotIds).sort(), shots.map(shot => shot.id).sort());
});
