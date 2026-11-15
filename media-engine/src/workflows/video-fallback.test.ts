import assert from "node:assert/strict";
import test from "node:test";

import { applyV15VideoReference, applyVideoReferenceFallback } from "./video-fallback.js";

function v15Graph(slots: Record<string, unknown> = {}): Record<string, any> {
    return {
        "741": { class_type: "NanFengH3MultiReferenceGeneratorV15", inputs: { 提示词: "prompt", 视频1: "未选择", 视频2: "未选择", 视频3: "未选择", ...slots } },
        out: { class_type: "SaveVideo", inputs: { video: ["741", 0], filename_prefix: "video/H3" } },
    };
}

test("V15 回退：填第一个空视频参考槽，深拷贝不改原图", () => {
    const graph = v15Graph({ 视频1: "user-ref.mp4" });
    const snapshot = JSON.stringify(graph);
    const { workflow, summary } = applyV15VideoReference(graph, "prev.mp4");
    assert.equal(JSON.stringify(graph), snapshot);
    assert.equal((workflow["741"] as any).inputs.视频1, "user-ref.mp4", "已有参考不被覆盖");
    assert.equal((workflow["741"] as any).inputs.视频2, "prev.mp4");
    assert.deepEqual(summary, { mode: "v15-reference", prevVideoFile: "prev.mp4", targetNode: "741", slot: "视频2" });
});

test("V15 回退：参考槽全占满时拒绝，不覆盖用户参考", () => {
    const graph = v15Graph({ 视频1: "a.mp4", 视频2: "b.mp4", 视频3: "c.mp4" });
    assert.throws(() => applyV15VideoReference(graph, "prev.mp4"), /参考槽位已满/);
});

/** YZ金鱼同构：原生 H3 参考节点 + 三个空 VHS_LoadVideo 喂 ref_videos，音频槽未接。 */
function emptyRefGraph(): Record<string, any> {
    return {
        "27": { class_type: "VHS_LoadVideo", inputs: { video: "" } },
        "25": { class_type: "VHS_LoadVideo", inputs: { video: "" } },
        "265": {
            class_type: "MiniMaxH3ReferenceToVideo",
            inputs: { prompt: "p", "ref_videos.ref_video_0": ["27", 0], "ref_videos.ref_video_1": ["25", 0] },
        },
        out: { class_type: "SaveVideo", inputs: { video: ["265", 0] } },
    };
}

test("参考槽回退：优先填最低序号的空视频加载器，并顺带接上同序号参考视频音频", () => {
    const graph = emptyRefGraph();
    const snapshot = JSON.stringify(graph);
    const { workflow, summary } = applyVideoReferenceFallback(graph, "prev.mp4");
    assert.equal(JSON.stringify(graph), snapshot);
    assert.equal((workflow["27"] as any).inputs.video, "prev.mp4", "填喂 ref_video_0 的加载器");
    assert.equal((workflow["25"] as any).inputs.video, "", "其它空槽不动");
    assert.deepEqual((workflow["265"] as any).inputs["ref_video_audios.ref_video_audio_0"], ["27", 2]);
    assert.deepEqual(summary, { mode: "reference-slot", prevVideoFile: "prev.mp4", targetNode: "27", slot: "ref_video_0", replaced: false, audioWired: true });
});

/** 二创神器同构：源视频加载器已有文件，同时喂画面（经透传）与音频槽。 */
function sourceRefGraph(): Record<string, any> {
    return {
        "336": { class_type: "VHS_LoadVideo", inputs: { video: "source.mp4" } },
        "349": { class_type: "ImageFromBatch", inputs: { image: ["336", 0], batch_index: 0, length: 100 } },
        "136": {
            class_type: "MiniMaxH3ReferenceToVideo",
            inputs: { prompt: "p", "ref_videos.ref_video_0": ["349", 0], "ref_video_audios.ref_video_audio_0": ["336", 2] },
        },
        out: { class_type: "SaveVideo", inputs: { video: ["136", 0] } },
    };
}

test("参考槽回退：无空槽时替换喂 ref_video_audios 的源视频加载器，音频随同源更新", () => {
    const graph = sourceRefGraph();
    const snapshot = JSON.stringify(graph);
    const { workflow, summary } = applyVideoReferenceFallback(graph, "prev.mp4");
    assert.equal(JSON.stringify(graph), snapshot);
    assert.equal((workflow["336"] as any).inputs.video, "prev.mp4");
    assert.deepEqual((workflow["136"] as any).inputs["ref_video_audios.ref_video_audio_0"], ["336", 2], "音频接线不变，随源加载器更新");
    assert.equal(summary.replaced, true);
    assert.equal(summary.targetNode, "336");
    assert.equal(summary.audioWired, false);
});

test("参考槽回退：没有 H3 参考节点时拒绝（无处载入视频）", () => {
    assert.throws(
        () => applyVideoReferenceFallback({ out: { class_type: "SaveVideo", inputs: {} } }, "prev.mp4"),
        /没有可载入上一段视频的位置/,
    );
});

test("参考槽回退：H3 参考节点没有任何视频加载器时拒绝", () => {
    const graph = {
        "136": { class_type: "MiniMaxH3ReferenceToVideo", inputs: { prompt: "p", "ref_images.ref_image_0": ["51", 0] } },
        "51": { class_type: "LoadImage", inputs: { image: "a.png" } },
        out: { class_type: "SaveVideo", inputs: { video: ["136", 0] } },
    };
    assert.throws(() => applyVideoReferenceFallback(graph, "prev.mp4"), /没有可载入的视频输入/);
});