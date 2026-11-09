import assert from "node:assert/strict";
import test from "node:test";

import { WorkflowExecutor } from "./executor.js";

/**
 * 真实链路回归：ComfyUI 的 /prompt 只是入队。模拟前两轮队列里跑的是别人的任务、
 * 本 prompt 第三轮才进入 running，验证自定义工作流不会在排队阶段被判超时，
 * 且 execution_started 事件如实记录排队时长。
 */
test("排队阶段不消耗执行预算，本任务进入 running 后正常收结果", async () => {
    const originalFetch = globalThis.fetch;
    const originalWs = (globalThis as any).WebSocket;
    (globalThis as any).WebSocket = undefined;

    const promptId = "prompt-under-test";
    let queuePolls = 0;
    let historyPolls = 0;
    const historyEntry = {
        [promptId]: {
            outputs: { "1": { images: [{ filename: "out.png", subfolder: "", type: "output" }] } },
            status: { status_str: "success", completed: true },
        },
    };
    globalThis.fetch = (async (url: string) => {
        const target = String(url);
        if (target.endsWith("/free")) return new Response(null, { status: 200 });
        if (target.endsWith("/prompt")) return new Response(JSON.stringify({ prompt_id: promptId }), { status: 200, headers: { "content-type": "application/json" } });
        if (target.endsWith("/queue")) {
            queuePolls += 1;
            // 前两轮：别人在跑，本任务还在 pending；第三轮：本任务进入 running。
            const running = queuePolls >= 3;
            return new Response(JSON.stringify({
                queue_running: running ? [[1, promptId, {}, {}, []]] : [[0, "someone-else", {}, {}, []]],
                queue_pending: running ? [] : [[1, promptId, {}, {}, []]],
            }), { status: 200, headers: { "content-type": "application/json" } });
        }
        if (target.includes("/history")) {
            historyPolls += 1;
            return new Response(JSON.stringify(historyPolls >= 3 ? historyEntry : {}), { status: 200, headers: { "content-type": "application/json" } });
        }
        if (target.includes("/view")) return new Response(new Uint8Array([137, 80, 78, 71]), { status: 200, headers: { "content-type": "image/png" } });
        throw new Error(`unexpected fetch: ${target}`);
    }) as never;

    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const media = {
        get: () => null,
        store: (bytes: Buffer, options: { mimeType?: string }) => ({ storageKey: "image:clock-test", mimeType: options.mimeType || "image/png", bytes: bytes.length }),
        async storeStream(stream: AsyncIterable<Uint8Array>, options: { mimeType?: string }) {
            const chunks: Buffer[] = [];
            for await (const chunk of stream) chunks.push(Buffer.from(chunk));
            return this.store(Buffer.concat(chunks), options);
        },
        url: (item: { storageKey: string }) => `/media/${encodeURIComponent(item.storageKey)}`,
    };
    const tasks = {
        create: () => ({}), get: () => null, update: () => ({}), list: () => [],
        addEvent: (_id: string, type: string, payload: Record<string, unknown>) => { events.push({ type, payload }); return {}; },
    };
    const executor = new WorkflowExecutor(
        { getUrl: () => "http://127.0.0.1:8188", cancelPromptExecution: async () => undefined } as never,
        tasks as never,
        media as never,
        { publish: () => undefined } as never,
        undefined,
    );

    try {
        const run = executor as unknown as {
            executeWorkflow: (...args: any[]) => Promise<{ status: { status_str: string }; media: unknown[] }>;
        };
        const result = await run.executeWorkflow(
            { id: "task-clock" },
            { "1": { class_type: "SaveImage", inputs: { filename_prefix: "out" } } },
            "http://127.0.0.1:8188",
            new AbortController(),
            "client-clock",
            [],
            "custom",
        );
        assert.equal(result.status.status_str, "success");
        assert.ok(result.media.length > 0, "媒体应已归档");
        const started = events.find((event) => event.type === "execution_started");
        assert.ok(started, "本任务进入 running 时应记录 execution_started");
        assert.equal(started.payload.promptId, promptId);
        assert.equal(typeof started.payload.queuedForMs, "number");
        assert.ok(queuePolls >= 3, "确实经历了多轮排队探测");
    } finally {
        globalThis.fetch = originalFetch;
        (globalThis as any).WebSocket = originalWs;
    }
});
