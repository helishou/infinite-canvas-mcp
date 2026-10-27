import crypto from "node:crypto";

import type { ToolName } from "./schemas.js";
import { canvasNodeDefaultSize } from "./node-sizes.js";
import { nextCanvasFlowAnchor, nextCanvasX } from "./tools.js";
import type { CanvasNode, CanvasNodeType, CanvasSnapshot } from "./types.js";

export type CanvasToolRequest = { name: "canvas_apply_ops"; input: Record<string, unknown> };

/** 移除 Agent/MCP 引用选择器误写进 prompt 的占位行，保留其后的真实提示词。 */
export function sanitizeCanvasPrompt(value: string) {
    const lines = String(value || "").replace(/\r\n?/g, "\n").split("\n");
    let index = 0;
    while (index < lines.length && (!lines[index].trim() || /^【文本\d+】$/.test(lines[index].trim()) || /^图片\d+$/.test(lines[index].trim()))) index += 1;
    return lines.slice(index).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** 将上层画布工具调用转换为前端可执行的批量操作。 */
export function buildCanvasToolRequest(name: ToolName, input: Record<string, unknown>, state: CanvasSnapshot | null): CanvasToolRequest {
    if (name === "canvas_apply_ops") return { name, input: normalizeCanvasApplyOps(input) };
    if (name === "canvas_create_node") {
        const data = input as { nodeType: CanvasNodeType; title?: string; x?: number; y?: number; width?: number; height?: number; metadata?: Record<string, unknown> };
        // 显式尺寸优先；省略时按该类型的默认规格落地，不再让 Backend 兜底成 320×240。
        const size = canvasNodeDefaultSize(data.nodeType);
        return applyOps([{ type: "add_node", nodeType: data.nodeType, title: data.title, position: { x: data.x ?? nextCanvasX(state), y: data.y ?? 0 }, width: data.width ?? size.width, height: data.height ?? size.height, metadata: data.metadata }]);
    }
    if (name === "canvas_create_config_node") {
        const x = Number(input.x ?? nextCanvasX(state));
        const y = Number(input.y ?? 0);
        const configId = String(input.id || `config-${crypto.randomUUID()}`);
        const mode = generationMode(input.mode);
        const prompt = String(input.prompt || "");
        return applyOps([configNodeOp(configId, input, x, y), ...(input.autoRun ? [runGenerationOp({
            nodeId: configId,
            mode,
            prompt,
            params: input.params as Record<string, unknown> | undefined,
            idempotencyKey: typeof input.idempotencyKey === "string" ? input.idempotencyKey : undefined,
            resultPolicy: input.resultPolicy as "replace-active" | "append" | undefined,
        })] : [])]);
    }
    if (name === "canvas_create_generation_flow") return applyOps(generationFlowOps(input, state));
    if (name === "canvas_generate_text" || name === "canvas_generate_image" || name === "canvas_generate_video" || name === "canvas_generate_audio") {
        return applyOps(generationFlowOps({ ...input, mode: name.replace("canvas_generate_", ""), autoRun: true }, state));
    }
    if (name === "canvas_set_generation_references") {
        const data = input as { nodeId: string; referenceNodeIds: string[] };
        const targetNodeId = String(data.nodeId || "");
        const referenceNodeIds = [...new Set(data.referenceNodeIds || [])];
        if (!state) throw new Error("替换生成参考图前必须先读取当前画布");
        const nodeById = new Map((state.nodes || []).map((node) => [node.id, node]));
        if (!nodeById.has(targetNodeId)) throw new Error(`找不到生成节点：${targetNodeId}`);
        const oldReferenceConnectionIds = (state.connections || [])
            .filter((connection) => connection.toNodeId === targetNodeId)
            .filter((connection) => nodeById.get(connection.fromNodeId)?.type !== "text")
            .map((connection) => connection.id);
        return applyOps([
            ...(oldReferenceConnectionIds.length ? [{ type: "delete_connections", ids: oldReferenceConnectionIds }] : []),
            ...referenceNodeIds.map((fromNodeId, order) => ({ type: "connect_nodes", fromNodeId, toNodeId: targetNodeId, role: "reference", order })),
        ]);
    }
    if (name === "canvas_update_node") {
        const data = input as { id: string; patch?: Record<string, unknown>; metadata?: Record<string, unknown> };
        return applyOps([{ type: "update_node", id: data.id, patch: data.patch, metadata: data.metadata }]);
    }
    if (name === "canvas_move_nodes") {
        const data = input as { items: Array<{ id: string; x?: number; y?: number; dx?: number; dy?: number }> };
        return applyOps(data.items.map((item) => {
            const current = findNode(state, item.id);
            return { type: "update_node", id: item.id, patch: { position: { x: item.x ?? ((current?.position.x || 0) + (item.dx || 0)), y: item.y ?? ((current?.position.y || 0) + (item.dy || 0)) } } };
        }));
    }
    if (name === "canvas_resize_node") {
        const data = input as { id: string; width: number; height: number; freeResize?: boolean };
        return applyOps([{ type: "update_node", id: data.id, patch: { width: data.width, height: data.height }, metadata: data.freeResize === undefined ? undefined : { freeResize: data.freeResize } }]);
    }
    if (name === "canvas_delete_nodes") return applyOps([{ type: "delete_node", ids: (input as { ids: string[] }).ids }]);
    if (name === "canvas_connect_nodes") {
        const data = input as { connections: Array<{ fromNodeId: string; toNodeId: string; role?: string; order?: number }> };
        return applyOps(data.connections.map((connection) => ({ type: "connect_nodes", ...connection })));
    }
    if (name === "canvas_select_nodes") return applyOps([{ type: "select_nodes", ids: (input as { ids: string[] }).ids }]);
    if (name === "canvas_run_generation") {
        const data = input as { nodeId: string; mode?: "text" | "image" | "video" | "audio"; prompt?: string; referenceNodeIds?: string[]; characterImageKeys?: Record<string, string[]>; params?: Record<string, unknown>; idempotencyKey?: string; resultPolicy?: "replace-active" | "append"; segmentId?: string };
        const referenceNodeIds = [...new Set(data.referenceNodeIds || [])];
        const prompt = String(data.prompt || "").trim();
        const promptOp = prompt ? [{ type: "update_node", id: data.nodeId, metadata: { composerContent: prompt, prompt } }] : [];
        const selections = data.characterImageKeys || {};
        const current = findNode(state, data.nodeId);
        const previous = current?.metadata?.characterReferences && typeof current.metadata.characterReferences === "object" ? current.metadata.characterReferences as Record<string, Record<string, unknown>> : {};
        const characterOps = Object.keys(selections).length ? [{ type: "update_node", id: data.nodeId, metadata: { characterReferences: Object.fromEntries([
            ...Object.entries(previous),
            ...Object.entries(selections).map(([id, imageKeys]) => [id, { ...(previous[id] || {}), imageKeys }]),
        ]) } }] : [];
        if (!referenceNodeIds.length) return applyOps([
            ...characterOps,
            ...promptOp,
            runGenerationOp({ ...data, mode: generationMode(data.mode) }),
        ]);
        if (!state) throw new Error("替换生成参考图前必须先读取当前画布");
        const nodeById = new Map((state.nodes || []).map((node) => [node.id, node]));
        if (!nodeById.has(data.nodeId)) throw new Error(`找不到生成节点：${data.nodeId}`);
        const oldReferenceConnectionIds = (state.connections || [])
            .filter((connection) => connection.toNodeId === data.nodeId)
            .filter((connection) => nodeById.get(connection.fromNodeId)?.type !== "text")
            .map((connection) => connection.id);
        return applyOps([
            ...(oldReferenceConnectionIds.length ? [{ type: "delete_connections", ids: oldReferenceConnectionIds }] : []),
            ...referenceNodeIds.map((fromNodeId, order) => ({ type: "connect_nodes", fromNodeId, toNodeId: data.nodeId, role: "reference", order })),
            ...characterOps,
            ...promptOp,
            runGenerationOp({ ...data, mode: generationMode(data.mode), referenceNodeIds: undefined }),
        ]);
    }
    throw new Error(`未知工具：${name}`);
}

/** 按最大边限制计算附件图片节点尺寸，并保持原始比例。 */
export function fitAttachmentNodeSize(width: number, height: number) {
    const scale = Math.min(1, 640 / width, 640 / height);
    return { width: width * scale, height: height * scale };
}

/** 创建统一的批量画布操作请求。 */
function applyOps(ops: unknown[]): CanvasToolRequest {
    return { name: "canvas_apply_ops", input: { ops } };
}

/** 直接提交 ops 时也要把显式提示词写回智能节点，避免绕过专用生成工具。 */
function normalizeCanvasApplyOps(input: Record<string, unknown>) {
    if (!Array.isArray(input.ops)) return input;
    const ops: Array<Record<string, unknown>> = [];
    for (const value of input.ops) {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
            ops.push(value as Record<string, unknown>);
            continue;
        }
        const op = value as Record<string, unknown>;
        if (op.type === "run_generation") {
            const nodeId = String(op.nodeId || "");
            const prompt = String(op.prompt || "").trim();
            if (nodeId && prompt && !ops.some((previous) => previous.type === "update_node" && previous.id === nodeId && String((previous.metadata as Record<string, unknown> | undefined)?.prompt || "").trim() === prompt)) {
                ops.push({ type: "update_node", id: nodeId, metadata: { composerContent: prompt, prompt } });
            }
        }
        ops.push(op);
    }
    return { ...input, ops };
}

/** 创建生成配置节点操作。 */
function configNodeOp(id: string, input: Record<string, unknown>, x: number, y: number) {
    const mode = generationMode(input.mode);
    const prompt = String(input.prompt || "");
    const size = canvasNodeDefaultSize("config");
    return {
        type: "add_node",
        id,
        nodeType: "config",
        title: String(input.title || generationTitle(mode)),
        position: { x, y },
        width: typeof input.width === "number" ? input.width : size.width,
        height: typeof input.height === "number" ? input.height : size.height,
        metadata: cleanRecord({
            smart: true,
            generationMode: mode,
            composerContent: prompt,
            prompt,
            status: "idle",
            model: input.model,
            size: input.size,
            quality: input.quality,
            count: input.count,
            seconds: input.seconds,
            vquality: input.vquality,
            generateAudio: input.generateAudio,
            watermark: input.watermark,
            audioVoice: input.audioVoice,
            audioFormat: input.audioFormat,
            audioSpeed: input.audioSpeed,
            audioInstructions: input.audioInstructions,
            params: input.params,
        }),
    };
}

/** 创建包含提示词、配置节点和引用连线的生成流程。 */
function generationFlowOps(input: Record<string, unknown>, state: CanvasSnapshot | null) {
    const mode = generationMode(input.mode);
    const prompt = sanitizeCanvasPrompt(String(input.prompt || ""));
    const referenceNodeIds = Array.isArray(input.referenceNodeIds) ? input.referenceNodeIds.filter((id): id is string => typeof id === "string") : [];
    const configId = `config-${crypto.randomUUID()}`;
    // 提示词与生成参数统一保存在智能节点中，不再另造普通文本节点。
    const anchor = nextCanvasFlowAnchor(state, referenceNodeIds[0], { includePrompt: false });
    const x = Number(input.x ?? anchor.x);
    const y = Number(input.y ?? anchor.y);
    const configPrompt = prompt;
    return [
        configNodeOp(configId, { ...input, prompt: configPrompt }, x, y),
        ...referenceNodeIds.map((fromNodeId, order) => ({ type: "connect_nodes", fromNodeId, toNodeId: configId, role: "reference", order })),
        { type: "select_nodes", ids: [configId] },
        ...(input.autoRun ? [runGenerationOp({
            nodeId: configId,
            mode,
            prompt: configPrompt,
            params: input.params as Record<string, unknown> | undefined,
            idempotencyKey: typeof input.idempotencyKey === "string" ? input.idempotencyKey : undefined,
            resultPolicy: input.resultPolicy as "replace-active" | "append" | undefined,
        })] : []),
    ];
}

/** 创建触发节点生成的画布操作。 */
function runGenerationOp(input: { nodeId: string; mode?: "text" | "image" | "video" | "audio"; prompt?: string; referenceNodeIds?: string[]; params?: Record<string, unknown>; idempotencyKey?: string; resultPolicy?: "replace-active" | "append"; segmentId?: string }) {
    return { type: "run_generation", nodeId: input.nodeId, ...(input.mode ? { mode: input.mode } : {}), prompt: input.prompt, ...cleanRecord({ params: input.params, idempotencyKey: input.idempotencyKey, resultPolicy: input.resultPolicy, segmentId: input.segmentId }) };
}

/** 将未知生成模式归一为画布支持的模式。 */
function generationMode(value: unknown): "text" | "image" | "video" | "audio" {
    return value === "text" || value === "video" || value === "audio" ? value : "image";
}

/** 获取生成模式对应的默认节点标题。 */
function generationTitle(mode: "text" | "image" | "video" | "audio") {
    if (mode === "text") return "文本生成";
    if (mode === "video") return "视频生成";
    if (mode === "audio") return "音频生成";
    return "图片生成";
}

/** 按节点 ID 查找当前画布节点。 */
function findNode(state: CanvasSnapshot | null, id: string): CanvasNode | undefined {
    return (state?.nodes || []).find((node) => node.id === id);
}

/** 移除对象中未设置的生成参数。 */
function cleanRecord(value: Record<string, unknown>) {
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== ""));
}
