import assert from "node:assert/strict";
import test from "node:test";

import { useConfigStore, type AiConfig } from "./use-config-store";

/**
 * 「点生成却弹配置」的回归：本地 OpenAI 兼容服务（media-engine 这类）不需要 apiKey，
 * 只有 baseUrl 也应算配置完整；远端渠道缺 apiKey 仍然要提示。
 */
const ready = useConfigStore.getState().isAiConfigReady;

const config: AiConfig = {
    baseUrl: "",
    apiKey: "",
    apiFormat: "openai",
    model: "",
    models: [],
    channels: [
        {
            id: "engine-local",
            name: "执行引擎 media-engine",
            kind: "local",
            baseUrl: "http://127.0.0.1:8300",
            apiKey: "",
            apiFormat: "openai",
            models: [{ name: "2.1", capability: "image" }],
        },
        {
            id: "remote",
            name: "远端中转",
            kind: "api",
            baseUrl: "https://api.example.com",
            apiKey: "",
            apiFormat: "openai",
            models: [{ name: "gpt-image-1", capability: "image" }],
        },
    ],
} as unknown as AiConfig;

test("本地引擎渠道：没填 apiKey 也算就绪（不再弹配置）", () => {
    assert.equal(ready(config, "engine-local::2.1"), true);
});

test("远端渠道：缺 apiKey 仍然不就绪", () => {
    assert.equal(ready(config, "remote::gpt-image-1"), false);
});

test("渠道 baseUrl 为空时本地渠道也不就绪", () => {
    const blank = { ...config, channels: [{ ...config.channels[0], baseUrl: "" }] } as unknown as AiConfig;
    assert.equal(ready(blank, "engine-local::2.1"), false);
});
