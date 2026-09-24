import assert from "node:assert/strict";
import test from "node:test";
import localforage from "localforage";

const buckets = new Map<string, Map<string, unknown>>();
localforage.createInstance = ((options: { name: string }) => ({
    iterate: async (visit: (value: unknown, key: string) => void) => { for (const [key, value] of buckets.get(options.name) || []) visit(value, key); },
})) as unknown as typeof localforage.createInstance;
const { listCanvasDrafts } = await import("./canvas-drafts");
const { getCanvasDraftSessionId } = await import("../../lib/canvas/canvas-draft-session");

test("草稿盘点隔离后台，关联会话缓存，不把已同步投影当作待提交操作", async () => {
    const backend = "http://127.0.0.1:17370";
    const owner = getCanvasDraftSessionId();
    buckets.set("infinite-canvas-command-outbox", new Map([
        ["c1", { ownerId: owner, backend, projectId: "p", operations: [{ type: "update_project" }], rejected: "conflict" }],
        ["c2", { ownerId: "closed", backend, projectId: "p2", operations: [] }],
        ["other-server", { ownerId: owner, backend: "http://other", projectId: "foreign" }],
    ]));
    buckets.set("infinite-canvas-project-cache", new Map([
        [JSON.stringify([backend, owner, "p"]), { project: { id: "p", title: "我的画布" }, base: { id: "p" } }],
        [JSON.stringify([backend, "clean", "p"]), { project: { id: "p" }, base: { id: "p" } }],
        [JSON.stringify([backend, "seed", "new"]), { project: { id: "new", title: "尚未创建" } }],
    ]));
    const result = await listCanvasDrafts();
    assert.equal(result.length, 3);
    const mine = result.find((item) => item.current)!;
    assert.equal(mine.pending, 1);
    assert.equal(mine.rejected, 1);
    assert.ok(mine.projects.includes("我的画布"));
    assert.equal(mine.records.length, 2);
    assert.equal(result.some((item) => item.records.some((record) => record.key === "other-server")), false);
    assert.equal(result.some((item) => item.ownerId === "clean"), false);
    assert.equal(result.find((item) => item.ownerId === "seed")?.pending, 1);
});

test("未知归属的旧缓存/文本和删除意图只读保留；空删除列表不算草稿", async () => {
    buckets.clear();
    const backend = "http://127.0.0.1:17370";
    buckets.set("infinite-canvas-text-outbox", new Map([["old-text", { backend, projectId: "p", state: "encoded" }]]));
    buckets.set("infinite-canvas-project-cache", new Map([["old-cache", { project: { id: "p", title: "旧缓存", nodes: [], connections: [] } }]]));
    buckets.set("infinite-canvas-project-deletions", new Map([
        [JSON.stringify([backend, "delete-owner", "deletions"]), ["p"]],
        [JSON.stringify([backend, "empty-owner", "deletions"]), []],
    ]));
    const before = JSON.stringify([...buckets].map(([name, values]) => [name, [...values]]));
    const result = await listCanvasDrafts();
    assert.equal(result.length, 3);
    assert.equal(result.filter((item) => !item.ownerId).length, 2);
    assert.deepEqual(result.find((item) => item.recoverableProjects.length)?.recoverableProjects.map((project) => project.id), ["p"]);
    assert.equal(result.some((item) => item.ownerId === "empty-owner"), false);
    assert.equal(JSON.stringify([...buckets].map(([name, values]) => [name, [...values]])), before);
});
