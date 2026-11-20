import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { BackendDatabase } from "../db.js";
import { EpisodeProductionService, ProductionConflictError } from "./production.js";
import { applySegmentReferenceOverrides } from "./clip-inputs.js";
import { compilationScopeInput } from "@basketikun/canvas-agent/drama/compilation-scope";
import { productionEditSchema } from "@basketikun/canvas-agent/drama/production-contract";
import { clipRefreshScope } from "./clip-refresh.js";
import type { DirectorProduction } from "@basketikun/canvas-agent/drama/production-contract";

const compilerScopeHash = (director: DirectorProduction, segmentId: string) =>
    compilationScopeInput(director, clipRefreshScope(segmentId)).inputHash;

const HASH = "b".repeat(64);
const engine = { commit: "a".repeat(40), patchVersion: "p", runtimeId: "r", version: "4.3.9" };

function seededDirector(): DirectorProduction {
    return {
        schemaVersion: 1,
        engine,
        source: {
            version: 2,
            prompt_assembly: { version: 2 },
            subject_registry: [],
            shots: [{ id: "S1", scene_id: "SC_A", timeline_id: "main", story_order: 0, duration_frames: 96, subject_usages: [], keyframes: [], utterance_refs: [] }],
            segments: [{ id: "seg-1", shot_ids: ["S1"], mode: "Ref2VA" }],
            script_scenes: [{ id: "SC_A", scene_id: "SC_A", scene_name: "房间", blocks: [{ id: "B1", kind: "action", text: "她拿起信封。" }] }],
            utterances: [],
            asset_plan: [],
            character_registry: [],
            scene_registry: [],
            ledger: { contract_version: 2, facts: [], timelines: [{ id: "main" }], initial: [], events: [], requirements: [], coverage: [] },
        },
        sourceHash: HASH,
        modules: {},
        artifacts: [],
        assets: {},
        shotInputs: {},
        boundaries: [],
        executionAuthorized: false,
        unresolved: [],
        workflow: {},
    };
}

function fixture(t: test.TestContext) {
    const dir = mkdtempSync(join(tmpdir(), "segment-reference-policy-"));
    const db = new BackendDatabase(join(dir, "production.sqlite"));
    db.upsertCanvasFolder({ id: "drama", name: "测试剧目", createdAt: new Date().toISOString(), isDrama: true });
    db.createCanvasProject({ id: "canvas", title: "第一集", revision: 0, nodes: [], connections: [] });
    db.upsertDramaEpisode({ id: "episode", dramaId: "drama", episodeNumber: 1, title: "首集", synopsis: "梗概", fullPlot: "剧情", canvasId: "canvas" });
    const service = new EpisodeProductionService(db, undefined, dir);
    t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
    return { db, service };
}

async function seed(t: test.TestContext) {
    const f = fixture(t);
    await f.service.edit("episode", {
        operationId: "seed", expectedRevision: 0,
        ops: [{ type: "set_director_production", director: seededDirector() }],
    });
    return f;
}

const seg = (id: string) => ({ id, storageKey: `media-${id}`, label: `<Picture ${id}>`, role: "character", enabled: true, usage: "reference" });

test("projection reorders and disables references strictly by the source-truth override", () => {
    const sourceSegments = [{ id: "seg-1", referenceOverrides: { mode: "manual", order: ["b", "a", "c"], disabled: ["b"] } }];
    const base = { referenceBindings: [seg("a"), seg("b"), seg("c")] };
    const out = applySegmentReferenceOverrides({ ...base, referenceBindings: [...base.referenceBindings] }, sourceSegments, "seg-1");
    assert.deepEqual(out.referenceOrder, ["b", "a", "c"]);
    assert.deepEqual(out.referenceBindings.map((b: any) => [b.id, b.enabled]), [["b", false], ["a", true], ["c", true]]);
    // 未列入 order 的绑定保持相对顺序追加到末尾，不丢失引用
    const partial = applySegmentReferenceOverrides({ referenceBindings: [seg("a"), seg("b"), seg("c")] },
        [{ id: "seg-1", referenceOverrides: { mode: "manual", order: ["c"], disabled: [] } }], "seg-1");
    assert.deepEqual(partial.referenceOrder, ["c", "a", "b"]);
});

test("projection leaves auto/unknown/unlisted overrides untouched and is idempotent", () => {
    const base = () => ({ referenceBindings: [seg("a"), seg("b")], referenceOrder: ["a", "b"] });
    const auto = applySegmentReferenceOverrides(base(), [{ id: "seg-1", referenceOverrides: { mode: "auto", order: ["b"], disabled: ["a"] } }], "seg-1");
    assert.deepEqual(auto.referenceOrder, ["a", "b"]);
    assert.deepEqual(auto.referenceBindings.map((b: any) => b.enabled), [true, true]);
    const unknown = applySegmentReferenceOverrides(base(), [], "missing");
    assert.deepEqual(unknown.referenceOrder, ["a", "b"]);
    const once = applySegmentReferenceOverrides(base(), [{ id: "seg-1", referenceOverrides: { mode: "manual", order: ["b", "a"], disabled: ["a"] } }], "seg-1");
    const twice = applySegmentReferenceOverrides(structuredClone(once), [{ id: "seg-1", referenceOverrides: { mode: "manual", order: ["b", "a"], disabled: ["a"] } }], "seg-1");
    assert.deepEqual(twice, once);
});

test("set_segment_reference_policy writes source truth, restores auto, and is idempotent by operationId", async (t) => {
    const { service } = await seed(t);
    let current = service.get("episode");
    const request = {
        operationId: "policy-manual", expectedRevision: current.revision,
        ops: [{ type: "set_segment_reference_policy" as const, segmentId: "seg-1", mode: "manual" as const, order: ["b", "a"], disabled: ["b"] }],
    };
    const saved = await service.edit("episode", request);
    assert.deepEqual((saved.draft.director!.source.segments as any[])[0].referenceOverrides, { mode: "manual", order: ["b", "a"], disabled: ["b"] });
    current = service.get("episode");
    const replay = await service.edit("episode", request);
    assert.equal(replay.revision, current.revision, "replay must not advance revision");

    // partial update merges into existing override
    const merged = await service.edit("episode", {
        operationId: "policy-partial", expectedRevision: replay.revision,
        ops: [{ type: "set_segment_reference_policy", segmentId: "seg-1", disabled: ["a"] }],
    });
    assert.deepEqual((merged.draft.director!.source.segments as any[])[0].referenceOverrides, { mode: "manual", order: ["b", "a"], disabled: ["a"] });

    // auto mode clears the override entirely -> derived again
    const auto = await service.edit("episode", {
        operationId: "policy-auto", expectedRevision: merged.revision,
        ops: [{ type: "set_segment_reference_policy", segmentId: "seg-1", mode: "auto" }],
    });
    assert.equal(Object.hasOwn((auto.draft.director!.source.segments as any[])[0], "referenceOverrides"), false);
});

test("set_segment_reference_policy rejects unknown segment and stale revision", async (t) => {
    const { service } = await seed(t);
    const current = service.get("episode");
    let unknownMessage = "";
    try {
        await service.edit("episode", { operationId: "unknown-target", expectedRevision: current.revision,
            ops: [{ type: "set_segment_reference_policy", segmentId: "missing", mode: "manual", order: [] }] });
    } catch (error) { unknownMessage = String((error as Error)?.message || error); }
    assert.match(unknownMessage, /SEGMENT_REFERENCE_TARGET_UNKNOWN/);

    let staleMessage = "";
    try {
        await service.edit("episode", { operationId: "stale", expectedRevision: current.revision + 1,
            ops: [{ type: "set_segment_reference_policy", segmentId: "seg-1", mode: "manual", order: [] }] });
    } catch (error) { staleMessage = String((error as Error)?.message || error); }
    assert.match(staleMessage, /revision|REVISION_CONFLICT|版本已变化/i);
});

test("policy edit changes the segment compilation-scope hash so H3 clip recompilation is triggered", async (t) => {
    const { service } = await seed(t);
    const before = structuredClone(service.get("episode").draft.director!);
    const beforeHash = compilerScopeHash(before, "seg-1");
    const current = service.get("episode");
    const saved = await service.edit("episode", {
        operationId: "policy-recompile", expectedRevision: current.revision,
        ops: [{ type: "set_segment_reference_policy", segmentId: "seg-1", mode: "manual", order: ["b", "a"], disabled: ["b"] }],
    });
    const afterHash = compilerScopeHash(saved.draft.director!, "seg-1");
    assert.notEqual(afterHash, beforeHash, "source override must alter compilationScope inputHash");
});

test("POST /production/episodes/:id/ops body is accepted by the shared edit contract", () => {
    const body = {
        operationId: "ui-reference-policy-1",
        expectedRevision: 12,
        ops: [{ type: "set_segment_reference_policy", segmentId: "seg-1", mode: "manual", order: ["b", "a"], disabled: ["b"] }],
    };
    assert.equal(productionEditSchema.safeParse(body).success, true);
    const restore = { ...body, operationId: "ui-reference-policy-2", ops: [{ type: "set_segment_reference_policy", segmentId: "seg-1", mode: "auto" }] };
    assert.equal(productionEditSchema.safeParse(restore).success, true);
});
