import crypto from "node:crypto";

import type { CanvasGenerationCommand } from "@basketikun/canvas-agent/generation-contract";
import type { CanvasProject } from "../db.js";
import type { Stores } from "../stores/types.js";
import type { CanvasOperation } from "./project-ops.js";

export type PreparedCanvasGenerationTarget = {
    command: CanvasGenerationCommand;
    project: CanvasProject | null;
    createOperations: CanvasOperation[];
    targetSize?: { width: number; height: number };
};

/**
 * Media result-node creation belongs to Backend so browser, MCP and Agent runs
 * get the same IDs, placement and initial state.
 */
export function prepareCanvasGenerationTarget(
    stores: Stores,
    command: CanvasGenerationCommand,
    taskId: string,
): PreparedCanvasGenerationTarget {
    if (command.loopOutput && (!["image", "video"].includes(command.mode) || !command.projectId || !command.nodeId)) {
        throw new Error("循环输出槽需要画布图片或视频生成节点");
    }
    if (!command.projectId || !command.nodeId || !["image", "video", "audio", "text"].includes(command.mode)) {
        return { command, project: null, createOperations: [] };
    }
    const project = stores.projects.get(command.projectId);
    const source = project && records(project.nodes).find((node) => String(node.id || "") === command.nodeId);
    if (!project || !source) throw new Error(`画布${modeLabel(command.mode)}生成目标不存在，未启动模型`);

    if (command.mode === "image") return prepareImage(stores, project, source, command, taskId);
    if (command.mode === "video" && command.loopOutput) return prepareLoopVideoOutput(stores, project, source, command, taskId);
    if (source.type === "config" && record(source.metadata).smart === true) return prepareSmartMedia(project, source, command);
    if (source.type === command.mode) {
        return {
            command,
            project,
            createOperations: [],
            targetSize: { width: Number(source.width || defaultSize(command.mode).width), height: Number(source.height || defaultSize(command.mode).height) },
        };
    }
    const size = defaultSize(command.mode);
    const outputId = `${command.mode}-${taskId}`;
    return {
        command: { ...command, nodeId: outputId, sourceNodeId: command.sourceNodeId || command.nodeId },
        project,
        createOperations: createResultOperations(project, source, command, taskId, outputId, size),
        targetSize: size,
    };
}

function prepareSmartMedia(project: CanvasProject, source: Record<string, any>, command: CanvasGenerationCommand): PreparedCanvasGenerationTarget {
    const metadata = record(source.metadata);
    const imageSlotIds = new Set(records(metadata.images).map((image) => String(image.id || "")));
    const legacyResultIds = [...new Set([
        ...(Array.isArray(metadata.generatedResultIds) ? metadata.generatedResultIds.map(String) : []),
        ...(metadata.primaryImageId && !imageSlotIds.has(String(metadata.primaryImageId)) ? [String(metadata.primaryImageId)] : []),
        ...(Array.isArray(metadata.generatedTextResultIds) ? metadata.generatedTextResultIds.map(String) : []),
        ...(metadata.primaryTextNodeId ? [String(metadata.primaryTextNodeId)] : []),
    ].filter((id) => id && id !== String(source.id)))];
    return {
        command,
        project,
        createOperations: [
            ...legacyResultIds.map((id) => ({ type: "delete_node", id })),
            {
                type: "update_node",
                id: String(source.id),
                metadata: { prompt: String(command.prompt || ""), model: command.model, generationMode: command.mode, activeImageHistoryExplicit: false },
                metadataDelete: ["content", "storageKey", "mimeType", "bytes", "naturalWidth", "naturalHeight", "durationMs", "errorDetails", "runProgress"],
            },
        ],
        targetSize: { width: Number(source.width || defaultSize(command.mode).width), height: Number(source.height || defaultSize(command.mode).height) },
    };
}

function prepareImage(stores: Stores, project: CanvasProject, source: Record<string, any>, command: CanvasGenerationCommand, taskId: string): PreparedCanvasGenerationTarget {
    const metadata = record(source.metadata);
    if (command.loopOutput) return prepareLoopImageOutput(stores, project, source, command, taskId);
    const writeBackToTarget = record(command.params).writeBackToTarget === true;
    const useSmartNode = source.type === "config" && metadata.smart === true;
    if (command.imageIds?.length) {
        const slots = Array.isArray(metadata.images) ? metadata.images : [];
        if ((!useSmartNode && source.type !== "image") || command.imageIds.length !== countOf(command)
            || new Set(command.imageIds).size !== command.imageIds.length
            || command.imageIds.some((id) => !slots.some((slot: Record<string, unknown>) => String(slot.id || "") === id))) {
            throw new Error("图片结果槽与生成数量或目标节点不匹配，未启动模型");
        }
    }
    // 智能生成节点沿用 Config 类型保存提示词与参数，但生成结果直接回写同一节点，
    // 这样网页、MCP 和 Agent 都能共享同一套结果槽与任务绑定语义。旧 Config 节点
    // 没有 smart 标记，继续保留“配置节点 -> 新图片结果节点”的兼容行为。
    const useExisting = writeBackToTarget || useSmartNode || (source.type === "image" && (Boolean(command.imageIds?.length) || !metadata.content));
    const count = countOf(command);
    if (useExisting) {
        const imageIds = command.imageIds?.length ? command.imageIds : Array.from({ length: count }, () => `image-slot-${crypto.randomUUID()}`);
        const imageSlotIds = new Set(records(metadata.images).map((image) => String(image.id || "")));
        const legacyResultIds = useSmartNode
            ? [...new Set([
                ...(Array.isArray(metadata.generatedResultIds) ? metadata.generatedResultIds.map(String) : []),
                ...(metadata.primaryImageId && !imageSlotIds.has(String(metadata.primaryImageId)) ? [String(metadata.primaryImageId)] : []),
                ...(Array.isArray(metadata.generatedTextResultIds) ? metadata.generatedTextResultIds.map(String) : []),
                ...(metadata.primaryTextNodeId ? [String(metadata.primaryTextNodeId)] : []),
            ].filter((id) => id && id !== String(source.id)))]
            : [];
        const historySnapshot = useSmartNode ? imageGenerationSnapshot(metadata, command, count) : undefined;
        const newImages = imageIds.map((id) => ({
            id,
            status: "idle",
            content: "",
            naturalWidth: 0,
            naturalHeight: 0,
            bytes: 0,
            mimeType: "",
            ...(historySnapshot ? { generationSnapshot: historySnapshot } : {}),
        }));
        const createOperations: CanvasOperation[] = [
            ...legacyResultIds.map((id) => ({ type: "delete_node", id })),
            ...(command.imageIds?.length || writeBackToTarget ? [] : [{
                type: "update_node",
                id: String(source.id),
                metadata: {
                    prompt: String(command.prompt || ""),
                    model: command.model,
                    generationMode: "image",
                    count,
                    generationType: command.references?.length ? "edit" : "generation",
                    images: [...(useSmartNode ? records(metadata.images) : []), ...newImages],
                    ...(useSmartNode ? { primaryImageId: imageIds[0], activeImageHistoryId: imageIds[0], activeImageHistoryExplicit: false } : {}),
                },
                    ...(useSmartNode ? { metadataDelete: ["generatedResultIds", "generatedTextResultIds", "primaryTextNodeId"] } : {}),
            }]),
        ];
        return {
            command: writeBackToTarget ? command : { ...command, imageIds },
            project,
            createOperations,
            targetSize: { width: Number(source.width || 340), height: Number(source.height || 240) },
        };
    }
    const outputId = `image-${taskId}`;
    const imageIds = Array.from({ length: count }, () => `image-slot-${crypto.randomUUID()}`);
    const size = { width: 340, height: 240 };
    const operations = createResultOperations(project, source, command, taskId, outputId, size);
    const add = operations[0] as Record<string, any>;
    add.metadata = {
        ...(add.metadata || {}),
        count,
        generationType: command.references?.length ? "edit" : "generation",
        images: imageIds.map((id) => ({ id, status: "idle", content: "", naturalWidth: 0, naturalHeight: 0, bytes: 0, mimeType: "" })),
    };
    return {
        command: { ...command, nodeId: outputId, sourceNodeId: command.sourceNodeId || command.nodeId, imageIds },
        project,
        createOperations: operations,
        targetSize: size,
    };
}

function prepareLoopImageOutput(stores: Stores, project: CanvasProject, source: Record<string, any>, command: CanvasGenerationCommand, taskId: string): PreparedCanvasGenerationTarget {
    if (Number(command.count || 1) !== 1 || command.imageIds?.length) throw new Error("循环每轮只能生成一个独立图片结果");
    if (source.type !== "image" && !(source.type === "config" && record(source.metadata).smart === true && (record(source.metadata).generationMode || "image") === "image")) {
        throw new Error("循环输出槽只支持图片生成节点");
    }
    const { loop, existing } = resolveLoopOutputSlot(stores, project, source, command, "image");
    const outputId = String(existing?.id || `loop-image-${taskId}`);
    const imageId = `image-slot-${crypto.randomUUID()}`;
    const image = { id: imageId, status: "loading", content: "", naturalWidth: 0, naturalHeight: 0, bytes: 0, mimeType: "", generationSnapshot: imageGenerationSnapshot(record(source.metadata), command, 1) };
    const tags = { loopOutputSlot: true, loopSourceId: loop.loopNodeId, loopRootId: String(source.id), loopRoundIndex: loop.roundIndex, loopSlotIndex: loop.slotIndex };
    const metadata = { ...tags, images: [...records(record(existing?.metadata).images), image], primaryImageId: imageId, activeImageHistoryId: imageId, activeImageHistoryExplicit: false };
    const size = existing ? { width: Number(existing.width || 340), height: Number(existing.height || 240) } : { width: 340, height: 240 };
    const createOperations: CanvasOperation[] = existing
        ? [{ type: "update_node", id: outputId, metadata, metadataDelete: ["content", "url", "storageKey", "mimeType", "bytes", "naturalWidth", "naturalHeight"] }]
        : createResultOperations(project, source, command, taskId, outputId, size);
    if (!existing) {
        const add = createOperations[0] as Record<string, any>;
        const sourceY = Number(record(source.position).y || 0);
        add.position = findResultPosition(project, source, size, sourceY + loop.slotIndex * (size.height + 28));
        add.title = `Image ${loop.roundIndex}`;
        add.metadata = { ...record(add.metadata), ...metadata };
    }
    return { command: { ...command, nodeId: outputId, sourceNodeId: String(source.id), imageIds: [imageId] }, project, createOperations, targetSize: size };
}

function prepareLoopVideoOutput(stores: Stores, project: CanvasProject, source: Record<string, any>, command: CanvasGenerationCommand, taskId: string): PreparedCanvasGenerationTarget {
    if (source.type !== "video" && !(source.type === "config" && record(source.metadata).smart === true && record(source.metadata).generationMode === "video")) {
        throw new Error("循环视频输出槽只支持视频生成节点");
    }
    const { loop, existing } = resolveLoopOutputSlot(stores, project, source, command, "video");
    const outputId = String(existing?.id || `loop-video-${taskId}`);
    const previous = record(existing?.metadata);
    const history = [...records(previous.loopOutputHistory)];
    if (previous.content || previous.storageKey) history.push({ content: previous.content, storageKey: previous.storageKey, mimeType: previous.mimeType, bytes: previous.bytes, naturalWidth: previous.naturalWidth, naturalHeight: previous.naturalHeight, durationMs: previous.durationMs, generationTaskId: previous.generationTaskId });
    const tags = { loopOutputSlot: true, loopSourceId: loop.loopNodeId, loopRootId: String(source.id), loopRoundIndex: loop.roundIndex, loopSlotIndex: loop.slotIndex };
    const size = existing ? { width: Number(existing.width || 340), height: Number(existing.height || 190) } : { width: 340, height: 190 };
    const metadataDelete = ["content", "url", "storageKey", "mimeType", "bytes", "naturalWidth", "naturalHeight", "durationMs"];
    const createOperations: CanvasOperation[] = existing
        ? [{ type: "update_node", id: outputId, metadata: { ...tags, loopOutputHistory: history }, metadataDelete }]
        : createResultOperations(project, source, command, taskId, outputId, size);
    if (!existing) {
        const add = createOperations[0] as Record<string, any>;
        const sourceY = Number(record(source.position).y || 0);
        add.position = findResultPosition(project, source, size, sourceY + loop.slotIndex * (size.height + 28));
        add.title = `Video ${loop.roundIndex}`;
        add.metadata = { ...record(add.metadata), ...tags };
    }
    return { command: { ...command, nodeId: outputId, sourceNodeId: String(source.id) }, project, createOperations, targetSize: size };
}

function resolveLoopOutputSlot(stores: Stores, project: CanvasProject, source: Record<string, any>, command: CanvasGenerationCommand, mode: "image" | "video") {
    const loop = command.loopOutput!;
    const nodes = records(project.nodes);
    const loopNode = nodes.find((node) => String(node.id || "") === loop.loopNodeId && node.type === "loop");
    if (!loopNode || !isDownstreamOf(project, loop.loopNodeId, String(source.id))) throw new Error("循环节点未连接到本次生成节点");
    const candidates = nodes.filter((node) => {
        const value = record(node.metadata);
        return node.type === mode && value.loopOutputSlot === true
            && value.loopSourceId === loop.loopNodeId && value.loopRootId === source.id;
    });
    const existing = candidates.find((node) => Number(record(node.metadata).loopRoundIndex) === loop.roundIndex)
        || candidates.find((node) => Number(record(node.metadata).loopSlotIndex) === loop.slotIndex);
    const activeTaskId = String(record(existing?.metadata).runtimeTaskId || "");
    if (activeTaskId && ["queued", "running"].includes(String(stores.tasks.get(activeTaskId)?.status || ""))) throw new Error("该循环轮次的输出槽正在生成");
    return { loop, existing };
}

function isDownstreamOf(project: CanvasProject, fromId: string, targetId: string) {
    const connections = records(project.connections);
    const seen = new Set([fromId]);
    const pending = [fromId];
    while (pending.length) {
        const current = pending.pop()!;
        for (const connection of connections) {
            if (String(connection.fromNodeId || "") !== current) continue;
            const next = String(connection.toNodeId || "");
            if (next === targetId) return true;
            if (next && !seen.has(next)) { seen.add(next); pending.push(next); }
        }
    }
    return false;
}

function createResultOperations(
    project: CanvasProject,
    source: Record<string, any>,
    command: CanvasGenerationCommand,
    taskId: string,
    outputId: string,
    size: { width: number; height: number },
): CanvasOperation[] {
    const position = findResultPosition(project, source, size);
    return [
        {
            type: "add_node",
            id: outputId,
            nodeType: command.mode,
            title: String(command.prompt || `${modeLabel(command.mode)}生成`).slice(0, 32),
            position,
            width: size.width,
            height: size.height,
            metadata: { prompt: command.prompt, model: command.model, status: "idle", generationEngine: "backend" },
        },
        { type: "connect_nodes", id: `connection-${taskId}`, fromNodeId: String(source.id), toNodeId: outputId },
    ];
}

/** Keep the flow expanding to the right while avoiding an occupied result slot. */
function findResultPosition(project: CanvasProject, source: Record<string, any>, size: { width: number; height: number }, preferredY?: number) {
    const gap = 96;
    const sourcePosition = record(source.position);
    const x = Number(sourcePosition.x || 0) + Number(source.width || size.width) + gap;
    const startY = preferredY ?? Number(sourcePosition.y || 0);
    const nodes = records(project.nodes);
    const rows = [startY];
    for (let ring = 1; ring <= 60; ring++) {
        rows.push(startY + ring * (size.height + gap), startY - ring * (size.height + gap));
    }
    for (const y of rows) {
        const blocked = nodes.some((node) => {
            if (String(node.id || "") === String(source.id || "")) return false;
            const nodePosition = record(node.position);
            const nx = Number(nodePosition.x || 0);
            const ny = Number(nodePosition.y || 0);
            return x < nx + Number(node.width || 0) + gap / 3
                && x + size.width + gap / 3 > nx
                && y < ny + Number(node.height || 0) + gap / 3
                && y + size.height + gap / 3 > ny;
        });
        if (!blocked) return { x, y };
    }
    return { x, y: startY };
}

function defaultSize(mode: CanvasGenerationCommand["mode"]) {
    return mode === "audio" ? { width: 320, height: 140 } : { width: 340, height: 190 };
}

function imageGenerationSnapshot(metadata: Record<string, any>, command: CanvasGenerationCommand, count: number) {
    const history = record((command as unknown as Record<string, unknown>).historySnapshot);
    const references = records(command.references).flatMap((reference, index) => {
        const storageKey = String(reference.storageKey || "");
        const rawUrl = String(reference.url || reference.dataUrl || "");
        const url = rawUrl && !/^(data:|blob:)/i.test(rawUrl) ? rawUrl : "";
        if (!storageKey && !url) return [];
        return [{
            id: String(reference.id || `reference-${index + 1}`),
            name: String(reference.name || `参考图 ${index + 1}`),
            type: String(reference.type || reference.mimeType || "image/png"),
            ...(url ? { url } : {}),
            ...(storageKey ? { storageKey } : {}),
        }];
    });
    const background = history.background ?? metadata.background;
    const params = record(command.params);
    return {
        createdAt: new Date().toISOString(),
        prompt: String(history.prompt ?? metadata.composerContent ?? metadata.prompt ?? command.prompt ?? ""),
        effectivePrompt: String(command.prompt || ""),
        model: String(command.model || ""),
        ...(history.size || command.size ? { size: String(history.size || command.size) } : {}),
        ...(command.quality ? { quality: String(command.quality) } : {}),
        ...(typeof background === "string" ? { background } : {}),
        count,
        ...(Object.keys(params).length ? { params: structuredClone(params) } : {}),
        references,
        ...(command.maskEdit || history.maskEdit ? { maskEdit: true } : {}),
    };
}

function countOf(command: CanvasGenerationCommand) { return Math.max(1, Math.min(4, Math.floor(Number(command.count || 1)))); }
function modeLabel(mode: CanvasGenerationCommand["mode"]) { return mode === "image" ? "图片" : mode === "video" ? "视频" : mode === "audio" ? "音频" : "文本"; }
function records(value: unknown): Array<Record<string, any>> { return Array.isArray(value) ? value.filter((item) => item && typeof item === "object" && !Array.isArray(item)) : []; }
function record(value: unknown): Record<string, any> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {}; }
