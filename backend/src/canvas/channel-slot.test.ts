/** withChannelSlot 集成测试：配了并发上限后，同类同渠道任务排队、释放后放行。 */
import assert from "node:assert/strict";
import test from "node:test";
import { channelIdOfModel, channelWaitReason, waitReasonHooks, withChannelSlot } from "./channel-slot.js";
import { channelConcurrency } from "./channel-concurrency.js";
import { BackendDatabase } from "../db.js";
import { createStores } from "../stores/index.js";

function mockStores(aiConfig: unknown) {
    return { settings: { get: (_key: string) => aiConfig } } as any;
}

/** 带 tasks/logs 的假 store：记录 waitReason 被写到了哪里。 */
function mockWaitStores(aiConfig: unknown) {
    const tasks = new Map<string, { id: string; params: Record<string, unknown> }>();
    const logs = new Map<string, { id: string; params: Record<string, unknown> }>();
    for (const id of ["task-A", "task-B", "task-C"]) tasks.set(id, { id, params: {} });
    for (const id of ["log-A", "log-B", "log-C"]) logs.set(id, { id, params: {} });
    const stores = {
        settings: { get: (_key: string) => aiConfig },
        tasks: {
            get: (id: string) => tasks.get(id) || null,
            update: (id: string, patch: { params?: Record<string, unknown> }) => {
                const task = tasks.get(id)!;
                task.params = { ...task.params, ...(patch.params || {}) };
                return task;
            },
        },
        logs: {
            get: (id: string) => logs.get(id) || null,
            update: (id: string, patch: { params?: Record<string, unknown> }) => {
                const log = logs.get(id)!;
                log.params = { ...(patch.params || {}) };
                return log;
            },
        },
    };
    return { stores: stores as any, tasks, logs };
}

test("channelIdOfModel 从 channelId::model 解析渠道", () => {
    assert.equal(channelIdOfModel("opencode-go::hy4-flash-free"), "opencode-go");
    assert.equal(channelIdOfModel("image:xxx"), undefined);
    assert.equal(channelIdOfModel(undefined), undefined);
});

test("没配上限时 withChannelSlot 立即执行，不限流", async () => {
    channelConcurrency.reset();
    const stores = mockStores({ channels: [{ id: "text-ch" }] });
    let ran = false;
    await withChannelSlot(stores, "text", "text-ch", async () => { ran = true; });
    assert.equal(ran, true);
    assert.deepEqual(channelConcurrency.stats("text:text-ch"), { active: 0, waiting: 0 });
});

test("配了上限=1 时同类同渠道任务排队，前一个 release 后放行", async () => {
    channelConcurrency.reset();
    const stores = mockStores({ channelConcurrency: 2, channels: [{ id: "text-ch", concurrencyLimit: 1 }] });
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstDone = new Promise<void>((r) => { releaseFirst = r; });
    const p1 = withChannelSlot(stores, "text", "text-ch", async () => {
        order.push("A-start");
        await firstDone;
        order.push("A-end");
    });
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(order, ["A-start"]);
    const p2 = withChannelSlot(stores, "text", "text-ch", async () => { order.push("B-start"); });
    assert.equal(channelConcurrency.stats("text:text-ch").waiting, 1, "第二个任务应排队");
    assert.deepEqual(order, ["A-start"], "B 尚未开始");
    releaseFirst();
    await Promise.all([p1, p2]);
    assert.deepEqual(order, ["A-start", "A-end", "B-start"]);
    assert.deepEqual(channelConcurrency.stats("text:text-ch"), { active: 0, waiting: 0 });
});

test("不同 kind / 不同渠道互不阻塞", async () => {
    channelConcurrency.reset();
    const stores = mockStores({ channels: [
        { id: "ch1", concurrencyLimit: 1 },
        { id: "ch2", concurrencyLimit: 1 },
    ] });
    const order: string[] = [];
    let rel!: () => void;
    const gate = new Promise<void>((r) => { rel = r; });
    const p1 = withChannelSlot(stores, "text", "ch1", async () => { order.push("text-ch1"); await gate; });
    await new Promise((r) => setTimeout(r, 10));
    const p2 = withChannelSlot(stores, "image", "ch1", async () => { order.push("image-ch1"); });
    const p3 = withChannelSlot(stores, "text", "ch2", async () => { order.push("text-ch2"); });
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(order, ["text-ch1", "image-ch1", "text-ch2"], "不同桶都应放行");
    rel();
    await Promise.all([p1, p2, p3]);
    channelConcurrency.reset();
});

test("已有占用需要排队时，第二个任务写入真实 waitReason（含并发数与前方等待数）", async () => {
    channelConcurrency.reset();
    const config = { channels: [{ id: "video-ch", concurrencyLimit: 1 }] };
    const { stores, logs } = mockWaitStores(config);
    let releaseA!: () => void;
    const gateA = new Promise<void>((r) => { releaseA = r; });
    let releaseB!: () => void;
    const gateB = new Promise<void>((r) => { releaseB = r; });
    const pA = withChannelSlot(stores, "video", "video-ch", async () => { await gateA; }, waitReasonHooks(stores, "task-A", "log-A"));
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(logs.get("log-A")!.params.waitReason, undefined, "立即拿到槽位的任务不写等待原因");
    const pB = withChannelSlot(stores, "video", "video-ch", async () => { await gateB; }, waitReasonHooks(stores, "task-B", "log-B"));
    await new Promise((r) => setTimeout(r, 10));
    const reasonB = String(logs.get("log-B")!.params.waitReason || "");
    assert.equal(reasonB, channelWaitReason("video", 1, 0), "文案只用真实并发上限与真实排队人数");
    assert.match(reasonB, /并发 1/);
    assert.equal(String(stores.tasks.get("task-B").params.waitReason || ""), reasonB, "任务 params 同步写入");
    // 第三个任务：真实已有 1 个在排队。
    const pC = withChannelSlot(stores, "video", "video-ch", async () => undefined, waitReasonHooks(stores, "task-C", "log-C"));
    assert.match(String(logs.get("log-C")!.params.waitReason || ""), /前面还有 1 个/);
    releaseA();
    await pA;
    await new Promise((r) => setTimeout(r, 10));
    releaseB();
    await Promise.all([pB, pC]);
    channelConcurrency.reset();
});

test("立即拿到槽位时不写任何 waitReason", async () => {
    channelConcurrency.reset();
    const config = { channels: [{ id: "text-ch", concurrencyLimit: 2 }] };
    const { stores, logs } = mockWaitStores(config);
    let ran = false;
    await withChannelSlot(stores, "text", "text-ch", async () => { ran = true; }, waitReasonHooks(stores, "task-A", "log-A"));
    assert.equal(ran, true);
    assert.equal("waitReason" in stores.tasks.get("task-A").params, false);
    assert.equal("waitReason" in logs.get("log-A")!.params, false);
    assert.deepEqual(channelConcurrency.stats("text:text-ch"), { active: 0, waiting: 0 });
});

test("拿到槽位开始执行后清理 waitReason，结束后无残留", async () => {
    channelConcurrency.reset();
    const config = { channelConcurrency: 1 };
    const { stores, tasks, logs } = mockWaitStores(config);
    let releaseA!: () => void;
    const gateA = new Promise<void>((r) => { releaseA = r; });
    const pA = withChannelSlot(stores, "image", "img-ch", async () => { await gateA; }, waitReasonHooks(stores, "task-A", "log-A"));
    await new Promise((r) => setTimeout(r, 10));
    const pB = withChannelSlot(stores, "image", "img-ch", async () => undefined, waitReasonHooks(stores, "task-B", "log-B"));
    await new Promise((r) => setTimeout(r, 10));
    assert.match(String(logs.get("log-B")!.params.waitReason || ""), /渠道并发已满/);
    releaseA();
    await Promise.all([pA, pB]);
    assert.equal(String(logs.get("log-B")!.params.waitReason || ""), "", "开始执行时应清空");
    assert.equal(String(tasks.get("task-B")!.params.waitReason || ""), "", "任务侧同样清空");
    assert.deepEqual(channelConcurrency.stats("image:img-ch"), { active: 0, waiting: 0 });
    channelConcurrency.reset();
});

test("真实 BackendDatabase：waitReason 落库不丢 generationSettings，执行前清空", async (t) => {
    channelConcurrency.reset();
    const db = new BackendDatabase(":memory:");
    t.after(() => db.close());
    const stores = createStores(db);
    stores.settings.set("ai.config", { channelConcurrency: 1 });
    const newLog = () => stores.logs.create({
        projectId: "p", status: "running", platform: "canvas-video", model: "video::m",
        references: [], inputCounts: {}, startedAt: new Date().toISOString(), durationMs: 0, outputs: [],
        params: { generationSettings: { size: "1280x720" } },
    });
    const logA = newLog();
    const logB = newLog();
    stores.tasks.create("task-wait-A", "canvas-video", {}, {});
    stores.tasks.create("task-wait-B", "canvas-video", {}, {});
    let releaseA!: () => void;
    const gateA = new Promise<void>((r) => { releaseA = r; });
    const pA = withChannelSlot(stores, "video", "video-ch", async () => { await gateA; }, waitReasonHooks(stores, "task-wait-A", logA.id));
    await new Promise((r) => setTimeout(r, 10));
    const pB = withChannelSlot(stores, "video", "video-ch", async () => undefined, waitReasonHooks(stores, "task-wait-B", logB.id));
    await new Promise((r) => setTimeout(r, 10));
    const queued = db.getGenerationLog(logB.id)!;
    assert.equal(queued.params.waitReason, channelWaitReason("video", 1, 0));
    assert.deepEqual(queued.params.generationSettings, { size: "1280x720" }, "补写等待原因不能冲掉已有 params");
    assert.equal(db.getTask("task-wait-B")!.params.waitReason, channelWaitReason("video", 1, 0));
    releaseA();
    await Promise.all([pA, pB]);
    const finished = db.getGenerationLog(logB.id)!;
    assert.equal(finished.params.waitReason, "", "拿到槽位后清空");
    assert.equal(db.getTask("task-wait-B")!.params.waitReason, "", "任务侧同步清空");
    channelConcurrency.reset();
});
