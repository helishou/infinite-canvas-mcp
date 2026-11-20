import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { emptyEpisodeProduction } from "@basketikun/canvas-agent/drama/production-contract";
import { BackendDatabase } from "../db.js";
import { BackendEventBus } from "../events.js";
import { directorHash, projectDirector, withoutDirectorProjection } from "./director.js";
import { EpisodeProductionService } from "./production.js";

function fixture(t: test.TestContext) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "shot-editor-fields-"));
    const file = path.join(directory, "db.sqlite");
    const db = new BackendDatabase(file);
    const events = new BackendEventBus();
    db.upsertCanvasFolder({ id: "drama", name: "Drama", createdAt: new Date().toISOString(), isDrama: true });
    db.upsertDramaEpisode({ id: "ep", dramaId: "drama", episodeNumber: 1, title: "Episode", synopsis: "" });
    const service = new EpisodeProductionService(db, events, directory, false, () => {});
    t.after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
    return { db, service };
}

/** 真数据副本：首镜 s1 + 次镜 s2，两镜都没有 action/imagePrompt/transition。 */
function directorWithShots() {
    const source = {
        version: 2, prompt_assembly: { version: 2 }, fps_num: 24, fps_den: 1, style_policy: "waived", style_policy_reason: "test",
        subject_registry: [], character_registry: [], scene_registry: [{ id: "room", name: "房间" }],
        script_scenes: [{ id: "sc", scene_id: "room", scene_name: "房间", text: "开场" }],
        asset_plan: [],
        shots: [
            { id: "s1", title: "镜一", scene_id: "room", source_scene_id: "sc", timeline_id: "main", story_order: 0,
                duration_frames: 120, visual: "甲站在门口", camera: { framing: "MS", movement: "static" } },
            { id: "s2", title: "镜二", scene_id: "room", source_scene_id: "sc", timeline_id: "main", story_order: 1,
                duration_frames: 120, visual: "甲走进屋", camera: { framing: "MS", movement: "static" } },
        ],
        utterances: [],
        segments: [{ id: "seg1", timeline_id: "main", shot_ids: ["s1", "s2"], mode: "T2VA" }],
        ledger: { contract_version: 2, facts: [], timelines: [{ id: "main", start_frame: 0 }], initial: [], events: [], requirements: [], coverage: [] },
    };
    return {
        schemaVersion: 1,
        engine: { commit: "a".repeat(40), patchVersion: "test", runtimeId: "test-engine", version: "4.3.9" },
        source, sourceHash: directorHash(source), modules: {}, artifacts: [], assets: {}, shotInputs: {}, boundaries: [],
        executionAuthorized: false, unresolved: [], workflow: { mediaProductionMode: "per_item" },
    } as any;
}

function seed(t: test.TestContext) {
    const f = fixture(t);
    const draft = emptyEpisodeProduction();
    draft.director = structuredClone(directorWithShots());
    projectDirector(draft);
    f.db.db.prepare("INSERT INTO episode_productions (episode_id, revision, draft_json, published_json, published_version, updated_at) VALUES (?, 1, ?, NULL, 0, ?)")
        .run("ep", JSON.stringify(withoutDirectorProjection(draft)), new Date().toISOString());
    return f;
}
const edit = (service: EpisodeProductionService, revision: number, ops: any[]) =>
    service.edit("ep", { operationId: crypto.randomUUID(), expectedRevision: revision, ops });
const shotOf = (record: any, id: string) => record.draft.director.source.shots.find((s: any) => s.id === id);

test("patch_director_source 写 action/imagePrompt/transition 到 director.source.shots 真值并落库重读", async t => {
    const { service } = seed(t);
    const before = service.get("ep");
    assert.equal(shotOf(before, "s1").action, undefined);
    assert.equal(shotOf(before, "s1").imagePrompt, undefined);
    assert.equal(shotOf(before, "s1").transition, undefined);

    const after = await edit(service, before.revision, [{
        type: "patch_director_source", entity: "shot", id: "s1",
        patch: { action: "甲推门进入", imagePrompt: "清晨门口的近景", transition: "fade" },
    }]);
    assert.equal(shotOf(after, "s1").action, "甲推门进入");
    assert.equal(shotOf(after, "s1").imagePrompt, "清晨门口的近景");
    assert.equal(shotOf(after, "s1").transition, "fade");
    assert.equal(shotOf(after, "s1").visual, "甲站在门口", "同镜未提交字段保留");
    assert.equal(shotOf(after, "s2").action, undefined, "邻镜不变");
    assert.notEqual(after.draft.director!.sourceHash, before.draft.director!.sourceHash);

    // 真值落库：从 DB 重新读取仍是写入值
    const reread = service.get("ep");
    assert.equal(reread.revision, after.revision);
    assert.equal(shotOf(reread, "s1").action, "甲推门进入");
    assert.equal(shotOf(reread, "s1").imagePrompt, "清晨门口的近景");
    assert.equal(shotOf(reread, "s1").transition, "fade");
    assert.equal(reread.draft.director!.sourceHash, after.draft.director!.sourceHash);
});

test("单字段续写只覆盖目标字段；首镜 transition 后端不施加 UI 的 disabled 约束", async t => {
    const { service } = seed(t);
    const first = await edit(service, service.get("ep").revision, [{
        type: "patch_director_source", entity: "shot", id: "s1",
        patch: { action: "甲推门", imagePrompt: "门口近景", transition: "cut" },
    }]);
    // s1 是首镜（story_order=0）；UI 里 disabled，但后端照存。
    assert.equal(shotOf(first, "s1").transition, "cut");
    const second = await edit(service, first.revision, [{
        type: "patch_director_source", entity: "shot", id: "s1", patch: { action: "甲转身离开" },
    }]);
    assert.equal(shotOf(second, "s1").action, "甲转身离开");
    assert.equal(shotOf(second, "s1").imagePrompt, "门口近景", "续写 action 不丢 imagePrompt");
    assert.equal(shotOf(second, "s1").transition, "cut", "续写 action 不丢 transition");
    const reread = shotOf(service.get("ep"), "s1");
    assert.equal(reread.action, "甲转身离开");
    assert.equal(reread.imagePrompt, "门口近景");
    assert.equal(reread.transition, "cut");
});

test("未登记字段经生产编辑真链被拒绝，不污染真值", async t => {
    const { service } = seed(t);
    await assert.rejects(
        async () => edit(service, service.get("ep").revision, [{
            type: "patch_director_source", entity: "shot", id: "s1", patch: { inventedShotField: "x" },
        }]),
        /不允许直接修改字段|unrecognized|unexpected|解析|校验|invalid/i,
    );
    assert.equal(shotOf(service.get("ep"), "s1").inventedShotField, undefined);
});
