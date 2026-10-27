import test from "node:test";
import assert from "node:assert/strict";
import { orderReferencesForSubmission } from "./storyboard-reference-order.js";

const refs = [
    { id: "scene", role: "scene" },
    { id: "hero", role: "subject" },
    { id: "board-2", role: "storyboard" },
    { id: "prop", role: "prop" },
    { id: "board-1", role: "storyboard" },
];
const ordered = (referenceOrder?: string[]) => orderReferencesForSubmission(refs, ["board-1", "board-2"],
    ref => ref.id, ref => ref.role === "storyboard", ref => ref.role === "subject", referenceOrder).map(ref => ref.id);

test("default submission keeps storyboard shot order and subject-first fallback", () => {
    assert.deepEqual(ordered(), ["board-1", "board-2", "hero", "scene", "prop"]);
});

test("explicit Ref drag order takes precedence over subject-first fallback without changing storyboard order", () => {
    assert.deepEqual(ordered(["prop", "board-2", "scene", "hero", "board-1"]), ["board-1", "board-2", "prop", "scene", "hero"]);
    assert.deepEqual(ordered(["scene", "missing"]), ["board-1", "board-2", "scene", "hero", "prop"]);
});
