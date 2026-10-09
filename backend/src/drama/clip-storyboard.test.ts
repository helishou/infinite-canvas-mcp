import assert from "node:assert/strict";
import test from "node:test";
import { directorModules, directorProductionSchema } from "@basketikun/canvas-agent/drama/production-contract";
import { repartitionDirectorClips } from "./clip-storyboard.js";

function shot(id: string, storyOrder: number, timelineId = "main") {
    return { id, timeline_id: timelineId, story_order: storyOrder, duration_frames: 48, visual: id, subject_usages: [], keyframes: [], utterance_refs: [] };
}

function director(segmentGroups: Array<Record<string, any>>) {
    const source = {
        prompt_assembly: { version: 2 }, fps_num: 24, fps_den: 1,
        character_registry: [], scene_registry: [], subject_registry: [], utterances: [], asset_plan: [], asset_cards: [],
        shots: [shot("S1", 0), shot("S2", 1), shot("S3", 2), shot("S4", 3)],
        segments: segmentGroups,
        ledger: { contract_version: 2, facts: [], timelines: [{ id: "main" }], initial: [], events: [], requirements: [], coverage: [] },
    };
    return directorProductionSchema.parse({
        schemaVersion: 1, engine: { commit: "a".repeat(40), patchVersion: "test", runtimeId: "test", version: "test" },
        source, sourceHash: "b".repeat(64), modules: Object.fromEntries(directorModules.map(module => [module, { status: "planned", evidence: [], unresolved: [] }])),
        artifacts: [], assets: {}, shotInputs: {}, boundaries: [], executionAuthorized: false, unresolved: [], workflow: {},
    });
}

test("repartition preserves Shot order, duration and a shared execution profile", () => {
    const value = director([{ id: "C1", shot_ids: ["S1", "S2", "S3", "S4"], mode: "Ref2VA", styleTemplateId: null }]);
    const result = repartitionDirectorClips(value, { shotIds: ["S1", "S2", "S3", "S4"], segments: [
        { shot_ids: ["S1", "S2"] }, { shot_ids: ["S3", "S4"] },
    ] });
    const source = value.source as Record<string, any>;
    assert.equal(result.totalFrames, 192);
    assert.deepEqual(source.segments.map((item: any) => item.shot_ids), [["S1", "S2"], ["S3", "S4"]]);
    assert.ok(source.segments.every((item: any) => item.mode === "Ref2VA" && item.styleTemplateId === null));
    assert.deepEqual(source.shots.map((item: any) => item.id), ["S1", "S2", "S3", "S4"]);
});

test("repartition rejects gaps and requires an explicit existing profile when old Clip settings differ", () => {
    const gapped = director([{ id: "C1", shot_ids: ["S1", "S2", "S3", "S4"], mode: "Ref2VA" }]);
    assert.throws(() => repartitionDirectorClips(gapped, { shotIds: ["S1", "S2", "S3", "S4"], segments: [{ shot_ids: ["S1", "S3"] }, { shot_ids: ["S2", "S4"] }] }), error => (error as any).diagnostics?.some((item: any) => item.code === "CLIP_PARTITION_ORDER"));

    const profiles = director([
        { id: "C1", shot_ids: ["S1", "S2"], mode: "Ref2VA", styleTemplateId: null },
        { id: "C2", shot_ids: ["S3", "S4"], mode: "I2VA", styleTemplateId: null },
    ]);
    assert.throws(() => repartitionDirectorClips(profiles, { shotIds: ["S1", "S2", "S3", "S4"], segments: [{ shot_ids: ["S1", "S2", "S3", "S4"] }] }), error => (error as any).diagnostics?.some((item: any) => item.code === "CLIP_EXECUTION_PROFILE_CONFLICT"));
    repartitionDirectorClips(profiles, { shotIds: ["S1", "S2", "S3", "S4"], segments: [{ shot_ids: ["S1", "S2", "S3", "S4"], executionProfileSourceId: "C2" }] });
    const source = profiles.source as Record<string, any>;
    assert.equal(source.segments[0].mode, "I2VA");
    assert.equal(source.segments[0].styleTemplateId, null);
    assert.equal(Object.hasOwn(source.segments[0], "executionProfileSourceId"), false);
});
