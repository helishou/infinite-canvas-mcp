import test from "node:test";
import { directorRunStartSchema } from "./production-contract.js";

test("unified run routing preserves canvas defaults and explicit published inputs", () => {
    const input = { kind: "canvas" as const, id: "canvas", runId: "run", idempotencyKey: "intent", expectedRevision: 2, targets: ["segment"] };
    const normal = productionToolRequest("production_start_run", input);
    assert.equal(directorRunStartSchema.parse((normal as { body: unknown }).body).inputBasis, "canvas");
    const published = productionToolRequest("production_start_run", { ...input, inputBasis: "published", version: 4 });
    assert.equal(directorRunStartSchema.parse((published as { body: unknown }).body).inputBasis, "published");
    const edit = productionToolRequest("production_edit", { kind: "canvas", id: "canvas", operationId: "adopt", expectedRevision: 2,
        ops: [{ type: "patch_director_source", entity: "brief", patch: { value: "accepted" } }], adoptions: [{ taskId: "task", artifactHash: "a".repeat(64) }] });
    assert.deepEqual((edit as { body: any }).body.adoptions, [{ taskId: "task", artifactHash: "a".repeat(64) }]);
});
import assert from "node:assert/strict";
import { productionToolNames, productionToolRequest, productionToolSchemas, executeProductionTool } from "./production-tools.js";
import { removedToolMigrations, removedToolNotice, migrateToolGuidance } from "../canvas/tool-migrations.js";

const cases: Record<string, { input?: Record<string, unknown>; method: string; suffix: string }> = {
    production_preflight: { input: { action: "generate", request: { expectedRevision: 2 } }, method: "POST", suffix: "/preflight" },
    production_get: { method: "GET", suffix: "?view=summary&snapshot=draft" },
    production_get_source: { input: { sourceSection: "shots" }, method: "GET", suffix: "?view=source&snapshot=draft&sourceSection=shots&pageSize=50" },
    production_get_artifact_index: { method: "GET", suffix: "?view=artifact_index&snapshot=draft&pageSize=50" },
    production_get_artifact: { input: { targetId: "seg/1" }, method: "GET", suffix: "?view=artifacts&snapshot=draft&targetIds=seg%2F1&chunkBytes=32768" },
    production_get_workbench: { input: { targetId: "seg/1", view: "clip_workbench" }, method: "GET", suffix: "?view=clip_workbench&snapshot=draft&targetIds=seg%2F1" },
    production_get_readiness: { method: "GET", suffix: "/readiness" },
    production_start_run: { input: { runId: "r", idempotencyKey: "original", expectedRevision: 2, targets: ["segment:s"], inputBasis: "canvas", expectedCanvasRevision: 7 }, method: "POST", suffix: "/runs" },
    production_get_batch: { input: { runId: "r" }, method: "GET", suffix: "/batches/r" },
    production_pause_run: { input: { runId: "r" }, method: "POST", suffix: "/batches/r/pause" },
    production_resume_run: { input: { runId: "r" }, method: "POST", suffix: "/batches/r/resume" },
    production_list_versions: { method: "GET", suffix: "/versions" },
    production_get_version: { input: { version: 2 }, method: "GET", suffix: "/versions/2?view=summary&snapshot=draft" },
    production_get_version_source: { input: { version: 2, sourceSection: "shots" }, method: "GET", suffix: "/versions/2?view=source&snapshot=published&sourceSection=shots&pageSize=50" },
    production_get_version_artifact_index: { input: { version: 2 }, method: "GET", suffix: "/versions/2?view=artifact_index&snapshot=published&pageSize=50" },
    production_get_version_artifact: { input: { version: 2, targetId: "seg/1" }, method: "GET", suffix: "/versions/2?view=artifacts&snapshot=published&targetIds=seg%2F1&chunkBytes=32768" },
    production_list_legacy: { method: "GET", suffix: "/legacy" },
    production_preview_impact: { input: { stage: "director" }, method: "GET", suffix: "/impact?stage=director" },
    production_edit: { input: { operationId: "original", expectedRevision: 2, ops: [{ type: "set_director_brief", brief: "中文\n原文" }] }, method: "POST", suffix: "/ops" },
    production_publish: { input: { operationId: "original", expectedRevision: 2, stage: "director" }, method: "POST", suffix: "/publish" },
    production_restore: { input: { operationId: "original", expectedRevision: 2, version: 1 }, method: "POST", suffix: "/restore" },
    production_sync_clips: { method: "POST", suffix: "/sync-clips" },
    production_get_run: { input: { version: 2 }, method: "GET", suffix: "/runs/2" },
    production_export_markdown: { input: { stage: "shots", version: 2 }, method: "GET", suffix: "/export?stage=shots&version=2" },
};
test("24 unified contracts route same IDs by explicit owner and reject mixed identities", () => {
    assert.equal(productionToolNames.length, 24);
    for (const name of productionToolNames) for (const kind of ["episode", "canvas"] as const) {
        const c = cases[name], raw = { kind, id: "same:id", ...c.input };
        const request = productionToolRequest(name, raw);
        assert.equal(request.method, c.method);
        assert.equal(request.path, `${kind === "episode" ? "/drama/episodes" : "/canvas/projects"}/same%3Aid/production${c.suffix}`);
        for (const invalid of [{ ...raw, projectId: "other" }, { ...raw, episodeId: "other" }, { ...raw, kind: "scene" }, { ...raw, id: undefined }]) assert.equal(productionToolSchemas[name].safeParse(invalid).success, false);
        if (request.method === "POST" && !["production_pause_run", "production_resume_run", "production_sync_clips"].includes(name)) assert.deepEqual(request.body, c.input);
    }
});
test("removed names are metadata, not executable aliases; guidance never rewrites authored content", () => {
    assert.equal(Object.keys(removedToolMigrations).length, 37);
    assert.equal(removedToolNotice("toString"), undefined);
    for (const name of Object.keys(removedToolMigrations)) assert.equal(removedToolNotice(name)?.code, "TOOL_REMOVED");
    const source = { nextRead: { tool: "drama_get_production", input: { episodeId: "original" } } };
    const value = { source, snapshot: source, preflight: { nextActions: [source.nextRead], diagnostics: [{ nextAction: source.nextRead }] } };
    const result = migrateToolGuidance(value);
    assert.equal(result.source, source); assert.equal(result.snapshot, source);
    assert.deepEqual(result.preflight.nextActions[0], { tool: "production_get", input: { kind: "episode", id: "original" } });
    assert.deepEqual(migrateToolGuidance({ nextRead: { tool: "drama_get_production", input: { kind: "episode", id: "original" } } }).nextRead,
        { tool: "production_get", input: { kind: "episode", id: "original" } });
});
test("write routing preserves request identity and projects replies without carrying full source", async () => {
    const input = { kind: "canvas", id: "c", operationId: "original", expectedRevision: 2, ops: [{ type: "set_director_brief", brief: "中文\n原文" }] };
    let count = 0;
    const result: any = await executeProductionTool({ get: async () => { throw new Error("Unexpected GET"); }, post: async (path, body) => {
        count++; assert.equal(path, "/canvas/projects/c/production/ops");
        const { kind: _, id: __, ...request } = input; assert.deepEqual(body, request);
        return { ok: true, production: { episodeId: "c", revision: 3, replayed: true, draft: { huge: "x".repeat(1000000) } } };
    } }, "production_edit", input);
    assert.equal(count, 1); assert.equal(result.operationId, "original"); assert.equal(result.production.replayed, true);
    assert.deepEqual(result.nextRead, { tool: "production_get", input: { kind: "canvas", id: "c" } });
    assert.ok(JSON.stringify(result).length < 2000);
});
