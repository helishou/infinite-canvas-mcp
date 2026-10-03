import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { BackendDatabase } from "../db.js";
import { EpisodeProductionService, ProductionConflictError } from "./production.js";
import { EpisodeProductionRunner } from "./production-runner.js";
import { createStores } from "../stores/index.js";
import type { CanvasGenerationService } from "../canvas/generation-service.js";
import type { CanvasGenerationCommand } from "@basketikun/canvas-agent/generation-contract";

const scene = { id: "scene-a", heading: "内景", location: "客厅", timeOfDay: "夜", blocks: [{ id: "action-a", kind: "action" as const, text: "她发现信封。" }] };
const shot = (id: string, sceneId = "scene-a") => ({ id, sceneId, title: id, duration: 5, visual: "她拿起信封。", camera: "近景", openingState: "站在桌边", endingState: "打开信封", sound: "纸张声", assetNodeIds: [], keyframePolicy: "new" as const });

function fixture(t: test.TestContext) {
    const dir = mkdtempSync(join(tmpdir(), "episode-production-"));
    const file = join(dir, "production.sqlite");
    const db = new BackendDatabase(file);
    db.upsertCanvasFolder({ id: "drama", name: "测试剧目", createdAt: new Date().toISOString(), isDrama: true });
    db.createCanvasProject({ id: "canvas", title: "第一集", revision: 0, nodes: [], connections: [] });
    db.upsertDramaEpisode({ id: "episode", dramaId: "drama", episodeNumber: 1, title: "首集", synopsis: "梗概", fullPlot: "原有剧情原文", canvasId: "canvas" });
    const service = new EpisodeProductionService(db, undefined, dir);
    t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
    return { db, dir, file, service };
}

test("legacy sources remain intact and import only the explicitly selected draft", (t) => {
    const { dir, service } = fixture(t);
    const productionDir = join(dir, "productions", "canvas");
    mkdirSync(productionDir, { recursive: true });
    writeFileSync(join(productionDir, "script.md"), "旧剧本文本");
    writeFileSync(join(productionDir, "storyboard.md"), "旧分镜文本");
    assert.deepEqual(service.legacy("episode").map((item) => item.source), ["fullPlot", "script.md", "storyboard.md"]);
    const result = service.edit("episode", { operationId: "import-script", expectedRevision: 0, ops: [{ type: "import_legacy", source: "script.md" }] });
    assert.equal(result.draft.scenes[0].blocks[0].text, "旧剧本文本");
    assert.deepEqual(result.draft.legacyImports.map((item) => item.source), ["script.md"]);
    assert.equal(readFileSync(join(productionDir, "script.md"), "utf8"), "旧剧本文本");
});

test("edit, publication, replay, conflict, impact and version restore retain identities", (t) => {
    const { service } = fixture(t);
    const input = { operationId: "write-scene", expectedRevision: 0, ops: [{ type: "upsert_scene", scene }] };
    const first = service.edit("episode", input);
    assert.equal(first.revision, 1);
    assert.equal(service.edit("episode", input).replayed, true);
    assert.throws(() => service.edit("episode", { operationId: "stale", expectedRevision: 0, ops: [{ type: "upsert_scene", scene }] }), ProductionConflictError);
    assert.equal(service.get("episode").revision, 1);
    const script = service.publish("episode", { operationId: "publish-script", expectedRevision: 1, stage: "script" });
    assert.equal(script.publishedVersion, 1);
    assert.equal(service.publish("episode", { operationId: "publish-script", expectedRevision: 1, stage: "script" }).replayed, true);
    const edited = service.edit("episode", { operationId: "write-shots", expectedRevision: 2, ops: [{ type: "upsert_shot", shot: shot("shot-a") }, { type: "upsert_shot", shot: shot("shot-b") }] });
    assert.deepEqual(edited.draft.shots.map((item) => item.id), ["shot-a", "shot-b"]);
    const preview = service.previewImpact("episode", "shots");
    assert.deepEqual(preview.affectedShotIds, ["shot-a", "shot-b"]);
    assert.deepEqual(preview.clipGroupIds, []);
    const published = service.publish("episode", { operationId: "publish-shots", expectedRevision: 3, stage: "shots" });
    assert.deepEqual(published.impact, preview);
    assert.equal(published.published?.clipGroups.length, 0);
    assert.deepEqual(service.versions("episode").map((item) => item.version), [2, 1]);
    assert.equal(service.version("episode", 2).snapshot.shots[0].id, "shot-a");
    assert.match(service.exportMarkdown("episode", "script", 1).markdown, /她发现信封/);
    assert.match(service.exportMarkdown("episode", "shots", 2).markdown, /镜头 ID：shot-a/);
    const reordered = service.edit("episode", { operationId: "reorder", expectedRevision: 4, ops: [{ type: "reorder_shots", sceneId: "scene-a", ids: ["shot-b", "shot-a"] }] });
    assert.deepEqual(reordered.draft.shots.map((item) => item.id), ["shot-b", "shot-a"]);
    assert.deepEqual(service.previewImpact("episode", "shots").affectedShotIds, ["shot-b", "shot-a"]);
    const restored = service.restore("episode", 2, "restore", 5);
    assert.deepEqual(restored.draft.shots.map((item) => item.id), ["shot-a", "shot-b"]);
    assert.equal(restored.publishedVersion, 2);
});

test("scene reorder keeps shot IDs but changes their production order", (t) => {
    const { service } = fixture(t);
    const second = { ...scene, id: "scene-b", heading: "门口", blocks: [{ id: "action-b", kind: "action" as const, text: "她推开门。" }] };
    service.edit("episode", { operationId: "scenes", expectedRevision: 0, ops: [{ type: "upsert_scene", scene }, { type: "upsert_scene", scene: second }] });
    service.publish("episode", { operationId: "script", expectedRevision: 1, stage: "script" });
    service.edit("episode", { operationId: "shots", expectedRevision: 2, ops: [{ type: "upsert_shot", shot: shot("shot-a") }, { type: "upsert_shot", shot: shot("shot-b", "scene-b") }] });
    service.publish("episode", { operationId: "shots-pub", expectedRevision: 3, stage: "shots" });
    const reordered = service.edit("episode", { operationId: "reorder-scene", expectedRevision: 4, ops: [{ type: "reorder_scenes", ids: ["scene-b", "scene-a"] }] });
    assert.deepEqual(reordered.draft.shots.map((item) => item.id), ["shot-b", "shot-a"]);
    assert.deepEqual(service.previewImpact("episode", "script").changedSceneIds, ["scene-b", "scene-a"]);
});

test("dialogue and action blocks can be inserted, edited and reordered by stable ID", (t) => {
    const { service } = fixture(t);
    service.edit("episode", { operationId: "scene", expectedRevision: 0, ops: [{ type: "upsert_scene", scene }] });
    const inserted = service.edit("episode", { operationId: "insert-dialogue", expectedRevision: 1, ops: [{ type: "upsert_script_block", sceneId: "scene-a", beforeBlockId: "action-a", block: { id: "dialogue-a", kind: "dialogue", speaker: "她", text: "是谁寄来的？" } }] });
    assert.deepEqual(inserted.draft.scenes[0].blocks.map((item) => item.id), ["dialogue-a", "action-a"]);
    const edited = service.edit("episode", { operationId: "edit-blocks", expectedRevision: 2, ops: [{ type: "upsert_script_block", sceneId: "scene-a", block: { ...scene.blocks[0], text: "她看见信封上的署名。" } }, { type: "reorder_script_blocks", sceneId: "scene-a", ids: ["action-a", "dialogue-a"] }] });
    assert.equal(edited.draft.scenes[0].blocks[1].speaker, "她");
    assert.equal(edited.draft.scenes[0].blocks[0].text, "她看见信封上的署名。");
    const deleted = service.edit("episode", { operationId: "delete-block", expectedRevision: 3, ops: [{ type: "delete_script_block", sceneId: "scene-a", id: "dialogue-a" }] });
    assert.deepEqual(deleted.draft.scenes[0].blocks.map((item) => item.id), ["action-a"]);
});
