import test from "node:test";
import assert from "node:assert/strict";

import { buildRestoreParamsPatch, exportH3Settings, importH3Settings } from "./h3-segment-utils";
import type { H3Ref, H3Segment } from "../types";
import { refsForSegment } from "./h3-data";

const targetSegment: H3Segment = {
    id: "target-clip",
    taskMode: "ref2va",
    duration: 8,
    h3CharacterGroups: {
        "group-shenhou": {
            id: "group-shenhou",
            characterName: "沈侯",
            characterNodeId: "character-shenhou",
            subjectId: "shenhou",
            outfits: [{ id: "outfit-winter", name: "冬装", url: "/media/shenhou.png", storageKey: "image:shenhou", role: "character_turnaround", enabled: true }],
            voiceEnabled: false,
        },
    },
    storyboardShots: [
        { id: "stale-shot", referenceBindingId: "deleted-binding", duration: 4 },
        { id: "stale-empty-shot", duration: 4 },
    ],
};

const historicalOutput: H3Ref = {
    url: "/media/result.mp4",
    type: "video",
    name: "历史输出",
    generationLogId: "generation-1",
    params: {
        prompt: "历史提示词",
        duration: 6,
        refs: [
            { url: "/media/shenhou.png", storageKey: "image:shenhou", type: "image", name: "沈侯 · 冬装", role: "character_turnaround", subjectId: "shenhou", groupId: "group-shenhou", outfitId: "outfit-winter" },
            { url: "/media/board.png", storageKey: "image:board", type: "image", name: "分镜图", role: "storyboard" },
        ],
    },
};

test("还原历史输出从当前角色组派生源节点而不持久双写角色 binding", () => {
    const patch = buildRestoreParamsPatch([], historicalOutput, targetSegment);
    assert.equal(patch.referenceBindings?.some((binding) => binding.groupId), false);
    const characterRef = refsForSegment({ ...targetSegment, ...patch }).find((ref) => ref.groupId === "group-shenhou");
    assert.equal(characterRef?.nodeId, "character-shenhou");
});

test("还原引用时丢弃旧 storyboardShots，按历史分镜引用重建，避免空槽叠加", () => {
    const patch = buildRestoreParamsPatch([], historicalOutput, targetSegment);
    const boardBinding = patch.referenceBindings?.find((binding) => binding.role === "storyboard");
    assert.ok(boardBinding);
    assert.deepEqual(patch.storyboardShots, [{ id: boardBinding.id, referenceBindingId: boardBinding.id }]);
    assert.equal(patch.storyboardShots?.some((shot) => shot.id === "stale-shot"), false);
    assert.equal(patch.storyboardShots?.some((shot) => shot.id === "stale-empty-shot"), false);
});

test("视觉风格模板随设置导出和导入，提示词不在设置文件中", () => {
    const exported = exportH3Settings({ id: "clip", prompt: "用户正文", styleTemplateId: "modern-korean" });
    assert.equal(exported.settings.styleTemplateId, "modern-korean");
    assert.equal(Object.hasOwn(exported.settings, "prompt"), false);
    assert.equal(importH3Settings(exported)?.styleTemplateId, "modern-korean");
});

test("历史参数还原使用可编辑快照，运行时尾帧和实际模式不进入ref配置", () => {
    const output: H3Ref = { url: "/media/result", name: "history", type: "video", generationLogId: "log", params: {
        mode: "ref2va", prompt: "runtime prompt mentioning <Picture 2>", refs: [
            { id: "runtime-tail-next", name: "尾帧", type: "image", url: "/media/tail", runtime: true },
        ], submission: {
            authoredPrompt: "Start with <Picture 1>.", continuation: { requestedMode: "i2v" },
            editableReferences: [{ id: "original", assetId: "image-asset", label: "原分镜", mediaType: "image", url: "/media/original", role: "storyboard" }],
        },
    } };
    const before = structuredClone(output);
    const patch = buildRestoreParamsPatch([], output);
    assert.equal(patch.mode, "i2v");
    assert.equal(patch.prompt, "Start with <Picture 1>.");
    assert.deepEqual(patch.referenceBindings?.map((ref) => [ref.id, ref.url]), [["original", "/media/original"]]);
    assert.deepEqual(output, before);
});

test("旧日志按原绑定清单恢复，临时尾帧保留在日志但不变成参考卡", () => {
    const output: H3Ref = { url: "/media/result", name: "history", type: "video", generationLogId: "log", params: {
        prompt: "Runtime tail <Picture 1>; original <Picture 2>.", refs: [
            { id: "runtime-tail-next", name: "Clip 1 尾帧", type: "image", url: "/media/tail", runtime: true },
            { id: "board", assetId: "board-asset", name: "原分镜", type: "image", url: "/media/board", role: "storyboard" },
        ], submission: { semanticPrompt: "Original <Picture 1>.", bindingMap: [{ id: "board", assetId: "board-asset", label: "原分镜", role: "storyboard" }] },
    } };
    const patch = buildRestoreParamsPatch([], output);
    assert.equal(patch.prompt, "Original <Picture 1>.");
    assert.deepEqual(patch.referenceBindings?.map((ref) => ref.id), ["board"]);
    assert.equal((output.params?.refs as Array<Record<string, unknown>>).length, 2);
});

test("旧首帧替换日志仅从同asset恢复原素材，缺失时拒绝而不丢参考", () => {
    const output: H3Ref = { url: "/media/result", name: "history", type: "video", generationLogId: "log", params: {
        refs: [{ id: "board", name: "尾帧", type: "image", url: "/media/tail", runtime: true }],
        submission: { semanticPrompt: "Original <Picture 1>.", bindingMap: [{ id: "board", assetId: "original-asset", label: "原分镜", role: "storyboard" }] },
    } };
    const target: H3Segment = { id: "target", referenceBindings: [{ id: "board", assetId: "original-asset", url: "/media/original", mediaType: "image", role: "storyboard" }] };
    const before = structuredClone(target);
    const patch = buildRestoreParamsPatch([], output, target);
    assert.equal(patch.referenceBindings?.[0].url, "/media/original");
    assert.deepEqual(target, before);
    assert.throws(() => buildRestoreParamsPatch([], output), /原始素材不可用/);
});

test("手工加入同名尾帧仍是普通用户参考，不能按名称误删", () => {
    const output: H3Ref = { url: "/media/result", name: "history", type: "video", generationLogId: "log", params: {
        prompt: "User prompt", refs: [{ id: "manual-tail", name: "Clip 1 尾帧", type: "image", url: "/media/manual", role: "storyboard" }],
    } };
    assert.equal(buildRestoreParamsPatch([], output).referenceBindings?.[0].url, "/media/manual");
});

test("作者提示词为空时保留当前正文，不把运行时尾帧说明恢复为作者内容", () => {
    const output: H3Ref = { url: "/media/result", name: "history", type: "video", generationLogId: "log", params: {
        prompt: "Runtime tail <Picture 1>.", refs: [{ id: "runtime-tail-next", name: "尾帧", type: "image", url: "/media/tail", runtime: true }],
        submission: { authoredPrompt: "", editableReferences: [] },
    } };
    const patch = buildRestoreParamsPatch([], output);
    assert.equal(Object.hasOwn(patch, "prompt"), false);
    assert.deepEqual(patch.referenceBindings, []);
});
