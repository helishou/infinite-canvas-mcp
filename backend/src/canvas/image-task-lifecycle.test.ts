import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { BackendDatabase } from "../db.js";
import { createStores } from "../stores/index.js";
import { CanvasImageDispatcher } from "./image-dispatcher.js";

function fixture(t: TestContext, childStatus: "queued" | "succeeded" | "failed" = "succeeded") {
    const db = new BackendDatabase(":memory:");
    t.after(() => db.close());
    db.createCanvasProject({ id: "p", nodes: [{ id: "source", type: "config", metadata: {} }], connections: [] });
    const stores = createStores(db);
    let calls = 0;
    const direct = {
        supports: () => true,
        run: (request: { count?: number }, _hooks: unknown, id: string) => {
            calls++;
            stores.tasks.create(id, "direct-image", {}, {});
            return stores.tasks.update(id, { status: childStatus, error: childStatus === "failed" ? "模拟模型失败" : null,
                result: { media: Array.from({ length: request.count || 1 }, (_, index) => ({ url: `http://unused.local/test-${index}.png`, storageKey: `fixture-${index}`, mimeType: "image/png", width: 1280, height: 720 })) } });
        },
        cancel: () => {},
    };
    const dispatcher = new CanvasImageDispatcher({ url: "http://unused.local" } as never, stores, {} as never, direct as never, {} as never, {} as never);
    const input = { projectId: "p", nodeId: "source", model: "gpt-image-2", prompt: "测试", clientTaskId: "first", resultPolicy: "append" as const };
    const metadata = () => (db.getCanvasProject("p")!.nodes as Array<{ metadata: Record<string, unknown> }>)[0].metadata;
    return { db, stores, dispatcher, input, metadata, calls: () => calls };
}

async function settle(db: BackendDatabase, id: string) {
    for (let i = 0; i < 100 && ["queued", "running"].includes(db.getTask(id)!.status); i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(!["queued", "running"].includes(db.getTask(id)!.status), "图片测试任务未进入终态");
}

test("图片执行器自绑定与重试，先回写结果再发布成功，不依赖 MCP 预写", async (t) => {
    const { db, stores, dispatcher, input, metadata, calls } = fixture(t);
    const writeBack = stores.projects.writeBackCanvasImageTask;
    stores.projects.writeBackCanvasImageTask = (task, binding, media) => {
        assert.equal(db.getTask(task.id)!.status, "running", "尚未回写不能先发布 succeeded");
        return writeBack(task, binding, media);
    };
    dispatcher.start(input);
    assert.equal(metadata().runtimeTaskId, "first");
    const revision = Number(db.getCanvasProject("p")!.revision);
    dispatcher.start(input);
    assert.equal(db.getCanvasProject("p")!.revision, revision);
    await settle(db, "first");
    assert.equal(metadata().status, "success");
    assert.equal(metadata().runtimeTaskId, undefined);
    const retried = await dispatcher.retry(db.getTask("first")!);
    assert.equal(metadata().runtimeTaskId, retried.id);
    await settle(db, retried.id);
    const output = (db.getCanvasProject("p")!.nodes as Array<Record<string, any>>).find((node) => node.type === "image")!;
    assert.equal(output.metadata.generationTaskId, retried.id);
    assert.equal((db.getCanvasProject("p")!.nodes as unknown[]).length, 2);
    assert.equal(calls(), 2);
    assert.ok(db.readCanvasChanges("p", 0).commits.some((commit) => commit.operationId === `image-task-bind:${retried.id}`));
});

test("图片取消发生在参考准备期时不启动子任务，节点和日志保持取消", async (t) => {
    const { db, stores, dispatcher, input, metadata, calls } = fixture(t);
    dispatcher.start(input);
    dispatcher.cancel("first");
    const before = db.getCanvasProject("p");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls(), 0);
    assert.equal(db.getTask("first")!.status, "cancelled");
    assert.equal(metadata().status, "cancelled");
    assert.deepEqual(db.getCanvasProject("p"), before);
    assert.equal(stores.logs.list({ runtimeTaskId: "first" })[0].status, "cancelled");
});

test("图片子执行器忽略取消并迟到成功，不能覆盖取消状态或回写画布", async (t) => {
    const { db, stores, dispatcher, input, calls } = fixture(t, "queued");
    dispatcher.start(input);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls(), 1);
    dispatcher.cancel("first");
    const before = db.getCanvasProject("p");
    stores.tasks.update("image-child-first", { status: "succeeded" });
    // 等现有 500ms 子任务轮询收到迟到结果；这是测试等待，不修改产品轮询频率。
    await new Promise((resolve) => setTimeout(resolve, 550));
    assert.equal(db.getTask("first")!.status, "cancelled");
    assert.deepEqual(db.getCanvasProject("p"), before);
    assert.equal(stores.logs.list({ runtimeTaskId: "first" })[0].status, "cancelled");
});

test("图片失败与丢失绑定恢复只处理原目标，不能接管新任务", async (t) => {
    const { db, stores, dispatcher, input, metadata, calls } = fixture(t, "failed");
    dispatcher.start(input);
    await settle(db, "first");
    assert.equal(metadata().status, "error");
    assert.equal(metadata().runtimeTaskId, undefined);
    const orphan = stores.tasks.create("orphan", "canvas-image", input, {});
    db.applyCanvasProjectOperations("p", undefined, [{ type: "update_node", id: "source", metadata: { runtimeTaskId: "new", status: "loading" } }], { runtimeWrite: true });
    const before = db.getCanvasProject("p");
    dispatcher.resume(orphan);
    assert.equal(db.getTask("orphan")!.status, "failed");
    assert.deepEqual(db.getCanvasProject("p"), before);
    assert.equal(calls(), 1);
});

test("图片绑定落库失败不能启动执行器，已有画布与结果保留", (t) => {
    const { db, stores, dispatcher, input, calls } = fixture(t);
    const before = db.getCanvasProject("p");
    stores.projects.applyOperations = () => { throw new Error("模拟持久化失败"); };
    assert.throws(() => dispatcher.start(input), /模拟持久化失败/);
    assert.equal(db.getTask("first")!.status, "failed");
    assert.equal(calls(), 0);
    assert.deepEqual(db.getCanvasProject("p"), before);
});

function slots(db: BackendDatabase, ids = ["a", "b", "c"]) {
    db.applyCanvasProjectOperations("p", undefined, [{ type: "add_node", id: "output", nodeType: "image", title: "批量图片",
        position: { x: 400, y: 50 }, width: 340, height: 240,
        metadata: { images: ids.map((id) => ({ id, status: "idle", content: `old-${id}` })) } }]);
    return () => (db.getCanvasProject("p")!.nodes as Array<Record<string, any>>).find((node) => node.id === "output")!;
}

test("一批 GPT 图片只提交一次，结果原地聚合并广播，不产生第二组结果节点", async (t) => {
    const { db, dispatcher, input, calls, metadata } = fixture(t);
    const output = slots(db);
    const command = { ...input, nodeId: "output", sourceNodeId: "source", imageIds: ["a", "b", "c"], count: 3 };
    dispatcher.start(command);
    const revision = Number(db.getCanvasProject("p")!.revision);
    dispatcher.start(command);
    assert.equal(db.getCanvasProject("p")!.revision, revision);
    assert.equal(metadata().runtimeTaskId, "first");
    assert.ok(output().metadata.images.every((image: any) => image.status === "loading"));
    await settle(db, "first");
    assert.equal(calls(), 1);
    assert.equal((db.getCanvasProject("p")!.nodes as unknown[]).length, 2);
    assert.equal(metadata().runtimeTaskId, undefined);
    assert.equal(metadata().status, "success");
    assert.deepEqual(output().metadata.images.map((image: any) => image.content), [0, 1, 2].map((index) => `http://unused.local/test-${index}.png`));
    assert.equal(output().metadata.content, undefined, "多图保持折叠");
    const commits = db.readCanvasChanges("p", revision).commits;
    assert.ok(commits.some((commit) => commit.operationId === "image-task-result:first"));
});

test("单槽重试保留其他槽位、远端主图选择及运行中拖动尺寸", async (t) => {
    const { db, dispatcher, input } = fixture(t, "queued");
    const output = slots(db);
    dispatcher.start({ ...input, nodeId: "output", sourceNodeId: "source", imageIds: ["b"] });
    await new Promise((resolve) => setImmediate(resolve));
    db.applyCanvasProjectOperations("p", undefined, [{ type: "update_node", id: "output", patch: { position: { x: 900, y: 600 }, width: 777, height: 333 },
        metadata: { primaryImageId: "a", content: "old-a", images: output().metadata.images.filter((image: any) => image.id !== "c") } }]);
    db.updateTask("image-child-first", { status: "succeeded" });
    await new Promise((resolve) => setTimeout(resolve, 550));
    await settle(db, "first");
    assert.deepEqual(output().position, { x: 900, y: 600 });
    assert.equal(output().width, 777);
    assert.equal(output().height, 333);
    assert.equal(output().metadata.primaryImageId, "a");
    assert.equal(output().metadata.content, "old-a");
    assert.deepEqual(output().metadata.images.map((image: any) => image.id), ["a", "b"]);
    assert.equal(output().metadata.images[1].status, "success");
});

test("单图按原始比例展示，已删除槽不复活；取消只结束绑定槽", async (t) => {
    const { db, dispatcher, input } = fixture(t);
    const output = slots(db, ["a"]);
    dispatcher.start({ ...input, nodeId: "output", imageIds: ["a"] });
    await settle(db, "first");
    assert.equal(output().metadata.primaryImageId, "a");
    assert.equal(output().width / output().height, 1280 / 720);
    assert.deepEqual(output().position, { x: 400, y: 50 });
    dispatcher.start({ ...input, clientTaskId: "cancel", nodeId: "output", imageIds: ["a"] });
    dispatcher.cancel("cancel");
    assert.equal(output().metadata.images[0].status, "cancelled");
    assert.equal(output().metadata.images[0].content, "http://unused.local/test-0.png");
    db.applyCanvasProjectOperations("p", undefined, [{ type: "update_node", id: "output", metadata: { runtimeTaskId: "late", images: [] } }], { runtimeWrite: true });
    db.writeBackCanvasImageTask({ id: "late", input: {}, params: {} } as never,
        { projectId: "p", nodeId: "output", prompt: "", model: "", imageIds: ["a"] }, [{ url: "late.png" }]);
    assert.deepEqual(output().metadata.images, []);
    assert.throws(() => dispatcher.start({ ...input, clientTaskId: "bad", nodeId: "output", imageIds: ["missing"] }), /结果槽/);
    assert.equal(db.getTask("bad"), null);
});

test("插件内置图片面板通过统一任务原位回写，不创建额外图片节点", async (t) => {
    const { db, dispatcher, input } = fixture(t);
    dispatcher.start({ ...input, params: { writeBackToTarget: true } });
    await settle(db, "first");
    const project = db.getCanvasProject("p")!;
    const source = (project.nodes as Array<Record<string, any>>).find((node) => node.id === "source")!;
    assert.equal((project.nodes as unknown[]).length, 1);
    assert.equal(source.type, "config");
    assert.equal(source.metadata.content, "http://unused.local/test-0.png");
    assert.equal(source.metadata.status, "success");
    assert.equal(source.metadata.runtimeTaskId, undefined);
});

test("内置 Comfy 批量子任务归属同一父任务，部分失败不把后续结果错填前槽", async (t) => {
    const { db, stores, input } = fixture(t);
    const output = slots(db);
    const childIds: string[] = [];
    const comfy = { run: (_preset: string, _input: unknown, params: any, _url: unknown, id: string) => {
        childIds.push(id);
        assert.equal(params.parentTaskId, "first");
        stores.tasks.create(id, "comfyui", {}, params);
        return stores.tasks.update(id, { status: id.endsWith("-1") ? "failed" : "succeeded", error: "测试失败",
            result: { media: [{ url: `${id}.png` }] } });
    } };
    const dispatcher = new CanvasImageDispatcher({} as never, stores, comfy as never, { supports: () => false } as never, {} as never, {} as never);
    dispatcher.start({ ...input, model: "z-image", nodeId: "output", count: 3, imageIds: ["a", "b", "c"] });
    await settle(db, "first");
    assert.equal(new Set(childIds).size, 3);
    assert.equal(output().metadata.images[0].content, "comfy-child-first-0.png");
    assert.equal(output().metadata.images[1].status, "error");
    assert.equal(output().metadata.images[2].content, "comfy-child-first-2.png");
});

test("自定义工作流批量取消覆盖全部子任务，所有槽位保持取消", async (t) => {
    const { db, stores, input } = fixture(t);
    const output = slots(db, ["a", "b"]);
    stores.settings.set("ai.config", { channels: [{ id: "local", kind: "comfyui", models: [{ name: "custom", workflows: ["fixture.json"], workflowRouting: { text: "fixture.json" } }] }] });
    const pending = new Map<string, (error: Error) => void>();
    const cancelled: string[] = [];
    const executor = { run: (...args: any[]) => new Promise((_resolve, reject) => pending.set(args[6], reject)),
        cancel: (id: string) => { cancelled.push(id); pending.get(id)!(new Error("已取消")); } };
    const dispatcher = new CanvasImageDispatcher({} as never, stores, {} as never, { supports: () => false } as never,
        { get: async () => ({ workflow: {}, config: { fields: [] } }) } as never, executor as never);
    dispatcher.start({ ...input, model: "local::custom", nodeId: "output", count: 2, imageIds: ["a", "b"] });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(pending.size, 2);
    dispatcher.cancel("first");
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(cancelled.sort(), ["workflow-child-first-0", "workflow-child-first-1"]);
    assert.equal(db.getTask("first")!.status, "cancelled");
    assert.ok(output().metadata.images.every((image: any) => image.status === "cancelled"));
});
