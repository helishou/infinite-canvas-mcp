import assert from "node:assert/strict";
import test from "node:test";

import { CanvasTextDispatcher, requestOpenAiText } from "./text-dispatcher.js";
import { BackendDatabase } from "../db.js";
import { createStores } from "../stores/index.js";

test("OpenAI Responses 请求携带参考图并解析 output_text", async () => {
    const originalFetch = globalThis.fetch;
    let seenUrl = "";
    let seenBody: Record<string, unknown> = {};
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        seenUrl = String(url);
        seenBody = JSON.parse(String(init?.body || "{}"));
        return new Response(JSON.stringify({ output_text: "可见角色特征" }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
        const result = await requestOpenAiText({
            baseUrl: "http://127.0.0.1:8000/v1",
            apiKey: "test-key",
            apiFormat: "openai",
            model: "gpt-5-5",
            systemPrompt: "",
            reasoningEffort: "high",
        }, "只分析可见内容", ["data:image/png;base64,AA=="]);
        assert.equal(result, "可见角色特征");
        assert.equal(seenUrl, "http://127.0.0.1:8000/v1/responses");
        assert.equal(seenBody.model, "gpt-5-5");
        assert.equal((seenBody.reasoning as Record<string, unknown>).effort, "high");
        assert.match(JSON.stringify(seenBody.input), /data:image\/png;base64,AA==/);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("Responses 不可用时回退 Chat Completions", async () => {
    const originalFetch = globalThis.fetch;
    const seen: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
        seen.push(String(url));
        if (seen.length === 1) return new Response("not found", { status: 404 });
        return new Response(JSON.stringify({ choices: [{ message: { content: "回退成功" } }] }), { status: 200 });
    }) as typeof fetch;
    try {
        const result = await requestOpenAiText({ baseUrl: "http://127.0.0.1:8000", apiKey: "test-key", apiFormat: "openai", model: "gpt-5-5", systemPrompt: "", reasoningEffort: "auto" }, "分析", []);
        assert.equal(result, "回退成功");
        assert.deepEqual(seen, ["http://127.0.0.1:8000/v1/responses", "http://127.0.0.1:8000/v1/chat/completions"]);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("文本任务完成后原子追加结果节点并连接源配置节点", async () => {
    const taskId = "canvas-text-test";
    let task: any;
    const applied: Array<Record<string, unknown>> = [];
    const project = {
        id: "project-1",
        revision: 7,
        nodes: [{ id: "config-1", type: "config", title: "角色卡反推", position: { x: 10, y: 20 }, width: 320, height: 240, metadata: { runtimeTaskId: taskId } }],
        connections: [],
    };
    const stores: any = {
        tasks: {
            get: (id: string) => id === taskId ? task : undefined,
            list: () => [],
            create: (id: string, kind: string, input: unknown, params: unknown) => { task = { id, kind, input, params, status: "queued", progress: 0, createdAt: "", updatedAt: "" }; return task; },
            update: (_id: string, patch: Record<string, unknown>) => { task = { ...task, ...patch }; return task; },
            addEvent: () => undefined,
        },
        settings: {
            get: () => ({ channels: [{ id: "channel-1", baseUrl: "http://127.0.0.1:8000/v1", apiKey: "test-key", apiFormat: "openai", models: [{ name: "gpt-5-5" }] }] }),
        },
        projects: {
            get: () => project,
            applyOperations: (_id: string, _revision: number, operations: Array<Record<string, unknown>>) => { applied.push(...operations); return project; },
        },
        media: { read: () => Buffer.from([0]), store: () => ({ storageKey: "image:stored", url: "/media/stored" }) },
    };
    const dispatcher = new CanvasTextDispatcher({ url: "http://127.0.0.1:17370" } as any, stores, async () => "脸部与服装特征");
    const started = dispatcher.start({
        projectId: project.id,
        nodeId: "config-1",
        model: "channel-1::gpt-5-5",
        prompt: "分析参考图",
        clientTaskId: taskId,
        resultPolicy: "append",
    });
    assert.equal(started.executor, "direct-text");
    for (let index = 0; index < 50 && !["succeeded", "failed"].includes(task?.status); index += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(task.status, "succeeded");
    const added = applied.find((operation) => operation.type === "add_node") as any;
    assert.equal(added.nodeType, "text");
    assert.equal(added.metadata.content, "脸部与服装特征");
    assert.ok(applied.some((operation) => operation.type === "connect_nodes" && operation.fromNodeId === "config-1" && operation.toNodeId === added.id));
    assert.ok(applied.some((operation) => operation.type === "update_node" && operation.id === "config-1"));
});

function liveFixture(t: import("node:test").TestContext, request: (...args: any[]) => Promise<string>) {
    const db = new BackendDatabase(":memory:");
    t.after(() => db.close());
    db.createCanvasProject({ id: "p", nodes: [{ id: "source", type: "config", metadata: {} }], connections: [] });
    const stores = createStores(db);
    stores.settings.set("ai.config", { channels: [{ id: "c", baseUrl: "http://unused.local/v1", apiKey: "test", models: [{ name: "gpt-5-5" }] }] });
    const dispatcher = new CanvasTextDispatcher({ url: "http://unused.local" } as any, stores, request);
    const input = { projectId: "p", nodeId: "source", model: "c::gpt-5-5", prompt: "测试", clientTaskId: "original" };
    const metadata = () => (db.getCanvasProject("p")!.nodes as Array<{ metadata: Record<string, unknown> }>)[0].metadata;
    return { db, stores, dispatcher, input, metadata };
}

async function settle(db: BackendDatabase, id: string) {
    for (let i = 0; i < 100 && ["queued", "running"].includes(db.getTask(id)!.status); i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(!["queued", "running"].includes(db.getTask(id)!.status), "测试任务没有进入终态");
}

test("无 MCP 预写也绑定文本任务，重试换绑新 ID 并回写结果；重复请求不新增版本", async (t) => {
    let calls = 0;
    const { db, dispatcher, input, metadata } = liveFixture(t, async () => { if (++calls === 1) throw new Error("模拟首次失败"); return "重试结果"; });
    const first = dispatcher.start(input);
    assert.equal(metadata().runtimeTaskId, first.taskId);
    assert.equal(metadata().status, "loading");
    const revision = db.getCanvasProject("p")!.revision;
    assert.equal(dispatcher.start(input).taskId, first.taskId);
    assert.equal(db.getCanvasProject("p")!.revision, revision);
    await settle(db, first.taskId);
    assert.equal(metadata().status, "error");
    const retried = dispatcher.retry(db.getTask(first.taskId)!);
    assert.notEqual(retried.id, first.taskId);
    assert.equal(metadata().runtimeTaskId, retried.id);
    await settle(db, retried.id);
    assert.equal(metadata().status, "success");
    assert.equal(metadata().generationTaskId, retried.id);
    assert.equal(metadata().runtimeTaskId, undefined);
    assert.equal(calls, 2);
    assert.equal((db.getCanvasProject("p")!.nodes as Array<{ metadata: Record<string, unknown> }>)[1].metadata.content, "重试结果");
    const commits = db.readCanvasChanges("p", 0).commits;
    assert.ok(commits.some((commit) => commit.operationId === `text-task-bind:${retried.id}`));
});

test("取消后提供方迟到成功不回写、不改终态、不继续批量请求", async (t) => {
    let release!: (text: string) => void, started!: () => void, calls = 0;
    const requested = new Promise<void>((resolve) => { started = resolve; });
    const { db, dispatcher, input, metadata } = liveFixture(t, () => { calls++; started(); return new Promise((resolve) => { release = resolve; }); });
    dispatcher.start({ ...input, count: 2 });
    await requested;
    dispatcher.cancel(input.clientTaskId);
    const before = db.getCanvasProject("p");
    release("不应显示的迟到结果");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(db.getTask(input.clientTaskId)!.status, "cancelled");
    assert.equal(metadata().status, "cancelled");
    assert.equal(calls, 1);
    assert.deepEqual(db.getCanvasProject("p"), before);
});

test("恢复失去绑定的旧任务不调用模型、不接管新任务；无目标不建任务", (t) => {
    let calls = 0;
    const { db, stores, dispatcher, input } = liveFixture(t, async () => { calls++; return "不应调用"; });
    const old = stores.tasks.create("old", "canvas-text", input, {});
    db.applyCanvasProjectOperations("p", undefined, [{ type: "update_node", id: "source", metadata: { runtimeTaskId: "new", status: "loading" } }], { runtimeWrite: true });
    const before = db.getCanvasProject("p");
    dispatcher.resume(old);
    assert.equal(calls, 0);
    assert.equal(db.getTask(old.id)!.status, "failed");
    assert.deepEqual(db.getCanvasProject("p"), before);
    assert.throws(() => dispatcher.start({ ...input, nodeId: "missing" }), /目标不存在/);
    assert.equal(db.getTask(input.clientTaskId), null);
});

test("绑定持久化失败不调用模型，恢复时也不能盲目重绑", (t) => {
    let calls = 0;
    const { db, stores, dispatcher, input } = liveFixture(t, async () => { calls++; return "不应调用"; });
    stores.projects.applyOperations = () => { throw new Error("模拟落库失败"); };
    const before = db.getCanvasProject("p");
    assert.throws(() => dispatcher.start(input), /模拟落库失败/);
    assert.equal(calls, 0);
    assert.equal(db.getTask(input.clientTaskId)!.status, "failed");
    assert.deepEqual(db.getCanvasProject("p"), before);
});

test("插件文本任务通过统一执行器保留本次系统提示词", async (t) => {
    let systemPrompt = "";
    const { db, dispatcher, input } = liveFixture(t, async (provider: any) => {
        systemPrompt = provider.systemPrompt;
        return "强化结果";
    });
    dispatcher.start({ ...input, clientTaskId: "plugin-text", params: { systemPrompt: "只返回优化后的中文提示词" } });
    await settle(db, "plugin-text");
    assert.equal(systemPrompt, "只返回优化后的中文提示词");
    assert.equal(db.getTask("plugin-text")!.status, "succeeded");
});

test("文本结果重试通过 Backend 原位更新目标节点，不重复创建结果", async (t) => {
    const { db, dispatcher, input } = liveFixture(t, async () => "原位重试结果");
    db.applyCanvasProjectOperations("p", undefined, [{
        type: "add_node", nodeType: "text", id: "text-result", title: "旧结果",
        position: { x: 420, y: 0 }, width: 340, height: 240,
        metadata: { content: "旧文本", status: "success" },
    }, { type: "connect_nodes", id: "source-result", fromNodeId: "source", toNodeId: "text-result" }] as never);
    dispatcher.start({ ...input, clientTaskId: "retry-in-place", params: { targetTextNodeId: "text-result" } });
    await settle(db, "retry-in-place");
    const project = db.getCanvasProject("p")!;
    const nodes = project.nodes as Array<{ id: string; metadata: Record<string, unknown> }>;
    assert.equal(nodes.length, 2);
    assert.equal(nodes.find((node) => node.id === "text-result")!.metadata.content, "原位重试结果");
    assert.deepEqual(nodes.find((node) => node.id === "source")!.metadata.generatedTextResultIds, ["text-result"]);
    assert.throws(() => dispatcher.start({ ...input, clientTaskId: "missing-target", params: { targetTextNodeId: "missing" } }), /结果节点不存在/);
    assert.equal(db.getTask("missing-target"), null);
});
