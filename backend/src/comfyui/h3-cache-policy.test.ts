import assert from "node:assert/strict";
import test from "node:test";
import { ComfyUiBackend, buildNativeNanFengV15Workflow, type ComfyUiDeps } from "./bridge.js";
import type { RuntimeTask } from "../db.js";

for (const scenario of [
    { name: "默认连续任务成功保留执行缓存，不发 /free", params: {}, fail: false, frees: 0 },
    { name: "明确保留模型缓存时成功不发 /free", params: { keepModelCache: true }, fail: false, frees: 0 },
    { name: "明确关闭缓存时成功完整释放一次", params: { keepModelCache: false }, fail: false, frees: 1 },
    { name: "采样失败时即使保留缓存也执行清理", params: { keepModelCache: true }, fail: true, frees: 1 },
]) {
    test(scenario.name, async (t) => {
        const task = { id: "h3-cache-test", kind: "comfyui:minimax-h3", status: "queued", progress: 0, input: {}, params: scenario.params } as RuntimeTask;
        let complete!: () => void;
        const terminal = new Promise<void>((resolve) => { complete = resolve; });
        const deps = {
            settings: { get: () => "" }, media: {},
            tasks: { get: () => task, create: () => task, update: (_id: string, patch: object) => Object.assign(task, patch), addEvent: () => {} },
            onTaskTerminal: () => complete(),
        } as unknown as ComfyUiDeps;
        const bridge = new ComfyUiBackend(deps, "http://comfy.test");
        t.mock.method(bridge as unknown as { executeWorkflow: () => Promise<object> }, "executeWorkflow", async () => {
            if (scenario.fail) throw new Error("模拟采样失败");
            return { media: [{ storageKey: "video:test" }] };
        });
        const requests: Array<{ path: string; body: object }> = [];
        t.mock.method(globalThis, "fetch", async (url: any, init: any) => {
            requests.push({ path: new URL(String(url)).pathname, body: JSON.parse(init.body) });
            return new Response(null, { status: 200 });
        });
        await bridge.run("minimax-h3", {}, scenario.params);
        await terminal;
        assert.equal(task.status, scenario.fail ? "failed" : "succeeded");
        assert.equal(requests.length, scenario.frees);
        if (scenario.frees) assert.deepEqual(requests[0], { path: "/free", body: { unload_models: true, free_memory: true } });
    });
}

test("只有原生节点声明 Loader 复用能力时才透传缓存设置", async (t) => {
    let supported = false;
    t.mock.method(globalThis, "fetch", async () => Response.json({ NanFengH3MultiReferenceGeneratorV15: { input: { required: {}, optional: supported ? { 复用加载器缓存: ["BOOLEAN", { default: false }] } : {} } } }));
    const build = (keepModelCache: boolean) => buildNativeNanFengV15Workflow({ prompt: "test" }, { mode: "t2v", seed: 1, keepModelCache }, async (file) => file, "http://comfy.test", new AbortController().signal);
    assert.equal(Object.hasOwn((await build(true)).nf_v15.inputs, "复用加载器缓存"), false);
    supported = true;
    assert.equal((await build(true)).nf_v15.inputs["复用加载器缓存"], true);
    assert.equal((await build(false)).nf_v15.inputs["复用加载器缓存"], false);
});
