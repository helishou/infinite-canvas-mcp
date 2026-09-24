import assert from "node:assert/strict";
import test from "node:test";

import { buildPluginMcpContext } from "./plugin-mcp.js";

test("同一 Backend 项目的并行读取合并请求，但不缓存快照", async () => {
    let reads = 0;
    const backend: any = {
        backendUrl: "http://coalesce.test",
        getCanvasProject: async (id: string) => {
            reads++;
            await new Promise((resolve) => setTimeout(resolve, 10));
            return { id, revision: reads, nodes: [] };
        },
    };
    const context = buildPluginMcpContext(backend, {} as any);
    const [first, second] = await Promise.all([
        context.getCanvasProject("project-one"),
        context.getCanvasProject("project-one"),
    ]);
    assert.equal(reads, 1);
    assert.notEqual(first, second);
    (first.nodes as unknown[]).push({ id: "caller-only" });
    assert.deepEqual(second.nodes, []);
    await context.getCanvasProject("project-one");
    assert.equal(reads, 2);
});

test("项目读取失败后会清除 in-flight 项并允许重试", async () => {
    let reads = 0;
    const backend: any = {
        backendUrl: "http://coalesce-error.test",
        getCanvasProject: async () => {
            reads++;
            if (reads === 1) throw new Error("temporary failure");
            return { id: "project-two", nodes: [] };
        },
    };
    const context = buildPluginMcpContext(backend, {} as any);
    await assert.rejects(context.getCanvasProject("project-two"), /temporary failure/);
    assert.equal((await context.getCanvasProject("project-two")).id, "project-two");
    assert.equal(reads, 2);
});
