import assert from "node:assert/strict";
import test from "node:test";

import { attachH3ActualSubmission, buildNativeNanFengV10Workflow, exactHistoryEntry, summarizeH3Workflow } from "./bridge.js";

const promptA = "5ef69623-4030-4f1b-a00b-09e7355303e4";
const promptB = "3d11bbd6-3b53-49c5-8514-d3fce9981704";
const upload = async (file: string) => `uploaded-${file}`;

test("history recovery never substitutes another prompt's output", () => {
    const history = {
        [promptB]: { outputs: { output: { videos: [{ filename: "AnimateDiff_00044-audio.mp4" }] } }, status: { status_str: "success" } },
    };
    assert.equal(exactHistoryEntry(history, promptA), undefined);
    assert.equal(exactHistoryEntry(history, promptB), history[promptB]);
});

test("H3 audit summary reads the submitted API graph instead of raw UI fields", async () => {
    const graph = await buildNativeNanFengV10Workflow(
        { prompt: "@图片1 起舞", references: ["reference.png"] },
        {
            mode: "ref2va", duration: 6, aspectRatio: "16:9", megapixels: 0.5, sizeMultiple: 32,
            seed: 272289703718811, realtimePreviewEnabled: false, sageAttention: "H3专用Sage加速",
            loraSlots: [{ name: "minimax/turbo.safetensors", strength: 1, enabled: true }, { name: "minimax/cinematic.safetensors", strength: 0.7, enabled: true }],
            v81ManualSigma: true, h3FullSigma: "1.0, 0.8, 0.5, 0.0", steps: 20,
        }, upload, "http://comfy.local", new AbortController().signal,
    );
    assert.equal(graph.nf_v10.class_type, "NanFengH3MultiReferenceGeneratorV10");
    assert.equal(graph.nf_v10.inputs["图片1"], "uploaded-reference.png");
    assert.equal(graph.nf_v10.inputs.SageAttention, "auto");
    assert.equal(graph.nf_v10.inputs["H3专用注意力"], "H3专用Sage加速");
    const summary = summarizeH3Workflow(graph, promptA);
    assert.deepEqual(summary, {
        promptId: promptA, seed: 272289703718811, frames: 141, width: 960, height: 544,
        loras: [{ name: "minimax/turbo.safetensors", strength: 1 }, { name: "minimax/cinematic.safetensors", strength: 0.7 }],
        attention: "auto", sigma: "手动：1.0, 0.8, 0.5, 0.0",
    });
    assert.deepEqual(attachH3ActualSubmission({ promptId: promptA, media: [] }, summary, promptA).actualSubmission, summary);
});

test("H3 audit reports scheduler Sigma and 192-frame graph values", async () => {
    const graph = await buildNativeNanFengV10Workflow(
        { prompt: "@图片1", references: ["reference.png"] },
        { mode: "ref2va", duration: 8, aspectRatio: "16:9", megapixels: 0.5, sizeMultiple: 32, seed: 792393709737869, realtimePreviewEnabled: false, sageAttention: "关闭", scheduler: "simple", steps: 20 },
        upload, "http://comfy.local", new AbortController().signal,
    );
    const summary = summarizeH3Workflow(graph, promptB);
    assert.equal(summary.frames, 192);
    assert.equal(summary.seed, 792393709737869);
    assert.equal(summary.attention, "disabled");
    assert.equal(summary.sigma, "调度器：simple / 20 步");
});
