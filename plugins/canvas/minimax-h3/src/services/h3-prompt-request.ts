import type { CanvasNodeContext } from "@infinite-canvas/plugin-sdk";
import { segmentsFor } from "../hooks/useH3Segments";

/** Capture text, references and candidate destination from the same Clip at click time. */
export function captureH3PromptRequest(ctx: CanvasNodeContext, segmentId: string) {
    const metadata = ctx.getNode(ctx.node.id)?.metadata || ctx.node.metadata || {};
    const segment = segmentsFor(metadata).find((item) => item.id === segmentId);
    if (!segment) throw new Error("当前 Clip 已不存在，无法增强提示词");
    const target = { nodeId: ctx.node.id, segmentId, field: "prompt" as const };
    const document = ctx.textDocument(target);
    const snapshot = document.getSnapshot();
    if (!snapshot.ready || snapshot.blocked) throw new Error(snapshot.error || "当前 Clip 的提示词尚未同步");
    if (!snapshot.text.trim()) throw new Error("请先输入当前 Clip 的提示词");
    return {
        metadata, segment, document,
        prompt: snapshot.text,
        documentId: document.getDocumentId(),
        suggestions: ctx.textSuggestions(target),
    };
}
