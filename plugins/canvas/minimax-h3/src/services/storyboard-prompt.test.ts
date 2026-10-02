import test from "node:test";
import assert from "node:assert/strict";
import { buildStoryboardPromptSections, ensureCharacterGroupSubjectDefinitions, ensureCharacterGroupSubjects, mergeSubjectDefinitions, toSubjectDefinitions } from "./storyboard-prompt";

test("旧实体数据缺少名称或别名时也不会在增强初始化阶段崩溃", () => {
    const malformed = [{ id: "legacy", aliases: [undefined, "旧别名"], name: undefined, profile: "", pictures: [], outfits: [] }] as unknown as Parameters<typeof ensureCharacterGroupSubjectDefinitions>[0];
    assert.doesNotThrow(() => ensureCharacterGroupSubjectDefinitions(malformed, {}));
    assert.doesNotThrow(() => ensureCharacterGroupSubjects([{ id: "legacy", name: "", aliases: [undefined], shotMarkers: [], profile: "", outfits: [], pictures: [] }] as unknown as Parameters<typeof ensureCharacterGroupSubjects>[0], {}));
});

test("关闭服装后旧实体清单里的失效图片来源不会让编译报错", () => {
    // 关闭服装前保存的实体清单：<Picture 2> 是沈侯的服装四视图。
    const savedDefinitions = [
        { id: "prop-ring", name: "婚书", profile: "旧婚书", pictures: [], outfits: [], role: "prop" },
        { id: "shenhou", name: "沈侯", profile: "侯爵", pictures: ["<Picture 2>"], outfits: [], role: "character_identity" },
    ];
    const ruleSubjects = ensureCharacterGroupSubjects([{ id: "prop-ring", name: "婚书", aliases: [], shotMarkers: [], profile: "旧婚书", outfits: [], pictures: [], role: "prop" }], {
        voice: { id: "voice", characterName: "沈侯", characterNodeId: "character-shen", subjectId: "shenhou", outfits: [], outfitEnabled: false, voiceEnabled: true },
    });
    const references = [
        { tag: "<Picture 1>", bindingId: "b1", type: "image", role: "storyboard", label: "分镜图", description: "", shotNumbers: [] },
        { tag: "<Audio 1>", bindingId: "b2", type: "audio", role: "character_voice", label: "声线", description: "低沉", subjectId: "shenhou", shotNumbers: [] },
    ] as Parameters<typeof buildStoryboardPromptSections>[1];
    const subjects = mergeSubjectDefinitions(ruleSubjects, savedDefinitions);
    const sections = buildStoryboardPromptSections(subjects, references, [{ description: "沈侯开口。", referenceIds: ["b1"] }]);

    assert.match(sections.subjectDefinitions, /<Subject 2> is 沈侯/);
    assert.doesNotMatch(sections.subjectDefinitions, /<Picture 2>/);
});

test("纯声线角色经过实体清单覆盖后仍能编译主体定义", () => {
    const ruleSubjects = ensureCharacterGroupSubjects([{ id: "prop-ring", name: "婚书", aliases: [], shotMarkers: [], profile: "旧婚书", outfits: [], pictures: ["<Picture 1>"], role: "prop" }], {
        voice: { id: "voice", characterName: "沈侯", characterNodeId: "character-shen", subjectId: "shenhou", outfits: [], outfitEnabled: false, voiceEnabled: true },
    });
    // 打开表单时保存下来的实体清单：纯声线角色的「视觉来源」是空的。
    const definitions = toSubjectDefinitions(ensureCharacterGroupSubjectDefinitions(toSubjectDefinitions(ruleSubjects), {
        voice: { id: "voice", characterName: "沈侯", characterNodeId: "character-shen", subjectId: "shenhou", outfits: [], outfitEnabled: false, voiceEnabled: true },
    }));
    const subjects = mergeSubjectDefinitions(ruleSubjects, definitions);
    const sections = buildStoryboardPromptSections(subjects, [
        { tag: "<Picture 1>", bindingId: "b1", type: "image", role: "storyboard", label: "分镜图", description: "", shotNumbers: [] },
        { tag: "<Audio 1>", bindingId: "b2", type: "audio", role: "character_voice", label: "声线", description: "低沉", subjectId: "shenhou", shotNumbers: [] },
    ], [{ description: "沈侯开口。", referenceIds: ["b1"] }]);

    assert.match(sections.subjectDefinitions, /<Subject 1> is 婚书/);
    assert.match(sections.subjectDefinitions, /<Subject 2> is 沈侯/);
    assert.match(sections.retentionAnalysis, /<Subject 2> \(appears in \[Shot 1\]\)/);
    assert.match(sections.retentionAnalysis, /<Audio 1>/);
});

test("道具图片不必定义主体，仍可作为独立参考通过分镜校验", () => {
    const subjects = [
        { id: "shenzhaoning", name: "沈昭宁", aliases: [], shotMarkers: [], profile: "雪院中的女子", outfits: [], pictures: ["<Picture 3>"] },
        { id: "shenhou", name: "沈侯", aliases: [], shotMarkers: [], profile: "画外说话人", outfits: [], pictures: [] },
    ];
    const references = [
        { tag: "<Picture 1>", bindingId: "storyboard", type: "image", role: "storyboard", label: "分镜图", description: "", shotNumbers: [1] },
        { tag: "<Picture 2>", bindingId: "document", type: "image", role: "prop", label: "婚书", description: "红线装订", shotNumbers: [] },
        { tag: "<Picture 3>", bindingId: "outfit", type: "image", role: "character_turnaround", label: "沈昭宁服装", description: "", shotNumbers: [] },
        { tag: "<Audio 1>", bindingId: "voice", type: "audio", role: "character_voice", label: "沈侯声线", description: "", subjectId: "shenhou", shotNumbers: [] },
    ] as Parameters<typeof buildStoryboardPromptSections>[1];
    const shots = [{ description: "沈昭宁拾起婚书，沈侯从画外说话。", referenceIds: ["storyboard"] }];

    const sections = buildStoryboardPromptSections(subjects, references, shots);
    assert.match(sections.subjectDefinitions, /^<Picture 2> is a prop visual reference/m);
    assert.match(sections.retentionAnalysis, /^<Picture 2>: attribute_transfer/m);
    assert.doesNotMatch(sections.subjectDefinitions, /^<Picture 3> is /m);

    const withPropSubject = buildStoryboardPromptSections([
        ...subjects,
        { id: "document", name: "婚书", aliases: [], shotMarkers: [], profile: "红线装订", outfits: [], pictures: ["<Picture 2>"] },
    ], references, shots);
    assert.doesNotMatch(withPropSubject.subjectDefinitions, /^<Picture 2> is /m);
});

test("服装关闭但声线开启的角色仍规则生成实体定义", () => {
    const subjects = ensureCharacterGroupSubjects([], {
        "group-shen": {
            id: "group-shen",
            characterName: "沈昭宁",
            characterNodeId: "character-shen",
            subjectId: "subject-shen",
            outfits: [{ id: "outfit-1", url: "/media/shen.png", name: "常服", enabled: true }],
            outfitEnabled: false,
            voiceEnabled: true,
        },
    });

    assert.equal(subjects.length, 1);
    assert.equal(subjects[0]?.id, "subject-shen");
    assert.equal(subjects[0]?.name, "沈昭宁");
    assert.equal(subjects[0]?.role, "character_identity");
    assert.match(subjects[0]?.profile || "", /voice/i);
});

test("只有已启用的角色组进入规则实体，关闭声线和服装的组不生成", () => {
    const subjects = ensureCharacterGroupSubjects([], {
        active: { id: "active", characterName: "甲", characterNodeId: "character-a", outfits: [], outfitEnabled: false, voiceEnabled: true },
        disabled: { id: "disabled", characterName: "乙", characterNodeId: "character-b", outfits: [], outfitEnabled: false, voiceEnabled: false },
    });

    assert.deepEqual(subjects.map((subject) => subject.name), ["甲"]);
});

test("已保存的旧实体清单会补回启用中的纯声线角色", () => {
    const definitions = ensureCharacterGroupSubjectDefinitions([{ id: "prop-ring", name: "婚书", profile: "", pictures: [], outfits: [] }], {
        voice: { id: "voice", characterName: "沈昭宁", characterNodeId: "character-shen", subjectId: "subject-shen", outfits: [], outfitEnabled: false, voiceEnabled: true },
    });
    assert.deepEqual(definitions.map((definition) => definition.name), ["婚书", "沈昭宁"]);
    assert.equal(definitions[1]?.role, "character_identity");
});
