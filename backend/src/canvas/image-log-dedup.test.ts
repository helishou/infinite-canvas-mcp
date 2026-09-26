import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { BackendDatabase } from "../db.js";
import { createStores } from "../stores/index.js";
import { CanvasImageDispatcher } from "./image-dispatcher.js";
import { WorkflowExecutor } from "../workflows/executor.js";

/**
 * 真实链路集成验证：画布生图走 comfy-workflow 时，
 * image-dispatcher 写一条 canvas-image 日志，内层 workflowExecutor 不得再写第二条 workflow 日志。
 * ComfyUI 用假 fetch 顶掉，专注数日志条数。
 */
async function withStubbedComfy<T>(fn: () => Promise<T>): Promise<T> {
    const originalFetch = globalThis.fetch;
    const originalWs = (globalThis as any).WebSocket;
    (globalThis as any).WebSocket = undefined;
    globalThis.fetch = (async (url: string) => {
        if (String(url).endsWith("/prompt")) return new Response(JSON.stringify({ prompt_id: "p1" }), { status: 200, headers: { "content-type": "application/json" } });
        if (String(url).includes("/history")) return new Response(JSON.stringify({ p1: { outputs: { "1": { images: [{ filename: "o.png", subfolder: "", type: "output" }] } } } }), { status: 200, headers: { "content-type": "application/json" } });
        if (String(url).includes("/view")) return new Response(new Uint8Array([137, 80, 78, 71]), { status: 200, headers: { "content-type": "image/png" } });
        if (String(url).includes("/upload/image")) return new Response(JSON.stringify({ name: "shot1.png", subfolder: "", type: "input" }), { status: 200, headers: { "content-type": "application/json" } });
        throw new Error(`unexpected fetch: ${url}`);
    }) as never;
    try { return await fn(); }
    finally { globalThis.fetch = originalFetch; (globalThis as any).WebSocket = originalWs; }
}

async function settle(db: BackendDatabase, id: string) {
    for (let i = 0; i < 200 && ["queued", "running"].includes(db.getTask(id)!.status); i++) await new Promise((r) => setTimeout(r, 5));
    assert.ok(!["queued", "running"].includes(db.getTask(id)!.status), "任务未进入终态");
}

test("画布生图走工作流时只写一条生成日志（不再出现「生图」+「工作流」两条）", async (t: TestContext) => {
    await withStubbedComfy(async () => {
        const db = new BackendDatabase(":memory:");
        t.after(() => db.close());
        db.createCanvasProject({ id: "p", nodes: [{ id: "source", type: "config", metadata: {} }], connections: [] });
        const stores = createStores(db);
        // 照抄 model-workflow.test.ts 里的真实渠道配置：ComfyUI 渠道 + 自定义工作流模型。
        stores.settings.set("ai.config", {
            channels: [
                {
                    id: "ch1",
                    name: "本地 ComfyUI",
                    kind: "comfyui",
                    models: [{
                        name: "custom/Flux2-Klein.json",
                        capability: "image",
                        workflows: ["custom/Flux2-Klein.json"],
                    }],
                },
            ],
        } as never);

        const bridge = { url: "http://127.0.0.1:8188", getUrl: () => "http://127.0.0.1:8188", uploadImage: async () => "x.png", cancelPromptExecution: async () => undefined } as never;
        // 工作流必须真的有一个图片输入槽，否则 dispatcher 在提交前就抛错，压根走不到写日志那步
        // （那样测试会因为「0 条 workflow 日志」而假通过）。
        const workflows = {
            get: async () => ({
                workflow: {
                    "10": { class_type: "LoadImage", inputs: { image: "placeholder.png" } },
                    "1": { class_type: "SaveImage", inputs: { filename_prefix: "o", images: ["10"] } },
                },
                config: {
                    title: "custom/Flux2-Klein.json",
                    fields: [
                        { id: "prompt", name: "提示词", type: "text", node: "10", input: "text", isPrompt: true },
                        { id: "image1", name: "参考图", type: "image", node: "10", input: "image" },
                    ],
                },
            }),
        } as never;
        const executor = new WorkflowExecutor(bridge, stores.tasks as never, stores.media as never, undefined, db as never);
        // 构造顺序：config, stores, comfy, directImage, workflows, workflowExecutor
        const dispatcher = new CanvasImageDispatcher(
            { url: "http://127.0.0.1:8188" } as never,
            stores,
            bridge,
            {} as never,
            workflows,
            executor as never,
        );

        dispatcher.start({
            projectId: "p", nodeId: "source", model: "ch1::custom/Flux2-Klein.json", prompt: "现在生成第1张卖点图片 图片1",
            clientTaskId: "t1", count: 1, width: 1024, height: 1024,
            loopInputImages: [{ id: "shot1", name: "镜 1.png", mimeType: "image/png", dataUrl: "data:image/png;base64,aGVsbG8=" }],
        } as never);
        await settle(db, "t1");

        const logs = db.listGenerationLogs({ projectId: "p" }) as unknown as Array<{ platform: string; status: string; nodeId?: string; error?: string }>;
        const byPlatform = logs.reduce<Record<string, number>>((acc, log) => { acc[log.platform] = (acc[log.platform] || 0) + 1; return acc; }, {});
        // 先确认任务真的成功跑完，否则「只有一条日志」是因为根本没跑到写日志那步。
        const task = db.getTask("t1")!;
        assert.equal(task.status, "succeeded", `任务应成功，实际 ${task.status}: ${String(task.error)}`);
        assert.equal(logs.length, 1, `应恰好一条日志，实际 ${JSON.stringify(logs.map((l) => ({ p: l.platform, s: l.status })))}`);
        assert.equal(byPlatform.workflow || 0, 0, `不应有 workflow 日志，实际：${JSON.stringify(byPlatform)}`);
        assert.equal(byPlatform["canvas-image"] || 0, 1, `应恰好一条 canvas-image 日志，实际：${JSON.stringify(byPlatform)}`);
    });
});
