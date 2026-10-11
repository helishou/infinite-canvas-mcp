import assert from "node:assert/strict";
import test from "node:test";
import { storyBeatCards, assetImagePreview, dialogueSpeakerLabel, shotDurationPatch } from "./director-display";
test("story beats show scoped authored action instead of repeated abstract goals", () => {
 const beats = [{ id: "1", scene_id: "A", goal: "A generic goal", choice: "主管递出处罚任务。" }, { id: "2", scene_id: "A", goal: "A generic goal", choice: "黎希拿起档案离开。" }, { id: "3", scene_id: "B", goal: "去签约", result: "张伟签下契约。" }];
 const before = structuredClone(beats), cards = storyBeatCards(beats, "A");
 assert.deepEqual(cards.map(card => card.text), ["主管递出处罚任务。", "黎希拿起档案离开。"]);
 assert.deepEqual(cards[0].repeatedFields, ["goal"]);
 assert.deepEqual(beats, before);
 assert.equal(storyBeatCards(beats, "B")[0].text, "张伟签下契约。");
 assert.deepEqual(storyBeatCards([{ goal: "The speaking character pursues the explicit action or information in the source line." }, { goal: "The speaking character pursues the explicit action or information in the source line." }]).map(card => card.text), ["", ""]);
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

test("dialogue speaker resolves the v2 speaker_id/speaker_name instead of showing the placeholder", () => {
 const nameMap = { CHAR_LIXI: "Lixi", CHAR_ZHANGWEI: "Zhang Wei" };
 const labels = { narration: "旁白", speaker: "说话人" };
 // v2 稿：说话人在 speaker_id + speaker_name，旧字段为空 → 必须显示名字，不能落到占位文案
 assert.equal(dialogueSpeakerLabel({ speaker_id: "S1", speaker_name: "Lixi", text: "人类的欲望" }, nameMap, labels), "Lixi");
 // 注册表 id 命中时用注册名（本地化优先）
 assert.equal(dialogueSpeakerLabel({ character_id: "CHAR_ZHANGWEI", speaker_name: "Zhang Wei" }, nameMap, labels), "Zhang Wei");
 // speaker_name 是注册表里的别名 → 反查回注册名
 assert.equal(dialogueSpeakerLabel({ speaker_id: "S4", speaker_name: "lixi" }, nameMap, labels), "Lixi");
 // 位次号没有对应注册实体时保留原始说话人名
 assert.equal(dialogueSpeakerLabel({ speaker_id: "S4", speaker_name: "subordinate" }, nameMap, labels), "subordinate");
 // 旁白与完全没有说话人信息的情况
 assert.equal(dialogueSpeakerLabel({ speaker_id: "NARRATOR", text: "三年后。" }, nameMap, labels), "旁白");
 assert.equal(dialogueSpeakerLabel({ text: "（沉默）" }, nameMap, labels), "说话人");
});

test("shot duration converts seconds to frames without moving the shot start", () => {
 // 起始帧由前序镜头决定，改时长只推 end_frame
 assert.deepEqual(shotDurationPatch({ start_frame: 0, end_frame: 108 }, 4.5, 24), { end_frame: 108 });
 assert.deepEqual(shotDurationPatch({ start_frame: 0, end_frame: 108 }, 6, 24), { end_frame: 144 });
 // 非零起点：时长是时长，不是绝对帧号
 assert.deepEqual(shotDurationPatch({ start_frame: 240, end_frame: 360 }, 3, 24), { end_frame: 312 });
 // 原稿已登记 duration_frames 时同步，避免两个字段各说各话
 assert.deepEqual(shotDurationPatch({ start_frame: 0, end_frame: 120, duration_frames: 120 }, 8, 24), { end_frame: 192, duration_frames: 192 });
 // 帧率异常时回落 24fps；时长下限 1 帧
 assert.deepEqual(shotDurationPatch({ start_frame: 0, end_frame: 0 }, 0.001, 0), { end_frame: 1 });
});
