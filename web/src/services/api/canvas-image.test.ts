import assert from "node:assert/strict";
import test from "node:test";
import { runCanvasImageTask } from "./canvas-image";

test("图片批量观察只提交一个命令，不在网页提交节点结果 ops", async (t) => {
    const requests: Array<{ method?: string; url: string; body: any }> = [];
    t.mock.method(globalThis, "fetch", async (url: any, init: any) => {
        requests.push({ method: init.method, url: String(url), body: init.body && JSON.parse(init.body) });
        if (init.method === "POST") return Response.json({ taskId: "batch", executor: "direct-image" });
        return Response.json({ task: { id: "batch", status: "succeeded" } });
    });
    await runCanvasImageTask({ mode: "image", model: "gpt-image-2", count: 3, imageIds: ["a", "b", "c"] }, new AbortController().signal);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].body.count, 3);
    assert.deepEqual(requests[0].body.imageIds, ["a", "b", "c"]);
    assert.equal(requests[1].method, "GET");
    assert.ok(requests.every((request) => !request.url.includes("/ops")));
});

test("提交期间点击停止，取回实际任务 ID 后取消，不丢失已启动任务", async (t) => {
    const controller = new AbortController();
    const paths: string[] = [];
    t.mock.method(globalThis, "fetch", async (url: any, init: any) => {
        paths.push(String(url));
        if (paths.length === 1) {
            assert.equal(init.signal, undefined);
            controller.abort();
            return Response.json({ taskId: "accepted", executor: "direct-image" });
        }
        assert.match(String(url), /accepted\/cancel/);
        return Response.json({ ok: true });
    });
    await assert.rejects(runCanvasImageTask({ mode: "image" }, controller.signal), { name: "AbortError" });
    assert.equal(paths.length, 2);
});

test("观察失败不伪造节点失败、清空结果或重新提交生成", async (t) => {
    const methods: string[] = [];
    t.mock.method(globalThis, "fetch", async (_url: any, init: any) => {
        methods.push(init.method);
        if (init.method === "POST") return Response.json({ taskId: "accepted", executor: "direct-image" });
        throw new Error("模拟断网");
    });
    await assert.rejects(runCanvasImageTask({ mode: "image" }, new AbortController().signal), /模拟断网/);
    assert.deepEqual(methods, ["POST", "GET"]);
});
