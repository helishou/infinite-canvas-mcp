import test from "node:test";
import assert from "node:assert/strict";
import { validateNodeUpdate, validateH3Edit } from "./edit-validation.js";
import { toolInputSchemas } from "./schemas.js";
test("node updates reject misspelled fields, invalid types and empty edits before writing", () => {
    assert.throws(() => validateNodeUpdate({ patch: { widht: 100 } }));
    assert.throws(() => validateNodeUpdate({ patch: { width: "100" } }));
    assert.throws(() => validateNodeUpdate({ patch: {} }), /必须包含/);
    assert.throws(() => validateNodeUpdate({ patch: { position: { x: 1, y: 2 }, x: 4 } }), /不能同时/);
    assert.deepEqual(validateNodeUpdate({ patch: { x: 10 } }, { position: { x: 1, y: 20 } }), { position: { x: 10, y: 20 } });
    assert.equal(toolInputSchemas.canvas_update_node.safeParse({ id: "n", patch: { title: "title" }, unexpected: true }).success, false);
});
test("H3 edits reject unknown fields, booleans as strings and invalid modes", () => {
    assert.throws(() => validateH3Edit({ promt: "bad" }), /patch.promt/);
    assert.throws(() => validateH3Edit({ motionContextEnabled: "false" }), /boolean/);
    assert.throws(() => validateH3Edit({ taskMode: "no-mode" }), /taskMode/);
    assert.doesNotThrow(() => validateH3Edit({ prompt: "ordinary Clip", motionContextEnabled: false, duration: 5 }));
});
