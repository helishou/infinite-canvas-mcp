import assert from "node:assert/strict";
import test from "node:test";

import { BackendDatabase } from "../db.js";
import { createStores } from "../stores/index.js";
import { CanvasGenerationService } from "./generation-service.js";

function serviceWith(overrides: { image?: Record<string, unknown>; h3?: Record<string, unknown>; comfy?: Record<string, unknown>; stores?: Record<string, unknown>; video?: Record<string, unknown>; browser?: Record<string, unknown> } = {}) {
    return new CanvasGenerationService(
        (overrides.image || {}) as never,
        (overrides.h3 || {}) as never,
        (overrides.stores || {}) as never,
        {} as never,
        (overrides.comfy || {}) as never,
        {} as never,
        undefined,
        overrides.video as never,
        undefined,
        overrides.browser as never,
    );
}

test("referenceNodeIds 明确选择的智能图片节点不会被图谱解析覆盖", async () => {
    let received: Record<string, unknown> | undefined;
    const service = serviceWith({
        image: { start: (input: Record<string, unknown>) => { received = input; return { taskId: "image-explicit", logId: "log-explicit", executor: "direct-image" }; } },
        stores: {
            projects: {
                get: () => ({
                    id: "project-1",
                    nodes: [
                        { id: "target", type: "config", metadata: { smart: true, generationMode: "image" } },
                        { id: "blocking", type: "config", metadata: { smart: true, generationMode: "image", primaryImageId: "main", images: [{ id: "main", content: "blocking.png", storageKey: "image:blocking" }] } },
                        { id: "continuity", type: "config", metadata: { smart: true, generationMode: "image", primaryImageId: "main", images: [{ id: "main", content: "continuity.png", storageKey: "image:continuity" }] } },
                    ],
                    connections: [{ id: "blocking-target", fromNodeId: "blocking", toNodeId: "target", order: 0 }],
                }),
            },
            tasks: { get: () => null },
        },
    });

    await service.start({
        mode: "image",
        projectId: "project-1",
        nodeId: "target",
        model: "gpt-image-2",
        prompt: "生成分镜",
        referenceNodeIds: ["blocking", "continuity"],
        references: [
            { id: "blocking:image:main", storageKey: "image:blocking" },
            { id: "continuity:image:main", storageKey: "image:continuity" },
        ],
    } as never);

    assert.deepEqual((received?.references as Array<{ storageKey: string }>).map((reference) => reference.storageKey), ["image:blocking", "image:continuity"]);
});
