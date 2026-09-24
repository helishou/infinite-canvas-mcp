import assert from "node:assert/strict";
import test from "node:test";
import { runCanvasVideoTask } from "./canvas-video";

test("普通视频只提交一次父任务，网页只观察终态", async (t) => {
    const requests: Array<{ method?: string; url: string; body: any }> = [];
    t.mock.method(globalThis, "fetch", async (url: any, init: any) => {
        requests.push({ method: init.method, url: String(url), body: init.body && JSON.parse(init.body) });
        if (init.method === "POST") return Response.json({ taskId: "video-parent", executor: "workflow" });
        return Response.json({ task: { id: "video-parent", status: "succeeded" } });
    });
    await runCanvasVideoTask({ mode: "video", model: "local::movie", videoReferences: [{ storageKey: "video:one" }] }, new AbortController().signal);
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[0].body.videoReferences, [{ storageKey: "video:one" }]);
    assert.equal(requests[1].method, "GET");
    assert.ok(requests.every((request) => !request.url.includes("/ops")));
});

test("视频提交期间停止，拿到父任务 ID 后再取消", async (t) => {
    const controller = new AbortController();
    const paths: string[] = [];
    t.mock.method(globalThis, "fetch", async (url: any, init: any) => {
        paths.push(String(url));
        if (paths.length === 1) {
            assert.equal(init.signal, undefined);
            controller.abort();
            return Response.json({ taskId: "accepted-video", executor: "workflow" });
        }
        assert.match(String(url), /accepted-video\/cancel/);
        return Response.json({ ok: true });
    });
    await assert.rejects(runCanvasVideoTask({ mode: "video", model: "local::movie" }, controller.signal), { name: "AbortError" });
    assert.equal(paths.length, 2);
});

test("视频观察断网不重新提交任务", async (t) => {
    const methods: string[] = [];
    t.mock.method(globalThis, "fetch", async (_url: any, init: any) => {
        methods.push(init.method);
        if (init.method === "POST") return Response.json({ taskId: "accepted-video", executor: "workflow" });
        throw new Error("模拟断网");
    });
    await assert.rejects(runCanvasVideoTask({ mode: "video", model: "local::movie" }, new AbortController().signal), /模拟断网/);
    assert.deepEqual(methods, ["POST", "GET"]);
});
