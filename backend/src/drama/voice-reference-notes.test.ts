import assert from "node:assert/strict";
import test from "node:test";
import {
    deriveVoiceCandidates, deriveAutoVoiceGroupIds, buildVoiceReferenceNotes,
    voiceSkipNotesFromRefs, mergeVoiceReferenceNotes, VOICE_NOTE_REASON,
    type VoiceReferenceNote,
} from "./auto-voice.js";
import { applyCanvasProjectOperations } from "../canvas/project-ops.js";
import { prepareClientCanvasOperation } from "../canvas/operation-authority.js";

const voice = (name: string) => ({ url: `https://audio/${name}`, name, storageKey: `voice:${name}` });
const group = (id: string, characterName: string, subjectId: string, withVoice: boolean) => ({
    id, characterName, subjectId, characterNodeId: `node-${id}`,
    ...(withVoice ? { voice: voice(characterName) } : {}),
});

function fixture(withVoiceFlags: boolean[] = [true, true, true, true]) {
    const groups: Record<string, any> = {};
    const shots: Array<Record<string, any>> = [];
    withVoiceFlags.forEach((hasVoice, i) => {
        const n = i + 1;
        groups[`G${n}`] = group(`G${n}`, `角色${n}`, `SUB${n}`, hasVoice);
        shots.push({ id: `S${n}`, dialogues: [{ speaker: `角色${n}`, text: "说话。" }] });
    });
    return {
        groups,
        source: { subject_registry: [], character_registry: [], shots },
        shotIds: shots.map(shot => String(shot.id)),
    };
}

test("deriveVoiceCandidates 按开口顺序返回候选并标记有无声线（含未绑定者）", () => {
    const f = fixture([true, false, true]);
    assert.deepEqual(deriveVoiceCandidates(f).map(c => [c.groupId, c.characterName, c.hasVoice]), [
        ["G1", "角色1", true], ["G2", "角色2", false], ["G3", "角色3", true],
    ]);
    // 重构后的 deriveAutoVoiceGroupIds 行为不变：无样本跳过、按上限截断。
    assert.deepEqual(deriveAutoVoiceGroupIds({ ...f, maxAudios: 2 }), ["G1", "G3"]);
});

test("buildVoiceReferenceNotes 落三类段级 Note（无样本 / 模式不支持 / 超限），sent 恒为 false", () => {
    const f = fixture([true, false, true, true]);
    const candidates = deriveVoiceCandidates(f);
    const notes = buildVoiceReferenceNotes({ candidates, maxAudios: 2 });
    assert.deepEqual(notes, [
        { groupId: "G2", characterName: "角色2", code: "voice_sample_missing", reason: VOICE_NOTE_REASON.voice_sample_missing, sent: false },
        { groupId: "G4", characterName: "角色4", code: "audio_reference_limit", reason: VOICE_NOTE_REASON.audio_reference_limit(2), sent: false },
    ]);
    assert.ok(notes.every(note => note.sent === false));
    // 模式不支持（非 ref2va / maxAudios=0）：有声线者全部写 Note，无样本者优先原因不变。
    const noMode = buildVoiceReferenceNotes({ candidates, maxAudios: 0 });
    // 影策按每个候选逐个判定：G1 有声线先命中模式不支持，G2 无样本才是无样本原因。
    assert.deepEqual(noMode.map(n => n.code), ["mode_not_supported", "voice_sample_missing", "mode_not_supported", "mode_not_supported"]);
    assert.equal(noMode[0].reason, VOICE_NOTE_REASON.mode_not_supported);
    // 上限充足时不留 Note。
    assert.deepEqual(buildVoiceReferenceNotes({ candidates: deriveVoiceCandidates(fixture()), maxAudios: 9 }), []);
});

test("运行时按实际跳过写超限 Note，角色名从段级 characterGroups 取", () => {
    const f = fixture();
    const notes = voiceSkipNotesFromRefs({
        skipped: [{ groupId: "G4", label: "<Audio 4>" }, { groupId: "G3", name: "角色3" }],
        characterGroups: f.groups,
        maxAudios: 2,
    });
    assert.deepEqual(notes, [
        { groupId: "G4", characterName: "角色4", code: "audio_reference_limit", reason: VOICE_NOTE_REASON.audio_reference_limit(2), sent: false },
        { groupId: "G3", characterName: "角色3", code: "audio_reference_limit", reason: VOICE_NOTE_REASON.audio_reference_limit(2), sent: false },
    ]);
});

test("段级 Note 持久化合并：保留编译期原因，以本次运行实际超限覆盖旧超限，去重脏数据", () => {
    const compiled: VoiceReferenceNote[] = [
        { groupId: "G2", characterName: "角色2", code: "voice_sample_missing", reason: VOICE_NOTE_REASON.voice_sample_missing, sent: false },
        { groupId: "G4", characterName: "角色4", code: "audio_reference_limit", reason: "旧上限 1 段", sent: false },
    ];
    const runtime: VoiceReferenceNote[] = [
        { groupId: "G5", characterName: "角色5", code: "audio_reference_limit", reason: VOICE_NOTE_REASON.audio_reference_limit(3), sent: false },
        { groupId: "G5", characterName: "角色5", code: "audio_reference_limit", reason: VOICE_NOTE_REASON.audio_reference_limit(3), sent: false },
    ];
    const merged = mergeVoiceReferenceNotes([
        ...compiled,
        { groupId: "BAD", code: "audio_reference_limit", reason: "sent 应为 false 却不合法", sent: true },
        null,
    ], runtime);
    assert.deepEqual(merged.map(n => [n.groupId, n.code]), [
        ["G2", "voice_sample_missing"],
        ["G5", "audio_reference_limit"],
    ]);
    assert.equal(merged[1].reason, VOICE_NOTE_REASON.audio_reference_limit(3));
    // 无运行超限时旧超限被清空（模型/模式变化后的过期 Note 不残留）。
    assert.deepEqual(mergeVoiceReferenceNotes(compiled, []).map(n => n.groupId), ["G2"]);
});

test("段级 Note 经 update_h3_segment 落进 metadata.segments[]，完整段替换也不冲掉", () => {
    const note: VoiceReferenceNote = { groupId: "G2", characterName: "角色2", code: "voice_sample_missing", reason: VOICE_NOTE_REASON.voice_sample_missing, sent: false };
    const project: any = { revision: 1, nodes: [{ id: "N", type: "minimax-h3:video", metadata: {
        productionClipProjection: { targetId: "CLIP", sourceHash: "h" },
        segments: [{ id: "S", prompt: "x", audioReferenceMode: "auto", autoVoiceGroupIds: [] }],
    } }], connections: [] };
    const write = { type: "update_h3_segment", nodeId: "N", segmentId: "S", patch: { voiceReferenceNotes: [note] } };
    prepareClientCanvasOperation(project, write);
    applyCanvasProjectOperations(project, [write]);
    assert.deepEqual(project.nodes[0].metadata.segments[0].voiceReferenceNotes, [note]);
    // 完整段替换省略该字段时按稳定 ID 从旧段继承（operation-authority 白名单生效）。
    const replace = { type: "replace_h3_segments", nodeId: "N", segments: [{ id: "S", prompt: "edited", audioReferenceMode: "auto", autoVoiceGroupIds: [] }] };
    prepareClientCanvasOperation(project, replace);
    applyCanvasProjectOperations(project, [replace]);
    assert.deepEqual(project.nodes[0].metadata.segments[0].voiceReferenceNotes, [note]);
});
