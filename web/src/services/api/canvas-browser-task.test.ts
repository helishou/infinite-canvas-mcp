import assert from "node:assert/strict";
import test from "node:test";

import { defaultConfig, useConfigStore } from "@/stores/use-config-store";
import { kickCanvasBrowserTask } from "./canvas-browser-task";

test("自定义文本脚本被单次认领，结果只提交 Backend 而不直接改画布", async () => {
    const originalFetch = globalThis.fetch;
    const script = `return "浏览器脚本结果";`;
    const task = {
        id: "browser-text-1", kind: "canvas-browser-script", status: "queued", progress: 0,
        input: { mode: "text", model: "channel::custom-text", prompt: "测试", script, count: 1 }, params: {},
    };
    useConfigStore.setState({
        config: {
            ...defaultConfig,
            channels: [{ id: "channel", name: "测试", baseUrl: "http://unused.local", apiKey: "test", apiFormat: "openai", models: [{ name: "custom-text", capability: "text", script }] }],
        },
    });
    const calls: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
        calls.push({ method: String(init?.method || "GET"), path: url.pathname, body });
        if (url.pathname.endsWith("/claim")) return Response.json({ ok: true, task: { ...task, status: "running" } });
        if (url.pathname.endsWith("/complete")) return Response.json({ ok: true, task: { ...task, status: "succeeded", result: body.result } });
        if (url.pathname === `/tasks/${task.id}`) return Response.json({ ok: true, task });
        return Response.json({ ok: false, error: "unexpected" }, { status: 404 });
    }) as typeof fetch;
    try {
        kickCanvasBrowserTask(task.id);
        kickCanvasBrowserTask(task.id);
        for (let index = 0; index < 50 && !calls.some((call) => call.path.endsWith("/complete")); index++) await new Promise((resolve) => setTimeout(resolve, 5));
        assert.equal(calls.filter((call) => call.path.endsWith("/claim")).length, 1);
        const completed = calls.find((call) => call.path.endsWith("/complete"));
        assert.deepEqual(completed?.body.result, { texts: ["浏览器脚本结果"] });
    } finally {
        globalThis.fetch = originalFetch;
    }
});
