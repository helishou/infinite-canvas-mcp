import assert from "node:assert/strict";
import test from "node:test";
import { pluginMcp } from "./mcp.js";
import { h3PluginManifest } from "../../../../plugins/canvas/minimax-h3/src/manifest.js";

function fixture(count = 10) {
    const project: any = { id: "delta-project", revision: 7, connections: [], nodes: [{
        id: "delta-h3", type: "minimax-h3:video", title: "isolated",
        metadata: { keepRoot: "untouched", segments: Array.from({ length: count + 1 }, (_, i) => ({
            id: `s${i + 1}`, title: `clip-${i + 1}`, duration: 8, taskMode: "t2va", status: "idle",
            prompt: "Unrelated stable sentence. ".repeat(300) + "😀 She holds the golden bell; preserve doorbell and dialogue.",
            openingState: "golden bell in her hand", endingState: "golden bell concealed",
            continuityIn: "golden bell enters", continuityOut: "golden bell leaves",
            timeline: [{ start: 0, end: 4, action: "Show golden bell", camera: "Fixed", description: "golden bell detail" }, { start: 4, end: 8, action: "Hide golden bell", camera: "Close" }],
            referenceBindings: [], resultStorageKey: "video:historical", privateUnknown: { keep: true },
        })) },
    }] };
    const calls: any[] = [];
    const commands = new Map<string, any>();
    const context: any = {
        getCanvasProject: async () => structuredClone(project),
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
        applyCanvasOperations: async (_id: string, operations: any[], revision: number, opId?: string, strict?: boolean, mcpCommand?: any) => {
            assert.equal(strict, true);
            assert.equal(revision, project.revision);
            calls.push(structuredClone(operations));
            for (const operation of operations) {
                const metadata = project.nodes[0].metadata;
                if (operation.type === "update_h3_segment") Object.assign(metadata.segments.find((s: any) => s.id === operation.segmentId), operation.patch);
                else if (operation.type === "update_node") Object.assign(metadata, operation.metadata);
            }
            project.revision++;
            if (mcpCommand) {
                const command = commands.get(opId!);
                command.status = "committed";
                command.committedRevision = project.revision;
                command.receipt = { ...command.receipt, ok: true, committed: true, operationId: opId, revision: project.revision, changesHash: "fixture-hash", replayed: false };
            }
            return { project: structuredClone(project), revision: project.revision, operationResults: [] };
        } },
    };
    const handlers = pluginMcp.createHandler(context);
    let operationNumber = 0;
    const run = (updates: unknown, extra: Record<string, unknown> = {}) => handlers.h3_update_clips!({ projectId: project.id, nodeId: "delta-h3", updates, operationId: String(extra.operationId || `narrative-unit-${++operationNumber}`), expectedRevision: project.revision, ...extra }, context);
    const read = (fields: unknown) => handlers.h3_get_clip!({ projectId: project.id, nodeId: "delta-h3", segmentId: "s1", fields }, context);
    return { project, calls, handlers, run, read };
}

const edit = (field = "prompt", expectedMatches = 1, find = "golden bell", replace = "thin jade pendant") => ({ field, find, replace, expectedMatches });
const updates = () => Array.from({ length: 10 }, (_, i) => ({ segmentId: `s${i + 1}`, edits: [edit(), edit("openingState"), edit("endingState"), edit("continuityIn"), edit("continuityOut"), edit("timeline[].action", 2)] }));

test("ten narrative deltas commit once, preserve unrelated bytes and avoid retransmitting full prompts", async () => {
    const f = fixture();
    const before = structuredClone(f.project);
    const input = updates();
    const result: any = await f.run(input, { expectedRevision: 7 });
    assert.equal(f.calls.length, 1);
    assert.equal(result.revision, 8);
    assert.equal(result.count, 10);
    assert.equal(result.dryRun, false);
    assert.equal(result.applied, true);
    for (let i = 0; i < 10; i++) {
        const old = before.nodes[0].metadata.segments[i];
        const actual = f.project.nodes[0].metadata.segments[i];
        assert.equal(actual.prompt, old.prompt.replace("golden bell", "thin jade pendant"));
        assert.ok(actual.prompt.includes("😀") && actual.prompt.includes("doorbell and dialogue"));
        assert.equal(actual.timeline[0].description, old.timeline[0].description);
        assert.deepEqual(actual.timeline.map((s: any) => [s.start, s.end, s.camera]), old.timeline.map((s: any) => [s.start, s.end, s.camera]));
        for (const key of ["resultStorageKey", "status", "duration", "privateUnknown", "referenceBindings"]) assert.deepEqual(actual[key], old[key]);
        assert.equal(result.items[i].editSummary.matchCount, 7);
        assert.equal(result.items[i].editSummary.byField["timeline[].action"], 2);
    }
    assert.deepEqual(f.project.nodes[0].metadata.segments[10], before.nodes[0].metadata.segments[10]);
    const legacy = input.map((entry, i) => ({ segmentId: entry.segmentId, patch: { prompt: before.nodes[0].metadata.segments[i].prompt.replace("golden bell", "thin jade pendant") } }));
    assert.ok(Buffer.byteLength(JSON.stringify(input)) < Buffer.byteLength(JSON.stringify(legacy)) / 10);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) < 24000);
});

test("dryRun validates and returns bounded previews without invoking the writer", async () => {
    const f = fixture();
    const before = structuredClone(f.project);
    const result: any = await f.run(updates(), { dryRun: true, expectedRevision: 7 });
    assert.equal(result.dryRun, true);
    assert.equal(result.applied, false);
    assert.equal(result.revision, 7);
    assert.equal(result.count, 10);
    assert.equal(f.calls.length, 0);
    assert.deepEqual(f.project, before);
    assert.ok(result.items[0].editSummary.previews.length > 0);
    assert.ok(result.items.flatMap((item: any) => item.editSummary.previews).length <= 20);
    assert.ok(result.items.some((item: any) => item.editSummary.previewTruncated));
    for (const sample of result.items.flatMap((item: any) => item.editSummary.previews)) {
        assert.ok(sample.before.length <= 200 && sample.after.length <= 200);
    }
});

for (const [name, invalid] of [
    ["missing literal", edit("prompt", 1, "missing")],
    ["wrong occurrence count", edit("prompt", 2)],
    ["empty find", edit("prompt", 1, "")],
    ["protected field", edit("status")],
    ["generic wildcard", edit("*")],
    ["fraction count", edit("prompt", 1.5)],
    ["zero count", edit("prompt", 0)],
    ["numeric timeline field", edit("timeline[].end")],
] as const) {
    test(`delta rejects ${name} without any write`, async () => {
        const f = fixture();
        const before = structuredClone(f.project);
        await assert.rejects(() => f.run([{ segmentId: "s1", edits: [invalid] }]));
        assert.equal(f.calls.length, 0);
        assert.deepEqual(f.project, before);
    });
}

test("a bad last target rejects all earlier valid deltas", async () => {
    const f = fixture();
    const before = structuredClone(f.project);
    const input = updates();
    input[9].edits = [edit("prompt", 99)];
    await assert.rejects(() => f.run(input), /匹配|命中|count/i);
    assert.equal(f.calls.length, 0);
    assert.deepEqual(f.project, before);
});

test("introduced invalid Picture reference is compiled before the writer", async () => {
    const f = fixture();
    await assert.rejects(() => f.run([{ segmentId: "s1", edits: [edit("prompt", 1, "golden bell", "<Picture 999>")] }]), /Picture|引用|参考/);
    assert.equal(f.calls.length, 0);
});

test("patch and edits can coexist only on distinct root fields", async () => {
    const f = fixture();
    await f.run([{ segmentId: "s1", patch: { duration: 9 }, edits: [edit()] }]);
    assert.equal(f.project.nodes[0].metadata.segments[0].duration, 9);
    for (const [patch, e] of [[{ prompt: "overwrite" }, edit()], [{ timeline: [] }, edit("timeline[].action", 2)]] as const) {
        await assert.rejects(() => f.run([{ segmentId: "s2", patch, edits: [e] }]), /冲突|同一|overlap/i);
    }
});

test("literal matching, deletion and ordered edits preserve untouched text", async () => {
    const f = fixture();
    f.project.nodes[0].metadata.segments[0].prompt = "😀 a.b aXb golden bell";
    await f.run([{ segmentId: "s1", edits: [edit("prompt", 1, "a.b", ""), edit(), edit("prompt", 1, "thin jade pendant", "jade")] }]);
    assert.equal(f.project.nodes[0].metadata.segments[0].prompt, "😀  aXb jade");
});

test("stale revision and nonboolean dryRun reject without mutation", async () => {
    const f = fixture();
    await assert.rejects(() => f.run(updates(), { expectedRevision: 6 }), /版本|revision/);
    await assert.rejects(() => f.run(updates(), { dryRun: "false" }));
    assert.equal(f.calls.length, 0);
});

test("field projection returns only requested narrative values, without two prompt bodies", async () => {
    const f = fixture();
    const result: any = await f.read(["openingState", "timeline"]);
    assert.deepEqual(Object.keys(result.fields), ["openingState", "timeline"]);
    assert.equal(result.fields.openingState, "golden bell in her hand");
    assert.deepEqual(result.fields.timeline, f.project.nodes[0].metadata.segments[0].timeline);
    assert.equal("semantic" in result.prompt, false);
    assert.equal("compiled" in result.prompt, false);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) < 2000);
    await assert.rejects(() => f.read(["status"]));
    await assert.rejects(() => f.read(["prompt", "prompt"]));
    await assert.rejects(() => f.read("prompt"));
});

test("field projection reports absent fields without inventing an empty value", async () => {
    const f = fixture();
    const result: any = await f.read(["music"]);
    assert.deepEqual(result.fields, {});
    assert.deepEqual(result.missingFields, ["music"]);
});

test("saved Clip summary and runtime reads skip reference compilation; explicit include compiles once", async () => {
    const f = fixture();
    const light: any = await f.handlers.h3_get_clip!({ projectId: f.project.id, nodeId: "delta-h3", segmentId: "s1" }, f.context);
    assert.equal(light.validationDeferred, true);
    assert.equal("compileMs" in light.timings, false);
    const compiled: any = await f.handlers.h3_get_clip!({ projectId: f.project.id, nodeId: "delta-h3", segmentId: "s1", include: ["prompt", "references"] }, f.context);
    assert.equal(typeof compiled.prompt.compiled, "string");
    assert.ok(Array.isArray(compiled.references));
    assert.equal(typeof compiled.timings.compileMs, "number");
    const runtime: any = await f.handlers.h3_get_clip_runtime!({ projectId: f.project.id, nodeId: "delta-h3", segmentId: "s1" }, f.context);
    assert.equal("compileMs" in runtime.timings, false);
});

test("preview flags literal remnants in unrequested continuity and timeline fields without rewriting them", async () => {
    const f = fixture();
    const before = structuredClone(f.project);
    const result: any = await f.run([{ segmentId: "s1", edits: [edit()] }], { dryRun: true });
    const fields = result.items[0].editSummary.remainingLiteralFields;
    assert.ok(fields.includes("continuityIn") && fields.includes("continuityOut"));
    assert.ok(fields.includes("openingState") && fields.includes("timeline[].description"));
    assert.equal(fields.includes("prompt"), false);
    assert.deepEqual(f.project, before);
    assert.equal(f.calls.length, 0);
});

test("bounded Unicode preview snippets never introduce lone surrogate characters", async () => {
    const f = fixture();
    const prompt = "😀".repeat(150) + "Xgolden bell" + "😀".repeat(150);
    f.project.nodes[0].metadata.segments[0].prompt = prompt;
    const result: any = await f.run([{ segmentId: "s1", edits: [edit()] }], { dryRun: true });
    for (const sample of result.items[0].editSummary.previews) {
        for (const value of [sample.before, sample.after]) {
            assert.ok(value.length <= 200);
            for (const character of value) assert.ok(character.length !== 1 || character.charCodeAt(0) < 0xD800 || character.charCodeAt(0) > 0xDFFF);
        }
    }
    assert.equal(f.project.nodes[0].metadata.segments[0].prompt, prompt);
});

test("browser and server expose the same edits and field-projection contracts", () => {
    for (const id of ["h3_update_clips", "h3_get_clip"]) {
        const server: any = pluginMcp.tools.find((tool) => tool.id === id);
        const browser: any = h3PluginManifest.mcp.tools.find((tool) => tool.id === id);
        assert.deepEqual(server.inputJsonSchema, browser.inputJsonSchema);
    }
    const batch: any = pluginMcp.tools.find((tool) => tool.id === "h3_update_clips");
    assert.ok(batch.inputJsonSchema.properties.dryRun);
    assert.ok(batch.inputJsonSchema.properties.updates.items.properties.edits);
});
