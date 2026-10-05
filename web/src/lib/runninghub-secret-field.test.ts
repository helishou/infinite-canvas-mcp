import assert from "node:assert/strict";
import test from "node:test";
import { keepTypedRunningHubSecret, runningHubSecretMask } from "./runninghub-secret-field.js";

test("a freshly typed key survives the masked save response", () => {
    assert.equal(keepTypedRunningHubSecret("newsessionkey0123456789abcdef", runningHubSecretMask), "newsessionkey0123456789abcdef");
});

test("an untouched masked field stays masked instead of looking empty", () => {
    assert.equal(keepTypedRunningHubSecret(runningHubSecretMask, runningHubSecretMask), runningHubSecretMask);
});

test("clearing the field clears it rather than restoring the mask", () => {
    assert.equal(keepTypedRunningHubSecret("", ""), "");
    assert.equal(keepTypedRunningHubSecret(runningHubSecretMask, ""), "");
});

test("a non-masked response is trusted when the field held the mask", () => {
    assert.equal(keepTypedRunningHubSecret(runningHubSecretMask, "server-value"), "server-value");
});

test("the mask is the exact sentinel the backend compares against", () => {
    assert.equal(runningHubSecretMask, "********");
    assert.equal(runningHubSecretMask.length, 8);
});
