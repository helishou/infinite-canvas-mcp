import assert from "node:assert/strict";
import test from "node:test";
import { defaultConfig, WORKFLOW_ROUTE_UNSUPPORTED, type AiConfig } from "@/stores/use-config-store";
import { createVideoGenerationTask, pollVideoGenerationTask } from "./video";

test("H3 界面尺寸和秒数写入实际节点字段，回执保存对齐后的参数", async (t) => {
    let submitted: any;
    t.mock.method(globalThis, "fetch", async (_input: any, init: any) => {
        if (init?.method === "POST") { submitted = JSON.parse(init.body); return Response.json({ taskId: "h3-adapted" }); }
        return Response.json({ workflow: { h3: { class_type: "NanFengH3MultiReferenceGeneratorV15", inputs: { 文生视频: true, 画面比例: "16:9 (Widescreen)", 百万像素: 0.8, 时长秒: 8, H3潜空间对齐: 2 } } }, config: { fields: [
            { id: "saved-duration", node: "h3", input: "时长秒", type: "number" },
            { id: "saved-ratio", node: "h3", input: "画面比例", type: "dropdown" },
            { id: "saved-mp", node: "h3", input: "百万像素", type: "number" },
        ] } });
    });
    const task = await createVideoGenerationTask({ ...localConfig(), size: "720x1280", videoSeconds: "6" }, "测试");
    assert.equal(submitted.fields["saved-duration"], 6);
    assert.equal(submitted.fields["saved-ratio"], "9:16 (Portrait Widescreen)");
    assert.equal(submitted.fields["saved-mp"], 0.9);
    assert.deepEqual(task.parameters, { size: "736x1280", resolution: "736", seconds: "6" });
    submitted = undefined;
    await assert.rejects(createVideoGenerationTask({ ...localConfig(), videoSeconds: "20" }, "测试"), /1.*15/);
    assert.equal(submitted, undefined);
});

function localConfig(): AiConfig {
    return { ...defaultConfig, model: "local::H3", videoModel: "local::H3", apiKey: "", channels: [{
        id: "local", name: "本地 ComfyUI", kind: "comfyui", baseUrl: "http://127.0.0.1:8188", apiKey: "", apiFormat: "openai", models: [{
            name: "H3", capability: "video", script: 'throw new Error("local models must not use API scripts")',
            workflows: ["custom/text.json", "custom/single.json", "custom/multi.json"],
            workflowRouting: { text: "custom/text.json", single: "custom/single.json", multi: "custom/multi.json" },
        }],
    }] };
}

test("本地视频创建任务不检查 API Key，按输入数量提交工作流并保存真实任务 ID", async (t) => {
    const calls: Array<{ method: string; path: string; body?: any }> = [];
    t.mock.method(globalThis, "fetch", async (input: any, init: any) => {
        const path = decodeURIComponent(new URL(String(input)).pathname);
        const body = init?.body ? JSON.parse(init.body) : undefined;
        calls.push({ method: init?.method || "GET", path, body });
        if (init?.method === "POST") return Response.json({ taskId: "workflow-task" });
        return Response.json({ workflow: {}, config: { title: "test", backend: "", operation: "", description: "", fields: [
            { id: "prompt-field", node: "1", input: "text", type: "text", name: "提示词", isPrompt: true },
            { id: "ref-a", node: "2", input: "image", type: "image", name: "参考 A" },
            { id: "ref-b", node: "3", input: "image", type: "image", name: "参考 B" },
        ] } });
    });
    for (const count of [0, 1, 2]) {
        calls.length = 0;
        const refs = Array.from({ length: count }, (_, index) => ({ id: `ref-${index}`, name: "参考", type: "image/png", dataUrl: `data:image/png;base64,${index}` }));
        const started: string[] = [];
        const task = await createVideoGenerationTask(localConfig(), "视频提示词", refs, { onTaskId: (id) => started.push(id) });
        assert.deepEqual(task, { id: "workflow-task", provider: "comfyui", model: "local::H3" });
        assert.deepEqual(started, ["workflow-task"]);
        const route = ["text", "single", "multi"][count];
        assert.deepEqual(calls.map((call) => [call.method, call.path]), [["GET", `/api/workflows/custom/${route}.json`], ["POST", `/api/workflows/custom/${route}.json/run`]]);
        assert.equal(calls[1].body.fields["prompt-field"], "视频提示词");
        if (count) assert.equal(calls[1].body.fields["ref-a"], refs[0].dataUrl);
        if (count === 2) assert.equal(calls[1].body.fields["ref-b"], refs[1].dataUrl);
    }
});

test("本地任务轮询按真实任务 ID 恢复，成功/失败/取消不进入 API 查询", async (t) => {
    let status = "succeeded";
    const paths: string[] = [];
    t.mock.method(globalThis, "fetch", async (input: any) => {
        paths.push(new URL(String(input)).pathname);
        return Response.json({ task: { id: "persisted-local", status, error: status === "failed" ? "工作流错误" : undefined,
            result: { media: [{ url: "/media/video%3Atest", mimeType: "video/mp4" }] } } });
    });
    const task = { id: "persisted-local", provider: "comfyui" as const, model: "local::H3" };
    assert.deepEqual(await pollVideoGenerationTask({ ...defaultConfig, channels: [], apiKey: "" }, task), { status: "completed", result: { url: "/media/video%3Atest", mimeType: "video/mp4" } });
    status = "failed";
    await assert.rejects(pollVideoGenerationTask(defaultConfig, task), /工作流错误/);
    status = "cancelled";
    await assert.rejects(pollVideoGenerationTask(defaultConfig, task), /取消/);
    assert.ok(paths.every((path) => path.endsWith("/persisted-local") && !path.includes("/videos/")));
});

test("明确不支持的本地输入场景不会回退其它工作流或 API", async (t) => {
    const config = localConfig();
    config.channels[0].models[0].workflowRouting!.text = WORKFLOW_ROUTE_UNSUPPORTED;
    let requests = 0;
    t.mock.method(globalThis, "fetch", async () => { requests++; return Response.json({}); });
    await assert.rejects(createVideoGenerationTask(config, "提示词"));
    assert.equal(requests, 0);
});

test("本地运行中的任务沿用工作流轮询，不重新创建任务", async (t) => {
    let polls = 0;
    t.mock.method(globalThis, "fetch", async (input: any, init: any) => {
        assert.equal(init.method, "GET");
        assert.ok(new URL(String(input)).pathname.endsWith("/local-running"));
        return Response.json({ task: { id: "local-running", status: ++polls === 1 ? "running" : "succeeded", result: { media: [{ url: "/media/video%3Aresult", mimeType: "video/mp4" }] } } });
    });
    const result = await pollVideoGenerationTask(localConfig(), { id: "local-running", provider: "comfyui", model: "local::H3" });
    assert.equal(result.status, "completed");
    assert.equal(polls, 2);
});

test("API 视频渠道仍要求 API Key", async () => {
    const config = localConfig();
    config.channels[0].kind = "api";
    config.channels[0].models[0].script = "";
    await assert.rejects(createVideoGenerationTask(config, "提示词"), /API Key|API key/);
});

test("首尾帧工作流不静默丢弃第三张参考图", async (t) => {
    let submitted = false;
    t.mock.method(globalThis, "fetch", async (_input: any, init: any) => {
        if (init?.method === "POST") submitted = true;
        return Response.json({ workflow: {}, config: { fields: [
            { id: "first", node: "h3", input: "图片1", type: "image", name: "首帧" },
            { id: "last", node: "h3", input: "图片2", type: "image", name: "尾帧" },
        ] } });
    });
    const refs = Array.from({ length: 3 }, (_, i) => ({ id: String(i), name: "ref", type: "image/png", dataUrl: "data:image/png;base64,AA" }));
    await assert.rejects(createVideoGenerationTask(localConfig(), "test", refs), /2.*3/);
    assert.equal(submitted, false);
});
