import assert from "node:assert/strict";
import test from "node:test";

import { redactInlineMedia } from "../runtime/redact-inline-media.js";
import { injectParams, removeEmptyMediaNodes, validatePromptGraph } from "./executor.js";

test("原生 H3 未提供的可选媒体保留合法 COMBO 空值，不让必填槽位消失", () => {
    const source = { h3: { class_type: "NanFengH3MultiReferenceGeneratorV15", inputs: { 图片1: "first.png", 图片2: "未选择", 视频1: "未选择", 音频1: "未选择", 提示词: "test" } }, image: { class_type: "LoadImage", inputs: { image: "stale.png" } } };
    const prepared = injectParams(source, { h3: { 图片2: null, 视频1: null, 音频1: null }, image: { image: null } }) as typeof source;
    assert.equal(prepared.h3.inputs.图片1, "first.png");
    assert.equal(prepared.h3.inputs.图片2, "未选择");
    assert.equal(prepared.h3.inputs.视频1, "未选择");
    assert.equal(prepared.h3.inputs.音频1, "未选择");
    assert.equal(Object.hasOwn(prepared.image.inputs, "image"), false);
    assert.equal(source.image.inputs.image, "stale.png");
});

test("工作流持久化数据会移除嵌套 data URL，但保留普通句柄和文本", () => {
    const value = redactInlineMedia({
        prompt: "test",
        image: "data:image/png;base64,AAAA",
        nested: [{ image: "data:image/jpeg;base64,BBBB" }, { storageKey: "image:ref-1" }],
    });

    assert.deepEqual(value, {
        prompt: "test",
        image: "[inline-media:image/png]",
        nested: [{ image: "[inline-media:image/jpeg]" }, { storageKey: "image:ref-1" }],
    });
    assert.doesNotMatch(JSON.stringify(value), /base64|AAAA|BBBB/);
});

test("Qwen 双图编辑裁掉未提供图片时保留提示词链和媒体输出", () => {
    const graph = {
        "1": { class_type: "LoadImage", inputs: { image: "first.png" } },
        "2": { class_type: "LoadImage", inputs: { image: "second.png" } },
        "3": { class_type: "LoadImage", inputs: { image: null } },
        "4": { class_type: "TE_Qwen_Image_2_1_Prompt_Enhancer", inputs: { 图片: ["1", 0], 图片2: ["2", 0], 图片3: ["3", 0] } },
        "5": { class_type: "TE_text_display", inputs: { input_text: ["4", 0] } },
        "6": { class_type: "TextEncodeQwenImage21", inputs: { prompt: ["5", 0], "images.image_1": ["1", 0], "images.image_2": ["2", 0], "images.image_3": ["3", 0] } },
        "7": { class_type: "KSampler", inputs: { positive: ["6", 0] } },
        "8": { class_type: "SaveImageAdvanced", inputs: { images: ["7", 0] } },
    };
    const fields = ["1", "2", "3"].map((node) => ({ id: `image-${node}`, node, input: "image", type: "image" as const, name: `图${node}` }));

    const prepared = removeEmptyMediaNodes(graph, fields, {});
    assert.equal(prepared["3"], undefined);
    assert.deepEqual((prepared["4"] as { inputs: Record<string, unknown> }).inputs, { 图片: ["1", 0], 图片2: ["2", 0] });
    assert.deepEqual((prepared["6"] as { inputs: Record<string, unknown> }).inputs, { prompt: ["5", 0], "images.image_1": ["1", 0], "images.image_2": ["2", 0] });
    assert.ok(prepared["8"]);
    assert.doesNotThrow(() => validatePromptGraph(prepared));
});

test("H3 参考槽位缺失时保留 MiniMaxH3ReferenceToVideo 并断开空槽", () => {
    const graph = {
        "51": { class_type: "LoadImage", inputs: { image: "first.png" } },
        "49": { class_type: "LoadImage", inputs: { image: null } },
        "27": { class_type: "VHS_LoadVideo", inputs: { video: "" } },
        "48": { class_type: "LoadAudio", inputs: { audio: null } },
        "265": {
            class_type: "MiniMaxH3ReferenceToVideo",
            inputs: {
                prompt: "test",
                "ref_images.ref_image_0": ["51", 0],
                "ref_images.ref_image_1": ["49", 0],
                "ref_videos.ref_video_0": ["27", 0],
                "ref_audios.ref_audio_0": ["48", 0],
            },
        },
        "364": { class_type: "VHS_VideoCombine", inputs: { images: ["265", 0] } },
    };
    const fields = [
        { id: "reference_image_1", node: "51", input: "image", type: "image" as const, name: "参考图 1" },
        { id: "reference_image_2", node: "49", input: "image", type: "image" as const, name: "参考图 2" },
        { id: "reference_video_1", node: "27", input: "video", type: "video" as const, name: "参考视频 1" },
        { id: "reference_audio_1", node: "48", input: "audio", type: "audio" as const, name: "参考音频 1" },
    ];

    const prepared = removeEmptyMediaNodes(graph, fields, {});
    assert.equal(prepared["49"], undefined);
    assert.equal(prepared["27"], undefined);
    assert.equal(prepared["48"], undefined);
    assert.deepEqual((prepared["265"] as { inputs: Record<string, unknown> }).inputs, {
        prompt: "test",
        "ref_images.ref_image_0": ["51", 0],
    });
    assert.ok(prepared["364"]);
    assert.doesNotThrow(() => validatePromptGraph(prepared));
});

test("必选参考图缺失时仍然报错，不会静默跑空槽", () => {
    const graph = {
        "51": { class_type: "LoadImage", inputs: { image: null } },
        "265": { class_type: "MiniMaxH3ReferenceToVideo", inputs: { "ref_images.ref_image_0": ["51", 0] } },
        "364": { class_type: "VHS_VideoCombine", inputs: { images: ["265", 0] } },
    };
    const fields = [{ id: "reference_image_1", node: "51", input: "image", type: "image" as const, name: "参考图 1", required: true }];
    assert.throws(() => removeEmptyMediaNodes(graph, fields, {}), /必选媒体/);
});

test("空音频接到非可选输入时保留加载器，交回 ComfyUI 报缺失输入", () => {
    const graph = {
        "1": { class_type: "LoadImage", inputs: { image: "first.png" } },
        "48": { class_type: "LoadAudio", inputs: { audio: null } },
        "364": { class_type: "VHS_VideoCombine", inputs: { images: ["1", 0], audio: ["48", 0] } },
    };
    const fields = [{ id: "reference_audio_1", node: "48", input: "audio", type: "audio" as const, name: "参考音频 1" }];
    const prepared = removeEmptyMediaNodes(graph, fields, {});
    assert.ok(prepared["48"]);
    assert.ok(prepared["364"]);
});
