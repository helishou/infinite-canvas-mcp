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
test("H3 reference and storyboard editor fields accept real UI patches and reject invalid container types", () => {
    assert.doesNotThrow(() => validateH3Edit({ h3CharacterGroups: {}, storyboardDurations: { board: 5 }, storyboardModeEnabled: true, storyboardCompositeEnabled: false, storyboardPromptCache: { version: 13 }, subjectDefinitions: [{ subjectId: "hero" }] }));
    for (const patch of [{ h3CharacterGroups: [] }, { storyboardDurations: "five" }, { storyboardPromptCache: null }, { storyboardModeEnabled: "true" }, { storyboardCompositeEnabled: 1 }, { subjectDefinitions: {} }]) assert.throws(() => validateH3Edit(patch), /INVALID_CLIP_FIELD/);
    assert.throws(() => validateH3Edit({ productionClipProjection: {} }), /不属于可编辑/);
});
