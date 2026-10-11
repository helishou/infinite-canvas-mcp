import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerDramaProductionRoutes } from "../src/server/drama-production-routes.js";
import { EpisodeProductionRunner } from "../src/drama/production-runner.js";
import { createStores } from "../src/stores/index.js";
import { EpisodeProductionService } from "../src/drama/production.js";
import { BackendEventBus } from "../src/events.js";
import { directorHash } from "../src/drama/director.js";
import { directorProductionSchema } from "@basketikun/canvas-agent/drama/production-contract";
/** Isolated interactive fixture: no user database, no media generation. */
import { BackendDatabase } from "../src/db.js";
import { startServer } from "../src/server.js";
import { ensureProductionCanvas } from "../src/drama/production-canvas.js";
import { CanvasRealtimeHub } from "../src/canvas/realtime-hub.js";
const db = new BackendDatabase(":memory:");
db.upsertCanvasFolder({ id: "preview-drama", name: "共享资产验证", isDrama: true, createdAt: new Date().toISOString() });
const referenceImage = { storageKey: "manual-preview-image", url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aO7sAAAAASUVORK5CYII=", width: 100, height: 100, bytes: 68, mimeType: "image/png", name: "测试图片" };
const mediaDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "manual-production-preview-"));
const mediaFile = path.join(mediaDirectory, "reference.png");
fs.writeFileSync(mediaFile, Buffer.from(referenceImage.url.split(",")[1], "base64"));
db.upsertMediaFile({ storageKey: referenceImage.storageKey, filePath: mediaFile, mimeType: "image/png", bytes: fs.statSync(mediaFile).size, width: 1, height: 1, durationMs: null, createdAt: new Date().toISOString() });
for (const [index, id] of ["manual-preview-a", "manual-preview-b"].entries()) {
    db.createCanvasProject({ id, title: index ? "分集二" : "分集一", nodes: index ? [] : [{ id: "preview-text", type: "text", title: "共享文本测试", position: { x: 0, y: 0 }, width: 440, height: 260, metadata: { content: "共享资产初始内容", fontSize: 20, status: "success" } },
        { id: "preview-character", type: "character", title: "转换后的角色素材", position: { x: 560, y: 0 }, width: 340, height: 400, metadata: { productionAssetId: "CHARACTER_PURPOSE", characterName: "转换后的角色素材", characterImages: [referenceImage], characterPrimaryIndex: 0, content: referenceImage.url, status: "success" } },
        { id: "preview-scene", type: "scene", title: "转换后的场景素材", position: { x: 1040, y: 0 }, width: 340, height: 400, metadata: { productionAssetId: "SCENE_PURPOSE", sceneName: "转换后的场景素材", sceneImage: referenceImage, content: referenceImage.url, status: "success" } }], connections: [], viewport: { x: 100, y: 180, k: 1 } });
    db.upsertDramaEpisode({ id: `ep-${id}`, dramaId: "preview-drama", episodeNumber: index + 1, title: `分集${index + 1}`, synopsis: "", fullPlot: "", canvasId: id, createdAt: "now", updatedAt: "now" });
}
db.upsertDramaEpisode({ id: "ep-preview-unbound", dramaId: "preview-drama", episodeNumber: 3, title: "未绑定画布的分集", synopsis: "", fullPlot: "", canvasId: null, createdAt: "now", updatedAt: "now" });
const source = {
    prompt_assembly: { version: 2 }, fps_num: 24, fps_den: 1,
    character_registry: [{ id: "CHAR_PREVIEW", name: "验证角色", appearance: "银色机械人" }],
    scene_registry: [{ id: "SCENE_PREVIEW", name: "验证场景", description: "铁壁船舱" }],
    asset_plan: [{ id: "PROP_PREVIEW", kind: "prop", asset_name: "验证道具", description: "生锈扳手", canvas_scope: "episode" }], asset_cards: [],
    subject_registry: [
        { id: "SUBJECT_CHAR", kind: "character", entityRef: { ownerKind: "episode", ownerId: "ep-manual-preview-a", kind: "character", id: "CHAR_PREVIEW" }, pictureBindings: [] },
        { id: "SUBJECT_SCENE", kind: "scene", entityRef: { ownerKind: "episode", ownerId: "ep-manual-preview-a", kind: "scene", id: "SCENE_PREVIEW" }, pictureBindings: [] },
        { id: "SUBJECT_PROP", kind: "prop", entityRef: { ownerKind: "episode", ownerId: "ep-manual-preview-a", kind: "asset", id: "PROP_PREVIEW" }, pictureBindings: [] },
    ],
    script_scenes: [{ id: "SCRIPT_PREVIEW", scene_id: "SCENE_PREVIEW", scene_name: "验证场景", text: "机械人在船舱中拿起扳手。", beat_ids: [] }],
    shots: [{ id: "SHOT_PREVIEW", scene_id: "SCENE_PREVIEW", timeline_id: "main", story_order: 0, duration_frames: 96, visual: "机械人拿起扳手", camera: { framing: "MCU", attention_subject_ids: [], editorial_reason: "展示手工编辑" }, subject_usages: [{ subjectId: "SUBJECT_CHAR", presentation: "state_context", referencePurpose: [], pictureBindingIds: [], continuityFactIds: [], stateRequirements: [] }], keyframes: [], utterance_refs: [] }],
    segments: [{ id: "CLIP_PREVIEW", shot_ids: ["SHOT_PREVIEW"], mode: "T2VA", mode_lock: "T2VA", mode_selection_reason: "手工填写" }], utterances: [],
    ledger: { contract_version: 2, facts: [], timelines: [], initial: [], events: [], requirements: [], coverage: [] },
};
const director = directorProductionSchema.parse({ schemaVersion: 1, engine: { commit: "a".repeat(40), patchVersion: "test", runtimeId: "test", version: "test" }, source, sourceHash: directorHash(source), assets: {}, shotInputs: {}, modules: { story: { status: "partial", evidence: [], unresolved: ["缺少当前revision绑定的Backend story验证回执。"] }, assets: { status: "partial", evidence: [], unresolved: ["风格母图依赖未批准，所有下游参考仍为草案。"] }, continuity: { status: "partial", evidence: [], unresolved: ["等待Backend ledger v2重放与覆盖检查。"] } }, artifacts: [], boundaries: [], unresolved: [], workflow: {}, executionAuthorized: false });
const service = new EpisodeProductionService(db, new BackendEventBus(), process.env.TEMP || ".", false, () => {});
service.edit("ep-manual-preview-a", { operationId: "entity-preview-init", expectedRevision: 0, ops: [{ type: "set_director_production", director }] });
const shared = ensureProductionCanvas(db, "shared-assets", "preview-drama");
console.log(`MANUAL_PREVIEW_PID=${process.pid}`);
console.log(`SHARED_LIBRARY_PREVIEW_SHARED=${shared.project.id}`);
const config = { url: "http://127.0.0.1", token: "shared-library-test", port: 0, origins: ["http://127.0.0.1:3017"] };
const { app, events } = startServer(db, config);
registerDramaProductionRoutes(app, service, new EpisodeProductionRunner(service, createStores(db), {} as any), undefined, events);
const hub = new CanvasRealtimeHub(config, db, events);
app.get("/canvas/projects/:id/collaboration", (req, res) => {
    const project = db.getCanvasProject(req.params.id);
    res.json({ ok: true, projectId: req.params.id, revision: Number(project?.revision || 0), participants: hub.participants(req.params.id) });
});
const server = app.listen(Number(process.env.CANVAS_PREVIEW_PORT) || 0, "127.0.0.1", () => {
    const address = server.address();
    if (address && typeof address === "object") console.log(`SHARED_LIBRARY_PREVIEW_PORT=${address.port}`);
});
hub.attach(server);
process.on("SIGINT", () => { hub.close(); server.close(() => { db.close(); process.exit(0); }); });
