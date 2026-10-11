import test from "node:test";
import assert from "node:assert/strict";
import { writeAssetIntent } from "./asset-write-intent";
test("unknown asset writes retain the exact operation and frozen payload; corrected rejected requests can proceed", async () => {
    const data = new Map<string, any>();
    const cache = { getItem: async <T>(key: string) => data.get(key) as T || null, setItem: async <T>(key: string, value: T) => { data.set(key, value); return value; }, removeItem: async (key: string) => { data.delete(key); } };
    const first = { method: "POST" as const, path: "/assets", body: { id: "original", operationId: "original-op", title: "内容" } };
    await assert.rejects(writeAssetIntent(cache, "node", first, async () => { throw Object.assign(new Error("lost response"), { status: 0 }); }, "restored"));
    const next = { ...first, body: { ...first.body, id: "new", operationId: "new-op" } };
    await writeAssetIntent(cache, "node", next, async request => { assert.deepEqual(request, first); return "receipt"; }, "restored");
    assert.equal(data.size, 0);
    await assert.rejects(writeAssetIntent(cache, "node", first, async () => { throw Object.assign(new Error("invalid input"), { status: 400 }); }, "restored"));
    assert.equal(data.size, 0);
    await writeAssetIntent(cache, "node", next, async request => { assert.deepEqual(request, next); return "corrected"; }, "restored");
});
