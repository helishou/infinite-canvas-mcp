import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { BackendDatabase } from "../db.js";
import { createStores } from "../stores/index.js";
import { CanvasVideoDispatcher, CANVAS_VIDEO_CONCAT_MODEL } from "./video-dispatcher.js";

function fixture(t: TestContext, pending = false) {
    const db = new BackendDatabase(":memory:");
    t.after(() => db.close());
    db.createCanvasProject({ id: "p", nodes: [
        { id: "source", type: "config", position: { x: 0, y: 0 }, width: 320, height: 240, metadata: {} },
        { id: "video", type: "video", position: { x: 416, y: 0 }, width: 340, height: 190, metadata: { prompt: "旧提示" } },
    ], connections: [{ id: "c", fromNodeId: "source", toNodeId: "video" }] });
    const stores = createStores(db);
    stores.settings.set("ai.config", { channels: [{ id: "local", kind: "comfyui", models: [{ name: "movie", workflowRouting: { text: "movie.json", single: "movie.json", multi: "movie.json" } }] }] });
    let calls = 0;
    const rejects = new Map<string, (error: Error) => void>();
    const executor = {
        run: (...args: any[]) => {
            calls++;
            const id = args[6];
            stores.tasks.create(id, "workflow", {}, { parentTaskId: args[9] });
            if (pending) return new Promise((_resolve, reject) => rejects.set(id, reject));
            stores.tasks.update(id, { status: "succeeded", result: { media: [{ url: "video.mp4", storageKey: "video:key", mimeType: "video/mp4", width: 1280, height: 720 }] } });
            return Promise.resolve({ taskId: id, media: [{ url: "video.mp4", storageKey: "video:key", mimeType: "video/mp4", width: 1280, height: 720 }] });
        },
        cancel: (id: string) => { stores.tasks.cancel(id); rejects.get(id)?.(new Error("已取消")); },
    };
    const workflows = { get: async () => ({ workflow: {}, config: { title: "movie", backend: "", operation: "", description: "", fields: [] } }) };
    const dispatcher = new CanvasVideoDispatcher(stores, { cancel: () => {} } as never, workflows as never, executor as never, { cancel: () => {} } as never);
    const input = { projectId: "p", nodeId: "video", sourceNodeId: "source", model: "local::movie", prompt: "电影", clientTaskId: "outer" };
    const node = (id: string) => (db.getCanvasProject("p")!.nodes as Array<Record<string, any>>).find((item) => item.id === id)!;
    return { db, stores, dispatcher, input, node, calls: () => calls };
}

async function settle(db: BackendDatabase, id = "outer") {
    for (let index = 0; index < 100 && ["queued", "running"].includes(db.getTask(id)!.status); index++) await new Promise((resolve) => setTimeout(resolve, 5));
}

test("普通 Comfy 视频绑定父任务，结果经 ops 原地回写并保留运行中布局", async (t) => {
    const { db, dispatcher, input, node, calls } = fixture(t);
    dispatcher.start(input);
    assert.equal(node("video").metadata.runtimeTaskId, "outer");
    assert.equal(node("source").metadata.runtimeTaskId, "outer");
    db.applyCanvasProjectOperations("p", undefined, [{ type: "update_node", id: "video", patch: { position: { x: 900, y: 500 }, width: 777, height: 333 } }]);
    await settle(db);
    assert.equal(calls(), 1);
    assert.equal(db.getTask("outer")!.status, "succeeded");
    assert.equal(node("video").metadata.content, "video.mp4");
    assert.deepEqual(node("video").position, { x: 900, y: 500 });
    assert.equal(node("video").width, 777);
    assert.equal(node("source").metadata.status, "success");
    assert.equal((db.getCanvasProject("p")!.nodes as unknown[]).length, 2);
    assert.ok(db.readCanvasChanges("p", 0).commits.some((commit) => commit.operationId === "video-task-result:outer"));
});

test("普通视频取消覆盖子任务，迟到失败不覆盖取消；重试换绑新父任务", async (t) => {
    const { db, dispatcher, input, node } = fixture(t, true);
    dispatcher.start(input);
    await new Promise((resolve) => setImmediate(resolve));
    dispatcher.cancel("outer");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(db.getTask("outer")!.status, "cancelled");
    assert.equal(node("video").metadata.status, "cancelled");
    assert.equal(node("video").metadata.runtimeTaskId, undefined);
    const retried = dispatcher.retry(db.getTask("outer")!);
    assert.match(retried.id, /^canvas-video-retry-/);
    assert.equal(node("video").metadata.runtimeTaskId, retried.id);
    dispatcher.cancel(retried.id);
});

test("视频恢复只认原绑定；已成功子任务直接采用，不二次运行工作流", async (t) => {
    const { db, stores, dispatcher, input, node, calls } = fixture(t);
    const task = stores.tasks.create("resume", "canvas-video", { ...input, clientTaskId: undefined }, {});
    stores.tasks.create("video-workflow-child-resume", "workflow", {}, {});
    stores.tasks.update("video-workflow-child-resume", { status: "succeeded", result: { media: [{ url: "resumed.mp4", mimeType: "video/mp4" }] } });
    db.applyCanvasProjectOperations("p", undefined, [{ type: "update_node", id: "video", metadata: { runtimeTaskId: "resume", status: "loading" } }], { runtimeWrite: true });
    dispatcher.resume(task);
    await settle(db, "resume");
    assert.equal(calls(), 0);
    assert.equal(node("video").metadata.content, "resumed.mp4");
    const orphan = stores.tasks.create("orphan", "canvas-video", { ...input, clientTaskId: undefined }, {});
    db.applyCanvasProjectOperations("p", undefined, [{ type: "update_node", id: "video", metadata: { runtimeTaskId: "new" } }], { runtimeWrite: true });
    dispatcher.resume(orphan);
    assert.equal(db.getTask("orphan")!.status, "failed");
    assert.equal(node("video").metadata.runtimeTaskId, "new");
});

test("视频拼接也使用 canvas-video 父任务和固定子任务 ID", async (t) => {
    const { db, stores, input, node } = fixture(t);
    const media = stores.media.store(Buffer.from("video"), { name: "clip.mp4", mimeType: "video/mp4", category: "input" });
    let childId = "";
    const concat = { run: (_videos: string[], _output: string, _edge: unknown, id: string, parent: string) => {
        childId = id; stores.tasks.create(id, "video-concat", {}, { parentTaskId: parent });
        return stores.tasks.update(id, { status: "succeeded", result: { media: { url: "joined.mp4", mimeType: "video/mp4" } } });
    }, cancel: () => {} };
    const dispatcher = new CanvasVideoDispatcher(stores, {} as never, {} as never, {} as never, concat as never);
    dispatcher.start({ ...input, model: CANVAS_VIDEO_CONCAT_MODEL, videoReferences: [{ storageKey: media.storageKey }] });
    await settle(db);
    assert.equal(childId, "video-concat-child-outer");
    assert.equal(node("video").metadata.content, "joined.mp4");
});

test("从 MCP 配置节点触发视频时先创建唯一结果节点再绑定任务", async (t) => {
    const { db, stores, dispatcher, input } = fixture(t);
    dispatcher.start({ ...input, nodeId: "source", sourceNodeId: undefined, clientTaskId: "config-video" });
    await settle(db, "config-video");
    const project = db.getCanvasProject("p")!;
    const nodes = project.nodes as Array<Record<string, any>>;
    const output = nodes.find((node) => node.id === "video-config-video");
    assert.equal(output?.type, "video");
    assert.equal(output?.metadata?.status, "success");
    assert.equal(output?.metadata?.content, "video.mp4");
    assert.equal(nodes.length, 3);
    assert.ok(stores.tasks.get("config-video"));
});

test("智能循环视频轮次各有独立节点，重跑保留旧媒体并复用节点", async (t) => {
    const { db, stores, dispatcher, input, node } = fixture(t);
    stores.projects.applyOperations("p", Number(stores.projects.get("p")!.revision || 0), [
        { type: "add_node", id: "loop", nodeType: "loop", title: "循环", position: { x: -480, y: 0 }, width: 380, height: 320, metadata: {} },
        { type: "connect_nodes", id: "loop-video", fromNodeId: "loop", toNodeId: "video" },
    ], { runtimeWrite: true });
    const base = { ...input, sourceNodeId: "video", loopOutput: { loopNodeId: "loop", roundIndex: 1, slotIndex: 0 } };
    dispatcher.start({ ...base, clientTaskId: "round-1" });
    dispatcher.start({ ...base, clientTaskId: "round-2", loopOutput: { loopNodeId: "loop", roundIndex: 2, slotIndex: 1 } });
    await Promise.all([settle(db, "round-1"), settle(db, "round-2")]);
    const slots = (db.getCanvasProject("p")!.nodes as Array<Record<string, any>>).filter((item) => item.metadata?.loopOutputSlot);
    assert.equal(slots.length, 2);
    assert.equal(node("video").metadata.runtimeTaskId, undefined);
    const first = slots.find((item) => item.metadata.loopRoundIndex === 1)!;
    assert.equal(first.metadata.status, "success");
    dispatcher.start({ ...base, clientTaskId: "round-1-again" });
    await settle(db, "round-1-again");
    const rerun = (db.getCanvasProject("p")!.nodes as Array<Record<string, any>>).filter((item) => item.metadata?.loopOutputSlot);
    assert.equal(rerun.length, 2);
    assert.equal(rerun.find((item) => item.metadata.loopRoundIndex === 1)?.id, first.id);
    assert.equal(rerun.find((item) => item.metadata.loopRoundIndex === 1)?.metadata.loopOutputHistory?.length, 1);
    const retried = dispatcher.retry(db.getTask("round-1")!);
    await settle(db, retried.id);
    const afterRetry = (db.getCanvasProject("p")!.nodes as Array<Record<string, any>>).filter((item) => item.metadata?.loopOutputSlot);
    assert.equal(afterRetry.length, 2);
    assert.equal(afterRetry.find((item) => item.metadata.loopRoundIndex === 1)?.metadata.loopOutputHistory?.length, 2);
});
