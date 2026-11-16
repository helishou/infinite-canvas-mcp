import assert from "node:assert/strict";
import test from "node:test";

import { findChannelConfig, findEngineChannel, isEngineModel } from "./engine-channel.js";

/** 引擎渠道解析：模型名 → 渠道 baseUrl/token。渠道是唯一配置入口，不再有全局开关。 */

const CONFIG = {
    channels: [
        { id: "local", kind: "comfyui", models: [{ name: "2.1", workflows: ["a.json"] }] },
        { id: "eng", kind: "local", apiFormat: "openai", baseUrl: "http://127.0.0.1:8300/", apiKey: "tok", models: [{ name: "2.1", capability: "image" }, { name: "H3 高速大动态", capability: "video" }] },
        { id: "nokey", kind: "local", apiFormat: "openai", baseUrl: "http://127.0.0.1:8400", models: [{ name: "裸引擎", capability: "image" }] },
        { id: "no-url", kind: "local", apiFormat: "openai", models: [{ name: "没地址", capability: "image" }] },
        { id: "gem", kind: "local", apiFormat: "gemini", baseUrl: "http://127.0.0.1:8500", models: [{ name: "gemini-pro", capability: "image" }] },
    ],
};

test("渠道 id 前缀优先：同一个模型名在多个渠道时按 channelId 定位", () => {
    assert.deepEqual(findEngineChannel(CONFIG, "eng::2.1"), {
        channelId: "eng",
        baseUrl: "http://127.0.0.1:8300",
        token: "tok",
        model: "2.1",
    });
    // 没有前缀时按模型名找，命中的是引擎渠道
    assert.equal(findEngineChannel(CONFIG, "H3 高速大动态")?.baseUrl, "http://127.0.0.1:8300");
});

test("不是引擎渠道 / 缺 baseUrl 时返回 null（回落原有执行器）", () => {
    assert.equal(findEngineChannel(CONFIG, "local::2.1"), null, "comfyui 渠道不走引擎");
    assert.equal(findEngineChannel(CONFIG, "gem::gemini-pro"), null, "gemini 不走 OpenAI 客户端");
    assert.equal(findEngineChannel(CONFIG, "没地址"), null, "引擎渠道缺 baseUrl = 未配置");
    assert.equal(findEngineChannel(CONFIG, "不存在的模型"), null);
    assert.equal(findEngineChannel(null, "2.1"), null);
});

test("token 可缺省；isEngineModel 与 findEngineChannel 判定一致", () => {
    assert.equal(findEngineChannel(CONFIG, "nokey::裸引擎")?.token, undefined);
    assert.equal(isEngineModel(CONFIG, "eng::2.1"), true);
    assert.equal(isEngineModel(CONFIG, "local::2.1"), false);
});

test("findChannelConfig 带出 apiFormat 与 extraBody（渠道级自定义参数）", () => {
    const withExtra = {
        channels: [
            { id: "eng", kind: "local", apiFormat: "openai", baseUrl: "http://127.0.0.1:8300", extraBody: { params: { 加速: true } }, models: [{ name: "2.1" }] },
        ],
    };
    const channel = findChannelConfig(withExtra, "eng::2.1");
    assert.equal(channel?.apiFormat, "openai");
    assert.deepEqual(channel?.extraBody, { params: { 加速: true } });
});
