// 视频工作台内部实现解析的测试。
//
// 视频侧原先只有通用参数；这里锁定「按场景命中内部实现 → 取出可填写字段 →
// 参数默认值取自渠道配置」这条链路，避免又退回成只显示通用项。
import assert from "node:assert/strict";
import test from "node:test";

import { initialVideoParamValues, videoParamKey } from "./video-implementation";
import type { WorkflowField } from "@/services/api/workflows";

const CHANNEL_ID = "local-comfyui";
const PROFILE_ID = "rh-1";

function config(models: unknown[]) {
    return { channels: [{ id: CHANNEL_ID, name: "本地 ComfyUI", kind: "comfyui", models }] } as never;
}

function field(id: string, extra: Partial<WorkflowField> = {}): WorkflowField {
    return { id, node: "1", input: id, name: id, type: "text", ...extra } as WorkflowField;
}

test("渠道按场景配的参数覆盖字段默认值", () => {
    const fields = [field("duration", { type: "number", default: 5 }), field("cfg", { type: "number", default: 0.5 })];
    const values = initialVideoParamValues(
        config([{ name: "云端生视频", capability: "video", workflowBindings: { text: { provider: "runninghub", profileId: PROFILE_ID } }, workflowParams: { text: { duration: 8 } } }]),
        `${CHANNEL_ID}::云端生视频`,
        0,
        fields,
    );
    assert.equal(values.duration, 8, "渠道配置应覆盖默认值");
    assert.equal(values.cfg, 0.5, "未覆盖的字段保留默认值");
});

test("渠道未配该场景时全部取字段默认值", () => {
    const fields = [field("duration", { type: "number", default: 5 })];
    const values = initialVideoParamValues(
        config([{ name: "云端生视频", capability: "video", workflowParams: { single: { duration: 3 } } }]),
        `${CHANNEL_ID}::云端生视频`,
        0,
        fields,
    );
    assert.equal(values.duration, 5, "文生场景不该拿到单图场景的参数");
});

test("字段没有默认值时不出现在初始值里，交给用户填", () => {
    const values = initialVideoParamValues(config([]), "任意模型", 0, [field("seed")]);
    assert.equal("seed" in values, false);
});

test("参数键按模型与实现隔离", () => {
    assert.equal(videoParamKey("ch::模型", "custom/a.json"), "ch::模型::custom/a.json");
    assert.notEqual(videoParamKey("ch::模型", "rh-1"), videoParamKey("ch::模型", "custom/a.json"));
});
