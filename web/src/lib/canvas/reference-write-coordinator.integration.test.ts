import assert from "node:assert/strict";
import test from "node:test";

import { createCanvasReferenceService } from "./reference-service";

const asset = (label: string) => ({ id: "shared", label, mediaType: "image" as const, role: "storyboard", tags: [] });

test("两个 H3 节点并发写相同 signature 时只跨过一次 HTTP 边界", async (t) => {
    const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
        requests.push({ path: url.pathname, body });
        await pending;
        return Response.json({ ok: true, asset: body });
    });

    const service = createCanvasReferenceService("project");
    const first = service.upsert(asset("A"));
    const second = service.upsert(asset("A"));
    await Promise.resolve();
    release();

    assert.equal(await first, await second);
    assert.equal(requests.length, 1);
    assert.match(requests[0].path, /\/canvas\/projects\/project\/reference-assets$/);
});

test("H3 catalog batch 仍只跨过一次 HTTP 边界，重复 ID 顺序原样提交", async (t) => {
    const requests: Array<{ path: string; body: { assets: unknown[] } }> = [];
    t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        const body = JSON.parse(String(init?.body)) as { assets: unknown[] };
        requests.push({ path: url.pathname, body });
        return Response.json({ ok: true, assets: body.assets });
    });

    const service = createCanvasReferenceService("project");
    const result = await service.upsertMany([asset("first"), { ...asset("last"), id: "other" }, asset("last")]);
    assert.equal(requests.length, 1);
    assert.match(requests[0].path, /\/canvas\/projects\/project\/reference-assets\/batch$/);
    assert.deepEqual(requests[0].body.assets, [asset("first"), { ...asset("last"), id: "other" }, asset("last")]);
    assert.equal(result.length, 3);
});
