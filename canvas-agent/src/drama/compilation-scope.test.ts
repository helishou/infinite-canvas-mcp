import assert from "node:assert/strict";
import test from "node:test";
import { compilationHash, compilationScopeInput, currentCompilationArtifact, preserveCompilationProvenance, scopedCompilerInput } from "./compilation-scope.js";
import type { DirectorProduction } from "./production-contract.js";
import { auditAchengContinuity, resolveAchengEngine } from "../skills/acheng.js";

export function scopedDirector(): DirectorProduction {
    const source = { brief: "confirmed", script_scenes: [{ id: "A", scene_id: "ROOM", beat_ids: ["a"] }, { id: "B", scene_id: "ROOM", beat_ids: ["b"] }], shots: [{ id: "SA", source_scene_id: "A", scene_id: "ROOM", visual: "A", required_assets: ["ROLE"] }, { id: "SB", source_scene_id: "B", scene_id: "ROOM", visual: "B", required_assets: ["ROLE"] }], segments: [{ id: "GA", shot_ids: ["SA"] }, { id: "GB", shot_ids: ["SB"] }], asset_plan: [{ id: "ROLE", canvas_scope: "shared" }, { id: "KA", canvas_scope: "episode", shot_ids: ["SA"], depends_on: ["ROLE"] }, { id: "KB", canvas_scope: "episode", shot_ids: ["SB"], depends_on: ["ROLE"] }], asset_cards: [{ id: "KA", references: [{ asset_id: "ROLE" }] }, { id: "KB", references: [{ asset_id: "ROLE" }] }] };
    return { schemaVersion: 1, engine: { commit: "a".repeat(40), patchVersion: "test", runtimeId: "test", version: "test" }, source, sourceHash: compilationHash(source), modules: {}, artifacts: [], assets: { ROLE: { version: "v1", status: "approved", storageKey: "role", sha256: "a".repeat(64) }, KA: { version: "v1", status: "planned" }, KB: { version: "v1", status: "planned" } }, shotInputs: { SA: { assetIds: ["ROLE"], keyframeAssetId: "KA" }, SB: { assetIds: ["ROLE"], keyframeAssetId: "KB" } }, boundaries: [], workflow: {}, unresolved: [], executionAuthorized: false };
}
test("same-environment scene occurrences have isolated compiler inputs and real dependency closures", () => {
    const d = scopedDirector(), a = compilationScopeInput(d, { sceneId: "A" });
    assert.deepEqual((a.director.source.shots as any[]).map(item => item.id), ["SA"]);
    assert.deepEqual(a.targetIds, ["GA", "KA", "ROLE"]);
    const b = structuredClone(d); (b.source.shots as any[])[1].visual = "changed B"; b.sourceHash = compilationHash(b.source);
    assert.equal(compilationScopeInput(b, { sceneId: "A" }).inputHash, a.inputHash);
    b.assets.ROLE.sha256 = "b".repeat(64);
    assert.notEqual(compilationScopeInput(b, { sceneId: "A" }).inputHash, a.inputHash);
});
test("scoped ledger retains coverage using the authored source anchor", () => {
    const d = scopedDirector();
    (d.source.script_scenes as any[])[0].blocks = [{ id: "A1", kind: "action", text: "Enter" }];
    (d.source.script_scenes as any[])[1].blocks = [{ id: "B1", kind: "action", text: "Leave" }];
    d.source.ledger = { contract_version: 2, coverage: [{ id: "CA", source_anchor: { block_id: "A1" } }, { id: "CB", source_anchor: { block_id: "B1" } }] };
    const a = compilationScopeInput(d, { sceneId: "A" });
    assert.deepEqual((a.director.source.ledger as any).coverage.map((row: any) => row.id), ["CA"]);
});

test("scoped replay retains genuine foreign asset identities without expanding output or media", () => {
    const director = scopedDirector();
    (director.source.asset_plan as any[]).push({ id: "FOREIGN_PROP", canvas_scope: "episode", shot_ids: ["SB"] });
    director.source.ledger = { contract_version: 2, facts: [{ id: "FOREIGN_STATE", object_kind: "asset", object_id: "FOREIGN_PROP" }] };
    const before = structuredClone(director);
    const scoped = compilationScopeInput(director, { sceneId: "A" });
    assert.ok((scoped.director.source._canvas_continuity_asset_registry as any[]).some(item => item.id === "FOREIGN_PROP"));
    assert.ok(!(scoped.director.source.asset_plan as any[]).some(item => item.id === "FOREIGN_PROP"));
    assert.ok(!scoped.targetIds.includes("FOREIGN_PROP"));
    assert.equal(scoped.director.assets.FOREIGN_PROP, undefined);
    assert.deepEqual(director, before);
});

test("one Clip keeps shared-block coverage, event references and replay context without compiling sibling Clips", () => {
    const d = scopedDirector(), runtime = resolveAchengEngine();
    d.engine = { commit: runtime.commit, patchVersion: runtime.patchVersion, runtimeId: runtime.runtimeId, version: runtime.version };
    const block = { id: "BLOCK", kind: "action", text: "The door opens and then closes." };
    d.source.script_scenes = [{ id: "A", scene_id: "ROOM", blocks: [block] }];
    d.source.character_registry = [{ id: "CHAR", name: "Alex" }];
    d.source.scene_registry = [{ id: "ROOM", name: "Room" }];
    d.source.shots = ["SA", "SB"].map((id, order) => ({ id, source_scene_id: "A", scene_id: "ROOM", timeline_id: "T", story_order: order, start_frame: order * 120, end_frame: (order + 1) * 120, continuity_facts: ["F"], visual: "The door changes state." }));
    d.source.ledger = { contract_version: 2, facts: [{ id: "F", object_kind: "character", object_id: "CHAR", allowed_values: ["closed", "open"] }], timelines: [{ id: "T" }], initial: [{ timeline_id: "T", fact_id: "F", value: "closed" }],
        events: ["SA", "SB"].map((shot_id, order) => ({ id: `E${order}`, shot_id, timeline_id: "T", fact_id: "F", frame: order * 120 + 10, before: order ? "open" : "closed", after: order ? "closed" : "open", reason: "The authored door action changes the state.", source_anchor: { block_id: "BLOCK" } })), requirements: ["SA", "SB"].map((shot_id, order) => ({ id: `R${order}`, shot_id, timeline_id: "T", fact_id: "F", kind: "change", event_ids: [`E${order}`] })),
        coverage: [{ id: "C", timeline_id: "T", source_anchor: { block_id: "BLOCK" }, source_digest: compilationHash({ scene_id: "ROOM", block }), evidence_kind: "explicit_change", fact_ids: ["F"], event_ids: ["E0", "E1"], shot_ids: ["SA", "SB"] }] };
    const before = structuredClone(d);
    const projected = compilationScopeInput(d, { sceneId: "A", targetIds: ["GB"] });
    assert.deepEqual((projected.director.source.segments as any[]).map(segment => segment.id), ["GB"]);
    assert.ok(!projected.targetIds.includes("GA"));
    assert.ok(!projected.targetIds.includes("KA"));
    assert.deepEqual((projected.director.source.ledger as any).events.map((event: any) => event.id), ["E0", "E1"]);
    const normalized = scopedCompilerInput(projected.director, { targetIds: ["GB"] });
    const checked = auditAchengContinuity(normalized, ["GB"]);
    assert.equal(checked.status, "passed", JSON.stringify(checked.diagnostics));
    assert.equal(checked.trajectories.SB.start.F, "open");
    assert.deepEqual(d, before);
    assert.throws(() => compilationScopeInput(d, { targetIds: ["MISSING"] }), /UNKNOWN_TARGET/);
});

test("asset-card references are included in the compiler dependency closure", () => {
    const director = scopedDirector();
    (director.source.asset_plan as any[]).push({ id: "REFERENCE_ONLY", canvas_scope: "shared" });
    (director.source.asset_cards as any[])[0].references.push({ asset_id: "REFERENCE_ONLY" });
    const scope = compilationScopeInput(director, { targetIds: ["KA"] });
    assert.ok(scope.targetIds.includes("REFERENCE_ONLY"));
    assert.ok((scope.director.source.asset_plan as any[]).some(item => item.id === "REFERENCE_ONLY"));
});
test("scope normalization moves reference windows with the authored shot frames", () => {
    const d = scopedDirector();
    (d.source.shots as any[])[0].start_frame = 600;
    (d.source.shots as any[])[0].end_frame = 720;
    (d.source.segments as any[])[0].references = [{ start_frame: 600, end_frame: 720 }];
    const projected = compilationScopeInput(d, { sceneId: "A" }).director;
    const normalized = scopedCompilerInput(projected, { sceneId: "A" });
    assert.deepEqual((normalized.source.segments as any[])[0].references, [{ start_frame: 0, end_frame: 120 }]);
    assert.equal((d.source.shots as any[])[0].start_frame, 600);
});
test("scoped receipts preserve original provenance across unrelated edits, but reject changed inputs", () => {
    const d = scopedDirector(), scope = { targetIds: ["KA"] }, input = compilationScopeInput(d, scope);
    const artifact: DirectorProduction["artifacts"][number] = { id: "image-KA", kind: "image", targetId: "KA", prompt: "authored", sha256: compilationHash("prompt"), sourceHash: d.sourceHash, status: "ready", references: [], receipt: { sourceHash: d.sourceHash, compilationScope: { scope, inputHash: input.inputHash } } };
    const changed = structuredClone(d); (changed.source.shots as any[])[1].visual = "other edit"; changed.sourceHash = compilationHash(changed.source);
    assert.equal(currentCompilationArtifact(changed, artifact), true);
    (changed.source.shots as any[])[0].visual = "my edit"; changed.sourceHash = compilationHash(changed.source);
    assert.equal(currentCompilationArtifact(changed, artifact), false);
    assert.equal(artifact.sourceHash, d.sourceHash);
    assert.throws(() => compilationScopeInput(d, { sceneId: "missing" }), /UNKNOWN_SCENE/);
});

test("engine changes retain legacy scoped receipt validity without accepting changed source or prompt identity", () => {
    const director = scopedDirector(), scope = { targetIds: ["KA"] };
    const artifact: DirectorProduction["artifacts"][number] = { id: "image-KA", kind: "image", targetId: "KA", prompt: "original", sha256: "a".repeat(64), sourceHash: director.sourceHash, status: "ready", references: [],
        receipt: { sourceHash: director.sourceHash, engineRuntimeId: director.engine.runtimeId, compilationScope: { scope, inputHash: compilationScopeInput(director, scope).legacyInputHash } } };
    director.artifacts = [artifact];
    preserveCompilationProvenance(director);
    const originalReceipt = structuredClone(artifact.receipt);
    director.engine = { commit: "b".repeat(40), patchVersion: "new", runtimeId: "new", version: "2" };
    assert.equal(currentCompilationArtifact(director, artifact), true);
    assert.deepEqual(artifact.receipt, originalReceipt);
    (director.source.shots as any[])[0].visual = "changed relevant action";
    assert.equal(currentCompilationArtifact(director, artifact), false);
});
