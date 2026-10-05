import assert from "node:assert/strict";
import test from "node:test";

import { WorkflowExecutor } from "./executor.js";

type LogRow = { id?: string; platform: string; status: string; workflow?: string; runtimeTaskId?: string; params?: Record<string, unknown> };

/** ComfyUI 不可用，所以用假 fetch 顶掉 /prompt 提交，专注验证「同一次生图只写一条日志」。 */
async function withStubbedComfy<T>(fn: () => Promise<T>): Promise<T> {
    const originalFetch = globalThis.fetch;
    const originalWs = (globalThis as any).WebSocket;
    (globalThis as any).WebSocket = undefined;
    globalThis.fetch = (async (url: string) => {
        if (String(url).endsWith("/prompt")) {
            return new Response(JSON.stringify({ prompt_id: "prompt-1" }), { status: 200, headers: { "content-type": "application/json" } });
        }
        if (String(url).includes("/history")) {
            return new Response(JSON.stringify({ "prompt-1": { outputs: { "1": { images: [{ filename: "out.png", subfolder: "", type: "output" }] } } } }), { status: 200, headers: { "content-type": "application/json" } });
        }
        if (String(url).includes("/view")) {
            return new Response(new Uint8Array([137, 80, 78, 71]), { status: 200, headers: { "content-type": "image/png" } });
        }
        throw new Error(`unexpected fetch: ${url}`);
    }) as never;
    try {
        return await fn();
    } finally {
        globalThis.fetch = originalFetch;
        (globalThis as any).WebSocket = originalWs;
    }
}

function harness(logs: LogRow[], parentLog?: LogRow, historicalFields: Array<{ workflowName: string; field: Record<string, unknown> }> = []) {
    const tasks = new Map<string, Record<string, unknown>>();
    const db = {
        createGenerationLog: (row: LogRow) => { logs.push(row); return { id: `log-${logs.length}` }; },
        listGenerationLogs: (filter?: { runtimeTaskId?: string; platform?: string }) => parentLog && parentLog.runtimeTaskId === filter?.runtimeTaskId && parentLog.platform === filter?.platform ? [parentLog] : [],
        getWorkflowFieldDefinitionsByIds: (ids: string[]) => historicalFields.filter(({ field }) => ids.includes(String(field.id))),
        updateGenerationLog: (id: string, patch: Partial<LogRow>) => {
            if (!parentLog || parentLog.id !== id) throw new Error(`unexpected log update: ${id}`);
            Object.assign(parentLog, patch);
            return parentLog;
        },
    };
    const executor = new WorkflowExecutor(
        { getUrl: () => "http://127.0.0.1:8188", uploadImage: async () => "x.png", cancelPromptExecution: async () => undefined } as never,
        {
            create: (id: string, _kind: string, input: Record<string, unknown>, params: Record<string, unknown>) => {
                const task = { id, kind: "workflow", status: "queued", progress: 0, input, params, result: null, error: null, createdAt: "", updatedAt: "", executor: "comfy-workflow", outputs: [] };
                tasks.set(id, task);
                return task;
            },
            get: (id: string) => tasks.get(id) || null,
            update: (id: string, patch: Record<string, unknown>) => Object.assign(tasks.get(id)!, patch),
            list: () => [], addEvent: () => ({}),
        } as never,
        { get: () => null, store: () => ({}), url: (key: string) => `/media/${encodeURIComponent(key)}` } as never,
        { publish: () => undefined } as never,
        db as never,
    );
    return executor;
}

const WORKFLOW = { "1": { class_type: "SaveImage", inputs: { filename_prefix: "out" } } };
const CONFIG = { title: "test", fields: [] } as never;

test("没有父任务时写一条 workflow 日志", async () => {
    await withStubbedComfy(async () => {
        const logs: LogRow[] = [];
        const executor = harness(logs);
        await executor.run(WORKFLOW, CONFIG, {}, "client", undefined, "wf", "task-a", "project-1", "node-1");
        assert.equal(logs.length, 1, "独立跑工作流仍要留一条日志");
        assert.equal(logs[0].platform, "workflow");
        assert.equal(logs[0].status, "success");
    });
});

test("画布父日志记录 ComfyUI 实际工作流字段（含默认值）并过滤凭据", async () => {
    await withStubbedComfy(async () => {
        const parentLog: LogRow = {
            id: "canvas-log",
            platform: "canvas-image",
            status: "running",
            workflow: "custom/test.json",
            runtimeTaskId: "canvas-task",
            params: { size: "1024x1024", quality: "auto", generationSettings: {} },
        };
        const logs: LogRow[] = [];
        const executor = harness(logs, parentLog, [{
            workflowName: "custom/2.1文生图.json",
            field: { id: "f_1790654100611_5uap", node: "25", input: "template", name: "Template", type: "dropdown" },
        }]);
        const config = {
            title: "test",
            fields: [
                { id: "f_prompt", node: "1", input: "prompt", name: "Prompt", type: "text", isPrompt: true },
                { id: "f_style", node: "1", input: "style", name: "Style", type: "dropdown", default: "default", options: ["default", "cinematic"] },
                { id: "f_strength", node: "1", input: "strength", name: "Strength", type: "number", default: 0.25 },
                { id: "f_api", node: "1", input: "api_key", name: "API key", type: "text", default: "" },
            ],
        } as never;
        const workflow = { "1": { class_type: "SaveImage", inputs: { filename_prefix: "out", style: "default", strength: 0.25, api_key: "" } } };

        await executor.run(workflow, config, {
            f_prompt: "test prompt", f_style: "cinematic", f_api: "do-not-log", f_1790654100611_5uap: "柔光",
        }, "client", undefined, "custom/test.json", "child-task", "project-1", "node-1", "canvas-task");

        const settings = (parentLog.params?.generationSettings || {}) as Record<string, any>;
        assert.deepEqual(settings, { workflowParameters: { Style: "cinematic", Strength: 0.25, "Template · 2.1文生图": "柔光" } });
        assert.equal(JSON.stringify(parentLog.params).includes("f_1790654100611_5uap"), false);
        assert.equal(JSON.stringify(parentLog.params).includes("do-not-log"), false);
        assert.equal(logs.length, 0, "父任务继续复用自己的日志，不新建 workflow 日志");
    });
});

test("画布父任务已写日志时，内层不再重复写（修掉每次生图两条记录）", async () => {
    await withStubbedComfy(async () => {
        const logs: LogRow[] = [];
        const executor = harness(logs);
        // parentTaskId 非空 = image-dispatcher 已在外面写过一条 canvas-image 日志
        await executor.run(WORKFLOW, CONFIG, {}, "client", undefined, "wf", "task-b", "project-1", "node-1", "canvas-task-b");
        assert.equal(logs.length, 0, "同一次生图不应产生第二条 workflow 日志");
    });
});
