import assert from "node:assert/strict";
import test from "node:test";
import { defaultDirectorReviewPolicy, directorReviewPolicySchema, resolveDirectorReviewPolicy } from "./production-contract.js";

test("missing review settings resolve to no required review", () => {
    assert.deepEqual(resolveDirectorReviewPolicy(), defaultDirectorReviewPolicy);
    assert.deepEqual(directorReviewPolicySchema.parse(defaultDirectorReviewPolicy), defaultDirectorReviewPolicy);
});

test("explicit review modes remain available and mixed policy must select both gates", () => {
    assert.equal(resolveDirectorReviewPolicy({ mode: "manual", shared: "manual", scene: "manual" }).mode, "manual");
    assert.equal(resolveDirectorReviewPolicy({ mode: "automatic", shared: "automatic", scene: "automatic" }).mode, "automatic");
    assert.throws(() => directorReviewPolicySchema.parse({ mode: "mixed", shared: "none", scene: "automatic" }));
});
