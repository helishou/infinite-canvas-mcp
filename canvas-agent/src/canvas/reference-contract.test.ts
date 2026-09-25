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
