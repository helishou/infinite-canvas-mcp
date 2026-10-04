import assert from "node:assert/strict";
import test from "node:test";

import type { RuntimeTask } from "../db.js";
import type { SettingStore, TaskStore } from "../stores/types.js";
import { patchRunningHubWorkflow, resolveRunningHubOutputNodes, RunningHubBackend } from "./runninghub.js";

test("empty SaveImageToLocal path is filled only in the submitted workflow copy", () => {
    const graph = {
        "31": { class_type: "SaveImage", inputs: { filename_prefix: "ComfyUI", images: ["9", 0] } },
        "38": { class_type: "SaveImageToLocal", inputs: { file_path: "", images: ["32", 0] } },
        "40": { class_type: "OtherNode", inputs: { file_path: "" } },
    };

    const patched = patchRunningHubWorkflow(graph, []);

    assert.equal(patched["38"].inputs.file_path, "output");
    assert.equal(graph["38"].inputs.file_path, "");
    assert.equal(patched["40"].inputs.file_path, "");
});

test("a SamplerCustomAdvanced missing noise reuses the sole shared RandomNoise link", () => {
    const graph = {
        "144": { class_type: "SamplerCustomAdvanced", inputs: { sampler: ["255", 0] } },
        "226": { class_type: "SamplerCustomAdvanced", inputs: { noise: ["256", 0], sampler: ["255", 0] } },
        "256": { class_type: "RandomNoise", inputs: { noise_seed: 123 } },
    };

    const patched = patchRunningHubWorkflow(graph, []);

    assert.deepEqual(patched["144"].inputs.noise, ["256", 0]);
    assert.equal(Object.hasOwn(graph["144"].inputs, "noise"), false);
});

test("FAILED workflow is rescued from a WS intermediate even with no selected output node", async (t) => {
    const originalFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = originalFetch; });
    globalThis.fetch = async () => new Response(JSON.stringify({ status: "FAILED", results: [], errorMessage: "workflow failed" }), {
        status: 200,
        headers: { "content-type": "application/json" },
    });

    const task = {
        id: "runninghub-rescue-test",
        kind: "runninghub:workflow",
        status: "running",
        progress: 0.5,
        input: {},
        params: { runninghubMode: "workflow" },
        result: null,
        error: null,
        createdAt: "",
        updatedAt: "",
        outputs: [],
    } as unknown as RuntimeTask;
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [{
        type: "intermediate",
        payload: {
            nodeId: "31",
            filename: "ComfyUI_00001.png",
            media: { url: "/media/image:test", storageKey: "image:test", mimeType: "image/png", bytes: 2048 },
        },
    }];
    const tasks = {
        get: () => task,
        events: () => events,
        addEvent: (_id: string, type: string, payload: Record<string, unknown>) => { events.push({ type, payload }); },
        update: (_id: string, patch: Partial<RuntimeTask>) => Object.assign(task, patch),
    } as unknown as TaskStore;
    const settings = {
        get: (key: string) => key === "runninghub.config" ? {
            baseUrl: "https://www.runninghub.ai",
            apiKey: "test-key",
            mode: "workflow",
            workflowId: "test-workflow",
            fields: [],
            instanceType: "default",
            concurrency: 1,
        } : undefined,
        set: () => {},
        delete: () => {},
    } as SettingStore;
    const backend = new RunningHubBackend(tasks, settings, undefined, {} as never, undefined, {} as never);
    const runtime = backend as unknown as {
        poll(task: RuntimeTask, config: { baseUrl: string; apiKey: string; mode: "workflow"; workflowId: string; fields: []; instanceType: string; concurrency: number; remoteId: string }, signal: AbortSignal): Promise<void>;
    };

    await runtime.poll(task, {
        baseUrl: "https://www.runninghub.ai",
        apiKey: "test-key",
        mode: "workflow",
        workflowId: "test-workflow",
        fields: [],
        instanceType: "default",
        concurrency: 1,
        remoteId: "remote-test-task",
    }, new AbortController().signal);

    assert.equal(task.status, "succeeded");
    assert.equal((task.result as { media: unknown[] }).media.length, 1);
    assert.match(String((task.result as { warning: string }).warning), /WebSocket/);
});

test("constant image fields backed by Backend media are uploaded before RunningHub submission", async (t) => {
    const originalFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = originalFetch; });
    const mediaKeys: string[] = [];
    globalThis.fetch = async (input) => {
        assert.equal(String(input), "https://www.runninghub.ai/openapi/v2/media/upload/binary");
        return new Response(JSON.stringify({ code: 0, data: { fileName: "input/reference.png" } }), {
            status: 200,
            headers: { "content-type": "application/json" },
        });
    };

    const task = {
        id: "runninghub-media-test",
        kind: "runninghub:workflow",
        status: "running",
        progress: 0.1,
        input: {},
        params: { runninghubParams: { "49::image": "/media/image%3Atest-key" } },
        result: null,
        error: null,
        createdAt: "",
        updatedAt: "",
        outputs: [],
    } as unknown as RuntimeTask;
    const tasks = { get: () => task, events: () => [], addEvent: () => {}, update: () => task } as unknown as TaskStore;
    const settings = { get: () => undefined, set: () => {}, delete: () => {} } as SettingStore;
    const media = {
        read: async (key: string) => { mediaKeys.push(key); return Buffer.from("test image"); },
        meta: () => ({ filePath: "reference.png" }),
    };
    const backend = new RunningHubBackend(tasks, settings, undefined, media as never, undefined, {} as never);
    const runtime = backend as unknown as {
        resolveFields(task: RuntimeTask, config: { baseUrl: string; apiKey: string; workflowId: string; mode: "workflow"; fields: Array<Record<string, unknown>> }, signal: AbortSignal): Promise<Array<{ nodeId: string; fieldName: string; fieldValue: unknown }>>;
    };

    const result = await runtime.resolveFields(task, {
        baseUrl: "https://www.runninghub.ai",
        apiKey: "test-key",
        workflowId: "test-workflow",
        mode: "workflow",
        fields: [{ id: "49::image", nodeId: "49", fieldName: "image", fieldType: "image", source: "constant", enabled: true }],
    }, new AbortController().signal);

    assert.deepEqual(mediaKeys, ["image:test-key"]);
    assert.deepEqual(result, [{ nodeId: "49", fieldName: "image", fieldValue: "input/reference.png" }]);
});

test("stale output node IDs are ignored when the saved graph has a current node list", () => {
    assert.deepEqual(resolveRunningHubOutputNodes(["31", "264"], { "214": {}, "264": {}, "328": {} }), {
        selected: ["264"],
        ignored: ["31"],
    });
});
