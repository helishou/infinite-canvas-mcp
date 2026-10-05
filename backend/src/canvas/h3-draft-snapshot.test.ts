import assert from "node:assert/strict";
import test from "node:test";
import { BackendDatabase } from "../db.js";
import { BackendEventBus } from "../events.js";
import { createStores } from "../stores/index.js";
import { CanvasH3Runner } from "./h3-runner.js";
import { KNOWN_FIRST_PARTY } from "@basketikun/canvas-agent/plugin-mcp";

test("native batch draft edit preserves active bindings and frozen inputs for current AND unstarted clips", async (t) => {
    const db = new BackendDatabase(":memory:");
    t.after(() => db.close());
    db.createCanvasProject({ id: "p", nodes: [{ id: "n", type: "minimax-h3:video", metadata: { segments: [
        { id: "a", prompt: "A bell.", mode: "t2v", timeline: [{ description: "Old A" }] },
        { id: "b", prompt: "Another bell.", mode: "t2v", timeline: [{ description: "Old B" }] },
    ] } }], connections: [] });
    const stores = createStores(db);
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const submitted: Array<{ input: Record<string, unknown>; params: Record<string, unknown> }> = [];
    const comfy = {
        async run(_preset: string, input: Record<string, unknown>, params: Record<string, unknown>, _url?: string, id?: string, onCreated?: (task: ReturnType<typeof stores.tasks.create>) => void) {
            const child = stores.tasks.create(id!, "comfyui:minimax-h3", input, params);
            submitted.push(structuredClone({ input, params }));
            onCreated?.(child);
            if (submitted.length === 1) await blocked;
            return stores.tasks.update(child.id, { status: "succeeded", progress: 1, result: { media: [{ url: `/media/${child.id}`, storageKey: child.id, mimeType: "video/mp4" }] } });
        },
        cancel() { assert.fail("draft edits must not cancel tasks"); },
    };
    const runner = new CanvasH3Runner(stores, new BackendEventBus(), comfy as never, { ready: () => false, queue: { select: () => "local", unreserve: () => {} } } as never);
    const parent = runner.start({ projectId: "p", nodeId: "n", runFromCurrent: true, skipCompleted: false }, "snapshot-parent");
    const waitFor = async (predicate: () => boolean) => {
        for (let i = 0; i < 200 && !predicate(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
        assert.ok(predicate(), db.getTask(parent.id)?.error || "runner timeout");
    };
    await waitFor(() => submitted.length === 1);
    const frozen = structuredClone(db.getTask(parent.id)!.input);
    const project = stores.projects.get("p")!;
    const before = structuredClone((project.nodes as any[])[0].metadata.segments);
    assert.ok(before[0].runtimeTaskId);
    const context: any = {
        getCanvasProject: async () => stores.projects.get("p"),
        backend: {
            checkMcpCommandReceipt: async () => ({ command: null }),
            prepareMcpCommand: async (input: any) => ({ status: "prepared", payload: input.payload, receipt: input.receipt }),
            getMcpCommandReceipt: async () => ({ command: null }),
            applyCanvasOperations: async (id: string, operations: any[], revision: number, _operationId?: string, strictRevision?: boolean) => {
            assert.equal(strictRevision, true);
            return stores.projects.applyOperations(id, revision, operations, { source: { clientId: "test", kind: "mcp", label: "draft edit" } });
        } },
    };
    const pluginMcp = await KNOWN_FIRST_PARTY["minimax-h3"].load();
    const handler = pluginMcp.createHandler(context).h3_update_clips!;
    try {
        await handler({ projectId: "p", nodeId: "n", operationId: "snapshot-draft-edit", expectedRevision: Number(project.revision), updates: ["a", "b"].map((segmentId) => ({ segmentId, patch: { prompt: "A sword and jade pendant.", timeline: [{ description: "New draft" }] } })) }, context);
        const after = (stores.projects.get("p")!.nodes as any[])[0].metadata.segments;
        for (let i = 0; i < 2; i++) {
            assert.equal(after[i].prompt, "A sword and jade pendant.");
            assert.deepEqual(after[i].timeline, [{ description: "New draft" }]);
            for (const field of ["status", "runtimeTaskId", "parentTaskId", "resultStorageKey"]) assert.deepEqual(after[i][field], before[i][field]);
        }
        assert.deepEqual(db.getTask(parent.id)!.input, frozen);
    } finally { release(); }
    await waitFor(() => ["succeeded", "failed"].includes(db.getTask(parent.id)!.status));
    assert.equal(db.getTask(parent.id)!.status, "succeeded", db.getTask(parent.id)!.error || "");
    assert.equal(submitted.length, 2);
    assert.match(JSON.stringify(submitted[0].input), /A bell/);
    assert.match(JSON.stringify(submitted[1].input), /Another bell/);
    assert.doesNotMatch(JSON.stringify(submitted), /sword|jade/);
    assert.deepEqual(db.getTask(parent.id)!.input, frozen);
    assert.equal((stores.projects.get("p")!.nodes as any[])[0].metadata.segments[0].prompt, "A sword and jade pendant.");
});
