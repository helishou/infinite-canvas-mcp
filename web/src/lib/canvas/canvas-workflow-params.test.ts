import assert from "node:assert/strict";
import test from "node:test";
import { reconcileWorkflowParams } from "./canvas-workflow-params";
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
