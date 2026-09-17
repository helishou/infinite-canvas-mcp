import assert from "node:assert/strict";
import test from "node:test";
import localforage from "localforage";

const disk = new Map<string, unknown>();
let failRead = false;
localforage.createInstance = (() => ({
    getItem: async (key: string) => { if (failRead) throw new Error("浏览器存储不可读"); return disk.get(key) ?? null; },
    setItem: async (key: string, value: unknown) => { disk.set(key, structuredClone(value)); return value; },
    removeItem: async (key: string) => { disk.delete(key); },
    iterate: async (visit: (value: unknown, key: string) => void) => { disk.forEach(visit); },
})) as unknown as typeof localforage.createInstance;
const { dismissBackendCanvasTextSuggestion, getCanvasTextSuggestions, listBackendCanvasTextSuggestions } = await import("./canvas-text-suggestions");
const { canvasDraftPersistence } = await import("../../lib/canvas/canvas-draft-persistence");

test("强化已返回但存储读取失败时先保留内存结果，重试原候选且不重复提交", async () => {
    const originalFetch = globalThis.fetch;
    const requests: Array<{ operationId: string; operations: unknown[] }> = [];
    globalThis.fetch = (async (_input, init) => {
        if (init?.method === "POST") {
            requests.push(JSON.parse(String(init.body)));
            return Response.json({ revision: 1, operations: [], project: { id: "storage-failure" } });
        }
        return Response.json({ suggestions: [] });
    }) as typeof fetch;
    try {
        const suggestions = getCanvasTextSuggestions("storage-failure", { field: "globalPrompt" });
        await suggestions.refresh();
        failRead = true;
        await assert.rejects(suggestions.save({ id: "candidate", documentId: "doc", base: "原文", text: "不能丢失的模型结果" }), /存储不可读/);
        assert.equal(suggestions.getSnapshot().items[0].text, "不能丢失的模型结果");
        assert.equal(suggestions.getSnapshot().pending, 1);
        assert.equal(requests.length, 0);
        assert.ok(JSON.stringify(canvasDraftPersistence.exportBackup()).includes("不能丢失的模型结果"));
        failRead = false;
        await canvasDraftPersistence.retry();
        await suggestions.refresh();
        assert.equal(requests.length, 1);
        assert.equal(requests[0].operationId, "suggestion-save:storage-failure:candidate");
        assert.equal(suggestions.getSnapshot().pending, 0);
        assert.equal(disk.size, 0);
        assert.equal(canvasDraftPersistence.getSnapshot().length, 0);
    } finally { globalThis.fetch = originalFetch; failRead = false; }
});

test("项目级候选列表可查看已删除目标并用稳定操作忽略", async () => {
    const originalFetch = globalThis.fetch;
    const candidate = { id: "orphan", target: { nodeId: "deleted-node", field: "prompt" }, documentId: "doc", base: "原文", text: "保留的候选", status: "pending", revision: 2 };
    let submitted: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_input, init) => {
        if (init?.method === "POST") {
            submitted = JSON.parse(String(init.body));
            return Response.json({ revision: 3, operations: [{ textSuggestion: { ...candidate, status: "dismissed", revision: 3 } }], project: { id: "candidate-manager" } });
        }
        return Response.json({ suggestions: [candidate] });
    }) as typeof fetch;
    try {
        assert.deepEqual(await listBackendCanvasTextSuggestions("candidate-manager"), [candidate]);
        await dismissBackendCanvasTextSuggestion("candidate-manager", "orphan");
        assert.equal(submitted?.operationId, "suggestion-resolve:candidate-manager:orphan:dismiss");
        assert.deepEqual(submitted?.operations, [{ type: "resolve_text_suggestion", id: "orphan", action: "dismiss" }]);
    } finally { globalThis.fetch = originalFetch; }
});
