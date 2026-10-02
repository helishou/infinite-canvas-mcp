import assert from "node:assert/strict";
import test from "node:test";
import type { CanvasNodeContext, CanvasTextSnapshot } from "@infinite-canvas/plugin-sdk";
import { captureH3PromptRequest } from "./h3-prompt-request";
import { persistPromptCandidate } from "./h3-prompt-jobs";
import { refsForSegment } from "./h3-data";

function fixture() {
    const snapshots: Record<string, CanvasTextSnapshot> = {
        a: { ready: true, blocked: false, pending: 0, error: "", text: "Clip A: bridge fight" },
        b: { ready: true, blocked: false, pending: 1, error: "", text: "Clip B: newly edited pond dialogue" },
    };
    let metadata = { selectedSegmentId: "a", segments: [
        { id: "a", prompt: "Clip A: bridge fight", mode: "ref2va", duration: 8, referenceBindings: [{ id: "a-ref", assetId: "a-asset", label: "A image", role: "scene", mediaType: "image", url: "https://media.test/a.png" }] },
        { id: "b", prompt: "Clip B: old metadata draft", mode: "i2v", duration: 5, referenceBindings: [{ id: "b-ref", assetId: "b-asset", label: "B image", role: "scene", mediaType: "image", url: "https://media.test/b.png" }] },
    ] };
    const writes: Array<{ segmentId: string; kind: string; documentId: string; base: string; text?: string }> = [];
    const documents = Object.fromEntries(Object.keys(snapshots).map((id) => [id, {
        getSnapshot: () => snapshots[id], subscribe: () => () => {}, getDocumentId: () => `doc-${id}`, flush: async () => {},
    }]));
    const ctx = {
        node: { id: "h3", metadata },
        getNode: () => ({ id: "h3", metadata }),
        textDocument: (target: { segmentId: string }) => documents[target.segmentId],
        textSuggestions: (target: { segmentId: string }) => ({
            save: async (input: { documentId: string; base: string; text: string }) => { writes.push({ segmentId: target.segmentId, kind: "save", ...input }); },
            apply: async (_id: string, documentId: string, base: string) => { writes.push({ segmentId: target.segmentId, kind: "apply", documentId, base }); },
        }),
    } as unknown as CanvasNodeContext;
    return { ctx, snapshots, writes, switchTo: (id: string) => { metadata = { ...metadata, selectedSegmentId: id }; } };
}

test("切换后立刻增强 B：原文、文本身份、模式、时长和参考都来自 B，忽略 A 和陈旧 metadata", () => {
    const { ctx, switchTo } = fixture();
    const previousDocument = ctx.textDocument({ nodeId: "h3", segmentId: "a", field: "prompt" });
    switchTo("b");
    const request = captureH3PromptRequest(ctx, "b");
    assert.notEqual(request.document, previousDocument);
    assert.equal(request.prompt, "Clip B: newly edited pond dialogue");
    assert.equal(request.documentId, "doc-b");
    assert.equal(request.segment.mode, "i2v");
    assert.equal(request.segment.duration, 5);
    assert.deepEqual(refsForSegment(request.segment).map((ref) => ref.name), ["B image"]);
});

test("请求发出后切回 A：B 的候选保存和采用仍只对应 B 的原文与文档", async () => {
    const { ctx, switchTo, writes } = fixture();
    const request = captureH3PromptRequest(ctx, "b");
    switchTo("a");
    await persistPromptCandidate(request.suggestions, { requestId: "b-request", base: request.prompt, documentId: request.documentId }, "Enhanced B");
    assert.deepEqual(writes.map(({ segmentId, kind, documentId, base }) => ({ segmentId, kind, documentId, base })), [
        { segmentId: "b", kind: "save", documentId: "doc-b", base: request.prompt },
        { segmentId: "b", kind: "apply", documentId: "doc-b", base: request.prompt },
    ]);
});

test("B 尚未就绪、同步受阻或为空时拒绝请求，不能用已就绪的 A 兜底", () => {
    const { ctx, snapshots } = fixture();
    snapshots.b = { ...snapshots.b, ready: false };
    assert.throws(() => captureH3PromptRequest(ctx, "b"), /尚未同步/);
    snapshots.b = { ...snapshots.b, ready: true, blocked: true, error: "B conflict" };
    assert.throws(() => captureH3PromptRequest(ctx, "b"), /B conflict/);
    snapshots.b = { ...snapshots.b, blocked: false, text: " " };
    assert.throws(() => captureH3PromptRequest(ctx, "b"), /请先输入/);
    assert.throws(() => captureH3PromptRequest(ctx, "deleted"), /已不存在/);
});
