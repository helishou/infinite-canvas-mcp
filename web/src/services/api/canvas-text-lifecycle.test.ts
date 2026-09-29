import assert from "node:assert/strict";
import test from "node:test";
import { deletesCanvasTextTarget, evictDeletedCanvasTextSessions, flushCurrentCanvasTextSessions } from "./canvas-text-lifecycle";

test("删除 Clip 只使该 Clip 的提示词会话失效，撤销后可建立新文本会话", () => {
    const deleted = { type: "delete_h3_segment", nodeId: "h3", segmentId: "Clip 1" };
    assert.equal(deletesCanvasTextTarget(deleted, { nodeId: "h3", segmentId: "Clip 1", field: "prompt" }), true);
    assert.equal(deletesCanvasTextTarget(deleted, { nodeId: "h3", segmentId: "Clip 2", field: "prompt" }), false);
    assert.equal(deletesCanvasTextTarget(deleted, { nodeId: "other", segmentId: "Clip 1", field: "prompt" }), false);
    assert.equal(deletesCanvasTextTarget({ type: "add_h3_segment", nodeId: "h3", segment: { id: "Clip 1" } }, { nodeId: "h3", segmentId: "Clip 1", field: "prompt" }), false);
});

test("删节点或整组替换 Clip 时使相应文本会话失效", () => {
    assert.equal(deletesCanvasTextTarget({ type: "delete_node", id: "h3" }, { nodeId: "h3", segmentId: "Clip 1", field: "prompt" }), true);
    assert.equal(deletesCanvasTextTarget({ type: "replace_h3_segments", nodeId: "h3", segments: [] }, { nodeId: "h3", segmentId: "Clip 1", field: "prompt" }), true);
    assert.equal(deletesCanvasTextTarget({ type: "replace_h3_segments", nodeId: "h3", segments: [] }, { nodeId: "h3", field: "prompt" }), false);
});

test("删除后撤销重建同 ID Clip 时不复用旧文档会话，也不影响其他 Clip", () => {
    const clip1 = { backend: "local", projectId: "project", target: { nodeId: "h3", segmentId: "Clip 1", field: "prompt" as const }, documentId: "old-document" };
    const clip2 = { ...clip1, target: { nodeId: "h3", segmentId: "Clip 2", field: "prompt" as const }, documentId: "other-document" };
    const sessions = new Map([["clip1", clip1], ["clip2", clip2]]);
    evictDeletedCanvasTextSessions(sessions, "local", "project", [{ type: "delete_h3_segment", nodeId: "h3", segmentId: "Clip 1" }]);
    assert.equal(sessions.has("clip1"), false);
    assert.equal(sessions.get("clip2"), clip2);
    sessions.set("clip1", { ...clip1, documentId: "restored-document" });
    assert.equal(sessions.get("clip1")?.documentId, "restored-document");
});

test("旧 Clip 文档草稿保留且不阻断其他图片节点的生成前同步", async () => {
    let oldFlushed = 0;
    let imageFlushed = 0;
    const oldClip = { initialize: async () => {}, getSnapshot: () => ({ pending: 1 }), hasReplacedDocument: () => true, flush: async () => { oldFlushed++; throw new Error("旧文档不能提交"); } };
    const imagePrompt = { initialize: async () => {}, getSnapshot: () => ({ pending: 1 }), hasReplacedDocument: () => false, flush: async () => { imageFlushed++; } };
    await flushCurrentCanvasTextSessions([oldClip, imagePrompt]);
    assert.equal(oldFlushed, 0);
    assert.equal(imageFlushed, 1);
});

test("当前文档的同步失败仍阻止生成", async () => {
    const active = { initialize: async () => {}, getSnapshot: () => ({ pending: 1 }), hasReplacedDocument: () => false, flush: async () => { throw new Error("当前提示词未同步"); } };
    await assert.rejects(flushCurrentCanvasTextSessions([active]), /当前提示词未同步/);
});
