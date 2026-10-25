import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { canonicalProduction } from "@basketikun/canvas-agent/drama/production-contract";
import { compilationInputsUnchanged } from "./compilation.js";

const hash = (value: unknown) => crypto.createHash("sha256").update(canonicalProduction(value)).digest("hex");
const engine = (runtimeId: string) => ({ commit: "a".repeat(40), patchVersion: "test", runtimeId, version: "test" });

function director(input: { runtimeId: string; brief?: string }) {
    return {
        schemaVersion: 1, engine: engine(input.runtimeId),
        source: {
            version: 2, prompt_assembly: { version: 2 }, brief: input.brief ?? "source", fps_num: 24, fps_den: 1,
            subject_registry: [], character_registry: [], scene_registry: [], shots: [], segments: [], utterances: [],
            asset_plan: [], asset_cards: [], ledger: { contract_version: 2, facts: [], timelines: [], initial: [], events: [], requirements: [], coverage: [] },
        },
        sourceHash: "b".repeat(64), modules: {}, artifacts: [], assets: {}, shotInputs: {}, boundaries: [],
        executionAuthorized: false, unresolved: [], workflow: {},
    } as any;
}

test("a compiler activated before the request does not invalidate its own result", () => {
    // The draft still carries the runtime of the last applied compilation; the request
    // captured the newly activated runtime. This used to block with COMPILATION_INPUT_CHANGED.
    const draft = director({ runtimeId: "runtime-old" });
    const activeInput = director({ runtimeId: "runtime-new" });
    assert.equal(compilationInputsUnchanged(
        { engineRuntimeId: "runtime-new", compilerInputFingerprint: "manifest", baselineHash: hash(draft) },
        { director: draft, input: activeInput, manifestHash: "manifest", activeRuntimeId: "runtime-new" },
    ), true);
});

test("a runtime switched while the job runs still blocks", () => {
    const draft = director({ runtimeId: "runtime-old" });
    const frozenInput = director({ runtimeId: "runtime-new" });
    assert.equal(compilationInputsUnchanged(
        { engineRuntimeId: "runtime-new", compilerInputFingerprint: "manifest", baselineHash: hash(draft) },
        { director: draft, input: frozenInput, manifestHash: "manifest", activeRuntimeId: "runtime-third" },
    ), false);
});

test("changed target input or a concurrent source edit still blocks", () => {
    const draft = director({ runtimeId: "runtime-new" });
    const input = director({ runtimeId: "runtime-new" });
    const identity = { engineRuntimeId: "runtime-new", compilerInputFingerprint: "manifest", baselineHash: hash(draft) };
    assert.equal(compilationInputsUnchanged(identity, { director: draft, input, manifestHash: "other" }), false);
    const edited = director({ runtimeId: "runtime-new", brief: "changed while compiling" });
    assert.equal(compilationInputsUnchanged(identity, { director: edited, input, manifestHash: "manifest" }), false);
});
