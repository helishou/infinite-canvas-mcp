import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { BackendDatabase } from "../db.js";
import { DATABASE_SCHEMA_VERSION } from "../database-upgrade.js";
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
    assert.deepEqual(preview.clipGroupIds, ["clip:shot-a", "clip:shot-b"]);
    const published = service.publish("episode", { operationId: "publish-shots", expectedRevision: 3, stage: "shots" });
    assert.deepEqual(published.impact, preview);
    assert.equal(published.published?.clipGroups.length, 2);
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

test("auto mode stores a version-scoped plan and pauses only when an image model is missing", async (t) => {
    const { service, db } = fixture(t);
    service.edit("episode", { operationId: "s", expectedRevision: 0, ops: [{ type: "upsert_scene", scene }] });
    service.publish("episode", { operationId: "ps", expectedRevision: 1, stage: "script" });
    service.edit("episode", { operationId: "mode-shot", expectedRevision: 2, ops: [{ type: "upsert_shot", shot: shot("shot-a") }, { type: "set_settings", patch: { mode: "auto" } }] });
    service.publish("episode", { operationId: "publish-auto", expectedRevision: 3, stage: "shots" });
    const run = service.run("episode", 2);
    assert.equal(run?.status, "pending");
    assert.deepEqual(run?.submitted, []);
    assert.equal(db.listTasks({ limit: 10 }).length, 0);
    assert.equal(service.get("episode").draft.settings.imageQuota, undefined);
    let attempted = 0;
    const fake = { start: () => { attempted += 1; throw new Error("paid generation must not start"); } } as unknown as CanvasGenerationService;
    const runner = new EpisodeProductionRunner(service, createStores(db), fake);
    await runner.run("episode", 2);
    assert.equal(service.run("episode", 2)?.status, "paused");
    assert.equal(attempted, 0);
    assert.match(service.run("episode", 2)?.error || "", /缺少图片模型/);
});

test("publication inherits and freezes node models and configured defaults without budgets", (t) => {
    const { service, db } = fixture(t);
    db.setSetting("ai.config", { imageModel: "configured-image" });
    db.setSetting("plugin:minimax-h3:defaults:v1", { modelName: "configured-h3" });
    db.applyCanvasProjectOperations("canvas", undefined, [
        { type: "add_node", id: "frame", nodeType: "image", metadata: { model: "node-image", storageKey: "image:old" } },
        { type: "add_node", id: "h3", nodeType: "minimax-h3:video", metadata: { modelName: "node-h3", segments: [{ id: "segment", modelName: "segment-h3" }] } },
    ]);
    service.edit("episode", { operationId: "s", expectedRevision: 0, ops: [{ type: "upsert_scene", scene }] });
    service.publish("episode", { operationId: "ps", expectedRevision: 1, stage: "script" });
    service.edit("episode", { operationId: "shots", expectedRevision: 2, ops: [
        { type: "upsert_shot", shot: shot("a") }, { type: "upsert_shot", shot: shot("b") },
        { type: "set_keyframe", shotId: "a", nodeId: "frame" },
        { type: "set_clip_group", group: { id: "mapped", shotIds: ["a"], nodeId: "h3", segmentId: "segment", sourceVersion: 1 } },
        { type: "set_settings", patch: { mode: "auto" } },
    ] });
    service.publish("episode", { operationId: "pub", expectedRevision: 3, stage: "shots" });
    const settings = service.version("episode", 2).snapshot.settings;
    assert.deepEqual(settings.imageModels, { a: "node-image", b: "configured-image" });
    assert.deepEqual(settings.h3Models, { mapped: "segment-h3", "clip:b": "configured-h3" });
    db.setSetting("ai.config", { imageModel: "changed-image" });
    db.setSetting("plugin:minimax-h3:defaults:v1", { modelName: "changed-h3" });
    assert.deepEqual(service.version("episode", 2).snapshot.settings, settings);
    assert.equal(service.run("episode", 2)?.status, "pending");
});

test("H3 sync updates a stable segment without replacing its historical result", async (t) => {
    const { service, db } = fixture(t);
    db.applyCanvasProjectOperations("canvas", undefined, [{ type: "add_node", id: "h3", nodeType: "minimax-h3:video", metadata: { segments: [{ id: "clip-1", prompt: "old", resultStorageKey: "video:old", results: [{ storageKey: "video:old" }] }] } }]);
    service.edit("episode", { operationId: "s", expectedRevision: 0, ops: [{ type: "upsert_scene", scene }] });
    service.publish("episode", { operationId: "ps", expectedRevision: 1, stage: "script" });
    service.edit("episode", { operationId: "shot", expectedRevision: 2, ops: [{ type: "upsert_shot", shot: shot("shot-a") }, { type: "set_clip_group", group: { id: "group-a", shotIds: ["shot-a"], nodeId: "h3", segmentId: "clip-1", sourceVersion: 1 } }] });
    service.publish("episode", { operationId: "publish", expectedRevision: 3, stage: "shots" });
    const runner = new EpisodeProductionRunner(service, createStores(db), { start: () => { throw new Error("generation was not requested"); } } as unknown as CanvasGenerationService);
    const result = await runner.syncClips("episode", 2);
    const node = (db.getCanvasProject("canvas")?.nodes as Array<Record<string, any>>).find((item) => item.id === "h3")!;
    const segment = node.metadata.segments[0];
    assert.equal(segment.id, "clip-1");
    assert.equal(segment.resultStorageKey, "video:old");
    assert.deepEqual(segment.results, [{ storageKey: "video:old" }]);
    assert.equal(result.published?.clipGroups[0].segmentId, "clip-1");
    db.createCanvasProject({ id: "other-canvas", title: "另一个画布", revision: 0, nodes: [], connections: [] });
    db.updateDramaEpisode("episode", { canvasId: "other-canvas" });
    assert.throws(() => service.bindRuntime("episode", 2, { groupId: "group-a", nodeId: "h3", segmentId: "clip-1" }), /找不到节点/);
    assert.equal((db.getCanvasProject("canvas")?.nodes as Array<Record<string, any>>)[0].metadata.segments[0].resultStorageKey, "video:old");
});

test("new shots append stable Clips to one episode H3 node", async (t) => {
    const { service, db } = fixture(t);
    service.edit("episode", { operationId: "s", expectedRevision: 0, ops: [{ type: "upsert_scene", scene }] });
    service.publish("episode", { operationId: "ps", expectedRevision: 1, stage: "script" });
    service.edit("episode", { operationId: "shots", expectedRevision: 2, ops: [{ type: "upsert_shot", shot: shot("shot-a") }, { type: "upsert_shot", shot: shot("shot-b") }] });
    service.publish("episode", { operationId: "pub", expectedRevision: 3, stage: "shots" });
    const runner = new EpisodeProductionRunner(service, createStores(db), { start: () => { throw new Error("no generation"); } } as unknown as CanvasGenerationService);
    await runner.syncClips("episode", 2);
    const first = service.get("episode").published!.clipGroups;
    assert.equal(first[0].nodeId, first[1].nodeId);
    assert.notEqual(first[0].segmentId, first[1].segmentId);
    const project = db.getCanvasProject("canvas")!;
    const node = (project.nodes as Array<Record<string, any>>).find((item) => item.id === first[0].nodeId)!;
    assert.equal(node.metadata.segments.length, 2);
    assert.equal(node.width, 1960);
    assert.equal(node.height, 1080);
    assert.match(node.metadata.segments[0].prompt, /integrated_multimodal_description:/);
    await runner.syncClips("episode", 2);
    const repeated = db.getCanvasProject("canvas")!;
    assert.equal((repeated.nodes as Array<Record<string, any>>).find((item) => item.id === first[0].nodeId)!.metadata.segments.length, 2);
});

test("schema 14 upgrade snapshots the old database and preserves episode data", (t) => {
    const dir = mkdtempSync(join(tmpdir(), "episode-migrate-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, "legacy.sqlite");
    const old = new BackendDatabase(file);
    old.upsertCanvasFolder({ id: "drama", name: "历史剧目", createdAt: new Date().toISOString(), isDrama: true });
    old.upsertDramaEpisode({ id: "episode", dramaId: "drama", episodeNumber: 1, title: "历史首集", synopsis: "旧梗概", fullPlot: "旧原文" });
    old.db.prepare("DELETE FROM schema_migrations WHERE version>=15").run();
    old.close();
    const reopened = new BackendDatabase(file);
    try {
        assert.equal(reopened.getDramaEpisode("episode")?.fullPlot, "旧原文");
        assert.equal((reopened.db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number }).version, DATABASE_SCHEMA_VERSION);
        assert.ok(readdirSync(dir).some((name) => name.includes(`pre-schema-v14-to-v${DATABASE_SCHEMA_VERSION}`)));
    } finally { reopened.close(); }
});

test("simulated image and H3 submissions keep task, media, node, and Clip identities aligned", async (t) => {
    const { service, db } = fixture(t);
    const stores = createStores(db);
    db.setSetting("ai.config", { imageModel: "simulated-image" });
    db.setSetting("plugin:minimax-h3:defaults:v1", { modelName: "simulated-h3" });
    db.applyCanvasProjectOperations("canvas", undefined, [{ type: "add_node", id: "asset-image", nodeType: "image", title: "角色参考", metadata: { storageKey: "image:reference", content: "media://image:reference", mimeType: "image/png" } }]);
    service.edit("episode", { operationId: "s", expectedRevision: 0, ops: [{ type: "upsert_scene", scene }] });
    service.publish("episode", { operationId: "ps", expectedRevision: 1, stage: "script" });
    service.edit("episode", { operationId: "shot-auto", expectedRevision: 2, ops: [
        { type: "upsert_shot", shot: { ...shot("shot-a"), assetNodeIds: ["asset-image"] } },
        { type: "set_settings", patch: { mode: "auto", imageQuota: 0, h3Quota: 0 } },
    ] });
    service.publish("episode", { operationId: "publish-auto", expectedRevision: 3, stage: "shots" });
    db.setSetting("ai.config", { imageModel: "changed-image" });
    db.setSetting("plugin:minimax-h3:defaults:v1", { modelName: "changed-h3" });
    const submitted: CanvasGenerationCommand[] = [];
    const fake = { start: async (command: CanvasGenerationCommand) => {
        submitted.push(command);
        const taskId = command.idempotencyKey!;
        const h3 = command.operation === "h3-run";
        stores.tasks.create(taskId, h3 ? "canvas-h3-run" : "canvas-image", { ...command }, {});
        if (h3) {
            const project = stores.projects.get(command.projectId!)!;
            stores.projects.applyOperations(command.projectId!, Number(project.revision || 0), [{ type: "update_h3_segment", nodeId: command.nodeId, segmentId: command.segmentId, patch: { resultStorageKey: "video:new", result: "media://video:new", status: "success" } }], { runtimeWrite: true });
            stores.tasks.update(taskId, { status: "succeeded", result: { media: [{ storageKey: "video:new" }] } });
        } else {
            const project = stores.projects.get(command.projectId!)!;
            stores.projects.applyOperations(command.projectId!, Number(project.revision || 0), [{ type: "update_node", id: command.nodeId, metadata: { storageKey: "image:new", status: "success" } }], { runtimeWrite: true });
            stores.tasks.update(taskId, { status: "succeeded", result: { media: [{ storageKey: "image:new" }] } });
        }
        return { taskId };
    } } as unknown as CanvasGenerationService;
    const runner = new EpisodeProductionRunner(service, stores, fake);
    await runner.run("episode", 2);
    assert.equal(service.run("episode", 2)?.status, "awaiting_review");
    service.edit("episode", { operationId: "visual-review", expectedRevision: service.get("episode").revision, ops: [{ type: "review_keyframe", shotId: "shot-a", verdict: "auto-accepted", evidence: "模拟视觉检查：主体、道具和起始状态与镜头表一致" }] });
    await runner.run("episode", 2);
    const run = service.run("episode", 2)!;
    assert.equal(run.status, "succeeded");
    assert.deepEqual(submitted.map((item) => item.mode), ["image", "video"]);
    assert.equal(submitted[0].references?.[0].storageKey, "image:reference");
    assert.ok(submitted[0].sourceNodeId);
    assert.equal(submitted[0].model, "simulated-image");
    assert.equal(submitted[1].params?.modelName, "simulated-h3");
    assert.equal(run.submitted.length, 2);
    assert.ok(run.submitted.every((item) => !!stores.tasks.get(item.taskId)));
    const published = service.get("episode").published!;
    assert.equal(published.keyframes["shot-a"].storageKey, "image:new");
    const group = published.clipGroups[0];
    const project = stores.projects.get("canvas")!;
    const image = (project.nodes as Array<Record<string, any>>).find((node) => node.id === published.keyframes["shot-a"].nodeId)!;
    const clip = (project.nodes as Array<Record<string, any>>).find((node) => node.id === group.nodeId)!.metadata.segments.find((item: { id: string }) => item.id === group.segmentId);
    assert.equal(image.metadata.storageKey, "image:new");
    assert.equal(clip.resultStorageKey, "video:new");
});

test("automatic run ignores legacy image quotas and preserves every completed result", async (t) => {
    const { service, db } = fixture(t);
    const stores = createStores(db);
    service.edit("episode", { operationId: "s", expectedRevision: 0, ops: [{ type: "upsert_scene", scene }] });
    service.publish("episode", { operationId: "ps", expectedRevision: 1, stage: "script" });
    service.edit("episode", { operationId: "shots-auto", expectedRevision: 2, ops: [
        { type: "upsert_shot", shot: shot("shot-a") }, { type: "upsert_shot", shot: shot("shot-b") },
        { type: "set_settings", patch: { mode: "auto", imageQuota: 1, h3Quota: 2, imageModel: "simulated-image", h3Model: "simulated-h3" } },
    ] });
    service.publish("episode", { operationId: "pub", expectedRevision: 3, stage: "shots" });
    let count = 0;
    const fake = { start: async (command: CanvasGenerationCommand) => {
        count += 1;
        const taskId = command.idempotencyKey!;
        stores.tasks.create(taskId, "canvas-image", { ...command }, {});
        const project = stores.projects.get("canvas")!;
        stores.projects.applyOperations("canvas", Number(project.revision || 0), [{ type: "update_node", id: command.nodeId, metadata: { storageKey: "image:first" } }], { runtimeWrite: true });
        stores.tasks.update(taskId, { status: "succeeded", result: { media: [{ storageKey: "image:first" }] } });
        return { taskId };
    } } as unknown as CanvasGenerationService;
    await new EpisodeProductionRunner(service, stores, fake).run("episode", 2);
    assert.equal(count, 2);
    assert.equal(service.run("episode", 2)?.status, "awaiting_review");
    assert.equal(service.get("episode").published?.keyframes["shot-a"].storageKey, "image:first");
    assert.equal(service.get("episode").published?.keyframes["shot-b"].storageKey, "image:first");
});

test("a later H3 failure pauses remaining work and leaves the completed Clip result", async (t) => {
    const { service, db } = fixture(t);
    const stores = createStores(db);
    service.edit("episode", { operationId: "s", expectedRevision: 0, ops: [{ type: "upsert_scene", scene }] });
    service.publish("episode", { operationId: "ps", expectedRevision: 1, stage: "script" });
    service.edit("episode", { operationId: "shots-auto", expectedRevision: 2, ops: [
        { type: "upsert_shot", shot: { ...shot("shot-a"), keyframePolicy: "none" } },
        { type: "upsert_shot", shot: { ...shot("shot-b"), keyframePolicy: "none" } },
        { type: "set_settings", patch: { mode: "auto", imageQuota: 0, h3Quota: 2, h3Model: "simulated-h3" } },
    ] });
    service.publish("episode", { operationId: "pub", expectedRevision: 3, stage: "shots" });
    let count = 0;
    const fake = { start: async (command: CanvasGenerationCommand) => {
        const taskId = command.idempotencyKey!;
        count += 1;
        stores.tasks.create(taskId, "canvas-h3-run", { ...command }, {});
        if (count === 1) {
            const project = stores.projects.get("canvas")!;
            stores.projects.applyOperations("canvas", Number(project.revision || 0), [{ type: "update_h3_segment", nodeId: command.nodeId, segmentId: command.segmentId, patch: { resultStorageKey: "video:first", result: "media://video:first", status: "success" } }], { runtimeWrite: true });
            stores.tasks.update(taskId, { status: "succeeded", result: { media: [{ storageKey: "video:first" }] } });
        } else stores.tasks.update(taskId, { status: "failed", error: "simulated provider failure" });
        return { taskId };
    } } as unknown as CanvasGenerationService;
    await new EpisodeProductionRunner(service, stores, fake).run("episode", 2);
    const run = service.run("episode", 2)!;
    assert.equal(run.status, "paused");
    assert.match(run.error || "", /simulated provider failure/);
    assert.equal(run.submitted.length, 2);
    const group = service.get("episode").published!.clipGroups[0];
    const project = stores.projects.get("canvas")!;
    const segment = (project.nodes as Array<Record<string, any>>).find((node) => node.id === group.nodeId)!.metadata.segments.find((item: { id: string }) => item.id === group.segmentId);
    assert.equal(segment.resultStorageKey, "video:first");
});

test("missing asset reference pauses auto run before any paid submission", async (t) => {
    const { service, db } = fixture(t);
    service.edit("episode", { operationId: "s", expectedRevision: 0, ops: [{ type: "upsert_scene", scene }] });
    service.publish("episode", { operationId: "ps", expectedRevision: 1, stage: "script" });
    service.edit("episode", { operationId: "shots", expectedRevision: 2, ops: [
        { type: "upsert_shot", shot: { ...shot("shot-a"), assetNodeIds: ["missing"] } },
        { type: "set_settings", patch: { mode: "auto", imageQuota: 1, h3Quota: 1, imageModel: "simulated-image", h3Model: "simulated-h3" } },
    ] });
    assert.deepEqual(service.previewImpact("episode", "shots").missingAssetNodeIds, ["missing"]);
    service.publish("episode", { operationId: "pub", expectedRevision: 3, stage: "shots" });
    let count = 0;
    const fake = { start: () => { count += 1; throw new Error("must not submit"); } } as unknown as CanvasGenerationService;
    await new EpisodeProductionRunner(service, createStores(db), fake).run("episode", 2);
    assert.equal(count, 0);
    assert.equal(service.run("episode", 2)?.status, "paused");
});

test("a changed published scene carries its shot dependency into the next shot publication preview", (t) => {
    const { service } = fixture(t);
    service.edit("episode", { operationId: "scene", expectedRevision: 0, ops: [{ type: "upsert_scene", scene }] });
    service.publish("episode", { operationId: "script-v1", expectedRevision: 1, stage: "script" });
    service.edit("episode", { operationId: "shot", expectedRevision: 2, ops: [{ type: "upsert_shot", shot: shot("shot-a") }] });
    service.publish("episode", { operationId: "shots-v2", expectedRevision: 3, stage: "shots" });
    service.edit("episode", { operationId: "scene-change", expectedRevision: 4, ops: [{ type: "upsert_scene", scene: { ...scene, blocks: [{ ...scene.blocks[0], text: "她发现信封里藏着钥匙。" }] } }] });
    service.publish("episode", { operationId: "script-v3", expectedRevision: 5, stage: "script" });
    const preview = service.previewImpact("episode", "shots");
    assert.deepEqual(preview.affectedShotIds, ["shot-a"]);
    assert.deepEqual(preview.imageShotIds, ["shot-a"]);
    assert.deepEqual(preview.clipGroupIds, ["clip:shot-a"]);
    assert.deepEqual(service.publish("episode", { operationId: "shots-v4", expectedRevision: 6, stage: "shots" }).impact, preview);
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
