import assert from "node:assert/strict";
import test from "node:test";

import { discoverRunningHubFields, patchRunningHubWorkflow, RunningHubBackend } from "./runninghub.js";
import type { SettingStore, TaskStore } from "../stores/types.js";

/** 只验证映射校验路径，不触网也不建任务。 */
function fakeSettings(): SettingStore {
    const store = new Map<string, unknown>();
    return { get: (key) => store.get(key), set: (key, value) => void store.set(key, value), delete: (key) => void store.delete(key) };
}
function fakeTasks(): TaskStore {
    return { list: () => [], get: () => undefined } as unknown as TaskStore;
}

// RunningHub 的 API 格式工作流：连线输入是 ["源节点ID", 端口序号]，不是可填写值。
const graph = {
    "36": { class_type: "Load VAE", inputs: { vae_name: "qwen_vae.safetensors" } },
    "38": { class_type: "Load CLIP", inputs: { clip_name: "qwen-clip.safetensors", type: "qwen_image", device: "default" } },
    "49": { class_type: "LoadImage", inputs: { image: "input.png" } },
    "6": { class_type: "KSampler", inputs: { model: ["38", 0], positive: ["10", 0], seed: 42, cfg: 4.5 } },
    "8": { class_type: "EmptyLatentImage", inputs: { width: 1328, height: 1328 } },
};

test("映射发现只列可填写输入，连线输入不会变成可覆写字段", () => {
    const fields = discoverRunningHubFields(graph);
    const targets = fields.map((field) => `${field.nodeId}.${field.fieldName}`);

    assert.ok(targets.includes("49.image"), "LoadImage 的图片名应可填写");
    assert.ok(targets.includes("6.seed") && targets.includes("6.cfg"), "数值输入应可填写");
    assert.ok(!targets.includes("6.model"), "连线输入 model 不能出现在映射表");
    assert.ok(!targets.includes("6.positive"), "连线输入 positive 不能出现在映射表");
    assert.equal(fields.filter((field) => field.fieldType === "image").length, 1);
    assert.equal(fields.filter((field) => field.fieldType === "number").length, 4, "seed / cfg / width / height");
    assert.ok(fields.every((field) => field.enabled === false), "新发现的映射默认不启用");
    assert.equal(fields.find((field) => field.nodeId === "6" && field.fieldName === "cfg")?.fieldType, "number");
    assert.equal(fields.find((field) => field.nodeId === "38" && field.fieldName === "device")?.fieldType, "text");
});

test("保存映射时拒绝重复目标、缺节点字段和失效来源的映射", () => {
    const backend = new RunningHubBackend(fakeTasks(), fakeSettings());
    const base = { id: "p1", name: "测试", workflowId: "2104986810811240449" };
    assert.throws(
        () => backend.saveWorkflowProfile({ ...base, fields: [
            { nodeId: "49", fieldName: "image", enabled: true },
            { nodeId: "49", fieldName: "image", enabled: true },
        ] }),
        /重复/,
    );
    // 缺节点 ID 由 zod 契约挡在业务校验之前，两层都要拦住非法映射。
    assert.throws(
        () => backend.saveWorkflowProfile({ ...base, fields: [{ nodeId: "", fieldName: "image", enabled: true }] }),
        /nodeId/,
    );
    // source=param 随 H3 专用路径一起移除，不能再作为可写入来源。
    assert.throws(
        () => backend.saveWorkflowProfile({ ...base, fields: [{ nodeId: "6", fieldName: "seed", enabled: true, source: "param" as never, paramKey: "seed" }] }),
        /来源无效/,
    );
    const saved = backend.saveWorkflowProfile({ ...base, fields: [{ nodeId: "6", fieldName: "seed", enabled: true, source: "constant", fieldValue: 42 }] });
    assert.equal(backend.listWorkflowProfiles().length, 1, "合法映射应能落盘");
    assert.equal(saved.fields[0].fieldValue, 42);
});

test("老档案里的 source=param 降级成 constant，档案不会整个读不出来", () => {
    const backend = new RunningHubBackend(fakeTasks(), fakeSettings());
    const settings = backend as unknown as { settings: { set: (k: string, v: unknown) => void } };
    settings.settings.set("runninghub.workflows", [{
        id: "old", name: "老档案", workflowId: "123",
        fields: [
            { nodeId: "6", fieldName: "seed", enabled: true, source: "param", paramKey: "seed", fieldValue: 7 },
            { nodeId: "7", fieldName: "value", enabled: true, source: "prompt" },
        ],
    }]);
    const profiles = backend.listWorkflowProfiles();
    assert.equal(profiles.length, 1, "老档案必须还能被读到，否则列表里静默消失");
    assert.equal(profiles[0].fields[0].source, "constant", "param 应降级成 constant");
    assert.equal(profiles[0].fields[0].paramKey, undefined, "paramKey 不该留下");
    assert.equal(profiles[0].fields[0].fieldValue, 7, "固定值必须保留");
    assert.equal(profiles[0].fields[1].source, "prompt", "其它来源不受影响");
});

test("正向与负面提示词各取自己的值，不被同一个 input.prompt 覆盖", async () => {
    const { resolveFieldsForTest } = await import("./runninghub.js");
    const task = {
        input: { prompt: "全局提示词" },
        params: {
            runninghubParams: { "7::value": "正向：赛博朋克街景", "10::negative_prompt": "负面：模糊、变形" },
            runninghubFields: [
                { nodeId: "7", fieldName: "value", enabled: true, source: "prompt" },
                { nodeId: "10", fieldName: "negative_prompt", enabled: true, source: "prompt" },
            ],
        },
    };
    const values = await resolveFieldsForTest(task as never, {} as never);
    const byNode = Object.fromEntries(values.map((v) => [`${v.nodeId}.${v.fieldName}`, v.fieldValue]));
    assert.equal(byNode["7.value"], "正向：赛博朋克街景");
    assert.equal(byNode["10.negative_prompt"], "负面：模糊、变形", "负面提示词不能被全局 prompt 覆盖");
});

test("字段没单独给值时才退回全局 input.prompt", async () => {
    const { resolveFieldsForTest } = await import("./runninghub.js");
    const task = {
        input: { prompt: "全局提示词" },
        params: {
            runninghubParams: {},
            runninghubFields: [{ nodeId: "7", fieldName: "value", enabled: true, source: "prompt" }],
        },
    };
    const values = await resolveFieldsForTest(task as never, {} as never);
    assert.equal(values[0].fieldValue, "全局提示词");
});

test("平台拒绝时给出可操作中文提示，而不是透传英文错误码", async () => {
    const { checkResponseForTest } = await import("./runninghub.js");
    const config = { apiKey: "", walletApiKey: "" } as never;
    // 810：工作流存在但没保存/没运行过
    assert.throws(
        () => checkResponseForTest({ ok: true } as Response, { code: 810, msg: "WORKFLOW_NOT_SAVED_OR_NOT_RUNNING" }, config),
        /还没有保存或运行过/,
    );
    // 380：工作流不存在
    assert.throws(
        () => checkResponseForTest({ ok: true } as Response, { code: 380, msg: "WORKFLOW_NOT_EXISTS" }, config),
        /找不到这个 RunningHub 工作流/,
    );
    // 421：并发/队列已满，保留原有语义
    assert.throws(
        () => checkResponseForTest({ ok: true } as Response, { code: 421, msg: "" }, config),
        /并发\/队列已满/,
    );
    // 成功响应不应抛错
    assert.doesNotThrow(() => checkResponseForTest({ ok: true } as Response, { code: 0, data: {} }, config));
});

test("patch 只改被映射的输入，其余节点和连线保持原样", () => {
    const patched = patchRunningHubWorkflow(graph, [{ nodeId: "49", fieldName: "image", fieldValue: "uploaded.png" }]);
    assert.equal((patched["49"] as any).inputs.image, "uploaded.png");
    assert.deepEqual((patched["6"] as any).inputs.model, ["38", 0], "未映射的连线不能被动过");
    assert.equal((patched["8"] as any).inputs.width, 1328);
    assert.equal((graph["49"] as any).inputs.image, "input.png", "原图不能被就地改写");
});

test("覆写连线输入被拒绝，而不是静默破坏节点连接", () => {
    assert.throws(
        () => patchRunningHubWorkflow(graph, [{ nodeId: "6", fieldName: "model", fieldValue: "whatever" }]),
        /连线/,
    );
    assert.throws(
        () => patchRunningHubWorkflow(graph, [{ nodeId: "999", fieldName: "image", fieldValue: "x.png" }]),
        /不存在/,
    );
});
