import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { BackendDatabase } from "../db.js";
import { createStores } from "../stores/index.js";
import { canonicalizeH3References, registerH3ReferenceAssets } from "./project-ops.js";

test("H3 旧引用迁移保留 Clip 语义并拆分冲突媒体", (t) => {
    const base = path.resolve(process.env.INFINITE_CANVAS_DATA_DIR || os.tmpdir());
    fs.mkdirSync(base, { recursive: true });
    const directory = fs.mkdtempSync(path.join(base, "h3-migrate-"));
    let migrated: BackendDatabase | undefined;
    t.after(() => {
        migrated?.close();
        const resolved = path.resolve(directory);
        if (resolved.startsWith(base + path.sep)) fs.rmSync(resolved, { recursive: true, force: true });
    });
    const file = path.join(directory, "runtime.sqlite");
    const db = new BackendDatabase(file);
    db.createCanvasProject({ id: "p", nodes: [], connections: [] });
    const project = db.getCanvasProject("p")!;
    project.nodes = [{ id: "h3", type: "minimax-h3", metadata: { segments: [
        { id: "a", prompt: "a", refItems: [{ bindingId: "bind-a", assetId: "shared", name: "书房", type: "image", role: "scene", storageKey: "image:a" }] },
        { id: "b", prompt: "b", referenceBindings: [], refItems: [{ bindingId: "bind-b", assetId: "shared", name: "角色服装", type: "image", role: "character_identity", subjectId: "hero", storageKey: "image:b" }] },
        { id: "c", prompt: "c", refItems: [{ bindingId: "bind-c", assetId: "shared", name: "另一个书房用途", type: "image", role: "storyboard", storageKey: "image:a" }] },
    ] } }] as typeof project.nodes;
    db.db.prepare("UPDATE canvas_projects SET data_json = ? WHERE id = 'p'").run(JSON.stringify(project));
    db.db.prepare("DELETE FROM schema_migrations WHERE version = 14").run();
    db.close();

    migrated = new BackendDatabase(file);
    const saved = migrated.getCanvasProject("p")!;
    const segments = (((saved.nodes as Array<Record<string, unknown>>)[0]).metadata as { segments: Array<Record<string, unknown>> }).segments;
    const bindings = segments.map((segment) => (segment.referenceBindings as Array<Record<string, unknown>>)[0]);
    assert.deepEqual(bindings.map((item) => item.label), ["书房", "角色服装", "另一个书房用途"]);
    assert.deepEqual(bindings.map((item) => item.role), ["scene", "character_identity", "storyboard"]);
    assert.equal(bindings[1].subjectId, "hero");
    assert.notEqual(bindings[0].assetId, bindings[1].assetId);
    assert.equal(bindings[0].assetId, bindings[2].assetId);
    assert.ok(segments.every((segment) => !("refItems" in segment) && !("refs" in segment)));
    assert.equal((saved.referenceCatalog as unknown[] | undefined)?.length, 2);
    assert.equal((migrated.db.prepare("SELECT COUNT(*) AS n FROM h3_reference_legacy_archive").get() as { n: number }).n, 3);
    assert.ok(fs.statSync(`${file}.pre-h3-v14-reference-archive.sqlite`).size > 0);
});

test("旧绑定与参考不一致时保留绑定真值并原样归档旧字段", (t) => {
    const base = path.resolve(process.env.INFINITE_CANVAS_DATA_DIR || os.tmpdir());
    fs.mkdirSync(base, { recursive: true });
    const directory = fs.mkdtempSync(path.join(base, "h3-conflict-"));
    let migrated: BackendDatabase | undefined;
    t.after(() => {
        migrated?.close();
        if (path.resolve(directory).startsWith(base + path.sep)) fs.rmSync(directory, { recursive: true, force: true });
    });
    const file = path.join(directory, "runtime.sqlite");
    const db = new BackendDatabase(file);
    db.createCanvasProject({ id: "p", nodes: [], connections: [] });
    const project = db.getCanvasProject("p")!;
    const legacyNode = { id: "h3", type: "minimax-h3", metadata: { segments: [{
        id: "clip", referenceBindings: [{ id: "known", assetId: "asset", label: "已登记", role: "scene", tags: [], enabled: true, usage: "reference" }],
        refItems: [{ bindingId: "known", assetId: "asset", storageKey: "image:a" }, { bindingId: "missing", assetId: "other", storageKey: "image:b" }],
    }] } };
    assert.throws(() => canonicalizeH3References(structuredClone(legacyNode)), /拒绝丢弃原数据/);
    project.nodes = [legacyNode] as typeof project.nodes;
    db.db.prepare("UPDATE canvas_projects SET data_json = ? WHERE id = 'p'").run(JSON.stringify(project));
    db.db.prepare("DELETE FROM schema_migrations WHERE version = 14").run();
    db.close();
    migrated = new BackendDatabase(file);
    const saved = migrated.getCanvasProject("p")!;
    const segment = (((saved.nodes as Array<Record<string, unknown>>)[0]).metadata as { segments: Array<Record<string, unknown>> }).segments[0];
    assert.equal((segment.referenceBindings as unknown[]).length, 1);
    assert.equal("refItems" in segment, false);
    const archive = migrated.db.prepare("SELECT legacy_json FROM h3_reference_legacy_archive WHERE project_id = 'p' AND node_id = 'h3' AND segment_id = 'clip'").get() as { legacy_json: string };
    assert.equal((JSON.parse(archive.legacy_json) as { refItems: unknown[] }).refItems.length, 2);
    assert.ok(fs.statSync(`${file}.pre-h3-v14-reference-archive.sqlite`).size > 0);
});

test("关闭角色服装后前端重发旧 refItems 不应被当作丢弃原数据", (t) => {
    const db = new BackendDatabase(":memory:");
    t.after(() => db.close());
    // 存储态：只有 referenceBindings（5 个），没有任何旧字段。
    const bindings = [
        { id: "b1", role: "storyboard", label: "分镜图1", storageKey: "image:1", assetId: "a1" },
        { id: "b2", role: "storyboard", label: "分镜图2", storageKey: "image:2", assetId: "a2" },
        { id: "b3", role: "character_turnaround", label: "沈侯服装", storageKey: "image:3", assetId: "a3" },
        { id: "b4", role: "character_voice", label: "沈侯声线", storageKey: "audio:4", assetId: "a4" },
        { id: "b5", role: "character_turnaround", label: "沈昭宁服装", storageKey: "image:5", assetId: "a5" },
    ];
    db.createCanvasProject({ id: "p", nodes: [{ id: "h3", type: "minimax-h3", metadata: { segments: [{ id: "clip", title: "V02", referenceBindings: bindings }] } }], connections: [] });
    const stores = createStores(db);
    // 用户在 UI 关闭沈侯服装：内存里 referenceBindings 仍是 5，但 refItems 只剩 3。
    const withoutShenhouOutfit = bindings.filter((binding) => binding.id !== "b3");
    stores.projects.applyOperations("p", Number(stores.projects.get("p")!.revision || 0), [
        { type: "update_h3_segment", nodeId: "h3", segmentId: "clip", patch: { referenceBindings: bindings, refItems: withoutShenhouOutfit } },
    ]);
    const segment = (stores.projects.get("p")!.nodes as unknown as Array<{ metadata: { segments: Array<Record<string, unknown>> } }>)[0].metadata.segments[0];
    assert.equal("refItems" in segment, false, "旧字段必须被清掉");
    assert.equal((segment.referenceBindings as unknown[]).length, 5, "关闭服装不应误删 referenceBindings");
});

/** Clip 参考绑定夹具：5 条真实角色/分镜/声线绑定。 */
const H3_REF_BINDINGS = [
    { id: "b1", assetId: "a1", label: "分镜图1", role: "storyboard", mediaType: "image", storageKey: "image:1" },
    { id: "b2", assetId: "a2", label: "分镜图2", role: "storyboard", mediaType: "image", storageKey: "image:2" },
    { id: "b3", assetId: "a3", label: "沈侯服装", role: "character_turnaround", mediaType: "image", storageKey: "image:3" },
    { id: "b4", assetId: "a4", label: "沈侯声线", role: "character_voice", mediaType: "audio", storageKey: "audio:4" },
    { id: "b5", assetId: "a5", label: "沈昭宁服装", role: "character_turnaround", mediaType: "image", storageKey: "image:5" },
];
const h3PickBindings = (ids: string[]) => H3_REF_BINDINGS.filter((binding) => ids.includes(String(binding.id)));
const h3LegacyRefs = (ids: string[]) => h3PickBindings(ids).map((binding) => ({ bindingId: binding.id, assetId: binding.assetId, storageKey: binding.storageKey, type: binding.mediaType, name: binding.label, role: binding.role }));

function h3SegmentNode(nextIds: string[], legacyIds: string[]): Record<string, unknown> {
    return {
        id: "h3",
        type: "minimax-h3:video",
        metadata: { segments: [{ id: "ep01-v02", title: "V02", referenceBindings: h3PickBindings(nextIds), refItems: h3LegacyRefs(legacyIds) }] },
    };
}

test("关闭服装后前端重发夹带已移除绑定的旧镜像按当前绑定放行", () => {
    // 存储态干净（5 绑定、无旧字段）；用户关掉沈侯服装后前端把 b3 从绑定移除，
    // 但内存里的旧字段仍夹带 b3 且已不含 b4 —— 既不是上一版的镜像，也不是当前绑定的镜像。
    const previousSegments = new Map([["ep01-v02", { id: "ep01-v02", referenceBindings: h3PickBindings(["b1", "b2", "b3", "b4", "b5"]) }]]);
    const node = h3SegmentNode(["b1", "b2", "b4", "b5"], ["b1", "b2", "b3", "b5"]);
    canonicalizeH3References(node, undefined, previousSegments);
    const segment = (node.metadata as { segments: Array<Record<string, unknown>> }).segments[0];
    assert.equal("refItems" in segment, false, "旧字段必须被清掉");
    assert.equal("refs" in segment, false, "旧字段必须被清掉");
    assert.deepEqual((segment.referenceBindings as Array<{ id: string }>).map((binding) => binding.id), ["b1", "b2", "b4", "b5"], "绑定真值不被旧字段改写");
});

test("关闭声线后前端重发夹带已移除绑定的旧镜像同样放行", () => {
    const previousSegments = new Map([["ep01-v02", { id: "ep01-v02", referenceBindings: h3PickBindings(["b1", "b2", "b3", "b4", "b5"]) }]]);
    assert.doesNotThrow(() => canonicalizeH3References(h3SegmentNode(["b1", "b2", "b3", "b5"], ["b1", "b2", "b3", "b5"]), undefined, previousSegments));
});

test("放行后引用两版绑定都不存在的旧字段仍然拒绝", () => {
    // 没有上一版可对照（导入 / 迁移路径）：旧字段是唯一记录，引用不存在的 binding 必须拒绝。
    assert.throws(() => canonicalizeH3References(h3SegmentNode(["b1"], ["b1", "b2"]), undefined, undefined), /拒绝丢弃原数据/);
});

test("上一版本身就带旧字段时仍按迁移规则校验", () => {
    const previousSegments = new Map([["ep01-v02", {
        id: "ep01-v02",
        referenceBindings: h3PickBindings(["b1"]),
        refItems: h3LegacyRefs(["b1", "b2"]),
    }]]);
    assert.throws(() => canonicalizeH3References(h3SegmentNode(["b1"], ["b1", "b2"]), undefined, previousSegments), /拒绝丢弃原数据/);
});

test("导入旧 H3 画布时也归档不一致的参考快照", (t) => {
    const db = new BackendDatabase(":memory:");
    t.after(() => db.close());
    const created = db.createCanvasProject({ id: "imported", nodes: [{
        id: "h3", type: "minimax-h3", metadata: { segments: [{
            id: "clip",
            referenceBindings: [{ id: "binding", assetId: "asset", label: "当前参考", role: "scene", enabled: true, usage: "reference" }],
            refItems: [{ bindingId: "binding", assetId: "asset", storageKey: "image:a" }, { bindingId: "stale", assetId: "old", storageKey: "image:b" }],
        }] },
    }], connections: [] });
    const segment = (((created.project.nodes as Array<Record<string, unknown>>)[0]).metadata as { segments: Array<Record<string, unknown>> }).segments[0];
    assert.equal((segment.referenceBindings as unknown[]).length, 1);
    assert.equal("refItems" in segment, false);
    const archive = db.db.prepare("SELECT legacy_json FROM h3_reference_legacy_archive WHERE project_id = 'imported' AND node_id = 'h3' AND segment_id = 'clip'").get() as { legacy_json: string };
    assert.equal((JSON.parse(archive.legacy_json) as { refItems: unknown[] }).refItems.length, 2);
});

test("旧绑定只含媒体快照时保留共享资产的动态来源", () => {
    const node = { id: "h3", type: "minimax-h3", metadata: { segments: [{
        id: "clip", referenceBindings: [{ id: "binding", assetId: "asset", label: "分镜", role: "storyboard", storageKey: "image:old" }],
    }] } };
    const project: Record<string, unknown> = {
        nodes: [node],
        referenceCatalog: [{ id: "asset", label: "分镜", storageKey: "image:old", sourceNodeId: "smart" }],
    };
    registerH3ReferenceAssets(project, node);
    const binding = ((node.metadata.segments[0] as Record<string, unknown>).referenceBindings as Array<Record<string, unknown>>)[0];
    assert.equal(binding.assetId, "asset");
    assert.equal((project.referenceCatalog as Array<Record<string, unknown>>).length, 1);
    assert.equal((project.referenceCatalog as Array<Record<string, unknown>>)[0].sourceNodeId, "smart");
});

test("任务查询先在 SQLite 过滤和分页，超过 500 个活动任务仍可全部遍历", (t) => {
    const db = new BackendDatabase(":memory:");
    t.after(() => db.close());
    for (let index = 0; index < 1101; index++) {
        const task = db.createTask(`active-${index}`, "canvas-h3-run", { projectId: "p", nodeId: "h3", segmentId: "clip" }, {});
        db.updateTask(task.id, { status: "running" });
    }
    for (let index = 0; index < 100; index++) {
        const task = db.createTask(`other-${index}`, "canvas-h3-run", { projectId: "other", nodeId: "h3" }, {});
        db.updateTask(task.id, { status: "succeeded" });
    }
    const pages = [0, 500, 1000].flatMap((offset) => db.listTasks({ projectId: "p", kind: "canvas-h3-run", status: "running", limit: 500, offset }));
    assert.equal(pages.length, 1101);
    assert.equal(new Set(pages.map((task) => task.id)).size, 1101);
    assert.ok(pages.every((task) => task.projectId === "p" && task.status === "running"));
    const plan = db.db.prepare("EXPLAIN QUERY PLAN SELECT * FROM tasks WHERE project_id = ? AND kind = ? AND status = ? ORDER BY created_at DESC LIMIT 500").all("p", "canvas-h3-run", "running") as Array<{ detail: string }>;
    assert.ok(plan.some((row) => row.detail.includes("tasks_project_kind_status_created")));
});

test("历史输出只由 Backend 核对日志与媒体后还原", (t) => {
    const db = new BackendDatabase(":memory:");
    t.after(() => db.close());
    db.createCanvasProject({ id: "p", nodes: [{ id: "h3", type: "minimax-h3", metadata: { segments: [{ id: "clip", prompt: "current", status: "idle" }] } }], connections: [] });
    const stores = createStores(db);
    const media = stores.media.store(Buffer.from("historical-video"), { name: "old.mp4", mimeType: "video/mp4", category: "output" });
    const log = stores.logs.create({
        projectId: "p", nodeId: "h3", segmentId: "clip", status: "success", platform: "comfyui",
        workflow: "MiniMax H3", model: "h3", taskMode: "t2v", prompt: "historical prompt", references: [],
        inputCounts: {}, startedAt: new Date().toISOString(), durationMs: 1,
        outputs: [{ url: `/media/${encodeURIComponent(media.storageKey)}`, storageKey: media.storageKey, mimeType: "video/mp4" }], params: {},
    });
    const result = db.applyCanvasProjectOperations("p", undefined, [{
        type: "restore_h3_output", nodeId: "h3", segmentId: "clip", generationLogId: log.id,
        storageKey: media.storageKey, settings: { prompt: "historical prompt" },
    }], { source: { clientId: "test", kind: "browser", label: "还原输出" } });
    const segment = (((result.project.nodes as Array<Record<string, unknown>>)[0]).metadata as { segments: Array<Record<string, unknown>> }).segments[0];
    assert.equal(segment.resultStorageKey, media.storageKey);
    assert.equal(segment.prompt, "historical prompt");
    assert.throws(() => db.applyCanvasProjectOperations("p", undefined, [{ type: "restore_h3_output", nodeId: "other", segmentId: "clip", generationLogId: log.id }]), /不属于/);
});
