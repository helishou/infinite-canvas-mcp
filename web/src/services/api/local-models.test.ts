import assert from "node:assert/strict";
import test from "node:test";

import { shouldProxyLocalModelList } from "./local-models.js";

test("local OpenAI-compatible model lists use the backend proxy, not browser CORS", () => {
    for (const baseUrl of [
        "http://127.0.0.1:8080/v1",
        "http://127.42.1.9:11434/v1",
        "http://localhost:8080/v1",
        "http://[::1]:8080/v1",
    ]) {
        assert.equal(shouldProxyLocalModelList(baseUrl, "openai"), true, baseUrl);
        assert.equal(shouldProxyLocalModelList(baseUrl, "openai-chat"), true, baseUrl);
    }

    assert.equal(shouldProxyLocalModelList("http://127.0.0.1:8080/v1", "gemini"), false);
    assert.equal(shouldProxyLocalModelList("https://api.example.com/v1", "openai"), false);
    assert.equal(shouldProxyLocalModelList("not a url", "openai"), false);
    assert.equal(shouldProxyLocalModelList("http://0.0.0.0:8080/v1", "openai"), false);
});
