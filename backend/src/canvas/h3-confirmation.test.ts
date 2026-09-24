import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { BackendDatabase } from "../db.js";
import { BackendEventBus } from "../events.js";
import { createStores } from "../stores/index.js";
import { CanvasH3Runner } from "./h3-runner.js";

function fixture(t: TestContext, count = 1, previousOutput = false, failSecondPass = false) {
    const db = new BackendDatabase(":memory:");
    t.after(() => db.close());
    db.createCanvasProject({ id: "p", nodes: [{ id: "n", type: "minimax-h3", metadata: { segments: Array.from({ length: count }, (_, i) => ({ id: `clip-${i + 1}`, prompt: "a video", confirmationMode: true, mode: "t2v", ...(previousOutput ? { result: "old-video.mp4", resultStorageKey: "old:key", cacheFingerprint: "old:fingerprint" } : {}) })) } }], connections: [] });
    const stores = createStores(db);
    const events = new BackendEventBus();
    const submitted: Array<{ id: string; input: Record<string, unknown> }> = [];
    const comfy = {
        async run(_preset: string, input: Record<string, unknown>, params: Record<string, unknown>, _url?: string, id?: string, onCreated?: (task: ReturnType<typeof stores.tasks.create>) => void) {
            const task = stores.tasks.create(id || `child-${submitted.length + 1}`, "comfyui:minimax-h3", input, params);
            submitted.push({ id: task.id, input });
            onCreated?.(task);
            if (failSecondPass && input.video) return stores.tasks.update(task.id, { status: "failed", error: "二采模拟失败" });
            stores.media.store(Buffer.from("fake-video"), { name: `${task.id}.mp4`, storageKey: task.id, mimeType: "video/mp4", category: "output" });
            return stores.tasks.update(task.id, { status: "succeeded", progress: 1, result: { media: [{ url: `/media/${task.id}`, storageKey: task.id, mimeType: "video/mp4" }] } });
        },
        cancel() {},
    };
    const runner = new CanvasH3Runner(stores, events, comfy as never, {} as never);
    const segment = (id = "clip-1") => (((db.getCanvasProject("p")!.nodes as unknown as Array<{ metadata: { segments: Array<Record<string, unknown>> } }>)[0]).metadata.segments).find((item) => item.id === id)!;
    const node = () => ((db.getCanvasProject("p")!.nodes as unknown as Array<{ metadata: Record<string, unknown> }>)[0]).metadata;
    const settle = async (id: string, expected: string) => {
        for (let i = 0; i < 100 && db.getTask(id)?.status !== expected; i++) await new Promise((resolve) => setTimeout(resolve, 10));
        assert.equal(db.getTask(id)?.status, expected, `task ${id} did not reach ${expected}`);
    };
    return { db, stores, events, comfy, runner, submitted, segment, node, settle };
}

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

test("跳过已完成模式一采暂停后仍锁住原 Clip，不会因一采回写结果而漏判重叠", async (t) => {
    const { db, stores, events, comfy, runner, submitted, segment, settle } = fixture(t);
    const task = runner.start({ projectId: "p", nodeId: "n", segmentId: "clip-1", skipCompleted: true }, "parent");
    await settle(task.id, "awaiting_confirmation");
    const repeat = runner.start({ projectId: "p", nodeId: "n", segmentId: "clip-1", skipCompleted: true }, "different-parent");
    assert.equal(repeat.id, task.id);
    const replacement = new CanvasH3Runner(stores, events, comfy as never, {} as never);
    await replacement.reconcileTerminal(db.getTask(task.id)!);
    replacement.resolveConfirmation(task.id, { action: "keep_first_pass", segmentIds: ["clip-1"], firstPassFingerprint: String(segment().firstPassFingerprint) });
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
    const fingerprint = String(segment().firstPassFingerprint);
    runner.resolveConfirmation(task.id, { action: "confirm", segmentIds: ["clip-1"], firstPassFingerprint: fingerprint });
    runner.resolveConfirmation(task.id, { action: "confirm", segmentIds: ["clip-1"], firstPassFingerprint: fingerprint });
    for (let i = 0; i < 100 && submitted.length < 3; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    await settle(task.id, "awaiting_confirmation");
    assert.equal(submitted.length, 3, "one first pass and one second pass for clip-1, then one first pass for clip-2");
    assert.ok(submitted[1].input.video, "clip-1 second pass must use first-pass video");
    assert.equal(segment().status, "success");
    assert.equal(submitted.length, 3, "next clip begins only after first is settled");
    assert.equal(db.getTask(task.id)?.status, "awaiting_confirmation");
    runner.resolveConfirmation(task.id, { action: "keep_first_pass", segmentIds: ["clip-2"], firstPassFingerprint: String(segment("clip-2").firstPassFingerprint) });
    await settle(task.id, "succeeded");
    assert.equal(submitted.length, 3);
    assert.equal(segment("clip-2").status, "success");
});

test("重启后保留一采沿用原任务，决议幂等且节点收口", async (t) => {
    const { db, stores, events, comfy, runner, submitted, segment, node, settle } = fixture(t);
    const task = runner.start({ projectId: "p", nodeId: "n" }, "parent");
    await settle(task.id, "awaiting_confirmation");
    const replacement = new CanvasH3Runner(stores, events, comfy as never, {} as never);
    await replacement.reconcileTerminal(db.getTask(task.id)!);
    assert.equal(replacement.resume(db.getTask(task.id)!).status, "awaiting_confirmation");
    const firstPassResult = String(segment().firstPassResult);
    const decision = { action: "keep_first_pass" as const, segmentIds: ["clip-1"], firstPassFingerprint: String(segment().firstPassFingerprint) };
    replacement.resolveConfirmation(task.id, decision);
    await settle(task.id, "succeeded");
    replacement.resolveConfirmation(task.id, decision);
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
    const replacement = new CanvasH3Runner(stores, events, comfy as never, {} as never);
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
    const decision = { action: "discard" as const, segmentIds: ["clip-1"], firstPassFingerprint: String(segment().firstPassFingerprint) };
    assert.throws(() => runner.resolveConfirmation(task.id, { ...decision, firstPassFingerprint: "stale" }), /快照/);
    runner.resolveConfirmation(task.id, decision);
    runner.resolveConfirmation(task.id, decision);
    assert.equal(db.getTask(task.id)!.status, "cancelled");
    assert.equal(segment().result, "old-video.mp4");
    assert.equal(segment().cacheFingerprint, "old:fingerprint");
    assert.equal(segment().firstPassReady, false);
    assert.equal(node().runtimeTaskId, "");
    assert.equal(submitted.length, 1);
    assert.ok(stores.media.meta(submitted[0].id), "一采媒体仍应保留");
});

test("保留一采后重新串行运行，复用的已收口 Clip 仍计入父任务媒体", async (t) => {
    const { db, runner, submitted, segment, settle } = fixture(t, 2);
    const first = runner.start({ projectId: "p", nodeId: "n", segmentId: "clip-1", runFromCurrent: true }, "first");
    await settle(first.id, "awaiting_confirmation");
    runner.resolveConfirmation(first.id, { action: "keep_first_pass", segmentIds: ["clip-1"], firstPassFingerprint: String(segment().firstPassFingerprint) });
    for (let i = 0; i < 100 && segment("clip-2").status !== "awaiting_confirmation"; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    await settle(first.id, "awaiting_confirmation");
    runner.resolveConfirmation(first.id, { action: "discard", segmentIds: ["clip-2"], firstPassFingerprint: String(segment("clip-2").firstPassFingerprint) });
    const second = runner.start({ projectId: "p", nodeId: "n", segmentId: "clip-1", runFromCurrent: true }, "second");
    await settle(second.id, "awaiting_confirmation");
    assert.equal(submitted.length, 3, "已收口的首 Clip 不应重跑");
    const media = db.getTask(second.id)?.result?.media;
    assert.equal(Array.isArray(media) ? media.length : 0, 1, "首 Clip 复用的视频应计入最终媒体");
});

test("二采失败返回同父任务待确认；显式重试使用新子任务，仍可保留一采", async (t) => {
    const { db, runner, submitted, segment, settle } = fixture(t, 1, false, true);
    const task = runner.start({ projectId: "p", nodeId: "n" }, "parent");
    await settle(task.id, "awaiting_confirmation");
    const fingerprint = String(segment().firstPassFingerprint);
    const confirm = { action: "confirm" as const, segmentIds: ["clip-1"], firstPassFingerprint: fingerprint };
    runner.resolveConfirmation(task.id, confirm);
    for (let i = 0; i < 100 && !db.getTask(task.id)?.error; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.match(db.getTask(task.id)?.error || "", /二采模拟失败/);
    assert.equal(db.getTask(task.id)?.status, "awaiting_confirmation");
    assert.equal(submitted.length, 2);
    runner.resolveConfirmation(task.id, confirm);
    assert.equal(submitted.length, 2, "不带 retry 的重复决议不得再次提交");
    runner.resolveConfirmation(task.id, { ...confirm, retry: true });
    for (let i = 0; i < 100 && submitted.length < 3; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(submitted.length, 3);
    assert.notEqual(submitted[1].id, submitted[2].id);
    for (let i = 0; i < 100 && !db.getTask(task.id)?.error; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    runner.resolveConfirmation(task.id, { action: "keep_first_pass", segmentIds: ["clip-1"], firstPassFingerprint: fingerprint });
    await settle(task.id, "succeeded");
    assert.equal(segment().status, "success");
    assert.equal(submitted.length, 3);
});
