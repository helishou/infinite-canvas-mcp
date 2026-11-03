import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { WorkflowExecutor } from "./executor.js";

// Captured failing prompt: f620e712-6537-48a0-9913-633db36935bc.
// ComfyUI completed after 87,785ms, with node 237's SaveImage result.
const promptId = "f620e712-6537-48a0-9913-633db36935bc";
const captured = process.env.CANVAS_TEST_COMFY_HISTORY
    ? JSON.parse(fs.readFileSync(process.env.CANVAS_TEST_COMFY_HISTORY, "utf8")).history[promptId]
    : { outputs: { "237": { images: [{ filename: "2采_00009_.png", subfolder: "", type: "output" }] } }, status: { status_str: "success", completed: true } };

async function replay(t: Parameters<Parameters<typeof test>[1]>[0], options: { wsOutput?: boolean; historyOutput?: boolean; missing?: boolean; outputNodes?: string[] }) {
    let now = 0;
    let socket: any;
    let historyReads = 0;
    const events: Array<{ type: string; payload: any }> = [];
    class Socket {
        onmessage: any;
        constructor() { socket = this; }
        close() {}
        emit(type: string, data: object) { this.onmessage({ data: JSON.stringify({ type, data: { prompt_id: promptId, ...data } }) }); }
    }
    t.mock.method(Date, "now", () => now);
    t.mock.method(globalThis, "setTimeout", ((fn: () => void) => { queueMicrotask(fn); return 0; }) as any);
    const oldWs = globalThis.WebSocket;
    (globalThis as any).WebSocket = Socket;
    t.mock.method(globalThis, "fetch", async (url: any) => {
        if (String(url).endsWith("/prompt")) return Response.json({ prompt_id: promptId });
        if (String(url).includes("/history/")) {
            historyReads++;
            if (historyReads === 1) {
                now = 87785;
                // Actual ComfyUI executed protocol is node + output, NOT an output-node map.
                if (options.wsOutput) {
                    socket.emit("executed", { node: "812", output: { images: [{ filename: "unselected.png" }] } });
                    socket.emit("executed", { node: "237", output: captured.outputs["237"] });
                }
                socket.emit("execution_success", { timestamp: now });
                // Unrelated prompts must not replace the selected result.
                socket.onmessage({ data: JSON.stringify({ type: "executed", data: { prompt_id: "other", node: "237", output: { images: [{ filename: "wrong.png" }] } } }) });
                return Response.json({});
            }
            if (options.missing) { now += 30001; return Response.json({}); }
            if (options.historyOutput) return Response.json({ [promptId]: captured });
            throw new Error("WS node output should have been used without a second history read");
        }
        if (String(url).includes("/view?")) {
            assert.ok((options.outputNodes || ["237"]).some(id => String(url).includes(encodeURIComponent(captured.outputs[id].images[0].filename))));
            return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "content-type": "image/png" } });
        }
        throw new Error(`unexpected fetch: ${url}`);
    });
    const media = { async storeStream(stream: AsyncIterable<Uint8Array>) {
        for await (const _chunk of stream) { /* exercise real response stream */ }
        return { storageKey: "image:completion", mimeType: "image/png" };
    }, url: () => "/media/completion" };
    const executor = new WorkflowExecutor({} as never, { addEvent: (_id: string, type: string, payload: unknown) => events.push({ type, payload }) } as never, media as never);
    try {
        const result = await (executor as any).executeWorkflow({ id: "replay-only" }, {}, "http://comfy.test", new AbortController(), "client", options.outputNodes || ["237"]);
        return { result, historyReads, events };
    } finally {
        (globalThis as any).WebSocket = oldWs;
        if (options.missing) {
            assert.equal(historyReads, 3, "read history throughout the grace period, including its final attempt");
            assert.equal(now, 147787, "grace is 60 seconds after completion, not submission");
        }
    }
}

test("captured user history archives both selected SaveImage nodes, not text 818", { skip: !process.env.CANVAS_TEST_COMFY_HISTORY }, async (t) => {
    const { result } = await replay(t, { historyOutput: true, outputNodes: ["237", "812"] });
    assert.deepEqual(Object.keys(result.outputs), ["237", "812"]);
    assert.deepEqual(result.media.map((item: any) => item.filename), ["2采_00009_.png", "一采_00010_.png"]);
});

test("long-running prompt collects node-keyed WS SaveImage output 237", async (t) => {
    const { result, historyReads } = await replay(t, { wsOutput: true });
    assert.deepEqual(Object.keys(result.outputs), ["237"]);
    assert.equal(result.media.length, 1);
    assert.equal(historyReads, 1);
});

test("completion after 87s still reads exact history before declaring result missing", async (t) => {
    const { result, historyReads } = await replay(t, { historyOutput: true });
    assert.deepEqual(result.outputs["237"], captured.outputs["237"]);
    assert.equal(result.media.length, 1);
    assert.equal(historyReads, 2);
});

test("missing results retain a bounded 60s grace measured from WS completion", async (t) => {
    await assert.rejects(replay(t, { missing: true }), /WebSocket 报告完成.*未取回结果/);
});
