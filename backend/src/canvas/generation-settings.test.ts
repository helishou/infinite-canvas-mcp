import assert from "node:assert/strict";
import test from "node:test";
import { generationSettingsSnapshot, workflowGenerationSettingsSnapshot } from "./generation-settings.js";

test("generation settings map custom workflow fields to labels and exclude credential/media inputs", () => {
    const settings = generationSettingsSnapshot({
        "f_width": 1024,
        "f_negative": "avoid blur",
        "f_api": "secret-value",
        "f_reference": "data:image/png;base64,AAAA",
        seed: 42,
    }, { count: 1 }, [
        { id: "f_width", name: "Output width", input: "width", node: "5", type: "number" },
        { id: "f_negative", name: "Negative prompt", input: "negative_prompt", node: "10", type: "text" },
        { id: "f_api", name: "API key", input: "api_key", node: "5", type: "text" },
        { id: "f_reference", name: "Reference image", input: "image", node: "20", type: "image" },
    ]);

    assert.deepEqual(settings, {
        seed: 42,
        count: 1,
        workflowParameters: { "Output width": 1024, "Negative prompt": "avoid blur" },
    });
});

test("workflow settings keep custom fields and omit generic routing controls", () => {
    const settings = workflowGenerationSettingsSnapshot({
        channelId: "private-channel-id",
        writeBackToTarget: true,
        seed: 42,
        f_width: 1024,
        f_api: "secret-value",
    }, [
        { id: "f_width", name: "Output width", input: "width", node: "5", type: "number" },
        { id: "f_api", name: "API key", input: "api_key", node: "5", type: "text" },
    ]);

    assert.deepEqual(settings, { seed: 42, workflowParameters: { "Output width": 1024 } });
});

test("unknown stale field IDs are not exposed as parameter names", () => {
    const settings = workflowGenerationSettingsSnapshot({ f_1790654100611_5uap: "柔光" }, [
        { id: "f_current", name: "Template", input: "template", node: "25", type: "dropdown" },
    ]);

    assert.deepEqual(settings, {});
});

test("historical field IDs display their renamed field name and source workflow", () => {
    const settings = workflowGenerationSettingsSnapshot({ f_1790654100611_5uap: "柔光" }, [{
        id: "f_1790654100611_5uap", name: "Template", input: "template", node: "25", type: "dropdown",
        sourceWorkflow: "custom/2.1文生图.json",
    }] as never);

    assert.deepEqual(settings, { workflowParameters: { "Template · 2.1文生图": "柔光" } });
});
