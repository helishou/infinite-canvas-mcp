import assert from "node:assert/strict";
import test from "node:test";

import { BackendDatabase } from "../db.js";
import { createStores } from "../stores/index.js";
import { prepareCanvasGenerationTarget } from "./generation-target.js";

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
