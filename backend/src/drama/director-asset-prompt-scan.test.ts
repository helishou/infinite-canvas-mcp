import test from "node:test";
import assert from "node:assert/strict";

import type { DirectorProduction } from "@basketikun/canvas-agent/drama/production-contract";
import { scanDirectorAssetPromptReferences } from "./director-asset-delete.js";

function directorWith(artifacts: Array<Record<string, unknown>>): DirectorProduction {
    return { artifacts } as unknown as DirectorProduction;
}

const artifact = (references: Array<Record<string, unknown>>, prompt: string, targetId = "seg-1") => ({
    targetId,
    prompt,
    references,
});

const ref = (assetId: string) => ({
    label: "参考", assetId, bindingId: `b-${assetId}`, nodeId: `n-${assetId}`,
    storageKey: `image:${assetId}`, sha256: "a".repeat(64), role: "character_identity",
});

test("删除前只读扫描：正文仍带编号且产物引用该资产 → warning，列出段与编号", () => {
    const director = directorWith([artifact([ref("asset-2")], "使用 <Picture 2> 与 <Picture 10> 生成 [Shot 1]")]);
    const before = JSON.stringify(director);
    const issues = scanDirectorAssetPromptReferences(director, "asset-2");
    assert.equal(issues.length, 1);
    assert.equal(issues[0].severity, "warning");
    assert.equal(issues[0].code, "prompt_reference_dangling");
    assert.equal(issues[0].targetId, "seg-1");
    assert.deepEqual(issues[0].tokens, ["<Picture 2>", "<Picture 10>"]);
    assert.match(issues[0].message, /只读提示，不阻断删除/);
    assert.equal(JSON.stringify(director), before, "扫描必须纯只读");
});

test("无关资产、正文无编号、空 assetId 都不报", () => {
    const director = directorWith([
        artifact([ref("asset-2")], "使用 <Picture 2>"),
        artifact([ref("asset-3")], "<Picture 1>"),
        artifact([ref("asset-4")], "没有任何编号的纯文本"),
    ]);
    assert.equal(scanDirectorAssetPromptReferences(director, "asset-9").length, 0);
    assert.equal(scanDirectorAssetPromptReferences(director, "  ").length, 0);
    assert.equal(scanDirectorAssetPromptReferences(director, "asset-4").length, 0);
    assert.equal(scanDirectorAssetPromptReferences(director, "asset-3").length, 1);
});

test("按 bindingId / nodeId / storageKey 命中，多个段分别报告", () => {
    const director = directorWith([
        artifact([{ ...ref("x"), bindingId: "target-binding" }], "<Picture 1>", "seg-a"),
        artifact([{ ...ref("y"), nodeId: "target-node" }], "<Video 1>", "seg-b"),
        artifact([{ ...ref("z"), storageKey: "image:target" }], "<Audio 1>", "seg-c"),
    ]);
    assert.deepEqual(scanDirectorAssetPromptReferences(director, "target-binding").map((issue) => issue.targetId), ["seg-a"]);
    assert.deepEqual(scanDirectorAssetPromptReferences(director, "target-node").map((issue) => issue.targetId), ["seg-b"]);
    assert.deepEqual(scanDirectorAssetPromptReferences(director, "image:target").map((issue) => issue.targetId), ["seg-c"]);
});

test("空产物与无 artifacts 的制作稿安全返回空", () => {
    assert.deepEqual(scanDirectorAssetPromptReferences({} as DirectorProduction, "asset-2"), []);
    assert.deepEqual(scanDirectorAssetPromptReferences(directorWith([]), "asset-2"), []);
});
