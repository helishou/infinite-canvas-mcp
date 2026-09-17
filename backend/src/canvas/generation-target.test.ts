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
