import assert from "node:assert/strict";
import test from "node:test";

import { engineMismatch, modelEngine, rememberedModelForEngine, rememberModelByEngine, type AgentEngine } from "./agent-engine-memory.js";
import type { AgentModel } from "@/stores/use-agent-store";

const model = (runtime: AgentModel["runtime"], name: string, isDefault = false): AgentModel => ({
    id: name, model: name, displayName: name, runtime,
    defaultReasoningEffort: "", supportedReasoningEfforts: [], isDefault,
});

const catalog: AgentModel[] = [
    model("hermes", "hermes-local::deepseek", true),
    model("hermes", "hermes-local::longcat"),
    model("codex", "gpt-5.0-luna", true),
];

test("modelEngine maps codex-cli and native codex to codex, hermes to hermes", () => {
    assert.equal(modelEngine(model("hermes", "x")), "hermes");
    assert.equal(modelEngine(model("codex", "x")), "codex");
    assert.equal(modelEngine(model("llm", "x")), "");
    assert.equal(modelEngine(undefined), "");
});

test("rememberedModelForEngine uses per-engine memory and stays inside the engine", () => {
    assert.equal(rememberedModelForEngine(catalog, "hermes", { hermes: "hermes-local::longcat" }), "hermes-local::longcat");
    // 记住的模型属于别的渠道时不能串台，回落到该渠道默认
    assert.equal(rememberedModelForEngine(catalog, "hermes", { hermes: "gpt-5.0-luna" }), "hermes-local::deepseek");
    // 无记忆时沿用属于该渠道的全局上次模型，不跳到默认
    assert.equal(rememberedModelForEngine(catalog, "hermes", {}, "hermes-local::longcat"), "hermes-local::longcat");
    assert.equal(rememberedModelForEngine(catalog, "hermes", {}, "gpt-5.0-luna"), "hermes-local::deepseek");
    assert.equal(rememberedModelForEngine(catalog, "codex", {}), "gpt-5.0-luna");
    assert.equal(rememberedModelForEngine(catalog, "codex", { codex: "gone" }), "gpt-5.0-luna");
    assert.equal(rememberedModelForEngine(catalog, "hermes", undefined), "hermes-local::deepseek");
    assert.equal(rememberedModelForEngine([], "hermes", {}), "");
});

test("rememberModelByEngine records under the model's own engine", () => {
    const next = rememberModelByEngine({ hermes: "old" }, model("codex", "gpt-5.0-luna"));
    assert.deepEqual(next, { hermes: "old", codex: "gpt-5.0-luna" });
    assert.deepEqual(rememberModelByEngine({ codex: "x" }, model("llm", "ignored")), { codex: "x" });
});

test("engineMismatch detects cross-runtime thread vs chosen channel", () => {
    assert.equal(engineMismatch("hermes-uuid", "codex"), true);
    assert.equal(engineMismatch("hermes-uuid", "hermes"), false);
    assert.equal(engineMismatch("plain-codex-thread", "codex"), false);
    assert.equal(engineMismatch("plain-codex-thread", "hermes"), true);
    assert.equal(engineMismatch("", "codex"), false);
});
