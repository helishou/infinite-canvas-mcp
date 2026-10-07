import assert from "node:assert/strict";
import test from "node:test";
import { productionToolPreflight, productionToolPreflightRequest } from "./production-tool-preflight.js";

test("compilation and both production owners share the same read-only gate", async () => {
    for (const [name, input, expected] of [
        ["production_start_run", { kind: "canvas", id: "c", expectedRevision: 2, workId: "work", runId: "new", targets: ["asset:A"] }, "/canvas/projects/c/production/preflight"],
        ["production_start_run", { kind: "episode", id: "e", expectedRevision: 2, runId: "new", targets: ["asset:A"] }, "/drama/episodes/e/production/preflight"],
    ] as const) {
        const calls: Array<{ path: string; body: any }> = [];
        const result = await productionToolPreflight({ post: async (path, body) => { calls.push({ path, body }); return { preflight: { valid: false, diagnostics: [{ code: "TARGET_OCCUPIED", severity: "error" }], nextActions: [{ action: "read_run", input: { runId: "original" } }] } }; } }, name, input);
        assert.equal(result?.status, "blocked");
        assert.equal(result?.mediaSubmitted, false);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].path, expected);
        assert.equal(calls[0].body.request.expectedRevision, 2);
        assert.equal(calls[0].body.request.workId, "workId" in input ? input.workId : undefined);
    }
    assert.equal(productionToolPreflightRequest("production_get", { kind: "episode", id: "e" }), undefined);
});

test("valid preflight allows execution while genuine preflight failures propagate", async () => {
    const input = { kind: "canvas", id: "c", expectedRevision: 1 };
    assert.equal(await productionToolPreflight({ post: async () => ({ preflight: { valid: true } }) }, "production_compile", input), undefined);
    await assert.rejects(() => productionToolPreflight({ post: async () => { throw new Error("network unavailable"); } }, "production_start_run", input), /network unavailable/);
    await assert.rejects(() => productionToolPreflight({ post: async () => ({ preflight: { valid: false, diagnostics: [{ code: "COMPILE_PREFLIGHT_UNAVAILABLE", message: "interpreter unavailable" }] } }) }, "production_start_run", input), /COMPILE_PREFLIGHT_UNAVAILABLE/);
});

test("compile submission does not run Python preflight on the request thread", async () => {
    assert.equal(await productionToolPreflight({ post: async () => { throw new Error("must not call"); } }, "production_compile", { operationId: "compile", id: "c", kind: "canvas" }), undefined);
});
