import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { BackendDatabase } from "../db.js";
import { BackendEventBus } from "../events.js";
import { createStores } from "../stores/index.js";
import { CanvasH3Runner } from "./h3-runner.js";
const localProvider = () => ({ ready: () => false, queue: { select: () => "local", unreserve() {} } });

function fixture(t: TestContext, count = 1, previousOutput = false, failSecondPass = false, withoutCheckpoint = false) {
    const db = new BackendDatabase(":memory:");
    t.after(() => db.close());
    db.createCanvasProject({ id: "p", nodes: [{ id: "n", type: "minimax-h3", metadata: { segments: Array.from({ length: count }, (_, i) => ({ id: `clip-${i + 1}`, prompt: "a video", confirmationMode: true, faceRefineEnabled: true, mode: "t2v", ...(previousOutput ? { result: "old-video.mp4", resultStorageKey: "old:key", cacheFingerprint: "old:fingerprint" } : {}) })) } }], connections: [] });
    const stores = createStores(db);
    const events = new BackendEventBus();
    const submitted: Array<{ id: string; input: Record<string, unknown> }> = [];
    const comfy = {
        async run(_preset: string, input: Record<string, unknown>, params: Record<string, unknown>, _url?: string, id?: string, onCreated?: (task: ReturnType<typeof stores.tasks.create>) => void) {
            const task = stores.tasks.create(id || `child-${submitted.length + 1}`, "comfyui:minimax-h3", input, withoutCheckpoint ? { ...params, latentConfirmationPhase: "" } : params);
            submitted.push({ id: task.id, input });
            onCreated?.(task);
            if (failSecondPass && (input.video || params.confirmSecondPass === true)) return stores.tasks.update(task.id, { status: "failed", error: "二采模拟失败" });
            stores.media.store(Buffer.from("fake-video"), { name: `${task.id}.mp4`, storageKey: task.id, mimeType: "video/mp4", category: "output" });
            return stores.tasks.update(task.id, { status: "succeeded", progress: 1, result: { media: [{ url: `/media/${task.id}`, storageKey: task.id, mimeType: "video/mp4" }] } });
        },
        cancel() {},
    };
    const runner = new CanvasH3Runner(stores, events, comfy as never, localProvider() as never);
    const segment = (id = "clip-1") => (((db.getCanvasProject("p")!.nodes as unknown as Array<{ metadata: { segments: Array<Record<string, unknown>> } }>)[0]).metadata.segments).find((item) => item.id === id)!;
    const node = () => ((db.getCanvasProject("p")!.nodes as unknown as Array<{ metadata: Record<string, unknown> }>)[0]).metadata;
    const settle = async (id: string, expected: string) => {
        for (let i = 0; i < 100 && db.getTask(id)?.status !== expected; i++) await new Promise((resolve) => setTimeout(resolve, 10));
        assert.equal(db.getTask(id)?.status, expected, `task ${id} did not reach ${expected}`);
    };
    return { db, stores, events, comfy, runner, submitted, segment, node, settle };
}

function decision(db: BackendDatabase, taskId: string, action: "confirm" | "keep_first_pass" | "discard", segmentId = "clip-1") {
    const confirmation = db.getTask(taskId)?.result?.confirmation as { revision: number } | undefined;
    return { action, segmentId, expectedRevision: Number(confirmation?.revision || 0) };
}

test("同节点不同 Clip 并发暂停各自保留确认入口，放弃其中一个不影响另一个", async (t) => {
    const { db, runner, segment, node, submitted, settle } = fixture(t, 2, true);
    const first = runner.start({ projectId: "p", nodeId: "n", segmentId: "clip-1" }, "parent-1");
    const second = runner.start({ projectId: "p", nodeId: "n", segmentId: "clip-2" }, "parent-2");
    await settle(first.id, "awaiting_confirmation");
    await settle(second.id, "awaiting_confirmation");
    for (const [clip, task] of [["clip-1", first], ["clip-2", second]] as const) {
        assert.equal(segment(clip).status, "awaiting_confirmation");
        assert.equal(segment(clip).firstPassReady, true);
        assert.equal(segment(clip).runtimeTaskId, task.id);
    }
    const otherOutput = segment("clip-2").result;
    runner.resolveConfirmation(first.id, decision(db, first.id, "discard"));
    assert.equal(db.getTask(first.id)?.status, "cancelled");
    assert.equal(segment().result, "old-video.mp4");
    assert.equal(segment("clip-2").result, otherOutput);
    assert.equal(segment("clip-2").runtimeTaskId, second.id);
    assert.equal(node().runtimeTaskId, second.id);
    runner.resolveConfirmation(second.id, decision(db, second.id, "keep_first_pass", "clip-2"));
    await settle(second.id, "succeeded");
    assert.equal(submitted.length, 2);
});

test("重新生成被暂停任务拒绝时恢复丢失的 Clip 确认投影，不覆盖其他 Clip", async (t) => {
    const { db, stores, runner, segment, node, submitted, settle } = fixture(t, 2, true);
    const first = runner.start({ projectId: "p", nodeId: "n", segmentId: "clip-1" }, "parent-1");
    await settle(first.id, "awaiting_confirmation");
    const second = runner.start({ projectId: "p", nodeId: "n", segmentId: "clip-2" }, "parent-2");
    await settle(second.id, "awaiting_confirmation");
    stores.projects.applyOperations("p", undefined, [{ type: "update_h3_segment", nodeId: "n", segmentId: "clip-1", patch: {
        status: "success", firstPassReady: false, runtimeTaskId: "", parentTaskId: "", result: "old-video.mp4", firstPassFingerprint: "old:fingerprint",
    } }], { runtimeWrite: true });
    const other = { ...segment("clip-2") };
    assert.throws(() => runner.start({ projectId: "p", nodeId: "n", segmentId: "clip-1", forceRegenerate: true }, "retry"), /占用/);
    assert.equal(segment().status, "awaiting_confirmation");
    assert.equal(segment().firstPassReady, true);
    assert.equal(segment().runtimeTaskId, first.id);
    assert.deepEqual(segment("clip-2"), other);
    assert.ok([first.id, second.id].includes(String(node().runtimeTaskId)), "顶层可聚合任一活动 Clip，不作为确认归属");
    assert.equal(db.getTask("retry"), null);
    runner.resolveConfirmation(first.id, decision(db, first.id, "keep_first_pass"));
    await settle(first.id, "succeeded");
    assert.equal(submitted.length, 2);
});

test("待确认恢复不抢占已经绑定其他父任务的 Clip", async (t) => {
    const { db, stores, runner, segment, settle } = fixture(t);
    const first = runner.start({ projectId: "p", nodeId: "n" }, "parent-1");
    await settle(first.id, "awaiting_confirmation");
    stores.projects.applyOperations("p", undefined, [{ type: "update_h3_segment", nodeId: "n", segmentId: "clip-1", patch: {
        parentTaskId: "another-parent", runtimeTaskId: "", status: "loading", firstPassReady: false,
    } }], { runtimeWrite: true });
    await runner.reconcileTerminal(db.getTask(first.id)!);
    assert.equal(segment().parentTaskId, "another-parent");
    assert.equal(segment().status, "loading");
    assert.throws(() => runner.resolveConfirmation(first.id, decision(db, first.id, "discard")), /绑定已变化/);
});

test("启动恢复找回丢失的待确认投影，只恢复按钮状态而不继续生成", async (t) => {
    const { db, stores, events, comfy, runner, segment, submitted, settle } = fixture(t, 2, true);
    const first = runner.start({ projectId: "p", nodeId: "n", segmentId: "clip-1" }, "parent-1");
    await settle(first.id, "awaiting_confirmation");
    const second = runner.start({ projectId: "p", nodeId: "n", segmentId: "clip-2" }, "parent-2");
    await settle(second.id, "awaiting_confirmation");
    stores.projects.applyOperations("p", undefined, [{ type: "update_h3_segment", nodeId: "n", segmentId: "clip-1", patch: {
        status: "success", firstPassReady: false, runtimeTaskId: "", parentTaskId: "",
    } }], { runtimeWrite: true });
    const replacement = new CanvasH3Runner(stores, events, comfy as never, localProvider() as never);
    for (const task of db.listStartupRecoveryTasks([], 10)) replacement.resume(task);
    assert.equal(segment().status, "awaiting_confirmation");
    assert.equal(segment().firstPassReady, true);
    assert.equal(segment().runtimeTaskId, first.id);
    assert.equal(segment("clip-2").runtimeTaskId, second.id);
    assert.equal(db.getTask(first.id)?.status, "awaiting_confirmation");
    assert.equal(db.getTask(second.id)?.status, "awaiting_confirmation");
    assert.equal(submitted.length, 2);
});

test("潜空间二采关闭时残留确认字段不暂停、不提交视频重采样", async (t) => {
    const { db, stores, runner, submitted, segment, settle } = fixture(t);
    const project = stores.projects.get("p")!;
    stores.projects.applyOperations("p", Number(project.revision || 0), [{ type: "update_h3_segment", nodeId: "n", segmentId: "clip-1", patch: {
        latentUpscaleEnabled: false, latentUpscaleConfirmationMode: true, confirmationMode: true, faceRefineEnabled: false,
    } }]);
    const task = runner.start({ projectId: "p", nodeId: "n" }, "ordinary-parent");
    await settle(task.id, "succeeded");
    assert.equal(submitted.length, 1);
    assert.equal(db.getTask(submitted[0].id)?.params.latentConfirmationPhase, undefined);
    assert.equal(db.getTask(submitted[0].id)?.params.postGenerationOnly, undefined);
    assert.equal(segment().firstPassReady, false);
    assert.equal(stores.tasks.events(task.id).some((event) => event.type === "first_pass_ready"), false);
});

test("精修确认不能替代潜空间确认，已有普通一采不能被确认成潜空间二采", async (t) => {
    const { db, stores, runner, submitted, settle } = fixture(t);
    const project = stores.projects.get("p")!;
    stores.projects.applyOperations("p", Number(project.revision || 0), [{ type: "update_h3_segment", nodeId: "n", segmentId: "clip-1", patch: {
        latentUpscaleEnabled: true, latentUpscaleConfirmationMode: false,
    } }]);
    const task = runner.start({ projectId: "p", nodeId: "n" }, "automatic-latent");
    await settle(task.id, "succeeded");
    assert.equal(submitted.length, 1);
    assert.equal(db.getTask(submitted[0].id)?.params.latentConfirmationPhase, undefined);
});

test("潜空间确认先暂停，重启后沿用快照二采且重复确认不重跑", async (t) => {
    const { db, stores, events, comfy, runner, submitted, settle } = fixture(t);
    const project = stores.projects.get("p")!;
    stores.projects.applyOperations("p", Number(project.revision || 0), [{ type: "update_h3_segment", nodeId: "n", segmentId: "clip-1", patch: {
        latentUpscaleEnabled: true, latentUpscaleConfirmationMode: true, h3FirstSteps: 6, h3SecondSteps: 4,
    } }]);
    const task = runner.start({ projectId: "p", nodeId: "n", params: { noiseSeedMode: "random", seed: 123 } }, "latent-parent");
    await settle(task.id, "awaiting_confirmation");
    assert.equal(submitted.length, 1);
    const first = db.getTask(submitted[0].id)!;
    assert.equal(first.params.latentConfirmationPhase, "first");
    assert.equal(first.params.latentUpscaleEnabled, true);
    assert.match(String(first.params.latentCheckpointId), /^[a-f0-9]{64}$/);
    const replacement = new CanvasH3Runner(stores, events, comfy as never, localProvider() as never);
    replacement.resume(db.getTask(task.id)!);
    assert.equal(submitted.length, 1);
    const request = { ...decision(db, task.id, "confirm"), postpassParams: { latentUpscaleEnabled: false, h3FirstSteps: 20, h3SecondSteps: 12, latentUpscaleMegapixels: 2 } };
    replacement.resolveConfirmation(task.id, request);
    await settle(task.id, "succeeded");
    replacement.resolveConfirmation(task.id, request);
    assert.equal(submitted.length, 2);
    const second = db.getTask(submitted[1].id)!;
    assert.equal(second.params.latentConfirmationPhase, "second");
    assert.equal(second.params.latentCheckpointId, first.params.latentCheckpointId);
    assert.equal(second.params.seed, first.params.seed);
    assert.equal(second.params.noiseSeed, first.params.noiseSeed);
    assert.equal(second.params.latentUpscaleEnabled, true);
    assert.equal(second.params.h3FirstSteps, 6);
    assert.equal(second.params.h3SecondSteps, 4);
    assert.equal(second.params.latentUpscaleMegapixels, 2);
    assert.equal(second.params.postGenerationOnly, false);
    assert.equal(second.input.video, undefined, "一采视频不能替代原生潜变量续采");
});

test("无潜变量身份的一采禁止进入潜空间二采，仍可保留一采", async (t) => {
    const { db, stores, runner, submitted, settle } = fixture(t, 1, false, false, true);
    const project = stores.projects.get("p")!;
    stores.projects.applyOperations("p", Number(project.revision || 0), [{ type: "update_h3_segment", nodeId: "n", segmentId: "clip-1", patch: {
        latentUpscaleEnabled: true, latentUpscaleConfirmationMode: true,
    } }]);
    const task = runner.start({ projectId: "p", nodeId: "n" }, "incompatible-first");
    await settle(task.id, "awaiting_confirmation");
    assert.throws(() => runner.resolveConfirmation(task.id, decision(db, task.id, "confirm")), /不匹配/);
    assert.equal(submitted.length, 1);
    assert.equal(db.getTask(task.id)?.status, "awaiting_confirmation");
    runner.resolveConfirmation(task.id, decision(db, task.id, "keep_first_pass"));
    await settle(task.id, "succeeded");
});

test("潜空间二采失败只重试二采，保留同一快照和一采结果", async (t) => {
    const { db, stores, runner, submitted, segment, settle } = fixture(t, 1, false, true);
    const project = stores.projects.get("p")!;
    stores.projects.applyOperations("p", Number(project.revision || 0), [{ type: "update_h3_segment", nodeId: "n", segmentId: "clip-1", patch: { latentUpscaleEnabled: true, latentUpscaleConfirmationMode: true } }]);
    const task = runner.start({ projectId: "p", nodeId: "n" }, "latent-failure");
    await settle(task.id, "awaiting_confirmation");
    const firstResult = segment().firstPassResult;
    for (let attempt = 0; attempt < 2; attempt++) {
        runner.resolveConfirmation(task.id, decision(db, task.id, "confirm"));
        for (let i = 0; i < 100 && !db.getTask(task.id)?.error; i++) await new Promise((resolve) => setTimeout(resolve, 10));
        await settle(task.id, "awaiting_confirmation");
        assert.equal(submitted.length, attempt + 2);
        assert.equal(segment().firstPassResult, firstResult);
        assert.equal(db.getTask(submitted[attempt + 1].id)?.params.latentConfirmationPhase, "second");
        assert.equal(db.getTask(submitted[attempt + 1].id)?.params.latentCheckpointId, db.getTask(submitted[0].id)?.params.latentCheckpointId);
    }
    runner.resolveConfirmation(task.id, decision(db, task.id, "keep_first_pass"));
    await settle(task.id, "succeeded");
    assert.equal(segment().result, firstResult);
    assert.equal(submitted.length, 3);
});

test("一采就绪使同一父任务持久暂停，保留绑定且不提前提交后一段", async (t) => {
    const { db, runner, submitted, segment, node, settle } = fixture(t, 2);
    const task = runner.start({ projectId: "p", nodeId: "n", segmentId: "clip-1", runFromCurrent: true }, "parent");
    await settle(task.id, "awaiting_confirmation");
    assert.equal(submitted.length, 1);
    assert.equal(segment().status, "awaiting_confirmation");
    assert.equal(segment().runtimeTaskId, task.id);
    assert.equal(node().status, "awaiting_confirmation");
    assert.equal(node().runtimeTaskId, task.id);
    assert.ok(db.getTask(task.id)!.progress < 1);
    assert.equal(runner.start({ projectId: "p", nodeId: "n", segmentId: "clip-1", runFromCurrent: true }, "another").id, task.id);
    assert.throws(() => runner.cancel(task.id), /不可取消|待确认/);
    assert.equal(db.getTask(task.id)?.status, "awaiting_confirmation");
});

test("两个窗口同时提交相同 H3 命令时接回同一活动父任务", async (t) => {
    const { db, runner, submitted, settle } = fixture(t);
    const input = { projectId: "p", nodeId: "n", segmentId: "clip-1" };
    const first = runner.start(input, "first-window");
    const second = runner.start(input, "second-window");
    assert.equal(second.id, first.id);
    assert.equal(db.getTask("second-window"), null);
    await settle(first.id, "awaiting_confirmation");
    assert.equal(submitted.length, 1);
});

test("首段单跑忽略无前段可接的 Motion Context 开关", async (t) => {
    const { db, stores, runner, submitted, settle } = fixture(t);
    const project = stores.projects.get("p")!;
    stores.projects.applyOperations("p", Number(project.revision || 0), [
        { type: "update_h3_segment", nodeId: "n", segmentId: "clip-1", patch: { motionContextEnabled: true } },
    ]);
    const task = runner.start({ projectId: "p", nodeId: "n", segmentId: "clip-1" }, "first-only");
    await settle(task.id, "awaiting_confirmation");
    assert.equal(submitted.length, 1);
});

test("跳过已完成模式一采暂停后仍锁住原 Clip，不会因一采回写结果而漏判重叠", async (t) => {
    const { db, stores, events, comfy, runner, submitted, segment, settle } = fixture(t);
    const task = runner.start({ projectId: "p", nodeId: "n", segmentId: "clip-1", skipCompleted: true }, "parent");
    await settle(task.id, "awaiting_confirmation");
    const repeat = runner.start({ projectId: "p", nodeId: "n", segmentId: "clip-1", skipCompleted: true }, "different-parent");
    assert.equal(repeat.id, task.id);
    const replacement = new CanvasH3Runner(stores, events, comfy as never, localProvider() as never);
    await replacement.reconcileTerminal(db.getTask(task.id)!);
    replacement.resolveConfirmation(task.id, decision(db, task.id, "keep_first_pass"));
    await settle(task.id, "succeeded");
    assert.equal(submitted.length, 1);
});

test("暂停时更改 Clip 提示词，不得复用旧父任务并吞掉新请求", async (t) => {
    const { db, stores, runner, settle } = fixture(t);
    const task = runner.start({ projectId: "p", nodeId: "n", segmentId: "clip-1" }, "parent");
    await settle(task.id, "awaiting_confirmation");
    const project = stores.projects.get("p")!;
    stores.projects.applyOperations("p", Number(project.revision || 0), [
        { type: "update_h3_segment", nodeId: "n", segmentId: "clip-1", patch: { prompt: "changed prompt" } },
    ]);
    assert.throws(() => runner.start({ projectId: "p", nodeId: "n", segmentId: "clip-1" }, "new-request"), /占用|冲突/);
    assert.equal(db.getTask("new-request"), null);
});

test("确认二采复用原父任务；重复请求不重复提交；后段串行暂停", async (t) => {
    const { db, runner, submitted, segment, settle } = fixture(t, 2);
    const task = runner.start({ projectId: "p", nodeId: "n", segmentId: "clip-1", runFromCurrent: true }, "parent");
    await settle(task.id, "awaiting_confirmation");
    const request = decision(db, task.id, "confirm");
    runner.resolveConfirmation(task.id, request);
    runner.resolveConfirmation(task.id, request);
    for (let i = 0; i < 100 && submitted.length < 3; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    await settle(task.id, "awaiting_confirmation");
    assert.equal(submitted.length, 3, "one first pass and one second pass for clip-1, then one first pass for clip-2");
    assert.ok(submitted[1].input.video, "clip-1 second pass must use first-pass video");
    assert.equal(segment().status, "success");
    assert.equal(submitted.length, 3, "next clip begins only after first is settled");
    assert.equal(db.getTask(task.id)?.status, "awaiting_confirmation");
    runner.resolveConfirmation(task.id, decision(db, task.id, "keep_first_pass", "clip-2"));
    await settle(task.id, "succeeded");
    assert.equal(submitted.length, 3);
    assert.equal(segment("clip-2").status, "success");
});

test("批量运行冻结后续 Clip，确认时只采纳二采专属参数", async (t) => {
    const { db, stores, runner, submitted, settle } = fixture(t, 2);
    const task = runner.start({ projectId: "p", nodeId: "n", segmentId: "clip-1", runFromCurrent: true }, "frozen-parent");
    await settle(task.id, "awaiting_confirmation");
    const project = stores.projects.get("p")!;
    stores.projects.applyOperations("p", Number(project.revision || 0), [
        { type: "update_h3_segment", nodeId: "n", segmentId: "clip-1", patch: { faceRefineDenoise: 0.27 } },
        { type: "update_h3_segment", nodeId: "n", segmentId: "clip-2", patch: { prompt: "new prompt for next run" } },
    ]);
    runner.resolveConfirmation(task.id, { ...decision(db, task.id, "confirm"), postpassParams: { faceRefineDenoise: 0.27, prompt: "must not replace frozen prompt" } });
    for (let i = 0; i < 100 && submitted.length < 3; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(submitted.length, 3);
    assert.equal(db.getTask(submitted[1].id)?.params.faceRefineDenoise, 0.27);
    assert.equal(submitted[2].input.prompt, "a video");
    assert.equal(submitted[1].input.prompt, "a video");
});

test("重启后保留一采沿用原任务，决议幂等且节点收口", async (t) => {
    const { db, stores, events, comfy, runner, submitted, segment, node, settle } = fixture(t);
    const task = runner.start({ projectId: "p", nodeId: "n" }, "parent");
    await settle(task.id, "awaiting_confirmation");
    const replacement = new CanvasH3Runner(stores, events, comfy as never, localProvider() as never);
    await replacement.reconcileTerminal(db.getTask(task.id)!);
    assert.equal(replacement.resume(db.getTask(task.id)!).status, "awaiting_confirmation");
    const firstPassResult = String(segment().firstPassResult);
    const request = decision(db, task.id, "keep_first_pass");
    replacement.resolveConfirmation(task.id, request);
    await settle(task.id, "succeeded");
    replacement.resolveConfirmation(task.id, request);
    assert.equal(submitted.length, 1);
    assert.equal(segment().result, firstPassResult);
    assert.equal(segment().firstPassReady, false);
    assert.equal(node().status, "success");
    assert.equal(node().runtimeTaskId, "");
});

test("重启时重放已持久化但尚未提交的二采决议，不重新生成一采", async (t) => {
    const { db, stores, events, comfy, runner, submitted, segment, settle } = fixture(t);
    const task = runner.start({ projectId: "p", nodeId: "n" }, "parent");
    await settle(task.id, "awaiting_confirmation");
    const current = db.getTask(task.id)!;
    const confirmation = current.result!.confirmation as { revision: number; pending: Array<{ nodeId: string; segmentId: string }> };
    assert.ok(stores.tasks.transitionH3(task.id, "awaiting_confirmation", confirmation.revision, {
        status: "running",
        result: { ...current.result, phase: "second_pass", confirmation: {
            ...confirmation, revision: confirmation.revision + 1,
            inFlight: { nodeId: "n", segmentId: "clip-1", action: "confirm", attempt: 1, childTaskId: "recovered-second", postpassParams: { confirmSecondPass: true } },
        } },
    }, { type: "h3_decision", payload: { action: "confirm", nodeId: "n", segmentId: "clip-1", childTaskId: "recovered-second" } }));
    const replacement = new CanvasH3Runner(stores, events, comfy as never, localProvider() as never);
    replacement.resume(db.getTask(task.id)!);
    await settle(task.id, "succeeded");
    assert.deepEqual(submitted.map((item) => item.id), [submitted[0].id, "recovered-second"]);
    assert.ok(submitted[1].input.video);
    assert.equal(segment().status, "success");
});

test("放弃恢复旧输出、取消同一父任务且不删除历史媒体", async (t) => {
    const { db, runner, stores, submitted, segment, node, settle } = fixture(t, 1, true);
    const task = runner.start({ projectId: "p", nodeId: "n" }, "parent");
    await settle(task.id, "awaiting_confirmation");
    const request = decision(db, task.id, "discard");
    assert.throws(() => runner.resolveConfirmation(task.id, { ...request, expectedRevision: request.expectedRevision - 1 }), /快照/);
    runner.resolveConfirmation(task.id, request);
    runner.resolveConfirmation(task.id, request);
    assert.equal(db.getTask(task.id)!.status, "cancelled");
    assert.equal(segment().result, "old-video.mp4");
    assert.equal(segment().cacheFingerprint, "old:fingerprint");
    assert.equal(segment().firstPassReady, false);
    assert.equal(node().runtimeTaskId, "");
    assert.equal(submitted.length, 1);
    assert.ok(stores.media.meta(submitted[0].id), "一采媒体仍应保留");
});

test("固定种子保留一采后重新串行运行，复用的已收口 Clip 仍计入父任务媒体", async (t) => {
    const { db, runner, submitted, segment, settle } = fixture(t, 2);
    const first = runner.start({ projectId: "p", nodeId: "n", segmentId: "clip-1", runFromCurrent: true, params: { noiseSeedMode: "fixed", seed: 123 } }, "first");
    await settle(first.id, "awaiting_confirmation");
    runner.resolveConfirmation(first.id, decision(db, first.id, "keep_first_pass"));
    for (let i = 0; i < 100 && segment("clip-2").status !== "awaiting_confirmation"; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    await settle(first.id, "awaiting_confirmation");
    runner.resolveConfirmation(first.id, decision(db, first.id, "discard", "clip-2"));
    const second = runner.start({ projectId: "p", nodeId: "n", segmentId: "clip-1", runFromCurrent: true, params: { noiseSeedMode: "fixed", seed: 123 } }, "second");
    await settle(second.id, "awaiting_confirmation");
    assert.equal(submitted.length, 3, "已收口的首 Clip 不应重跑");
    const media = db.getTask(second.id)?.result?.media;
    assert.equal(Array.isArray(media) ? media.length : 0, 1, "首 Clip 复用的视频应计入最终媒体");
});

test("二采失败返回同父任务待确认；显式重试使用新子任务，仍可保留一采", async (t) => {
    const { db, runner, submitted, segment, node, settle } = fixture(t, 1, false, true);
    const task = runner.start({ projectId: "p", nodeId: "n" }, "parent");
    await settle(task.id, "awaiting_confirmation");
    const confirm = decision(db, task.id, "confirm");
    runner.resolveConfirmation(task.id, confirm);
    for (let i = 0; i < 100 && !db.getTask(task.id)?.error; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.match(db.getTask(task.id)?.error || "", /二采模拟失败/);
    assert.equal(db.getTask(task.id)?.status, "awaiting_confirmation");
    assert.equal(segment().status, "awaiting_confirmation");
    assert.equal(segment().runtimeTaskId, task.id);
    assert.equal(node().status, "awaiting_confirmation");
    assert.equal(submitted.length, 2);
    runner.resolveConfirmation(task.id, confirm);
    assert.equal(submitted.length, 2, "不带 retry 的重复决议不得再次提交");
    runner.resolveConfirmation(task.id, decision(db, task.id, "confirm"));
    for (let i = 0; i < 100 && submitted.length < 3; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(submitted.length, 3);
    assert.notEqual(submitted[1].id, submitted[2].id);
    for (let i = 0; i < 100 && !db.getTask(task.id)?.error; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    runner.resolveConfirmation(task.id, decision(db, task.id, "keep_first_pass"));
    await settle(task.id, "succeeded");
    assert.equal(segment().status, "success");
    assert.equal(submitted.length, 3);
});

test("固定种子明确重新生成绕过缓存，普通再次运行仍可复用成品", async (t) => {
    const { db, runner, submitted, settle } = fixture(t);
    const first = runner.start({ projectId: "p", nodeId: "n", params: { noiseSeedMode: "fixed", seed: 123 } }, "first");
    await settle(first.id, "awaiting_confirmation");
    runner.resolveConfirmation(first.id, decision(db, first.id, "keep_first_pass"));
    await settle(first.id, "succeeded");
    const reused = runner.start({ projectId: "p", nodeId: "n" }, "reused");
    await settle(reused.id, "succeeded");
    assert.equal(submitted.length, 1);
    const forced = runner.start({ projectId: "p", nodeId: "n", forceRegenerate: true }, "forced");
    await settle(forced.id, "awaiting_confirmation");
    assert.equal(submitted.length, 2);
});
