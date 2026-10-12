import assert from "node:assert/strict";
import test from "node:test";
import { groupWorkflowFields } from "./field-groups";
import type { WorkflowField } from "@/services/api/workflows";

test("workflow groups preserve every mapped field, identity and defaults", () => {
    const types = ["text", "image", "video", "audio", "dropdown", "boolean", "number", "custom"];
    const fields = types.map((type, index) => ({ id: String(index), type, name: type, node: "2,3", input: "value", default: "unchanged" })) as WorkflowField[];
    const groups = groupWorkflowFields(fields);
    assert.deepEqual(groups.map(group => group.key), ["content", "media", "parameters"]);
    assert.equal(groups.flatMap(group => group.fields).length, fields.length);
    fields.forEach(field => assert.equal(groups.flatMap(group => group.fields).find(item => item.id === field.id), field));
    assert.deepEqual(groups[1].fields.map(field => field.type), ["image", "video", "audio"]);
    assert.deepEqual(groups[2].fields.map(field => field.type), ["dropdown", "boolean", "number", "custom"]);
});
test("empty workflow groups create no empty input sections", () => assert.deepEqual(groupWorkflowFields([]), []));
