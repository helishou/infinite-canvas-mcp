import assert from "node:assert/strict";
import test from "node:test";

import { pluginMcp } from "./mcp.js";
import { aspectRatioOf, matchesAspectRatio, resolveStoryboardGroupSlots } from "./storyboard-slots.js";

function imageNode(id: string, options: { shotNumber?: number; storageKey?: string; width?: number; height?: number; groupId?: string; sourceVideoNodeId?: string; y?: number; x?: number }) {
    return {
        id,
        type: "image",
        title: `镜 ${options.shotNumber ?? id}`,
        position: { x: options.x ?? 0, y: options.y ?? 0 },
        metadata: {
            status: "success",
            storageKey: options.storageKey ?? `image:${id}`,
            naturalWidth: options.width ?? 2944,
            naturalHeight: options.height ?? 1664,
            shotNumber: options.shotNumber,
            ...(options.groupId ? { groupId: options.groupId } : {}),
            ...(options.sourceVideoNodeId ? { sourceVideoNodeId: options.sourceVideoNodeId } : {}),
        },
    };
}

function fixture() {
    const project: any = {
        id: "project-1",
        revision: 5,
        nodes: [
            {
                id: "group-1",
                type: "group",
                title: "H3 Clip 1 · 3 镜首帧",
                position: { x: 0, y: 0 },
                width: 900,
                height: 540,
                metadata: { orderedGroup: true, orderedGroupColumns: 3, groupSlots: [], sourceVideoNodeId: "video-source", shotCount: 3 },
            },
            { id: "video-source", type: "video", title: "母片", position: { x: -400, y: 0 }, metadata: { status: "success" } },
            imageNode("shot-1", { shotNumber: 1, x: 20 }),
            imageNode("shot-2", { shotNumber: 2, x: 220 }),
            imageNode("shot-3", { shotNumber: 3, x: 420 }),
            imageNode("new-horizontal", { storageKey: "image:new-horizontal", x: 0, y: 900 }),
            imageNode("new-vertical", { storageKey: "image:new-vertical", width: 1664, height: 2944, x: 400, y: 900 }),
        ],
        connections: [],
        referenceCatalog: [],
    };
    const calls: any[] = [];
    const backend = {
        backendUrl: "http://backend.test",
        getCanvasProject: async (projectId: string) => projectId === project.id ? project : null,
        applyCanvasOperations: async (_projectId: string, operations: any[], _revision?: number) => {
            calls.push(operations);
            for (const operation of operations) {
                if (operation.type === "update_node") {
                    const node = project.nodes.find((item: any) => item.id === operation.id);
                    node.metadata = { ...node.metadata, ...operation.metadata };
                }
                if (operation.type === "upsert_reference_asset") {
                    const index = project.referenceCatalog.findIndex((item: any) => item.id === operation.asset.id);
                    if (index < 0) project.referenceCatalog.push(operation.asset);
                    else project.referenceCatalog[index] = operation.asset;
                }
            }
            project.revision += 1;
            return { project, revision: project.revision, operationResults: [] };
        },
    };
    const context: any = {
        backend,
        getCanvasProject: async (projectId: string) => projectId === project.id ? project : null,
        getCanvasNode: async (id: string) => project.nodes.find((node: any) => node.id === id) || null,
        getCanvasNodes: async () => project.nodes,
    };
    return { project, calls, handlers: pluginMcp.createHandler(context), handlersAll: pluginMcp.createHandler(context) };
}

test("槽位账本为空时按成员归属重建", () => {
    const { project } = fixture();
    project.nodes[2].metadata.groupId = "group-1";
    project.nodes[3].metadata.groupId = "group-1";
    project.nodes[4].metadata.groupId = "group-1";
    const resolved = resolveStoryboardGroupSlots(project, "group-1");
    assert.equal(resolved.slotSource, "memberGroupId");
    assert.deepEqual(resolved.slots.map((slot) => slot.nodeId), ["shot-1", "shot-2", "shot-3"]);
    assert.ok(resolved.issues.some((issue) => issue.code === "STORYBOARD_SLOTS_REBUILT"));
});

test("槽位账本为空且成员归属串组时按源视频分镜镜头重建", () => {
    const { project } = fixture();
    // 真实画布上的形态：三个镜头图的 groupId 指向另一个组，但源视频与组声明一致。
    for (const node of project.nodes.slice(2)) if (node.type === "image" && node.metadata.shotNumber) node.metadata.groupId = "group-2";
    for (const node of project.nodes) if (node.type === "image" && node.metadata.shotNumber) node.metadata.sourceVideoNodeId = "video-source";
    const resolved = resolveStoryboardGroupSlots(project, "group-1");
    assert.equal(resolved.slotSource, "sourceVideoShots");
    assert.deepEqual(resolved.slots.map((slot) => slot.nodeId), ["shot-1", "shot-2", "shot-3"]);
    assert.deepEqual(resolved.slots.map((slot) => slot.aspectRatio), ["16:9", "16:9", "16:9"]);
});

test("账本与成员归属同时漂移时给出结构化问题而不是静默取空", () => {
    const { project } = fixture();
    project.nodes[0].metadata.groupSlots = ["shot-1", "shot-2", "shot-3", "gone-node"];
    project.nodes[2].metadata.groupId = "group-2";
    project.nodes[3].metadata.sourceVideoNodeId = "video-other";
    project.nodes[0].metadata.shotCount = 6;
    const resolved = resolveStoryboardGroupSlots(project, "group-1");
    assert.equal(resolved.slotSource, "groupSlots");
    assert.equal(resolved.slots.length, 3);
    const codes = resolved.issues.map((issue) => issue.code);
    assert.ok(codes.includes("STORYBOARD_SLOT_NODE_MISSING"));
    assert.ok(codes.includes("STORYBOARD_MEMBER_GROUP_DRIFT"));
    assert.ok(codes.includes("STORYBOARD_SLOT_FOREIGN_SHOT"));
    assert.ok(codes.includes("STORYBOARD_SHOTCOUNT_MISMATCH"));
});

test("装成片的有序组不会因为槽位不是图片而被误报", () => {
    const { project } = fixture();
    project.nodes[0].metadata.groupSlots = ["video-source"];
    const resolved = resolveStoryboardGroupSlots(project, "group-1");
    assert.equal(resolved.slots.length, 1);
    assert.equal(resolved.slots[0].nodeId, "video-source");
    assert.equal(resolved.issues.some((issue) => issue.code === "STORYBOARD_SLOT_NO_IMAGE"), false);
});

test("装成片的有序组不会因为槽位不是图片而被误报", () => {
    const { project } = fixture();
    project.nodes[0].metadata.groupSlots = ["video-source"];
    const resolved = resolveStoryboardGroupSlots(project, "group-1");
    assert.equal(resolved.slots.length, 1);
    assert.equal(resolved.issues.some((issue) => issue.code === "STORYBOARD_SLOT_NO_IMAGE"), false);
});

test("不存在有序组时报明确错误码", () => {
    const { project } = fixture();
    project.nodes[0].metadata.orderedGroup = false;
    assert.throws(() => resolveStoryboardGroupSlots(project, "group-1"), /STORYBOARD_GROUP_NOT_FOUND/);
});

test("画幅判定接受缩放取整误差，拒绝真正不同的画幅", () => {
    assert.equal(aspectRatioOf(2944, 1664), "16:9");
    assert.equal(aspectRatioOf(187, 105.69565217391303), "16:9");
    assert.ok(matchesAspectRatio(2944, 1664, 16 / 9));
    assert.ok(matchesAspectRatio(187, 105.69565217391303, 16 / 9));
    assert.ok(matchesAspectRatio(1664, 2944, 9 / 16));
    assert.ok(!matchesAspectRatio(1000, 1000, 16 / 9));
    assert.ok(!matchesAspectRatio(1664, 2944, 16 / 9));
});

test("替换槽位：省略画幅、当前节点与资产，自动补账本并登记分镜资产", async () => {
    const { project, calls, handlers } = fixture();
    for (const node of project.nodes) if (node.type === "image" && node.metadata.shotNumber) node.metadata.sourceVideoNodeId = "video-source";
    const result: any = await handlers.canvas_replace_storyboard_slots!({
        projectId: "project-1",
        groupId: "group-1",
        slots: [{ slot: 2, nodeId: "new-horizontal" }],
    });
    assert.equal(result.ok, true);
    assert.equal(result.slotSource, "sourceVideoShots");
    assert.equal(result.rebuilt, true);
    const groupOps = calls[0];
    assert.equal(groupOps[0].type, "update_node");
    assert.deepEqual(groupOps[0].metadata.groupSlots, ["shot-1", "new-horizontal", "shot-3"]);
    assert.equal(groupOps.some((operation: any) => operation.type === "upsert_reference_asset"), true);
    const asset = project.referenceCatalog[0];
    assert.equal(asset.role, "storyboard");
    assert.equal(asset.sourceNodeId, "new-horizontal");
    assert.equal(asset.storageKey, "image:new-horizontal");
    assert.deepEqual(result.slots[0].assetIds, [asset.id]);
    // 账本写回后再读一次，槽位来源应回到 groupSlots。
    assert.equal(resolveStoryboardGroupSlots(project, "group-1").slotSource, "groupSlots");
});

test("替换槽位：dryRun 只预检，画幅不符给出槽位与目标画幅", async () => {
    const { project, calls, handlers } = fixture();
    for (const node of project.nodes) if (node.type === "image" && node.metadata.shotNumber) node.metadata.sourceVideoNodeId = "video-source";
    const preview: any = await handlers.canvas_replace_storyboard_slots!({
        projectId: "project-1",
        groupId: "group-1",
        dryRun: true,
        slots: [{ slot: 1, nodeId: "new-vertical" }],
    });
    assert.equal(preview.dryRun, true);
    assert.equal(preview.applied, false);
    assert.equal(preview.ready, false);
    assert.equal(preview.blocked[0].code, "STORYBOARD_ASPECT_MISMATCH");
    assert.match(preview.blocked[0].message, /1664×2944/);
    assert.equal(preview.targetAspectRatio, "16:9");
    assert.equal(project.revision, 5);
    assert.equal(calls.length, 0);
    // 真正写入时才在第一个错误上停下。
    await assert.rejects(
        handlers.canvas_replace_storyboard_slots!({ projectId: "project-1", groupId: "group-1", slots: [{ slot: 1, nodeId: "new-vertical" }] }),
        /STORYBOARD_ASPECT_MISMATCH/,
    );
    const vertical: any = await handlers.canvas_replace_storyboard_slots!({
        projectId: "project-1",
        groupId: "group-1",
        expectedAspectRatio: "9:16",
        slots: [{ slot: 1, nodeId: "new-vertical" }],
    });
    assert.equal(vertical.ok, true);
    assert.equal(vertical.targetAspectRatio, "9:16");
});

test("替换槽位：显式 assetIds 职责不是 storyboard 时拒绝", async () => {
    const { project, handlers } = fixture();
    for (const node of project.nodes) if (node.type === "image" && node.metadata.shotNumber) node.metadata.sourceVideoNodeId = "video-source";
    project.referenceCatalog = [{ id: "scene-asset", label: "卧房", role: "scene", mediaType: "image", tags: [], storageKey: "image:new-horizontal", sourceNodeId: "new-horizontal" }];
    await assert.rejects(
        handlers.canvas_replace_storyboard_slots!({ projectId: "project-1", groupId: "group-1", slots: [{ slot: 1, nodeId: "new-horizontal", assetIds: ["scene-asset"] }] }),
        /STORYBOARD_ASSET_ROLE/,
    );
});

test("读取槽位：省略 groupId 时只列摘要，给定 groupId 时返回逐槽位明细", async () => {
    const { project, handlers } = fixture();
    for (const node of project.nodes) if (node.type === "image" && node.metadata.shotNumber) node.metadata.sourceVideoNodeId = "video-source";
    const index: any = await handlers.canvas_get_storyboard_slots!({ projectId: "project-1" });
    assert.equal(index.groupCount, 1);
    assert.equal(index.groups[0].groupId, "group-1");
    assert.equal(index.groups[0].slotCount, 3);
    assert.equal("slots" in index.groups[0], false);
    const detail: any = await handlers.canvas_get_storyboard_slots!({ projectId: "project-1", groupId: "group-1" });
    assert.equal(detail.slots.length, 3);
    assert.deepEqual(Object.keys(detail.slots[0]).sort(), ["assetIds", "aspectRatio", "height", "mimeType", "nodeId", "shotNumber", "slot", "status", "storageKey", "title", "url", "width"].sort());
    assert.equal(detail.slots[0].storageKey, "image:shot-1");
});

test("工具目录包含槽位读取，替换工具不再强制画幅与资产", () => {
    const readTool = pluginMcp.tools.find((tool) => tool.id === "canvas_get_storyboard_slots")!;
    assert.equal(readTool.annotations?.readOnlyHint, true);
    const replaceTool = pluginMcp.tools.find((tool) => tool.id === "canvas_replace_storyboard_slots")!;
    const schema: any = replaceTool.inputJsonSchema;
    assert.deepEqual(schema.required, ["projectId", "groupId", "slots"]);
    assert.deepEqual(schema.properties.slots.items.required, ["slot", "nodeId"]);
    assert.ok(schema.properties.dryRun);
    const bindingTool = pluginMcp.tools.find((tool) => tool.id === "h3_replace_storyboard_binding")!;
    assert.equal((bindingTool.inputJsonSchema as any).required.includes("expectedStorageKey"), false);
});
