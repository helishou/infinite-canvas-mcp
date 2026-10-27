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
    const shotRefresh = productionToolRequest("production_edit", { kind: "episode", id: "episode", operationId: "shot-refresh", expectedRevision: 5,
        ops: [{ type: "request_director_shot_refresh", shotIds: ["SHOT_A", "SHOT_B"] }] });
    assert.deepEqual((shotRefresh as { body: any }).body.ops, [{ type: "request_director_shot_refresh", shotIds: ["SHOT_A", "SHOT_B"] }]);
    assert.equal(productionToolSchemas.production_edit.safeParse({ kind: "episode", id: "episode", operationId: "duplicate-shot-refresh", expectedRevision: 5,
        ops: [{ type: "request_director_shot_refresh", shotIds: ["SHOT_A", "SHOT_A"] }] }).success, false);
});
import assert from "node:assert/strict";
import { productionToolNames, productionToolRequest, productionToolSchemas, executeProductionTool, isProductionTool } from "./production-tools.js";

const cases: Record<string, { input?: Record<string, unknown>; method: string; suffix: string }> = {
    production_preflight: { input: { action: "generate", request: { expectedRevision: 2 } }, method: "POST", suffix: "/preflight" },
    production_get: { method: "GET", suffix: "?view=summary&snapshot=draft" },
    production_get_source: { input: { sourceSection: "shots" }, method: "GET", suffix: "?view=source&snapshot=draft&sourceSection=shots&pageSize=20" },
    production_get_artifact_index: { method: "GET", suffix: "?view=artifact_index&snapshot=draft&pageSize=20" },
    production_get_artifact: { input: { targetId: "seg/1" }, method: "GET", suffix: "?view=artifacts&snapshot=draft&targetIds=seg%2F1&chunkBytes=32768" },
    production_get_workbench: { input: { targetId: "seg/1", view: "clip_workbench" }, method: "GET", suffix: "?view=clip_workbench&snapshot=draft&targetIds=seg%2F1&chunkBytes=32768&includeContext=false&includeRuntime=false" },
    production_get_readiness: { method: "GET", suffix: "/readiness?source=draft&view=summary&pageSize=20" },
    production_start_run: { input: { runId: "r", idempotencyKey: "original", expectedRevision: 2, targets: ["segment:s"], inputBasis: "canvas", expectedCanvasRevision: 7 }, method: "POST", suffix: "/runs" },
    production_get_batch: { input: { runId: "r" }, method: "GET", suffix: "/batches/r" },
    production_pause_run: { input: { runId: "r" }, method: "POST", suffix: "/batches/r/pause" },
    production_resume_run: { input: { runId: "r" }, method: "POST", suffix: "/batches/r/resume" },
    production_retire_run: { input: { runId: "r", reason: "user ended paused batch" }, method: "POST", suffix: "/batches/r/retire" },
    production_list_versions: { method: "GET", suffix: "/versions" },
    production_get_version: { input: { version: 2 }, method: "GET", suffix: "/versions/2?view=summary&snapshot=draft" },
    production_get_version_source: { input: { version: 2, sourceSection: "shots" }, method: "GET", suffix: "/versions/2?view=source&snapshot=published&sourceSection=shots&pageSize=20" },
    production_get_version_artifact_index: { input: { version: 2 }, method: "GET", suffix: "/versions/2?view=artifact_index&snapshot=published&pageSize=20" },
    production_get_version_artifact: { input: { version: 2, targetId: "seg/1" }, method: "GET", suffix: "/versions/2?view=artifacts&snapshot=published&targetIds=seg%2F1&chunkBytes=32768" },
    production_preview_impact: { input: { stage: "director" }, method: "GET", suffix: "/impact?stage=director" },
    production_edit: { input: { operationId: "original", expectedRevision: 2, ops: [{ type: "set_director_brief", brief: "中文\n原文" }] }, method: "POST", suffix: "/ops" },
    production_split_scene: { input: { operationId: "original", expectedRevision: 2, sourceSceneId: "SCENE1", sourceScenePatch: { text: "Remaining." }, newScene: { id: "SCENE2", scene_id: "ENV2", scene_name: "Dining room", location: "Dining room", time_of_day: "Morning", text: "Moved scene.", beat_ids: [] }, shotIds: ["SHOT2"], environmentSubjectId: "SUBJECT2", environmentPictureBindingId: "BINDING2" }, method: "POST", suffix: "/ops" },
    production_publish: { input: { operationId: "original", expectedRevision: 2, stage: "director" }, method: "POST", suffix: "/publish" },
    production_restore: { input: { operationId: "original", expectedRevision: 2, version: 1 }, method: "POST", suffix: "/restore" },
    production_sync_clips: { method: "POST", suffix: "/sync-clips" },
    production_get_run: { input: { version: 2 }, method: "GET", suffix: "/runs/2" },
    production_export_markdown: { input: { stage: "shots", version: 2 }, method: "GET", suffix: "/export?stage=shots&version=2" },
};
test("25 unified contracts route same IDs by explicit owner and reject mixed identities", () => {
    assert.equal(productionToolNames.length, 25);
    for (const name of productionToolNames) for (const kind of ["episode", "canvas"] as const) {
        const c = cases[name], raw = { kind, id: "same:id", ...c.input };
        const request = productionToolRequest(name, raw);
        assert.equal(request.method, c.method);
        assert.equal(request.path, `${kind === "episode" ? "/drama/episodes" : "/canvas/projects"}/same%3Aid/production${c.suffix}`);
        for (const invalid of [{ ...raw, projectId: "other" }, { ...raw, episodeId: "other" }, { ...raw, kind: "scene" }, { ...raw, id: undefined }]) assert.equal(productionToolSchemas[name].safeParse(invalid).success, false);
        if (request.method === "POST" && !["production_pause_run", "production_resume_run", "production_sync_clips"].includes(name)) {
            if (name === "production_split_scene") {
                const { operationId, expectedRevision, ...operation } = c.input!;
                assert.deepEqual(request.body, { operationId, expectedRevision, ops: [{ type: "split_director_scene", ...operation }] });
            } else if (name === "production_retire_run") assert.deepEqual(request.body, { reason: c.input!.reason });
            else assert.deepEqual(request.body, c.input);
        }
    }
});
test("retired production names are absent and current guidance is not rewritten", () => {
    assert.equal(Object.hasOwn(productionToolSchemas, "production_list_legacy"), false);
    for (const name of ["production_list_legacy", "production_preview_continuity_upgrade", "drama_get_production", "canvas_get_production"]) {
        assert.equal(isProductionTool(name), false);
        assert.equal(Object.hasOwn(productionToolSchemas, name), false);
    }
    const source = { nextRead: { tool: "production_get", input: { kind: "episode", id: "original" } } };
    assert.deepEqual(source.nextRead, { tool: "production_get", input: { kind: "episode", id: "original" } });
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

test("current MCP reads preserve Backend nextRead values without alias rewriting", async () => {
    const payload = { nextRead: { tool: "drama_get_production", input: { episodeId: "e" } }, data: { stable: true } };
    const result = await executeProductionTool({ get: async () => payload, post: async () => { throw new Error("Unexpected POST"); } }, "production_get", { kind: "episode", id: "e" });
    assert.equal(result, payload);
    assert.deepEqual((result as any).nextRead, { tool: "drama_get_production", input: { episodeId: "e" } });
});

test("production preflight preserves structured shared-asset binding diagnostics from Backend", async () => {
    const payload = { ok: true, preflight: { valid: false, diagnostics: [{ code: "SHARED_ASSET_BINDING_INVALID", path: "subject_registry.SUBJECT_ROLE.pictureBindings.binding.sourceNode",
        message: "图片绑定指向的本地节点没有声明当前共享来源身份", severity: "error", details: { stage: "projection_validation", reason: "binding_projection_identity_mismatch",
            sourceProjectId: "episode-canvas", sourceNodeId: "wrong-node", productionProjectId: "episode-canvas", productionNodeId: "asset-projection",
            expectedSourceProjectId: "shared-canvas", expectedSourceNodeId: "shared-role" } }] } };
    const result = await executeProductionTool({ get: async () => { throw new Error("Unexpected GET"); }, post: async (path) => {
        assert.equal(path, "/drama/episodes/ep/production/preflight");
        return payload;
    } }, "production_preflight", { kind: "episode", id: "ep", action: "compile", request: { expectedRevision: 3 } });
    assert.deepEqual((result as any).preflight.counts, { diagnostics: 1, readyTargets: 0, blockedTargets: 0, warnings: 0 });
    assert.equal((result as any).preflight.diagnostics, undefined);
    const full: any = await executeProductionTool({ get: async () => { throw new Error("Unexpected GET"); }, post: async () => payload }, "production_preflight", { kind: "episode", id: "ep", action: "compile", request: { expectedRevision: 3 }, view: "diagnostics" });
    assert.equal(full.preflight.items[0].details.expectedSourceNodeId, "shared-role");
});

test("production preflight pages bind cursors to request and revision", async () => {
    let revision = 7;
    const payload = () => ({ preflight: { valid: false, revision, diagnostics: Array.from({ length: 47 }, (_, i) => ({ code: `D${i}`, message: `diagnostic-${i}`, severity: "warning" })) } });
    const post = async () => payload();
    const first: any = await executeProductionTool({ get: async () => ({}), post }, "production_preflight", { kind: "episode", id: "ep", action: "compile", request: { expectedRevision: 3 }, view: "diagnostics" });
    assert.equal(first.preflight.items.length, 20);
    const second: any = await executeProductionTool({ get: async () => ({}), post }, "production_preflight", { kind: "episode", id: "ep", action: "compile", request: { expectedRevision: 3 }, view: "diagnostics", cursor: first.preflight.nextCursor });
    assert.equal(second.preflight.items[0].code, "D20");
    assert.equal(second.preflight.items.length, 20);
    const third: any = await executeProductionTool({ get: async () => ({}), post }, "production_preflight", { kind: "episode", id: "ep", action: "compile", request: { expectedRevision: 3 }, view: "diagnostics", cursor: second.preflight.nextCursor });
    assert.deepEqual([...first.preflight.items, ...second.preflight.items, ...third.preflight.items].map((item: any) => item.code), Array.from({ length: 47 }, (_, i) => `D${i}`));
    await assert.rejects(() => executeProductionTool({ get: async () => ({}), post }, "production_preflight", { kind: "episode", id: "ep", action: "compile", request: { expectedRevision: 4 }, view: "diagnostics", cursor: first.preflight.nextCursor }), /READ_CURSOR_EXPIRED/);
    revision++;
    await assert.rejects(() => executeProductionTool({ get: async () => ({}), post }, "production_preflight", { kind: "episode", id: "ep", action: "compile", request: { expectedRevision: 3 }, view: "diagnostics", cursor: first.preflight.nextCursor }), /READ_CURSOR_EXPIRED/);
});

test("production preflight returns oversized diagnostics through the same tool in verified chunks", async () => {
    const payload = { preflight: { valid: false, revision: 3, diagnostics: [{ code: "LARGE", message: "敏感正文".repeat(25000) }] } };
    const post = async () => payload;
    const page: any = await executeProductionTool({ get: async () => ({}), post }, "production_preflight", { kind: "episode", id: "ep", action: "compile", request: { expectedRevision: 3 }, view: "diagnostics" });
    assert.equal(JSON.stringify(page).length < 100000, true);
    assert.equal(page.preflight.items.length, 0);
    let cursor = page.preflight.nextCursor, assembled = "", firstHash = "";
    while (cursor) {
        const chunk: any = await executeProductionTool({ get: async () => ({}), post }, "production_preflight", { kind: "episode", id: "ep", action: "compile", request: { expectedRevision: 3 }, view: "diagnostics", cursor, chunkBytes: 32768 });
        assert.equal(Buffer.byteLength(chunk.preflight.diagnosticChunk.text, "utf8") <= 32768, true);
        firstHash ||= chunk.preflight.diagnosticChunk.sha256;
        assert.equal(chunk.preflight.diagnosticChunk.sha256, firstHash);
        assembled += chunk.preflight.diagnosticChunk.text;
        cursor = chunk.preflight.diagnosticChunk.nextCursor;
    }
    assert.equal(JSON.parse(assembled).message, "敏感正文".repeat(25000));
});
