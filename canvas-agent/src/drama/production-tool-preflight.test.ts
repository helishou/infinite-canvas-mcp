import assert from "node:assert/strict";
import test from "node:test";
import { productionToolPreflight, productionToolPreflightRequest } from "./production-tool-preflight.js";

test("production writes do not run a second automatic preflight", async () => {
    let calls = 0;
    for (const name of ["production_compile", "production_start_run"]) {
        assert.equal(productionToolPreflightRequest(name, { kind: "episode", id: "episode" }), undefined);
        assert.equal(await productionToolPreflight({ post: async () => { calls++; throw new Error("must not call"); } }, name, { kind: "episode", id: "episode" }), undefined);
    }
    assert.equal(calls, 0);
});

test("explicit callers can still use the Backend production_preflight tool", async () => {
    const response = { preflight: { valid: false, diagnostics: [{ code: "TARGET_OCCUPIED", severity: "error" }] } };
    assert.equal(await productionToolPreflight({ post: async () => response }, "production_preflight", { kind: "episode", id: "episode" }), undefined);
});
