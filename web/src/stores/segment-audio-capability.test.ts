import assert from "node:assert/strict";
import { test } from "node:test";
import type { AiConfig } from "./use-config-store";

// Config/i18n 在模块初始化时读浏览器存储；与 model-video-capability.test.ts 同一套 shim。
const values = new Map<string, string>();
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
    },
});

const { modelVideoCapabilitiesOf, modelCapabilityOf, useConfigStore } = await import("./use-config-store");

function configWith(channels: Array<{ id: string; models: Array<Record<string, unknown>> }>): AiConfig {
    return {
        channels: channels.map((c) => ({ ...c, name: c.id, baseUrl: "http://127.0.0.1:8300", apiKey: "", apiFormat: "openai", kind: "local" })),
    } as unknown as AiConfig;
}

/** 段弹窗声音行的渲染判据（studio-detail-panel.tsx:2556）：只有 boolean 真值才渲染整行。 */
function soundRowText(config: AiConfig, segmentModel: string): string | null {
    const audio = modelVideoCapabilitiesOf(config, segmentModel).generateAudio;
    if (typeof audio !== "boolean") return null;
    return audio ? "模型同步生成对白与音效" : "所选模型不出声，本段视频没有对白与音效";
}

const HAS_SOUND = "模型同步生成对白与音效";
const NO_SOUND = "所选模型不出声，本段视频没有对白与音效";

const registered = configWith([{
    id: "engine-local",
    models: [
        { name: "H3 展开流", capability: "video", generateAudio: true, maxAudios: 2 },
        { name: "视频flashvsr", capability: "video", generateAudio: false, maxAudios: 0 },
        // 真实库里 local-comfyui::武戏 22 条、xq3...::YZ金鱼 9 条，渠道 id 已失效。
        { name: "武戏", capability: "video", generateAudio: true },
        { name: "YZ金鱼", capability: "video", generateAudio: true },
    ],
}]);

test("精确匹配的优先级不变：带正确 channelId 时仍只认该渠道的模型能力", () => {
    assert.equal(soundRowText(registered, "engine-local::H3 展开流"), HAS_SOUND);
    assert.equal(soundRowText(registered, "engine-local::视频flashvsr"), NO_SOUND);
    // 同名模型在多个渠道存在时，channelId 精确命中优先于「第一个同名」回退。
    const twoChannels = configWith([
        { id: "first", models: [{ name: "同名", generateAudio: false }] },
        { id: "second", models: [{ name: "同名", generateAudio: true }] },
    ]);
    assert.equal(soundRowText(twoChannels, "second::同名"), HAS_SOUND);
    assert.equal(soundRowText(twoChannels, "first::同名"), NO_SOUND);
});

test("失败模式①：陈旧 channelId（local-comfyui:: / xq3...::）按模型名跨渠道回退", () => {
    assert.equal(soundRowText(registered, "local-comfyui::H3 展开流"), HAS_SOUND);
    assert.equal(soundRowText(registered, "local-comfyui::武戏"), HAS_SOUND);
    assert.equal(soundRowText(registered, "xq3BUgABCDEFG::YZ金鱼"), HAS_SOUND);
    // 回退后同一模型的其它能力（capability、generateAudio）也能读到。
    assert.equal(modelCapabilityOf(registered, "local-comfyui::H3 展开流"), "video");
    assert.equal(soundRowText(registered, "local-comfyui::视频flashvsr"), NO_SOUND);
});

test("失败模式②：工作流名不是已登记模型名，回退也不得误匹配", () => {
    const workflowName = "YZ金鱼-MiniMax+H3+终极篇-文武双全";
    assert.equal(soundRowText(registered, `engine-local::${workflowName}`), null);
    assert.equal(soundRowText(registered, `local-comfyui::${workflowName}`), null);
    assert.deepEqual(modelVideoCapabilitiesOf(registered, `local-comfyui::${workflowName}`), {});
    // 部分包含也不算命中。
    assert.equal(soundRowText(registered, "local-comfyui::YZ金鱼-MiniMax+H3"), null);
});

test("失败模式③：纯名（无 ::）仍按原有跨渠道精确名语义命中", () => {
    assert.equal(soundRowText(registered, "H3 展开流"), HAS_SOUND);
    assert.equal(soundRowText(registered, "武戏"), HAS_SOUND);
    assert.equal(soundRowText(registered, "视频flashvsr"), NO_SOUND);
    // 陈旧 channelId 回退与纯名走同一个查找语义：结果必须一致。
    assert.equal(
        soundRowText(registered, "local-comfyui::武戏"),
        soundRowText(registered, "武戏"),
    );
});

test("未登记 generateAudio 的视频模型默认能出声（用户口径），显式 false 仍是无声", () => {
    const unregistered = configWith([{ id: "engine-local", models: [{ name: "H3 展开流", capability: "video", maxAudios: 2 }] }]);
    // 默认：视频模型都能出声，所以未登记也渲染「模型同步生成对白与音效」。
    assert.equal(soundRowText(unregistered, "engine-local::H3 展开流"), HAS_SOUND);
    assert.equal(soundRowText(unregistered, "local-comfyui::H3 展开流"), HAS_SOUND);
    assert.equal(modelVideoCapabilitiesOf(unregistered, "local-comfyui::H3 展开流").generateAudio, true);
    // 显式登记 false 的模型不受默认值影响。
    const silent = configWith([{ id: "engine-local", models: [{ name: "无声模型", capability: "video", generateAudio: false }] }]);
    assert.equal(soundRowText(silent, "engine-local::无声模型"), NO_SOUND);
    // 渠道 id 与模型名都找不到时仍是 null（模型未知不臆造）。
    assert.equal(soundRowText(registered, "engine-local::不存在"), null);
    assert.equal(soundRowText(registered, "不存在"), null);
});

test("跨渠道回退取第一个同名模型，与无 :: 的既有语义一致", () => {
    const twoChannels = configWith([
        { id: "first", models: [{ name: "同名", generateAudio: false }] },
        { id: "second", models: [{ name: "同名", generateAudio: true }] },
    ]);
    assert.equal(soundRowText(twoChannels, "陈旧渠道::同名"), soundRowText(twoChannels, "同名"));
    assert.equal(soundRowText(twoChannels, "陈旧渠道::同名"), NO_SOUND);
});

test("回退只影响能力读取：readiness 仍把已下线渠道的同名模型判为不可用", () => {
    const ready = useConfigStore.getState().isAiConfigReady;
    assert.equal(ready(registered, "engine-local::H3 展开流"), true);
    // 陈旧 channelId 的模型能力可读，但渠道已下线，不能因此被当成可重试。
    assert.equal(ready(registered, "local-comfyui::H3 展开流"), false);
    assert.equal(ready(registered, "xq3BUgABCDEFG::YZ金鱼"), false);
    assert.equal(ready(registered, "H3 展开流"), true); // 裸名仍按原语义可用
});
