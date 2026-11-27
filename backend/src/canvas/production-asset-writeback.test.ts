import assert from "node:assert/strict";
import test from "node:test";
import { CanvasImageDispatcher } from "./image-dispatcher.js";

function hooksFor(written: unknown) {
    const calls: Array<Record<string, unknown>> = [];
    let shouldThrow = false;
    const stores = {
        projects: {
            writeBackCanvasImageTask: () => written,
            syncProductionAssetImageWriteBack: (input: Record<string, unknown>) => {
                calls.push(input);
                if (shouldThrow) throw new Error("制作稿写回暂时不可用");
                return { ok: true, scope: "episode", assetId: "asset-scene", storageKey: "image:gen" };
            },
        },
    } as any;
    const dispatcher = new CanvasImageDispatcher({} as any, stores, {} as any, {} as any);
    const hooks = (dispatcher as any).canvasHooks({ projectId: "canvas-1", nodeId: "entity-scene", model: "m", prompt: "p" });
    return { hooks, calls, failNext: () => { shouldThrow = true; } };
}

test("图片任务完成并在画布落盘后，按实体节点触发制作台回写", async () => {
    const { hooks, calls } = hooksFor({
        project: { nodes: [{ id: "entity-scene", metadata: { storageKey: "image:gen" } }], revision: 2 },
        operations: [],
    });
    await hooks.onCompleted({ media: [{ storageKey: "image:gen" }] }, { id: "task-1" });
    assert.deepEqual(calls, [{ projectId: "canvas-1", nodeId: "entity-scene", storageKey: "image:gen", taskId: "task-1" }]);
});

test("画布未回写生成结果时不触发制作台回写", async () => {
    const { hooks, calls } = hooksFor(null);
    await hooks.onCompleted({ media: [{ storageKey: "image:gen" }] }, { id: "task-2" });
    assert.deepEqual(calls, []);
});

test("制作台回写失败不改变生成任务已完成的事实", async () => {
    const { hooks, calls, failNext } = hooksFor({
        project: { nodes: [{ id: "entity-scene", metadata: { storageKey: "image:gen" } }], revision: 2 },
        operations: [],
    });
    failNext();
    await assert.doesNotReject(() => hooks.onCompleted({ media: [{ storageKey: "image:gen" }] }, { id: "task-3" }));
    assert.equal(calls.length, 1);
});
