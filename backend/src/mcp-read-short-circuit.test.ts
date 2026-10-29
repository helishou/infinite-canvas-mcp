import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { BackendDatabase } from "./db.js";
import { startServer } from "./server.js";
import { registerBackendMcpHttpRoutes } from "./mcp.js";

/** P7c 夹具 K：同一目标同一投影的重复读取，第二次传 ifChanged 只回短确认。 */

test("static reads return a content fingerprint and short-circuit when unchanged", async t => {
    const originalToken = process.env.INFINITE_CANVAS_BACKEND_TOKEN;
    process.env.INFINITE_CANVAS_BACKEND_TOKEN = "fixture";
    t.after(() => { if (originalToken === undefined) delete process.env.INFINITE_CANVAS_BACKEND_TOKEN; else process.env.INFINITE_CANVAS_BACKEND_TOKEN = originalToken; });
    const db = new BackendDatabase(":memory:");
    const longPrompt = "同一段提示词正文，用于占位读取体积。".repeat(400);
    db.createCanvasProject({ id: "cache", title: "Short circuit fixture", revision: 0, nodes: [
        { id: "actor", type: "character", title: "Actor", metadata: { storageKey: "image:face", characterImages: [{ storageKey: "image:face", width: 768, height: 1024 }], prompt: longPrompt } },
        { id: "h3", type: "minimax-h3:video", metadata: { segments: [{ id: "clip-1", prompt: longPrompt, duration: 4, modelName: "fixture", status: "idle", referenceBindings: [] }] } },
    ], connections: [] });

    const config = { url: "http://127.0.0.1", port: 0, token: "fixture", origins: ["*"] };
    const { app } = startServer(db, config);
    const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const routes = registerBackendMcpHttpRoutes(app, { ...config, url });
    const client = new Client({ name: "read-short-circuit", version: "1" });
    t.after(async () => { await client.close(); await routes.closeAll(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); db.close(); });
    await client.connect(new StreamableHTTPClientTransport(new URL(url + "/mcp")));

    const read = async (name: string, args: Record<string, unknown>) => {
        const result: any = await client.callTool({ name, arguments: args });
        assert.notEqual(result.isError, true, JSON.stringify(result));
        return JSON.parse(result.content.find((item: any) => item.type === "text").text);
    };

    // 1. 普通读取：正文照旧，回执附带指纹供下次使用。
    const first = await read("canvas_get_state", { projectId: "cache", nodeIds: ["actor"], projection: "full" });
    assert.ok(first.nodes?.[0]?.metadata, "普通读取必须返回正文");
    assert.match(String(first.contentFingerprint), /^[a-f0-9]{64}$/);

    // 2. 同一内容 + ifChanged：只回短确认，不夹带正文。
    const second = await read("canvas_get_state", { projectId: "cache", nodeIds: ["actor"], projection: "full", ifChanged: first.contentFingerprint });
    assert.equal(second.unchanged, true);
    assert.equal(second.contentFingerprint, first.contentFingerprint);
    assert.equal(second.nodes, undefined);
    const firstBytes = Buffer.byteLength(JSON.stringify(first));
    const secondBytes = Buffer.byteLength(JSON.stringify(second));
    assert.ok(secondBytes * 50 < firstBytes, `${secondBytes} 应远小于 ${firstBytes}`);

    // 3. 指纹稳定：不传 ifChanged 再读一次，指纹不变。
    const third = await read("canvas_get_state", { projectId: "cache", nodeIds: ["actor"], projection: "full" });
    assert.equal(third.contentFingerprint, first.contentFingerprint);

    // 4. 内容变了：同一 ifChanged 不再命中，返回正文与新指纹。
    db.applyCanvasProjectOperations("cache", undefined, [{ type: "update_node", id: "actor", patch: { title: "Actor Renamed" } }] as never);
    const changed = await read("canvas_get_state", { projectId: "cache", nodeIds: ["actor"], projection: "full", ifChanged: first.contentFingerprint });
    assert.notEqual(changed.unchanged, true);
    assert.ok(changed.nodes?.[0]?.metadata, "内容变化时必须返回正文");
    assert.notEqual(changed.contentFingerprint, first.contentFingerprint);

    // 5. 不同投影是不同内容，不能互相命中。
    const media = await read("canvas_get_state", { projectId: "cache", nodeIds: ["actor"], projection: "media" });
    assert.notEqual(media.contentFingerprint, changed.contentFingerprint);
    const crossRead = await read("canvas_get_state", { projectId: "cache", nodeIds: ["actor"], projection: "media", ifChanged: changed.contentFingerprint });
    assert.notEqual(crossRead.unchanged, true);
    assert.ok(crossRead.nodes?.[0]?.media, "跨投影传旧指纹不得短路");

    // 6. 动态查询不参与短路：任务状态永远读实时值。
    const task = db.createTask("cache-task", "canvas-image", { projectId: "cache" }, {});
    const status = await read("canvas_task_status", { taskId: task.id });
    assert.equal(status.contentFingerprint, undefined);
    assert.equal(status.unchanged, undefined);
});
