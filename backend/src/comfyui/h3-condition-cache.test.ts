import assert from "node:assert/strict";
import test from "node:test";

import { buildExpandedNanFengV10Workflow } from "./bridge.js";

/**
 * 连续生成模式（keepModelCache）的条件缓存契约。
 *
 * 展开流默认把三个 Loader 的名字接在释放屏障（NanFengH3ReleaseAtStartV15 /
 * NanFengH3ReleaseBeforeConditionLoadersV15）后面，屏障节点的 IS_CHANGED 在非 keep 时返回 NaN，
 * 而 ComfyUI 的缓存签名递归包含祖先（comfy_execution/caching.py:117）——于是 CLIPLoader 与
 * 条件编码节点（MiniMaxH3ImageToVideo 内联 clip.tokenize(prompt)）每次都是新 key，
 * prompt 没变也要重新加载 TE 并重编码。
 *
 * keep 模式必须把名字改回字面量、并把条件释放节点从条件链上摘掉，条件张量才可能命中缓存。
 * 这类改动会直接改变图形状，所以逐条钉死。
 */

const base = {
    mode: "t2v",
    prompt: "a shot",
    modelName: "H3\\probe.safetensors",
    textEncoder: "qwen3vl_32b_minimax_h3_fp8.safetensors",
    videoVae: "H3\\minimax_h3_video_vae_fp16.safetensors",
    audioVae: "H3\\minimax_h3_audio_vae_fp32.safetensors",
    aspectRatio: "16:9 (Widescreen)",
    megapixels: 0.4,
    referenceLongEdge: 1920,
    duration: 5,
    steps: 20,
    denoise: 1,
    scheduler: "simple",
    seed: 12345,
    precision: "default",
    textEncoderType: "minimax",
    textEncoderDevice: "default",
    sampler: "er_sde",
    realtimePreviewEnabled: true,
    nativeLoaderCacheSupported: true,
    keepModelCache: false,
    noCaption: true,
} as Record<string, unknown>;

const upload = async (file: string) => `uploaded-${file}`;

const build = (input: Record<string, unknown>, params: Record<string, unknown>) =>
    buildExpandedNanFengV10Workflow(input, { ...base, ...params }, upload, "http://comfy.local", new AbortController().signal);

test("默认模式：Loader 名字仍由释放屏障供给，条件释放节点挂在条件链上", async () => {
    const graph = await build({ prompt: "a shot" }, {});
    assert.deepEqual(graph.nf_clip.inputs.clip_name, ["nf_gate_clip", 1]);
    assert.deepEqual(graph.nf_video_vae.inputs.vae_name, ["nf_gate_video_vae", 1]);
    assert.deepEqual(graph.nf_audio_vae.inputs.vae_name, ["nf_gate_audio_vae", 1]);
    assert.equal(graph.nf_condition_release.class_type, "NanFengH3ReleaseBeforeConditioningV15");
    assert.deepEqual(graph.nf_image_condition.inputs.clip, ["nf_condition_release", 0]);
    assert.deepEqual(graph.nf_image_condition.inputs.vae, ["nf_condition_release", 1]);
});

test("连续生成模式：条件链脱离 NaN 屏障，prompt 不变时可命中缓存", async () => {
    const graph = await build({ prompt: "a shot" }, { keepModelCache: true });
    assert.equal(graph.nf_clip.inputs.clip_name, base.textEncoder);
    assert.equal(graph.nf_video_vae.inputs.vae_name, base.videoVae);
    assert.equal(graph.nf_audio_vae.inputs.vae_name, base.audioVae);
    // 条件释放节点被摘掉：它每次执行都会把 NaN 写进下游签名。
    assert.equal(Object.hasOwn(graph, "nf_condition_release"), false);
    assert.deepEqual(graph.nf_image_condition.inputs.clip, ["nf_clip", 0]);
    assert.deepEqual(graph.nf_image_condition.inputs.vae, ["nf_video_vae", 0]);
    // 条件编码节点的其余输入必须只有真实参数，不能再出现屏障链。
    const ancestors = JSON.stringify(graph.nf_image_condition.inputs);
    assert.equal(ancestors.includes("nf_condition_loaders"), false);
    assert.equal(ancestors.includes("nf_gate_clip"), false);
});

test("连续生成模式在 ref2va 下同样只保留真实参数依赖", async () => {
    const graph = await build({ prompt: "@图片1", references: ["probe_ref.png"] }, { mode: "ref2va", keepModelCache: true });
    assert.equal(graph.nf_clip.inputs.clip_name, base.textEncoder);
    assert.deepEqual(graph.nf_ref_condition.inputs.clip, ["nf_clip", 0]);
    assert.deepEqual(graph.nf_ref_condition.inputs.vae, ["nf_video_vae", 0]);
    assert.deepEqual(graph.nf_ref_condition.inputs.audio_vae, ["nf_audio_vae", 0]);
    assert.equal(JSON.stringify(graph.nf_ref_condition.inputs).includes("nf_condition_loaders"), false);
});

test("连续生成模式不改变采样侧与屏障节点本身", async () => {
    const graph = await build({ prompt: "a shot" }, { keepModelCache: true });
    assert.equal(graph.nf_start.class_type, "NanFengH3ReleaseAtStartV15");
    // 起始释放必须每任务执行（卸载上一段模型 + 预留显存）；跳过它会让显存带着上一段状态进入采样。
    assert.equal(graph.nf_start.inputs.keep_loader_cache, false);
    assert.equal(graph.nf_sampling_release.class_type, "NanFengH3ReleaseBeforeSamplingV15");
    assert.deepEqual(graph.nf_model.inputs.unet_name, ["nf_gate_unet", 1]);
    // 条件加载屏障保留但失去条件侧下游，ComfyUI 不会执行它，也不再污染条件签名。
    assert.equal(graph.nf_condition_loaders.class_type, "NanFengH3ReleaseBeforeConditionLoadersV15");
    assert.equal(graph.nf_condition_loaders.inputs.keep_loader_cache, true);
});
