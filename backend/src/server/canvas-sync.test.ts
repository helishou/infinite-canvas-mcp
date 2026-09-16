import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { BackendDatabase } from "../db.js";
import { startServer } from "../server.js";

test("摘要不包含节点内容，详情单独读取；SSE 断线补发和实例切换通过真实 HTTP 验证", async () => {
    const db = new BackendDatabase(":memory:");
    db.upsertCanvasProject({ id: "p", title: "画布", revision: 3, nodes: [{ id: "n", metadata: { content: "large-content" } }], connections: [], createdAt: "2026-01-01", updatedAt: "2026-01-01" });
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
        assert.equal(summaries.projects[0].revision, 3);
        assert.equal("nodes" in summaries.projects[0], false);
        const detail = await (await request("/canvas/projects/p")).json() as { project: { nodes: unknown[] } };
        assert.equal(detail.project.nodes.length, 1);
        assert.equal((await request("/canvas/projects/missing")).status, 404);
        const operationBody = { expectedRevision: 3, operationId: "browser-1:op-1", source: { clientId: "browser-1", kind: "browser", label: "测试浏览器" }, operations: [{ type: "update_node", id: "n", patch: { title: "新标题" } }] };
        const updated = await fetch(`${url}/canvas/projects/p/ops?response=delta`, {
            method: "POST", headers: { Authorization: "Bearer test", "Content-Type": "application/json" },
            body: JSON.stringify(operationBody),
        });
        const delta = await updated.json() as Record<string, unknown>;
        assert.equal(updated.status, 200);
        assert.equal(delta.revision, 4);
        assert.equal("project" in delta, false);
        assert.equal((delta.operations as unknown[]).length, 1);
        assert.equal((db.getCanvasProject("p")!.nodes as Array<Record<string, unknown>>)[0].title, "新标题");
        const duplicate = await fetch(`${url}/canvas/projects/p/ops?response=delta`, {
            method: "POST", headers: { Authorization: "Bearer test", "Content-Type": "application/json" }, body: JSON.stringify(operationBody),
        });
        const duplicateDelta = await duplicate.json() as Record<string, unknown>;
        assert.equal(duplicate.status, 200);
        assert.equal(duplicateDelta.duplicated, true);
        assert.equal(duplicateDelta.revision, 4);
        assert.equal(Number(db.getCanvasProject("p")!.revision), 4);
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
