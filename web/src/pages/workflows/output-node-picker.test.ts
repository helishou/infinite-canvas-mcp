import assert from "node:assert/strict";
import test from "node:test";

import { lastOutputNodeId, normalizeOutputNodeSelection, pickerOutputNodeSelection } from "./output-node-picker.js";

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

test("default selection is the output node at the end of the chain, not the first one", () => {
    // 真实案例（终极资产图）：两个 PreviewImage 在上游，SaveImage 在链路末端。
    const graph = {
        "718": { class_type: "PreviewImage", inputs: { images: ["772", 0] } },
        "772": { class_type: "KSampler", inputs: {} },
        "380": { class_type: "PreviewImage", inputs: { images: ["718", 0] } },
        "684": { class_type: "ImageComposite", inputs: { a: ["718", 0] } },
        "743": { class_type: "SaveImage", inputs: { images: ["684", 0] } },
    };

    assert.equal(lastOutputNodeId(graph), "743");
    assert.deepEqual(pickerOutputNodeSelection([], graph), ["743"]);
});

test("deeper node wins over a larger id", () => {
    const graph = {
        "772": { class_type: "KSampler", inputs: {} },
        "684": { class_type: "ImageComposite", inputs: { a: ["772", 0] } },
        "380": { class_type: "PreviewImage", inputs: { images: ["684", 0] } },
        "743": { class_type: "SaveImage", inputs: { images: ["772", 0] } },
    };

    assert.equal(lastOutputNodeId(graph), "380", "380 在链路末端，编号更小也要选它");
});

test("an explicit clear is respected and defaults do not come back", () => {
    const graph = { "743": { class_type: "SaveImage", inputs: {} } };

    assert.deepEqual(pickerOutputNodeSelection([], graph, false, true), []);
    assert.deepEqual(pickerOutputNodeSelection(["743"], graph), ["743"]);
});

test("a configured selection is never replaced by the default", () => {
    const graph = {
        "380": { class_type: "PreviewImage", inputs: { images: ["772", 0] } },
        "772": { class_type: "KSampler", inputs: {} },
        "743": { class_type: "SaveImage", inputs: { images: ["380", 0] } },
    };

    assert.deepEqual(pickerOutputNodeSelection(["380"], graph), ["380"]);
});
