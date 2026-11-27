import assert from "node:assert/strict";
import test from "node:test";

import { wouldWipeAiChannels } from "./ai-config-guard.js";

/** 防止一次带空 channels 的设置保存把全部渠道清空（常驻 bug：配置反复归零）。 */

const withChannels = {
    channels: [
        { id: "opencode-go", kind: "api", apiFormat: "openai-chat", baseUrl: "https://opencode.ai/v1", apiKey: "k", models: [{ name: "hy4-flash-free" }] },
    ],
};

test("incoming 无 channels（空对象/缺失）且当前有渠道 → 判定为清空，必须拦下", () => {
    assert.equal(wouldWipeAiChannels(withChannels, {}), true, "config:{} 会清空渠道");
    assert.equal(wouldWipeAiChannels(withChannels, { channels: [] }), true, "channels:[] 会清空渠道");
    assert.equal(wouldWipeAiChannels(withChannels, { imageModel: "x" }), true, "缺 channels 字段也会清空");
});

test("当前本就没有渠道时不算清空（允许首次写入）", () => {
    assert.equal(wouldWipeAiChannels({}, {}), false);
    assert.equal(wouldWipeAiChannels({ channels: [] }, { channels: [] }), false);
});

test("incoming 带非空 channels 时放行（正常改配置/换模型）", () => {
    assert.equal(wouldWipeAiChannels(withChannels, withChannels), false);
    assert.equal(wouldWipeAiChannels(withChannels, { channels: [{ id: "engine-local", baseUrl: "http://127.0.0.1:8300", models: [] }] }), false);
});
