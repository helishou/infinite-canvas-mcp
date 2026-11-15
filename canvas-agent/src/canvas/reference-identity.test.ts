import test from "node:test";
import assert from "node:assert/strict";

import type { CompiledReference } from "./reference-contract.js";
import {
    buildLabelMap,
    compareLabelMaps,
    labelMapHash,
    normalizeReferenceToken,
    rewritePromptLabels,
    validateReferenceIdentity,
} from "./reference-identity.js";

function reference(token: string, id: string, assetId = id, storageKey?: string, extra: Record<string, unknown> = {}): CompiledReference {
    return {
        id, assetId, label: id, token,
        ordinal: Number(/\d+/.exec(token)?.[0] || 1),
        mediaType: "image", role: "other", tags: [], enabled: true, usage: "reference",
        ...(storageKey ? { storageKey } : {}),
        ...extra,
    } as unknown as CompiledReference;
}

test("labelMapHash 只由编号→身份决定：顺序无关，换图必变", () => {
    const a = reference("<Picture 1>", "b1", "asset-1", "image:one");
    const b = reference("<Picture 2>", "b2", "asset-2", "image:two");
    const forward = buildLabelMap([a, b]);
    const reversed = buildLabelMap([b, a]);
    assert.equal(labelMapHash(forward), labelMapHash(reversed));
    const changed = buildLabelMap([a, reference("<Picture 2>", "b2", "asset-2", "image:replaced")]);
    assert.notEqual(labelMapHash(forward), labelMapHash(changed), "同一 assetId 换图也必须改变摘要");
    assert.equal(normalizeReferenceToken("<picture 10>"), "<Picture 10>");
    assert.equal(normalizeReferenceToken("<VIDEO  3>"), "<Video 3>");
});

test("编译期身份校验只产 warning，不阻断", () => {
    const duplicate = buildLabelMap([
        reference("<Picture 1>", "b1", "asset-1", "image:one"),
        reference("<Picture 2>", "b2", "asset-1", "image:one"),
    ]);
    const issues = validateReferenceIdentity("<Picture 1> 和 <Picture 2>", duplicate);
    assert.ok(issues.length > 0);
    assert.ok(issues.every((issue) => issue.severity === "warning"), "assertReferenceCompilation 只拦 error");
    assert.ok(issues.some((issue) => issue.code === "prompt_reference_identity_duplicated"));

    const unstable = buildLabelMap([reference("<Picture 1>", "", "")]);
    assert.ok(validateReferenceIdentity("<Picture 1>", unstable).some((issue) => issue.code === "prompt_reference_identity_unstable"));

    const unused = buildLabelMap([
        reference("<Picture 1>", "b1", "asset-1", "image:one"),
        reference("<Picture 2>", "b2", "asset-2", "image:two"),
    ]);
    assert.ok(validateReferenceIdentity("<Picture 1>", unused).some((issue) => issue.code === "prompt_reference_identity_unused"));
});

test("换图但正文没改报 mismatch；正文同步改写不报；绑定移除仍被引用报 dangling", () => {
    const before = buildLabelMap([
        reference("<Picture 1>", "b1", "asset-1", "image:one"),
        reference("<Picture 2>", "b2", "asset-2", "image:two"),
    ]);
    const after = buildLabelMap([
        reference("<Picture 1>", "b1", "asset-1", "image:one"),
        reference("<Picture 2>", "b2", "asset-2", "image:replaced"),
    ]);
    const prompt = "<Picture 1> 与 <Picture 2>";
    const mismatch = compareLabelMaps(before, after, { promptBefore: prompt, promptAfter: prompt });
    assert.ok(mismatch.some((issue) => issue.code === "prompt_reference_identity_mismatch"));
    assert.ok(mismatch.every((issue) => issue.severity === "warning"));

    const rewritten = compareLabelMaps(before, after, { promptBefore: prompt, promptAfter: `${prompt}（已按新绑定改写）` });
    assert.ok(!rewritten.some((issue) => issue.code === "prompt_reference_identity_mismatch"), "正文同步改写是合法重排");

    const removed = buildLabelMap([reference("<Picture 1>", "b1", "asset-1", "image:one")]);
    const dangling = compareLabelMaps(before, removed, { promptBefore: prompt, promptAfter: prompt });
    assert.ok(dangling.some((issue) => issue.code === "prompt_reference_dangling" && issue.message.includes("<Picture 2>")));
});

test("按身份重映射编号：一次性替换，不误匹配 Picture 1 / Picture 10", () => {
    const before = buildLabelMap([
        reference("<Picture 1>", "b1", "asset-1", "image:one"),
        reference("<Picture 10>", "b10", "asset-10", "image:ten"),
    ]);
    const after = buildLabelMap([
        reference("<Picture 3>", "b1", "asset-1", "image:one"),
        reference("<Picture 10>", "b10", "asset-10", "image:ten"),
    ]);
    const rewritten = rewritePromptLabels("Use <picture 1> and <Picture 10> for [Shot 1]", before, after);
    assert.match(rewritten, /<Picture 3> and <Picture 10>/);
    assert.doesNotMatch(rewritten, /<Picture 1>/);

    // 连续漂移不能链式替换：1→2 与 2→3 必须按身份各自一次落位。
    const shiftBefore = buildLabelMap([
        reference("<Picture 1>", "b1", "asset-1", "image:one"),
        reference("<Picture 2>", "b2", "asset-2", "image:two"),
    ]);
    const shiftAfter = buildLabelMap([
        reference("<Picture 2>", "b1", "asset-1", "image:one"),
        reference("<Picture 3>", "b2", "asset-2", "image:two"),
    ]);
    assert.equal(rewritePromptLabels("<Picture 1> <Picture 2>", shiftBefore, shiftAfter), "<Picture 2> <Picture 3>");
});
