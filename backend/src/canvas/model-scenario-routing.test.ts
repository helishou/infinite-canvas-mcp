// 模型弹窗的场景路由解析测试。
//
// 「不支持」是显式声明的场景状态，必须优先于任何实现绑定；否则用户在场景
// 下拉里选了「不支持」，回填时又被绑定覆盖回该实现，表现为「点不了」。
import assert from "node:assert/strict";
import test from "node:test";

import { resolveWorkflowBindingForModel, WORKFLOW_ROUTE_UNSUPPORTED } from "../canvas/model-workflow.js";

const PROFILE_ID = "2efeb650-2c9f-494b-80af-1e5c661c4730";

/** 复现弹窗 effectiveKeys 的判定顺序：不支持 > 绑定 > 旧 routing 回落。 */
function effectiveScenario(
    model: { workflows?: string[]; workflowRouting?: Record<string, string>; workflowBindings?: Record<string, { provider: string; profileId?: string; workflow?: string }> },
    scenario: "text" | "single" | "multi",
) {
    const routed = model.workflowRouting?.[scenario];
    if (routed === WORKFLOW_ROUTE_UNSUPPORTED) return WORKFLOW_ROUTE_UNSUPPORTED;
    const bound = model.workflowBindings?.[scenario];
    if (bound) return bound.provider === "runninghub" ? `runninghub::${bound.profileId}` : `local::${bound.workflow}`;
    return routed ? `local::${routed}` : "";
}

test("routing 标记不支持时，不再被同场景的绑定覆盖", () => {
    const model = {
        workflows: [],
        workflowRouting: { multi: WORKFLOW_ROUTE_UNSUPPORTED },
        workflowBindings: { multi: { provider: "runninghub", profileId: PROFILE_ID } },
    };
    assert.equal(effectiveScenario(model, "multi"), WORKFLOW_ROUTE_UNSUPPORTED);
});

test("没有不支持标记时，绑定生效", () => {
    // 不支持标记只作用于它自己那个场景，不影响其它场景的绑定。
    const model = {
        workflows: [],
        workflowRouting: { multi: WORKFLOW_ROUTE_UNSUPPORTED },
        workflowBindings: { text: { provider: "runninghub", profileId: PROFILE_ID } },
    };
    assert.equal(effectiveScenario(model, "text"), `runninghub::${PROFILE_ID}`);
    assert.equal(effectiveScenario(model, "multi"), WORKFLOW_ROUTE_UNSUPPORTED);
});

test("只有旧 routing 时按本地工作流回落", () => {
    const model = { workflows: ["custom/a.json"], workflowRouting: { single: "custom/a.json" } };
    assert.equal(effectiveScenario(model, "single"), "local::custom/a.json");
});

test("后端解析器与弹窗判定一致：不支持优先于绑定", () => {
    const config = {
        channels: [
            {
                id: "rh",
                name: "RunningHub",
                kind: "comfyui",
                models: [
                    {
                        name: "云端生视频",
                        capability: "video",
                        workflows: [],
                        workflowRouting: { multi: WORKFLOW_ROUTE_UNSUPPORTED },
                        workflowBindings: { multi: { provider: "runninghub", profileId: PROFILE_ID } },
                    },
                ],
            },
        ],
    };
    // 2 张参考 = multi 场景：必须是不支持，而不是云端档案。
    const resolved = resolveWorkflowBindingForModel(config, "云端生视频", 2);
    assert.equal(resolved.ok, false);
    assert.equal(!resolved.ok && resolved.reason, "unsupported");
});
