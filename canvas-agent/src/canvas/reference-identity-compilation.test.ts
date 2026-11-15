import test from "node:test";
import assert from "node:assert/strict";

import { assertReferenceCompilation, compileReferenceSubmission } from "./reference-contract.js";
import { compareLabelMaps } from "./reference-identity.js";

const binding = (id: string, storageKey: string) => ({
    id, assetId: id, label: id, role: "other", tags: [], enabled: true,
    usage: "reference", mediaType: "image", url: `https://example.test/${id}.png`, storageKey,
});

function compile(secondStorageKey: string, prompt = "使用 <Picture 1> 与 <Picture 2> 生成 [Shot 1]") {
    return compileReferenceSubmission({}, {
        taskMode: "ref2va",
        prompt,
        referenceBindings: [binding("asset-a", "image:a"), binding("asset-b", secondStorageKey)],
    });
}

test("编译产物带 labelMap 与 labelMapHash；身份校验只追加 warning，不触发阻断", () => {
    const result = compile("image:b");
    assert.ok(result.labelMap, "编译期必须产出编号→身份映射");
    assert.equal(Object.keys(result.labelMap.byToken).length, 2);
    assert.equal(result.labelMap.byToken["<Picture 1>"].identity.assetId, "asset-a");
    assert.equal(result.labelMap.byToken["<Picture 2>"].identity.storageKey, "image:b");
    assert.equal(typeof result.labelMapHash, "string");
    assert.notEqual(result.labelMapHash, "");
    assert.ok(result.issues.every((issue) => issue.severity !== "error"), "本阶段不得新增 error");
    assert.doesNotThrow(() => assertReferenceCompilation(result), "warning 不该阻断生成");
    // 正文格式完全不变，避免撞翻译冻结哈希。
    assert.equal(result.semanticPrompt, "使用 <Picture 1> 与 <Picture 2> 生成 [Shot 1]");
});

test("换图但正文没改 → 前后 labelMap 比对报 mismatch；正文同步改写则不报", () => {
    const before = compile("image:b");
    const after = compile("image:b-replaced");
    assert.equal(before.semanticPrompt, after.semanticPrompt);
    assert.notEqual(before.labelMapHash, after.labelMapHash, "换图必须改变摘要");

    const issues = compareLabelMaps(before.labelMap!, after.labelMap!, {
        promptBefore: before.semanticPrompt,
        promptAfter: after.semanticPrompt,
    });
    assert.ok(issues.some((issue) => issue.code === "prompt_reference_identity_mismatch" && issue.message.includes("<Picture 2>")));
    assert.ok(issues.every((issue) => issue.severity === "warning"));

    const rewritten = compareLabelMaps(before.labelMap!, after.labelMap!, {
        promptBefore: before.semanticPrompt,
        promptAfter: `${after.semanticPrompt}（正文已随绑定改写）`,
    });
    assert.ok(!rewritten.some((issue) => issue.code === "prompt_reference_identity_mismatch"));
});

test("绑定移除但正文仍引用 → dangling warning，删除前可据此提示", () => {
    const before = compile("image:b");
    const after = compileReferenceSubmission({}, {
        taskMode: "ref2va",
        prompt: "使用 <Picture 1> 与 <Picture 2> 生成 [Shot 1]",
        referenceBindings: [{ ...binding("asset-a", "image:a") }],
    });
    // 正文越界已有 error（prompt_reference_missing），这里只验证身份层的 dangling 提示。
    const issues = compareLabelMaps(before.labelMap!, after.labelMap!, {
        promptBefore: before.semanticPrompt,
        promptAfter: before.semanticPrompt,
    });
    assert.ok(issues.some((issue) => issue.code === "prompt_reference_dangling" && issue.message.includes("<Picture 2>")));
});
