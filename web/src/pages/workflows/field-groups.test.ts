import assert from "node:assert/strict";
import test from "node:test";
import { groupWorkflowFields, reorderMediaFields } from "./field-groups";
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

test("reorderMediaFields reorders only media and keeps non-media positions", () => {
    const fields = [
        { id: "t1", type: "text" },
        { id: "img1", type: "image" },
        { id: "v1", type: "video" },
        { id: "img2", type: "image" },
        { id: "p1", type: "number" },
        { id: "img3", type: "image" },
    ] as WorkflowField[];
    const isMedia = (field: WorkflowField) => ["image", "video", "audio"].includes(field.type);
    const next = reorderMediaFields(fields, isMedia, (field) => field.id, ["img3", "img1", "v1", "img2"]);
    assert.deepEqual(next.map((field) => field.id), ["t1", "img3", "img1", "v1", "p1", "img2"]);
});

test("reorderMediaFields ignores ids absent from media and leaves order for empty list", () => {
    const fields = [
        { id: "img1", type: "image" },
        { id: "v1", type: "video" },
        { id: "img2", type: "image" },
    ] as WorkflowField[];
    const isMedia = (field: WorkflowField) => ["image", "video", "audio"].includes(field.type);
    const withGhost = reorderMediaFields(fields, isMedia, (field) => field.id, ["ghost", "img2", "img1", "v1"]);
    assert.deepEqual(withGhost.map((field) => field.id), ["img2", "img1", "v1"]);
    const empty = reorderMediaFields(fields, isMedia, (field) => field.id, []);
    assert.deepEqual(empty.map((field) => field.id), ["img1", "v1", "img2"]);
});
