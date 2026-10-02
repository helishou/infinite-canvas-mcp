import assert from "node:assert/strict";
import test from "node:test";
import { mergeSubjectDefinitions, subjectVisualSourceDetails, toSubjectDefinitions } from "./subject-definitions.js";

const references = [
    { tag: "<Picture 1>", bindingId: "face", type: "image", role: "character_identity", description: "source face analysis" },
    { tag: "<Picture 2>", bindingId: "body", type: "image", role: "character_turnaround", description: "source body analysis" },
];

test("同主体的每个视觉来源分别编译手写描述，旧整体描述仍保留", () => {
    const [subject] = mergeSubjectDefinitions([], [{ id: "hero", name: "Hero", profile: "legacy overall note", pictures: references.map((r) => r.tag), pictureDescriptions: { face: "FACE_ONLY", body: "BODY_ONLY" } }]);
    assert.deepEqual(subjectVisualSourceDetails(subject, references), ["<Picture 1> visual attributes: FACE_ONLY", "<Picture 2> visual attributes: BODY_ONLY"]);
    assert.equal(toSubjectDefinitions([subject])[0].profile, "legacy overall note");
    assert.deepEqual(toSubjectDefinitions([subject])[0].pictureDescriptions, { face: "FACE_ONLY", body: "BODY_ONLY" });
});

test("来源重新编号时描述跟随绑定，旧描述不串到复用编号的新参考", () => {
    const subject = { pictures: ["<Picture 1>", "<Picture 2>"], pictureDescriptions: { face: "FACE_ONLY", body: "BODY_ONLY", removed: "REMOVED_ONLY" } };
    const reordered = [{ ...references[1], tag: "<Picture 1>" }, { ...references[0], tag: "<Picture 2>" }];
    assert.deepEqual(subjectVisualSourceDetails(subject, reordered), ["<Picture 1> visual attributes: BODY_ONLY", "<Picture 2> visual attributes: FACE_ONLY"]);
    assert.deepEqual(subjectVisualSourceDetails(subject, [{ ...references[0], bindingId: "new-source", description: "NEW_ONLY" }]), ["<Picture 1> visual attributes: NEW_ONLY"]);
});

test("空描述只回落本来源分析；取消选择、分镜图和站位图不输出来源特征", () => {
    const subject = { pictures: ["<Picture 1>"], pictureDescriptions: { face: "  ", body: "BODY_ONLY" } };
    assert.deepEqual(subjectVisualSourceDetails(subject, references), ["<Picture 1> visual attributes: source face analysis"]);
    assert.deepEqual(subjectVisualSourceDetails(subject, [{ ...references[0], role: "storyboard" }]), []);
    assert.deepEqual(subjectVisualSourceDetails(subject, [{ ...references[0], role: "blocking" }]), []);
    const cleared = mergeSubjectDefinitions([{ id: "hero", name: "Hero", profile: "", pictures: ["<Picture 1>"], outfits: [], aliases: [], shotMarkers: [] }], [{ id: "hero", name: "Hero", pictures: [], pictureDescriptions: subject.pictureDescriptions }])[0];
    assert.deepEqual(subjectVisualSourceDetails(cleared, references), []);
    assert.deepEqual(cleared.pictureDescriptions, subject.pictureDescriptions, "取消选择后保留描述草稿供重新添加");
});
