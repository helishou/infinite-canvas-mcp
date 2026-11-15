import assert from "node:assert/strict";
import test from "node:test";

import {
    applyLatentContinuation, applyV15LatentContinuation, detectH3AvHooks, findV15Generator,
} from "./latent-continuation.js";

const FOLDER = "nanfeng_v15_context/46d69df1ec6e86b9f5aac04a64864c7a691f80c8a9498e90ec603056b444d333";

/** 裸 H3 AV 流的最小同构图：Ref2VA → BasicGuider → SamplerCustomAdvanced → 双解码 → CreateVideo → SaveVideo。 */
function bareH3Graph(): Record<string, any> {
    return {
        "136": { class_type: "MiniMaxH3ReferenceToVideo", inputs: { clip: ["559", 0], vae: ["234", 0], audio_vae: ["235", 0], prompt: ["561", 0] } },
        "314": { class_type: "BasicGuider", inputs: { model: ["275", 0], conditioning: ["136", 0] } },
        "125": { class_type: "SamplerCustomAdvanced", inputs: { noise: ["129", 0], guider: ["314", 0], sampler: ["123", 0], sigmas: ["283", 0], latent_image: ["136", 1] } },
        "219": { class_type: "VAEDecode", inputs: { samples: ["125", 1], vae: ["237", 0] } },
        "218": { class_type: "VAEDecodeAudio", inputs: { samples: ["125", 1], vae: ["236", 0] } },
        "220": { class_type: "CreateVideo", inputs: { images: ["219", 0], audio: ["218", 0], fps: 24 } },
        "221": { class_type: "SaveVideo", inputs: { video: ["220", 0], filename_prefix: "video/H3" } },
        "129": { class_type: "RandomNoise", inputs: { noise_seed: 1 } },
        "123": { class_type: "KSamplerSelect", inputs: { sampler_name: "euler" } },
        "283": { class_type: "BasicScheduler", inputs: { steps: 6 } },
        "275": { class_type: "UNETLoader", inputs: { unet_name: "h3.safetensors" } },
        "237": { class_type: "VAELoader", inputs: { vae_name: "h3_video.safetensors" } },
        "236": { class_type: "VAELoader", inputs: { vae_name: "h3_audio.safetensors" } },
        "559": { class_type: "CLIPLoader", inputs: { clip_name: "t5.safetensors" } },
        "234": { class_type: "VAELoader", inputs: { vae_name: "h3_video.safetensors" } },
        "235": { class_type: "VAELoader", inputs: { vae_name: "h3_audio.safetensors" } },
        "561": { class_type: "PrimitiveString", inputs: { value: "prompt" } },
    };
}

test("探测：从最终视频输出回溯定位共享 AV latent 的采样器与条件插入点", () => {
    const hooks = detectH3AvHooks(bareH3Graph());
    assert.ok(hooks, "裸 H3 AV 流必须命中");
    assert.deepEqual(hooks.latentLink, ["125", 1]);
    assert.deepEqual(hooks.targetLatentLink, ["136", 1]);
    assert.deepEqual(hooks.conditioningLink, ["136", 0]);
    assert.deepEqual(hooks.conditioningConsumer, { id: "314", input: "conditioning" });
    assert.deepEqual(hooks.videoVaeLink, ["237", 0]);
    assert.equal(hooks.decodeImageId, "219");
    assert.equal(hooks.decodeAudioId, "218");
    assert.equal(hooks.videoNodeId, "220");
    assert.equal(hooks.loopId, undefined);
});

test("探测：穿过 ifElse/VRAM_Debug 透传分支仍命中；画面音频 latent 不一致时拒绝", () => {
    const graph = bareH3Graph();
    graph["1245"] = { class_type: "easy ifElse", inputs: { predicate: ["705", 2], on_true: ["219", 0], on_false: ["219", 0] } };
    graph["303"] = { class_type: "VRAM_Debug", inputs: { any: ["1245", 0] } };
    graph["220"].inputs.images = ["303", 0];
    assert.ok(detectH3AvHooks(graph), "透传/分支节点不应阻断回溯");
    const mismatched = bareH3Graph();
    mismatched["218"].inputs.samples = ["136", 1];
    assert.equal(detectH3AvHooks(mismatched), null, "音频解码必须共享同一条采样器输出");
    assert.equal(detectH3AvHooks({ "1": { class_type: "SaveImage", inputs: { images: ["2", 0] } } }), null);
});

test("仅导出：纯追加 SaveLatent 侧支，零改写，原图不变", () => {
    const graph = bareH3Graph();
    const before = JSON.stringify(graph);
    const hooks = detectH3AvHooks(graph)!;
    const { workflow: out, summary } = applyLatentContinuation(graph, hooks, { folder: FOLDER, save: true });
    assert.equal(JSON.stringify(graph), before, "存储图克隆后绝不改动");
    assert.deepEqual(out.lc_save, { class_type: "MiniMaxH3MotionContextSaveLatent", inputs: { latent: ["125", 1], filename_prefix: `${FOLDER}/clip`, clip_index: 1 } });
    assert.deepEqual(out["314"].inputs.conditioning, ["136", 0], "导出侧不改条件");
    assert.deepEqual(out["220"].inputs.images, ["219", 0], "导出侧不改输出");
    assert.equal(summary.addedNodes, 1);
    assert.equal(summary.conditioningRewires, 0);
    assert.equal(summary.outputRewires, 0);
    assert.equal(summary.saved, true);
    assert.equal(summary.loadedFrom, undefined);
});

test("导入：LoadLatent→MotionContext→Trim 接线，条件与最终输出共改写三处", () => {
    const graph = bareH3Graph();
    const hooks = detectH3AvHooks(graph)!;
    const file = `${FOLDER}/clip_00001.safetensors`;
    const { workflow: out, summary } = applyLatentContinuation(graph, hooks, { folder: FOLDER, save: true, load: { file, contextLength: "22", audioContextLength: 24 } });
    assert.deepEqual(out.lc_load.inputs, { latent_path: file, clip_index: 1 });
    assert.deepEqual(out.lc_context.inputs, {
        conditioning: ["136", 0], vae: ["237", 0], latent: ["136", 1],
        context_latent: ["lc_load", 0], context_length: "22", audio_context_length: 24,
    });
    assert.deepEqual(out["314"].inputs.conditioning, ["lc_context", 0]);
    assert.deepEqual(out.lc_trim.inputs, { images: ["219", 0], audio: ["218", 0], trim_frames: ["lc_context", 1], fps: 24, match_tail: true });
    assert.deepEqual(out["220"].inputs.images, ["lc_trim", 0]);
    assert.deepEqual(out["220"].inputs.audio, ["lc_trim", 1]);
    assert.equal(summary.addedNodes, 4);
    assert.equal(summary.conditioningRewires, 1);
    assert.equal(summary.outputRewires, 2);
    assert.equal(summary.loadedFrom, file);
});

test("循环流：导入时强制起始/结束段号=1，导出时不碰循环", () => {
    const graph = bareH3Graph();
    graph["14"] = { class_type: "easy forLoopStart", inputs: { total: ["12", 1] } };
    graph["13"] = { class_type: "MathExpression|pysssss", inputs: { a: ["14", 1], b: ["11", 0], expression: "a+b" } };
    graph["12"] = { class_type: "ComfyMathExpression", inputs: { "values.a": ["10", 0], "values.b": ["11", 0], expression: "a-b+1" } };
    graph["11"] = { class_type: "PrimitiveInt", inputs: { value: 3 } };
    graph["10"] = { class_type: "PrimitiveInt", inputs: { value: 5 } };
    const hooks = detectH3AvHooks(graph)!;
    assert.equal(hooks.loopId, "14");
    const saveOnly = applyLatentContinuation(graph, hooks, { folder: FOLDER, save: true });
    assert.equal(saveOnly.workflow["11"].inputs.value, 3, "仅导出不得改变用户配置的段数");
    assert.equal(saveOnly.summary.loopForced, undefined);
    const { workflow: out, summary } = applyLatentContinuation(graph, hooks, { folder: FOLDER, save: true, load: { file: `${FOLDER}/clip_00001.safetensors`, contextLength: "22", audioContextLength: 24 } });
    assert.equal(out["11"].inputs.value, 1);
    assert.equal(out["10"].inputs.value, 1);
    assert.deepEqual(summary.loopForced, { startNode: "11", endNode: "10" });
});

test("非法输入明确拒绝：目录命名空间、context_length、节点 ID 冲突、空操作", () => {
    const graph = bareH3Graph();
    const hooks = detectH3AvHooks(graph)!;
    assert.throws(() => applyLatentContinuation(graph, hooks, { folder: "output/whatever", save: true }), /隔离的生成命名空间/);
    assert.throws(() => applyLatentContinuation(graph, hooks, { folder: FOLDER, save: false }), /至少需要导出或导入一侧/);
    assert.throws(() => applyLatentContinuation(graph, hooks, { folder: FOLDER, save: true, load: { file: "x", contextLength: "17", audioContextLength: 24 } }), /context_length/);
    graph.lc_save = { class_type: "Anything", inputs: {} };
    assert.throws(() => applyLatentContinuation(graph, hooks, { folder: FOLDER, save: true }), /ID 冲突/);
});

test("V15 主节点：填字段零追加；非 nf_v15  ID 在克隆上改号并同步引用", () => {
    const graph = {
        nf_v15: { class_type: "NanFengH3MultiReferenceGeneratorV15", inputs: { "启用潜空间续写": false, "潜空间续写任务": "", context_length: "22", audio_context_length: 24 } },
        "9": { class_type: "VHS_VideoCombine", inputs: { images: ["nf_v15", 0], audio: ["nf_v15", 1] } },
    };
    const before = JSON.stringify(graph);
    const descriptor = JSON.stringify({ workflow: "p1", node: "nf_v15", group: "n1", run: "task-1", index: 2 });
    const { workflow: out, summary } = applyV15LatentContinuation(graph, { descriptor, folder: FOLDER, index: 2 });
    assert.equal(JSON.stringify(graph), before);
    assert.equal(out.nf_v15.inputs["启用潜空间续写"], true);
    assert.equal(out.nf_v15.inputs["潜空间续写任务"], descriptor);
    assert.equal(out.nf_v15.inputs.context_length, "22", "不覆盖用户已有的窗口配置");
    assert.equal(summary.family, "v15");
    assert.equal(summary.index, 2);
    assert.equal(summary.renamedFrom, undefined);
    assert.equal(Object.keys(out).length, 2, "零追加节点");

    const renamed = {
        "7": { class_type: "NanFengH3MultiReferenceGeneratorV15", inputs: { "启用潜空间续写": false, "潜空间续写任务": "" } },
        "9": { class_type: "VHS_VideoCombine", inputs: { images: ["7", 0], audio: ["7", 1] } },
    };
    const result = applyV15LatentContinuation(renamed, { descriptor, folder: FOLDER, index: 1 });
    assert.equal(result.workflow["7"], undefined);
    assert.ok(result.workflow.nf_v15);
    assert.deepEqual(result.workflow["9"].inputs.images, ["nf_v15", 0]);
    assert.deepEqual(result.workflow["9"].inputs.audio, ["nf_v15", 1]);
    assert.equal(result.summary.renamedFrom, "7");
    assert.equal(findV15Generator(bareH3Graph()), null);
});