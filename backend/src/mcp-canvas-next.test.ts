import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { BackendDatabase } from "./db.js";
import { startServer } from "./server.js";
import { registerBackendMcpHttpRoutes } from "./mcp.js";
import { toolInputSchemas } from "@basketikun/canvas-agent/schemas";

/** P7d 夹具 L：一次 canvas_next 覆盖「阶段 + 参考就绪 + 任务状态」，nextAction 唯一且参数合法。
 *  runtimeTaskId / status 由任务维护，不能通过画布 ops 写，所以任务态场景各自建独立项目。 */

const character = { id: "actor", type: "character", title: "Actor", metadata: { characterImages: [{ storageKey: "image:face" }], characterPrimaryIndex: 0 } };
const scene = { id: "scene", type: "scene", title: "Room", metadata: { sceneImage: { storageKey: "image:room" } } };
const clip = (id: string, extra: Record<string, unknown> = {}) => ({
    id, prompt: `片段 ${id} 的提示词`, duration: 5, status: "idle",
    referenceBindings: [{ id: `${id}-ref`, role: "character_turnaround", enabled: true, storageKey: "image:face" }],
    results: [], ...extra,
});
const projectWith = (id: string, segments: Array<Record<string, unknown>>) =>
    ({ id, title: `Canvas next ${id}`, revision: 3, nodes: [character, scene, { id: "h3", type: "minimax-h3:video", metadata: { segments } }], connections: [] }) as never;

test("canvas_next returns one stage, one next action and a legal argument set", async t => {
    const originalToken = process.env.INFINITE_CANVAS_BACKEND_TOKEN;
    process.env.INFINITE_CANVAS_BACKEND_TOKEN = "fixture";
    t.after(() => { if (originalToken === undefined) delete process.env.INFINITE_CANVAS_BACKEND_TOKEN; else process.env.INFINITE_CANVAS_BACKEND_TOKEN = originalToken; });
    const db = new BackendDatabase(":memory:");
    db.createCanvasProject(projectWith("next", [clip("clip-1"), clip("clip-2")]));
    const runningTask = db.createTask("next-running", "canvas-h3-run", { projectId: "next-busy", nodeId: "h3" }, {});
    db.createCanvasProject(projectWith("next-busy", [clip("clip-1", { runtimeTaskId: runningTask.id }), clip("clip-2")]));
    db.createCanvasProject(projectWith("next-done", [
        clip("clip-1", { results: [{ storageKey: "video:a" }] }),
        clip("clip-2", { results: [{ storageKey: "video:b" }] }),
    ]));
    // 现场踩到的坑：段被标 cancelled 但没有任务号，裁决不能给出空 taskId 的动作。
    db.createCanvasProject(projectWith("next-orphan", [clip("clip-1", { status: "cancelled" }), clip("clip-2")]));

    const config = { url: "http://127.0.0.1", port: 0, token: "fixture", origins: ["*"] };
    const { app } = startServer(db, config);
    const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const routes = registerBackendMcpHttpRoutes(app, { ...config, url });
    const client = new Client({ name: "canvas-next", version: "1" });
    t.after(async () => { await client.close(); await routes.closeAll(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); db.close(); });
    await client.connect(new StreamableHTTPClientTransport(new URL(url + "/mcp")));

    const next = async (projectId: string, args: Record<string, unknown> = {}) => {
        const result: any = await client.callTool({ name: "canvas_next", arguments: { projectId, ...args } });
        assert.notEqual(result.isError, true, JSON.stringify(result));
        return JSON.parse(result.content.find((item: any) => item.type === "text").text);
    };

    // 1) 全部就绪 → 该去预检，而不是再去「看一眼」。
    const ready = await next("next");
    assert.equal(ready.stage, "clip-run");
    assert.deepEqual(ready.settled, { identity: true, scene: true, clipRefs: true, clipPlan: true, clipRun: false });
    assert.equal(ready.nextAction.tool, "h3_preview_run");
    assert.deepEqual(ready.nextAction.args, { projectId: "next", nodeId: "h3" });
    assert.equal(ready.budget.reads, 1, "只有一次项目快照");
    assert.equal(ready.blockers.length, 0);

    // 2) 某段缺参考 → clip-plan，裁决指向该段。
    db.applyCanvasProjectOperations("next", undefined, [{ type: "update_h3_segment", nodeId: "h3", segmentId: "clip-2", patch: { referenceBindings: [] } }] as never);
    const unbound = await next("next");
    assert.equal(unbound.stage, "clip-plan");
    assert.equal(unbound.settled.clipRefs, false);
    assert.equal(unbound.nextAction.tool, "h3_get_clip_references");
    assert.deepEqual(unbound.nextAction.args, { projectId: "next", nodeId: "h3", segmentId: "clip-2" });
    assert.equal(unbound.blockers[0].code, "REFERENCE_UNBOUND");
    assert.equal(unbound.blockers[0].target, "h3/clip-2");

    // 3) 某段缺提示词 → 提示词先于参考。
    db.applyCanvasProjectOperations("next", undefined, [{ type: "update_h3_segment", nodeId: "h3", segmentId: "clip-1", patch: { prompt: "" } }] as never);
    const noPrompt = await next("next");
    assert.equal(noPrompt.nextAction.tool, "h3_get_clip");
    assert.deepEqual(noPrompt.nextAction.args, { projectId: "next", nodeId: "h3", segmentId: "clip-1" });
    assert.ok(noPrompt.blockers.some((item: any) => item.code === "PROMPT_MISSING"));

    // 4) 任务在跑 → 只给等待，并且多读一次任务表。
    const busy = await next("next-busy");
    assert.equal(busy.stage, "clip-run");
    assert.equal(busy.nextAction.tool, "canvas_wait_tasks");
    assert.deepEqual(busy.nextAction.args, { taskIds: [runningTask.id] });
    assert.equal(busy.budget.reads, 2);

    // 5) 任务失败 → 裁决指向读失败原因，并带 P7a 分级。
    db.updateTask(runningTask.id, { status: "failed", progress: 1, error: "Error: spawn ffprobe ENOENT" });
    const broken = await next("next-busy");
    assert.equal(broken.nextAction.tool, "canvas_task_status");
    const failedBlocker = broken.blockers.find((item: any) => item.code === "MEDIA_TOOL_MISSING");
    assert.ok(failedBlocker, JSON.stringify(broken.blockers));
    assert.equal(failedBlocker.scope, "environment");
    assert.equal(failedBlocker.doNotRetry, true);

    // 6) 全部有结果 → deliver，不再给动作。
    const delivered = await next("next-done");
    assert.equal(delivered.stage, "deliver");
    assert.equal(delivered.nextAction, null);
    assert.equal(delivered.settled.clipRun, true);
    assert.ok(delivered.humanReview.length > 0, "身份/场景锚点应进入人眼确认清单");

    // 7) 段标记 cancelled 但没有任务号 → 不发空参数动作，退回读该段。
    const orphan = await next("next-orphan");
    assert.notEqual(orphan.nextAction.tool, "canvas_task_status");
    assert.equal(orphan.nextAction.tool, "h3_get_clip");
    assert.equal(orphan.nextAction.args.taskId, undefined);
    assert.equal(orphan.nextAction.args.segmentId, "clip-1");

    // 8) 每个 nextAction 的参数都必须能被目标工具校验通过，且只有一个动作。
    for (const receipt of [ready, unbound, noPrompt, busy, broken, orphan]) {
        const action = receipt.nextAction;
        assert.ok(action && typeof action.tool === "string", JSON.stringify(receipt));
        assert.equal(Array.isArray(action), false);
        const schema = (toolInputSchemas as Record<string, any>)[action.tool];
        if (schema) {
            schema.parse(action.args);
        } else {
            const required: Record<string, string[]> = {
                h3_get_clip: ["projectId", "nodeId", "segmentId"],
                h3_get_clip_references: ["projectId", "nodeId", "segmentId"],
                h3_get_node: ["projectId", "nodeId"],
                h3_preview_run: ["projectId"],
            };
            for (const key of required[action.tool] || []) assert.ok(action.args[key], `${action.tool} 缺 ${key}`);
        }
    }

    // 8) compact 不带逐段明细，也不夹带正文；full 才有。
    const compact = await next("next-done");
    assert.equal(compact.clips, undefined);
    assert.equal(JSON.stringify(compact).includes("片段"), false);
    const full = await next("next-done", { view: "full" });
    assert.equal(full.clips.length, 2);
    assert.equal(full.clips[0].promptChars > 0, true);
    assert.equal(full.clips[0].hasResult, true);
});
