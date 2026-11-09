import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { h3ContinuationFolder, stageH3ContinuationSeed } from "../comfyui/continuation-seed.js";
import { WorkflowExecutor } from "./executor.js";

const LOCAL_URL = "http://127.0.0.1:8188";
const TARGET = { workflow: "project-1", group: "node-1", run: "parent-task-1" };
const SOURCE = { workflow: "project-1", group: "node-1", run: "prev-run" };

/** 裸 H3 AV 流的最小同构图（与 latent-continuation.test 的夹具同构）。 */
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

/** 循环骨架（与 video-continuation.test 同构）补齐悬空输入，使整图能通过提交前校验。 */
function loopH3Graph(): Record<string, any> {
    return {
        ...bareH3Graph(),
        "14": { class_type: "easy forLoopStart", inputs: { total: ["12", 1] } },
        "13": { class_type: "MathExpression|pysssss", inputs: { a: ["14", 1], b: ["11", 0], expression: "a+b" } },
        "11": { class_type: "PrimitiveInt", inputs: { value: 3 } },
        "10": { class_type: "PrimitiveInt", inputs: { value: 0 } },
        "12": { class_type: "ComfyMathExpression", inputs: { "values.a": ["10", 0], "values.b": ["11", 0], expression: "a-b+1" } },
        "705": { class_type: "ComfyMathExpression", inputs: { "values.a": ["14", 1], expression: "a > 0" } },
        "1240": { class_type: "ComfyMathExpression", inputs: { "values.a": ["12", 1], expression: "a > 1" } },
        "48": { class_type: "ComfyMathExpression", inputs: { "values.a": ["6", 0], "values.b": ["14", 1], expression: "22*(b>0)" } },
        "704": { class_type: "ComfyBooleanSwitch", inputs: { switch: ["705", 2], on_true: ["14", 2], on_false: ["9", 0] } },
        "1245": { class_type: "ComfyBooleanSwitch", inputs: { boolean: ["1240", 2] } },
        "6": { class_type: "PrimitiveInt", inputs: { value: 0 } },
        "9": { class_type: "PrimitiveInt", inputs: { value: 0 } },
    };
}

function latent(bytes: string) {
    const data = Buffer.from(bytes);
    const header = Buffer.from(JSON.stringify({
        __metadata__: { format: "h3_motion_context_av_v1" },
        audio: { dtype: "F32", shape: [1, 1], data_offsets: [0, 2] },
        video: { dtype: "F32", shape: [1, 1], data_offsets: [2, data.length] },
    }));
    const length = Buffer.alloc(8);
    length.writeBigUInt64LE(BigInt(header.length));
    return Buffer.concat([length, header, data]);
}

async function seedSource(root: string) {
    const dir = path.join(root, "output", h3ContinuationFolder(SOURCE));
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "clip_00001.safetensors"), latent("previous-clip-av-payload"));
}

function harness(root: string) {
    const taskEvents: Array<{ type: string; payload: any }> = [];
    const logUpdates: Array<{ id: string; patch: any }> = [];
    const tasks = {
        create: (id: string, kind: string, input: any, params: any) => ({ id, kind, input, params, status: "queued", progress: 0 }),
        update: (id: string, patch: any) => { taskEvents.push({ type: "update", payload: patch }); return { id, ...patch }; },
        addEvent: (_id: string, type: string, payload: any) => { taskEvents.push({ type, payload }); },
    };
    const db = {
        listGenerationLogs: () => [{ id: "log-1", params: {} }],
        updateGenerationLog: (id: string, patch: any) => { logUpdates.push({ id, patch }); },
    };
    const bridge = {
        getUrl: () => LOCAL_URL,
        isLocalUrl: (url: string) => url === LOCAL_URL,
        localH3DirectConfig: () => ({ rootDir: root, inputDir: "", cacheDir: "", mediaDir: "", ready: true }),
        stageLocalInput: () => null,
        prepareH3ContinuationSeed: (source: any, target: any, index: number) => stageH3ContinuationSeed(root, source, target, index),
    };
    const executor = new WorkflowExecutor(bridge as never, tasks as never, {} as never, undefined, db as never);
    const prepare = (workflow: Record<string, unknown>, values: Record<string, unknown>, fields: any[] = [], comfyUrl = LOCAL_URL) =>
        (executor as any).prepareRun(workflow, { title: "测试流", fields }, values, "client", comfyUrl, "测试流", "task-1", "project-1", "node-1", "parent-task-1");
    return { executor, prepare, taskEvents, logUpdates };
}

async function withRoot(fn: (root: string) => Promise<void>) {
    const root = await mkdtemp(path.join(os.tmpdir(), "h3-exec-latent-"));
    try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test("仅导出：prepareRun 在克隆图追加 SaveLatent 侧支并把事实写进父生成日志", () => withRoot(async (root) => {
    const h = harness(root);
    const graph = bareH3Graph();
    const snapshot = JSON.stringify(graph);
    const ctx = await h.prepare(graph, { latent_save: true });
    const folder = h3ContinuationFolder(TARGET);
    assert.deepEqual(ctx.prepared.lc_save, {
        class_type: "MiniMaxH3MotionContextSaveLatent",
        inputs: { latent: ["125", 1], filename_prefix: `${folder}/clip`, clip_index: 1 },
    });
    assert.equal(ctx.prepared.lc_load, undefined);
    assert.equal(ctx.prepared["220"].inputs.images[0], "219", "仅导出不改写最终输出");
    assert.equal(JSON.stringify(graph), snapshot, "存储的原工作流图不得改动");
    const fact = h.logUpdates.find((item) => item.patch.params?.latentContinuation);
    assert.ok(fact, "父日志必须记录潜空间续写事实");
    assert.equal(fact.patch.params.latentContinuation.family, "h3-av");
    assert.equal(fact.patch.params.latentContinuation.saved, true);
    assert.equal(fact.patch.params.latentContinuation.addedNodes, 1);
}));

test("导入：种子存在时 LoadLatent 直连来源文件，优先于 mp4 续写且不再上传上一段成片", () => withRoot(async (root) => {
    await seedSource(root);
    const h = harness(root);
    const ctx = await h.prepare(bareH3Graph(), { resume_prev: true, prev_video: "prev.mp4", latent_prev_task: "prev-run" });
    assert.equal(ctx.prepared.lc_load.inputs.latent_path, `${h3ContinuationFolder(SOURCE)}/clip_00001.safetensors`);
    assert.deepEqual(ctx.prepared["220"].inputs.images, ["lc_trim", 0]);
    assert.deepEqual(ctx.prepared["220"].inputs.audio, ["lc_trim", 1]);
    assert.deepEqual(ctx.prepared["314"].inputs.conditioning, ["lc_context", 0]);
    assert.equal(ctx.prepared.vc_load, undefined, "潜空间载入后不得叠加 mp4 续写节点");
    const fact = h.logUpdates.find((item) => item.patch.params?.latentContinuation);
    assert.ok(fact.patch.params.latentContinuation.loadedFrom);
}));

test("导入：裸 H3 流种子缺失时回退加载视频续写（MotionContext 像素路径），不拒绝", () => withRoot(async (root) => {
    const h = harness(root);
    const graph = bareH3Graph();
    const snapshot = JSON.stringify(graph);
    const ctx = await h.prepare(graph, { resume_prev: true, prev_video: "prev.mp4", latent_prev_task: "prev-run" });
    assert.equal(ctx.prepared.lc_video.inputs.video, "prev.mp4");
    assert.deepEqual(ctx.prepared.lc_context.inputs.context_frames, ["lc_video", 0]);
    assert.deepEqual(ctx.prepared.lc_context.inputs.context_audio, ["lc_video", 2]);
    assert.deepEqual(ctx.prepared.lc_context.inputs.audio_vae, ["236", 0], "像素回退用音频解码器的 VAE 编码尾音频");
    assert.equal(ctx.prepared.lc_context.inputs.context_latent, undefined);
    assert.equal(ctx.prepared.lc_load, undefined);
    assert.deepEqual(ctx.prepared["220"].inputs.images, ["lc_trim", 0]);
    assert.deepEqual(ctx.prepared["220"].inputs.audio, ["lc_trim", 1]);
    assert.deepEqual(ctx.prepared["314"].inputs.conditioning, ["lc_context", 0]);
    assert.equal(JSON.stringify(graph), snapshot, "存储的原工作流图不得改动");
    const fact = h.logUpdates.find((item) => item.patch.params?.latentContinuation);
    assert.equal(fact.patch.params.latentContinuation.loadedVideoFrom, "prev.mp4");
    assert.equal(fact.patch.params.latentContinuation.family, "h3-av");

    const oldData = await h.prepare(bareH3Graph(), { resume_prev: true, prev_video: "prev.mp4" });
    assert.ok(oldData.prepared.lc_video, "上一段运行 ID 缺失（旧数据）同样回退加载视频续写");
}));

test("导入：裸 H3 流缺种子且本段开启续写保存时，像素回退一次性接好导出与加载", () => withRoot(async (root) => {
    const h = harness(root);
    const ctx = await h.prepare(bareH3Graph(), { resume_prev: true, prev_video: "prev.mp4", latent_save: true });
    assert.ok(ctx.prepared.lc_save, "本段潜变量仍导出供下一段无损续写");
    assert.ok(ctx.prepared.lc_video, "同时加载上一段成片做像素回退续写");
    assert.equal(ctx.prepared.lc_load, undefined);
    const fact = h.logUpdates.find((item) => item.patch.params?.latentContinuation);
    assert.equal(fact.patch.params.latentContinuation.saved, true);
    assert.equal(fact.patch.params.latentContinuation.loadedVideoFrom, "prev.mp4");
}));

test("循环流：种子缺失回落 mp4 续写，导出侧支仍然挂上；种子存在则潜空间优先并强制单段", () => withRoot(async (root) => {
    const h = harness(root);
    const values = { resume_prev: true, prev_video: "prev.mp4", latent_prev_task: "prev-run", latent_save: true };
    const fallback = await h.prepare(loopH3Graph(), values);
    assert.ok(fallback.prepared.vc_load, "循环流无种子时保留 mp4 续写兜底");
    assert.ok(fallback.prepared.lc_save, "兜底运行仍导出本段潜变量供下一段");
    assert.equal(fallback.prepared.lc_load, undefined);
    await seedSource(root);
    const latentRun = await h.prepare(loopH3Graph(), values);
    assert.ok(latentRun.prepared.lc_load);
    assert.equal(latentRun.prepared.vc_load, undefined);
    assert.equal(latentRun.prepared["11"].inputs.value, 1);
    assert.equal(latentRun.prepared["10"].inputs.value, 1);
}));

test("V15 主节点：改号后字段注入同步 remap，种子复制到本次目录，描述符 index=2", () => withRoot(async (root) => {
    await seedSource(root);
    const h = harness(root);
    const graph = {
        "741": { class_type: "NanFengH3MultiReferenceGeneratorV15", inputs: { 提示词: "旧提示词", 启用潜空间续写: false, 潜空间续写任务: "" } },
        "out": { class_type: "SaveVideo", inputs: { video: ["741", 0], filename_prefix: "video/H3" } },
    };
    const snapshot = JSON.stringify(graph);
    const fields = [{ id: "prompt", node: "741", input: "提示词", type: "text", name: "提示词", isPrompt: true }];
    const ctx = await h.prepare(graph, { prompt: "新提示词", resume_prev: true, prev_video: "prev.mp4", latent_prev_task: "prev-run" }, fields);
    assert.equal(ctx.prepared["741"], undefined);
    assert.equal(ctx.prepared.nf_v15.inputs.提示词, "新提示词", "改号后字段注入必须命中新 ID");
    assert.equal(ctx.prepared.nf_v15.inputs.启用潜空间续写, true);
    assert.deepEqual(JSON.parse(ctx.prepared.nf_v15.inputs.潜空间续写任务), { workflow: "project-1", node: "nf_v15", group: "node-1", run: "parent-task-1", index: 2 });
    assert.deepEqual(ctx.prepared.out.inputs.video, ["nf_v15", 0]);
    const folder = h3ContinuationFolder(TARGET);
    assert.equal(ctx.latentV15SlotFolder, folder);
    assert.ok(await stat(path.join(root, "output", folder, "clip_00001.safetensors")), "种子必须已复制到本次运行目录");
    assert.equal(JSON.stringify(graph), snapshot);
    const fact = h.logUpdates.find((item) => item.patch.params?.latentContinuation);
    assert.equal(fact.patch.params.latentContinuation.family, "v15");
    assert.equal(fact.patch.params.latentContinuation.renamedFrom, "741");
}));

test("远端 ComfyUI 实例不启用潜空间续写（本地 output/ 不可读写）", () => withRoot(async (root) => {
    const h = harness(root);
    const ctx = await h.prepare(bareH3Graph(), { latent_save: true }, [], "http://remote.example:8188");
    assert.equal(ctx.prepared.lc_save, undefined);
    assert.equal(h.logUpdates.find((item) => item.patch.params?.latentContinuation), undefined);
}));

test("V15 收口：2 号槽归一先于成功标记；归一失败留事件但不判任务失败", () => withRoot(async (root) => {
    const h = harness(root);
    const folder = h3ContinuationFolder(TARGET);
    const dir = path.join(root, "output", folder);
    await mkdir(dir, { recursive: true });
    const runtime = h.executor as any;
    runtime.executeWorkflow = async () => ({ promptId: "p", outputs: {}, media: [], status: { status_str: "success", completed: true } });
    const ctx = {
        task: { id: "task-1" }, prepared: {}, url: LOCAL_URL, controller: new AbortController(), clientId: "client",
        promptText: "", persistedFieldValues: {}, projectId: "project-1", nodeId: "node-1", name: "测试流", configTitle: "测试流",
        outputNodes: [], previewNodeId: "", parentTaskId: "parent-task-1", latentV15SlotFolder: folder,
    };
    await writeFile(path.join(dir, "clip_00002.safetensors"), latent("second-pass-output"));
    let normalizedBeforeSuccess = false;
    const originalUpdate = (h as any).executor.tasks.update;
    runtime.tasks.update = (id: string, patch: any) => {
        if (patch.status === "succeeded") {
            normalizedBeforeSuccess = existsSync(path.join(dir, "clip_00001.safetensors"));
        }
        return originalUpdate(id, patch);
    };
    const result = await runtime.executeAndFinalize(ctx);
    assert.equal(result.taskId, "task-1");
    assert.ok(normalizedBeforeSuccess, "下一段在父任务成功后立刻取种，归一必须先于成功标记");
    assert.deepEqual(await readFile(path.join(dir, "clip_00001.safetensors")), latent("second-pass-output"));

    await rm(path.join(dir, "clip_00002.safetensors"));
    const failed = await runtime.executeAndFinalize({ ...ctx, task: { id: "task-2" } });
    assert.equal(failed.taskId, "task-2", "视频已产出，归一失败不判任务失败");
    assert.ok(h.taskEvents.some((event) => event.type === "latent_slot_normalize_failed"));
}));