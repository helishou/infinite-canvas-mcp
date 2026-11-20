import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveAutoVoiceGroupIds, isNarratorSpeaker, normalizeSpeakerName, normalizeVoiceOverrides, applyVoiceOverridesToGroups, applyVoiceOverridesToRefs } from "./auto-voice.js";

const voice = (name: string) => ({ url: `https://audio/${name}`, name, storageKey: `voice:${name}` });
const group = (id: string, characterName: string, subjectId: string, withVoice: boolean) => ({
    id, characterName, subjectId, characterNodeId: `node-${id}`,
    ...(withVoice ? { voice: voice(characterName) } : {}),
});

test("规范化与旁白判定与影策对齐", () => {
    assert.equal(normalizeSpeakerName("  旁 白 "), "旁白");
    assert.equal(normalizeSpeakerName("Nar-rator"), "narrator");
    assert.equal(isNarratorSpeaker("旁白"), true);
    assert.equal(isNarratorSpeaker("Narrator"), true);
    assert.equal(isNarratorSpeaker("画外音"), true);
    assert.equal(isNarratorSpeaker("小夏"), false);
});

test("按镜头顺序去重、跳过空台词与旁白、只保留有声线者", () => {
    const groups: Record<string, any> = {
        A: group("A", "小夏", "SUB_A", true),
        B: group("B", "老陈", "SUB_B", true),
        C: group("C", "无名", "SUB_C", false),
    };
    const source = {
        subject_registry: [
            { id: "SUB_A", name: "小夏", entityRef: { id: "P_A" }, pictureBindings: [] },
            { id: "SUB_B", name: "老陈", entityRef: { id: "P_B" }, pictureBindings: [] },
            { id: "SUB_C", name: "无名", entityRef: { id: "P_C" }, pictureBindings: [] },
        ],
        character_registry: [
            { id: "P_A", name: "小夏", aliases: ["阿夏", "夏丫头"] },
            { id: "P_B", name: "老陈" },
        ],
        shots: [
            { id: "S1", dialogues: [{ speaker: "旁白", text: "夜色降临。" }, { speaker: "阿夏", text: "我来了。" }] },
            { id: "S2", dialogues: [{ speaker: "小夏", text: "又见面。" }, { speaker: "老陈", text: "嗯。" }] },
            { id: "S3", dialogues: [{ speaker: "无名", text: "路过。" }, { speaker: "小夏", text: "" }] },
        ],
    };
    assert.deepEqual(deriveAutoVoiceGroupIds({ source, shotIds: ["S1", "S2", "S3"], groups }), ["A", "B"]);
});

test("utterances 的 speakerSubjectId / speakerName 也能命中角色组", () => {
    const groups: Record<string, any> = {
        A: group("A", "信使", "SUB_A", true),
        B: group("B", "守卫", "SUB_B", true),
    };
    const source = {
        subject_registry: [{ id: "SUB_A", name: "信使", entityRef: { id: "P_A" } }],
        character_registry: [],
        shots: [{ id: "S1", dialogues: [] }, { id: "S2", dialogues: [] }],
        utterances: [
            { id: "U1", speakerSubjectId: "SUB_A", text: "有信。", start: { shotId: "S1" } },
            { id: "U2", speakerName: "守卫", text: "站住。", start: { shotId: "S2" } },
            { id: "U3", speakerName: "旁白", text: "他转身。", start: { shotId: "S2" } },
        ],
    };
    assert.deepEqual(deriveAutoVoiceGroupIds({ source, shotIds: ["S1", "S2"], groups }), ["A", "B"]);
});

test("最多 3 段参考音频，超出按开口顺序截断", () => {
    const groups: Record<string, any> = {};
    const shots: Array<Record<string, any>> = [];
    for (let i = 1; i <= 5; i++) {
        groups[`G${i}`] = group(`G${i}`, `角色${i}`, `SUB${i}`, true);
        shots.push({ id: `S${i}`, dialogues: [{ speaker: `角色${i}`, text: "说话。" }] });
    }
    const source = { subject_registry: [], character_registry: [], shots };
    assert.deepEqual(deriveAutoVoiceGroupIds({ source, shotIds: shots.map(s => s.id), groups }), ["G1", "G2", "G3"]);
});

test("按模型动态上限截断：不同模型/不同 maxAudios 得到不同派生数量", () => {
    const groups: Record<string, any> = {};
    const shots: Array<Record<string, any>> = [];
    for (let i = 1; i <= 5; i++) {
        groups[`G${i}`] = group(`G${i}`, `角色${i}`, `SUB${i}`, true);
        shots.push({ id: `S${i}`, dialogues: [{ speaker: `角色${i}`, text: "说话。" }] });
    }
    const source = { subject_registry: [], character_registry: [], shots };
    const shotIds = shots.map(s => s.id);
    assert.deepEqual(deriveAutoVoiceGroupIds({ source, shotIds, groups, maxAudios: 2 }), ["G1", "G2"]);
    assert.deepEqual(deriveAutoVoiceGroupIds({ source, shotIds, groups, maxAudios: 5 }), ["G1", "G2", "G3", "G4", "G5"]);
    assert.deepEqual(deriveAutoVoiceGroupIds({ source, shotIds, groups, maxAudios: 0 }), []);
});

// ===== 段级音色覆写：覆写生效 / 恢复自动 / 无覆写沿用本体 =====
const bodyGroups = () => ({
    A: { id: "A", characterName: "小夏", voice: voice("小夏-本体") },
    B: { id: "B", characterName: "老陈", voice: voice("老陈-本体") },
}) as Record<string, any>;

test("无覆写：沿用角色本体音色（自动）", () => {
    const groups = bodyGroups();
    const applied = applyVoiceOverridesToGroups(groups, normalizeVoiceOverrides(undefined));
    assert.deepEqual(applied, groups);
    assert.equal(applied.A.voice.storageKey, "voice:小夏-本体");
    assert.equal(applied.B.voice.storageKey, "voice:老陈-本体");
});

test("段级覆写生效：指定角色改用 voiceStorageKey，其他角色沿用本体", () => {
    const overrides = normalizeVoiceOverrides({ A: "voice:小夏-指定", "": "ignored", B: "  " });
    assert.deepEqual(overrides, { A: { storageKey: "voice:小夏-指定" } });
    const applied = applyVoiceOverridesToGroups(bodyGroups(), overrides);
    assert.equal(applied.A.voice.storageKey, "voice:小夏-指定");
    assert.equal(applied.B.voice.storageKey, "voice:老陈-本体");
    // 本体 voice 的其他字段（name/url）仍在，只是媒体身份被覆写。
    assert.equal(applied.A.voice.name, "小夏-本体");
});

test("恢复自动：清掉覆写后重新派生回到本体音色", () => {
    const groups = bodyGroups();
    const withOverride = applyVoiceOverridesToGroups(groups, normalizeVoiceOverrides({ A: "voice:小夏-指定" }));
    assert.equal(withOverride.A.voice.storageKey, "voice:小夏-指定");
    // 真实链路：清覆写走 patch/patchDelete，下一次编译从角色本体重建 characterGroups，
    // 不再套覆写 → 回到本体音色。这里用 fresh bodyGroups 模拟「重编译」。
    const afterRecompile = applyVoiceOverridesToGroups(bodyGroups(), normalizeVoiceOverrides({}));
    assert.equal(afterRecompile.A.voice.storageKey, "voice:小夏-本体");
});

test("对象形式覆写（storageKey + url + name）按媒体身份生效", () => {
    const overrides = normalizeVoiceOverrides({ B: { storageKey: "voice:老陈-指定", url: "https://audio/custom", name: "指定音色" } });
    assert.deepEqual(overrides, { B: { storageKey: "voice:老陈-指定", url: "https://audio/custom", name: "指定音色" } });
    const applied = applyVoiceOverridesToGroups(bodyGroups(), overrides);
    assert.equal(applied.B.voice.storageKey, "voice:老陈-指定");
    assert.equal(applied.B.voice.name, "指定音色");
});

test("运行时参考音频按覆写改写 storageKey，保留组/id/标签；未覆写者原样", () => {
    const refs = [
        { id: "B1", groupId: "A", type: "audio", label: "<Audio 1>", storageKey: "voice:小夏-本体" },
        { id: "B2", groupId: "B", type: "audio", label: "<Audio 2>", storageKey: "voice:老陈-本体" },
        { id: "B3", type: "audio", label: "<Audio 3>", storageKey: "free-audio" },
    ];
    const applied = applyVoiceOverridesToRefs(refs, normalizeVoiceOverrides({ A: "voice:小夏-指定" }));
    assert.equal(applied[0].storageKey, "voice:小夏-指定");
    assert.equal(applied[0].groupId, "A");
    assert.equal(applied[0].label, "<Audio 1>");
    assert.equal(applied[1].storageKey, "voice:老陈-本体");
    assert.equal(applied[2].storageKey, "free-audio");
});

test("覆写让本体无声线的开口角色也进入 autoVoiceGroupIds（受 audioLimit 截断）", () => {
    // 角色 C 本体无声线，但用户给它指定了音色；应随覆写进入参考清单。
    const groups: Record<string, any> = {
        A: group("A", "小夏", "SUB_A", true),
        C: group("C", "路人", "SUB_C", false),
    };
    const source = {
        subject_registry: [{ id: "SUB_A", name: "小夏" }, { id: "SUB_C", name: "路人" }],
        character_registry: [],
        shots: [
            { id: "S1", dialogues: [{ speaker: "小夏", text: "我来了。" }] },
            { id: "S2", dialogues: [{ speaker: "路人", text: "借过。" }] },
        ],
    };
    const shotIds = ["S1", "S2"];
    assert.deepEqual(deriveAutoVoiceGroupIds({ source, shotIds, groups }), ["A"]);
    const overridden = applyVoiceOverridesToGroups(groups, normalizeVoiceOverrides({ C: "voice:路人-指定" }));
    assert.deepEqual(deriveAutoVoiceGroupIds({ source, shotIds, groups: overridden }), ["A", "C"]);
    assert.deepEqual(deriveAutoVoiceGroupIds({ source, shotIds, groups: overridden, maxAudios: 1 }), ["A"]);
});
