import test from "node:test";
import assert from "node:assert/strict";
import { imageChoiceKey, smartImageChoices } from "./smart-image-node-options";
const node = (id: string, title: string) => ({ id, title, type: "config", metadata: { smart: true, generationMode: "image" } });
test("same node IDs in different canvases stay distinct and shared choices retain adoption asset identity", () => {
    const assets = { adopted: { sharedSource: { sourceProjectId: "shared", sourceNodeId: "same" } } };
    const result = smartImageChoices("episode", [node("same", "本集图片")], assets, [{ id: "shared", nodes: [node("same", "共享图片"), node("unadopted", "不可直接采用")] }]);
    assert.equal(result.length, 2); assert.notEqual(imageChoiceKey(result[0]), imageChoiceKey(result[1])); assert.equal(result[1].assetId, "adopted");
    assert.equal(result.some(choice => choice.nodeId === "unadopted"), false);
});
test("plain result slots, non-image smart nodes and missing adopted nodes are excluded", () => {
    const result = smartImageChoices("episode", [{ id: "slot", type: "image" }, { ...node("video", "视频"), metadata: { smart: true, generationMode: "video" } }], { broken: { sharedSource: { sourceProjectId: "shared", sourceNodeId: "missing" } } }, [{ id: "shared", nodes: [] }]);
    assert.deepEqual(result, []);
});
