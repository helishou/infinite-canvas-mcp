import assert from "node:assert/strict";
import test from "node:test";

import { CanvasGenerationService } from "./generation-service.js";

/**
 * 画风接线：出图请求最终落到执行器的那份 prompt 必须带上剧目级画风句子。
 * 这里用桩执行器截获输入，不连接任何模型。
 */
function serviceWithArtStyle(artStyle: string, dramaId = "drama-A") {
    let received: Record<string, unknown> | undefined;
    const task = { id: "image-1", kind: "canvas-image", status: "queued", progress: 0, input: {}, params: {} };
    const db = {
        getDramaIdByCanvasId: (canvasId: string) => (canvasId === "canvas-ep" ? dramaId : ""),
        listCanvasFolders: (id?: string) => (id === dramaId ? [{ id: dramaId, productionPlan: { topic: { artStyle, language: "中文" } } }] : []),
    };
    const stores = {
        tasks: { get: () => task, list: () => [] },
        projects: { get: () => ({ id: "canvas-ep", revision: 0, nodes: [], connections: [] }) },
    };
    const service = new CanvasGenerationService(
        { start: (input: Record<string, unknown>) => { received = input; return { taskId: task.id, executor: "direct-image" }; } } as never,
        {} as never,
        stores as never,
        {} as never,
        {} as never,
        {} as never,
        undefined,
        undefined,
        undefined,
        undefined,
        db as never,
    );
    return { service, prompt: () => String(received?.prompt || "") };
}

test("分集画布出图时，提示词末尾带上剧目画风", async () => {
    const { service, prompt } = serviceWithArtStyle("国风水墨");
    await service.start({ mode: "image", projectId: "canvas-ep", nodeId: "n1", model: "m", prompt: "角色设定三视图｜沈砚", idempotencyKey: "k1" });
    assert.match(prompt(), /角色设定三视图｜沈砚\n全片统一画风：国风水墨/);
});

test("剧目没选画风时提示词一字不改", async () => {
    const { service, prompt } = serviceWithArtStyle("");
    await service.start({ mode: "image", projectId: "canvas-ep", nodeId: "n1", model: "m", prompt: "纯提示词", idempotencyKey: "k2" });
    assert.equal(prompt(), "纯提示词");
});

test("自由画布（没有绑剧目）不加画风", async () => {
    const { service, prompt } = serviceWithArtStyle("国风水墨");
    await service.start({ mode: "image", projectId: "canvas-free", nodeId: "n1", model: "m", prompt: "纯提示词", idempotencyKey: "k3" });
    assert.equal(prompt(), "纯提示词");
});
