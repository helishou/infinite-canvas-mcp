import assert from "node:assert/strict";
// 双 runner：vitest 验收与项目 node:test runner 共用同一份用例。
type TestFn = (name: string, fn: () => void | Promise<void>) => void;
let test: TestFn;
if ((process.env as Record<string, string | undefined>).VITEST) {
    // @ts-ignore vitest 由 npx 临时提供
    test = (await import("vitest")).test as unknown as TestFn;
} else {
    test = (await import("node:test")).default as unknown as TestFn;
}
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BackendDatabase, type Asset } from "../db.js";
import { adoptSharedAssetImage, findPipelineAssetEntityNode, generatedMediaStorageKey, syncGeneratedProductionAssetImage } from "./pipeline-asset-image.js";
import { ensureProductionCanvas } from "./production-canvas.js";

test("generatedMediaStorageKey 取结果里第一张真实媒体，并兼容顶层 storageKey", () => {
    assert.equal(generatedMediaStorageKey({ result: { media: [{ storageKey: "image:a" }, { storageKey: "image:b" }] } }), "image:a");
    assert.equal(generatedMediaStorageKey({ result: { media: [{ url: "/media/x" }, { storageKey: " image:b " }] } }), "image:b");
    assert.equal(generatedMediaStorageKey({ result: { storageKey: "image:top" } }), "image:top");
    assert.equal(generatedMediaStorageKey({ result: { media: [] } }), "");
    assert.equal(generatedMediaStorageKey(null), "");
});

test("findPipelineAssetEntityNode 优先按实体绑定/名称定位，不猜多个候选", () => {
    const nodes = [
        { id: "production-entity-ep-1-character-A", type: "character", title: "甲", metadata: { productionEntity: { entityId: "entity-A" }, characterName: "甲" } },
        { id: "production-entity-ep-1-character-B", type: "character", title: "乙", metadata: { productionEntity: { entityId: "entity-B" }, characterName: "乙" } },
        { id: "production-entity-ep-1-scene-S", type: "scene", title: "雪夜", metadata: { sceneName: "雪夜" } },
        { id: "production-entity-ep-1-prop-P", type: "prop", title: "玉佩", metadata: { propName: "玉佩" } },
    ];
    assert.equal(findPipelineAssetEntityNode(nodes, { kind: "character", name: "乙", entityId: "entity-B" })?.id,
        "production-entity-ep-1-character-B");
    assert.equal(findPipelineAssetEntityNode(nodes, { kind: "scene", name: "雪夜" })?.id,
        "production-entity-ep-1-scene-S");
    assert.equal(findPipelineAssetEntityNode(nodes, { kind: "prop", name: "玉佩" })?.id,
        "production-entity-ep-1-prop-P");
    // 两个同类候选、无绑定也无名称命中时不猜。
    assert.equal(findPipelineAssetEntityNode(nodes, { kind: "character", name: "" }), null);
    assert.equal(findPipelineAssetEntityNode(nodes, { kind: "character", name: "不存在的角色", entityId: "missing" }), null);
});

test("findPipelineAssetEntityNode 在没有 production-entity 前缀时按唯一同类型节点兜底", () => {
    const nodes = [{ id: "legacy-node", type: "scene", title: "旧场景", metadata: {} }];
    assert.equal(findPipelineAssetEntityNode(nodes, { kind: "scene", name: "" })?.id, "legacy-node");
});

function registerAdoptImage(db: BackendDatabase, dir: string, storageKey: string, bytes: Buffer) {
    const file = path.join(dir, `${storageKey.replace(/[^a-z0-9]/gi, "_")}.png`);
    fs.writeFileSync(file, bytes);
    db.upsertMediaFile({ storageKey, filePath: file, mimeType: "image/png", bytes: bytes.length, width: 8, height: 8,
        durationMs: null, createdAt: new Date().toISOString(), sha256: crypto.createHash("sha256").update(bytes).digest("hex") });
}

function adoptFixture() {
    const db = new BackendDatabase(":memory:");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shared-adopt-"));
    const newBytes = Buffer.from("new-adopted-image");
    registerAdoptImage(db, dir, "image:old", Buffer.from("old-shared-image"));
    registerAdoptImage(db, dir, "image:new", newBytes);
    db.upsertCanvasFolder({ id: "drama", name: "剧目", isDrama: true, createdAt: new Date().toISOString() });
    const shared = ensureProductionCanvas(db, "shared-assets", "drama");
    db.applyCanvasProjectOperations(shared.project.id, undefined, [{ type: "add_node", id: "shared-character", nodeType: "character",
        title: "共享角色", position: { x: 20, y: 30 }, width: 240, height: 320,
        metadata: { productionAssetId: "C1", characterName: "共享角色", characterDescription: "共享设定", characterImages: [{ storageKey: "image:old", url: "/media/image%3Aold" }], characterPrimaryIndex: 0 } }], { runtimeWrite: true });
    const source = { dramaId: "drama", assetId: "shared-asset", sourceProjectId: shared.project.id, sourceNodeId: "shared-character" };
    const asset: Asset = { id: "shared-asset", kind: "character", dramaId: "drama", title: "共享角色", coverUrl: "", tags: [], folderId: null,
        note: null, source: "production-shared", metadata: { sharedAssetSource: source }, data: {}, createdAt: "now", updatedAt: "now" };
    db.upsertAssetRecord(asset);
    const episodeId = "episode-1", canvasId = "episode-canvas";
    db.createCanvasProject({ id: canvasId, nodes: [], connections: [] });
    db.upsertDramaEpisode({ id: episodeId, dramaId: "drama", episodeNumber: 1, title: "第1集", synopsis: "", fullPlot: "",
        canvasId, createdAt: "now", updatedAt: "now" });
    db.applyCanvasProjectOperations(canvasId, undefined, [{ type: "add_node", id: "episode-ref", nodeType: "character", title: "共享角色",
        position: { x: 10, y: 10 }, width: 240, height: 320,
        metadata: { productionEntity: { ownerKind: "episode", ownerId: episodeId, kind: "character", entityId: "C1" },
            characterName: "共享角色", sharedAssetReference: { ...source, writeThrough: true } } }], { runtimeWrite: true });
    const director = {
        schemaVersion: 1, engine: "h3", sourceHash: "seed", artifacts: [], modules: {}, boundaries: [], unresolved: [],
        executionAuthorized: false, shotInputs: {}, workflow: {},
        source: { version: 1, asset_plan: [{ id: "asset", kind: "character", entity_id: "C1", version: "v1", status: "planned", sharedSource: source }],
            character_registry: [{ id: "C1", name: "共享角色", appearance: "共享设定", description: "共享设定" }],
            subject_registry: [{ id: "SUB", entityRef: { ownerKind: "episode", ownerId: episodeId, kind: "character", id: "C1" },
                pictureBindings: [{ id: "pb", assetId: "asset", sourceNode: { projectId: canvasId, nodeId: "episode-ref" },
                    provides: ["identity"], defaultFor: ["identity"], selection: { mode: "node_selection" } }] }],
            asset_cards: [], shots: [], segments: [], utterances: [] },
        assets: { asset: { storageKey: "image:old", status: "generated", version: "v1" } },
    };
    db.db.prepare("INSERT INTO episode_productions (episode_id,revision,draft_json,published_json,published_version,updated_at) VALUES (?,?,?,NULL,0,?)")
        .run(episodeId, 1, JSON.stringify({ director, keyframes: [], keyframeReviews: [], settings: {} }), "now");
    return { db, dir, shared, episodeId, newBytes };
}

test("adopt-shared-image 写 canonical 节点并同步消费分集 assets，重复采用幂等", () => {
    const { db, dir, shared, episodeId, newBytes } = adoptFixture();
    try {
        const beforeRevision = Number(db.getCanvasProjectRevision(shared.project.id));
        const result = adoptSharedAssetImage(db, { projectId: shared.project.id, nodeId: "shared-character", storageKey: "image:new" });
        assert.equal(result.ok, true);
        assert.equal(result.sha256, crypto.createHash("sha256").update(newBytes).digest("hex"));
        assert.ok(result.canvasRevision > beforeRevision);
        const canonical = (db.getCanvasProject(shared.project.id)!.nodes as any[]).find(n => n.id === "shared-character");
        assert.equal(canonical.metadata.characterImages[canonical.metadata.characterPrimaryIndex].storageKey, "image:new");
        assert.equal(canonical.metadata.storageKey, "image:new");
        // writeThrough 引用 live projection 指向新图，本集不落本地图片副本。
        const projected = (db.getCanvasProject("episode-canvas")!.nodes as any[]).find(n => n.id === "episode-ref");
        assert.equal(projected.metadata.characterImages[projected.metadata.characterPrimaryIndex].storageKey, "image:new");
        const rawNode = JSON.parse((db.db.prepare("SELECT node_json FROM canvas_nodes WHERE project_id=? AND node_id=?").get("episode-canvas", "episode-ref") as any).node_json);
        assert.equal(rawNode.metadata.characterImages, undefined, "shared image stays a live projection, not a local copy");
        const draft = JSON.parse((db.db.prepare("SELECT draft_json FROM episode_productions WHERE episode_id=?").get(episodeId) as any).draft_json);
        assert.equal(draft.director.assets.asset.storageKey, "image:new");
        assert.equal(draft.director.assets.asset.sha256, result.sha256);
        assert.equal(draft.director.assets.asset.status, "generated");
        assert.equal(draft.director.assets.asset.selectedResult.storageKey, "image:new");
        const revision = Number(db.getCanvasProjectRevision(shared.project.id));
        adoptSharedAssetImage(db, { projectId: shared.project.id, nodeId: "shared-character", storageKey: "image:new" });
        assert.equal(Number(db.getCanvasProjectRevision(shared.project.id)), revision, "same operationId is idempotent");
    } finally {
        db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("adopt-shared-image 拒绝非共享画布、缺失媒体与缺失节点", () => {
    const { db, shared } = adoptFixture();
    try {
        assert.throws(() => adoptSharedAssetImage(db, { projectId: "episode-canvas", nodeId: "episode-ref", storageKey: "image:new" }), /NOT_SHARED_CANVAS/);
        assert.throws(() => adoptSharedAssetImage(db, { projectId: shared.project.id, nodeId: "shared-character", storageKey: "image:missing" }), /MEDIA_MISSING/);
        assert.throws(() => adoptSharedAssetImage(db, { projectId: shared.project.id, nodeId: "missing-node", storageKey: "image:new" }), /NODE_MISSING/);
    } finally { db.close(); }
});

function episodeEntityFixture() {
    const db = new BackendDatabase(":memory:");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "entity-writeback-"));
    registerAdoptImage(db, dir, "image:scene-new", Buffer.from("scene-image-bytes"));
    db.upsertCanvasFolder({ id: "drama", name: "剧目", isDrama: true, createdAt: "now" });
    const episodeId = "episode-1", canvasId = "episode-canvas";
    db.createCanvasProject({ id: canvasId, nodes: [], connections: [] });
    db.upsertDramaEpisode({ id: episodeId, dramaId: "drama", episodeNumber: 1, title: "第1集", synopsis: "", fullPlot: "",
        canvasId, createdAt: "now", updatedAt: "now" });
    db.applyCanvasProjectOperations(canvasId, undefined, [{ type: "add_node", id: "entity-scene", nodeType: "scene", title: "雪夜",
        position: { x: 10, y: 20 }, width: 300, height: 200,
        metadata: { sceneName: "雪夜", prompt: "雪夜全景", storageKey: "image:scene-new",
            productionEntity: { ownerKind: "episode", ownerId: episodeId, kind: "scene", entityId: "SC-1" } } }], { runtimeWrite: true });
    const director = {
        schemaVersion: 1, engine: "h3", sourceHash: "seed", artifacts: [], modules: {}, boundaries: [], unresolved: [],
        executionAuthorized: false, shotInputs: {}, workflow: {},
        source: { version: 1, asset_plan: [{ id: "asset-scene", kind: "scene", entity_id: "SC-1", version: "v1", status: "planned" }],
            asset_cards: [], shots: [], segments: [], utterances: [] },
        assets: { "asset-scene": { status: "planned", version: "v1" } },
    };
    db.db.prepare("INSERT INTO episode_productions (episode_id,revision,draft_json,published_json,published_version,updated_at) VALUES (?,?,?,NULL,0,?)")
        .run(episodeId, 1, JSON.stringify({ director, keyframes: [], keyframeReviews: [], settings: {} }), "now");
    return { db, dir, episodeId, canvasId };
}

test("生成结果写回分集实体节点时同步制作稿资产与 sceneImage，并标为 generated", () => {
    const { db, dir, episodeId, canvasId } = episodeEntityFixture();
    try {
        const result = syncGeneratedProductionAssetImage(db, {
            projectId: canvasId, nodeId: "entity-scene", storageKey: "image:scene-new", taskId: "task-scene",
        });
        assert.deepEqual(result, { ok: true, scope: "episode", assetId: "asset-scene", storageKey: "image:scene-new" });
        const draft = JSON.parse((db.db.prepare("SELECT draft_json FROM episode_productions WHERE episode_id=?").get(episodeId) as any).draft_json);
        assert.equal(draft.director.assets["asset-scene"].storageKey, "image:scene-new");
        assert.equal(draft.director.assets["asset-scene"].status, "generated");
        assert.equal(draft.director.assets["asset-scene"].selectedResult.taskId, "task-scene");
        const node = (db.getCanvasProject(canvasId)!.nodes as any[]).find(n => n.id === "entity-scene");
        assert.equal(node.metadata.sceneImage.storageKey, "image:scene-new");
        assert.equal(node.metadata.generationTaskId, "task-scene");
        // 相同 storageKey 重复调用幂等：不重复加 revision。
        const revision = Number((db.db.prepare("SELECT revision FROM episode_productions WHERE episode_id=?").get(episodeId) as any).revision);
        syncGeneratedProductionAssetImage(db, { projectId: canvasId, nodeId: "entity-scene", storageKey: "image:scene-new", taskId: "task-scene" });
        assert.equal(Number((db.db.prepare("SELECT revision FROM episode_productions WHERE episode_id=?").get(episodeId) as any).revision), revision);
    } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("共享画布生成结果走 canonical 节点采用并传播消费分集", () => {
    const { db, dir, shared, episodeId } = adoptFixture();
    try {
        const result = syncGeneratedProductionAssetImage(db, {
            projectId: shared.project.id, nodeId: "shared-character", storageKey: "image:new", taskId: "task-shared",
        });
        assert.deepEqual(result, { ok: true, scope: "shared", assetId: "C1", storageKey: "image:new" });
        const canonical = (db.getCanvasProject(shared.project.id)!.nodes as any[]).find(n => n.id === "shared-character");
        assert.equal(canonical.metadata.characterImages[canonical.metadata.characterPrimaryIndex].storageKey, "image:new");
        const draft = JSON.parse((db.db.prepare("SELECT draft_json FROM episode_productions WHERE episode_id=?").get(episodeId) as any).draft_json);
        assert.equal(draft.director.assets.asset.storageKey, "image:new");
        assert.equal(draft.director.assets.asset.status, "generated");
    } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("非生产实体节点与缺失媒体明确跳过，不猜资产不造假图", () => {
    const { db, dir, canvasId } = episodeEntityFixture();
    try {
        db.applyCanvasProjectOperations(canvasId, undefined, [{ type: "add_node", id: "plain-image", nodeType: "image", title: "普通图",
            position: { x: 0, y: 0 }, width: 100, height: 100, metadata: {} }], { runtimeWrite: true });
        assert.deepEqual(syncGeneratedProductionAssetImage(db, { projectId: canvasId, nodeId: "plain-image", storageKey: "image:scene-new" }),
            { ok: false, reason: "NOT_ENTITY_NODE" });
        assert.deepEqual(syncGeneratedProductionAssetImage(db, { projectId: canvasId, nodeId: "entity-scene", storageKey: "image:missing" }),
            { ok: false, reason: "MEDIA_MISSING" });
    } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
