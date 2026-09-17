import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { resolve } from "node:path";
import { getPluginNodeView } from "./plugin-node-view";
import { persistPromptCandidate, promptJobs, setPromptJob } from "../../../../plugins/canvas/minimax-h3/src/services/h3-prompt-jobs";
import { H3_LOCAL_VIEW_DEFAULTS, splitH3MetadataPatch } from "../../../../plugins/canvas/minimax-h3/src/hooks/useH3LocalView";
import { buildRestoreParamsPatch } from "../../../../plugins/canvas/minimax-h3/src/services/h3-segment-utils";
import type { H3Segment } from "../../../../plugins/canvas/minimax-h3/src/types";
import { H3_LOCAL_VIEW_FIELDS } from "../../../../canvas-agent/src/canvas/runtime-fields";
import type { CanvasNodeContext, CanvasTextSuggestions } from "../../../../plugins/canvas/sdk/src/types";

test("插件本地视图按项目/节点隔离，裁剪重挂载复用视图且只通知实际变化", () => {
    const view = getPluginNodeView("view-project", "node");
    const empty = view.getSnapshot();
    assert.equal(view.getSnapshot(), empty);
    let notifications = 0;
    const unsubscribe = view.subscribe(() => { notifications++; });
    view.update({ selectedSegmentId: "S04" });
    view.update({ selectedSegmentId: "S04" });
    assert.equal(notifications, 1);
    assert.equal(getPluginNodeView("view-project", "node"), view);
    assert.equal(getPluginNodeView("other-project", "node").getSnapshot().selectedSegmentId, undefined);
    assert.equal(getPluginNodeView("view-project", "other-node").getSnapshot().selectedSegmentId, undefined);
    unsubscribe();
    view.update({ playhead: 12 });
    assert.equal(notifications, 1);
});

test("H3 个人选择、播放与内部布局不会混入共享 metadata", () => {
    const patch = { ...H3_LOCAL_VIEW_DEFAULTS, segments: [{ id: "S03" }], prompt: "共享提示词" };
    const { personal, shared } = splitH3MetadataPatch(patch);
    assert.deepEqual(personal, H3_LOCAL_VIEW_DEFAULTS);
    assert.deepEqual(shared, { segments: [{ id: "S03" }], prompt: "共享提示词" });
    assert.equal(Object.hasOwn(shared, "selectedSegmentId"), false);
    assert.equal(Object.hasOwn(shared, "minimaxTimelineH"), false);
    assert.equal(Object.hasOwn(shared, "timelineScrollLeft"), false);
    assert.equal(Object.hasOwn(shared, "nanFengExpandedSections"), false);
    assert.deepEqual(new Set(H3_LOCAL_VIEW_FIELDS.filter((key) => key in H3_LOCAL_VIEW_DEFAULTS)), new Set(Object.keys(H3_LOCAL_VIEW_DEFAULTS)));
});

test("文本类插件的编辑态留在当前窗口，正文使用协作文本协议", () => {
    for (const plugin of ["markdown", "html", "sticky-note", "svg", "template"]) {
        const source = readFileSync(resolve("../plugins/canvas", plugin, "src/index.tsx"), "utf8");
        assert.match(source, /ctx\.view\.update\(\{ editing:/);
        assert.match(source, /target=\{\{ nodeId: ctx\.node\.id, field: "content" \}\}/);
        assert.doesNotMatch(source, /ctx\.updateMetadata\(\{ editing:/);
        assert.doesNotMatch(source, /onChange=\{\(e\) => ctx\.updateMetadata\(\{ content:/);
    }
});

test("H3 历史输出按 generationLogId 还原生成时快照，不借用源 Clip 的当前参数", () => {
    const segments: H3Segment[] = [{ id: "S03", prompt: "后来修改", steps: 12, result: "/media/old.mp4", refItems: [{ url: "/media/current.png", type: "image", name: "当前参考" }] }];
    const historical = buildRestoreParamsPatch(segments, {
        url: "/media/old.mp4", type: "video", name: "旧结果", segmentId: "S03", generationLogId: "log-1",
        params: { prompt: "生成时提示词", steps: 6, refs: [{ url: "/media/history.png", type: "image", name: "生成时参考" }] },
    });
    assert.equal(historical.prompt, "生成时提示词");
    assert.equal(historical.steps, 6);
    assert.equal(historical.refItems?.[0]?.url, "/media/history.png");
    const current = buildRestoreParamsPatch(segments, { url: "/media/old.mp4", type: "video", name: "当前结果", segmentId: "S03" });
    assert.equal(current.prompt, "后来修改");
    assert.equal(current.steps, 12);
});

test("强化先持久化候选，再按捕获的文档身份和原文尝试采用", async () => {
    const calls: unknown[][] = [];
    const suggestions = {
        save: async (...args: unknown[]) => { calls.push(["save", ...args]); },
        apply: async (...args: unknown[]) => { calls.push(["apply", ...args]); },
    } as unknown as CanvasTextSuggestions;
    await persistPromptCandidate(suggestions, { requestId: "request", documentId: "original-document", base: "原文" }, "强化");
    assert.deepEqual(calls, [["save", { id: "request", documentId: "original-document", base: "原文", text: "强化" }], ["apply", "request", "original-document", "原文"]]);
});

test("采用被拒绝时已保存候选仍在；保存失败则绝不提交替换", async () => {
    let saved: unknown;
    let attempts = 0;
    const suggestions = {
        save: async (value: unknown) => { saved = value; },
        apply: async () => { attempts++; throw new Error("原文变化"); },
    } as unknown as CanvasTextSuggestions;
    const job = { requestId: "id", documentId: "doc", base: "原文" };
    await assert.rejects(persistPromptCandidate(suggestions, job, "候选"), /原文变化/);
    assert.deepEqual(saved, { id: "id", documentId: "doc", base: "原文", text: "候选" });
    suggestions.save = async () => { throw new Error("未保存"); };
    await assert.rejects(persistPromptCandidate(suggestions, job, "候选"), /未保存/);
    assert.equal(attempts, 1);
});

test("不同 Clip 强化的进行状态与候选独立保存，不进入共享节点", () => {
    const ctx = { view: getPluginNodeView("prompt-project", "parallel-jobs") } as unknown as CanvasNodeContext;
    setPromptJob(ctx, "S03", { requestId: "a", documentId: "d3", base: "原文", status: "running" });
    setPromptJob(ctx, "S04", { requestId: "b", documentId: "d4", base: "下一段", status: "running" });
    setPromptJob(ctx, "S03", { requestId: "a", documentId: "d3", base: "原文", status: "suggestion", text: "候选" });
    assert.equal(promptJobs(ctx).S04.status, "running");
    assert.equal(promptJobs(ctx).S03.text, "候选");
});
