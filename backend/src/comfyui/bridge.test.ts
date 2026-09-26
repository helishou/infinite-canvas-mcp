import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";

import { ComfyUiBackend, attachH3ActualSubmission, buildNativeNanFengV15Workflow, exactHistoryEntry, h3WatchdogState, localComfyInputName, summarizeH3Workflow, type ComfyUiDeps } from "./bridge.js";
import { MEDIA_DIR } from "../config.js";

const promptA = "5ef69623-4030-4f1b-a00b-09e7355303e4";
const promptB = "3d11bbd6-3b53-49c5-8514-d3fce9981704";
const upload = async (file: string) => `uploaded-${file}`;

test("H3 model catalog includes LoRAs outside the Minimax folder", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
        const node = String(input).split("/").at(-1)!;
        const required = node === "LoraLoader" ? { lora_name: [["Minimax/turbo.safetensors", "custom/style.safetensors"]] }
            : node === "LoraLoaderModelOnly" ? { lora_name: [["custom/style.safetensors", "motion.safetensors"]] }
                : node === "NanFengH3MultiReferenceGeneratorV15" ? { LoRA1: [["custom/style.safetensors"]] } : {};
        return new Response(JSON.stringify({ [node]: { input: { required } } }), { status: 200 });
    };
    try {
        const bridge = new ComfyUiBackend({ settings: { get: () => "" } } as unknown as ComfyUiDeps, "http://comfy.test");
        const catalog = await bridge.models();
        assert.deepEqual(catalog.loras, ["custom/style.safetensors", "Minimax/turbo.safetensors", "motion.safetensors"]);
    } finally {
        globalThis.fetch = originalFetch;
    }
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

test("H3 audit summary reads the submitted API graph instead of raw UI fields", async () => {
    const graph = await buildNativeNanFengV15Workflow(
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

test("H3 audit reports scheduler Sigma and 192-frame graph values", async () => {
    const graph = await buildNativeNanFengV15Workflow(
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

test("H3 random seed and legacy LoRA aliases become the values submitted to V15", async () => {
    const graph = await buildNativeNanFengV15Workflow(
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

test("H3 TE acceleration uses a graph that contains the visible TE patcher", async () => {
    const graph = await buildNativeNanFengV15Workflow(
        { prompt: "@图片1", references: ["reference.png"] },
        { mode: "ref2va", teAccel: true, seed: 123, realtimePreviewEnabled: false },
        upload, "http://comfy.local", new AbortController().signal,
    );
    assert.equal(graph.nf_v15, undefined);
    assert.equal(Object.values(graph).some((node: any) => node.class_type === "TESpeedMiniMaxH3"), true);
});

test("H3 V15 native workflow does not submit removed model-cache input", async () => {
    const graph = await buildNativeNanFengV15Workflow(
        { prompt: "@图片1", references: ["reference.png"] },
        { mode: "ref2va", keepModelCache: true },
        upload, "http://comfy.local", new AbortController().signal,
    );
    assert.equal(Object.prototype.hasOwnProperty.call(graph.nf_v15.inputs, "连续生成模式"), false);
    assert.equal(graph.face_refine, undefined);
    assert.deepEqual(graph.nf_output.inputs.images, ["nf_v15", 0]);
    assert.deepEqual(graph.nf_output.inputs.audio, ["nf_v15", 1]);
});

test("opt-in H3 face refine runs after V15 and preserves generated audio", async () => {
    const graph = await buildNativeNanFengV15Workflow(
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

test("seam transition wires previous picture/audio into face refine", async () => {
    const graph = await buildNativeNanFengV15Workflow(
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

test("decoded-video confirmation phase reads cached video and never contains V15 generation", async () => {
    const graph = await buildNativeNanFengV15Workflow(
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

test("decoded-video confirmation uses the packaged full-frame refiner when face refinement is off", async () => {
    const graph = await buildNativeNanFengV15Workflow(
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
