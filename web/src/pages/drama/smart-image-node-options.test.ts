import test from "node:test";
import assert from "node:assert/strict";
import { imageChoiceKey, smartImageChoices } from "./smart-image-node-options";
const node = (id: string, title: string) => ({ id, title, type: "config", metadata: { smart: true, generationMode: "image" } });
test("same node IDs in different canvases stay distinct and direct shared source selection retains the plan identity", () => {
    const assets = { selected: { nodeId: "same" } };
    const assetPlan = [{ id: "selected", sharedSource: { sourceProjectId: "shared", sourceNodeId: "same" } }];
    const result = smartImageChoices("episode", [node("same", "本集图片")], assets, [{ id: "shared", nodes: [node("same", "共享图片"), node("unselected", "未选择")] }], assetPlan);
    assert.equal(result.length, 2); assert.notEqual(imageChoiceKey(result[0]), imageChoiceKey(result[1])); assert.equal(result[1].assetId, "selected");
    assert.equal(result.some(choice => choice.nodeId === "unselected"), false);
});
test("episode projection nodes backed by a shared source are labeled as projections, not ordinary current-canvas nodes", () => {
    const sharedSource = { sourceProjectId: "shared", sourceNodeId: "shenyan" };
    const localProjection = { id: "episode-shenyan", type: "image", title: "沈砚", metadata: {
        storageKey: "image:projection",
        productionAssetId: "adopted", sharedAssetReference: { dramaId: "drama", assetId: "adopted", sourceProjectId: "shared", sourceNodeId: "shenyan" },
    } };
    const assets = { adopted: { nodeId: "episode-shenyan" } };
    const assetPlan = [{ id: "adopted", asset_name: "沈砚", sharedSource }];
    const result = smartImageChoices("episode", [localProjection], assets, [{ id: "shared", nodes: [{ id: "shenyan", type: "character", title: "沈砚" }] }], assetPlan);

    assert.equal(result[0].sharedProjection, true);
    assert.equal(result[0].shared, undefined);
    assert.equal(result[0].assetId, "adopted");
    assert.equal(result[1].shared, true);
    assert.equal(result[1].sharedProjection, undefined);
});
test("plain result slots, non-image smart nodes and missing shared source nodes are excluded", () => {
    const result = smartImageChoices("episode", [{ id: "slot", type: "image" }, { ...node("video", "视频"), metadata: { smart: true, generationMode: "video" } }], {}, [{ id: "shared", nodes: [] }], [{ id: "broken", sharedSource: { sourceProjectId: "shared", sourceNodeId: "missing" } }]);
    assert.deepEqual(result, []);
});

test("typed character, scene and prop nodes can supply workbench image bindings", () => {
    const result = smartImageChoices("episode", ["character", "scene", "prop"].map(type => ({ id: type, type, title: type })), {}, []);
    assert.deepEqual(result.map(choice => choice.nodeId), ["character", "scene", "prop"]);
});

test("an imported archived image is available for manual Subject binding", () => {
    const choices = smartImageChoices("episode", [{ id: "upload", type: "image", metadata: { storageKey: "image:upload" } }], {}, []);
    assert.equal(choices[0].nodeId, "upload");
});
