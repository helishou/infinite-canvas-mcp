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

test("智能循环保留本轮显式参考，不回退到源节点的旧输出", async () => {
    let received: Record<string, unknown> | undefined;
    const service = serviceWith({
        image: { start: (input: Record<string, unknown>) => { received = input; return { taskId: "loop-task", executor: "direct-image" }; } },
        stores: {
            projects: { get: () => ({ id: "p", nodes: [
                { id: "loop", type: "loop", metadata: {} },
                { id: "old", type: "image", metadata: { content: "old.png", storageKey: "image:old" } },
                { id: "target", type: "config", metadata: { smart: true, generationMode: "image" } },
            ], connections: [{ id: "old-target", fromNodeId: "old", toNodeId: "target" }, { id: "loop-target", fromNodeId: "loop", toNodeId: "target" }] }) },
            tasks: { get: () => null },
        },
    });
    await service.start({ mode: "image", projectId: "p", nodeId: "target", model: "gpt-image-2", prompt: "本轮",
        references: [{ storageKey: "image:new" }], loopOutput: { loopNodeId: "loop", roundIndex: 2, slotIndex: 1 } });
    assert.deepEqual((received?.references as Array<{ storageKey: string }>).map((item) => item.storageKey), ["image:new"]);
});
