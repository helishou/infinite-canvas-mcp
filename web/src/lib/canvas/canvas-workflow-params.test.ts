import assert from "node:assert/strict";
import test from "node:test";
import { reconcileWorkflowParams, workflowAspectOption } from "./canvas-workflow-params";
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
