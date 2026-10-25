import assert from "node:assert/strict";
import test from "node:test";

import { normalizeOutputNodeSelection, pickerOutputNodeSelection } from "./output-node-picker.js";

test("output selection drops node IDs that are no longer visible in the workflow graph", () => {
    const graph = {
        "214": { class_type: "VHS_VideoCombine" },
        "264": { class_type: "VHS_VideoCombine" },
        "328": { class_type: "VHS_VideoCombine" },
    };

    assert.deepEqual(normalizeOutputNodeSelection(["31", "264"], graph), ["264"]);
});

test("an empty output selection stays empty", () => {
    assert.deepEqual(normalizeOutputNodeSelection([], { "264": { class_type: "VHS_VideoCombine" } }), []);
});

test("RunningHub output candidates exclude SaveImageToLocal while retaining other save nodes", () => {
    const graph = {
        "967": { class_type: "SaveImage" },
        "980": { class_type: "SaveImageToLocal" },
        "981": { class_type: "SaveImageToLocal", _meta: { title: "Save Image To Local" } },
    };

    assert.deepEqual(normalizeOutputNodeSelection(["967", "980", "981"], graph, true), ["967"]);
    assert.deepEqual(normalizeOutputNodeSelection(["967", "980", "981"], graph), ["967", "980", "981"]);
});

test("the only output candidate is selected by default, but an explicit clear stays clear", () => {
    const graph = { "967": { class_type: "SaveImage" }, "980": { class_type: "SaveImageToLocal" } };

    assert.deepEqual(pickerOutputNodeSelection([], graph, true), ["967"]);
    assert.deepEqual(pickerOutputNodeSelection([], graph, true, true), []);
    assert.deepEqual(pickerOutputNodeSelection([], { "980": { class_type: "SaveImageToLocal" } }, true), []);
});
