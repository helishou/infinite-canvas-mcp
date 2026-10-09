import assert from "node:assert/strict";
import test from "node:test";
import { storyBeatCards, assetImagePreview } from "./director-display";
test("story beats show scoped authored action instead of repeated abstract goals", () => {
 const beats = [{ id: "1", scene_id: "A", goal: "A generic goal", choice: "主管递出处罚任务。" }, { id: "2", scene_id: "A", goal: "A generic goal", choice: "黎希拿起档案离开。" }, { id: "3", scene_id: "B", goal: "去签约", result: "张伟签下契约。" }];
 const before = structuredClone(beats), cards = storyBeatCards(beats, "A");
 assert.deepEqual(cards.map(card => card.text), ["主管递出处罚任务。", "黎希拿起档案离开。"]);
 assert.deepEqual(cards[0].repeatedFields, ["goal"]);
 assert.deepEqual(beats, before);
 assert.equal(storyBeatCards(beats, "B")[0].text, "张伟签下契约。");
});


test("asset history browsing keeps current production identity and ignores failed or removed results", () => {
 const rows = [{ status: "success", storageKey: "current" }, { status: "success", storageKey: "old" }, { status: "failed", storageKey: "failed" }];
 const original = structuredClone(rows), preview = assetImagePreview("current", rows, "old");
 assert.deepEqual(preview.images, ["current", "old"]);
 assert.equal(preview.previewKey, "old");
 assert.equal(preview.browsingHistory, true);
 assert.equal(assetImagePreview("current", rows, "failed").browsingHistory, false);
 assert.equal(assetImagePreview("new", [], "old").previewKey, "new");
 assert.deepEqual(rows, original);
});
