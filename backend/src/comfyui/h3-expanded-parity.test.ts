import assert from "node:assert/strict";
import test from "node:test";

import { buildExpandedNanFengV10Workflow, splitH3Confirmation } from "./bridge.js";

/**
 * 展开流与原生 NanFengH3MultiReferenceGeneratorV15 的等价性契约。
 *
 * 期望值不是手写的：每个场景的 class_type 集合都是把南风 pack 自己的
 * GraphBuilder 子图（custom_nodes/nanfeng_prompt_nodes_v15/h3_generator.py 的 generate()）
 * 在同一组入参下真实展开后抄下来的，再加两类展开流自己特有的节点：
 *  - VHS_VideoCombine：展开流唯一多出的落盘出口；
 *  - ImpactExecutionOrderController ×4：静态图把名字屏障接到 Loader 上时必须的 AnyType 透传
 *    （ComfyUI 不容许 STRING 直连 COMBO，原生子图靠执行期展开绕过了这条校验）。
 * 谁改动展开流的节点构成或连线形状，这里必须先失败。
 */

const base = {
    mode: "ref2va",
    prompt: "a shot",
    modelName: "H3\\probe.safetensors",
    textEncoder: "qwen3vl_32b_minimax_h3_fp8.safetensors",
    videoVae: "H3\\minimax_h3_video_vae_fp16.safetensors",
    audioVae: "H3\\minimax_h3_audio_vae_fp32.safetensors",
    aspectRatio: "16:9 (Widescreen)",
    megapixels: 0.4,
    sizeMultiple: 32,
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

const SIGMA = "0.9, 0.85, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1, 0";
const upload = async (file: string) => `uploaded-${file}`;
const CONTINUATION = JSON.stringify({ workflow: "wf", node: "nf_v15", group: "g", run: "r0", index: 2 });

const scenarios: Record<string, { references: string[]; audios?: string[]; extra?: Record<string, unknown>; expected: string[] }> = {
    baseline: {
        references: ["probe_ref.png"],
        expected: ["BasicGuider", "BasicScheduler", "CLIPLoader", "ImpactExecutionOrderController", "KSamplerSelect", "LoadImage", "MiniMaxH3MemoryEfficientSageAttentionPatch", "MiniMaxH3ReferenceToVideo", "NanFengH3KJPreviewBridgeV15", "NanFengH3LimitImageLongEdgeV15", "NanFengH3ReleaseAtStartV15", "NanFengH3ReleaseBeforeConditionLoadersV15", "NanFengH3ReleaseBeforeSamplingV15", "NanFengH3TimedAudioVAEDecodeV15", "NanFengH3TimedVideoVAEDecodeV15", "NanFengV15DLSSOutput", "RandomNoise", "SamplerCustomAdvanced", "UNETLoader", "VAELoader", "VHS_VideoCombine"],
    },
    "dlss-er": {
        references: ["probe_ref.png"],
        extra: { sampler: "南风采样器", erSolverType: "ER-SDE", erMaxStage: 3, erEta: 1, erSNoise: 1, dlssUpscaleMode: "1.5× (Quality)", dlssFrameInterpolationEnabled: true },
        expected: ["BasicGuider", "BasicScheduler", "CLIPLoader", "ImpactExecutionOrderController", "LoadImage", "MiniMaxH3MemoryEfficientSageAttentionPatch", "MiniMaxH3ReferenceToVideo", "NanFengH3KJPreviewBridgeV15", "NanFengH3LimitImageLongEdgeV15", "NanFengH3ReleaseAtStartV15", "NanFengH3ReleaseBeforeConditionLoadersV15", "NanFengH3ReleaseBeforeSamplingV15", "NanFengH3TimedAudioVAEDecodeV15", "NanFengH3TimedVideoVAEDecodeV15", "NanFengV15DLSSOutput", "RandomNoise", "SamplerCustomAdvanced", "SamplerER_SDE", "UNETLoader", "VAELoader", "VHS_VideoCombine"],
    },
    continuation: {
        references: ["probe_ref.png"],
        extra: { motionContextEnabled: true, continuationTask: CONTINUATION, continuationAudioRefineEnabled: true, continuationSeamNoiseEnabled: true, continuationSeamNoise: 0.053, continuationSeamNoiseRamp: 3, contextLength: "22", audioContextLength: 24 },
        expected: ["BasicGuider", "BasicScheduler", "CLIPLoader", "ImpactExecutionOrderController", "KSamplerSelect", "LoadImage", "MiniMaxH3MemoryEfficientSageAttentionPatch", "MiniMaxH3MotionContext", "MiniMaxH3MotionContextLoadLatent", "MiniMaxH3MotionContextTrim", "MiniMaxH3ReferenceToVideo", "NanFengH3KJPreviewBridgeV15", "NanFengH3LimitImageLongEdgeV15", "NanFengH3ReleaseAtStartV15", "NanFengH3ReleaseBeforeConditionLoadersV15", "NanFengH3ReleaseBeforeSamplingV15", "NanFengH3TimedAudioVAEDecodeV15", "NanFengH3TimedVideoVAEDecodeV15", "NanFengV15CommitContinuation", "NanFengV15ContinuationAudioRefine", "NanFengV15DLSSOutput", "RandomNoise", "SamplerCustomAdvanced", "UNETLoader", "VAELoader", "VHS_VideoCombine"],
    },
    i2v: {
        references: ["probe_ref.png"], extra: { mode: "i2v" },
        expected: ["BasicGuider", "BasicScheduler", "CLIPLoader", "ImpactExecutionOrderController", "KSamplerSelect", "LoadImage", "MiniMaxH3ImageToVideo", "MiniMaxH3MemoryEfficientSageAttentionPatch", "NanFengH3KJPreviewBridgeV15", "NanFengH3LimitImageLongEdgeV15", "NanFengH3ReleaseAtStartV15", "NanFengH3ReleaseBeforeConditionLoadersV15", "NanFengH3ReleaseBeforeConditioningV15", "NanFengH3ReleaseBeforeSamplingV15", "NanFengH3TimedAudioVAEDecodeV15", "NanFengH3TimedVideoVAEDecodeV15", "NanFengV15DLSSOutput", "RandomNoise", "SamplerCustomAdvanced", "UNETLoader", "VAELoader", "VHS_VideoCombine"],
    },
    fl2v: {
        references: ["probe_ref.png", "probe_ref2.png"], extra: { mode: "fl2v" },
        expected: ["BasicGuider", "BasicScheduler", "CLIPLoader", "ImpactExecutionOrderController", "KSamplerSelect", "LoadImage", "MiniMaxH3ImageToVideo", "MiniMaxH3MemoryEfficientSageAttentionPatch", "NanFengH3KJPreviewBridgeV15", "NanFengH3LimitImageLongEdgeV15", "NanFengH3ReleaseAtStartV15", "NanFengH3ReleaseBeforeConditionLoadersV15", "NanFengH3ReleaseBeforeConditioningV15", "NanFengH3ReleaseBeforeSamplingV15", "NanFengH3TimedAudioVAEDecodeV15", "NanFengH3TimedVideoVAEDecodeV15", "NanFengV15DLSSOutput", "RandomNoise", "SamplerCustomAdvanced", "UNETLoader", "VAELoader", "VHS_VideoCombine"],
    },
    t2v: {
        references: [], extra: { mode: "t2v" },
        expected: ["BasicGuider", "BasicScheduler", "CLIPLoader", "ImpactExecutionOrderController", "KSamplerSelect", "MiniMaxH3ImageToVideo", "MiniMaxH3MemoryEfficientSageAttentionPatch", "NanFengH3KJPreviewBridgeV15", "NanFengH3ReleaseAtStartV15", "NanFengH3ReleaseBeforeConditionLoadersV15", "NanFengH3ReleaseBeforeConditioningV15", "NanFengH3ReleaseBeforeSamplingV15", "NanFengH3TimedAudioVAEDecodeV15", "NanFengH3TimedVideoVAEDecodeV15", "NanFengV15DLSSOutput", "RandomNoise", "SamplerCustomAdvanced", "UNETLoader", "VAELoader", "VHS_VideoCombine"],
    },
    lock: {
        // 锁音频把音频直接编码进目标 AV latent，所以没有音频解码节点，取而代之的是 NativeAudioLockV15。
        references: ["probe_ref.png"], audios: ["probe_lock.wav"], extra: { lockAudio: true },
        expected: ["BasicGuider", "BasicScheduler", "CLIPLoader", "ImpactExecutionOrderController", "KSamplerSelect", "LoadAudio", "LoadImage", "MiniMaxH3MemoryEfficientSageAttentionPatch", "MiniMaxH3NativeAudioLockV15", "MiniMaxH3ReferenceToVideo", "NanFengH3KJPreviewBridgeV15", "NanFengH3LimitImageLongEdgeV15", "NanFengH3ReleaseAtStartV15", "NanFengH3ReleaseBeforeConditionLoadersV15", "NanFengH3ReleaseBeforeSamplingV15", "NanFengH3TimedVideoVAEDecodeV15", "NanFengV15DLSSOutput", "RandomNoise", "SamplerCustomAdvanced", "TrimAudioDuration", "UNETLoader", "VAELoader", "VHS_VideoCombine"],
    },
    upscale: {
        references: ["probe_ref.png"],
        extra: { latentUpscaleEnabled: true, h3FullSigma: SIGMA, h3FirstSteps: 6, h3SecondSteps: 4 },
        expected: ["BasicGuider", "BasicScheduler", "CLIPLoader", "ImpactExecutionOrderController", "KSamplerSelect", "LoadImage", "ManualSigmas", "MiniMaxH3MemoryEfficientSageAttentionPatch", "MiniMaxH3ReferenceToVideo", "NanFengH3ClearUpscalerCacheResidentV15", "NanFengH3KJPreviewBridgeV15", "NanFengH3LimitImageLongEdgeV15", "NanFengH3LowPeakLatentUpscalerV15", "NanFengH3ReleaseAtStartV15", "NanFengH3ReleaseBeforeConditionLoadersV15", "NanFengH3ReleaseBeforeSamplingV15", "NanFengH3TimedAudioVAEDecodeV15", "NanFengH3TimedVideoVAEDecodeV15", "NanFengV15DLSSOutput", "RandomNoise", "SamplerCustomAdvanced", "SplitSigmas", "UNETLoader", "VAELoader", "VHS_VideoCombine"],
    },
    "uniblock-rtx": {
        references: ["probe_ref.png"], extra: { uniBlockSwapEnabled: true, rtxEnabled: true },
        expected: ["BasicGuider", "BasicScheduler", "CLIPLoader", "ImpactExecutionOrderController", "KSamplerSelect", "LoadImage", "MiniMaxH3MemoryEfficientSageAttentionPatch", "MiniMaxH3ReferenceToVideo", "NanFengH3ApplyUniBlockSwapV15", "NanFengH3KJPreviewBridgeV15", "NanFengH3LimitImageLongEdgeV15", "NanFengH3RTXVideoSuperResolutionV15", "NanFengH3ReleaseAtStartV15", "NanFengH3ReleaseBeforeConditionLoadersV15", "NanFengH3ReleaseBeforeSamplingV15", "NanFengH3TimedAudioVAEDecodeV15", "NanFengH3TimedVideoVAEDecodeV15", "NanFengV15DLSSOutput", "RandomNoise", "SamplerCustomAdvanced", "UNETLoader", "VAELoader", "VHS_VideoCombine"],
    },
};

const build = (references: string[], audios: string[] | undefined, extra: Record<string, unknown>) =>
    buildExpandedNanFengV10Workflow({ prompt: "@图片1", references, audios }, { ...base, ...extra }, upload, "http://comfy.local", new AbortController().signal);

const classes = (graph: Record<string, any>) => [...new Set(Object.values(graph).map((node: any) => node.class_type))].sort();
const only = (graph: Record<string, any>, classType: string) => Object.values(graph).filter((node: any) => node.class_type === classType);

test("展开流在每个模式下与原生 V15 子图的节点构成逐个对齐", async () => {
    for (const [tag, scenario] of Object.entries(scenarios)) {
        const graph = await build(scenario.references, scenario.audios, scenario.extra || {});
        assert.deepEqual(classes(graph), scenario.expected, `${tag} 的节点构成必须与原生 V15 子图一致`);
    }
});

test("名字屏障经 AnyType 透传接到 Loader 上：STRING 直连 COMBO 会被 ComfyUI 判 return_type_mismatch", async () => {
    const graph = await build(["probe_ref.png"], undefined, {});
    assert.deepEqual(graph.nf_start.inputs.unet_name, base.modelName);
    assert.deepEqual(graph.nf_condition_loaders.inputs.clip_name, ["nf_start", 1]);
    assert.deepEqual(graph.nf_condition_loaders.inputs.video_vae_name, ["nf_start", 2]);
    assert.deepEqual(graph.nf_condition_loaders.inputs.audio_vae_name, ["nf_start", 3]);
    assert.deepEqual(graph.nf_condition_loaders.inputs.keep_loader_cache, false);
    // 名字是 STRING，而 unet_name/clip_name/vae_name 都是 COMBO。静态图必须经过 AnyType 透传：
    // signal 保住「先释放显存再加载」的依赖，value 把名字送进 Loader。
    const gates: Array<[string, string, string, [string, number]]> = [
        ["nf_gate_unet", "nf_model", "unet_name", ["nf_start", 0]],
        ["nf_gate_clip", "nf_clip", "clip_name", ["nf_condition_loaders", 0]],
        ["nf_gate_video_vae", "nf_video_vae", "vae_name", ["nf_condition_loaders", 1]],
        ["nf_gate_audio_vae", "nf_audio_vae", "vae_name", ["nf_condition_loaders", 2]],
    ];
    for (const [gateId, loaderId, loaderKey, source] of gates) {
        assert.equal(graph[gateId].class_type, "ImpactExecutionOrderController", `${gateId} 必须是 AnyType 透传节点`);
        assert.deepEqual(graph[gateId].inputs.signal, source, `${gateId}.signal 必须仍是屏障的名字输出`);
        assert.deepEqual(graph[gateId].inputs.value, source, `${gateId}.value 必须仍是屏障的名字输出`);
        assert.deepEqual(graph[loaderId].inputs[loaderKey], [gateId, 1], `${loaderId}.${loaderKey} 必须取透传节点的 value 口`);
    }
});

test("TRT 视频 VAE 取代普通 VAELoader，缺引擎时明确拒绝而不是静默回退", async () => {
    const graph = await build(["probe_ref.png"], undefined, { trtVideoVaeEnabled: true, trtDecoderEngine: "decoder.engine", trtEncoderEngine: "encoder.engine" });
    assert.equal(graph.nf_video_vae.class_type, "MiniMaxH3TRTVAELoader");
    assert.deepEqual(graph.nf_video_vae.inputs, { decoder: "decoder.engine", encoder: "encoder.engine" });
    assert.deepEqual(graph.nf_audio_vae.inputs.vae_name, ["nf_gate_audio_vae", 1]);
    await assert.rejects(build(["probe_ref.png"], undefined, { trtVideoVaeEnabled: true }), /未选择本机编译的 TRT decoder\/encoder 引擎/);
    await assert.rejects(build(["probe_ref.png"], undefined, { trtVideoVaeEnabled: true, trtDecoderEngine: "decoder.engine", trtEncoderEngine: "None" }), /未选择本机编译的 TRT decoder\/encoder 引擎/);
});

test("南风 ER 采样器用 SamplerER_SDE 取代 KSamplerSelect，其他采样器名保持 KSamplerSelect", async () => {
    const er = await build(["probe_ref.png"], undefined, { sampler: "南风采样器", erSolverType: "ER-SDE", erMaxStage: 3, erEta: 1, erSNoise: 1 });
    assert.equal(er.nf_sampler.class_type, "SamplerER_SDE");
    assert.deepEqual(er.nf_sampler.inputs, { solver_type: "ER-SDE", max_stage: 3, eta: 1, s_noise: 1 });
    const plain = await build(["probe_ref.png"], undefined, { sampler: "res_multistep" });
    assert.equal(plain.nf_sampler.class_type, "KSamplerSelect");
    assert.deepEqual(plain.nf_sampler.inputs, { sampler_name: "res_multistep" });
});

test("潜空间续写用原生同一套目录算法与裁尾链路，节点身份由 backend 自己承担", async () => {
    const graph = await build(["probe_ref.png"], undefined, { motionContextEnabled: true, continuationTask: CONTINUATION, continuationAudioRefineEnabled: true, continuationSeamNoiseEnabled: true, continuationSeamNoise: 0.053, continuationSeamNoiseRamp: 3, contextLength: "22", audioContextLength: 24 });
    // 期望目录来自南风 pack 自己的 json.dumps([...], ensure_ascii=False) + sha256；
    // 两边算不出一致目录，跨路径续写就会各自找不到上下文。
    const folder = "nanfeng_v15_context/e243788773537a9778639f063538aa470ce39c39d1ab7b58cb047db964f4bf7d";
    assert.equal(graph.nf_continuation_load.inputs.latent_path, folder);
    assert.equal(graph.nf_continuation_load.inputs.clip_index, 1);
    assert.equal(graph.nf_continuation.inputs.context_length, "22");
    assert.equal(graph.nf_continuation.inputs.noise_mode, "block");
    assert.equal(graph.nf_continuation.inputs.noise_std, 0.053);
    assert.equal(graph.nf_continuation.inputs.noise_ramp, 3);
    assert.equal(graph.nf_continuation.inputs.audio_context_length, 24);
    assert.deepEqual(graph.nf_continuation.inputs.latent, [graph.nf_continuation.inputs.conditioning[0], 1]);
    assert.deepEqual(graph.nf_continuation.inputs.vae, ["nf_video_vae", 0]);
    assert.deepEqual(graph.nf_continuation.inputs.context_latent, ["nf_continuation_load", 0]);
    // 精修必须吃未打 LoRA 的基础模型和采样前释放出来的条件张量。
    assert.deepEqual(graph.nf_continuation_audio_refine.inputs.model, ["nf_model", 0]);
    assert.deepEqual(graph.nf_continuation_audio_refine.inputs.trim_frames, ["nf_continuation", 1]);
    assert.equal(graph.nf_continuation_audio_refine.inputs.audio_denoise, 0.3);
    const commit = only(graph, "NanFengV15CommitContinuation")[0] as any;
    assert.equal(commit.inputs.folder, folder);
    assert.equal(commit.inputs.clip_index, 2);
    // 开启续写音频精修后，落盘的 AV latent 来自精修节点而不是一采本身。
    assert.deepEqual(commit.inputs.latent, ["nf_continuation_audio_refine", 0]);
    assert.deepEqual(commit.inputs.images, ["nf_continuation_trim", 0]);
    assert.deepEqual(commit.inputs.audio, ["nf_continuation_trim", 1]);
    // DLSS 输出链是唯一的落盘出口，裁尾/落盘结果必须经它再进 VHS。
    assert.deepEqual(graph.nf_post.inputs.images, ["nf_continuation_commit", 0]);
    assert.deepEqual(graph.nf_post.inputs.audio, ["nf_continuation_commit", 1]);
    assert.deepEqual(graph.nf_output.inputs.images, ["nf_post", 0]);
    assert.deepEqual(graph.nf_output.inputs.audio, ["nf_post", 1]);
});

test("续写与锁音频、音频驱动、潜空间放大二采互斥，且必须有合法任务描述符", async () => {
    await assert.rejects(build(["probe_ref.png"], ["probe_lock.wav"], { motionContextEnabled: true, continuationTask: CONTINUATION, lockAudio: true }), /不与锁音频\/音频驱动混用/);
    await assert.rejects(build(["probe_ref.png"], undefined, { motionContextEnabled: true, continuationTask: CONTINUATION, latentUpscaleEnabled: true, h3FullSigma: SIGMA, h3FirstSteps: 6, h3SecondSteps: 4 }), /请关闭潜空间放大二采/);
    await assert.rejects(build(["probe_ref.png"], undefined, { motionContextEnabled: true }), /缺少有效的工作流\/节点\/连续组\/本次运行编号/);
    await assert.rejects(build(["probe_ref.png"], undefined, { motionContextEnabled: true, continuationTask: JSON.stringify({ workflow: "wf", node: "other", group: "g", run: "r0", index: 2 }) }), /缺少有效的工作流\/节点\/连续组\/本次运行编号/);
});

test("DLSS 输出链是 IMAGE/AUDIO 的出口，关闭时原样透传", async () => {
    const graph = await build(["probe_ref.png"], undefined, { dlssUpscaleMode: "1.5× (Quality)", dlssFrameInterpolationEnabled: true, dlssFgOutputFps: "120" });
    assert.deepEqual(graph.nf_output.inputs.images, ["nf_post", 0]);
    assert.deepEqual(graph.nf_output.inputs.audio, ["nf_post", 1]);
    assert.deepEqual(graph.nf_post.inputs.images, ["nf_image_decode", 0]);
    assert.equal(graph.nf_post.inputs["DLSS超分模式"], "1.5× (Quality)");
    assert.equal(graph.nf_post.inputs["启用DLSS补帧"], true);
    assert.equal(graph.nf_post.inputs.DLSS_fg_output_fps, "120");
    // 关闭时只是透传，仍然是同一条链路。
    const off = await build(["probe_ref.png"], undefined, {});
    assert.equal(off.nf_post.inputs["DLSS超分模式"], "关闭");
    assert.equal(off.nf_post.inputs["启用DLSS补帧"], false);
});

test("锁音频用 V15 原生锁节点，音频驱动时以专属音频替代参考音频并补齐时长", async () => {
    const graph = await build(["probe_ref.png"], ["drive.wav"], { lockAudio: true, audioDrive: true, audioDriveFile: "drive.wav", audioDriveStart: 12 });
    const lock = only(graph, "MiniMaxH3NativeAudioLockV15")[0] as any;
    assert.deepEqual(lock.inputs.model, ["nf_h3_attention", 0]);
    assert.deepEqual(lock.inputs.audio_vae, ["nf_audio_vae", 0]);
    assert.deepEqual(lock.inputs.audio, ["nf_lock_audio_pad", 0]);
    assert.equal(graph.nf_audio_decode, undefined);
    assert.deepEqual(graph.nf_audio_trim_0.inputs.start_index, 12);
    // 音频驱动下索引为 0 时仍必须是可见的音频1，而不是被 pad 覆盖成空。
    assert.equal(only(graph, "MiniMaxH3ReferenceToVideo").length, 1);
});

test("@引用别名按原生规则编号，音频序号在视频音轨与音频之间连续递增", async () => {
    const graph = await build(["probe_ref.png"], undefined, {});
    const prompt = graph.nf_ref_condition.inputs.prompt as string;
    assert.equal(prompt.includes("<Picture 1>"), true);
    assert.equal(prompt.includes("@图片1"), false);
    const mixed = await buildExpandedNanFengV10Workflow(
        { prompt: "@图片1 和 @视频音频1 和 @音频1 和 @视频1", references: ["a.png"], videos: ["v.mp4"], audios: ["b.wav"] },
        { ...base }, upload, "http://comfy.local", new AbortController().signal,
    );
    const text = mixed.nf_ref_condition.inputs.prompt as string;
    assert.equal(text.includes("<Video 1>"), true);
    // 视频音轨占 Audio 1，音频参考接着排 Audio 2 —— 与原生 build_native_prompt 的连续编号一致。
    assert.equal(text.includes("<Audio 1>"), true);
    assert.equal(text.includes("<Audio 2>"), true);
    assert.equal(text.includes("<Audio 3>"), false);
    await assert.rejects(buildExpandedNanFengV10Workflow({ prompt: "@图片3", references: ["a.png"] }, { ...base }, upload, "http://comfy.local", new AbortController().signal), /没有对应素材/);
});

/**
 * 「潜空间一采确认」的展开流切分必须与 pack 自己的 split_confirmation() 同构。
 * 期望值同样是从原生展开图跑 pack 的 split_confirmation() 抄下来的（22 / 18 节点），
 * 排除展开流自己特有的节点后逐类对齐。
 * 唯一已知差异：sigma 来源。原生二采分支默认用 BasicScheduler（steps 驱动），
 * 而画布一律显式传 h3FullSigma，展开流走 ManualSigmas —— 这条差异在切换展开流之前就存在
 * （manualSigma 一直登记在 H3_MERGED_ONLY_DEFAULTS 里），不是这次切分引入的。
 */
const CONFIRMATION_EXTRA = ["VHS_VideoCombine", "ImpactExecutionOrderController"];
const NATIVE_CONFIRMATION_FIRST = ["BasicGuider", "BasicScheduler", "CLIPLoader", "InfiniteCanvasH3SaveCheckpoint", "KSamplerSelect", "LoadImage", "MiniMaxH3MemoryEfficientSageAttentionPatch", "MiniMaxH3ReferenceToVideo", "NanFengH3KJPreviewBridgeV15", "NanFengH3LimitImageLongEdgeV15", "NanFengH3ReleaseAtStartV15", "NanFengH3ReleaseBeforeConditionLoadersV15", "NanFengH3ReleaseBeforeSamplingV15", "NanFengH3TimedAudioVAEDecodeV15", "NanFengH3TimedVideoVAEDecodeV15", "NanFengV15DLSSOutput", "RandomNoise", "SamplerCustomAdvanced", "SplitSigmas", "UNETLoader", "VAELoader"];
const NATIVE_CONFIRMATION_SECOND = ["BasicGuider", "InfiniteCanvasH3LoadCheckpoint", "KSamplerSelect", "MiniMaxH3MemoryEfficientSageAttentionPatch", "NanFengH3ClearUpscalerCacheResidentV15", "NanFengH3KJPreviewBridgeV15", "NanFengH3LowPeakLatentUpscalerV15", "NanFengH3ReleaseAtStartV15", "NanFengH3ReleaseBeforeConditionLoadersV15", "NanFengH3ReleaseBeforeSamplingV15", "NanFengH3TimedAudioVAEDecodeV15", "NanFengH3TimedVideoVAEDecodeV15", "NanFengV15DLSSOutput", "RandomNoise", "SamplerCustomAdvanced", "UNETLoader", "VAELoader"];

const CONFIRMATION_PARAMS = { latentUpscaleEnabled: true, h3FullSigma: SIGMA, h3FirstSteps: 6, h3SecondSteps: 4 };
const checkpointClasses = (graph: Record<string, any>) =>
    [...new Set(Object.values(graph).map((node: any) => node.class_type).filter((type: string) => !CONFIRMATION_EXTRA.includes(type)))].sort();

test("一采确认阶段与原生切分同构：放大器与二采都被裁掉，只剩落盘快照", async () => {
    const graph = splitH3Confirmation(await build(["probe_ref.png"], undefined, CONFIRMATION_PARAMS), "first", "c".repeat(64), false);
    assert.deepEqual(checkpointClasses(graph), NATIVE_CONFIRMATION_FIRST.map(type => type === "BasicScheduler" ? "ManualSigmas" : type).sort());
    assert.equal(graph.nf_latent_upscale, undefined);
    assert.equal(graph.nf_sample_second, undefined);
    assert.equal(graph.nf_latent_upscale_clear, undefined);
    assert.equal(Object.values(graph).filter((node: any) => node.class_type === "SamplerCustomAdvanced").length, 1);
});

test("二采确认阶段与原生切分完全同构：一采采样与 guider 都被裁掉，快照当输入", async () => {
    const graph = splitH3Confirmation(await build(["probe_ref.png"], undefined, CONFIRMATION_PARAMS), "second", "c".repeat(64), false);
    assert.deepEqual(checkpointClasses(graph), NATIVE_CONFIRMATION_SECOND);
    assert.equal(graph.nf_sample_first, undefined);
    assert.equal(graph.nf_guider, undefined);
    assert.equal(graph.nf_sigma_split, undefined, "二采的剩余 sigma 来自快照，不再需要切分节点");
    assert.equal(graph.nf_sigmas_manual, undefined);
});

test("确认阶段只认结构性锚点，锚点被改动时必须明确报错而不是切错", async () => {
    const broken = await build(["probe_ref.png"], undefined, CONFIRMATION_PARAMS);
    delete broken.nf_latent_upscale;
    assert.throws(() => splitH3Confirmation(broken, "first", "c".repeat(64), false), /找不到唯一的确认边界/);
    const noGuider = await build(["probe_ref.png"], undefined, CONFIRMATION_PARAMS);
    noGuider.nf_guider.inputs.conditioning = ["nf_condition_loaders", 0];
    assert.throws(() => splitH3Confirmation(noGuider, "second", "c".repeat(64), false), /采样前释放边界已变化/);
});
