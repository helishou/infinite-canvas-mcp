import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { pluginMcp } from "./mcp.js";
import { h3PluginManifest } from "../../../../plugins/canvas/minimax-h3/src/manifest.js";

function fixture() {
    const project: any = { id: "batch-project", revision: 9, connections: [], nodes: [{
        id: "h3-batch", type: "minimax-h3:video", title: "batch",
        metadata: { customRoot: "keep", segments: Array.from({ length: 7 }, (_, i) => ({
            id: `s${i + 1}`, title: `old-${i + 1}`, duration: 6, taskMode: "t2va",
            prompt: "An empty room.", status: "idle", referenceBindings: [],
            resultStorageKey: i === 6 ? "video:historical" : undefined,
        })) },
    }] };
    const calls: any[] = [];
    const commands = new Map<string, any>();
    let reads = 0;
    let beforeCommit: (() => void) | undefined;
    const context: any = {
        getCanvasProject: async () => { reads++; return structuredClone(project); },
        backend: {
            checkMcpCommandReceipt: async (operationId: string, identity: any) => {
                const command = commands.get(operationId);
                if (command && JSON.stringify(command.request) !== JSON.stringify(identity.request)) throw Object.assign(new Error("operationId 已用于不同请求"), { code: "OPERATION_ID_REUSED" });
                return { ok: true, command: command ? structuredClone(command) : null };
            },
            prepareMcpCommand: async (input: any) => {
                const command = { operationId: input.operationId, tool: input.tool, targetId: input.targetId, status: "prepared", payload: structuredClone(input.payload), receipt: structuredClone(input.receipt), request: structuredClone(input.request) };
                commands.set(input.operationId, command);
                return structuredClone(command);
            },
            getMcpCommandReceipt: async (operationId: string) => ({ ok: true, command: structuredClone(commands.get(operationId) || null) }),
            applyCanvasOperations: async (id: string, operations: any[], revision: number, _operationId?: string, strictRevision?: boolean, mcpCommand?: any) => {
                calls.push({ id, operations: structuredClone(operations), revision, strictRevision });
                beforeCommit?.();
                assert.equal(strictRevision, true, "batch must demand strict revision at the real writer");
                if (revision !== project.revision) throw new Error("REVISION_CONFLICT");
                const next = structuredClone(project);
                for (const operation of operations) {
                    const node = next.nodes.find((item: any) => item.id === (operation.nodeId || operation.id));
                    if (operation.type === "update_h3_segment") {
                        Object.assign(node.metadata.segments.find((item: any) => item.id === operation.segmentId), operation.patch);
                    } else if (operation.type === "update_node") {
                        Object.assign(node.metadata, operation.metadata);
                    }
                }
                next.revision++;
                Object.assign(project, next);
                if (mcpCommand) {
                    const command = commands.get(_operationId);
                    command.status = "committed";
                    command.committedRevision = project.revision;
                    command.receipt = { ...command.receipt, ok: true, committed: true, operationId: _operationId, revision: project.revision, changesHash: "fixture-hash", replayed: false };
                }
                return { project: structuredClone(project), revision: project.revision, operationResults: [] };
            },
        },
    };
    const handler: any = pluginMcp.createHandler(context).h3_update_clips;
    assert.equal(typeof handler, "function", "native h3_update_clips handler must exist");
    const run = async (updates: unknown, extra: Record<string, unknown> = {}) => {
        return handler({ projectId: project.id, nodeId: "h3-batch", updates, expectedRevision: project.revision, operationId: "batch-operation", ...extra }, context);
    };
    return { project, calls, run, reads: () => reads, race: (fn: () => void) => { beforeCommit = fn; } };
}

const updates = () => Array.from({ length: 6 }, (_, i) => ({ segmentId: `s${i + 1}`, patch: { title: `new-${i + 1}`, duration: 7 } }));

test("native batch declaration is shared by server and manifest", () => {
    const server = pluginMcp.tools.find((tool) => tool.id === "h3_update_clips");
    const client = h3PluginManifest.mcp.tools.find((tool) => tool.id === "h3_update_clips");
    assert.ok(server, "native batch tool must be declared");
    assert.ok(client);
    assert.deepEqual(server.inputJsonSchema, client.inputJsonSchema);
});

test("six updates use one read, one atomic writer and a compact replayable receipt", async () => {
    const f = fixture();
    const untouched = structuredClone(f.project.nodes[0].metadata.segments[6]);
    const result = await f.run(updates(), { expectedRevision: 9, operationId: "replayable-batch" });
    assert.equal(f.reads(), 1);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].operations.filter((op: any) => op.type === "update_h3_segment").length, 6);
    assert.equal(f.project.revision, 10);
    assert.equal(result.count, 6);
    assert.equal(result.atomic, true);
    assert.deepEqual(result.segmentIds, ["s1", "s2", "s3", "s4", "s5", "s6"]);
    assert.deepEqual(result.updatedFields, ["title", "duration"]);
    for (const item of result.items) { assert.equal(item.values.duration, 7); assert.match(item.values.title, /^new-/); }
    assert.match(result.changesHash, /^fixture-hash$/);
    assert.deepEqual(f.project.nodes[0].metadata.segments[6], untouched);
    assert.equal("project" in result, false);
    assert.equal("metadata" in result, false);
    const replay = await f.run(updates(), { expectedRevision: 9, operationId: "replayable-batch" });
    assert.equal(replay.replayed, true);
    assert.equal(f.reads(), 1);
    assert.equal(f.calls.length, 1);
});

test("late invalid prompt rejects every update before the writer", async () => {
    const f = fixture();
    const before = structuredClone(f.project);
    const input = updates();
    input[5].patch = { prompt: "The person in <Picture 999>." } as any;
    await assert.rejects(() => f.run(input), /Picture|参考|引用|missing/i);
    assert.equal(f.calls.length, 0);
    assert.deepEqual(f.project, before);
});

for (const [name, input] of [
    ["empty", []],
    ["duplicate", [{ segmentId: "s1", patch: { title: "a" } }, { segmentId: "s1", patch: { title: "b" } }]],
    ["missing target", [{ segmentId: "missing", patch: { title: "a" } }]],
    ["empty patch", [{ segmentId: "s1", patch: {} }]],
    ["array patch", [{ segmentId: "s1", patch: [] }]],
    ["invalid duration", [{ segmentId: "s1", patch: { duration: 0 } }]],
] as const) {
    test(`batch rejects ${name} without partial write`, async () => {
        const f = fixture();
        await assert.rejects(() => f.run(input));
        assert.equal(f.calls.length, 0);
        assert.equal(f.project.revision, 9);
    });
}

for (const field of ["id", "status", "runtimeTaskId", "resultStorageKey", "h3CharacterGroups", "characterGroups"]) {
    test(`batch rejects protected ${field}`, async () => {
        const f = fixture();
        await assert.rejects(() => f.run([{ segmentId: "s1", patch: { [field]: "forged" } }]));
        assert.equal(f.calls.length, 0);
    });
}

for (const status of ["loading", "queued", "running", "awaiting_confirmation", "success"]) {
    test(`batch edits ${status} task-bound drafts without clearing runtime fields`, async () => {
        const f = fixture();
        const target = f.project.nodes[0].metadata.segments[5];
        Object.assign(target, { status, runtimeTaskId: "child-active", parentTaskId: "parent-active", resultStorageKey: "video:existing" });
        const result = await f.run([{ segmentId: "s6", patch: { prompt: "A sword and a jade pendant.", timeline: [{ description: "A sword." }] } }]);
        assert.equal(result.count, 1);
        const saved = f.project.nodes[0].metadata.segments[5];
        assert.equal(saved.prompt, "A sword and a jade pendant.");
        assert.deepEqual(saved.timeline, [{ description: "A sword." }]);
        for (const field of ["status", "runtimeTaskId", "parentTaskId", "resultStorageKey"]) assert.equal(saved[field], target[field]);
        assert.deepEqual(Object.keys(f.calls[0].operations[0].patch).sort(), ["prompt", "timeline"]);
    });
}

test("old caller revision fails before commit; mid-flight revision change is not rebased", async () => {
    const f = fixture();
    await assert.rejects(() => f.run(updates(), { expectedRevision: 8 }), /revision|版本/i);
    assert.equal(f.calls.length, 0);
    f.race(() => { f.project.revision++; });
    await assert.rejects(() => f.run(updates(), { expectedRevision: 9 }), /REVISION_CONFLICT/);
    assert.equal(f.project.nodes[0].metadata.segments[0].title, "old-1");
});

test("root projection is one update with existing input-order last-write semantics", async () => {
    const f = fixture();
    await f.run([
        { segmentId: "s1", patch: { modelName: "first" } },
        { segmentId: "s2", patch: { modelName: "last", videoSteps: 4 } },
    ]);
    const roots = f.calls[0].operations.filter((op: any) => op.type === "update_node");
    assert.equal(roots.length, 1);
    assert.deepEqual(roots[0].metadata, { modelName: "last", minimaxBaseModel: "last", videoSteps: 4 });
    assert.equal(f.project.nodes[0].metadata.customRoot, "keep");
});

test("long prompts are hashed from committed values, not echoed into the response", async () => {
    const f = fixture();
    const prompt = "An empty room. ".repeat(20000);
    const result = await f.run([{ segmentId: "s1", patch: { prompt } }]);
    assert.equal("prompt" in result.items[0].values, false);
    assert.equal(result.items[0].fieldSummaries.prompt.sha256, createHash("sha256").update(JSON.stringify(prompt)).digest("hex"));
    assert.ok(Buffer.byteLength(JSON.stringify(result)) < 4096);
    assert.equal(f.project.nodes[0].metadata.segments[0].prompt, prompt);
});
