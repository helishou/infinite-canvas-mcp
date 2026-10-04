// RunningHub 档案 → 本地 WorkflowConfig 的字段适配测试。
//
// 运行页签与字段表单按 WorkflowConfig 渲染，本地与云端共用同一套 UI；
// 这里锁定映射规则，避免平台提交时的字段对不上表单。
import assert from "node:assert/strict";
import test from "node:test";

import {
    runningHubFieldToLocal,
    runningHubMediaSlots,
    runningHubProfileToConfig,
    runningHubValuesFromForm,
} from "./runninghub-run-adapter";
import type { RunningHubWorkflowProfile } from "@/services/api/runninghub";

const profile: RunningHubWorkflowProfile = {
    id: "rh-1",
    name: "云端生视频",
    workflowId: "2104986810811240449",
    fields: [
        { nodeId: "12", fieldName: "prompt", source: "prompt", fieldType: "text", label: "正向提示词", enabled: true },
        { nodeId: "49", fieldName: "image", source: "image", fieldType: "image", label: "首帧", enabled: true, index: 1 },
        { nodeId: "51", fieldName: "image", source: "image", fieldType: "image", label: "尾帧", enabled: true, index: 2 },
        { nodeId: "60", fieldName: "duration", source: "param", paramKey: "duration", fieldValue: 5, fieldType: "number", enabled: true },
        { nodeId: "61", fieldName: "cfg", source: "param", paramKey: "cfg", fieldValue: 0.5, fieldType: "slider", enabled: true },
        { nodeId: "62", fieldName: "vae_name", source: "constant", fieldValue: "h3_vae.safetensors", fieldType: "text", enabled: false },
    ],
};

test("启用字段才进入运行表单，禁用字段保留在档案里不参与提交", () => {
    const config = runningHubProfileToConfig(profile);
    const ids = config.fields.map((field) => field.id);
    assert.deepEqual(ids, ["prompt", "image", "image", "duration", "cfg"]);
    assert.equal(ids.includes("vae_name"), false);
});

test("source=prompt 标为 isPrompt，生成时注入提示词正文", () => {
    const field = runningHubFieldToLocal(profile.fields[0]);
    assert.equal(field?.isPrompt, true);
    assert.equal(field?.type, "text");
});

test("source=param 用 paramKey 作字段 id，填写的值原样回到平台节点", () => {
    const duration = runningHubFieldToLocal(profile.fields[3]);
    const cfg = runningHubFieldToLocal(profile.fields[4]);
    assert.equal(duration?.id, "duration");
    assert.equal(duration?.input, "duration");
    assert.equal(duration?.default, 5);
    assert.equal(cfg?.id, "cfg");
    assert.equal(cfg?.type, "slider");
});

test("媒体字段不填默认值，避免用档案旧图覆盖本次请求", () => {
    const field = runningHubFieldToLocal(profile.fields[1]);
    assert.equal(field?.type, "image");
    assert.equal(field?.default, undefined);
});

test("媒体槽按 source 与 index 排序，供注入顺序使用", () => {
    const slots = runningHubMediaSlots(profile);
    assert.deepEqual(slots.map((slot) => slot.label), ["首帧", "尾帧"]);
    assert.deepEqual(slots.map((slot) => slot.position), [0, 1]);
});

test("表单值转平台参数：数字保持数值，空值不提交", () => {
    const values = runningHubValuesFromForm({ duration: "6", cfg: "0.5", name: "", seed: "-1" });
    assert.deepEqual(values, { duration: 6, cfg: 0.5, seed: -1 });
});

test("档案没有启用字段时表单为空，不报错", () => {
    const empty: RunningHubWorkflowProfile = { ...profile, fields: [{ nodeId: "1", fieldName: "x", enabled: false }] };
    assert.deepEqual(runningHubProfileToConfig(empty).fields, []);
});
