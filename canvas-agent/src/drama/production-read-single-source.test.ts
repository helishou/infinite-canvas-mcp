import assert from "node:assert/strict";
import test from "node:test";
import { productionEditSchema } from "./production-contract.js";
import { projectProductionRead } from "./production-read.js";

const source = { version: 2, prompt_assembly: { version: 2 }, ledger: { contract_version: 2 }, script_scenes: [{ id: "scene-1" }], shots: [{ id: "shot-1" }], segments: [{ id: "segment-1", shot_ids: ["shot-1"] }] };
const snapshot = { director: { source, sourceHash: "hash", modules: {}, assets: {}, artifacts: [] }, scenes: [{ id: "legacy-scene" }], shots: [{ id: "legacy-shot" }], clipGroups: [{ id: "legacy-segment" }], keyframes: {}, keyframeReviews: {}, settings: {} };
const production = { episodeId: "ep", revision: 4, publishedVersion: 1, updatedAt: "now", draft: snapshot, published: snapshot };

test("v2 full reads drop legacy workbench mirrors and summaries count formal source rows", () => {
    const full = projectProductionRead(production, { view: "full" }) as any;
    for (const field of ["scenes", "shots", "clipGroups"]) assert.equal(Object.hasOwn(full.draft, field), false);
    const summary = projectProductionRead(production, { view: "summary" }) as any;
    assert.deepEqual(summary.draft.counts, { scenes: 1, shots: 1, clipGroups: 1, keyframes: 0, keyframeReviews: 0 });
});

test("v2 source reads refuse legacy storyboard aliases", () => {
    assert.throws(() => projectProductionRead(production, { view: "source", sourceSection: "production_shots" }), /source\.shots/);
    assert.throws(() => projectProductionRead(production, { view: "source", sourceSection: "clip_groups" }), /source\.segments/);
});

test("ordinary production edits reject old root-level Director wrappers", () => {
    const result = productionEditSchema.safeParse({ operationId: "edit-1", expectedRevision: 0, ops: [{ type: "set_director_production", director: {} }], director: { shots: [], story: {}, clipGroups: [] } });
    assert.equal(result.success, false);
});

test("legacy published snapshots stay hidden while the current v2 draft remains readable", () => {
    const legacy = structuredClone(snapshot);
    legacy.director.source.version = 1;
    legacy.director.source.ledger.contract_version = 1;
    const mixed = { ...production, published: legacy };
    const full = projectProductionRead(mixed, { view: "full" }) as any;
    assert.equal(full.published, null);
    assert.equal(full.publishedFormatStatus, "legacy-maintenance-required");
    assert.throws(() => projectProductionRead(mixed, { view: "summary", snapshot: "published" }), /UNSUPPORTED_PRODUCTION_FORMAT/);
});
