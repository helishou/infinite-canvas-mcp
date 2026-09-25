import assert from "node:assert/strict";
import test from "node:test";

import { applyCanvasProjectOperations } from "./project-ops.js";

type Project = { revision?: number; nodes: Array<Record<string, unknown>>; connections: Array<Record<string, unknown>>; selectedNodeIds?: string[]; viewport?: Record<string, unknown> };

function makeH3Node(overrides: Partial<{ id: string; segments: Array<Record<string, unknown>> }> = {}): Record<string, unknown> {
    return {
        id: overrides.id || "h3-1",
        type: "minimax-h3:video",
        title: "H3 节点",
        position: { x: 0, y: 0 },
        width: 600,
        height: 400,
        metadata: {
            segments: overrides.segments || [
                { id: "s1", prompt: "开场", status: "idle" },
                { id: "s2", prompt: "中段", status: "idle" },
            ],
        },
    };
}

function makeProject(nodes: Array<Record<string, unknown>>): Project {
    return { revision: 1, nodes, connections: [] };
}

test("update_h3_segment：按 segmentId 原子更新单段字段，不动其它段", () => {
    const project = makeProject([makeH3Node()]);
    const results = applyCanvasProjectOperations(project as Record<string, unknown>, [
        { type: "update_h3_segment", nodeId: "h3-1", segmentId: "s1", patch: { prompt: "新的开场", status: "loading" } },
    ]);
    assert.equal(results[0].ok, true);
    assert.deepEqual(results[0].updatedSegmentIds, ["s1"]);
    const segments = (project.nodes[0].metadata as Record<string, unknown>).segments as Array<Record<string, unknown>>;
    assert.equal(segments[0].prompt, "新的开场");
    assert.equal(segments[0].status, "loading");
    assert.equal(segments[1].prompt, "中段");
});

test("update_h3_segment：CAS 失败时抛错（runtimeTaskId 已被清空）", () => {
    // 旧任务试图回写时本应 CAS 失败：当前段 runtimeTaskId 已被新任务清空，而旧任务仍带 expectedFields.runtimeTaskId = "task-A"
    const project = makeProject([makeH3Node({
        segments: [
            { id: "s1", prompt: "开场", status: "running", runtimeTaskId: "" },
        ],
    })]);
    assert.throws(() => applyCanvasProjectOperations(project as Record<string, unknown>, [
        { type: "update_h3_segment", nodeId: "h3-1", segmentId: "s1", patch: { status: "success" }, expectedFields: { runtimeTaskId: "task-A" } },
    ]), /CAS 失败/);
});

test("update_h3_segment：patchDelete 正确删除段内字段", () => {
    const project = makeProject([makeH3Node({
        segments: [
            { id: "s1", prompt: "开场", status: "error", errorDetails: "旧错误" } as Record<string, unknown>,
        ],
    })]);
    applyCanvasProjectOperations(project as Record<string, unknown>, [
        { type: "update_h3_segment", nodeId: "h3-1", segmentId: "s1", patch: { status: "success" }, patchDelete: ["errorDetails"] },
    ]);
    const seg = ((project.nodes[0].metadata as Record<string, unknown>).segments as Array<Record<string, unknown>>)[0];
    assert.equal(seg.status, "success");
    assert.equal("errorDetails" in seg, false);
});

test("add_h3_segment：按 id 追加新段到末尾，重复 id 抛错", () => {
    const project = makeProject([makeH3Node()]);
    applyCanvasProjectOperations(project as Record<string, unknown>, [
        { type: "add_h3_segment", nodeId: "h3-1", segment: { id: "s3", prompt: "新段" } },
    ]);
    const segments = (project.nodes[0].metadata as Record<string, unknown>).segments as Array<Record<string, unknown>>;
    assert.equal(segments.length, 3);
    assert.equal(segments[2].id, "s3");
    assert.throws(() => applyCanvasProjectOperations(project as Record<string, unknown>, [
        { type: "add_h3_segment", nodeId: "h3-1", segment: { id: "s3", prompt: "重复" } },
    ]), /已存在/);
});

test("add_h3_segment：可按 beforeSegmentId / afterSegmentId 插入并保留完整段字段", () => {
    const project = makeProject([makeH3Node({
        segments: [
            { id: "s1", prompt: "开场", referenceBindings: [{ id: "r1" }] },
            { id: "s2", prompt: "中段", referenceBindings: [{ id: "r2" }] },
        ],
    })]);
    const before = applyCanvasProjectOperations(project as Record<string, unknown>, [
        { type: "add_h3_segment", nodeId: "h3-1", beforeSegmentId: "s2", segment: { id: "s1b", prompt: "插入前", referenceBindings: [{ id: "rb" }] } },
    ]);
    assert.equal(before[0].insertedSegmentIndex, 1);
    let segments = (project.nodes[0].metadata as Record<string, unknown>).segments as Array<Record<string, unknown>>;
    assert.deepEqual(segments.map((segment) => segment.id), ["s1", "s1b", "s2"]);
    assert.deepEqual(segments[1].referenceBindings, [{ id: "rb" }]);

    const after = applyCanvasProjectOperations(project as Record<string, unknown>, [
        { type: "add_h3_segment", nodeId: "h3-1", afterSegmentId: "s1b", segment: { id: "s1c", prompt: "插入后" } },
    ]);
    assert.equal(after[0].insertedSegmentIndex, 2);
    segments = (project.nodes[0].metadata as Record<string, unknown>).segments as Array<Record<string, unknown>>;
    assert.deepEqual(segments.map((segment) => segment.id), ["s1", "s1b", "s1c", "s2"]);
});

test("add_h3_segment：插入定位参数互斥且必须命中已有段", () => {
    const project = makeProject([makeH3Node()]);
    assert.throws(() => applyCanvasProjectOperations(project as Record<string, unknown>, [
        { type: "add_h3_segment", nodeId: "h3-1", beforeSegmentId: "s1", afterSegmentId: "s2", segment: { id: "s3" } },
    ]), /不能同时指定/);
    assert.throws(() => applyCanvasProjectOperations(project as Record<string, unknown>, [
        { type: "add_h3_segment", nodeId: "h3-1", beforeSegmentId: "missing", segment: { id: "s3" } },
    ]), /beforeSegmentId 不存在/);
    assert.throws(() => applyCanvasProjectOperations(project as Record<string, unknown>, [
        { type: "add_h3_segment", nodeId: "h3-1", afterSegmentId: "missing", segment: { id: "s4" } },
    ]), /afterSegmentId 不存在/);
});

test("delete_h3_segment：按 id 删除；远端已无该段视为 skipped", () => {
    const project = makeProject([makeH3Node()]);
    const results = applyCanvasProjectOperations(project as Record<string, unknown>, [
        { type: "delete_h3_segment", nodeId: "h3-1", segmentId: "s2" },
    ]);
    assert.deepEqual(results[0].deletedSegmentIds, ["s2"]);
    const segments = (project.nodes[0].metadata as Record<string, unknown>).segments as Array<Record<string, unknown>>;
    assert.equal(segments.length, 1);
    assert.equal(segments[0].id, "s1");
    // 远端已删
    const second = applyCanvasProjectOperations(project as Record<string, unknown>, [
        { type: "delete_h3_segment", nodeId: "h3-1", segmentId: "s2" },
    ]);
    assert.equal(second[0].skipped, true);
});

test("delete_node 后同批 delete_connections：连线已级联删除时幂等跳过", () => {
    const project = makeProject([
        { id: "node-1", type: "text", metadata: {} },
        { id: "node-2", type: "text", metadata: {} },
    ]);
    project.connections = [{ id: "edge-1", fromNodeId: "node-1", toNodeId: "node-2" }];
    const results = applyCanvasProjectOperations(project as Record<string, unknown>, [
        { type: "delete_node", id: "node-1" },
        { type: "delete_connections", ids: ["edge-1"] },
    ]);
    assert.deepEqual(results[0].deletedNodeIds, ["node-1"]);
    assert.equal(results[1].skipped, true);
    assert.deepEqual(results[1].deletedConnectionIds, []);
    assert.equal(project.nodes.length, 1);
    assert.equal(project.connections.length, 0);
});

test("replace_h3_segments：完全替换；id 集合变化是允许的", () => {
    const project = makeProject([makeH3Node()]);
    const results = applyCanvasProjectOperations(project as Record<string, unknown>, [
        { type: "replace_h3_segments", nodeId: "h3-1", segments: [
            { id: "x1", prompt: "全新计划 1" },
            { id: "x2", prompt: "全新计划 2" },
        ] },
    ]);
    assert.deepEqual(results[0].deletedSegmentIds?.sort(), ["s1", "s2"]);
    assert.deepEqual(results[0].createdSegmentIds?.sort(), ["x1", "x2"]);
    const segments = (project.nodes[0].metadata as Record<string, unknown>).segments as Array<Record<string, unknown>>;
    assert.deepEqual(segments.map((s) => s.id), ["x1", "x2"]);
});

test("replace_h3_segments：省略字段继承旧值，显式空数组才清空参考", () => {
    const project = makeProject([makeH3Node()]);
    const segments = (project.nodes[0].metadata as Record<string, unknown>).segments as Array<Record<string, unknown>>;
    segments[0].refs = { image: [{ storageKey: "image:keep" }], video: [], audio: [] };
    segments[0].refItems = [{ storageKey: "image:keep" }];
    segments[0].referenceBindings = [{ id: "binding-keep", assetId: "asset-keep" }];
    applyCanvasProjectOperations(project as Record<string, unknown>, [
        { type: "replace_h3_segments", nodeId: "h3-1", segments: [{ id: "s1", prompt: "重排但丢了 refs" }, { id: "s2", prompt: "保留" }] },
    ]);
    const preserved = (project.nodes[0].metadata as Record<string, unknown>).segments as Array<Record<string, unknown>>;
    assert.equal((preserved[0].referenceBindings as unknown[]).length, 1);
    applyCanvasProjectOperations(project as Record<string, unknown>, [
        { type: "replace_h3_segments", nodeId: "h3-1", segments: [{ id: "s1", refs: { image: [], video: [], audio: [] }, refItems: [], referenceBindings: [] }, { id: "s2" }] },
    ]);
    const cleared = (project.nodes[0].metadata as Record<string, unknown>).segments as Array<Record<string, unknown>>;
    assert.deepEqual(cleared[0].referenceBindings, []);
});

test("update_node.metadata.segments 严格校验：id 集合不一致时抛错", () => {
    const project = makeProject([makeH3Node()]);
    assert.throws(() => applyCanvasProjectOperations(project as Record<string, unknown>, [
        { type: "update_node", id: "h3-1", metadata: { segments: [{ id: "s1" }, { id: "sX" }] } },
    ]), /metadata.segments 必须为完整数组/);
});

test("update_node.metadata.segments 严格校验：id 数量一致但少了某个 id 时抛错", () => {
    const project = makeProject([makeH3Node()]);
    assert.throws(() => applyCanvasProjectOperations(project as Record<string, unknown>, [
        { type: "update_node", id: "h3-1", metadata: { segments: [{ id: "s1" }, { id: "s1" }] } },
    ]), /metadata.segments 必须为完整数组/);
});

test("update_node.metadata.segments 严格校验：完整替换（同长同 id）允许", () => {
    const project = makeProject([makeH3Node()]);
    const results = applyCanvasProjectOperations(project as Record<string, unknown>, [
        { type: "update_node", id: "h3-1", metadata: { segments: [
            { id: "s1", prompt: "A", status: "idle" },
            { id: "s2", prompt: "B", status: "idle" },
        ] } },
    ]);
    assert.equal(results[0].ok, true);
    const segments = (project.nodes[0].metadata as Record<string, unknown>).segments as Array<Record<string, unknown>>;
    assert.equal(segments[0].prompt, "A");
    assert.equal(segments[1].prompt, "B");
});

test("非 H3 节点 metadata.segments 出现就抛错", () => {
    const project = makeProject([{ id: "img-1", type: "image", title: "图片", position: { x: 0, y: 0 }, width: 200, height: 200, metadata: {} }]);
    assert.throws(() => applyCanvasProjectOperations(project as Record<string, unknown>, [
        { type: "update_node", id: "img-1", metadata: { segments: [{ id: "s1" }] } },
    ]), /只有 H3 节点/);
});

test("update_h3_segment 在非 H3 节点上抛错", () => {
    const project = makeProject([{ id: "img-1", type: "image", title: "图片", position: { x: 0, y: 0 }, width: 200, height: 200, metadata: {} }]);
    assert.throws(() => applyCanvasProjectOperations(project as Record<string, unknown>, [
        { type: "update_h3_segment", nodeId: "img-1", segmentId: "s1", patch: { status: "loading" } },
    ]), /不是 H3 节点/);
});

test("混合：H3 节点级 metadata + 单段 patch 共存，revision 一次 +1", () => {
    const project = makeProject([makeH3Node()]);
    const results = applyCanvasProjectOperations(project as Record<string, unknown>, [
        { type: "update_h3_segment", nodeId: "h3-1", segmentId: "s1", patch: { status: "loading" } },
        { type: "update_node", id: "h3-1", metadata: { status: "running", runProgress: 0.5 } },
    ]);
    assert.equal(results.length, 2);
    const node = project.nodes[0];
    const segments = (node.metadata as Record<string, unknown>).segments as Array<Record<string, unknown>>;
    assert.equal(segments[0].status, "loading");
    assert.equal(segments[1].status, "idle");
    assert.equal((node.metadata as Record<string, unknown>).status, "running");
    assert.equal((node.metadata as Record<string, unknown>).runProgress, 0.5);
});

test("referenceBindings CAS 使用结构比较，且项目参考资产不会改节点位置", () => {
    const project = makeProject([makeH3Node()]) as Project & Record<string, unknown>;
    const originalPosition = structuredClone((project.nodes as Array<Record<string, unknown>>)[0].position);
    const bindings = [{ id: "binding-1", assetId: "asset-1", label: "人物", role: "character_identity", tags: [], enabled: true, usage: "reference", mediaType: "image", storageKey: "image:1" }];
    applyCanvasProjectOperations(project, [
        { type: "update_h3_segment", nodeId: "h3-1", segmentId: "s1", patch: { referenceBindings: bindings }, expectedFields: { referenceBindings: undefined } },
        { type: "upsert_reference_asset", asset: { id: "asset-1", label: "人物", mediaType: "image", role: "character_identity", tags: [], storageKey: "image:1" } },
    ]);
    assert.deepEqual((project.nodes as Array<Record<string, unknown>>)[0].position, originalPosition);
    assert.deepEqual(project.referenceCatalog, [{ id: "asset-1", label: "人物", mediaType: "image", role: "character_identity", tags: [], storageKey: "image:1" }]);
    assert.throws(() => applyCanvasProjectOperations(project, [{ type: "update_h3_segment", nodeId: "h3-1", segmentId: "s1", patch: { referenceBindings: [] }, expectedFields: { referenceBindings: [{ ...bindings[0], label: "旧人物" }] } }]));
});

test("移除 H3 绑定时允许请求夹带与保存前绑定相同的旧参考副本", () => {
    const bindings = ["first", "second"].map((name) => ({ id: `binding-${name}`, assetId: `asset-${name}`, storageKey: `image:${name}`, mediaType: "image" }));
    const legacy = bindings.map((binding) => ({ bindingId: binding.id, storageKey: binding.storageKey, type: "image" }));
    const project = makeProject([makeH3Node({ segments: [{ id: "ep01-v02", referenceBindings: bindings }] })]);
    applyCanvasProjectOperations(project as Record<string, unknown>, [{
        type: "update_h3_segment", nodeId: "h3-1", segmentId: "ep01-v02",
        patch: { referenceBindings: [bindings[0]], refItems: legacy, refs: { image: legacy, video: [], audio: [] } },
    }]);
    const segment = ((project.nodes[0].metadata as Record<string, unknown>).segments as Array<Record<string, unknown>>)[0];
    assert.deepEqual(segment.referenceBindings, [bindings[0]]);
    assert.equal("refItems" in segment, false);
    assert.equal("refs" in segment, false);

    const clearProject = makeProject([makeH3Node({ segments: [{ id: "ep01-v02", referenceBindings: bindings }] })]);
    applyCanvasProjectOperations(clearProject as Record<string, unknown>, [{
        type: "update_h3_segment", nodeId: "h3-1", segmentId: "ep01-v02",
        patch: { referenceBindings: [], refItems: legacy },
    }]);
    const cleared = ((clearProject.nodes[0].metadata as Record<string, unknown>).segments as Array<Record<string, unknown>>)[0];
    assert.deepEqual(cleared.referenceBindings, []);
    assert.equal("refItems" in cleared, false);
});

test("H3 旧参考副本含保存前绑定之外的素材时仍拒绝丢弃", () => {
    const binding = { id: "binding-first", assetId: "asset-first", storageKey: "image:first", mediaType: "image" };
    const project = makeProject([makeH3Node({ segments: [{ id: "ep01-v02", referenceBindings: [binding] }] })]);
    assert.throws(() => applyCanvasProjectOperations(project as Record<string, unknown>, [{
        type: "update_h3_segment", nodeId: "h3-1", segmentId: "ep01-v02",
        patch: { referenceBindings: [], refItems: [
            { bindingId: binding.id, storageKey: binding.storageKey, type: "image" },
            { bindingId: "binding-unknown", storageKey: "image:unknown", type: "image" },
        ] },
    }]), /绑定与旧参考不一致/);
});

test("新建 H3 Clip 的空绑定列表仍可从旧参考完整迁移", () => {
    const project = makeProject([makeH3Node({ segments: [] })]);
    applyCanvasProjectOperations(project as Record<string, unknown>, [{
        type: "add_h3_segment", nodeId: "h3-1", segment: {
            id: "legacy-new", referenceBindings: [],
            refItems: [{ bindingId: "binding-legacy", storageKey: "image:legacy", type: "image" }],
        },
    }]);
    const segment = ((project.nodes[0].metadata as Record<string, unknown>).segments as Array<Record<string, unknown>>)[0];
    assert.equal((segment.referenceBindings as Array<Record<string, unknown>>).length, 1);
    assert.equal("refItems" in segment, false);
});

test("add_node：省略坐标时按当前画布向右排布，同批节点不重叠", () => {
    const project = makeProject([]);
    applyCanvasProjectOperations(project as Record<string, unknown>, [
        { type: "add_node", id: "a", nodeType: "image", width: 320, height: 240 },
        { type: "add_node", id: "b", nodeType: "image", width: 320, height: 240 },
        { type: "add_node", id: "c", nodeType: "image", width: 640, height: 480 },
    ]);
    assert.deepEqual(project.nodes.map((node) => node.position), [
        { x: 0, y: 0 },
        { x: 416, y: 0 },
        { x: 832, y: 0 },
    ]);
});

test("add_node：显式坐标仍保持调用方布局，不被自动排布覆盖", () => {
    const project = makeProject([]);
    applyCanvasProjectOperations(project as Record<string, unknown>, [
        { type: "add_node", id: "a", nodeType: "text", position: { x: 120, y: 240 } },
    ]);
    assert.deepEqual(project.nodes[0].position, { x: 120, y: 240 });
});

test("add_node：写入有序组成员时同步 groupSlots 和节点位置", () => {
    const project = makeProject([
        { id: "g1", type: "group", title: "有序组", position: { x: 0, y: 0 }, width: 760, height: 480, metadata: { orderedGroup: true, groupSlots: ["old"] } },
        { id: "old", type: "image", title: "旧节点", position: { x: 24, y: 52 }, width: 240, height: 160, metadata: { groupId: "g1" } },
    ]);
    applyCanvasProjectOperations(project as Record<string, unknown>, [
        { type: "add_node", id: "new", nodeType: "image", position: { x: 1600, y: 900 }, width: 240, height: 160, metadata: { groupId: "g1" } },
    ]);
    const group = project.nodes.find((node) => node.id === "g1")!;
    const added = project.nodes.find((node) => node.id === "new")!;
    assert.deepEqual((group.metadata as Record<string, unknown>).groupSlots, ["old", "new"]);
    assert.ok((added.position as { x: number }).x < 760 && (added.position as { y: number }).y < 480, "新节点应立即落在有序组框内");
});

test("add_node：组框较小时，新增成员等比缩入槽位并写回操作回执", () => {
    const project = makeProject([
        { id: "g1", type: "group", title: "有序组", position: { x: 0, y: 0 }, width: 220, height: 160, metadata: { orderedGroup: true, groupSlots: [] } },
    ]);
    const operation = { type: "add_node" as const, id: "new", nodeType: "image", width: 400, height: 240, metadata: { groupId: "g1" } };
    applyCanvasProjectOperations(project as Record<string, unknown>, [operation]);
    const added = project.nodes.find((node) => node.id === "new")!;
    const x = (added.position as { x: number }).x;
    const y = (added.position as { y: number }).y;
    const width = Number(added.width);
    const height = Number(added.height);
    assert.ok(width > 0 && width <= 32.5);
    assert.ok(height > 0 && height <= 84);
    assert.ok(x >= 24 && x + width <= 56.5);
    assert.ok(y >= 52 && y + height <= 136);
    assert.equal(operation.width, width);
    assert.equal(operation.height, height);
});

test("add_node：新增一行槽位时重排并收紧已有成员", () => {
    const project = makeProject([
        { id: "g1", type: "group", title: "有序组", position: { x: 0, y: 0 }, width: 760, height: 480, metadata: { orderedGroup: true, groupSlots: ["a", "b", "c"] } },
        ...["a", "b", "c"].map((id) => ({ id, type: "image", title: id, position: { x: 0, y: 52 }, width: 160, height: 300, metadata: { groupId: "g1" } })),
    ]);
    applyCanvasProjectOperations(project as Record<string, unknown>, [
        { type: "add_node", id: "d", nodeType: "image", width: 160, height: 300, metadata: { groupId: "g1" } },
    ]);
    for (const id of ["a", "b", "c", "d"]) {
        const placed = project.nodes.find((node) => node.id === id)!;
        const y = (placed.position as { y: number }).y;
        const height = Number(placed.height);
        assert.ok(height <= 195);
        assert.ok(y >= 52 && y + height <= 247);
    }
});

test("拖出有序组的撤销和重做保留显式槽位顺序与成员布局", () => {
    const project = makeProject([
        { id: "g", type: "group", title: "有序组", position: { x: 10, y: 20 }, width: 760, height: 480, metadata: { orderedGroup: true, groupSlots: ["a", "c"] } },
        { id: "a", type: "image", title: "A", position: { x: 80, y: 145 }, width: 160, height: 96, metadata: { groupId: "g" } },
        { id: "b", type: "image", title: "B", position: { x: 900, y: 80 }, width: 180, height: 120, metadata: {} },
        { id: "c", type: "image", title: "C", position: { x: 415, y: 145 }, width: 160, height: 96, metadata: { groupId: "g" } },
    ]);
    const after = structuredClone(project.nodes);
    applyCanvasProjectOperations(project as Record<string, unknown>, [
        { type: "update_node", id: "g", metadata: { groupSlots: ["a", "b", "c"] } },
        { type: "update_node", id: "a", patch: { position: { x: 58, y: 100 }, width: 180, height: 120 } },
        { type: "update_node", id: "b", patch: { position: { x: 220, y: 100 } }, metadata: { groupId: "g" } },
        { type: "update_node", id: "c", patch: { position: { x: 410, y: 100 }, width: 180, height: 120 } },
    ]);
    assert.deepEqual((project.nodes[0].metadata as Record<string, unknown>).groupSlots, ["a", "b", "c"]);
    assert.deepEqual(project.nodes[1].position, { x: 58, y: 100 });
    assert.deepEqual(project.nodes[1].width, 180);
    applyCanvasProjectOperations(project as Record<string, unknown>, [
        { type: "update_node", id: "g", metadata: { groupSlots: ["a", "c"] } },
        { type: "update_node", id: "a", patch: { position: { x: 80, y: 145 }, width: 160, height: 96 } },
        { type: "update_node", id: "b", patch: { position: { x: 900, y: 80 } }, metadataDelete: ["groupId"] },
        { type: "update_node", id: "c", patch: { position: { x: 415, y: 145 }, width: 160, height: 96 } },
    ]);
    assert.deepEqual(project.nodes, after);
});

test("run_generation 前的提示词更新会持久化到智能节点", () => {
    const project = makeProject([{ id: "config-1", type: "config", title: "智能生成", position: { x: 0, y: 0 }, width: 320, height: 240, metadata: { smart: true, generationMode: "image" } }]);
    applyCanvasProjectOperations(project as Record<string, unknown>, [
        { type: "update_node", id: "config-1", metadata: { composerContent: "新的场景提示词", prompt: "新的场景提示词" } },
        { type: "run_generation", nodeId: "config-1", mode: "image", prompt: "新的场景提示词" },
    ]);
    const metadata = project.nodes[0].metadata as Record<string, unknown>;
    assert.equal(metadata.composerContent, "新的场景提示词");
    assert.equal(metadata.prompt, "新的场景提示词");
});
