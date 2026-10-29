import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { BackendDatabase } from "./db.js";
import { startServer } from "./server.js";
import { registerBackendMcpHttpRoutes } from "./mcp.js";
import { classifyErrorDisposition, taskFailureDisposition } from "./error-taxonomy.js";

/** P7a 夹具 J：环境故障（缺 ffprobe）必须被判成「不可重试的环境问题」，
 *  而不是一句自由文本，避免调用方按内容问题改提示词重跑整轮。 */

test("error taxonomy separates environment failures from content failures", () => {
    const media = classifyErrorDisposition({ code: "CANVAS_TOOL_FAILED", message: "Error: spawn ffprobe ENOENT", tool: "canvas_generate_video" });
    assert.equal(media.code, "MEDIA_TOOL_MISSING");
    assert.equal(media.scope, "environment");
    assert.equal(media.doNotRetry, true);
    assert.equal(media.fix?.file, "backend.json");
    assert.equal(media.fix?.key, "mediaTools.ffmpegDir");

    const spec = classifyErrorDisposition({ code: "SPEC_MISMATCH", message: "视频尺寸 512x512 与 1088x1920 不符" });
    assert.equal(spec.scope, "content");
    assert.equal(spec.doNotRetry, true);

    const conflict = classifyErrorDisposition({ code: "REVISION_CONFLICT", message: "revision 已变化" });
    assert.equal(conflict.scope, "conflict");
    assert.equal(conflict.doNotRetry, false);

    const transient = classifyErrorDisposition({ code: "BACKEND_HTTP_502", message: "bad gateway" });
    assert.equal(transient.scope, "transient");
    assert.equal(transient.doNotRetry, false);

    const input = classifyErrorDisposition({ code: "NODE_NOT_FOUND", message: "节点不存在" });
    assert.equal(input.scope, "input");
    assert.equal(input.doNotRetry, true);

    // 明确错误码优先于消息猜测：model 缺失的文案里出现 ffmpeg 也不能当成缺工具。
    const explicit = classifyErrorDisposition({ code: "MODEL_FILE_MISSING", message: "ffmpeg 可用但模型文件不存在: x.safetensors" });
    assert.equal(explicit.code, "MODEL_FILE_MISSING");
    assert.equal(explicit.scope, "environment");

    // 无法识别时不臆断为内容问题。
    const unknown = taskFailureDisposition("ComfyUI 执行器返回未知状态");
    assert.equal(unknown?.scope, "transient");
    assert.equal(unknown?.doNotRetry, false);
    assert.equal(taskFailureDisposition(null), undefined);
});

test("failed task snapshots carry scope/doNotRetry through canvas_task_status", async t => {
    const originalToken = process.env.INFINITE_CANVAS_BACKEND_TOKEN;
    process.env.INFINITE_CANVAS_BACKEND_TOKEN = "fixture";
    t.after(() => { if (originalToken === undefined) delete process.env.INFINITE_CANVAS_BACKEND_TOKEN; else process.env.INFINITE_CANVAS_BACKEND_TOKEN = originalToken; });
    const db = new BackendDatabase(":memory:");
    db.createCanvasProject({ id: "taxonomy", title: "Taxonomy fixture", revision: 0, nodes: [{ id: "h3", type: "minimax-h3:video", metadata: { segments: [] } }], connections: [] });
    const binding = { projectId: "taxonomy", nodeId: "h3", segmentId: "clip-1" };
    const envTask = db.createTask("taxonomy-env", "comfyui:minimax-h3", { ...binding }, { canvasBinding: binding });
    db.updateTask(envTask.id, { status: "failed", progress: 1, error: "Error: spawn ffprobe ENOENT" });
    const contentTask = db.createTask("taxonomy-content", "comfyui:minimax-h3", { ...binding }, { canvasBinding: binding });
    db.updateTask(contentTask.id, { status: "failed", progress: 1, error: "SPEC_MISMATCH: 输出 512x512，期望 1088x1920" });
    const okTask = db.createTask("taxonomy-ok", "comfyui:minimax-h3", { ...binding }, { canvasBinding: binding });
    db.updateTask(okTask.id, { status: "succeeded", progress: 1, result: { media: [{ storageKey: "video:ok", width: 1088, height: 1920 }] } });

    const config = { url: "http://127.0.0.1", port: 0, token: "fixture", origins: ["*"] };
    const { app } = startServer(db, config);
    const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const routes = registerBackendMcpHttpRoutes(app, { ...config, url });
    const client = new Client({ name: "error-taxonomy", version: "1" });
    t.after(async () => { await client.close(); await routes.closeAll(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); db.close(); });
    await client.connect(new StreamableHTTPClientTransport(new URL(url + "/mcp")));

    const read = async (args: Record<string, unknown>) => {
        const result: any = await client.callTool({ name: "canvas_task_status", arguments: args });
        assert.notEqual(result.isError, true, JSON.stringify(result));
        return JSON.parse(result.content.find((item: any) => item.type === "text").text);
    };

    const batch = await read({ projectId: "taxonomy", taskIds: [envTask.id, contentTask.id, okTask.id] });
    const byId = new Map(batch.tasks.map((task: any) => [task.taskId, task]));
    const env: any = byId.get(envTask.id);
    assert.equal(env.status, "failed");
    assert.equal(env.failure.code, "MEDIA_TOOL_MISSING");
    assert.equal(env.failure.scope, "environment");
    assert.equal(env.failure.doNotRetry, true);
    assert.equal(env.failure.fix.key, "mediaTools.ffmpegDir");
    // 原始错误文本不能被替换，旧消费方仍只看 error。
    assert.match(env.error, /ffprobe ENOENT/);

    const content: any = byId.get(contentTask.id);
    assert.equal(content.failure.code, "SPEC_MISMATCH");
    assert.equal(content.failure.scope, "content");

    const ok: any = byId.get(okTask.id);
    assert.equal(ok.failure, undefined);

    // 工具级错误也带分级：查不存在的任务属于输入问题，原样重提无意义。
    const missing: any = await client.callTool({ name: "canvas_task_status", arguments: { taskId: "nope" } });
    assert.equal(missing.isError, true);
    const failure = JSON.parse(missing.content[0].text).error;
    assert.equal(failure.code, "TASK_NOT_FOUND");
    assert.equal(failure.scope, "input");
    assert.equal(failure.doNotRetry, true);
});
