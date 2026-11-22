import test from "node:test";
import assert from "node:assert/strict";
import {
    dialogueShotLinesOf,
    speakerRegistryOf,
    speakerNameOf,
    utterancesOfShot,
    type StudioSource,
} from "./studio-utterance.js";

const source: StudioSource = {
    subject_registry: [
        { id: "EP2-SUBJ-MULI", kind: "character", entityRef: { kind: "character", id: "EP2-CHAR-MULI" } },
        { id: "EP2-SUBJ-LUCHEN", kind: "character", entityRef: { kind: "character", id: "EP2-CHAR-LUCHEN" } },
    ],
    character_registry: [
        { id: "EP2-CHAR-MULI", name: "慕璃" },
        { id: "EP2-CHAR-LUCHEN", name: "陆沉" },
    ],
    utterances: [
        { id: "U1", speakerSubjectId: "EP2-SUBJ-MULI", text: "哪来的？", start: { shotId: "S1", localFrame: 12 }, end: { shotId: "S1", localFrame: 34 } },
        // 跨镜共享台词：start 在 S2，但 S1/S2 都通过 utterance_refs 引用它。
        { id: "U2", speakerSubjectId: "EP2-SUBJ-LUCHEN", text: "剑来！", start: { shotId: "S2", localFrame: 3 }, end: { shotId: "S2", localFrame: 30 } },
        // 只有 start.shotId、没有 ref 的旧稿台词。
        { id: "U3", speakerName: "旁白", text: "山雨欲来。", start: { shotId: "S3", localFrame: 0 }, end: { shotId: "S3", localFrame: 20 } },
    ],
    shots: [
        {
            id: "S1",
            utterance_refs: [
                { utteranceId: "U1", role: "speaker", localStartFrame: 12, localEndFrame: 34, textStart: 0, textEnd: 4 },
                { utteranceId: "U2", role: "speaker", localStartFrame: 40, localEndFrame: 46, textStart: 0, textEnd: 3 },
            ],
        },
        {
            id: "S2",
            utterance_refs: [{ utteranceId: "U2", role: "speaker", localStartFrame: 3, localEndFrame: 30, textStart: 0, textEnd: 3 }],
        },
        { id: "S3" },
        { id: "OLD", dialogues: [{ speaker: "赵村长", text: "造孽啊。" }, { speaker: "村民", text: "散了吧。" }] },
    ],
};

test("说话人按 subject_registry.entityRef.id → character_registry.name 解析", () => {
    const reg = speakerRegistryOf(source);
    assert.deepEqual(
        utterancesOfShot(source, source.shots[0], reg).map(line => line.speaker),
        ["慕璃", "陆沉"],
    );
    assert.equal(utterancesOfShot(source, source.shots[2], reg)[0].speaker, "旁白");
});

test("shot.utterance_refs 聚合台词，跨镜共享台词在每个引用镜头都出现", () => {
    const reg = speakerRegistryOf(source);
    const s1 = utterancesOfShot(source, source.shots[0], reg);
    assert.deepEqual(s1.map(line => [line.utteranceId, line.text]), [["U1", "哪来的？"], ["U2", "剑来！"]]);
    assert.equal(s1[0].speakerSubjectId, "EP2-SUBJ-MULI");
    const s2 = utterancesOfShot(source, source.shots[1], reg);
    assert.deepEqual(s2.map(line => line.utteranceId), ["U2"]);
    // 引用顺序决定展示顺序，不按 utterances 数组顺序。
    source.shots[0].utterance_refs = [...source.shots[0].utterance_refs].reverse();
    assert.deepEqual(utterancesOfShot(source, source.shots[0], reg).map(line => line.utteranceId), ["U2", "U1"]);
    source.shots[0].utterance_refs = [...source.shots[0].utterance_refs].reverse();
});

test("无 refs 回退 start.shotId；老剧目 dialogues 兼容且与 utterance 同文本去重", () => {
    const reg = speakerRegistryOf(source);
    assert.deepEqual(utterancesOfShot(source, source.shots[2], reg).map(line => line.text), ["山雨欲来。"]);
    const oldShot = source.shots[3];
    assert.deepEqual(utterancesOfShot(source, oldShot, reg).map(line => line.speaker), ["赵村长", "村民"]);
    // 同一镜头同时有 utterance 引用和回填 dialogues 时，同文本不重复展示。
    oldShot.utterance_refs = [{ utteranceId: "U2", role: "speaker", localStartFrame: 0, localEndFrame: 3, textStart: 0, textEnd: 3 }];
    oldShot.dialogues = [{ speaker: "村民", text: "剑来！" }];
    assert.deepEqual(utterancesOfShot(source, oldShot, reg).map(line => line.text), ["剑来！"]);
    delete oldShot.utterance_refs;
    oldShot.dialogues = [{ speaker: "赵村长", text: "造孽啊。" }, { speaker: "村民", text: "散了吧。" }];
});

test("对白核查镜头侧聚合不再依赖 dialogues：新剧目 4 行 + 老剧目 2 行", () => {
    const lines = dialogueShotLinesOf(source);
    assert.deepEqual(lines, ["哪来的？", "剑来！", "剑来！", "山雨欲来。", "造孽啊。", "散了吧。"]);
    const newDrama = { ...source, shots: source.shots.slice(0, 3).map((shot: Record<string, any>) => ({ ...shot, dialogues: undefined })) };
    assert.deepEqual(dialogueShotLinesOf(newDrama), ["哪来的？", "剑来！", "剑来！", "山雨欲来。"]);
});


test("回填老剧目 speakerSubjectId 是 character_registry.id 时显示角色名而非 entity id", () => {
    const src: StudioSource = {
        subject_registry: [], // 回填的老剧目没有 subject_registry
        character_registry: [{ id: "entity-character-16pxnor", name: "崇良" }],
    };
    const reg = speakerRegistryOf(src);
    assert.equal(speakerNameOf(reg, { speakerSubjectId: "entity-character-16pxnor" }), "崇良");
});
