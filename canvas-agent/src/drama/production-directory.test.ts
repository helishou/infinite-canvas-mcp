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

test("legacy unannotated blocks associate shots only when their scene occurrence is unambiguous", () => {
    const source = { script_scenes: [{ id: "a", scene_id: "hall" }, { id: "b", scene_id: "hall" }], shots: [{ id: "shot", scene_id: "hall" }] };
    assert.deepEqual(productionSceneEntries(source)[0].shotIds, ["shot"]);
    source.script_scenes.push({ id: "outside", scene_id: "street" }, { id: "return", scene_id: "hall" });
    assert.deepEqual(productionSceneEntries(source).map(scene => scene.shotIds), [[], [], []]);
});
