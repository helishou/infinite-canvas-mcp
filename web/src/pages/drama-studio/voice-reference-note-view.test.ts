import assert from "node:assert/strict";
import test from "node:test";
import { projectVoiceReferenceNotes, VOICE_NOTE_LABEL } from "./voice-reference-note-view";

test("段详情音色区把段级 Note 投影成三类可读原因，sent=true 不展示", () => {
    const notes = projectVoiceReferenceNotes([
        { groupId: "G1", characterName: "阿夏", code: "audio_reference_limit", reason: "超出视频模型参考音频上限（3 段）", sent: false },
        { groupId: "G2", characterName: "小夏", code: "voice_sample_missing", reason: "角色尚未绑定声音样本", sent: false },
        { groupId: "G3", characterName: "老陈", code: "mode_not_supported", reason: "所选视频模型不支持参考音频", sent: false },
        { groupId: "G4", characterName: "已发送", code: "audio_reference_limit", reason: "不该出现", sent: true },
    ]);
    assert.deepEqual(notes.map(n => [n.groupId, n.code, VOICE_NOTE_LABEL[n.code]]), [
        ["G1", "audio_reference_limit", "超限"],
        ["G2", "voice_sample_missing", "无样本"],
        ["G3", "mode_not_supported", "模式不支持"],
    ]);
    assert.equal(notes[0].reason, "超出视频模型参考音频上限（3 段）");
});

test("段级 Note 缺失或脏数据时安全回落，不抛错、不伪造原因", () => {
    assert.deepEqual(projectVoiceReferenceNotes(undefined), []);
    assert.deepEqual(projectVoiceReferenceNotes({} as never), []);
    const dirty = projectVoiceReferenceNotes([null, { groupId: "G9", code: "future_code", reason: "X", sent: false }]);
    assert.equal(dirty.length, 1);
    assert.equal(dirty[0].code, "mode_not_supported");
    assert.equal(dirty[0].characterName, "G9"); // 缺角色名时回落 groupId
});
