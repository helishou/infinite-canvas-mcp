import assert from "node:assert/strict";
import test from "node:test";
import { runCanvasTextTask } from "./canvas-text-task";

test("标准文本只提交一次父任务，网页只观察终态", async (t) => {
    const requests: Array<{ method?: string; url: string; body: any }> = [];
    t.mock.method(globalThis, "fetch", async (url: any, init: any) => {
        requests.push({ method: init.method, url: String(url), body: init.body && JSON.parse(init.body) });
        if (init.method === "POST") return Response.json({ taskId: "text-parent", executor: "direct-text" });
        return Response.json({ task: { id: "text-parent", status: "succeeded" } });
    });
    const task = await runCanvasTextTask({ mode: "text", model: "cloud::gpt-5-6", prompt: "你好", count: 1 }, new AbortController().signal);
    assert.equal(task.id, "text-parent");
    assert.equal(requests.length, 2);
    assert.equal(requests[0].body.mode, "text");
    assert.equal(requests[1].method, "GET");
    assert.ok(requests.every((request) => !request.url.includes("/ops")));
});
