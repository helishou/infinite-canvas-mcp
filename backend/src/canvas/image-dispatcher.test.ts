import assert from "node:assert/strict";
import test from "node:test";

import { CanvasImageDispatcher, type CanvasImageReference } from "./image-dispatcher.js";

function task(id: string, input: Record<string, unknown>, status: "queued" | "running" | "succeeded" = "queued") {
    return { id, kind: "canvas-image", status, progress: status === "succeeded" ? 1 : 0, input, params: {}, result: status === "succeeded" ? { media: [] } : null, error: null, createdAt: "", updatedAt: "", executor: "direct-image", outputs: [] };
}

function dispatcherWith(overrides: { tasks?: Record<string, unknown>; media?: Record<string, unknown>; directImage?: Record<string, unknown> } = {}) {
    return new CanvasImageDispatcher(
        { url: "http://127.0.0.1:17370" } as never,
        {
            tasks: (overrides.tasks || {}) as never,
            media: (overrides.media || {}) as never,
            settings: { get: () => undefined } as never,
            logs: { create: () => { throw new Error("日志不应在此测试中创建"); } } as never,
            projects: {} as never,
        } as never,
        {} as never,
        (overrides.directImage || {}) as never,
        {} as never,
        {} as never,
    );
}

test("图片任务只保存参考图媒体句柄，不把 dataUrl 写入任务输入", async () => {
    const records = new Map<string, ReturnType<typeof task>>();
    const media = new Map<string, { storageKey: string; mimeType: string; filePath: string; bytes: number; width: null; height: null; durationMs: null; createdAt: string }>();
    const storedData: Buffer[] = [];
    const outer = task("outer", {}, "queued");
    records.set(outer.id, outer);
    const child = task("child", {}, "succeeded");
    records.set(child.id, child);
    const tasks = {
        get: (id: string) => records.get(id) || null,
        list: () => [],
        create: (id: string, _kind: string, input: Record<string, unknown>, params: Record<string, unknown>) => {
            outer.input = input;
            outer.params = params;
            records.set(id, outer);
            return outer;
        },
        update: (id: string, patch: Record<string, unknown>) => Object.assign(records.get(id)!, patch),
        addEvent: () => ({}),
    };
    const mediaStore = {
        meta: (key: string) => media.get(key) || null,
        store: (data: Buffer, options: Record<string, unknown>) => {
            storedData.push(data);
            const value = { storageKey: "image:reference-1", mimeType: String(options.mimeType || "image/png"), filePath: "", bytes: data.length, width: null, height: null, durationMs: null, createdAt: "" };
            media.set(value.storageKey, value);
            return value;
        },
        url: () => "/media/image%3Areference-1",
    };
    const directImage = {
        supports: () => true,
        run: (request: { references?: Array<{ data: Buffer }> }, _hooks: unknown, childTaskId: string) => {
            assert.equal(request.references?.length, 1);
            assert.deepEqual(request.references?.[0].data, Buffer.from("hello"));
            return records.get(childTaskId) || child;
        },
    };

    const dispatcher = dispatcherWith({ tasks, media: mediaStore, directImage });
    dispatcher.start({ model: "gpt-image-2", prompt: "test", references: [{ id: "ref-1", name: "ref.png", dataUrl: "data:image/png;base64,aGVsbG8=" }] as CanvasImageReference[] });
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(storedData.length, 1);
    assert.equal((outer.input.references as Array<Record<string, unknown>>)[0].dataUrl, undefined);
    assert.equal((outer.input.references as Array<Record<string, unknown>>)[0].storageKey, "image:reference-1");
});

test("同一源节点的运行中任务按 sourceNodeId 去重，不受新结果节点影响", () => {
    const active = task("active-task", { projectId: "project-1", nodeId: "old-result", sourceNodeId: "source-config" }, "running");
    let directCalls = 0;
    const dispatcher = dispatcherWith({
        tasks: {
            get: (id: string) => id === active.id ? active : null,
            list: () => [active],
            create: () => { throw new Error("不应创建第二个任务"); },
        },
        media: { meta: () => null },
        directImage: { supports: () => true, run: () => { directCalls++; throw new Error("不应启动第二次模型调用"); } },
    });

    const result = dispatcher.start({ projectId: "project-1", nodeId: "new-result", sourceNodeId: "source-config", model: "gpt-image-2", prompt: "test" });

    assert.equal(result.taskId, active.id);
    assert.equal(directCalls, 0);
});
