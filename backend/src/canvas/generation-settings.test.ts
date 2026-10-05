import assert from "node:assert/strict";
import test from "node:test";
import { generationSettingsSnapshot } from "./generation-settings.js";

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
