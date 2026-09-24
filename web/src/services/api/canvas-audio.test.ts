import assert from "node:assert/strict";
import test from "node:test";
import { runCanvasAudioTask } from "./canvas-audio";

test("普通音频只提交一次父任务，网页只观察终态", async (t) => {
    const requests: Array<{ method?: string; url: string; body: any }> = [];
    t.mock.method(globalThis, "fetch", async (url: any, init: any) => {
        requests.push({ method: init.method, url: String(url), body: init.body && JSON.parse(init.body) });
        if (init.method === "POST") return Response.json({ taskId: "audio-parent", executor: "direct-audio" });
        return Response.json({ task: { id: "audio-parent", status: "succeeded" } });
    });
    await runCanvasAudioTask({ mode: "audio", model: "cloud::tts", prompt: "你好", params: { voice: "alloy" } }, new AbortController().signal);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].body.mode, "audio");
    assert.equal(requests[1].method, "GET");
    assert.ok(requests.every((request) => !request.url.includes("/ops")));
});
