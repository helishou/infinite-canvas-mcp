import assert from "node:assert/strict";
import test from "node:test";
import { planFlowOf, planFlowRows } from "./agent-plan-flow";

const planMessage = {
    id: "plan-1",
    role: "tool",
    detail: {
        kind: "todo",
        status: "inProgress",
        explanation: "正在拆分镜",
        tasks: [
            { step: "读剧本", status: "completed" },
            { step: "拆分镜", status: "inProgress" },
            { step: "出片", status: "pending" },
        ],
    },
};

test("总流程按模型给的顺序读出步骤与说明", () => {
    const flow = planFlowOf(planMessage);
    assert.ok(flow);
    assert.deepEqual(flow.steps.map((step) => step.step), ["读剧本", "拆分镜", "出片"]);
    assert.equal(flow.explanation, "正在拆分镜");
});

test("总流程给每步编号，并把状态归到已完成/进行中/未开始", () => {
    const rows = planFlowRows(planFlowOf(planMessage));
    assert.deepEqual(rows.map((row) => [row.index, row.label]), [[1, "读剧本"], [2, "拆分镜"], [3, "出片"]]);
    assert.deepEqual(rows.map((row) => row.tone), ["done", "running", "pending"]);
    assert.deepEqual(rows.map((row) => row.statusKey), ["agent.message.completed", "agent.message.running", "agent.message.notStarted"]);
});

test("不是待办的消息、空任务、空白步骤都不出总流程", () => {
    assert.equal(planFlowOf({ role: "tool", detail: { kind: "tool" } }), null);
    assert.equal(planFlowOf({ role: "assistant", detail: { kind: "todo", tasks: [{ step: "x", status: "pending" }] } }), null);
    assert.equal(planFlowOf({ role: "tool", detail: { kind: "todo", tasks: [{ step: "   ", status: "pending" }] } }), null);
    assert.equal(planFlowOf(undefined), null);
    assert.deepEqual(planFlowRows(null), []);
});
