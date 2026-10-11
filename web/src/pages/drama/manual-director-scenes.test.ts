import assert from "node:assert/strict";
import test from "node:test";
import { createManualScriptScene } from "./manual-director-scenes";

test("new manual script scene creates a separate occurrence/environment and the first usable timeline", () => {
    const source = { script_scenes: [], scene_registry: [], ledger: { contract_version: 2, timelines: [], facts: [], initial: [], events: [], requirements: [], coverage: [] }, untouched: true };
    const result = createManualScriptScene(source, { blockId: "BLOCK_1", sceneId: "SCENE_1", name: "旧屋夜内", defaultTimelineName: "主时间线" });

    assert.deepEqual(source.script_scenes, []);
    assert.deepEqual(result.occurrence, { id: "BLOCK_1", scene_id: "SCENE_1", scene_name: "旧屋夜内", kind: "action", text: "" });
    assert.deepEqual(result.environment, { id: "SCENE_1", name: "旧屋夜内", description: "" });
    assert.deepEqual(result.source.ledger.timelines, [{ id: "main", name: "主时间线" }]);
    assert.deepEqual(result.source.untouched, true);
});

test("manual scene addition preserves existing environments and timelines", () => {
    const source = { script_scenes: [], scene_registry: [{ id: "SCENE_OLD", name: "旧环境" }], ledger: { timelines: [{ id: "TIMELINE_OLD", name: "既有时间线" }] } };
    const result = createManualScriptScene(source, { blockId: "BLOCK_2", sceneId: "SCENE_2", name: "新场次", defaultTimelineName: "主时间线" });

    assert.deepEqual(result.source.scene_registry, [...source.scene_registry, { id: "SCENE_2", name: "新场次", description: "" }]);
    assert.deepEqual(result.source.ledger.timelines, source.ledger.timelines);
    assert.equal(result.timelineId, "TIMELINE_OLD");
});
