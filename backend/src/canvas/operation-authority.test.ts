import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import * as Y from "yjs";
import { BackendDatabase, type RuntimeTask } from "../db.js";

function fixture(t: TestContext) {
    const db = new BackendDatabase(":memory:");
    t.after(() => db.close());
    db.createCanvasProject({ id: "p", nodes: [{ id: "h3", type: "minimax-h3:video", metadata: {
        status: "success", runtimeTaskId: "task", content: "video.mp4", segments: [
            { id: "s1", prompt: "一", status: "success", result: "one.mp4", runtimeTaskId: "child1" },
            { id: "s2", prompt: "二", status: "success", result: "two.mp4", runtimeTaskId: "child2" },
        ],
    } }], connections: [] });
    return db;
}

test("客户端不能伪装 task/system 来源篡改运行字段，整批失败无部分写入", (t) => {
    const db = fixture(t);
    const before = db.getCanvasProject("p");
    const changes = [
        { type: "update_node", id: "h3", metadata: { status: "loading" } },
        { type: "update_node", id: "h3", nodeId: "missing", metadata: { status: "loading" } },
        { type: "update_node", id: "h3", metadataDelete: ["segments"] },
        { type: "update_node", id: "h3", metadataDelete: ["content"] },
        { type: "update_h3_segment", nodeId: "h3", segmentId: "s1", patch: { runtimeTaskId: "fake" } },
        { type: "update_h3_segment", nodeId: "h3", segmentId: "s1", patchDelete: ["result"] },
        { type: "update_node", id: "h3", patch: { metadata: { segments: [] } } },
        { type: "update_node", id: "h3", patch: { id: "different" } },
        { type: "update_node", id: "h3", patch: { type: "text" } },
        { type: "update_h3_segment", nodeId: "h3", segmentId: "s1", patchDelete: ["id"] },
    ];
    for (const [index, change] of changes.entries()) {
        assert.throws(() => db.applyCanvasProjectOperations("p", undefined, [{ type: "update_project", patch: { title: "不应部分保存" } }, change], { operationId: `fake-${index}`, source: { kind: index % 2 ? "task" : "system" } }), /后台任务|ID 不可|metadata 必须|删除 Clip 必须/);
        assert.deepEqual(db.getCanvasProject("p"), before);
        assert.equal(db.readCanvasChanges("p", 0).commits.length, 0);
    }
});

test("重排和完整替换按 Clip ID 继承省略的任务字段，不丢结果、不按数组下标串片段", (t) => {
    const db = fixture(t);
    const op = { type: "replace_h3_segments", nodeId: "h3", segments: [{ id: "s2", prompt: "二修改" }, { id: "s1", prompt: "一修改" }] };
    const original = structuredClone(op);
    const result = db.applyCanvasProjectOperations("p", undefined, [op], { operationId: "reorder" });
    const segments = ((result.project.nodes as Array<{ metadata: { segments: Record<string, unknown>[] } }>)[0]).metadata.segments;
    assert.equal(segments[0].result, "two.mp4");
    assert.equal(segments[1].runtimeTaskId, "child1");
    assert.deepEqual(op, original);
    db.applyCanvasProjectOperations("p", undefined, [{ type: "update_h3_segment", nodeId: "h3", segmentId: "s1", patch: { prompt: "后来修改" } }]);
    assert.deepEqual(db.applyCanvasProjectOperations("p", undefined, [op], { operationId: "reorder" }).project, result.project);
    assert.throws(() => db.applyCanvasProjectOperations("p", undefined, [{ type: "replace_h3_segments", nodeId: "h3", segments: [{ id: "s1", status: "idle" }] }]), /后台任务/);
    const replaced = db.applyCanvasProjectOperations("p", undefined, [{ type: "update_node", id: "h3", metadata: { segments: [{ id: "s2", prompt: "2" }, { id: "s1", prompt: "1" }] } }]);
    assert.equal((replaced.project.nodes as typeof result.project.nodes & Array<{ metadata: { segments: Record<string, unknown>[] } }>)[0].metadata.segments[0].result, "two.mp4");
});

test("旧页面移除 H3 参考时携带旧字段副本，事务保留删除意图与幂等回执", (t) => {
    const db = new BackendDatabase(":memory:");
    t.after(() => db.close());
    const bindings = ["first", "second"].map((name) => ({ id: `binding-${name}`, assetId: `asset-${name}`, storageKey: `image:${name}`, mediaType: "image" }));
    const legacy = bindings.map((binding) => ({ bindingId: binding.id, storageKey: binding.storageKey, type: "image" }));
    db.createCanvasProject({ id: "legacy-retry", nodes: [{ id: "h3", type: "minimax-h3:video", metadata: { segments: [{ id: "ep01-v02", referenceBindings: bindings }] } }], connections: [] });
    const op = { type: "update_h3_segment", nodeId: "h3", segmentId: "ep01-v02", patch: { referenceBindings: [bindings[0]], refItems: legacy } };
    const before = db.getCanvasProject("legacy-retry")!;
    const beforeRevision = Number(before.revision || 0);
    const receipt = db.applyCanvasProjectOperations("legacy-retry", beforeRevision, [op], { operationId: "remove-stale-ref" });
    const segment = ((receipt.project.nodes as Array<{ metadata: { segments: Record<string, unknown>[] } }>)[0]).metadata.segments[0];
    assert.deepEqual(segment.referenceBindings, [bindings[0]]);
    assert.equal("refItems" in segment, false);
    assert.equal(receipt.revision, beforeRevision + 1);
    const replay = db.applyCanvasProjectOperations("legacy-retry", beforeRevision, [op], { operationId: "remove-stale-ref" });
    assert.equal(replay.duplicated, true);
    assert.equal(db.getCanvasProject("legacy-retry")!.revision, receipt.revision);

    const invalid = { ...op, patch: { referenceBindings: [], refItems: [...legacy, { bindingId: "unknown", storageKey: "image:unknown", type: "image" }] } };
    assert.throws(() => db.applyCanvasProjectOperations("legacy-retry", receipt.revision, [invalid], { operationId: "reject-extra-ref" }), /绑定与旧参考不一致/);
    assert.deepEqual(db.getCanvasProject("legacy-retry"), receipt.project);
});

test("旧检查点含参考副本时仍能重取已提交 H3 操作的原回执", (t) => {
    const db = new BackendDatabase(":memory:");
    t.after(() => db.close());
    const oldBindings = ["first", "second"].map((name) => ({ id: `binding-${name}`, assetId: `asset-${name}`, storageKey: `image:${name}`, mediaType: "image" }));
    db.createCanvasProject({ id: "history-replay", nodes: [{ id: "h3", type: "minimax-h3:video", metadata: { segments: [{ id: "ep01-v02", referenceBindings: oldBindings }] } }], connections: [] });
    const operation = { type: "update_h3_segment", nodeId: "h3", segmentId: "ep01-v02", patch: {
        referenceBindings: [...oldBindings, { id: "binding-third", assetId: "asset-third", storageKey: "image:third", mediaType: "image" }],
    } };
    const first = db.applyCanvasProjectOperations("history-replay", undefined, [operation], { operationId: "already-committed" });
    const rawDb = (db as unknown as { db: { prepare: (sql: string) => { get: (...values: unknown[]) => { data_json: string }; run: (...values: unknown[]) => void } } }).db;
    const checkpoint = JSON.parse(rawDb.prepare("SELECT data_json FROM canvas_collaboration_checkpoints WHERE project_id = ?").get("history-replay").data_json) as Record<string, any>;
    checkpoint.nodes[0].metadata.segments[0].refItems = oldBindings.map((binding) => ({ bindingId: binding.id, storageKey: binding.storageKey, type: "image" }));
    rawDb.prepare("UPDATE canvas_collaboration_checkpoints SET data_json = ? WHERE project_id = ?").run(JSON.stringify(checkpoint), "history-replay");

    const duplicate = db.applyCanvasProjectOperations("history-replay", undefined, [operation], { operationId: "already-committed" });
    assert.equal(duplicate.duplicated, true);
    assert.deepEqual(duplicate.project, first.project);
    assert.deepEqual(db.getCanvasProject("history-replay"), first.project);
});

test("进程内任务权限可更新状态，普通提示词/布局仍可编辑", (t) => {
    const db = fixture(t);
    db.applyCanvasProjectOperations("p", undefined, [
        { type: "update_node", id: "h3", metadata: { status: "loading", runtimeTaskId: "new-parent" } },
        { type: "update_h3_segment", nodeId: "h3", segmentId: "s1", patch: { status: "loading", runtimeTaskId: "new-child" }, patchDelete: ["result"] },
    ], { runtimeWrite: true, source: { kind: "task" } });
    const updated = db.applyCanvasProjectOperations("p", undefined, [
        { type: "update_node", id: "h3", patch: { position: { x: 20, y: 40 } }, metadata: { prompt: "可编辑" } },
        { type: "update_h3_segment", nodeId: "h3", segmentId: "s1", patch: { prompt: "新台词" } },
    ]);
    const node = (updated.project.nodes as Array<{ position: unknown; metadata: Record<string, unknown> }>)[0];
    assert.deepEqual(node.position, { x: 20, y: 40 });
    assert.equal(node.metadata.runtimeTaskId, "new-parent");
    assert.equal((node.metadata.segments as Record<string, unknown>[])[0].prompt, "新台词");
});

test("普通节点绑定后台任务时丢弃客户端瞬态字段但保留布局和提示词", (t) => {
    const db = new BackendDatabase(":memory:");
    t.after(() => db.close());
    db.createCanvasProject({ id: "media", nodes: [{ id: "image", type: "image", position: { x: 0, y: 0 }, metadata: { prompt: "旧提示", status: "loading", runtimeTaskId: "task-1", runProgress: 0.4 } }], connections: [] });
    const result = db.applyCanvasProjectOperations("media", undefined, [{
        type: "update_node", id: "image", patch: { position: { x: 20, y: 30 } },
        metadata: { prompt: "新提示", status: "success", runtimeTaskId: "fake", runProgress: 1, errorDetails: "旧错误" },
        metadataDelete: ["runtimeTaskId"],
    }]);
    const node = (result.project.nodes as Array<Record<string, any>>)[0];
    assert.deepEqual(node.position, { x: 20, y: 30 });
    assert.equal(node.metadata.prompt, "新提示");
    assert.equal(node.metadata.status, "loading");
    assert.equal(node.metadata.runtimeTaskId, "task-1");
    assert.equal(node.metadata.runProgress, 0.4);
    assert.equal(node.metadata.errorDetails, undefined);
});

test("H3 个人视图字段在新建、导入节点和旧客户端更新边界全部剥离", (t) => {
    const db = new BackendDatabase(":memory:");
    t.after(() => db.close());
    db.createCanvasProject({ id: "local-view", nodes: [{ id: "seed", type: "minimax-h3:video", metadata: { selectedSegmentId: "S02", playhead: 4, minimaxPreviewH: 900, prompt: "共享" } }], connections: [] });
    let nodes = db.getCanvasProject("local-view")!.nodes as Array<Record<string, any>>;
    assert.equal(nodes[0].metadata.prompt, "共享");
    assert.equal(Object.hasOwn(nodes[0].metadata, "selectedSegmentId"), false);
    assert.equal(Object.hasOwn(nodes[0].metadata, "playhead"), false);
    assert.equal(Object.hasOwn(nodes[0].metadata, "minimaxPreviewH"), false);

    db.applyCanvasProjectOperations("local-view", undefined, [{ type: "add_node", id: "added", nodeType: "minimax-h3:video", metadata: { timelineScrollLeft: 320, nanFengExpandedSections: { model: true }, segments: [{ id: "S01" }] } }]);
    db.applyCanvasProjectOperations("local-view", undefined, [{ type: "update_node", id: "added", metadata: { selectedSegmentId: "S01", minimaxPromptW: 700, notes: "保留" }, metadataDelete: ["playhead"] }]);
    nodes = db.getCanvasProject("local-view")!.nodes as Array<Record<string, any>>;
    assert.deepEqual(nodes[1].metadata.segments, [{ id: "S01" }]);
    assert.equal(nodes[1].metadata.notes, "保留");
    for (const field of ["timelineScrollLeft", "nanFengExpandedSections", "selectedSegmentId", "minimaxPromptW", "playhead"]) {
        assert.equal(Object.hasOwn(nodes[1].metadata, field), false);
    }

    const rawDb = (db as unknown as { db: { prepare: (sql: string) => { run: (...values: unknown[]) => void } } }).db;
    const legacy = structuredClone(db.getCanvasProject("local-view")!) as Record<string, any>;
    legacy.nodes[0].metadata = { ...legacy.nodes[0].metadata, selectedSegmentId: "S09", minimaxTimelineH: 999 };
    rawDb.prepare("UPDATE canvas_projects SET data_json = ? WHERE id = ?").run(JSON.stringify(legacy), "local-view");
    rawDb.prepare("UPDATE canvas_collaboration_checkpoints SET revision = ?, data_json = ? WHERE project_id = ?").run(Number(legacy.revision || 0), JSON.stringify(legacy), "local-view");
    assert.equal(Object.hasOwn((db.getCanvasProject("local-view")!.nodes as Array<Record<string, any>>)[0].metadata, "selectedSegmentId"), false);
    assert.equal(Object.hasOwn((db.listCanvasProjects()[0].nodes as Array<Record<string, any>>)[0].metadata, "minimaxTimelineH"), false);
    const receipt = db.applyCanvasProjectOperations("local-view", undefined, [{ type: "update_project", patch: { title: "迁移旧项目" } }], { operationId: "legacy-local-view" });
    assert.equal(Object.hasOwn((receipt.project.nodes as Array<Record<string, any>>)[0].metadata, "selectedSegmentId"), false);
    assert.deepEqual(db.applyCanvasProjectOperations("local-view", undefined, [{ type: "update_project", patch: { title: "迁移旧项目" } }], { operationId: "legacy-local-view" }).project, receipt.project);
});

test("拒绝输出修改时，同批合法文本增量与条件替换也完整回滚", (t) => {
    const db = fixture(t);
    assert.throws(() => db.getCanvasText("p", { nodeId: "h3", field: "content" }), /不是可协作文本/);
    const target = { nodeId: "h3", segmentId: "s1", field: "prompt" };
    const state = db.getCanvasText("p", target);
    const before = db.getCanvasProject("p");
    const doc = new Y.Doc();
    Y.applyUpdate(doc, Buffer.from(state.state, "base64"));
    const vector = Y.encodeStateVector(doc);
    doc.getText("text").insert(0, "篡改");
    const update = Buffer.from(Y.encodeStateAsUpdate(doc, vector)).toString("base64");
    const invalid = { type: "update_node", id: "h3", metadata: { content: "篡改" } };
    assert.throws(() => db.applyCanvasProjectOperations("p", undefined, [{ type: "text_update", target, documentId: state.documentId, update }, invalid]), /后台任务/);
    assert.throws(() => db.applyCanvasProjectOperations("p", undefined, [{ type: "text_replace", target, documentId: state.documentId, expectedText: state.text, text: "篡改" }, invalid]), /后台任务/);
    assert.deepEqual(db.getCanvasText("p", target), state);
    assert.deepEqual(db.getCanvasProject("p"), before);
    assert.equal(db.readCanvasChanges("p", 0).commits.length, 0);
    doc.destroy();
});

test("真实任务回写仍可落库并记录增量，旧任务不能覆盖已被接管的 Clip", (t) => {
    const db = fixture(t);
    const task = { id: "child1", status: "succeeded", progress: 100 } as RuntimeTask;
    const binding = { projectId: "p", nodeId: "h3", segmentId: "s1" };
    const output = { url: "new.mp4", storageKey: "new.mp4", type: "video" };
    const saved = db.writeBackH3Task(task, binding, output);
    assert.ok(saved);
    const node = (saved.project.nodes as Array<{ metadata: Record<string, unknown> }>)[0];
    const segments = node.metadata.segments as Record<string, unknown>[];
    assert.equal(node.metadata.content, "new.mp4");
    assert.equal(segments[0].result, "new.mp4");
    assert.equal(segments[0].runtimeTaskId, "");
    assert.equal(segments[1].result, "two.mp4");
    assert.equal(db.readCanvasChanges("p", 0).commits.length, 1);
    db.applyCanvasProjectOperations("p", undefined, [{ type: "update_h3_segment", nodeId: "h3", segmentId: "s1", patch: { runtimeTaskId: "new-task", status: "loading" } }], { runtimeWrite: true });
    const before = db.getCanvasProject("p");
    assert.equal(db.writeBackH3Task(task, binding, { ...output, url: "stale.mp4" }), null);
    assert.deepEqual(db.getCanvasProject("p"), before);
});
