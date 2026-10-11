// 模型选项标签的实现来源判定测试。
//
// ComfyUI 渠道里的模型可以挂 RunningHub 档案作为内部实现；只显示渠道名会
// 让「模型名（本地 ComfyUI）」配上一个实际走云端的实现，看着像本地跑。
import assert from "node:assert/strict";
import test from "node:test";

const CHANNEL_ID = "local-comfyui";

type Binding = { provider: "comfyui"; workflow: string } | { provider: "runninghub"; profileId: string };
type Model = { name: string; workflowBindings?: Partial<Record<"text" | "single" | "multi", Binding>> };

function modelImplementationSource(model: Model | undefined): "runninghub" | "comfyui" | null {
    if (!model) return null;
    const bindings = Object.values(model.workflowBindings || {});
    return bindings.some((binding) => binding?.provider === "runninghub") ? "runninghub" : "comfyui";
}

test("任一场景绑定 RunningHub 即视为云端实现", () => {
    const model: Model = {
        name: "h3生视频RH",
        workflowBindings: {
            text: { provider: "runninghub", profileId: "rh-1" },
            multi: { provider: "comfyui", workflow: "custom/h3-local-t2va.json" },
        },
    };
    assert.equal(modelImplementationSource(model), "runninghub");
});

test("只挂本地工作流时仍是 comfyui", () => {
    const model: Model = {
        name: "krea2",
        workflowBindings: { text: { provider: "comfyui", workflow: "custom/Krea2文生图.json" } },
    };
    assert.equal(modelImplementationSource(model), "comfyui");
});

test("没有任何绑定时按 comfyui 处理（渠道本身就是工作流渠道）", () => {
    assert.equal(modelImplementationSource({ name: "裸模型" }), "comfyui");
});

test("bindings 为空对象时不误判成云端", () => {
    assert.equal(modelImplementationSource({ name: "空绑定", workflowBindings: {} }), "comfyui");
});

test("找不到模型时返回 null，由调用方回退到渠道名", () => {
    assert.equal(modelImplementationSource(undefined), null);
});
