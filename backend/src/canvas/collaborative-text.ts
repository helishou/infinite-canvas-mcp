import * as Y from "yjs";
import { z } from "zod";
import { textTargetSchema } from "@basketikun/canvas-agent/schemas";
import type { CanvasOperation } from "./project-ops.js";

export { textTargetSchema };
export type CanvasTextTarget = z.infer<typeof textTargetSchema>;
export const textKey = (target: CanvasTextTarget) => JSON.stringify([target.nodeId || "", target.segmentId || "", target.field, ...(target.textItemId ? [target.textItemId] : [])]);

export function readText(project: Record<string, unknown>, target: CanvasTextTarget): string {
    if (!target.nodeId) {
        if (target.field !== "globalPrompt" || target.segmentId || target.textItemId) throw new Error("项目级协作文本仅支持 globalPrompt");
        return String(project.globalPrompt || "");
    }
    const node = (project.nodes as Array<Record<string, unknown>> || []).find((node) => node.id === target.nodeId);
    if (!node) throw new Error(`找不到节点：${target.nodeId}`);
    const metadata = (node.metadata || {}) as Record<string, unknown>;
    if (target.textItemId) {
        if (target.field !== "content" || target.segmentId || node.type !== "text") throw new Error("文本项只支持 content");
        const item = (metadata.texts as Array<Record<string, unknown>> || []).find((item) => item.id === target.textItemId);
        if (!item) throw new Error(`找不到文本项：${target.textItemId}`);
        return String(item.content || "");
    }
    if (target.segmentId) {
        if (target.field !== "prompt") throw new Error("Clip 协作文本仅支持 prompt");
        const segment = (metadata.segments as Array<Record<string, unknown>> || []).find((item) => item.id === target.segmentId);
        if (!segment) throw new Error(`找不到 Clip：${target.segmentId}`);
        return String(segment.prompt || "");
    }
    if (target.field === "globalPrompt" || (target.field === "content" && node.type !== "text")) throw new Error("该字段不是可协作文本");
    return String(metadata[target.field] || "");
}

export function textOperation(target: CanvasTextTarget, text: string, project: Record<string, unknown>): CanvasOperation {
    if (!target.nodeId) return { type: "update_project", patch: { globalPrompt: text } };
    if (target.textItemId) {
        const node = (project.nodes as Array<Record<string, unknown>>).find((node) => node.id === target.nodeId)!;
        const metadata = node.metadata as Record<string, unknown>;
        const texts = metadata.texts as Array<Record<string, unknown>>;
        return { type: "update_node", id: target.nodeId, metadata: {
            texts: texts.map((item) => item.id === target.textItemId ? { ...item, content: text } : item),
            ...((metadata.primaryTextId || texts[0]?.id) === target.textItemId ? { content: text } : {}),
        } };
    }
    if (target.segmentId) return { type: "update_h3_segment", nodeId: target.nodeId, segmentId: target.segmentId, patch: { prompt: text } };
    return { type: "update_node", id: target.nodeId, metadata: { [target.field]: text } };
}

export function editedTextTargets(operation: CanvasOperation, project: Record<string, unknown>): CanvasTextTarget[] {
    if (operation.type === "update_project" && Object.hasOwn(operation.patch as object || {}, "globalPrompt")) return [{ field: "globalPrompt" }];
    if (operation.type === "update_h3_segment" && (Object.hasOwn(operation.patch as object || {}, "prompt") || (operation.patchDelete as string[] || []).includes("prompt"))) return [{ nodeId: String(operation.nodeId), segmentId: String(operation.segmentId), field: "prompt" }];
    if (operation.type === "replace_h3_segments") return (operation.segments as Array<{ id: string }> || []).map((segment) => ({ nodeId: String(operation.nodeId), segmentId: segment.id, field: "prompt" }));
    if (operation.type === "add_h3_segment") return [{ nodeId: String(operation.nodeId), segmentId: String((operation.segment as { id: string }).id), field: "prompt" }];
    if (operation.type !== "update_node") return [];
    const node = (project.nodes as Array<Record<string, unknown>> || []).find((node) => node.id === operation.id);
    const keys = new Set([...Object.keys(operation.metadata as object || {}), ...(operation.metadataDelete as string[] || [])]);
    const targets: CanvasTextTarget[] = (["prompt", "composerContent", ...(node?.type === "text" ? ["content"] : [])] as CanvasTextTarget["field"][]).filter((field) => keys.has(field)).map((field) => ({ nodeId: String(operation.id), field }));
    if (keys.has("segments")) {
        const segments = (node?.metadata as { segments?: Array<{ id: string }> } | undefined)?.segments || [];
        targets.push(...segments.map((segment): CanvasTextTarget => ({ nodeId: String(operation.id), segmentId: segment.id, field: "prompt" })));
    }
    if (node?.type === "text" && keys.has("texts")) {
        const texts = (node.metadata as { texts?: Array<{ id: string }> })?.texts || [];
        targets.push(...texts.map((item): CanvasTextTarget => ({ nodeId: String(operation.id), textItemId: item.id, field: "content" })));
    }
    return targets;
}

export function loadTextDocument(state: Uint8Array | undefined, text: string) {
    const doc = new Y.Doc();
    if (state) Y.applyUpdate(doc, state);
    else if (text) doc.getText("text").insert(0, text);
    return doc;
}

export function replaceText(doc: Y.Doc, next: string) {
    const text = doc.getText("text");
    const current = text.toString();
    let start = 0;
    while (start < current.length && start < next.length && current[start] === next[start]) start++;
    let end = 0;
    while (end < current.length - start && end < next.length - start && current[current.length - 1 - end] === next[next.length - 1 - end]) end++;
    doc.transact(() => {
        text.delete(start, current.length - start - end);
        text.insert(start, next.slice(start, next.length - end));
    });
}
