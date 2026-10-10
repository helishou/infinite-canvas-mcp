import assert from "node:assert/strict";
import test from "node:test";
import axios from "axios";
import { defaultConfig, type AiConfig } from "@/stores/use-config-store";
import { requestGeneration } from "./image";

function config(apiFormat: "openai" | "gemini", quality: string, size: string): AiConfig {
    const model = apiFormat === "gemini" ? "gemini-2.5-flash-image" : "gpt-image-2";
    return { ...defaultConfig, model: `provider::${model}`, quality, size, count: "1", channels: [{ id: "provider", name: "test", apiFormat, apiKey: "test-key", baseUrl: "https://example.test", models: [{ name: model, capability: "image" }] }] };
}

test("image quality does not change explicit or ratio-derived dimensions", async (t) => {
    const requests: any[] = [];
    t.mock.method(axios, "post", async (_url: string, body: any) => {
        requests.push(body);
        return { data: { data: [{ b64_json: "test" }] } };
    });
    for (const quality of ["low", "high", "xhigh", "max"]) {
        await requestGeneration(config("openai", quality, "2048x1152"), "test");
        assert.equal(requests.at(-1).quality, quality);
        assert.equal(requests.at(-1).size, "2048x1152");
    }
    await requestGeneration(config("openai", "max", "1:1"), "test");
    assert.equal(requests.at(-1).size, "1024x1024");
});

test("Gemini receives a selected resolution on older image model names regardless of quality", async (t) => {
    const requests: any[] = [];
    t.mock.method(axios, "post", async (_url: string, body: any) => {
        requests.push(body);
        return { data: { candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: "test" } }] } }] } };
    });
    for (const [size, tier] of [["1536x864", "1K"], ["2048x1152", "2K"], ["3840x2160", "4K"]]) {
        await requestGeneration(config("gemini", "max", size), "test");
        assert.equal(requests.at(-1).generationConfig.imageConfig.imageSize, tier);
        assert.equal(requests.at(-1).generationConfig.imageConfig.aspectRatio, "16:9");
    }
    await requestGeneration(config("gemini", "high", "auto"), "test");
    assert.equal(requests.at(-1).generationConfig.imageConfig, undefined);
});
