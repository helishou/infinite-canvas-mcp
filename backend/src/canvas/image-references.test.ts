import assert from "node:assert/strict";
import test from "node:test";

import { resolveCanvasImageReferences } from "./image-references.js";

const image = (id: string, title: string) => ({ id, type: "image", title, metadata: { storageKey: `image:${id}`, mimeType: "image/png" } });

test("图片生成从结果节点沿配置节点回溯全部参考图并保留顺序", () => {
    const project = {
        id: "project-1",
        nodes: [
            { id: "config", type: "config" },
            { id: "result", type: "image", metadata: { storageKey: "image:result" } },
            image("scene", "场景"), image("shen", "沈昭"), image("su", "苏晚"), image("blocking", "站位图"),
        ],
        connections: [
            { id: "config-result", fromNodeId: "config", toNodeId: "result" },
            { id: "scene-config", fromNodeId: "scene", toNodeId: "config", role: "reference", order: 0 },
            { id: "shen-config", fromNodeId: "shen", toNodeId: "config", role: "reference", order: 1 },
            { id: "su-config", fromNodeId: "su", toNodeId: "config", role: "reference", order: 2 },
            { id: "blocking-config", fromNodeId: "blocking", toNodeId: "config", role: "reference", order: 3 },
        ],
    };

    assert.deepEqual(resolveCanvasImageReferences(project, "result")?.map((reference) => reference.id), ["result", "scene", "shen", "su", "blocking"]);
});

test("配置节点没有媒体入边时解析为空数组而不是丢失生成命令", () => {
    const project = { id: "project-1", nodes: [{ id: "config", type: "config" }], connections: [] };
    assert.deepEqual(resolveCanvasImageReferences(project, "config"), []);
});
