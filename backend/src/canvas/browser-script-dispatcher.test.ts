import assert from "node:assert/strict";
import test from "node:test";

import { BackendDatabase } from "../db.js";
import { BackendEventBus } from "../events.js";
import { createStores } from "../stores/index.js";
import { CanvasBrowserScriptDispatcher } from "./browser-script-dispatcher.js";
import { CanvasTextDispatcher } from "./text-dispatcher.js";

function fixture(t: import("node:test").TestContext) {
    const db = new BackendDatabase(":memory:");
    t.after(() => db.close());
    db.createCanvasProject({ id: "p", nodes: [{ id: "source", type: "config", title: "文本生成", position: { x: 0, y: 0 }, width: 320, height: 200, metadata: {} }], connections: [] });
    const stores = createStores(db);
    const text = new CanvasTextDispatcher({ url: "http://unused.local" } as never, stores, async () => { throw new Error("不应由 Backend 调模型"); });
    const dispatcher = new CanvasBrowserScriptDispatcher(stores, new BackendEventBus(), text);
    const input = { mode: "text" as const, projectId: "p", nodeId: "source", model: "c::custom-text", prompt: "测试", clientTaskId: "browser-1" };
    const metadata = () => (db.getCanvasProject("p")!.nodes as Array<{ metadata: Record<string, unknown> }>)[0].metadata;
    return { db, stores, dispatcher, input, metadata };
}

test("浏览器脚本任务由 Backend 绑定、单实例认领并原子回写文本", (t) => {
    const { db, dispatcher, input, metadata } = fixture(t);
    const started = dispatcher.start(input, "return '浏览器结果'");
    assert.equal(started.executor, "browser-script");
    assert.equal(metadata().runtimeTaskId, "browser-1");
    assert.equal(db.getTask("browser-1")!.status, "queued");

    dispatcher.claim("browser-1", "tab-a");
    assert.equal(db.getTask("browser-1")!.status, "running");
    assert.throws(() => dispatcher.claim("browser-1", "tab-b"), /另一个浏览器/);

    dispatcher.complete("browser-1", "tab-a", { texts: ["浏览器结果"] });
    assert.equal(db.getTask("browser-1")!.status, "succeeded");
    assert.equal(metadata().runtimeTaskId, undefined);
    assert.equal(metadata().status, "success");
    const result = (db.getCanvasProject("p")!.nodes as Array<{ type: string; metadata: Record<string, unknown> }>).find((node) => node.type === "text");
    assert.equal(result?.metadata.content, "浏览器结果");
    assert.throws(() => dispatcher.complete("browser-1", "tab-a", { texts: ["迟到结果"] }), /状态 succeeded/);
});

test("显式释放可由另一标签页继续；Backend 重启不自动重跑已认领脚本", (t) => {
    const { db, dispatcher, input, metadata } = fixture(t);
    dispatcher.start(input, "return '结果'");
    dispatcher.claim("browser-1", "tab-a");
    dispatcher.release("browser-1", "tab-a");
    assert.equal(db.getTask("browser-1")!.status, "queued");
    dispatcher.claim("browser-1", "tab-b");
    dispatcher.resume(db.getTask("browser-1")!);
    assert.equal(db.getTask("browser-1")!.status, "failed");
    assert.match(String(db.getTask("browser-1")!.error), /手动重试/);
    assert.equal(metadata().status, "error");
    assert.equal(metadata().runtimeTaskId, undefined);
});

test("无自定义脚本的遗留浏览器 provider 也使用同一认领与回写协议", (t) => {
    const { db, dispatcher, input } = fixture(t);
    const started = dispatcher.start({ ...input, clientTaskId: "browser-provider-1", model: "gemini::gemini-text" }, "", "browser-provider");
    assert.equal(started.executor, "browser-provider");
    assert.equal(db.getTask(started.taskId)!.executor, "browser-provider");
    dispatcher.claim(started.taskId, "tab-a");
    dispatcher.complete(started.taskId, "tab-a", { texts: ["浏览器渠道结果"] });
    const result = (db.getCanvasProject("p")!.nodes as Array<{ type: string; metadata: Record<string, unknown> }>).find((node) => node.type === "text");
    assert.equal(result?.metadata.content, "浏览器渠道结果");
});

test("浏览器图片渠道也由 Backend 创建并绑定统一结果节点", (t) => {
    const { db, stores, dispatcher, input } = fixture(t);
    const started = dispatcher.start({ ...input, mode: "image", clientTaskId: "browser-image-1", model: "gemini::image", count: 1 }, "", "browser-provider");
    const before = db.getCanvasProject("p")!;
    const target = (before.nodes as Array<Record<string, any>>).find((node) => node.id === "image-browser-image-1")!;
    assert.equal(target.metadata.runtimeTaskId, started.taskId);
    assert.deepEqual(target.position, { x: 416, y: 0 });
    const media = stores.media.store(Buffer.from("image"), { name: "result.png", mimeType: "image/png", category: "output" });
    dispatcher.claim(started.taskId, "tab-a");
    dispatcher.complete(started.taskId, "tab-a", { media: [media.storageKey] });
    const output = (db.getCanvasProject("p")!.nodes as Array<Record<string, any>>).find((node) => node.id === target.id)!;
    assert.equal(output.metadata.storageKey, media.storageKey);
    assert.equal(output.metadata.status, "success");
});
