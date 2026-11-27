import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { BackendDatabase, type RuntimeTask } from "../db.js";
import { createStores } from "../stores/index.js";
import { BackendEventBus } from "../events.js";

/**
 * 方案二：画布与制作台对等维护 Clip，制作稿不再是独占权威源。
 * 覆盖两件事：
 * 1) 画布结构操作（add/delete/move_h3_segment）不再被 PRODUCTION_CLIP_MEMBERSHIP_OWNED 拦住；
 * 2) 画布段结构改动会同步回写制作稿 draft.source.segments（统一数据源）。
 */
function fixture(t: TestContext) {
    const db = new BackendDatabase(":memory:");
    t.after(() => db.close());
    const projection = { targetId: "seg-1", fieldHashes: {} };
    db.createCanvasProject({ id: "p", nodes: [{ id: "h3", type: "minimax-h3:video", metadata: {
        productionSceneId: "scene-1", productionOwnerKind: "episode", productionOwnerId: "ep-1",
        segments: [
            { id: "clip-1", prompt: "一", productionClipProjection: projection },
            { id: "clip-2", prompt: "二", productionClipProjection: { targetId: "seg-2", fieldHashes: {} } },
        ],
    } }], connections: [] });
    // 造一个绑定画布的制作稿，draft 里有两个段
    // drama_episodes 有外键指向 drama_projects(folder_id)，folder 又指向 canvas_folders
    db.upsertCanvasFolder({ id: "d", name: "Drama", isDrama: true, createdAt: new Date().toISOString() });
    // upsertCanvasFolder(isDrama:true) 已建 drama_projects 父行
    db.upsertDramaEpisode({ id: "ep-1", dramaId: "d", episodeNumber: 1, title: "E1", synopsis: "", canvasId: "p" });
    db.db.prepare("INSERT OR REPLACE INTO episode_productions (episode_id, draft_json, published_version, revision, updated_at) VALUES (?, ?, 0, 1, ?)").run(
        "ep-1",
        JSON.stringify({ director: { source: { version: 2, prompt_assembly: { version: 2 }, ledger: { contract_version: 2, facts: [], timelines: [], initial: [], events: [], requirements: [], coverage: [] }, segments: [
            { id: "seg-1", shot_ids: ["s1"], mode: "T2VA" },
            { id: "seg-2", shot_ids: ["s2"], mode: "T2VA" },
        ], fps_num: 24, fps_den: 1 } }, assets: {}, shotInputs: {}, clipGroups: [], artifacts: [] }),
        new Date().toISOString(),
    );
    return db;
}

test("画布可对制作绑定的 Clip 重排/删除/新增，不再被归属门禁拒绝", (t) => {
    const db = fixture(t);
    // 重排（move_h3_segment）——原门禁在 isProductionBoundNode 节点上拒绝
    assert.doesNotThrow(() => db.applyCanvasProjectOperations("p", undefined, [
        { type: "move_h3_segment", nodeId: "h3", segmentId: "clip-2", beforeSegmentId: "clip-1" },
    ], { operationId: "reorder" }));
    let segs = ((db.getCanvasProject("p")!.nodes as any[])[0].metadata.segments as any[]).map(s => s.id);
    assert.deepEqual(segs, ["clip-2", "clip-1"]);

    // 删除制作绑定段
    assert.doesNotThrow(() => db.applyCanvasProjectOperations("p", undefined, [
        { type: "delete_h3_segment", nodeId: "h3", segmentId: "clip-1" },
    ], { operationId: "delete" }));
    segs = ((db.getCanvasProject("p")!.nodes as any[])[0].metadata.segments as any[]).map(s => s.id);
    assert.deepEqual(segs, ["clip-2"]);

    // 新增段
    assert.doesNotThrow(() => db.applyCanvasProjectOperations("p", undefined, [
        { type: "add_h3_segment", nodeId: "h3", segment: { id: "clip-3", prompt: "三" } },
    ], { operationId: "add" }));
    segs = ((db.getCanvasProject("p")!.nodes as any[])[0].metadata.segments as any[]).map(s => s.id);
    assert.deepEqual(segs, ["clip-2", "clip-3"]);
});

test("画布重排制作绑定段后，制作稿 source.segments 顺序同步更新", (t) => {
    const db = fixture(t);
    db.applyCanvasProjectOperations("p", undefined, [
        { type: "move_h3_segment", nodeId: "h3", segmentId: "clip-2", beforeSegmentId: "clip-1" },
    ], { operationId: "reorder-sync" });
    const row = db.db.prepare("SELECT draft_json FROM episode_productions WHERE episode_id='ep-1'").get() as { draft_json: string };
    const segs = (JSON.parse(row.draft_json).director.source.segments as any[]).map(s => s.id);
    assert.deepEqual(segs, ["seg-2", "seg-1"], "制作稿顺序应跟随画布重排");
});

test("系统来源（制作稿→画布同步）的重排不回写制作稿，避免循环同步", (t) => {
    const db = fixture(t);
    const beforeRevision = (db.db.prepare("SELECT revision FROM episode_productions WHERE episode_id='ep-1'").get() as any).revision;
    db.applyCanvasProjectOperations("p", undefined, [
        { type: "move_h3_segment", nodeId: "h3", segmentId: "clip-2", beforeSegmentId: "clip-1" },
    ], { runtimeWrite: true, source: { clientId: "episode-production", kind: "system" } });
    const afterRevision = (db.db.prepare("SELECT revision FROM episode_productions WHERE episode_id='ep-1'").get() as any).revision;
    assert.equal(afterRevision, beforeRevision, "系统同步不应回写制作稿");
});

test("画布删除制作绑定段后，制作稿 draft 同步移除对应 source.segment（统一数据源）", (t) => {
    const db = fixture(t);
    db.applyCanvasProjectOperations("p", undefined, [
        { type: "delete_h3_segment", nodeId: "h3", segmentId: "clip-1" },
    ], { operationId: "delete-sync" });
    const row = db.db.prepare("SELECT draft_json FROM episode_productions WHERE episode_id='ep-1'").get() as { draft_json: string };
    const segs = (JSON.parse(row.draft_json).director.source.segments as any[]).map(s => s.id);
    assert.deepEqual(segs, ["seg-2"], "制作稿应移除被画布删除的段");
});
