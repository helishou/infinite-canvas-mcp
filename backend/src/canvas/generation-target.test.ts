import assert from "node:assert/strict";
import test from "node:test";

import { BackendDatabase } from "../db.js";
import { createStores } from "../stores/index.js";
import { prepareCanvasGenerationTarget, prepareCanvasLoopRun } from "./generation-target.js";

test("循环运行把旧链式节点改造成单个有序输出组并为四种模式分配稳定槽位", (t) => {
    const db = new BackendDatabase(":memory:");
    t.after(() => db.close());
    db.createCanvasProject({ id: "loop-project", nodes: [
        { id: "loop", type: "loop", title: "循环", position: { x: 0, y: 0 }, width: 380, height: 320,
            metadata: { generationMode: "image", model: "loop-model", prompt: "逐轮生成", loopStart: 1 } },
        { id: "out-a", type: "image", title: "A", position: { x: 500, y: 0 }, width: 340, height: 240,
            metadata: { content: "old-a.png", storageKey: "media:old-a", model: "old-model" } },
        { id: "out-b", type: "video", title: "B", position: { x: 900, y: 0 }, width: 340, height: 240,
            metadata: { content: "old-b.mp4", storageKey: "media:old-b", model: "old-model" } },
    ], connections: [
        { id: "loop-a", fromNodeId: "loop", toNodeId: "out-a" },
        { id: "a-b", fromNodeId: "out-a", toNodeId: "out-b" },
    ] });
    const stores = createStores(db);
    const input = { projectId: "loop-project", loopNodeId: "loop", runId: "run-1", mode: "image" as const, totalRounds: 3, roundInputNodeIds: [[], [], []] as string[][] };
    const prepared = prepareCanvasLoopRun(stores, input);
    assert.equal(prepared.outputGroupId, "loop-output-group-loop");
    assert.equal(prepared.slotNodeIds.length, 3);
    assert.deepEqual(prepared.slotNodeIds.slice(0, 2), ["out-a", "out-b"]);
    const project = stores.projects.get("loop-project")!;
    const group = (project.nodes as Array<Record<string, any>>).find((node) => node.id === prepared.outputGroupId)!;
    assert.deepEqual(group.metadata.groupSlots, prepared.slotNodeIds);
    assert.equal(group.metadata.orderedGroup, true);
    const outputs = (project.nodes as Array<Record<string, any>>).filter((node) => prepared.slotNodeIds.includes(String(node.id)));
    assert.ok(outputs.every((node) => node.type === "config" && node.metadata.smart && node.metadata.groupId === prepared.outputGroupId));
    assert.equal(outputs[0].metadata.model, "loop-model");
    assert.equal(outputs[0].metadata.loopOutputHistory[0].storageKey, "media:old-a");
    assert.deepEqual((project.connections as Array<Record<string, any>>).filter((edge) => edge.fromNodeId === "loop").map((edge) => edge.toNodeId), [prepared.outputGroupId]);
    assert.equal((project.connections as Array<Record<string, any>>).some((edge) => edge.id === "a-b"), false, "旧 A→B 生成链不能继续执行或显示");
    assert.deepEqual(prepareCanvasLoopRun(stores, input), prepared, "重复准备返回同一组和槽 ID");

    for (const [index, mode] of (["image", "video", "audio", "text"] as const).entries()) {
        const nextRun = { ...input, runId: `run-${mode}`, mode };
        const next = prepareCanvasLoopRun(stores, nextRun);
        const slotIndex = index % input.totalRounds;
        const target = prepareCanvasGenerationTarget(stores, {
            mode, projectId: input.projectId, nodeId: next.slotNodeIds[slotIndex], model: "loop-model", prompt: "本轮输入",
            loopOutput: { loopNodeId: "loop", roundIndex: slotIndex + 1, slotIndex, totalRounds: 3,
                slotNodeId: next.slotNodeIds[slotIndex], outputGroupId: next.outputGroupId },
        }, `task-${mode}`);
        assert.equal(target.command.nodeId, next.slotNodeIds[slotIndex]);
        assert.equal((target.createOperations[0] as any).id, next.slotNodeIds[slotIndex]);
    }
    const shortened = prepareCanvasLoopRun(stores, { ...input, runId: "run-short", mode: "text", totalRounds: 2, roundInputNodeIds: [[], []] });
    assert.deepEqual(shortened.slotNodeIds, prepared.slotNodeIds.slice(0, 2));
    const expanded = prepareCanvasLoopRun(stores, { ...input, runId: "run-expanded", mode: "text", totalRounds: 3 });
    assert.deepEqual(expanded.slotNodeIds, prepared.slotNodeIds, "缩短后扩容应重用保留的旧槽，不另造重复结果节点");
});

test("循环输出有序组自动对齐 8 轮和 0、2、8 个既有输出", (t) => {
    for (const existingCount of [0, 2, 8]) {
        const db = new BackendDatabase(":memory:");
        t.after(() => db.close());
        const outputNodes = Array.from({ length: existingCount }, (_, index) => ({ id: `output-${index + 1}`, type: "image", title: `旧输出 ${index + 1}`,
            position: { x: 500 + index * 20, y: 0 }, width: 340, height: 240, metadata: { content: `old-${index + 1}.png`, storageKey: `media:old-${index + 1}` } }));
        db.createCanvasProject({ id: "p", nodes: [{ id: "loop", type: "loop", position: { x: 0, y: 0 }, width: 380, height: 320, metadata: { model: "model", prompt: "prompt" } }, ...outputNodes],
            connections: outputNodes.map((node) => ({ id: `loop-${node.id}`, fromNodeId: "loop", toNodeId: node.id })) });
        const stores = createStores(db);
        const prepared = prepareCanvasLoopRun(stores, { projectId: "p", loopNodeId: "loop", runId: `run-${existingCount}`, mode: "text", totalRounds: 8, roundInputNodeIds: Array.from({ length: 8 }, () => []) });
        assert.equal(prepared.slotNodeIds.length, 8);
        assert.deepEqual(prepared.slotNodeIds.slice(0, existingCount), outputNodes.map((node) => node.id));
        const project = stores.projects.get("p")!;
        const groups = (project.nodes as Array<Record<string, any>>).filter((node) => node.type === "group" && node.metadata.loopOutputGroup === true);
        assert.equal(groups.length, 1);
        assert.deepEqual(groups[0].metadata.groupSlots, prepared.slotNodeIds);
    }
});

test("循环准备将每轮输入图连接到对应结果槽，重排时只替换自身管理的参考线", (t) => {
    const db = new BackendDatabase(":memory:");
    t.after(() => db.close());
    const inputs = [1, 2, 3].map((index) => ({ id: `input-${index}`, type: "image", title: `输入 ${index}`,
        position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { groupId: "input-group", content: `image-${index}.png` } }));
    db.createCanvasProject({ id: "p", nodes: [
        { id: "input-group", type: "group", position: { x: 0, y: 0 }, width: 400, height: 300,
            metadata: { orderedGroup: true, groupSlots: inputs.map((item) => item.id) } },
        ...inputs,
        { id: "loop", type: "loop", position: { x: 500, y: 0 }, width: 380, height: 320, metadata: { model: "model" } },
        { id: "old-output", type: "image", position: { x: 1000, y: 0 }, width: 340, height: 240, metadata: { content: "old.png" } },
    ], connections: [
        { id: "input-loop", fromNodeId: "input-group", toNodeId: "loop" },
        { id: "loop-old", fromNodeId: "loop", toNodeId: "old-output" },
    ] });
    const stores = createStores(db);
    const first = { projectId: "p", loopNodeId: "loop", runId: "first", mode: "image" as const,
        totalRounds: 3, roundInputNodeIds: [["input-1"], ["input-2"], ["input-3"]] };
    const prepared = prepareCanvasLoopRun(stores, first);
    const links = () => (stores.projects.get("p")!.connections as Array<Record<string, any>>)
        .filter((edge) => edge.role === "loop-input-reference")
        .map((edge) => [edge.fromNodeId, edge.toNodeId]);
    assert.deepEqual(links(), inputs.map((item, index) => [item.id, prepared.slotNodeIds[index]]));
    assert.deepEqual(prepareCanvasLoopRun(stores, first), prepared);
    assert.equal(links().length, 3, "重复准备不添加参考线");
    assert.throws(() => prepareCanvasLoopRun(stores, { ...first, roundInputNodeIds: [["input-2"], ["input-1"], ["input-3"]] }), /不同的轮次计划/);
    assert.throws(() => prepareCanvasLoopRun(stores, { ...first, runId: "bad", roundInputNodeIds: [["outside"], [], []] }), /不属于循环左侧/);
    assert.deepEqual(links(), inputs.map((item, index) => [item.id, prepared.slotNodeIds[index]]), "非法请求不改画布");

    const second = prepareCanvasLoopRun(stores, { ...first, runId: "second", totalRounds: 1,
        roundInputNodeIds: [["input-2", "input-3"]] });
    assert.deepEqual(links(), [["input-2", second.slotNodeIds[0]], ["input-3", second.slotNodeIds[0]]]);
    assert.equal((stores.projects.get("p")!.nodes as Array<Record<string, any>>).find((node) => node.id === "old-output")?.metadata.content, "old.png");
});

test("网页、MCP 与浏览器执行器共用 Backend 媒体结果节点布局", (t) => {
    const db = new BackendDatabase(":memory:");
    t.after(() => db.close());
    db.createCanvasProject({
        id: "p",
        nodes: [
            { id: "source", type: "config", title: "生成", position: { x: 100, y: 50 }, width: 320, height: 220, metadata: {} },
            { id: "occupied", type: "image", position: { x: 516, y: 50 }, width: 340, height: 240, metadata: {} },
        ],
        connections: [],
    });
    const stores = createStores(db);
    const image = prepareCanvasGenerationTarget(stores, {
        mode: "image", projectId: "p", nodeId: "source", model: "gpt-image-2", prompt: "测试", count: 2,
    }, "same-task");
    assert.equal(image.command.nodeId, "image-same-task");
    assert.equal(image.command.sourceNodeId, "source");
    assert.equal(image.command.imageIds?.length, 2);
    assert.deepEqual((image.createOperations[0] as any).position, { x: 516, y: 386 });
    assert.deepEqual(image.createOperations.map((operation) => operation.type), ["add_node", "connect_nodes"]);

    const video = prepareCanvasGenerationTarget(stores, {
        mode: "video", projectId: "p", nodeId: "source", model: "video-model", prompt: "测试",
    }, "same-task");
    assert.equal(video.command.nodeId, "video-same-task");
    assert.deepEqual((video.createOperations[0] as any).position, { x: 516, y: 336 });
});

test("图片槽重试和插件原位写回不会新建结果节点", (t) => {
    const db = new BackendDatabase(":memory:");
    t.after(() => db.close());
    db.createCanvasProject({ id: "p", nodes: [{ id: "image", type: "image", width: 400, height: 300,
        metadata: { content: "old.png", images: [{ id: "slot", status: "success", content: "old.png" }] } }], connections: [] });
    const stores = createStores(db);
    const retry = prepareCanvasGenerationTarget(stores, {
        mode: "image", projectId: "p", nodeId: "image", model: "gpt-image-2", prompt: "重试", count: 1, imageIds: ["slot"],
    }, "retry");
    assert.equal(retry.command.nodeId, "image");
    assert.deepEqual(retry.createOperations, []);
    const plugin = prepareCanvasGenerationTarget(stores, {
        mode: "image", projectId: "p", nodeId: "image", model: "gpt-image-2", prompt: "改图", params: { writeBackToTarget: true },
    }, "plugin");
    assert.equal(plugin.command.nodeId, "image");
    assert.deepEqual(plugin.createOperations, []);
});

test("智能生成节点把图片结果槽直接绑定到自身", (t) => {
    const db = new BackendDatabase(":memory:");
    t.after(() => db.close());
    db.createCanvasProject({ id: "p", nodes: [
        { id: "smart", type: "config", width: 420, height: 540,
            metadata: { smart: true, generationMode: "image", composerContent: "一只猫", generatedResultIds: ["legacy-image"], primaryImageId: "legacy-image" } },
        { id: "legacy-image", type: "image", width: 340, height: 240, metadata: { content: "legacy.png" } },
    ], connections: [{ id: "legacy-connection", fromNodeId: "smart", toNodeId: "legacy-image" }] });
    const stores = createStores(db);
    const prepared = prepareCanvasGenerationTarget(stores, {
        mode: "image", projectId: "p", nodeId: "smart", model: "gpt-image-2", prompt: "一只猫", count: 2,
    }, "smart-task");
    assert.equal(prepared.command.nodeId, "smart");
    assert.equal(prepared.command.sourceNodeId, undefined);
    assert.equal(prepared.command.imageIds?.length, 2);
    assert.deepEqual(prepared.createOperations.map((operation) => operation.type), ["delete_node", "update_node"]);
    assert.deepEqual((prepared.createOperations[1] as any).metadataDelete, ["generatedResultIds", "generatedTextResultIds", "primaryTextNodeId"]);
});

// 循环输出现在是一个有序组 + 组内智能槽（不再是每轮一个游离的独立节点）。
// 组在首次运行时一次建好，之后每轮只更新自己那一槽。
test("智能循环建有序组与预建槽，重跑复用同一槽并保留旧结果", (t) => {
    const db = new BackendDatabase(":memory:");
    t.after(() => db.close());
    db.createCanvasProject({ id: "p", nodes: [
        { id: "loop", type: "loop", position: { x: 0, y: 0 }, width: 380, height: 320, metadata: {} },
        { id: "smart", type: "config", position: { x: 480, y: 0 }, width: 420, height: 540, metadata: { smart: true, generationMode: "image", prompt: "原提示词", model: "gpt-image-2" } },
    ], connections: [{ id: "loop-smart", fromNodeId: "loop", toNodeId: "smart" }] });
    const stores = createStores(db);
    const command = { mode: "image" as const, projectId: "p", nodeId: "smart", model: "gpt-image-2", prompt: "第一轮", count: 1,
        loopOutput: { loopNodeId: "loop", roundIndex: 1, slotIndex: 0, totalRounds: 1 } };
    const first = prepareCanvasGenerationTarget(stores, command, "task-one");
    const firstAdds = first.createOperations.filter((operation: any) => operation.type === "add_node") as any[];
    const firstGroup = firstAdds.find((operation) => operation.nodeType === "group");
    const firstSlots = firstAdds.filter((operation) => operation.nodeType === "config");
    assert.ok(firstGroup, "首次运行应建有序组");
    assert.equal(firstGroup.metadata.orderedGroup, true, "组必须是有序组");
    assert.equal(firstSlots.length, 1, "loopCount 缺省时只建 1 个槽");
    assert.equal(first.command.sourceNodeId, "smart");
    assert.equal(first.command.nodeId, firstSlots[0].id, "结果写进组内槽");
    assert.equal(firstSlots[0].metadata.smart, true);
    assert.equal(firstSlots[0].metadata.model, "gpt-image-2", "槽配置继承生成源节点");
    const firstSlotId = first.command.nodeId;
    const firstSlotImage = (first.createOperations.find((operation: any) => operation.type === "update_node") as any)?.metadata?.images?.[0]?.id
        || firstSlots[0].metadata?.images?.[0]?.id;
    stores.projects.applyOperations("p", Number(stores.projects.get("p")!.revision || 0), first.createOperations, { runtimeWrite: true });
    const otherRound = prepareCanvasGenerationTarget(stores, { ...command, prompt: "第二轮", loopOutput: { loopNodeId: "loop", roundIndex: 2, slotIndex: 1 } }, "task-two");
    assert.notEqual(otherRound.command.nodeId, firstSlotId, "第 2 轮应写进另一个槽");
    stores.projects.applyOperations("p", Number(stores.projects.get("p")!.revision || 0), otherRound.createOperations, { runtimeWrite: true });
    const rerun = prepareCanvasGenerationTarget(stores, command, "task-three");
    assert.equal(rerun.command.nodeId, firstSlotId, "重跑同一轮复用同一个槽");
    assert.deepEqual(rerun.createOperations.map((operation) => operation.type), ["update_node"]);
    const rerunMetadata = (rerun.createOperations[0] as any).metadata;
    assert.equal(rerunMetadata.images.length, 2, "重跑保留旧结果槽");
    assert.notEqual(rerun.command.imageIds?.[0], firstSlotImage);
});

test("循环输出槽拒绝未连接的循环节点", (t) => {
    const db = new BackendDatabase(":memory:");
    t.after(() => db.close());
    db.createCanvasProject({ id: "p", nodes: [
        { id: "loop", type: "loop", metadata: {} },
        { id: "smart", type: "config", metadata: { smart: true, generationMode: "image" } },
    ], connections: [] });
    assert.throws(() => prepareCanvasGenerationTarget(createStores(db), {
        mode: "image", projectId: "p", nodeId: "smart", model: "gpt-image-2", prompt: "失败",
        loopOutput: { loopNodeId: "loop", roundIndex: 1, slotIndex: 0 },
    }, "task"), /未连接/);
});

// 循环节点自己就是智能生成节点：生成源就是循环节点本身，没有「循环 → 生成节点」连线。
// 曾经的 bug：resolveLoopOutputSlot 无条件要求 isDownstreamOf(loop, source)，
// 循环节点当源时该检查永远为假，直接抛「循环节点未连接到本次生成节点」。
test("循环节点自己当生成源时不需要存在循环到自身的连线", (t) => {
    const db = new BackendDatabase(":memory:");
    t.after(() => db.close());
    db.createCanvasProject({ id: "p", nodes: [
        { id: "loop", type: "loop", position: { x: 0, y: 0 }, width: 380, height: 320, metadata: { generationMode: "image", loopCount: 3, model: "seedream-4" } },
    ], connections: [] });
    const stores = createStores(db);
    const first = prepareCanvasGenerationTarget(stores, {
        mode: "image", projectId: "p", nodeId: "loop", model: "seedream-4", prompt: "第一轮", count: 1,
        loopOutput: { loopNodeId: "loop", roundIndex: 1, slotIndex: 0, totalRounds: 3 },
    }, "task-one");
    // 首次运行要建「一个组 + 3 个槽」，本轮写入第 1 个槽。
    const addNodes = first.createOperations.filter((operation: any) => operation.type === "add_node") as any[];
    const groups = addNodes.filter((operation) => operation.nodeType === "group");
    const slots = addNodes.filter((operation) => operation.nodeType === "config");
    assert.equal(groups.length, 1, "首次运行应建一个有序组");
    assert.equal(slots.length, 3, "应按 loopCount 预建 3 个槽");
    assert.deepEqual(groups[0].metadata.groupSlots, [1, 2, 3].map((index) => `${groups[0].id}-slot-${index}`));
    assert.equal(slots[0].metadata.smart, true, "槽必须是智能生成节点");
    assert.equal(slots[0].metadata.model, "seedream-4", "槽配置继承循环节点");
    assert.equal(slots[0].metadata.groupId, groups[0].id, "槽必须指向所属组");
    assert.equal(first.command.nodeId, slots[0].id, "本轮结果写进第 1 个槽");

    // 落库后跑第 2 轮：必须复用同一个组，只更新对应槽，不能再建一个组。
    stores.projects.applyOperations("p", Number(stores.projects.get("p")!.revision || 0), first.createOperations, { runtimeWrite: true });
    const second = prepareCanvasGenerationTarget(stores, {
        mode: "image", projectId: "p", nodeId: "loop", model: "seedream-4", prompt: "第二轮", count: 1,
        loopOutput: { loopNodeId: "loop", roundIndex: 2, slotIndex: 1, totalRounds: 3 },
    }, "task-two");
    assert.deepEqual(second.createOperations.map((operation: any) => operation.type), ["update_node"], "已有组时只更新本轮槽");
    assert.equal(second.command.nodeId, `${groups[0].id}-slot-2`, "第 2 轮写进第 2 个槽");
});

// auto 模式下真实轮次由上游素材数算出，和用户设置的 loopCount（默认 1）无关。
// Backend 曾经只读 loopCount，导致 2 张组图只建出 1 个槽，第二轮的结果被塞进同一个节点。
test("组已建但槽数不足时补建缺失槽并同步 groupSlots", (t) => {
    const db = new BackendDatabase(":memory:");
    t.after(() => db.close());
    // loopCount 故意留 1（默认），模拟 auto 模式下真实轮次是 2 的情况。
    db.createCanvasProject({ id: "p", nodes: [
        { id: "loop", type: "loop", position: { x: 0, y: 0 }, width: 380, height: 320, metadata: { generationMode: "image", loopCountMode: "auto", model: "seedream-4" } },
        // 上一轮已经建好了组，但只建了 1 个槽。
        { id: "g1", type: "group", position: { x: 500, y: 0 }, width: 372, height: 272, metadata: { orderedGroup: true, groupSlots: ["g1-slot-1"], loopOutputSlot: true, loopSourceId: "loop", loopRootId: "loop" } },
        { id: "g1-slot-1", type: "config", position: { x: 516, y: 16 }, width: 340, height: 240, metadata: { smart: true, groupId: "g1", loopOutputSlot: true, loopSourceId: "loop", loopRootId: "loop", loopRoundIndex: 1, loopSlotIndex: 0 } },
    ], connections: [] });
    const stores = createStores(db);
    // 这次前端告知真实总轮次是 2。
    const prepared = prepareCanvasGenerationTarget(stores, {
        mode: "image", projectId: "p", nodeId: "loop", model: "seedream-4", prompt: "第二轮", count: 1,
        loopOutput: { loopNodeId: "loop", roundIndex: 2, slotIndex: 1, totalRounds: 2 },
    }, "task-two");
    const added = prepared.createOperations.filter((operation: any) => operation.type === "add_node") as any[];
    assert.equal(added.length, 1, "应补建 1 个槽");
    assert.equal(added[0].id, "g1-slot-2");
    assert.equal(added[0].metadata.loopRoundIndex, 2, "补建槽要带上正确的轮次");
    assert.equal(added[0].metadata.groupId, "g1");
    const groupSync = prepared.createOperations.find((operation: any) => operation.type === "update_node" && operation.id === "g1") as any;
    assert.ok(groupSync, "必须同步 groupSlots");
    assert.deepEqual(groupSync.metadata.groupSlots, ["g1-slot-1", "g1-slot-2"]);
    assert.equal(prepared.command.nodeId, "g1-slot-2", "第 2 轮写进补建的槽");
});

test("智能节点重生成不写入位置或尺寸布局", (t) => {
    const db = new BackendDatabase(":memory:");
    t.after(() => db.close());
    const position = { x: 7696.817739973209, y: -128.17954001649002 };
    const size = { width: 140.69976076555025, height: 211.04964114832538 };
    db.createCanvasProject({ id: "p", nodes: [{ id: "smart", type: "config", position, ...size,
        metadata: { smart: true, generationMode: "image", runtimeTaskId: "task-1", images: [{ id: "slot", status: "idle" }] } }], connections: [] });
    const task = { id: "task-1", status: "succeeded", progress: 1, input: {}, params: { imageTargetSize: size }, result: null,
        error: null, createdAt: "", updatedAt: "", outputs: [] } as any;
    const written = db.writeBackCanvasImageTask(task, { projectId: "p", nodeId: "smart", prompt: "重生成", model: "gpt-image-2", imageIds: ["slot"] },
        [{ url: "image.png", storageKey: "image:generated", mimeType: "image/png", width: 1024, height: 1536, bytes: 1 }]);
    assert.ok(written);
    const node = (written as any).project.nodes.find((item: any) => item.id === "smart") as any;
    assert.deepEqual(node.position, position);
    assert.deepEqual({ width: node.width, height: node.height }, size);
    const update = written!.operations.find((operation: any) => operation.type === "update_node" && operation.id === "smart") as any;
    assert.ok(update);
    assert.equal(update.patch?.position, undefined);
    assert.equal(update.patch?.width, undefined);
    assert.equal(update.patch?.height, undefined);
});

test("智能生成节点切换到音频、视频或文本时仍复用自身，不创建输出节点", (t) => {
    const db = new BackendDatabase(":memory:");
    t.after(() => db.close());
    db.createCanvasProject({ id: "p", nodes: [
        { id: "smart", type: "config", width: 420, height: 540, metadata: { smart: true, generationMode: "image", generatedTextResultIds: ["legacy-text"] } },
        { id: "legacy-text", type: "text", width: 340, height: 240, metadata: { content: "旧结果" } },
    ], connections: [{ id: "legacy-text-connection", fromNodeId: "smart", toNodeId: "legacy-text" }] });
    const stores = createStores(db);
    for (const mode of ["video", "audio", "text"] as const) {
        const prepared = prepareCanvasGenerationTarget(stores, {
            mode, projectId: "p", nodeId: "smart", model: `${mode}-model`, prompt: "测试",
        }, `${mode}-task`);
        assert.equal(prepared.command.nodeId, "smart");
        assert.deepEqual(prepared.createOperations.map((operation) => operation.type), ["delete_node", "update_node"]);
        assert.equal((prepared.createOperations[1] as any).id, "smart");
        assert.equal((prepared.createOperations[1] as any).metadata.generationMode, mode);
    }
});
