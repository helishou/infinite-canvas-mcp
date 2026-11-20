import { test } from "node:test";
import assert from "node:assert/strict";
import {
    DEFAULT_VIDEO_MAX_AUDIOS,
    effectiveAudioLimit,
    maxAudiosFromEngineInfo,
    modelMaxAudiosOf,
    resolveModelMaxAudios,
    aiConfigMaxAudiosResolver,
    capAudioReferences,
} from "./model-audio-capability.js";

const aiConfig = (models: Array<Record<string, unknown>>) => ({
    channels: [{ id: "engine-local", name: "本地引擎", kind: "local", apiFormat: "openai", baseUrl: "http://127.0.0.1:8300", apiKey: "", models }],
});

test("模型 maxAudios 从 ai.config 真实能力读取，缺省回落 H3 原生默认", () => {
    const config = aiConfig([
        { name: "武戏", capability: "video", maxAudios: 2 },
        { name: "H3 展开流", capability: "video", maxAudios: 5 },
        { name: "未声明模型", capability: "video" },
        { name: "文生图", capability: "image", maxAudios: 1 },
    ]);
    assert.equal(modelMaxAudiosOf(config, "engine-local::武戏"), 2);
    assert.equal(resolveModelMaxAudios(config, "engine-local::武戏"), 2);
    assert.equal(resolveModelMaxAudios(config, "engine-local::H3 展开流"), 5);
    assert.equal(resolveModelMaxAudios(config, "engine-local::未声明模型"), DEFAULT_VIDEO_MAX_AUDIOS);
    assert.equal(resolveModelMaxAudios(config, "engine-local::文生图"), 1);
    // 不在配置里的模型也按默认回落，避免老 Clip 因渠道改名而静默丢全部音色。
    assert.equal(resolveModelMaxAudios(config, "engine-local::已删除模型"), DEFAULT_VIDEO_MAX_AUDIOS);
});

test("显式 0 与非法声明按真值处理，不被默认覆盖", () => {
    const config = aiConfig([
        { name: "无音色", capability: "video", maxAudios: 0 },
        { name: "非法负数", capability: "video", maxAudios: -1 },
        { name: "非法文本", capability: "video", maxAudios: "若干" },
        { name: "字符串数字", capability: "video", maxAudios: "4" },
    ]);
    assert.equal(resolveModelMaxAudios(config, "engine-local::无音色"), 0);
    assert.equal(resolveModelMaxAudios(config, "engine-local::非法负数"), DEFAULT_VIDEO_MAX_AUDIOS);
    assert.equal(resolveModelMaxAudios(config, "engine-local::非法文本"), DEFAULT_VIDEO_MAX_AUDIOS);
    assert.equal(resolveModelMaxAudios(config, "engine-local::字符串数字"), 4);
});

test("不同模型不同上限：resolver 与模式门控（非 ref2va 一律 0）", () => {
    const config = aiConfig([
        { name: "武戏", capability: "video", maxAudios: 2 },
        { name: "H3 展开流", capability: "video", maxAudios: 5 },
    ]);
    const resolve = aiConfigMaxAudiosResolver(config);
    assert.equal(effectiveAudioLimit(resolve, "engine-local::武戏", "ref2va"), 2);
    assert.equal(effectiveAudioLimit(resolve, "engine-local::H3 展开流", "ref2va"), 5);
    for (const mode of ["t2v", "i2v", "fl2v", "l2v", "", undefined]) {
        assert.equal(effectiveAudioLimit(resolve, "engine-local::武戏", mode), 0, `mode=${mode}`);
    }
});

test("超限参考音频按影策写 Note 跳过：保留前 N 条，其余 skipped 不发送", () => {
    const refs = ["A", "B", "C", "D", "E"].map(id => ({ label: `<Audio ${id}>`, id }));
    assert.deepEqual(capAudioReferences(refs, 2).kept.map(ref => ref.id), ["A", "B"]);
    assert.deepEqual(capAudioReferences(refs, 2).skipped.map(ref => ref.id), ["C", "D", "E"]);
    assert.deepEqual(capAudioReferences(refs, 5).skipped, []);
    assert.deepEqual(capAudioReferences(refs, 0).kept, []);
    assert.deepEqual(capAudioReferences(refs, 0).skipped.map(ref => ref.id), ["A", "B", "C", "D", "E"]);
});

test("引擎 media_inputs.audios 真实槽位数读取（数字或数组），没暴露返回 undefined", () => {
    assert.equal(maxAudiosFromEngineInfo({ media_inputs: { audios: 2, images: 9 } }), 2);
    assert.equal(maxAudiosFromEngineInfo({ media_inputs: { audios: ["audio1", "audio2"] } }), 2);
    assert.equal(maxAudiosFromEngineInfo({ media_inputs: {} }), undefined);
    assert.equal(maxAudiosFromEngineInfo({}), undefined);
    assert.equal(maxAudiosFromEngineInfo(null), undefined);
});
