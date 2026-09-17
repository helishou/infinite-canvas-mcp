import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { BackendDatabase } from "../db.js";
import { startServer } from "../server.js";

test("新建幂等但不能覆盖，整批快照接口停用且不破坏文档、日志或文本身份", async () => {
    const db = new BackendDatabase(":memory:");
    const { app, events } = startServer(db, { url: "http://127.0.0.1", token: "test", port: 0, origins: ["*"] });
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const request = (method: string, path: string, body: unknown) => fetch(url + path, { method, headers: { Authorization: "Bearer test", "Content-Type": "application/json" }, body: JSON.stringify(body) });
    try {
        const seed = { id: "created", title: "原画布", nodes: [], connections: [], globalPrompt: "原文", revision: 100 };
        const input = structuredClone(seed);
        const created = await request("POST", "/canvas/projects", seed);
        assert.equal(created.status, 201);
        assert.equal((await created.json() as { project: { revision: number } }).project.revision, 0);
        assert.deepEqual(seed, input);
        const doc = db.getCanvasText(seed.id, { field: "globalPrompt" });
        const edited = db.applyCanvasProjectOperations(seed.id, undefined, [{ type: "update_project", patch: { title: "协作者的标题", globalPrompt: "协作者新正文" } }], { operationId: "edit", baseRevision: 0 });
        const before = db.getCanvasProject(seed.id);
        const history = db.readCanvasChanges(seed.id, 0);
        const eventsBefore = events.since().length;
        // 原创建请求丢回执后重放，只返回当前文档，不再次生成事件或回退到初始种子。
        const retry = await request("POST", "/canvas/projects", seed);
        assert.equal(retry.status, 200);
        const retried = await retry.json() as { project: unknown; created: boolean };
        assert.equal(retried.created, false);
        assert.deepEqual(retried.project, before);
        for (const body of [{ ...seed, title: "覆盖", revision: 999, updatedAt: "9999-01-01" }, { ...before, globalPrompt: "更改全文", revision: 1000 }]) {
            const rejected = await request("POST", "/canvas/projects", body);
            assert.equal(rejected.status, 409);
            assert.equal((await rejected.json() as { code: string }).code, "PROJECT_EXISTS");
        }
        for (const body of [{ projects: [] }, { projects: [{ ...seed, title: "整批覆盖" }] }, {}]) {
            const rejected = await request("PUT", "/canvas/projects", body);
            assert.equal(rejected.status, 410);
            assert.equal((await rejected.json() as { code: string }).code, "SNAPSHOT_WRITE_REMOVED");
        }
        assert.deepEqual(db.getCanvasProject(seed.id), before);
        assert.deepEqual(db.readCanvasChanges(seed.id, 0), history);
        assert.equal(events.since().length, eventsBefore);
        assert.equal(db.getCanvasText(seed.id, { field: "globalPrompt" }).documentId, doc.documentId);
        assert.equal(db.getCanvasText(seed.id, { field: "globalPrompt" }).text, "协作者新正文");
        assert.deepEqual(db.applyCanvasProjectOperations(seed.id, undefined, [{ type: "update_project", patch: { title: "协作者的标题", globalPrompt: "协作者新正文" } }], { operationId: "edit", baseRevision: 0 }).project, edited.project);
    } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        db.close();
    }
});

test("HTTP 入参不能授予任务写权限或借 source 身份覆盖 H3 输出", async () => {
    const db = new BackendDatabase(":memory:");
    db.createCanvasProject({ id: "p", nodes: [{ id: "h3", type: "minimax-h3:video", metadata: { content: "original.mp4", segments: [] } }], connections: [] });
    const { app, events } = startServer(db, { url: "http://127.0.0.1", token: "test", port: 0, origins: ["*"] });
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    try {
        const before = db.getCanvasProject("p");
        const eventCount = events.since().length;
        for (const kind of ["browser", "mcp", "task", "system"]) {
            const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/canvas/projects/p/ops?response=delta`, {
                method: "POST", headers: { Authorization: "Bearer test", "Content-Type": "application/json" },
                body: JSON.stringify({ operationId: `forged-${kind}`, runtimeWrite: true, context: { runtimeWrite: true }, source: { clientId: "fake-task", kind, runtimeWrite: true }, operations: [
                    { type: "update_project", patch: { title: "不可部分写入" } },
                    { type: "update_node", id: "h3", metadata: { content: "fake.mp4" } },
                ] }),
            });
            assert.equal(response.status, 400);
            assert.match((await response.json() as { error: string }).error, /后台任务/);
        }
        assert.deepEqual(db.getCanvasProject("p"), before);
        assert.equal(db.readCanvasChanges("p", 0).commits.length, 0);
        assert.equal(events.since().length, eventCount);
    } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        db.close();
    }
});

test("摘要不包含节点内容，详情单独读取；SSE 断线补发和实例切换通过真实 HTTP 验证", async () => {
    const db = new BackendDatabase(":memory:");
    db.createCanvasProject({ id: "p", title: "画布", revision: 0, nodes: [{ id: "n", metadata: { content: "large-content" } }], connections: [], createdAt: "2026-01-01", updatedAt: "2026-01-01" });
    const { app, events } = startServer(db, { url: "http://127.0.0.1", token: "test", port: 0, origins: ["*"] });
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const request = (path: string, headers = {}) => fetch(`${url}${path}`, { headers: { Authorization: "Bearer test", ...headers } });
    const readHandshake = async (cursor: string) => {
        const response = await request("/events", { "Last-Event-ID": cursor });
        const reader = response.body!.getReader();
        let text = "";
        try {
            while (!text.includes("event: events.sync")) {
                const { value, done } = await reader.read();
                if (done) break;
                text += new TextDecoder().decode(value);
            }
        } finally { await reader.cancel(); }
        return text;
    };
    try {
        const summaries = await (await request("/canvas/projects?summary=true")).json() as { projects: Record<string, unknown>[] };
        assert.equal(summaries.projects[0].nodeCount, 1);
        assert.equal(summaries.projects[0].revision, 0);
        assert.equal("nodes" in summaries.projects[0], false);
        const detail = await (await request("/canvas/projects/p")).json() as { project: { nodes: unknown[] } };
        assert.equal(detail.project.nodes.length, 1);
        assert.equal((await request("/canvas/projects/missing")).status, 404);
        const operationBody = { expectedRevision: 0, operationId: "browser-1:op-1", source: { clientId: "browser-1", kind: "browser", label: "测试浏览器" }, operations: [{ type: "update_node", id: "n", patch: { title: "新标题" } }] };
        const updated = await fetch(`${url}/canvas/projects/p/ops?response=delta`, {
            method: "POST", headers: { Authorization: "Bearer test", "Content-Type": "application/json" },
            body: JSON.stringify(operationBody),
        });
        const delta = await updated.json() as Record<string, unknown>;
        assert.equal(updated.status, 200);
        assert.equal(delta.revision, 1);
        assert.equal("project" in delta, false);
        assert.equal((delta.operations as unknown[]).length, 1);
        assert.equal((db.getCanvasProject("p")!.nodes as Array<Record<string, unknown>>)[0].title, "新标题");
        const duplicate = await fetch(`${url}/canvas/projects/p/ops?response=delta`, {
            method: "POST", headers: { Authorization: "Bearer test", "Content-Type": "application/json" }, body: JSON.stringify(operationBody),
        });
        const duplicateDelta = await duplicate.json() as Record<string, unknown>;
        assert.equal(duplicate.status, 200);
        assert.equal(duplicateDelta.duplicated, true);
        assert.equal(duplicateDelta.revision, 1);
        assert.equal(Number(db.getCanvasProject("p")!.revision), 1);
        const first = events.publish({ type: "task.created", payload: "first" });
        const second = events.publish({ type: "task.completed", payload: "second" });
        const replay = await readHandshake(first.id);
        assert.ok(replay.includes(`id: ${second.id}`));
        assert.ok(!replay.includes('"first"'));
        assert.ok(replay.includes('"reset":false'));
        const reset = await readHandshake("old-instance:5");
        assert.ok(reset.includes('"reset":true'));
        assert.ok(!reset.includes('"second"'));
    } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        db.close();
    }
});
