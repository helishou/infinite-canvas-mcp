import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import crypto from "node:crypto";
import { injectParams } from "../workflows/executor.js";

import { CanvasImageDispatcher, type CanvasImageReference } from "./image-dispatcher.js";

function task(id: string, input: Record<string, unknown>, status: "queued" | "running" | "succeeded" = "queued") {
    return { id, kind: "canvas-image", status, progress: status === "succeeded" ? 1 : 0, input, params: {}, result: status === "succeeded" ? { media: [] } : null, error: null, createdAt: "", updatedAt: "", executor: "direct-image", outputs: [] };
}

function dispatcherWith(overrides: { tasks?: Record<string, unknown>; media?: Record<string, unknown>; directImage?: Record<string, unknown>; projects?: Record<string, unknown> } = {}) {
    return new CanvasImageDispatcher(
        { url: "http://127.0.0.1:17370" } as never,
        {
            tasks: (overrides.tasks || {}) as never,
            media: (overrides.media || {}) as never,
            settings: { get: () => undefined } as never,
            logs: { create: () => { throw new Error("日志不应在此测试中创建"); } } as never,
            projects: (overrides.projects || { get: () => null }) as never,
        } as never,
        {} as never,
        (overrides.directImage || {}) as never,
        {} as never,
        {} as never,
    );
}

test("正式参考数量和顺序不一致时不创建任务；上传前字节变化不调用 provider", async () => {
    const original = Buffer.from("approved"), sha256 = crypto.createHash("sha256").update(original).digest("hex");
    const snapshot = { schemaVersion: 1, targetId: "FRAME", sourceNodeId: "source", sourceHash: "a".repeat(64), promptHash: "b".repeat(64), inputHash: "c".repeat(64),
        references: [{ label: "<Picture 1>", nodeId: "role", assetId: "ROLE", assetVersion: "v1", storageKey: "image:approved", sha256, role: "identity" }] };
    let created = 0, providerCalls = 0;
    const parent = task("parent", {}, "queued");
    const dispatcher = dispatcherWith({ tasks: { get: (id: string) => id === "parent" && created ? parent : null, list: () => [],
        create: (_id: string, _kind: string, input: Record<string, unknown>) => { created++; parent.input = input; return parent; },
        update: (_id: string, patch: Record<string, unknown>) => Object.assign(parent, patch), addEvent: () => ({}) },
        media: { meta: () => ({ storageKey: "image:approved", mimeType: "image/png" }), read: () => Buffer.from("changed before upload") },
        directImage: { supports: () => true, run: () => { providerCalls++; throw new Error("must never submit changed bytes"); } } });
    const input = { model: "gpt-image-2", prompt: "Formal prompt", clientTaskId: "parent", params: { productionImageInput: snapshot } };
    assert.throws(() => dispatcher.start({ ...input, references: [] }), /数量/);
    assert.throws(() => dispatcher.start({ ...input, references: [{ storageKey: "image:other" }] }), /正式顺序/);
    assert.equal(created, 0);
    dispatcher.start({ ...input, references: [{ storageKey: "image:approved" }] });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(parent.status, "failed"); assert.match(String((parent as any).error), /字节在提交前变化/);
    assert.equal(providerCalls, 0);
    assert.equal((parent.input.references as any[])[0].sha256, sha256);
});

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

test("同一源节点相同请求按 sourceNodeId 去重，不受新结果节点影响", () => {
    const active = task("active-task", { projectId: "project-1", nodeId: "old-result", sourceNodeId: "source-config", model: "gpt-image-2", prompt: "test" }, "running");
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

test("同一源节点的不同提示词不能复用运行中任务", () => {
    const active = task("active-task", { projectId: "project-1", nodeId: "old-result", sourceNodeId: "source-config", model: "gpt-image-2", prompt: "cat" }, "running");
    let created = 0;
    const dispatcher = dispatcherWith({
        tasks: {
            get: (id: string) => id === active.id ? active : null,
            list: () => [active],
            create: () => { created++; return task(`new-${created}`, {}, "queued"); },
            update: () => active,
            addEvent: () => ({}),
        },
        media: { meta: () => null },
        directImage: { supports: () => true, run: () => { throw new Error("测试只验证任务去重边界"); } },
        projects: { get: () => null },
    });
    const result = dispatcher.start({ sourceNodeId: "source-config", model: "gpt-image-2", prompt: "dog" });
    assert.notEqual(result.taskId, active.id);
    assert.equal(created, 1);
});

test("canvas workflow maps 16:9 into the submitted graph and blocks a saved 1:1 choice", async () => {
    const aspect = { id: "f_1790686390394_nzk9", node: "11", input: "aspect_ratio", name: "Aspect ratio", type: "dropdown", default: "9:16 (Portrait Widescreen)", options: ["1:1 (Square)", "9:16 (Portrait Widescreen)", "16:9 (Widescreen)"] };
    const prompt = { id: "prompt", node: "11", input: "prompt", name: "Prompt", type: "text", isPrompt: true };
    const values: Array<Record<string, unknown>> = [];
    const workflow = { "11": { class_type: "EmptyLatentImage", inputs: { aspect_ratio: "9:16 (Portrait Widescreen)" } } };
    const dispatcher = new CanvasImageDispatcher(
        { url: "http://127.0.0.1:17370" } as never,
        { tasks: { get: () => null } } as never,
        {} as never,
        {} as never,
        { get: async () => ({
            workflow,
            config: { title: "2.1文生图", backend: "comfyui", operation: "image", description: "", fields: [prompt, aspect] },
        }) } as never,
        { run: async (_workflow: unknown, _config: unknown, fields: Record<string, unknown>) => { values.push(fields); return { media: [] }; } } as never,
    );
    const run = (params?: Record<string, unknown>) => (dispatcher as unknown as { dispatchWorkflow: (input: Record<string, unknown>, taskId: string, workflowName: string) => Promise<unknown> }).dispatchWorkflow(
        { model: "qwen_image_2_1", prompt: "test", width: 1824, height: 1024, params }, "task", "custom/2.1文生图.json",
    );
    await run();
    await run({ [aspect.id]: "16:9" });
    await assert.rejects(run({ [aspect.id]: "1:1 (Square)" }), /工作流画幅与目标冲突/);
    assert.equal(values[0][aspect.id], "16:9 (Widescreen)");
    assert.equal(values[1][aspect.id], "16:9 (Widescreen)");
    assert.equal(values.length, 2);
    const submitted = injectParams(workflow, { "11": { aspect_ratio: values[0][aspect.id] } });
    assert.equal((submitted["11"] as { inputs: { aspect_ratio: string } }).inputs.aspect_ratio, "16:9 (Widescreen)");
});

test("Canvas ComfyUI generation uses and logs custom params persisted on its source node", async () => {
    const fields = [
        { id: "f_prompt", node: "1", input: "prompt", name: "Prompt", type: "text", isPrompt: true },
        { id: "f_style", node: "1", input: "style", name: "Style", type: "dropdown", default: "default", options: ["default", "cinematic"] },
        { id: "f_strength", node: "1", input: "strength", name: "Strength", type: "number", default: 0.25 },
        { id: "f_api", node: "1", input: "api_key", name: "API key", type: "text", default: "" },
    ];
    const savedParams = { f_style: "cinematic", f_strength: 0.8, f_api: "do-not-log" };
    const aiConfig = {
        channels: [{
            id: "test-channel",
            kind: "comfyui",
            models: [{
                name: "test-image",
                capability: "image",
                workflows: ["custom/test.json"],
                workflowRouting: { text: "custom/test.json" },
            }],
        }],
    };
    const project = {
        id: "project-test",
        revision: 1,
        nodes: [{ id: "source-node", type: "config", title: "Source", width: 340, height: 240, metadata: { smart: true, generationMode: "image", comfyParams: savedParams } }],
        connections: [],
    };
    const taskRecords = new Map<string, Record<string, any>>();
    let createdLog: Record<string, any> | undefined;
    let executedFields: Record<string, unknown> | undefined;
    const workflow = {
        "1": { class_type: "TestNode", inputs: { prompt: "", style: "default", strength: 0.25, api_key: "" } },
    };
    const dispatcher = new CanvasImageDispatcher(
        { url: "http://127.0.0.1:17370" } as never,
        {
            tasks: {
                get: (id: string) => taskRecords.get(id) || null,
                list: () => [],
                create: (id: string, kind: string, input: Record<string, unknown>, params: Record<string, unknown>) => {
                    const record = { id, kind, status: "queued", progress: 0, input, params, result: null, error: null, createdAt: "", updatedAt: "" };
                    taskRecords.set(id, record);
                    return record;
                },
                update: (id: string, patch: Record<string, unknown>) => Object.assign(taskRecords.get(id)!, patch),
                addEvent: () => ({}),
            },
            media: { meta: () => null },
            settings: { get: (key: string) => key === "ai.config" ? aiConfig : undefined },
            logs: {
                create: (input: Record<string, unknown>) => { createdLog = { ...input, id: "log-test" }; return createdLog; },
                update: () => ({}),
            },
            projects: { get: () => project, applyOperations: () => ({}) },
        } as never,
        {} as never,
        { supports: () => false } as never,
        {
            getConfig: () => ({ fields }),
            get: async () => ({ workflow, config: { title: "test", fields } }),
        } as never,
        {
            run: async (_workflow: unknown, _config: unknown, values: Record<string, unknown>) => {
                executedFields = values;
                return { media: [] };
            },
        } as never,
    );

    dispatcher.start({
        projectId: "project-test",
        nodeId: "source-node",
        model: "test-channel::test-image",
        prompt: "test prompt",
        clientTaskId: "task-test",
        params: { writeBackToTarget: true, f_strength: 0.9 },
    }, { onCompleted: () => {}, onFailed: () => {} });

    const settings = (createdLog?.params as Record<string, any>)?.generationSettings as Record<string, any>;
    assert.deepEqual(settings, { workflowParameters: { Style: "cinematic", Strength: 0.9 } });
    assert.equal(JSON.stringify(createdLog?.params).includes("do-not-log"), false);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(executedFields?.f_style, "cinematic");
    assert.equal(executedFields?.f_strength, 0.9);
    assert.equal(executedFields?.f_api, "do-not-log");
});

test("workflow 使用真实节点输入名映射 width/height 并拒绝旧尺寸", async () => {
    const prompt = { id: "prompt", node: "7", input: "prompt", name: "Prompt", type: "text", isPrompt: true };
    const fields = [
        prompt,
        { id: "field-width", node: "7", input: "width", name: "宽度", type: "number" },
        { id: "field-height", node: "7", input: "height", name: "高度", type: "number" },
    ];
    const values: Array<Record<string, unknown>> = [];
    const dispatcher = new CanvasImageDispatcher(
        { url: "http://127.0.0.1:17370" } as never, { tasks: { get: () => null } } as never,
        {} as never, {} as never,
        { get: async () => ({ workflow: { "7": { class_type: "EmptyLatentImage", inputs: { width: 1024, height: 1024 } } }, config: { fields } }) } as never,
        { run: async (_workflow: unknown, _config: unknown, input: Record<string, unknown>) => { values.push(input); return { media: [] }; } } as never,
    );
    const run = (params?: Record<string, unknown>) => (dispatcher as any).dispatchWorkflow({ model: "qwen_image_2_1", prompt: "test", width: 1024, height: 576, size: "16:9", params }, "task", "qwen.json");
    await run();
    assert.deepEqual([values[0]["field-width"], values[0]["field-height"]], [1024, 576]);
    await assert.rejects(run({ "field-height": 1024 }), /与目标尺寸冲突/);
    assert.equal(values.length, 1);
});

test("workflow 方图结果保留归档证据且不写回画布结果槽", async () => {
    const image = await sharp({ create: { width: 64, height: 64, channels: 3, background: "red" } }).png().toBuffer();
    const updates: Array<Record<string, unknown>> = [];
    let completed = 0, failed = 0;
    const taskRecord = { ...task("square-output", {}, "running"), result: null as unknown };
    const dispatcher = dispatcherWith({
        tasks: { get: () => taskRecord, update: (_id: string, patch: Record<string, unknown>) => { updates.push(patch); Object.assign(taskRecord, patch); }, addEvent: () => ({}) },
        media: { read: async () => image },
    });
    (dispatcher as any).dispatch = async () => ({ taskId: "square-output", media: [{ url: "/media/square", storageKey: "image:square", mimeType: "image/png" }] });
    await (dispatcher as any).execute({ executor: "comfy-workflow", input: { size: "16:9" } }, taskRecord, {
        onCompleted: () => { completed++; }, onFailed: () => { failed++; },
    });
    assert.equal(completed, 0);
    assert.equal(failed, 1);
    assert.equal(taskRecord.status, "failed");
    assert.deepEqual((taskRecord.result as any).media.map((item: any) => [item.storageKey, item.width, item.height]), [["image:square", 64, 64]]);
    assert.match(String(updates.at(-1)?.error), /目标 16:9，实际 64×64/);
});

test("workflow 横图结果按真实像素写入任务并允许回写", async () => {
    const image = await sharp({ create: { width: 64, height: 36, channels: 3, background: "blue" } }).png().toBuffer();
    const taskRecord = { ...task("wide-output", {}, "running"), result: null as unknown };
    const dispatcher = dispatcherWith({ tasks: { get: () => taskRecord, update: (_id: string, patch: Record<string, unknown>) => Object.assign(taskRecord, patch), addEvent: () => ({}) }, media: { read: async () => image } });
    (dispatcher as any).dispatch = async () => ({ taskId: "wide-output", media: [{ url: "/media/wide", storageKey: "image:wide", mimeType: "image/png" }] });
    let written: Array<{ width: number; height: number }> = [];
    await (dispatcher as any).execute({ executor: "comfy-workflow", input: { size: "16:9" } }, taskRecord, {
        onCompleted: (result: { media: Array<{ width: number; height: number }> }) => { written = result.media; },
    });
    assert.equal(taskRecord.status, "succeeded");
    assert.deepEqual(written.map((item) => [item.width, item.height]), [[64, 36]]);
});

test("SVG 参考保留原件并以确定性 PNG 句柄送入模型", async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 36"><rect width="64" height="36" fill="red"/></svg>');
    const media = new Map<string, { storageKey: string; mimeType: string; filePath: string }>([["image:source-svg", { storageKey: "image:source-svg", mimeType: "image/svg+xml", filePath: "source.svg" }]]);
    const stored = new Map<string, Buffer>();
    const events: Array<Record<string, unknown>> = [];
    const dispatcher = dispatcherWith({
        tasks: { addEvent: (_id: string, _type: string, event: Record<string, unknown>) => { events.push(event); } },
        media: {
            meta: (key: string) => media.get(key) || null,
            read: async (key: string) => key === "image:source-svg" ? svg : stored.get(key),
            store: (data: Buffer, options: { storageKey: string }) => { stored.set(options.storageKey, data); const entry = { storageKey: options.storageKey, mimeType: "image/png", filePath: "derived.png" }; media.set(entry.storageKey, entry); return entry; },
            url: (entry: { storageKey: string }) => `/media/${entry.storageKey}`,
        },
    });
    const reference = { storageKey: "image:source-svg", mimeType: "image/svg+xml", name: "diagram.svg" };
    const first = await (dispatcher as any).modelReference(reference, "task-svg");
    const again = await (dispatcher as any).modelReference(reference, "task-svg");
    assert.equal(first.storageKey, again.storageKey);
    assert.equal(stored.size, 1);
    assert.equal(first.mimeType, "image/png");
    const dimensions = await sharp(stored.get(first.storageKey)!).metadata();
    assert.deepEqual([dimensions.width, dimensions.height], [64, 36]);
    assert.deepEqual(events[0], { sourceStorageKey: "image:source-svg", sourceName: "diagram.svg", submittedStorageKey: first.storageKey, mimeType: "image/png" });
});
