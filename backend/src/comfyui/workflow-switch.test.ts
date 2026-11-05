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
