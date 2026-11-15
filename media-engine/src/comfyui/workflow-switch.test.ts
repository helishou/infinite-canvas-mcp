import test from "node:test";
import assert from "node:assert/strict";
import { ComfyWorkflowSwitch } from "./workflow-switch.js";

test("workflow changes release both caches before submission; endpoints and repeated workflows are independent", async () => {
    const original = globalThis.fetch;
    const calls: unknown[] = [];
    globalThis.fetch = async (url, init) => {
        calls.push([url, JSON.parse(String(init?.body))]);
        return new Response(null, { status: 200 });
    };
    try {
        const policy = new ComfyWorkflowSwitch();
        const submit = (name: string) => async () => { calls.push(name); return name; };
        await policy.submit("http://comfy/", "a", submit("a"));
        await policy.submit("http://comfy", "a", submit("a2"));
        await policy.submit("http://other", "b", submit("other"));
        await Promise.all([
            policy.submit("http://comfy", "b", submit("b")),
            policy.submit("http://comfy", "b", submit("b2")),
        ]);
        assert.deepEqual(calls, ["a", "a2", "other", ["http://comfy/free", { unload_models: true, free_memory: true }], "b", "b2"]);
        globalThis.fetch = async () => new Response(null, { status: 500 });
        await assert.rejects(policy.submit("http://comfy", "c", submit("must not submit")), /\/free failed/);
        assert.equal(calls.includes("must not submit"), false);
        await assert.rejects(policy.submit("http://other", "c", async () => { throw new Error("submit failed"); }), /\/free failed/);
    } finally {
        globalThis.fetch = original;
    }
});

test("空闲时任务结束后释放，且下一次同一工作流提交不再重复释放", async () => {
    const original = globalThis.fetch;
    const calls: unknown[] = [];
    globalThis.fetch = async (url, init) => {
        const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
        calls.push([url, body]);
        if (String(url).endsWith("/queue")) return Response.json({ queue_running: [], queue_pending: [] });
        return new Response(null, { status: 200 });
    };
    try {
        const policy = new ComfyWorkflowSwitch();
        const submit = (name: string) => async () => { calls.push(name); return name; };
        await policy.submit("http://comfy", "seg", submit("first"));
        // 第一段结束后释放：先查队列再释放。
        assert.equal(await policy.releaseIfIdle("http://comfy"), true);
        // 已释放，第二段提交时无需再按换流释放一次。
        await policy.submit("http://comfy", "seg", submit("second"));
        assert.deepEqual(calls, [
            "first",
            ["http://comfy/queue", undefined],
            ["http://comfy/free", { unload_models: true, free_memory: true }],
            "second",
        ]);
    } finally {
        globalThis.fetch = original;
    }
});

test("队列里还有运行中或排队中的 prompt 时跳过释放", async () => {
    const original = globalThis.fetch;
    const calls: unknown[] = [];
    globalThis.fetch = async (url, init) => {
        calls.push([url, init?.body === undefined ? undefined : JSON.parse(String(init.body))]);
        if (String(url).endsWith("/queue")) return Response.json({ queue_running: [[1, "prompt-1"]], queue_pending: [] });
        return new Response(null, { status: 200 });
    };
    try {
        const policy = new ComfyWorkflowSwitch();
        assert.equal(await policy.releaseIfIdle("http://comfy"), false);
        assert.deepEqual(calls, [["http://comfy/queue", undefined]]);

        globalThis.fetch = async (url, init) => {
            calls.push([url, init?.body === undefined ? undefined : JSON.parse(String(init.body))]);
            if (String(url).endsWith("/queue")) return Response.json({ queue_running: [], queue_pending: [[1, "prompt-2"]] });
            return new Response(null, { status: 200 });
        };
        assert.equal(await policy.releaseIfIdle("http://comfy"), false);
        assert.equal(calls.some(([url]) => String(url).endsWith("/free")), false);
    } finally {
        globalThis.fetch = original;
    }
});
