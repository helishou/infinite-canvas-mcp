import assert from "node:assert/strict";
import test from "node:test";

import { buildApiUrl, defaultConfig, useConfigStore } from "./use-config-store";

test("old exports retain provider settings but cannot reactivate the retired proxy", () => {
    const original = useConfigStore.getState().config;
    const imported = {
        ...defaultConfig,
        channels: [{ id: "provider", name: "Provider", baseUrl: "https://provider.example/v1", apiKey: "test-key", apiFormat: "openai" as const, models: [{ name: "custom-model", capability: "text" as const }] }],
        textModel: "provider::custom-model",
        proxyEnabled: true,
        proxyUrl: "http://127.0.0.1:23210",
    };
    try {
        useConfigStore.getState().replaceConfig(imported);
        const config = useConfigStore.getState().config;
        assert.equal(config.channels.length, 1);
        assert.equal(config.channels[0].baseUrl, imported.channels[0].baseUrl);
        assert.equal(config.channels[0].apiKey, imported.channels[0].apiKey);
        assert.equal(config.channels[0].models[0].name, "custom-model");
        assert.equal(config.channels[0].models[0].capability, "text");
        assert.equal(config.textModel, imported.textModel);
        const exported = JSON.parse(JSON.stringify(config));
        assert.equal(Object.hasOwn(exported, "proxyEnabled"), false);
        assert.equal(Object.hasOwn(exported, "proxyUrl"), false);
        assert.equal(buildApiUrl(config.channels[0].baseUrl, "/models"), "https://provider.example/v1/models");
        useConfigStore.getState().updateConfig("audioVoice", "nova");
        assert.equal(Object.hasOwn(useConfigStore.getState().config, "proxyUrl"), false);
    } finally {
        useConfigStore.setState({ config: original });
    }
});

test("provider and Backend URLs keep their configured origin and API prefix", () => {
    assert.equal(buildApiUrl("https://provider.example/", "/images/generations"), "https://provider.example/v1/images/generations");
    assert.equal(buildApiUrl("https://provider.example/v1/", "/chat/completions"), "https://provider.example/v1/chat/completions");
    assert.equal(buildApiUrl("http://127.0.0.1:17370", "/models"), "http://127.0.0.1:17370/v1/models");
});
