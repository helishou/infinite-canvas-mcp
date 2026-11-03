import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { BackendDatabase } from "./db.js";
import { startServer } from "./server.js";
import { registerBackendMcpHttpRoutes } from "./mcp.js";

/** P7b 夹具 M：一批任务收敛成一次回执 —— 成了什么、卡了什么、还差什么。
 *  折叠计算与提交工具共用同一份（applyWaitFold → waitForCanvasTasks → foldWaitFields），
 *  这里通过 canvas_wait_tasks 走同一条链路验证回执形状与分级。 */

test("wait receipt folds outputs, pending and blocked in one call", async t => {
    const originalToken = process.env.INFINITE_CANVAS_BACKEND_TOKEN;
    process.env.INFINITE_CANVAS_BACKEND_TOKEN = "fixture";
    t.after(() => { if (originalToken === undefined) delete process.env.INFINITE_CANVAS_BACKEND_TOKEN; else process.env.INFINITE_CANVAS_BACKEND_TOKEN = originalToken; });
    const db = new BackendDatabase(":memory:");
    db.createCanvasProject({ id: "fold", title: "Wait fold fixture", revision: 0, nodes: [{ id: "h3", type: "minimax-h3:video", metadata: { segments: [] } }], connections: [] });
    const binding = { projectId: "fold", nodeId: "h3" };

    const okTask = db.createTask("fold-ok", "comfyui:minimax-h3", { ...binding, segmentId: "clip-1" }, { canvasBinding: { ...binding, segmentId: "clip-1" } });
    db.updateTask(okTask.id, { status: "succeeded", progress: 1, result: { media: [{ storageKey: "video:seg1" }], specification: { status: "passed", measured: { width: 1088, height: 1920, rotation: 0 } } } });
    const badTask = db.createTask("fold-bad", "comfyui:minimax-h3", { ...binding, segmentId: "clip-2" }, { canvasBinding: { ...binding, segmentId: "clip-2" } });
    db.updateTask(badTask.id, { status: "failed", progress: 1, error: "Error: spawn ffprobe ENOENT" });

    const config = { url: "http://127.0.0.1", port: 0, token: "fixture", origins: ["*"] };
    const { app } = startServer(db, config);
    const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const routes = registerBackendMcpHttpRoutes(app, { ...config, url });
    const client = new Client({ name: "wait-fold", version: "1" });
    t.after(async () => { await client.close(); await routes.closeAll(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); db.close(); });
    await client.connect(new StreamableHTTPClientTransport(new URL(url + "/mcp")));

    const call = async (name: string, args: Record<string, unknown>) => {
        const result: any = await client.callTool({ name, arguments: args });
        assert.notEqual(result.isError, true, JSON.stringify(result));
        return JSON.parse(result.content.find((item: any) => item.type === "text").text);
    };

    // 一次调用：两段产物 + 失败分级同时到位，不需要再逐个 canvas_task_status。
    const wait = await call("canvas_wait_tasks", { taskIds: [okTask.id, badTask.id], timeoutMs: 5_000 });
    assert.equal(wait.status, "partial");
    assert.deepEqual(wait.pending, []);
    assert.equal(wait.outputs.length, 1);
    assert.equal(wait.outputs[0].taskId, okTask.id);
    assert.equal(wait.outputs[0].storageKey, "video:seg1");
    // 规格从任务自身的 specification 透传（归档时的 probe 结果），不额外核验。
    assert.equal(wait.outputs[0].width, 1088);
    assert.equal(wait.outputs[0].height, 1920);
    assert.equal(wait.outputs[0].specification.status, "passed");
    assert.equal(wait.blocked.length, 1);
    assert.equal(wait.blocked[0].taskId, badTask.id);
    // P7a 分级在这里接上：环境问题不该被当成内容问题重提。
    assert.equal(wait.blocked[0].code, "MEDIA_TOOL_MISSING");
    assert.equal(wait.blocked[0].scope, "environment");
    assert.equal(wait.blocked[0].doNotRetry, true);
    // 既有字段不受影响：旧消费方仍可读 tasks/summary。
    assert.equal(wait.tasks.length, 2);
    assert.equal(wait.summary.total, 2);
    // 进度比例让「还要不要继续等」可判定，不必 wait → get_batch → wait。
    assert.deepEqual(wait.progress, { complete: 2, total: 2, ratio: 1, pending: 0 });
    assert.equal(wait.canKeepWaiting, false);

    // 全部成功：status 折成 succeeded。
    const allOk = await call("canvas_wait_tasks", { taskIds: [okTask.id], timeoutMs: 5_000 });
    assert.equal(allOk.status, "succeeded");
    assert.deepEqual(allOk.blocked, []);

    // 提交类工具必须真的声明该参数，否则「看起来支持、其实没等」。
    const catalog = (await client.listTools()).tools;
    for (const name of ["canvas_generate_image", "canvas_generate_image_batch"]) {
        const tool = catalog.find((item) => item.name === name)!;
        assert.ok(tool, `${name} 未注册`);
        assert.ok(tool.inputSchema.properties?.waitForCompletion, `${name} 缺少 waitForCompletion`);
    }
    const h3 = catalog.find((item) => item.name === "h3_run_all_clips");
    if (h3) assert.ok(h3.inputSchema.properties?.waitForCompletion, "h3_run_all_clips 缺少 waitForCompletion");
});
