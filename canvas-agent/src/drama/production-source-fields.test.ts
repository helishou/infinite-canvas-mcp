import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { projectProductionRead, projectProductionVersion, productionReadQuery } from "./production-read.js";
import { assertProductionSourceFields } from "./production-source-fields.js";
import { productionToolRequest, executeProductionTool } from "./production-tools.js";

const digest = (value: string) => crypto.createHash("sha256").update(value).digest("hex");
function fixture() {
    return { episodeId: "e", revision: 7, publishedVersion: 1, draft: { settings: { parallelScenes: false, count: 0, optional: null }, director: {
        sourceHash: "a".repeat(64), source: { version: 2, prompt_assembly: { version: 2 }, ledger: { contract_version: 2 },
            shots: Array.from({ length: 3 }, (_, i) => ({ id: `shot-${i}`, duration_frames: 96, camera: { framing: "wide" }, performance: "未请求正文😀".repeat(3000), optional: null })),
            segments: [{ id: "clip", shot_ids: ["shot-0", "shot-1", "shot-2"] }] },
    } } };
}

test("source fields keep identities, false/zero/null and explicit missing fields without leaking other content", () => {
    const production = fixture(), before = JSON.stringify(production);
    const result: any = projectProductionRead(production, { view: "source", sourceSection: "shots", fields: ["duration_frames", "camera", "unknown", "camera"], targetIds: ["shot-1"], pageSize: 20 });
    assert.deepEqual(result.sourceFields, ["camera", "duration_frames", "unknown"]);
    assert.equal(result.partialSource, true);
    assert.deepEqual(result.source.items, [{ id: "shot-1", camera: { framing: "wide" }, duration_frames: 96 }]);
    assert.deepEqual(result.missingFields, [{ targetId: "shot-1", index: 0, fields: ["unknown"] }]);
    assert.deepEqual(result.targetClipMappings, [{ shotId: "shot-1", segmentIds: ["clip"] }]);
    assert.ok(!JSON.stringify(result).includes("未请求正文"));
    const settings: any = projectProductionRead(production, { view: "source", sourceSection: "settings", fields: ["parallelScenes", "count", "optional"] });
    assert.deepEqual(settings.source, { count: 0, optional: null, parallelScenes: false });
    assert.equal(JSON.stringify(production), before);
    const legacy: any = projectProductionRead(production, { view: "source", sourceSection: "shots", targetIds: ["shot-1"], pageSize: 20 });
    assert.equal(legacy.partialSource, undefined);
    assert.match(legacy.source.items[0].performance, /未请求正文/);
});

test("field pages and UTF-8 chunks are complete and bind selectors to their cursors", () => {
    const production = fixture();
    const query = { view: "source", sourceSection: "shots", fields: ["camera", "duration_frames"], pageSize: 1 };
    const first: any = projectProductionRead(production, query);
    const second: any = projectProductionRead(production, { ...query, fields: ["duration_frames", "camera", "camera"], cursor: first.source.nextCursor });
    assert.equal(second.source.items[0].id, "shot-1");
    assert.throws(() => projectProductionRead(production, { ...query, fields: ["performance"], cursor: first.source.nextCursor }), /READ_CURSOR_EXPIRED/);
    assert.throws(() => projectProductionRead(production, { ...query, pageSize: 2, cursor: first.source.nextCursor }), /READ_CURSOR_EXPIRED/);
    assert.throws(() => projectProductionRead({ ...production, revision: 8 }, { ...query, cursor: first.source.nextCursor }), /READ_CURSOR_EXPIRED/);
    let cursor: string | undefined, text = "", hash = "";
    const chunkQuery = { view: "source", sourceSection: "shots", fields: ["performance"], targetIds: ["shot-0"], chunkBytes: 1000 };
    const firstChunk: any = projectProductionRead(production, chunkQuery, digest);
    assert.throws(() => projectProductionRead(production, { ...chunkQuery, fields: ["camera"], cursor: firstChunk.chunk.nextCursor }, digest), /READ_CURSOR_EXPIRED/);
    do { const page: any = projectProductionRead(production, { ...chunkQuery, cursor }, digest); text += page.chunk.text; hash = page.chunk.sha256; cursor = page.chunk.nextCursor || undefined; } while (cursor);
    assert.deepEqual(JSON.parse(text), { id: "shot-0", performance: production.draft.director.source.shots[0].performance });
    assert.equal(digest(text), hash);
    const current: any = projectProductionRead(production, { ...query, ifRevision: 7 });
    assert.equal(current.unchanged, true);
    assert.equal(assertProductionSourceFields(current, query), current);
});

test("history projection uses the frozen version and preserves complete legacy reads", () => {
    const production = fixture();
    const version = { version: 1, snapshot: production.draft, createdAt: "saved", stage: "director" };
    const query = { view: "source", snapshot: "published", sourceSection: "shots", fields: ["duration_frames"], pageSize: 1 };
    const first: any = projectProductionVersion({ episodeId: "e" }, version, query, digest);
    const second: any = projectProductionVersion({ episodeId: "e" }, version, { ...query, cursor: first.snapshot.source.nextCursor }, digest);
    assert.equal(second.snapshot.source.items[0].id, "shot-1");
    assert.equal(assertProductionSourceFields({ version: first }, query).version, first);
    assert.throws(() => projectProductionVersion({ episodeId: "e" }, version, { ...query, fields: ["camera"], cursor: first.snapshot.source.nextCursor }, digest), /READ_CURSOR_EXPIRED/);
});

test("fields travel through the query contract, reject incompatible requests and fail closed on old Backends", async () => {
    const request = productionToolRequest("production_get_source", { kind: "episode", id: "e", sourceSection: "shots", fields: ["duration_frames"] });
    assert.deepEqual(JSON.parse(new URL("http://fixture" + request.path).searchParams.get("fields")!), ["duration_frames"]);
    assert.throws(() => productionReadQuery({ view: "summary", sourceSection: "shots", fields: ["camera"] }), /view=source/);
    assert.throws(() => productionReadQuery({ view: "source", fields: ["camera"] }), /sourceSection/);
    for (const fields of [[], ["camera.framing"], ["__proto__"]]) assert.throws(() => productionReadQuery({ view: "source", sourceSection: "shots", fields }));
    await assert.rejects(executeProductionTool({ get: async () => ({ production: { revision: 7, source: "private-full-body" } }), post: async () => ({}) }, "production_get_source", { kind: "episode", id: "e", sourceSection: "shots", fields: ["camera"] }), /SOURCE_FIELDS_UNSUPPORTED/);
});
