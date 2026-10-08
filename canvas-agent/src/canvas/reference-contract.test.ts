import test from "node:test";
import assert from "node:assert/strict";

import { characterGroupBindings, compileReferenceSubmission, normalizeReferenceRole } from "./reference-contract.js";

test("legacy director identity references normalize to H3 character_identity, not other", () => {
    assert.equal(normalizeReferenceRole("identity"), "character_identity");
    const result = compileReferenceSubmission({}, { taskMode: "ref2va", prompt: "<Picture 1>", referenceBindings: [
        { id: "cui", assetId: "cui", label: "Cuizi", role: "identity", subjectId: "C_CUI", tags: [], enabled: true, usage: "reference", mediaType: "image", url: "https://example.test/cui.png" },
    ] });
    assert.equal(result.references[0].role, "character_identity");
    assert.equal(result.references[0].subjectId, "C_CUI");
});

test("分镜图片固定占用最前 Picture 槽，旧提示词按绑定身份改写", () => {
    const binding = (id: string, role: "storyboard" | "character_identity") => ({
        id, assetId: id, label: id, role, tags: [], enabled: true, usage: "reference", mediaType: "image", url: `https://example.test/${id}.png`,
    });
    const result = compileReferenceSubmission({}, {
        taskMode: "ref2va",
        prompt: "<Picture 1> <Picture 2> <Picture 3> <Picture 4>",
        referenceBindings: [binding("person-a", "character_identity"), binding("board-a", "storyboard"), binding("person-b", "character_identity"), binding("board-b", "storyboard")],
        storyboardShots: [{ referenceBindingId: "board-b" }, { referenceBindingId: "board-a" }],
    });
    assert.deepEqual(result.references.map((ref) => [ref.token, ref.id]), [
        ["<Picture 1>", "board-b"], ["<Picture 2>", "board-a"], ["<Picture 3>", "person-a"], ["<Picture 4>", "person-b"],
    ]);
    assert.equal(result.semanticPrompt, "<Picture 1> <Picture 2> <Picture 3> <Picture 4>");
    assert.equal(result.compiledPrompt, "<Picture 3> <Picture 2> <Picture 4> <Picture 1>");
});

test("单张分镜图也排在人物图之前", () => {
    const refs = ["person-a", "person-b", "board"].map((id) => ({
        id, assetId: id, label: id, role: id === "board" ? "storyboard" : "other",
        tags: [], enabled: true, usage: "reference", mediaType: "image", url: `https://example.test/${id}.png`,
    }));
    const result = compileReferenceSubmission({}, { taskMode: "ref2va", prompt: "<Picture 1> <Picture 2> <Picture 3>", referenceBindings: refs });
    assert.deepEqual(result.references.map((ref) => ref.id), ["board", "person-a", "person-b"]);
    assert.equal(result.compiledPrompt, "<Picture 2> <Picture 3> <Picture 1>");
});

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

test("关闭服装总开关不提交图片，保留单件选择且不关闭声线", () => {
    const segment = groupSegment([]);
    const group = segment.h3CharacterGroups["group-1"];
    const enabledRefs = characterGroupBindings(group);
    segment.referenceBindings = enabledRefs;
    group.outfitEnabled = false;
    const withVoice = { ...segment, h3CharacterGroups: { "group-1": {
        ...group, voiceEnabled: true, voice: { url: "http://media.test/voice.mp3", storageKey: "audio:voice" },
    } } };
    const before = structuredClone(withVoice);
    const result = compileReferenceSubmission(groupProject, withVoice);
    assert.deepEqual(result.references.map((ref) => ref.mediaType), ["audio"]);
    assert.deepEqual(result.issues.filter((issue) => issue.severity === "error"), []);
    assert.deepEqual(withVoice, before, "编译不得清空服装目录或单件选择");
    group.outfitEnabled = true;
    assert.deepEqual(compileReferenceSubmission(groupProject, segment).references.map((ref) => ref.storageKey), ["image:a", "image:b"]);
});

for (const role of ["scene", "storyboard"] as const) {
    test(`刷新旧角色绑定保持 Picture 的媒体语义，兼容${role}排序`, () => {
        const segment = groupSegment([]);
        const outfits = characterGroupBindings(segment.h3CharacterGroups["group-1"]);
        segment.referenceBindings = [
            { ...outfits[1], id: "legacy-outfit-b", storageKey: "image:stale-b" },
            { id: "scene", assetId: "scene", label: "场景", role, mediaType: "image", storageKey: "image:scene", enabled: true, tags: [], usage: "reference" },
            { ...outfits[0], id: "legacy-outfit-a", storageKey: "image:stale-a" },
        ];
        segment.prompt = "<Picture 1> / <Picture 2> / <Picture 3>";
        const before = structuredClone(segment);
        const result = compileReferenceSubmission(groupProject, segment);
        const media = [...result.compiledPrompt.matchAll(/<Picture (\d+)>/g)]
            .map((match) => result.references.filter((ref) => ref.mediaType === "image")[Number(match[1]) - 1].storageKey);
        assert.deepEqual(media, ["image:b", "image:scene", "image:a"]);
        assert.deepEqual(result.issues.filter((issue) => issue.severity === "error"), []);
        assert.deepEqual(segment, before, "生成编译不得改写已保存提示词和参考快照");
    });
}

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
