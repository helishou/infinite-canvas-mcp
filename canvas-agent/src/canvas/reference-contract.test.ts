import test from "node:test";
import assert from "node:assert/strict";

import { compileReferenceSubmission } from "./reference-contract.js";

test("提示词使用公开编号标签，主体定义补入对应图片引用", () => {
    const project = { referenceCatalog: [
        { id: "a", label: "人物", mediaType: "image", role: "character_identity", tags: [], storageKey: "image:a" },
        { id: "b", label: "分镜", mediaType: "image", role: "storyboard", tags: [], storageKey: "image:b" },
    ] };
    const segment = { taskMode: "ref2va", prompt: "subject_definitions:\n<subject 1> 人物定义\nsummary:\n对照 <picture 1>", referenceBindings: [
        { id: "bind-b", assetId: "b", label: "分镜", role: "storyboard", tags: [], enabled: true, usage: "reference" },
        { id: "bind-a", assetId: "a", label: "人物", role: "character_identity", tags: [], enabled: true, usage: "reference", subjectId: "person-a" },
    ] };
    const result = compileReferenceSubmission(project, segment);
    assert.equal(result.compiledPrompt, "subject_definitions:\n<Subject 1> 人物定义 The source appearance and costume are referenced from <Picture 2>.\nsummary:\n对照 <Picture 1>");
    assert.deepEqual(result.references.map((ref) => ref.role), ["storyboard", "character_identity"]);
    assert.equal(result.issues.filter((issue) => issue.severity === "error").length, 0);
});

test("旧 refs 首次读取可归一化为 bindings，色卡只警告不阻断", () => {
    const result = compileReferenceSubmission({}, { taskMode: "ref2va", prompt: "<Picture 1>", refItems: [{ url: "http://local/palette.png", type: "image", name: "项目色卡" }] });
    assert.equal(result.migratedLegacyRefs, true);
    assert.equal(result.bindings.length, 1);
    assert.equal(result.bindings[0].role, "palette");
    assert.ok(result.issues.some((issue) => issue.code === "palette_as_runtime_reference" && issue.severity === "warning"));
});

test("公开编号标签规范化为 H3 接口大小写", () => {
    const result = compileReferenceSubmission({}, { taskMode: "ref2va", prompt: "<subject 1> from <picture 2>", referenceBindings: [] });
    assert.equal(result.compiledPrompt, "<Subject 1> from <Picture 2>");
});

test("非角色 Subject 定义只需在提示词中声明，不按角色卡数量卡控", () => {
    const result = compileReferenceSubmission({}, {
        taskMode: "ref2va",
        prompt: "subject_definitions:\n<Subject 1> 一把旧雨伞\nsummary:\n<Subject 1> 被拿起",
        referenceBindings: [],
    });
    assert.equal(result.issues.filter((issue) => issue.code === "prompt_reference_missing" && issue.severity === "error").length, 0);
});

test("公开编号标签引用未启用的素材时预检报错", () => {
    const result = compileReferenceSubmission({}, { taskMode: "ref2va", prompt: "<Picture 1>", referenceBindings: [] });
    assert.ok(result.issues.some((issue) => issue.code === "prompt_reference_missing" && issue.severity === "error"));
});

test("T2V 提示词引用参考素材时预检阻断", () => {
    const result = compileReferenceSubmission({}, { taskMode: "t2v", prompt: "沿用 <Picture 1> 的人物", referenceBindings: [] });
    assert.ok(result.issues.some((issue) => issue.code === "t2v_prompt_uses_reference" && issue.severity === "error"));
});

test("Clip 绑定职责覆盖项目资产默认职责，但媒体读取项目资产最新版本", () => {
    const project = { referenceCatalog: [{ id: "asset-1", label: "项目素材", mediaType: "image", role: "scene", tags: ["项目标签"], storageKey: "image:new" }] };
    const segment = { taskMode: "ref2va", prompt: "<picture 1>", referenceBindings: [{ id: "binding-1", assetId: "asset-1", label: "旧快照", role: "blocking", tags: ["本镜站位"], enabled: true, usage: "reference", storageKey: "image:old" }] };
    const result = compileReferenceSubmission(project, segment);

    assert.equal(result.references[0].role, "blocking");
    assert.deepEqual(result.references[0].tags, ["本镜站位"]);
    assert.equal(result.references[0].storageKey, "image:new");
});

test("同一媒体在不同 Clip 保留各自名称与主体，来源节点的新主图在提交时解析", () => {
    const project = {
        referenceCatalog: [{ id: "shared", label: "全局名称", mediaType: "image", role: "other", tags: [], storageKey: "image:old" }],
        nodes: [{ id: "smart", type: "config", metadata: { smart: true, generationMode: "image", primaryImageId: "new", images: [{ id: "new", content: "/media/new", storageKey: "image:new", mimeType: "image/png" }] } }],
    };
    const binding = (label: string, subjectId: string) => [{
        id: `bind-${subjectId}`, assetId: "shared", label, role: "character_identity", tags: [subjectId],
        subjectId, sourceNodeId: "smart", enabled: true, usage: "reference",
    }];
    const first = compileReferenceSubmission(project, { taskMode: "ref2va", prompt: "<Picture 1>", referenceBindings: binding("角色甲", "a") });
    const second = compileReferenceSubmission(project, { taskMode: "ref2va", prompt: "<Picture 1>", referenceBindings: binding("角色乙", "b") });
    assert.deepEqual([first.references[0].label, second.references[0].label], ["角色甲", "角色乙"]);
    assert.deepEqual([first.references[0].subjectId, second.references[0].subjectId], ["a", "b"]);
    assert.deepEqual([first.references[0].storageKey, second.references[0].storageKey], ["image:new", "image:new"]);
});

// 角色组参考绑定是 h3CharacterGroups 的派生视图：写工具整组替换 bindings 时不必重建它们。
// 这是 h3_set_reference_bindings 26/64 失败（character_group_binding_count /
// character_group_binding_source_mismatch）的根因修复。
const characterNode = {
    id: "character-1",
    type: "character",
    metadata: {
        characterAssetId: "asset-char-1",
        characterName: "沈侯",
        characterImages: [
            { url: "http://media.test/a.png", storageKey: "image:a", outfit: "常服", role: "character_turnaround" },
            { url: "http://media.test/b.png", storageKey: "image:b", outfit: "夜行", role: "character_turnaround" },
        ],
    },
};
const groupProject = { nodes: [characterNode] };
const groupSegment = (bindings: unknown[]) => ({
    taskMode: "ref2va",
    prompt: "<Subject 1> 走出画面\n<d>[Chinese] 既然如此，我谢家与你们再无干系。</d>",
    h3CharacterGroups: {
        "group-1": {
            id: "group-1",
            characterName: "沈侯",
            characterAssetId: "asset-char-1",
            characterNodeId: "character-1",
            subjectId: "shen-hou",
            outfitEnabled: true,
            outfits: [
                { id: "outfit-1", url: "http://media.test/a.png", storageKey: "image:a", name: "常服", role: "character_turnaround", enabled: true },
                { id: "outfit-2", url: "http://media.test/b.png", storageKey: "image:b", name: "夜行", role: "character_turnaround", enabled: true },
            ],
            voiceEnabled: false,
        },
    },
    referenceBindings: bindings,
});

test("整组替换 bindings 不含角色组派生行时，编译器仍提交角色组服装并零报错", () => {
    const result = compileReferenceSubmission(groupProject, groupSegment([
        { id: "bind-scene", assetId: "asset-scene", label: "雪庭院", role: "scene", tags: [], enabled: true, usage: "reference", storageKey: "image:scene" },
    ]));
    const errors = result.issues.filter((issue) => issue.severity === "error");
    assert.deepEqual(errors, [], errors.map((issue) => issue.message).join("；"));
    const groupRefs = result.references.filter((ref) => ref.groupId === "group-1");
    assert.equal(groupRefs.length, 2);
    assert.deepEqual(groupRefs.map((ref) => ref.outfitId), ["outfit-1", "outfit-2"]);
    assert.deepEqual([...new Set(groupRefs.map((ref) => ref.sourceNodeId))], ["character-1"]);
    assert.deepEqual([...new Set(groupRefs.map((ref) => ref.subjectId))], ["shen-hou"]);
    assert.ok(result.references.some((ref) => ref.label === "雪庭院"));
});

test("角色组派生 binding 的存量快照被逐条覆盖，id 与顺序保持稳定", () => {
    const stale = [{
        id: "stale-binding-id", assetId: "asset-x", label: "旧快照", role: "character_turnaround", tags: [],
        enabled: true, usage: "reference", groupId: "group-1", outfitId: "outfit-1", sourceNodeId: "wrong-node", subjectId: "wrong-subject",
    }];
    const first = compileReferenceSubmission(groupProject, groupSegment(stale));
    const second = compileReferenceSubmission(groupProject, groupSegment([]));
    assert.deepEqual(first.references.map((ref) => ref.id), second.references.map((ref) => ref.id));
    assert.ok(!first.references.some((ref) => ref.id === "stale-binding-id"));
    const outfit1 = first.references.find((ref) => ref.outfitId === "outfit-1");
    assert.equal(outfit1?.sourceNodeId, "character-1");
    assert.equal(outfit1?.subjectId, "shen-hou");
});

test("角色组没有任何启用服装时只提交手工参考，不产生空派生行", () => {
    const segment = groupSegment([]);
    segment.h3CharacterGroups["group-1"].outfits.forEach((outfit) => { outfit.enabled = false; });
    const result = compileReferenceSubmission(groupProject, segment);
    assert.equal(result.references.filter((ref) => ref.groupId === "group-1").length, 0);
    assert.equal(result.issues.filter((issue) => issue.severity === "error").length, 0);
});
