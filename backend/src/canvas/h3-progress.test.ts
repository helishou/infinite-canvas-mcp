import assert from "node:assert/strict";
import test from "node:test";
import { CanvasH3Runner } from "./h3-runner.js";
import { BackendDatabase } from "../db.js";
import { BackendEventBus } from "../events.js";
import { createStores } from "../stores/index.js";

// Exercise the actual wait/publish seam, without a GPU, DB writes or live tasks.
function fixture(progress = 0, status = "running") {
    let parent = { id: "parent", status, progress, result: { currentChildTaskId: "child" } };
    let child = { id: "child", status: "running", progress: 0.5 };
    const updates: unknown[] = [];
    const runner = new CanvasH3Runner({ tasks: {
        get: (id: string) => id === "parent" ? parent : child,
        update: (_id: string, patch: object) => (parent = { ...parent, ...patch }),
    } } as never, { publish: (event: unknown) => updates.push(event) } as never, {} as never, {} as never);
    const wait = (base: number, weight: number) => (runner as unknown as {
        waitForTerminal(parent: string, child: string, base: number, weight: number): Promise<unknown>;
    }).waitForTerminal("parent", "child", base, weight);
    return { wait, updates, parent: () => parent, child: (patch: object) => { child = { ...child, ...patch }; } };
}

test("single ordinary clip reflects 50% child before terminal", async () => {
    const f = fixture();
    const pending = f.wait(0, 1);
    const observed = f.parent().progress;
    f.child({ status: "succeeded", progress: 1 });
    await pending;
    assert.equal(observed, 0.5);
    assert.equal(f.parent().progress, 0.99);
    assert.equal(f.updates.length, 2);
});

test("first/second confirmation phases each receive half a clip, clips equal weight", async () => {
    for (const [base, weight, expected] of [[0, 0.5, 0.25], [0.5, 0.5, 0.75], [0.5, 0.25, 0.625]]) {
        const f = fixture();
        const pending = f.wait(base, weight);
        const observed = f.parent().progress;
        f.child({ status: "failed" });
        await pending;
        assert.equal(observed, expected);
        assert.equal(f.parent().status, "running");
    }
});

test("retries/recovery never regress and unchanged polls do not publish", async () => {
    const f = fixture(0.8);
    const pending = f.wait(0.5, 0.5);
    assert.equal(f.parent().progress, 0.8);
    f.child({ status: "cancelled", progress: 0 });
    await pending;
    assert.equal(f.parent().progress, 0.8);
    assert.equal(f.updates.length, 0);
});

test("execute derives ordinary/face/latent weights, persists progress and publishes it", async (t) => {
    for (const [settings, expected] of [
        [{}, 0.5],
        [{ faceRefineEnabled: true, confirmationMode: true }, 0.25],
        [{ latentUpscaleEnabled: true, latentUpscaleConfirmationMode: true }, 0.25],
        [{ latentUpscaleEnabled: true, latentUpscaleConfirmationMode: false }, 0.5],
    ] as const) {
        const db = new BackendDatabase(":memory:");
        const stores = createStores(db);
        db.createCanvasProject({ id: "p", nodes: [{ id: "n", type: "minimax-h3", metadata: {
            segments: [{ id: "s", mode: "t2v", prompt: "video", ...settings }],
        } }], connections: [] });
        const published: number[] = [];
        const events = new BackendEventBus();
        const originalPublish = events.publish.bind(events);
        events.publish = (event) => {
            if (event.entityId === "parent") published.push(Number((event.payload as { progress: number }).progress));
            return originalPublish(event);
        };
        const comfy = {
            async run(_preset: string, input: Record<string, unknown>, params: Record<string, unknown>, _url?: string, id?: string, onCreated?: (task: ReturnType<typeof stores.tasks.create>) => void) {
                const child = stores.tasks.create(id!, "comfyui:minimax-h3", input, params);
                onCreated?.(child);
                return stores.tasks.update(child.id, { status: "running", progress: 0.5 });
            },
            cancel(id: string) { return stores.tasks.update(id, { status: "cancelled" }); },
        };
        const runner = new CanvasH3Runner(stores, events, comfy as never, {} as never);
        try {
            runner.start({ projectId: "p", nodeId: "n" }, "parent");
            for (let i = 0; i < 100 && db.getTask("parent")?.progress !== expected; i++) await new Promise((resolve) => setTimeout(resolve, 5));
            assert.equal(db.getTask("parent")?.status, "running");
            assert.equal(db.getTask("parent")?.progress, expected);
            assert.ok(published.includes(expected), "parent progress must reach SSE event bus");
        } finally {
            runner.cancel("parent");
            await new Promise((resolve) => setTimeout(resolve, 550));
            db.close();
        }
    }
});

test("non-finite child progress is ignored and failed children are not credited as completed", async () => {
    const f = fixture();
    f.child({ status: "failed", progress: NaN });
    await f.wait(0, 1);
    assert.equal(f.parent().progress, 0);
    assert.equal(f.updates.length, 0);
});

test("cancelled parent cannot be changed by polling", async () => {
    const f = fixture(0.4, "cancelled");
    await assert.rejects(f.wait(0, 1), /任务已取消/);
    assert.equal(f.parent().progress, 0.4);
    assert.equal(f.updates.length, 0);
});
