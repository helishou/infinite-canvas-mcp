import { after as afterAll, test } from "node:test";
import assert from "node:assert/strict";
import type { AiConfig } from "./use-config-store";

// Config/i18n 在模块初始化时读浏览器存储；与 model-selection.test.ts 同一套 shim。
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
afterAll(() => {
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
});

const { modelVideoCapabilitiesOf, normalizeChannelModels, normalizeModelVideoCapabilities, setModelPromptMaxChars } = await import("./use-config-store");

function configWith(models: Array<Record<string, unknown>>): AiConfig {
    return {
        channels: [{ id: "engine-local", name: "本地引擎", baseUrl: "http://127.0.0.1:8300", apiKey: "", apiFormat: "openai", kind: "local", models }],
    } as unknown as AiConfig;
}

test("设置页读取视频能力：有登记就读真值，没登记绝不脑补默认值", () => {
    const config = configWith([
        {
            name: "H3 首尾帧", capability: "video",
            videoRatios: ["16:9", "9:16"], videoResolutions: ["720p"],
            generateAudio: true, tailFrameChain: true, maxVideoSeconds: 15,
        },
        { name: "无声模型", capability: "video", generateAudio: false, tailFrameChain: false },
        { name: "未知模型", capability: "video" },
    ]);
    assert.deepEqual(modelVideoCapabilitiesOf(config, "engine-local::H3 首尾帧"), {
        videoRatios: ["16:9", "9:16"], videoResolutions: ["720p"], generateAudio: true, tailFrameChain: true, maxVideoSeconds: 15,
    });
    assert.deepEqual(modelVideoCapabilitiesOf(config, "H3 首尾帧"), modelVideoCapabilitiesOf(config, "engine-local::H3 首尾帧"));
    assert.deepEqual(modelVideoCapabilitiesOf(config, "engine-local::无声模型"), { generateAudio: false, tailFrameChain: false });
    assert.deepEqual(modelVideoCapabilitiesOf(config, "engine-local::未知模型"), {});
    assert.deepEqual(modelVideoCapabilitiesOf(config, "engine-local::不存在"), {});
    assert.deepEqual(normalizeModelVideoCapabilities({ videoRatios: ["16:9 (Widescreen)", "原图比例"] }), { videoRatios: ["16:9"] });
});

test("normalizeConfig 持久化往返不吞掉能力字段，非法值被丢弃", () => {
    const normalized = normalizeChannelModels([
        { name: "A", capability: "video", videoRatios: ["16:9"], generateAudio: false, tailFrameChain: true, maxVideoSeconds: 8 },
        { name: "B", capability: "video", videoRatios: ["", 3] as unknown as string[], maxVideoSeconds: -1, generateAudio: "false" as unknown as boolean },
    ]);
    assert.deepEqual(normalizeModelVideoCapabilities(normalized[0]), {
        videoRatios: ["16:9"], generateAudio: false, tailFrameChain: true, maxVideoSeconds: 8,
    });
    assert.deepEqual(normalizeModelVideoCapabilities(normalized[1]), {}, "非法声明不得进入配置");
});

test("promptMaxChars：前端另一子代理读的能力字段按真值透传，缺省不臆造，非法值丢弃", () => {
    const config = configWith([
        { name: "已登记", capability: "video", promptMaxChars: 8000 },
        { name: "非法值", capability: "video", promptMaxChars: -1 },
        { name: "未登记", capability: "video" },
    ]);
    assert.equal(modelVideoCapabilitiesOf(config, "engine-local::已登记").promptMaxChars, 8000);
    assert.equal(modelVideoCapabilitiesOf(config, "已登记").promptMaxChars, 8000);
    assert.equal(modelVideoCapabilitiesOf(config, "engine-local::非法值").promptMaxChars, undefined);
    assert.equal(modelVideoCapabilitiesOf(config, "engine-local::未登记").promptMaxChars, undefined);
    assert.deepEqual(normalizeModelVideoCapabilities({ promptMaxChars: 32000 }), { promptMaxChars: 32000 });
    for (const bad of [0, -1, 1.5, "8000", null, true]) {
        assert.deepEqual(normalizeModelVideoCapabilities({ promptMaxChars: bad }), {});
    }
    const normalized = normalizeChannelModels([{ name: "A", capability: "video", promptMaxChars: 8000 }]);
    assert.deepEqual(normalizeModelVideoCapabilities(normalized[0]), { promptMaxChars: 8000 });
});

test("设置页显式登记字数上限：写进渠道模型并可读回；清空删除字段，非法值不写入", () => {
    const config = configWith([{ name: "H3", capability: "video" }]);
    const written = setModelPromptMaxChars(config, "engine-local::H3", 8000);
    assert.notEqual(written, config, "不得原地改用户配置");
    assert.equal(modelVideoCapabilitiesOf(written, "engine-local::H3").promptMaxChars, 8000);
    assert.equal(written.channels[0].models[0].promptMaxChars, 8000);
    assert.equal(config.channels[0].models[0].promptMaxChars, undefined, "原配置保持不变");
    const cleared = setModelPromptMaxChars(written, "engine-local::H3", undefined);
    assert.equal(Object.hasOwn(cleared.channels[0].models[0], "promptMaxChars"), false);
    assert.deepEqual(setModelPromptMaxChars(config, "engine-local::H3", -1), config);
    assert.deepEqual(setModelPromptMaxChars(config, "engine-local::不存在", 8000), config);
});
