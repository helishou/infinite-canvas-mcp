import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { BackendDatabase } from "./db.js";
import { createStores } from "./stores/index.js";
import type { GenerationSource } from "./engine-contract/contracts.js";
import { bindPipelineAssetImage, adoptSharedAssetImage } from "./drama/pipeline-asset-image.js";
import { ensureProductionCanvas } from "./drama/production-canvas.js";

function logInput(source?: GenerationSource) {
    return {
        projectId: "p", nodeId: "h3", segmentId: "clip", status: "success" as const,
        platform: "selected-video-model", ...(source ? { source } : {}),
        workflow: "MiniMax H3", model: "h3", taskMode: "t2v", prompt: "测试生成",
        references: [], inputCounts: {}, startedAt: new Date().toISOString(), durationMs: 1,
        outputs: [{ storageKey: "video:source-test", mimeType: "video/mp4" }], params: {},
    };
}

test("generation_logs 写入并读回四种来源真值（缺省 pipeline）", (t) => {
    const db = new BackendDatabase(":memory:");
    t.after(() => db.close());
    const expected: GenerationSource[] = ["pipeline", "upload", "canvas", "restore"];
    const ids: string[] = [];
    for (const source of expected) ids.push(db.createGenerationLog(logInput(source)).id);
    ids.push(db.createGenerationLog(logInput()).id); // 不传 → 缺省 pipeline

    const readBack = ids.map((id) => db.getGenerationLog(id)!.source);
    assert.deepEqual(readBack, [...expected, "pipeline"]);
    const listed = db.listGenerationLogs({ projectId: "p" }).map((log) => log.source).sort();
    assert.deepEqual(listed, [...expected, "pipeline"].sort());
});

test("updateGenerationLog 更新来源，且不影响其它日志", (t) => {
    const db = new BackendDatabase(":memory:");
    t.after(() => db.close());
    const a = db.createGenerationLog(logInput("pipeline"));
    const b = db.createGenerationLog(logInput("pipeline"));
    db.updateGenerationLog(a.id, { source: "restore" });
    assert.equal(db.getGenerationLog(a.id)!.source, "restore");
    assert.equal(db.getGenerationLog(b.id)!.source, "pipeline");
});

test("老库补列：无 source 列的 generation_logs 重开后幂等补齐，历史日志按 pipeline 读", (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gen-source-migrate-"));
    const file = path.join(dir, "runtime.sqlite");
    const open: BackendDatabase[] = [];
    t.after(() => { for (const db of open.reverse()) { try { db.close(); } catch { /* already closed */ } } fs.rmSync(dir, { recursive: true, force: true }); });

    const first = new BackendDatabase(file);
    open.push(first);
    const legacyId = first.createGenerationLog(logInput()).id;
    // 模拟升级前的老库：没有 source 列，历史日志仍然存在。
    first.db.exec("ALTER TABLE generation_logs DROP COLUMN source");
    first.db.prepare(`INSERT INTO generation_logs
        (id, project_id, node_id, segment_id, status, platform, workflow, model, task_mode, prompt,
         references_json, input_counts_json, runtime_task_id, prompt_id, started_at, finished_at,
         duration_ms, outputs_json, error, params_json, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run("legacy-no-source", "p", null, null, "success", "comfyui", null, null, null, null,
            "[]", "{}", null, null, new Date().toISOString(), null, 1, "[]", null, "{}",
            new Date().toISOString(), new Date().toISOString());
    first.close();

    const reopened = new BackendDatabase(file);
    open.push(reopened);
    const columns = reopened.db.prepare("PRAGMA table_info(generation_logs)").all() as Array<{ name: string }>;
    assert.ok(columns.some((column) => column.name === "source"), "重开后应补出 source 列");
    assert.equal(reopened.getGenerationLog("legacy-no-source")!.source, "pipeline", "历史日志不编造其它来源");
    assert.equal(reopened.getGenerationLog(legacyId)!.source, "pipeline");
    const explicit = reopened.createGenerationLog(logInput("canvas"));
    assert.equal(reopened.getGenerationLog(explicit.id)!.source, "canvas");
    // 二次打开不重复 ALTER。
    reopened.close();
    const again = new BackendDatabase(file);
    open.push(again);
    assert.equal(again.getGenerationLog(explicit.id)!.source, "canvas");
});

test("restore_h3_output 在当前结果条目写入 source=restore 与 generationLogId", (t) => {
    const db = new BackendDatabase(":memory:");
    t.after(() => db.close());
    db.createCanvasProject({ id: "p", nodes: [{ id: "h3", type: "minimax-h3", metadata: { segments: [{ id: "clip", status: "idle" }] } }], connections: [] });
    const stores = createStores(db);
    const media = stores.media.store(Buffer.from("historical-video"), { name: "old.mp4", mimeType: "video/mp4", category: "output" });
    const log = stores.logs.create({
        projectId: "p", nodeId: "h3", segmentId: "clip", status: "success", platform: "selected-video-model", source: "pipeline",
        workflow: "MiniMax H3", model: "h3", taskMode: "t2v", prompt: "historical prompt", references: [],
        inputCounts: {}, startedAt: new Date().toISOString(), durationMs: 1,
        outputs: [{ url: `/media/${encodeURIComponent(media.storageKey)}`, storageKey: media.storageKey, mimeType: "video/mp4" }], params: {},
    });
    const result = db.applyCanvasProjectOperations("p", undefined, [{
        type: "restore_h3_output", nodeId: "h3", segmentId: "clip", generationLogId: log.id,
        storageKey: media.storageKey, settings: {},
    }], { source: { clientId: "test", kind: "browser", label: "设为当前" } });
    const segment = (((result.project.nodes as Array<Record<string, unknown>>)[0]).metadata as { segments: Array<Record<string, unknown>> }).segments[0];
    const chosen = (segment.results as Array<Record<string, unknown>>).find((r) => r.storageKey === media.storageKey)!;
    assert.equal(segment.resultStorageKey, media.storageKey);
    assert.equal(chosen.source, "restore", "当前条目标记切版本来源");
    assert.equal(chosen.generationLogId, log.id, "保留生成日志凭证供版本行回查");
});

function imageSourceFixture() {
    const db = new BackendDatabase(":memory:");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "image-source-"));
    const bytes = Buffer.from("source-image-bytes");
    const file = path.join(dir, "image.png");
    fs.writeFileSync(file, bytes);
    const now = new Date().toISOString();
    db.upsertMediaFile({ storageKey: "image:src", filePath: file, mimeType: "image/png", bytes: bytes.length,
        width: 8, height: 8, durationMs: null, createdAt: now,
        sha256: "0".repeat(64) });
    db.upsertCanvasFolder({ id: "drama", name: "剧目", isDrama: true, createdAt: now });
    const shared = ensureProductionCanvas(db, "shared-assets", "drama");
    db.applyCanvasProjectOperations(shared.project.id, undefined, [{ type: "add_node", id: "shared-char", nodeType: "character",
        title: "共享角色", position: { x: 0, y: 0 }, width: 200, height: 200, metadata: {} }], { runtimeWrite: true });
    db.createCanvasProject({ id: "ep-canvas", nodes: [], connections: [] });
    db.applyCanvasProjectOperations("ep-canvas", undefined, [{ type: "add_node", id: "ep-char", nodeType: "character",
        title: "分集角色", position: { x: 0, y: 0 }, width: 200, height: 200, metadata: {} }], { runtimeWrite: true });
    db.upsertDramaEpisode({ id: "ep1", dramaId: "drama", episodeNumber: 1, title: "第1集", synopsis: "", fullPlot: "",
        canvasId: "ep-canvas", createdAt: now, updatedAt: now });
    const director = {
        schemaVersion: 1, engine: "h3", sourceHash: "seed", artifacts: [], modules: {}, boundaries: [], unresolved: [],
        executionAuthorized: false, shotInputs: {}, workflow: {},
        source: { version: 1, asset_plan: [], character_registry: [], subject_registry: [], asset_cards: [], shots: [], segments: [], utterances: [] },
        assets: {},
    };
    db.db.prepare("INSERT INTO episode_productions (episode_id,revision,draft_json,published_json,published_version,updated_at) VALUES (?,?,?,NULL,0,?)")
        .run("ep1", 1, JSON.stringify({ director, keyframes: [], keyframeReviews: [], settings: {} }), now);
    return { db, dir, sharedProjectId: shared.project.id };
}

test("上传形象图/素材库采用在真实写路径落来源：bind-image=upload、adopt-shared-image=canvas", (t) => {
    const { db, dir, sharedProjectId } = imageSourceFixture();
    t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

    // 分集「上传形象图」→ bind-image 默认 upload。
    bindPipelineAssetImage(db, { episodeId: "ep1", assetId: "asset", nodeId: "ep-char", storageKey: "image:src" });
    const epNode = (db.getCanvasProject("ep-canvas")!.nodes as any[]).find((n) => n.id === "ep-char");
    assert.equal(epNode.metadata.source, "upload");
    assert.equal(epNode.metadata.characterImages[0].source, "upload");
    let draft = JSON.parse((db.db.prepare("SELECT draft_json FROM episode_productions WHERE episode_id=?").get("ep1") as any).draft_json);
    assert.equal(draft.director.assets.asset.selectedResult.source, "upload");

    // 共享画布「素材库采用并锁定」→ adopt-shared-image 落 canvas。
    adoptSharedAssetImage(db, { projectId: sharedProjectId, nodeId: "shared-char", storageKey: "image:src" });
    const sharedNode = (db.getCanvasProject(sharedProjectId)!.nodes as any[]).find((n) => n.id === "shared-char");
    assert.equal(sharedNode.metadata.source, "canvas");
    assert.equal(sharedNode.metadata.characterImages[0].source, "canvas");

    // 画布收尾对账显式传 canvas，也写 canvas（不是 upload）。用独立 assetId 避开 bind 的 (assetId,storageKey) 幂等键。
    bindPipelineAssetImage(db, { episodeId: "ep1", assetId: "asset-canvas", nodeId: "ep-char", storageKey: "image:src", source: "canvas" });
    const epNode2 = (db.getCanvasProject("ep-canvas")!.nodes as any[]).find((n) => n.id === "ep-char");
    assert.equal(epNode2.metadata.source, "canvas");
    draft = JSON.parse((db.db.prepare("SELECT draft_json FROM episode_productions WHERE episode_id=?").get("ep1") as any).draft_json);
    assert.equal(draft.director.assets["asset-canvas"].selectedResult.source, "canvas");
});
