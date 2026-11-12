import assert from "node:assert/strict";
import test from "node:test";
import { reconcileWorkflowParams, workflowAspectOption, workflowDimensionSize } from "./canvas-workflow-params";
import type { WorkflowField } from "@/services/api/workflows";

const fields: WorkflowField[] = [{ id: "steps", node: "1", input: "steps", name: "步数", type: "number", default: 20 }];

test("remount keeps user parameters and does not schedule an identical update", () => {
    const current = { steps: 30 };
    assert.equal(reconcileWorkflowParams(current, fields, { steps: 10 }, false), current);
    assert.equal(reconcileWorkflowParams(current, fields, { steps: 30 }, true), current);
});

test("workflow switch resets parameters and removes obsolete fields", () => {
    assert.deepEqual(reconcileWorkflowParams({ steps: 30, stale: true }, fields, { steps: 10 }, true), { steps: 10 });
    assert.deepEqual(reconcileWorkflowParams({ steps: 30 }, [], {}, true), {});
});

test("null channel defaults converge instead of triggering another update", () => {
    const next = reconcileWorkflowParams(undefined, fields, { steps: null }, false);
    assert.deepEqual(next, { steps: 20 });
    assert.equal(reconcileWorkflowParams(next, fields, { steps: null }, false), next);
    assert.equal(reconcileWorkflowParams(undefined, [], {}, false), undefined);
});

test("canvas 16:9 size reaches a workflow aspect_ratio field without overriding a chosen value", () => {
    const aspect: WorkflowField = {
        id: "f_1790686390394_nzk9", node: "11", input: "aspect_ratio", name: "Aspect ratio", type: "dropdown",
        default: "9:16 (Portrait Widescreen)", options: ["1:1 (Square)", "9:16 (Portrait Widescreen)", "16:9 (Widescreen)"],
    };
    assert.deepEqual(reconcileWorkflowParams(undefined, [aspect], {}, false, "16:9"), { [aspect.id]: "16:9 (Widescreen)" });
    assert.equal(workflowAspectOption(aspect, undefined, undefined, "2048x1152"), "16:9 (Widescreen)");
    const chosen = { [aspect.id]: "1:1 (Square)" };
    assert.equal(reconcileWorkflowParams(chosen, [aspect], {}, false, "16:9"), chosen);
    assert.deepEqual(reconcileWorkflowParams(undefined, [aspect], { [aspect.id]: "1:1 (Square)" }, false, "16:9"), chosen);
});

test("workflow width/height fields define the canvas size", () => {
    const dimensionFields: WorkflowField[] = [
        { id: "width", node: "301", input: "width", name: "宽", type: "number", default: 1920 },
        { id: "height", node: "301", input: "height", name: "高", type: "number", default: 1024 },
    ];
    assert.equal(workflowDimensionSize(dimensionFields, undefined), "1920x1024");
    assert.equal(workflowDimensionSize(dimensionFields, { width: 1024, height: 1824 }), "1024x1824");
    assert.equal(workflowDimensionSize(dimensionFields, { width: 2048 }), "2048x1024");
    // 参数由字段默认值铺开时，画布尺寸也要跟着落成同一组像素，而不是保留节点上的旧尺寸。
    const reconciled = reconcileWorkflowParams(undefined, dimensionFields, {}, false, "1024x1824");
    assert.equal(workflowDimensionSize(dimensionFields, reconciled), "1920x1024");
    // 只有宽或只有高、值非法、字段不映射 width/height 时不接管画布尺寸。
    assert.equal(workflowDimensionSize(dimensionFields.slice(0, 1), {}), undefined);
    assert.equal(workflowDimensionSize(dimensionFields, { width: 0, height: 1024 }), undefined);
    assert.equal(workflowDimensionSize([{ ...dimensionFields[0], id: "custom_width", input: "custom_width" }], { custom_width: 2048 }), undefined);
});
