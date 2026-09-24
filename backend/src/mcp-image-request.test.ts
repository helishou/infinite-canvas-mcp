import assert from "node:assert/strict";
import test from "node:test";

import { buildCanvasImageRequest } from "./mcp.js";

test("图片模式智能节点按所选类型解析为真实图片参考，而不是被当作 config 跳过", () => {
    const project = {
        id: "project-1",
        nodes: [
            {
                id: "target",
                type: "config",
                metadata: { smart: true, generationMode: "image", composerContent: "生成分镜" },
            },
            {
                id: "blocking",
                type: "config",
                title: "站位图智能节点",
                metadata: {
                    smart: true,
                    generationMode: "image",
                    primaryImageId: "blocking-main",
                    images: [{ id: "blocking-main", content: "blocking.png", storageKey: "image:blocking", mimeType: "image/png" }],
                },
            },
            {
                id: "continuity",
                type: "config",
                title: "上一镜智能节点",
                metadata: {
                    smart: true,
                    generationMode: "image",
                    primaryImageId: "continuity-main",
                    images: [{ id: "continuity-main", content: "continuity.png", storageKey: "image:continuity", mimeType: "image/png" }],
                },
            },
        ],
        connections: [],
    };

    const request = buildCanvasImageRequest(
        project.nodes[0] as Record<string, unknown>,
        project,
        { prompt: "生成分镜", referenceNodeIds: ["blocking", "continuity"] },
        "gpt-image-2",
    );

    assert.deepEqual(request.references?.map((reference) => reference.storageKey), ["image:blocking", "image:continuity"]);
});
