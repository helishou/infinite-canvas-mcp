import assert from "node:assert/strict";
import test from "node:test";

import { selectAvailableAgentModel } from "./agent-model-selection.js";
import type { AgentModel } from "@/stores/use-agent-store";

const models: AgentModel[] = [
    { id: "gpt-5.6-sol", model: "gpt-5.6-sol", displayName: "GPT-5.6 Sol", isDefault: true, defaultReasoningEffort: "low", supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }] },
    { id: "gpt-5.6-luna", model: "gpt-5.6-luna", displayName: "GPT-5.6 Luna", defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "medium" }] },
];

test("falls back to the connected service default when saved model is unavailable", () => {
    const selected = selectAvailableAgentModel(models, "gpt-6-luna", "high");
    assert.equal(selected.model, "gpt-5.6-sol");
    assert.equal(selected.reasoningEffort, "high");
});

test("uses the selected model's supported effort and clears stale catalog", () => {
    assert.equal(selectAvailableAgentModel(models, "gpt-5.6-luna", "ultra").reasoningEffort, "medium");
    assert.deepEqual(selectAvailableAgentModel([], "gpt-6-luna", "medium"), { models: [], model: "", reasoningEffort: "" });
});
