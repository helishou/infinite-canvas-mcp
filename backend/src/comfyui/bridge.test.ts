import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import test, { type TestContext } from "node:test";
import path from "node:path";

import { ComfyUiBackend, attachH3ActualSubmission, buildNativeNanFengV15Workflow as buildH3Entry, exactHistoryEntry, h3WatchdogState, localComfyInputName, summarizeH3Workflow, type ComfyUiDeps } from "./bridge.js";
import { appendTailFramePrompt, routeTailFrameInput } from "../canvas/h3-runner.js";
import { MEDIA_DIR } from "../config.js";

const promptA = "5ef69623-4030-4f1b-a00b-09e7355303e4";
const promptB = "3d11bbd6-3b53-49c5-8514-d3fce9981704";
const upload = async (file: string) => `uploaded-${file}`;

/**
 * H3 提交入口默认走展开流（把南风 V15 内部子图摊成真实节点）。
 * 下面这些用例断言的是**合并流**（后路：单个 NanFengH3MultiReferenceGeneratorV15 节点）
 * 提交的输入，所以统一在这里显式选后路；要测默认的展开流就直接用 buildH3Entry。
 */
const buildMergedNanFengV15Workflow = (
    input: Record<string, unknown>, params: Record<string, unknown>,
    uploader: (file: string) => Promise<string>, comfyUrl: string, signal: AbortSignal,
) => buildH3Entry(input, { mergedWorkflow: true, ...params }, uploader, comfyUrl, signal);

function mockObjectInfo(t: TestContext, nodes = ["NanFengH3MultiReferenceGeneratorV15"], baseUrl = "http://comfy.local", response: (node: string) => unknown = () => ({})) {
    const expected = nodes.map(node => ({ url: `${baseUrl}/object_info/${node}`, method: "GET", body: null }));
    const requests: Array<{ url: string; method: string; body: unknown }> = [];
    t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
        const request = { url: input instanceof Request ? input.url : String(input),
            method: init?.method || (input instanceof Request ? input.method : "GET"),
            body: init?.body ?? (input instanceof Request ? input.body : null) };
        requests.push(request);
        assert.deepEqual(request, expected[requests.length - 1], "only the declared inert discovery request is allowed");
        return Response.json(response(nodes[requests.length - 1]));
    });
    // Optional discovery catches failures, so verify outside the builder as well.
    t.after(() => assert.deepEqual(requests, expected, "all discovery requests must match the fixture; none may reach the network"));
}

test("latent confirmation selects the native checkpoint wrapper and refuses missing support before sampling", async t => {
    let checkpointInstalled = true;
    const discovery = ["NanFengH3MultiReferenceGeneratorV15", "H3LatentUpscalerNodeMegapixels", "NanFengH3LowPeakLatentUpscalerV15"];
    const confirmation = [...discovery, "InfiniteCanvasH3ConfirmedGeneratorV15"];
    mockObjectInfo(t, [...confirmation, ...confirmation, ...discovery, ...confirmation], "http://comfy.test", name => {
        if (name === "InfiniteCanvasH3ConfirmedGeneratorV15") return checkpointInstalled ? { [name]: { input: {} } } : {};
        if (name === "H3LatentUpscalerNodeMegapixels") return { [name]: { input: {} } };
        if (name === "NanFengH3LowPeakLatentUpscalerV15") return { [name]: { input: { required: { model_name: [["upscaler.safetensors"]] } } } };
        return {};
    });
    const params = { mode: "t2v", latentUpscaleEnabled: true, latentUpscaleModel: "upscaler.safetensors", latentCheckpointId: "a".repeat(64), h3FirstSteps: 6, h3SecondSteps: 4, teAccel: true };
    for (const phase of ["first", "second"]) {
        const graph = await buildMergedNanFengV15Workflow({ prompt: "a shot" }, { ...params, latentConfirmationPhase: phase }, upload, "http://comfy.test", new AbortController().signal);
        assert.equal(graph.nf_v15.class_type, "InfiniteCanvasH3ConfirmedGeneratorV15");
        assert.equal(graph.nf_v15.inputs.checkpoint_phase, phase);
        assert.equal(graph.nf_v15.inputs.checkpoint_id, params.latentCheckpointId);
        assert.equal(graph.nf_v15.inputs.checkpoint_te_accel, true);
        assert.equal(graph.nf_v15.inputs["启用H3潜空间放大二采"], true);
        assert.equal(graph.cached_first_pass, undefined);
        const summary = summarizeH3Workflow(graph, promptA);
        assert.equal(summary.steps, phase === "first" ? 6 : 4);
        assert.ok(Number.isFinite(summary.seed));
    }
    const automatic = await buildMergedNanFengV15Workflow({ prompt: "a shot" }, { ...params, teAccel: false }, upload, "http://comfy.test", new AbortController().signal);
    assert.equal(automatic.nf_v15.class_type, "NanFengH3MultiReferenceGeneratorV15");
    assert.equal(automatic.nf_v15.inputs.checkpoint_phase, undefined);
    checkpointInstalled = false;
    await assert.rejects(buildMergedNanFengV15Workflow({ prompt: "a shot" }, { ...params, latentConfirmationPhase: "first" }, upload, "http://comfy.test", new AbortController().signal), /未提交一采任务/);
});

test("H3 model catalog includes LoRAs outside the Minimax folder", async t => {
    mockObjectInfo(t, ["UNETLoader", "LoraLoader", "LoraLoaderModelOnly", "NanFengH3MultiReferenceGeneratorV15", "CLIPLoader", "VAELoader", "VAELoader", "NanFengH3LowPeakLatentUpscalerV15", "NanFengH3MultiReferenceGeneratorV15"], "http://comfy.test", node => {
        const required = node === "LoraLoader" ? { lora_name: [["Minimax/turbo.safetensors", "custom/style.safetensors"]] }
            : node === "LoraLoaderModelOnly" ? { lora_name: [["custom/style.safetensors", "motion.safetensors"]] }
                : node === "NanFengH3MultiReferenceGeneratorV15" ? { LoRA1: [["custom/style.safetensors"]] } : {};
        return { [node]: { input: { required } } };
    });
    const bridge = new ComfyUiBackend({ settings: { get: () => "" } } as unknown as ComfyUiDeps, "http://comfy.test");
    const catalog = await bridge.models();
    assert.deepEqual(catalog.loras, ["custom/style.safetensors", "Minimax/turbo.safetensors", "motion.safetensors"]);
});

test("H3 watchdog identifies a stagnant low-progress task and can be disabled", () => {
    assert.deepEqual(h3WatchdogState(100_000, 0, 90_000, 0.05), { stalled: true, stagnantForMs: 100_000, progress: 0.05 });
    assert.equal(h3WatchdogState(80_000, 0, 90_000, 0.05).stalled, false);
    assert.equal(h3WatchdogState(100_000, 0, 0, 0.05).stalled, false);
});

test("history recovery never substitutes another prompt's output", () => {
    const history = {
        [promptB]: { outputs: { output: { videos: [{ filename: "AnimateDiff_00044-audio.mp4" }] } }, status: { status_str: "success" } },
    };
    assert.equal(exactHistoryEntry(history, promptA), undefined);
    assert.equal(exactHistoryEntry(history, promptB), history[promptB]);
});

test("H3 local input only exposes files from runtime-media", () => {
    assert.match(localComfyInputName(path.join(MEDIA_DIR, "input", "ref.png")), /^infinite-canvas-cache\/input\/ref\.png$/);
    assert.throws(() => localComfyInputName(path.join(path.dirname(MEDIA_DIR), "ref.png")), /运行媒体/);
});

test("H3 audit summary reads the submitted API graph instead of raw UI fields", async t => {
    mockObjectInfo(t);
    const graph = await buildMergedNanFengV15Workflow(
        { prompt: "@图片1 起舞", references: ["reference.png"] },
        {
            mode: "ref2va", duration: 6, aspectRatio: "16:9", megapixels: 0.5, sizeMultiple: 32,
            seed: 272289703718811, realtimePreviewEnabled: false, sageAttention: "H3专用Sage加速",
            motionContextEnabled: true, continuationTask: "{\"group\":\"test\",\"index\":1}", dlssVideoOutputDetailStrength: 1.5,
            loraSlots: [{ name: "minimax/turbo.safetensors", strength: 1, enabled: true }, { name: "minimax/cinematic.safetensors", strength: 0.7, enabled: true }],
            v81ManualSigma: true, h3FullSigma: "1.0, 0.8, 0.5, 0.0", steps: 20,
        }, upload, "http://comfy.local", new AbortController().signal,
    );
    assert.equal(graph.nf_v15.class_type, "NanFengH3MultiReferenceGeneratorV15");
    assert.equal(graph.nf_v15.inputs["图片1"], "uploaded-reference.png");
    assert.equal(graph.nf_v15.inputs["启用潜空间续写"], true);
    assert.equal(graph.nf_v15.inputs["潜空间续写任务"], "{\"group\":\"test\",\"index\":1}");
    assert.equal(graph.nf_v15.inputs.DLSS_video_output_detail_strength, 1.5);
    assert.equal(graph.nf_v15.inputs.SageAttention, "auto");
    assert.equal(graph.nf_v15.inputs["H3专用注意力"], "H3专用Sage加速");
    const summary = summarizeH3Workflow(graph, promptA);
    assert.deepEqual(summary, {
        promptId: promptA, seed: 272289703718811, seedMode: "fixed", frames: 141, width: 960, height: 544,
        steps: 3, sampler: "res_multistep", scheduler: "simple",
        loras: [{ name: "minimax/turbo.safetensors", strength: 1 }, { name: "minimax/cinematic.safetensors", strength: 0.7 }],
        attention: "H3专用Sage加速", sigma: "手动：1.0, 0.8, 0.5, 0.0",
        // 审计必须把真正落到图片/视频/音频槽位的媒体记下来，否则「上一段成品被当成视频1 塞进来」
        // 这类隐式注入在日志里完全不可见（正是这次修复要防的盲点）。
        mediaInputs: { images: ["uploaded-reference.png"], videos: [], audios: [] },
    });
    assert.deepEqual(attachH3ActualSubmission({ promptId: promptA, media: [] }, summary, promptA).actualSubmission, summary);
});

test("尾帧参考进入V15额外图片槽，保留原首尾帧并以多参考执行", async t => {
    mockObjectInfo(t);
    const routed = routeTailFrameInput("fl2v", ["saved-first.png", "saved-last.png"], [{ id: "first" }, { id: "last" }], { resolved: "captured-tail.png" });
    const graph = await buildMergedNanFengV15Workflow(
        { prompt: "<Picture 1> opening; <Picture 2> closing; <Picture 3> continuity", references: routed.images },
        { mode: routed.taskMode, taskMode: routed.taskMode, seed: 123 }, upload, "http://comfy.local", new AbortController().signal,
    );
    assert.equal(graph.nf_v15.inputs["首尾帧"], false);
    assert.equal(graph.nf_v15.inputs["图片1"], "uploaded-saved-first.png");
    assert.equal(graph.nf_v15.inputs["图片2"], "uploaded-saved-last.png");
    assert.equal(graph.nf_v15.inputs["图片3"], "uploaded-captured-tail.png");
});

test("Ref2VA尾帧参考保留本段分镜图1和Shot1的构图指令", async t => {
    mockObjectInfo(t);
    const routed = routeTailFrameInput("ref2va", ["saved-board.png", "saved-next.png"], [
        { id: "board-1", role: "storyboard", type: "image" }, { id: "board-2", role: "storyboard", type: "image" },
    ], { resolved: "captured-tail.png" });
    const prompt = appendTailFramePrompt("detailed_description:\n[Shot 1] Use the approved old board from <Picture 1> as the target composition reference for this shot. Move.\n[Shot 2] Continue with <Picture 2>.", "Clip 1", routed.tailImageOrdinal);
    const graph = await buildMergedNanFengV15Workflow(
        { prompt, references: routed.images }, { mode: routed.taskMode, taskMode: routed.taskMode, seed: 123 }, upload, "http://comfy.local", new AbortController().signal,
    );
    assert.equal(graph.nf_v15.inputs["图片1"], "uploaded-saved-board.png");
    assert.equal(graph.nf_v15.inputs["图片2"], "uploaded-saved-next.png");
    assert.equal(graph.nf_v15.inputs["图片3"], "uploaded-captured-tail.png");
    assert.match(prompt, /\[Shot 1\] Use the approved old board from <Picture 1>/);
    assert.match(prompt, /Start this segment from the physical state shown in <Picture 3> from Clip 1/);
    assert.deepEqual(summarizeH3Workflow(graph, promptA).mediaInputs?.images, ["uploaded-saved-board.png", "uploaded-saved-next.png", "uploaded-captured-tail.png"]);
});

test("V15 审计尺寸使用真实潜变量对齐规则，能区分 0.8MP 与 0.5MP 续写画布", async t => {
    mockObjectInfo(t, ["NanFengH3MultiReferenceGeneratorV15", "NanFengH3MultiReferenceGeneratorV15"]);
    const summaries = [];
    for (const megapixels of [0.8, 0.5]) {
        const graph = await buildMergedNanFengV15Workflow(
            { prompt: "@图片1", references: ["reference.png"] },
            { mode: "ref2va", aspectRatio: "9:16 (Portrait)", megapixels, sizeMultiple: 32, latentUpscaleAlign: 2, duration: 8 },
            upload, "http://comfy.local", new AbortController().signal,
        );
        summaries.push(summarizeH3Workflow(graph, promptA));
    }
    assert.deepEqual(summaries.map(({ width, height }) => [width, height]), [[672, 1216], [544, 960]]);
});

test("H3 audit reports scheduler Sigma and 192-frame graph values", async t => {
    mockObjectInfo(t);
    const graph = await buildMergedNanFengV15Workflow(
        { prompt: "@图片1", references: ["reference.png"] },
        { mode: "ref2va", duration: 8, aspectRatio: "16:9", megapixels: 0.5, sizeMultiple: 32, seed: 792393709737869, realtimePreviewEnabled: false, sageAttention: "关闭", scheduler: "simple", steps: 20 },
        upload, "http://comfy.local", new AbortController().signal,
    );
    const summary = summarizeH3Workflow(graph, promptB);
    assert.equal(summary.frames, 192);
    assert.equal(summary.seed, 792393709737869);
    assert.equal(summary.seedMode, "fixed");
    assert.equal(summary.steps, 20);
    assert.equal(summary.attention, "disabled");
    assert.equal(summary.sigma, "调度器：simple / 20 步");
    assert.deepEqual(summary.mediaInputs, { images: ["uploaded-reference.png"], videos: [], audios: [] });
});

test("H3 random seed and legacy LoRA aliases become the values submitted to V15", async t => {
    mockObjectInfo(t);
    const graph = await buildMergedNanFengV15Workflow(
        { prompt: "@图片1", references: ["reference.png"] },
        {
            mode: "ref2va", duration: 5, noiseSeedMode: "random", noiseSeed: 0, seed: 0,
            loraSlots: [], loraName: "Minimax\\minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors", loraStrength: 0.75,
            realtimePreviewEnabled: false,
        }, upload, "http://comfy.local", new AbortController().signal,
    );
    const submittedSeed = Number(graph.nf_v15.inputs["随机种子"]);
    assert.ok(submittedSeed > 0);
    assert.equal(graph.nf_v15.inputs["固定随机种子"], false);
    assert.equal(graph.nf_v15.inputs["启用LoRA"], true);
    assert.equal(graph.nf_v15.inputs.LoRA1, "Minimax\\minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors");
    assert.equal(graph.nf_v15.inputs["LoRA1强度"], 0.75);
    assert.equal(graph.nf_v15.inputs["LoRA1启用"], true);
    const summary = summarizeH3Workflow(graph, promptA);
    assert.equal(summary.seed, submittedSeed);
    assert.equal(summary.seedMode, "random");
    assert.deepEqual(summary.loras, [{ name: "Minimax\\minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors", strength: 0.75 }]);
});

test("H3 LoRA 强度 7 原样提交 V15，仅超出新范围时夹紧", async t => {
    mockObjectInfo(t);
    // V15 节点 LoRA 强度上限已扩至 10；7 应保留，超出 -4..10 才夹紧。
    const graph = await buildMergedNanFengV15Workflow(
        { prompt: "@图片1", references: ["reference.png"] },
        {
            mode: "ref2va", seed: 123, realtimePreviewEnabled: false,
            loraSlots: [
                { name: "Minimax\\minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors", strength: 0.75, enabled: true },
                { name: "H3_speed_slider_1.1.safetensors", strength: 7, enabled: true },
                { name: "Minimax\\Bunny_weapon_combatV1.safetensors", strength: -9, enabled: true },
                { name: "Max_guard.safetensors", strength: 12, enabled: true },
            ],
        }, upload, "http://comfy.local", new AbortController().signal,
    );
    assert.equal(graph.nf_v15.inputs["LoRA1强度"], 0.75);
    assert.equal(graph.nf_v15.inputs["LoRA2强度"], 7);
    assert.equal(graph.nf_v15.inputs["LoRA3强度"], -4);
    assert.equal(graph.nf_v15.inputs["LoRA4强度"], 10);
});

test("H3 TE acceleration uses a graph that contains the visible TE patcher", async t => {
    // 展开流里 TE 加速是真的插一个 TESpeedMiniMaxH3 模型节点，所以提交前会先探它的注册状态。
    mockObjectInfo(t, ["NanFengH3MultiReferenceGeneratorV15", "TESpeedMiniMaxH3"], "http://comfy.local",
        name => name === "TESpeedMiniMaxH3" ? { TESpeedMiniMaxH3: { input: { required: {} } } } : {});
    const graph = await buildH3Entry(
        { prompt: "@图片1", references: ["reference.png"] },
        { mode: "ref2va", teAccel: true, seed: 123, realtimePreviewEnabled: false },
        upload, "http://comfy.local", new AbortController().signal,
    );
    assert.equal(graph.nf_v15, undefined);
    assert.equal(Object.values(graph).some((node: any) => node.class_type === "TESpeedMiniMaxH3"), true);
});

test("TE 加速缺少 TESpeedMiniMaxH3 时提交前明确拒绝，而不是让 ComfyUI 回 400", async t => {
    mockObjectInfo(t, ["NanFengH3MultiReferenceGeneratorV15", "TESpeedMiniMaxH3"], "http://comfy.local", () => ({}));
    await assert.rejects(buildH3Entry(
        { prompt: "@图片1", references: ["reference.png"] },
        { mode: "ref2va", teAccel: true, seed: 123 },
        upload, "http://comfy.local", new AbortController().signal,
    ), /未加载 TESpeedMiniMaxH3 节点/);
});

test("H3 默认提交展开流，只有 mergedWorkflow 才回到合并流", async t => {
    mockObjectInfo(t, ["NanFengH3MultiReferenceGeneratorV15", "NanFengH3MultiReferenceGeneratorV15"], "http://comfy.local");
    const input = { prompt: "@图片1", references: ["reference.png"] };
    const expanded = await buildH3Entry(input, { mode: "ref2va", seed: 123 }, upload, "http://comfy.local", new AbortController().signal);
    assert.equal(expanded.nf_v15, undefined, "默认路径不能再有单个南风 V15 主节点");
    assert.equal(expanded.nf_sampling_release.class_type, "NanFengH3ReleaseBeforeSamplingV15");
    assert.deepEqual(expanded.nf_output.inputs.images, ["nf_post", 0]);
    assert.equal(expanded.nf_post.class_type, "NanFengV15DLSSOutput");
    const merged = await buildH3Entry(input, { mode: "ref2va", seed: 123, mergedWorkflow: true }, upload, "http://comfy.local", new AbortController().signal);
    assert.deepEqual(Object.keys(merged).sort(), ["nf_output", "nf_v15"]);
    assert.equal(merged.nf_v15.class_type, "NanFengH3MultiReferenceGeneratorV15");
    assert.deepEqual(merged.nf_output.inputs.images, ["nf_v15", 0]);
});

test("潜空间二采一采确认走展开流：边界切在磁盘快照上，放大器与二采都不执行", async t => {
    const discovery = ["NanFengH3MultiReferenceGeneratorV15", "H3LatentUpscalerNodeMegapixels", "NanFengH3LowPeakLatentUpscalerV15"];
    mockObjectInfo(t, [...discovery, "InfiniteCanvasH3SaveCheckpoint", "InfiniteCanvasH3LoadCheckpoint"], "http://comfy.test", name => {
        if (name === "H3LatentUpscalerNodeMegapixels") return { [name]: { input: {} } };
        if (name === "NanFengH3LowPeakLatentUpscalerV15") return { [name]: { input: { required: { model_name: [["upscaler.safetensors"]] } } } };
        return { [name]: { input: {} } };
    });
    const graph = await buildH3Entry({ prompt: "a shot" }, {
        mode: "t2v", latentUpscaleEnabled: true, latentUpscaleModel: "upscaler.safetensors",
        latentCheckpointId: "a".repeat(64), h3FirstSteps: 6, h3SecondSteps: 4, latentConfirmationPhase: "first",
    }, upload, "http://comfy.test", new AbortController().signal);
    const types = Object.values(graph).map((node: any) => node.class_type);
    assert.equal(types.includes("NanFengH3ConfirmedGeneratorV15"), false, "默认不再用原生包装节点");
    assert.equal(graph.nf_latent_upscale, undefined, "一采阶段不能通向放大器");
    assert.equal(graph.nf_sample_second, undefined, "一采阶段不能跑二采");
    const samplers = Object.entries(graph).filter(([, node]: any) => node.class_type === "SamplerCustomAdvanced");
    assert.deepEqual(samplers.map(([id]) => id), ["nf_sample_first"], "一采阶段只剩一采采样器");
    const [saveId, save] = Object.entries(graph).find(([, node]: any) => node.class_type === "InfiniteCanvasH3SaveCheckpoint")!;
    assert.equal(save.inputs.checkpoint_id, "a".repeat(64));
    assert.deepEqual(save.inputs.latent, ["nf_sample_first", 1], "快照吃一采去噪口");
    assert.deepEqual(save.inputs.conditioning, ["nf_sampling_release", 1], "快照存采样前释放出来的条件张量");
    assert.deepEqual(save.inputs.sigmas, ["nf_sigma_split", 1], "快照存剩余的 sigma");
    assert.deepEqual(graph.nf_image_decode.inputs.samples, [saveId, 0], "解码改读一采快照");
    assert.deepEqual(graph.nf_audio_decode.inputs.samples, [saveId, 0]);
    assert.deepEqual(graph.nf_output.inputs.images, ["nf_post", 0], "落盘出口必须留下");
});

test("潜空间二采二采确认走展开流：只跑二采，一采 latent/条件/剩余 sigma 全部读快照", async t => {
    const discovery = ["NanFengH3MultiReferenceGeneratorV15", "H3LatentUpscalerNodeMegapixels", "NanFengH3LowPeakLatentUpscalerV15"];
    mockObjectInfo(t, [...discovery, "InfiniteCanvasH3SaveCheckpoint", "InfiniteCanvasH3LoadCheckpoint"], "http://comfy.test", name => {
        if (name === "H3LatentUpscalerNodeMegapixels") return { [name]: { input: {} } };
        if (name === "NanFengH3LowPeakLatentUpscalerV15") return { [name]: { input: { required: { model_name: [["upscaler.safetensors"]] } } } };
        return { [name]: { input: {} } };
    });
    const graph = await buildH3Entry({ prompt: "a shot" }, {
        mode: "t2v", latentUpscaleEnabled: true, latentUpscaleModel: "upscaler.safetensors",
        latentCheckpointId: "b".repeat(64), h3FirstSteps: 6, h3SecondSteps: 4, latentConfirmationPhase: "second",
    }, upload, "http://comfy.test", new AbortController().signal);
    const [loadId, load] = Object.entries(graph).find(([, node]: any) => node.class_type === "InfiniteCanvasH3LoadCheckpoint")!;
    const loadInput = load.inputs.checkpoint_id;
    assert.equal(loadInput, "b".repeat(64));
    assert.equal(graph.nf_sample_first, undefined, "二采阶段不能重跑一采采样");
    assert.equal(graph.nf_guider, undefined);
    assert.deepEqual(graph.nf_latent_upscale.inputs.latent, [loadId, 0], "放大器吃快照 latent");
    assert.deepEqual(graph.nf_latent_upscale_clear.inputs.latent, ["nf_latent_upscale", 0]);
    assert.deepEqual(graph.nf_latent_upscale_clear.inputs.conditioning, [loadId, 1]);
    assert.deepEqual(graph.nf_sampling_release.inputs.conditioning, [loadId, 1], "释放节点吃快照条件");
    assert.deepEqual(graph.nf_sampling_release.inputs.latent, [loadId, 0]);
    const samplers = Object.entries(graph).filter(([, node]: any) => node.class_type === "SamplerCustomAdvanced");
    assert.deepEqual(samplers.map(([id]) => id), ["nf_sample_second"], "二采阶段只剩二采采样器");
    assert.deepEqual(samplers[0][1].inputs.latent_image, ["nf_latent_upscale_clear", 0]);
    assert.deepEqual(samplers[0][1].inputs.sigmas, [loadId, 2], "二采吃快照里存的剩余 sigma");
    assert.deepEqual(samplers[0][1].inputs.guider, ["nf_second_guider", 0]);
    assert.deepEqual(graph.nf_second_guider.inputs.conditioning, ["nf_latent_upscale_clear", 1]);
    assert.deepEqual(graph.nf_image_decode.inputs.samples, ["nf_sample_second", 0]);
    assert.deepEqual(graph.nf_output.inputs.images, ["nf_post", 0]);
});

test("显式 mergedWorkflow 时二采确认仍然走原生包装节点", async t => {
    const discovery = ["NanFengH3MultiReferenceGeneratorV15", "H3LatentUpscalerNodeMegapixels", "NanFengH3LowPeakLatentUpscalerV15"];
    mockObjectInfo(t, [...discovery, "InfiniteCanvasH3ConfirmedGeneratorV15"], "http://comfy.test", name => {
        if (name === "H3LatentUpscalerNodeMegapixels") return { [name]: { input: {} } };
        if (name === "NanFengH3LowPeakLatentUpscalerV15") return { [name]: { input: { required: { model_name: [["upscaler.safetensors"]] } } } };
        return { [name]: { input: {} } };
    });
    const graph = await buildMergedNanFengV15Workflow({ prompt: "a shot" }, {
        mode: "t2v", latentUpscaleEnabled: true, latentUpscaleModel: "upscaler.safetensors",
        latentCheckpointId: "a".repeat(64), h3FirstSteps: 6, h3SecondSteps: 4, latentConfirmationPhase: "first",
    }, upload, "http://comfy.test", new AbortController().signal);
    assert.equal(graph.nf_v15.class_type, "InfiniteCanvasH3ConfirmedGeneratorV15");
    assert.equal(graph.nf_v15.inputs.checkpoint_phase, "first");
});

test("展开流尚未承载的开关自动退回合并流，而不是静默丢掉该功能", async t => {
    mockObjectInfo(t, ["NanFengH3MultiReferenceGeneratorV15"], "http://comfy.local");
    const graph = await buildH3Entry(
        { prompt: "@图片1", references: ["reference.png"] },
        { mode: "ref2va", seed: 123, faceRefineEnabled: true },
        upload, "http://comfy.local", new AbortController().signal,
    );
    assert.equal(graph.nf_v15.class_type, "NanFengH3MultiReferenceGeneratorV15");
    assert.equal(graph.face_refine.class_type, "MiniMaxH3PostGenerationFaceRefine");
    assert.deepEqual(graph.nf_output.inputs.images, ["face_refine", 0]);
});

test("H3 native realtime preview submits preview and TAEH3 flags without a model patcher", async t => {
    mockObjectInfo(t);
    const graph = await buildMergedNanFengV15Workflow(
        { prompt: "@图片1", references: ["reference.png"] },
        { mode: "ref2va", seed: 123, targetNodeId: "h3-node-42", taeh3Enabled: true },
        upload, "http://comfy.local", new AbortController().signal,
    );
    assert.equal(graph.nf_v15.inputs["启用实时预览"], true);
    assert.equal(graph.nf_v15.inputs["启用TAEH3彩色预览"], true);
    assert.deepEqual(graph.nf_output.inputs.images, ["nf_v15", 0]);
});

test("H3 expanded preview bridge receives the canvas target node and TAEH3 flag", async t => {
    mockObjectInfo(t);
    // 不带 mergedWorkflow 就是默认路径 = 展开流。
    const graph = await buildH3Entry(
        { prompt: "@图片1", references: ["reference.png"] },
        { mode: "ref2va", seed: 123, targetNodeId: "h3-node-42", taeh3Enabled: true },
        upload, "http://comfy.local", new AbortController().signal,
    );
    const preview = Object.values(graph).find((node: any) => node.class_type === "NanFengH3KJPreviewBridgeV15") as any;
    assert.ok(preview);
    assert.equal(preview.inputs.target_node_id, "h3-node-42");
    assert.equal(preview.inputs.taeh3_enabled, true);
});

test("H3 realtime preview is skipped only when explicitly disabled", async t => {
    mockObjectInfo(t);
    const graph = await buildMergedNanFengV15Workflow(
        { prompt: "@图片1", references: ["reference.png"] },
        { mode: "ref2va", seed: 123, realtimePreviewEnabled: false },
        upload, "http://comfy.local", new AbortController().signal,
    );
    assert.equal(Object.values(graph).some((node: any) => node.class_type === "NanFengH3KJPreviewBridgeV15"), false);
    assert.equal(graph.nf_v15.inputs["启用实时预览"], false);
});

test("H3 V15 native workflow does not submit removed model-cache input", async t => {
    mockObjectInfo(t);
    const graph = await buildMergedNanFengV15Workflow(
        { prompt: "@图片1", references: ["reference.png"] },
        { mode: "ref2va", keepModelCache: true },
        upload, "http://comfy.local", new AbortController().signal,
    );
    assert.equal(Object.prototype.hasOwnProperty.call(graph.nf_v15.inputs, "连续生成模式"), false);
    assert.equal(graph.face_refine, undefined);
    assert.deepEqual(graph.nf_output.inputs.images, ["nf_v15", 0]);
    assert.deepEqual(graph.nf_output.inputs.audio, ["nf_v15", 1]);
});

test("opt-in H3 face refine runs after V15 and preserves generated audio", async t => {
    mockObjectInfo(t);
    const graph = await buildMergedNanFengV15Workflow(
        { prompt: "portrait close-up" },
        {
            mode: "t2v", faceRefineEnabled: true, faceRefineDetector: "face_yolov8m.pt",
            faceRefineConfidence: 0.25, faceRefineCropFactor: 3, faceRefineCanvasSize: 640,
            faceRefineDenoise: 0.35, faceRefineSteps: 6, faceRefineSampler: "euler",
            faceRefineScheduler: "simple", faceRefinePasteRegion: "face_ellipse",
            faceRefineMaskDilation: 12, faceRefineFeather: 20, faceRefineColourMatch: 0.9,
            faceRefineBlend: 0.8, seed: 123,
        },
        upload, "http://comfy.local", new AbortController().signal,
    );
    assert.equal(graph.face_refine.class_type, "MiniMaxH3PostGenerationFaceRefine");
    assert.deepEqual(graph.face_refine.inputs.images, ["nf_v15", 0]);
    assert.deepEqual(graph.face_refine.inputs.audio, ["nf_v15", 1]);
    assert.equal(graph.face_refine.inputs.detector, "face_yolov8m.pt");
    assert.equal(graph.face_refine.inputs.canvas_size, 640);
    assert.equal(graph.face_refine.inputs.paste_region, "face_ellipse");
    assert.deepEqual(graph.nf_output.inputs.images, ["face_refine", 0]);
    assert.deepEqual(graph.nf_output.inputs.audio, ["face_refine", 1]);
});

test("seam transition wires previous picture/audio into face refine", async t => {
    mockObjectInfo(t);
    const graph = await buildMergedNanFengV15Workflow(
        { prompt: "next shot", previousVideo: "previous.mp4" },
        { mode: "t2v", faceRefineEnabled: true, seamFaceFadeFrames: 8, seamColourMatch: 0.7, seamAudioCrossfadeMs: 250 },
        upload, "http://comfy.local", new AbortController().signal,
    );
    assert.equal(graph.face_refine.inputs.seam_fade_frames, 8);
    assert.equal(graph.face_refine.inputs.seam_colour_match, 0.7);
    assert.equal(graph.face_refine.inputs.audio_crossfade_ms, 250);
    assert.deepEqual(graph.face_refine.inputs.previous_images, ["seam_previous_parts", 0]);
    assert.deepEqual(graph.face_refine.inputs.previous_audio, ["seam_previous_parts", 1]);
    assert.equal(graph.seam_previous_video.inputs.file, "uploaded-previous.mp4");
});

test("decoded-video confirmation phase reads cached video and never contains V15 generation", async t => {
    mockObjectInfo(t);
    const graph = await buildMergedNanFengV15Workflow(
        { prompt: "confirmed shot", video: "cached-first-pass.mp4", references: ["character.png", "storyboard.png"] },
        { postGenerationOnly: true, h3SecondSteps: 5, secondPassDenoise: 0.3, latentUpscaleMegapixels: 1.2, faceRefineEnabled: true },
        upload, "http://comfy.local", new AbortController().signal,
    );
    assert.equal(graph.nf_v15, undefined);
    assert.equal(graph.cached_first_pass.class_type, "LoadVideo");
    assert.equal(graph.cached_first_pass.inputs.file, "uploaded-cached-first-pass.mp4");
    assert.equal(graph.full_frame_refine, undefined);
    assert.equal(graph.face_refine.class_type, "InfiniteCanvasH3FaceRefine");
    assert.deepEqual(graph.face_refine.inputs.images, ["cached_parts", 0]);
    assert.deepEqual(graph.face_refine.inputs.audio, ["cached_parts", 1]);
    assert.deepEqual(graph.face_refine.inputs.reference_1, ["face_refine_reference_1", 0]);
    assert.deepEqual(graph.face_refine.inputs.reference_2, ["face_refine_reference_2", 0]);
    assert.equal(graph.face_refine_reference_1.inputs.image, "uploaded-character.png");
    assert.equal(graph.face_refine_reference_2.inputs.image, "uploaded-storyboard.png");
    assert.deepEqual(graph.nf_output.inputs.audio, ["face_refine", 1]);
});

test("decoded-video confirmation uses the packaged full-frame refiner when face refinement is off", async t => {
    mockObjectInfo(t);
    const graph = await buildMergedNanFengV15Workflow(
        { prompt: "confirmed shot", video: "cached-first-pass.mp4" },
        { postGenerationOnly: true, h3SecondSteps: 3, secondPassDenoise: 0.3, latentUpscaleMegapixels: 0.4 },
        upload, "http://comfy.local", new AbortController().signal,
    );
    assert.equal(graph.nf_v15, undefined);
    assert.equal(graph.full_frame_refine.class_type, "MiniMaxH3PostGenerationFullFrameRefine");
    assert.deepEqual(graph.full_frame_refine.inputs.images, ["cached_parts", 0]);
    assert.deepEqual(graph.full_frame_refine.inputs.audio, ["cached_parts", 1]);
    assert.equal(graph.full_frame_refine.inputs.steps, 3);
    assert.equal(graph.full_frame_refine.inputs.target_megapixels, 0.4);
    assert.deepEqual(graph.nf_output.inputs.audio, ["full_frame_refine", 1]);
});

/** 存量任务里的输入路径可能已被清理：必须在复制/上传之前按房内措辞讲清楚，而不是抛 ENOENT。 */
test("H3 input missing from disk fails with the house wording before any copy", async t => {
    const bridge = new ComfyUiBackend({ settings: { get: () => "" } } as unknown as ComfyUiDeps, "http://comfy.test");
    const localH3Input = (bridge as unknown as { localH3Input: (file: string, signal: AbortSignal, url: string) => Promise<string> }).localH3Input.bind(bridge);
    // 实测库里确实存在这类陈旧输入（2026-09 的 H3 任务仍指向早已消失的 previousVideo）。
    const missing = path.join(MEDIA_DIR, "2312e4b6-b782-4c2e-8431-4ae51e8578a5.mp4");
    assert.equal(fs.existsSync(missing), false, "用例前提：该历史输入确实不在盘上");
    await assert.rejects(
        () => localH3Input(missing, new AbortController().signal, "http://comfy.test"),
        (error: Error) => error.message.startsWith("媒体文件丢失：H3 输入") && error.message.includes(missing),
    );

    // 存在的文件不能被这条守卫拦下（后续报错属于 ComfyUI 目录/副本问题，与文件丢失无关）。
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "h3-input-guard-"));
    t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
    const present = path.join(dir, "input.png");
    await fs.promises.writeFile(present, "png");
    await assert.rejects(
        () => localH3Input(present, new AbortController().signal, "http://comfy.test"),
        (error: Error) => { assert.equal(/媒体文件丢失/.test(error.message), false, `存在的文件不得报丢失：${error.message}`); return true; },
    );

    // 非 H3 preset 走的通用 upload() 同样要先讲清楚（同一类陈旧输入）。
    await assert.rejects(
        () => bridge.upload(missing, new AbortController().signal, "http://comfy.test"),
        (error: Error) => error.message.startsWith("媒体文件丢失：ComfyUI 输入") && error.message.includes(missing),
    );
});
