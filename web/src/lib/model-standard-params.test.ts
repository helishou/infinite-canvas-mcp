import assert from "node:assert/strict";
import test from "node:test";
import { resolvePresetFieldIds, type ModelStandardParams } from "./model-standard-params.js";
import type { WorkflowField } from "@/types/workflow";

const field = (id: string, input: string, extra: Partial<WorkflowField> = {}): WorkflowField =>
    ({ id, node: "1", input, name: id, type: "number", ...extra });

test("roles map width/height/frames to their field ids", () => {
    const fields = [
        field("width", "width"),
        field("height", "height"),
        field("frames", "length"),
        field("seed", "noise_seed"),
    ];
    const standard: ModelStandardParams = {
        supported: ["size", "seed"],
        roles: [
            { role: "width", field: "width", openai_param: "size", bound: true },
            { role: "height", field: "height", openai_param: "size", bound: true },
            { role: "frames", field: "frames", bound: true },
            { role: "seed", field: "seed", openai_param: "seed", bound: true },
            { role: "width", field: "other_unbound", bound: false },
        ],
    };
    assert.deepEqual(resolvePresetFieldIds(fields, standard), { width: "width", height: "height", seconds: "frames" });
});

test("falls back to field input names when standard params are missing", () => {
    const fields = [field("f1", "width"), field("f2", "height"), field("f3", "duration")];
    assert.deepEqual(resolvePresetFieldIds(fields, null), { width: "f1", height: "f2", seconds: "f3" });
});

test("returns empty mapping when no size or duration field exists", () => {
    assert.deepEqual(resolvePresetFieldIds([field("seed", "noise_seed")], null), { width: undefined, height: undefined, seconds: undefined });
});
