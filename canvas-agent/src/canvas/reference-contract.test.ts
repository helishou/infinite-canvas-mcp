import test from "node:test";
import assert from "node:assert/strict";

import { compileReferenceSubmission } from "./reference-contract.js";

test("稳定引用按 binding id 编译，重排后提示词编号自动更新", () => {
    const project = { referenceCatalog: [
        { id: "a", label: "人物", mediaType: "image", role: "character_identity", tags: [], storageKey: "image:a" },
        { id: "b", label: "分镜", mediaType: "image", role: "storyboard", tags: [], storageKey: "image:b" },
    ] };
    const segment = { taskMode: "ref2va", prompt: "{{subject:bind-a}} 对照 {{ref:bind-b}}", referenceBindings: [
        { id: "bind-b", assetId: "b", label: "分镜", role: "storyboard", tags: [], enabled: true, usage: "reference" },
        { id: "bind-a", assetId: "a", label: "人物", role: "character_identity", tags: [], enabled: true, usage: "reference" },
    ] };
    const result = compileReferenceSubmission(project, segment);
    assert.equal(result.compiledPrompt, "<Subject 2> 对照 <Picture 1>");
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

test("语义提示词引用缺失 binding 时预检报错", () => {
    const result = compileReferenceSubmission({}, { taskMode: "ref2va", prompt: "{{ref:missing}}", referenceBindings: [] });
    assert.ok(result.issues.some((issue) => issue.code === "prompt_binding_missing" && issue.severity === "error"));
});

test("T2V 提示词引用参考素材时预检阻断", () => {
    const result = compileReferenceSubmission({}, { taskMode: "t2v", prompt: "沿用 <Picture 1> 的人物", referenceBindings: [] });
    assert.ok(result.issues.some((issue) => issue.code === "t2v_prompt_uses_reference" && issue.severity === "error"));
});

test("Clip 绑定职责覆盖项目资产默认职责，但媒体读取项目资产最新版本", () => {
    const project = { referenceCatalog: [{ id: "asset-1", label: "项目素材", mediaType: "image", role: "scene", tags: ["项目标签"], storageKey: "image:new" }] };
    const segment = { taskMode: "ref2va", prompt: "{{ref:binding-1}}", referenceBindings: [{ id: "binding-1", assetId: "asset-1", label: "旧快照", role: "blocking", tags: ["本镜站位"], enabled: true, usage: "reference", storageKey: "image:old" }] };
    const result = compileReferenceSubmission(project, segment);

    assert.equal(result.references[0].role, "blocking");
    assert.deepEqual(result.references[0].tags, ["本镜站位"]);
    assert.equal(result.references[0].storageKey, "image:new");
});
