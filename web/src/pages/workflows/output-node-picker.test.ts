import assert from "node:assert/strict";
import test from "node:test";

import { normalizeOutputNodeSelection } from "./output-node-picker.js";

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
