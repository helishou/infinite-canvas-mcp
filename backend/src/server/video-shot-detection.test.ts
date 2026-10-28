import assert from "node:assert/strict";
import test from "node:test";
import type { Express } from "express";
import type { Stores } from "../stores/types.js";
import { registerVideoShotDetectionRoute } from "./video-shot-detection.js";

type Handler = (req: any, res: any) => unknown;

function setup(stores: Partial<Stores>, detect: (file: string) => Promise<{ cuts: Array<{ frame: number; time: number }> }> = async () => ({ cuts: [] })) {
    const routes = new Map<string, Handler>();
    registerVideoShotDetectionRoute({ get: (path: string, handler: Handler) => routes.set(path, handler) } as unknown as Express, stores as Stores, detect);
    return routes.get("/canvas/projects/:id/video/:nodeId/scene-cuts")!;
}

function response() {
    const result: { statusCode: number; body?: unknown; status(code: number): typeof result; json(body: unknown): typeof result } = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; },
    };
    return result;
}

test("scene detection only reads an archived video node in the requested canvas", async () => {
    let detectedPath = "";
    const handler = setup({
        projects: { get: (id: string) => id === "canvas" ? { nodes: [{ id: "video-1", type: "video", metadata: { storageKey: "video:1" } }] } : null } as never,
        media: { meta: (key: string) => key === "video:1" ? { filePath: "C:/media/source.mp4", mimeType: "video/mp4" } : null } as never,
    }, async (file) => { detectedPath = file; return { cuts: [{ frame: 24, time: 1 }] }; });
    const res = response();

    await handler({ params: { id: "canvas", nodeId: "video-1" } }, res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { ok: true, cuts: [{ frame: 24, time: 1 }] });
    assert.equal(detectedPath, "C:/media/source.mp4");
});

test("scene detection rejects missing or unarchived video nodes before invoking Python", async () => {
    let invoked = false;
    const handler = setup({
        projects: { get: () => ({ nodes: [{ id: "video-1", type: "video", metadata: { content: "blob:browser-only" } }] }) } as never,
        media: { meta: () => null } as never,
    }, async () => { invoked = true; return { cuts: [] }; });
    const res = response();

    await handler({ params: { id: "canvas", nodeId: "video-1" } }, res);

    assert.equal(res.statusCode, 409);
    assert.equal(invoked, false);
});
