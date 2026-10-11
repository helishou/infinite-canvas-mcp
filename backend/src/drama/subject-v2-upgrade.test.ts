import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { directorModules, directorSourceV2Diagnostics, isSubjectPromptAssembly } from "@basketikun/canvas-agent/drama/production-contract";
import { resolveAchengEngine } from "@basketikun/canvas-agent/skills/acheng";
import { BackendDatabase } from "../db.js";
import { BackendEventBus } from "../events.js";
import { EpisodeProductionService } from "./production.js";
import { directorHash } from "./director.js";
import { convertDirectorSourceToSubjectV2 } from "./subject-v2-upgrade.js";

function legacySource() {
    return {
        fps_num: 24, fps_den: 1, brief: "旧稿",
        character_registry: [{ id: "CHAR_LIXI", name: "黎希", prompt_description: "approved identity" }],
        scene_registry: [{ id: "SCENE1", name: "办公室" }],
        asset_plan: [{ id: "A1", asset_id: "A1", entity_id: "CHAR_LIXI", kind: "character", status: "approved" }],
        script_scenes: [], asset_cards: [],
        shots: [
            { id: "S1", scene_id: "SCENE1", title: "开场", start_frame: 0, end_frame: 96,
                visual: "黎希在办公桌前签合同。", camera: { description: "固定机位" },
                characters: [{ id: "CHAR_LIXI" }],
                dialogues: [{ speaker_id: "S1", speaker_name: "黎希", text: "人类的欲望，从来不会让我失望。", start: 0, end: 84, voiceover: false },
                    { speaker_id: "S4", speaker_name: "下属", text: "黎希大人，年度指标已完成。", start: 84, end: 96, voiceover: true }],
                state_in: "calm", state_out: "calm", state_description: "calm throughout", required_assets: [], required_prop_ids: [], reference_requirements: [] },
            { id: "S2", scene_id: "SCENE1", title: "收尾", start_frame: 96, end_frame: 192,
                visual: "下属退场。", characters: [{ id: "CHAR_LIXI" }], dialogues: [] },
        ],
        segments: [{ id: "SEG01", start_frame: 0, end_frame: 192, shot_ids: ["S1", "S2"], mode: "Ref2VA", mode_lock: "Ref2VA", mode_selection_reason: "legacy" }],
        ledger: { initial: { characters: { CHAR_LIXI: {} }, scenes: {}, props: {} }, events: [], film_flow: [] },
    };
}

function fixture(t: test.TestContext) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "subject-v2-upgrade-"));
    const db = new BackendDatabase(path.join(directory, "runtime.sqlite")), events = new BackendEventBus();
    db.upsertCanvasFolder({ id: "drama", name: "Drama", createdAt: new Date().toISOString(), isDrama: true });
    db.upsertDramaEpisode({ id: "ep", dramaId: "drama", episodeNumber: 1, title: "Episode", synopsis: "" });
    const service = new EpisodeProductionService(db, events, directory, false, () => {});
    const current = service.get("ep");
    const source = legacySource() as Record<string, any>;
    const runtime = resolveAchengEngine();
    const director = {
        schemaVersion: 1, engine: { commit: runtime.commit, patchVersion: runtime.patchVersion, runtimeId: runtime.runtimeId, version: runtime.version },
        source, sourceHash: directorHash(source),
        modules: Object.fromEntries(directorModules.map(module => [module, { status: "planned" as const, evidence: [], unresolved: [] }])),
        artifacts: [], assets: {}, shotInputs: {}, boundaries: [], executionAuthorized: false, unresolved: [],
        workflow: { contentDeliveryMode: "auto_file_batch" as const, mediaProductionMode: "per_item" as const },
    };
    service.edit("ep", { operationId: "seed-legacy", expectedRevision: current.revision, ops: [{ type: "set_director_production", director }] } as any);
    t.after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
    return { service, db };
}

test("converts legacy v1 source into contract-valid Subject Prompt v2", () => {
    const { source, notes, issues } = convertDirectorSourceToSubjectV2("ep", legacySource() as Record<string, any>);
    assert.equal(issues.length, 0, JSON.stringify(issues));
    assert.ok(isSubjectPromptAssembly(source));
    assert.equal(source.ledger.contract_version, 2);
    assert.ok(source.legacyContinuityProjection);
    assert.ok(source.subject_registry.length >= 2);
    assert.equal(source.shots[0].duration_frames, 96);
    assert.equal(source.shots[0].timeline_id, "main");
    assert.equal(source.shots[0].story_order, 0);
    assert.equal(source.shots[1].story_order, 1);
    assert.ok(source.utterances.length === 2);
    assert.ok(source.shots[0].utterance_refs.length === 2);
    assert.ok(notes.some(note => note.includes("legacyContinuityProjection")));
    assert.ok(source.shots[0].subject_usages.some((usage: any) => usage.presentation === "offscreen_voice"));
    assert.ok(source.character_registry.some((character: any) => character.id.startsWith("CHAR_OFF_")));
});

test("service upgrade switches the draft to v2 and enables clip repartition", t => {
    const { service } = fixture(t);
    const current = service.get("ep");
    const receipt = service.upgradeSubjectV2("ep", { operationId: "upgrade-1", expectedRevision: current.revision });
    assert.ok(Array.isArray(receipt.notes) && receipt.notes.length);
    const upgraded = service.get("ep");
    const source = upgraded.draft.director!.source as Record<string, any>;
    assert.ok(isSubjectPromptAssembly(source));
    assert.deepEqual(directorSourceV2Diagnostics(source), []);
    assert.equal(upgraded.draft.director!.executionAuthorized, false);
    assert.ok(upgraded.revision > current.revision);
    // Replay is idempotent by operationId.
    const replay = service.upgradeSubjectV2("ep", { operationId: "upgrade-1", expectedRevision: current.revision });
    assert.equal((replay as any).replayed, true);
    // The actual goal: repartition ops are now accepted (v1 used to reject with SUBJECT_SOURCE_VERSION_REQUIRED).
    const edit = service.edit("ep", { operationId: "repartition-after-upgrade", expectedRevision: upgraded.revision,
        ops: [{ type: "repartition_director_clips", shotIds: ["S1", "S2"], segments: [
            { shot_ids: ["S1"], mode: "Ref2VA", mode_lock: "Ref2VA", mode_selection_reason: "migrated single-shot clip", styleTemplateId: null },
            { shot_ids: ["S2"], mode: "Ref2VA", mode_lock: "Ref2VA", mode_selection_reason: "migrated single-shot clip", styleTemplateId: null }] }] } as any);
    assert.ok(edit);
    const after = service.get("ep");
    const segments = (after.draft.director!.source as Record<string, any>).segments as Array<Record<string, any>>;
    assert.deepEqual(segments.map(segment => segment.shot_ids), [["S1"], ["S2"]]);
});
