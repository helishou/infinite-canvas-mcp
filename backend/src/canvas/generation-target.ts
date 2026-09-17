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
    if (!command.projectId || !command.nodeId || !["image", "video", "audio"].includes(command.mode)) {
        return { command, project: null, createOperations: [] };
    }
    const project = stores.projects.get(command.projectId);
    const source = project && records(project.nodes).find((node) => String(node.id || "") === command.nodeId);
    if (!project || !source) throw new Error(`画布${modeLabel(command.mode)}生成目标不存在，未启动模型`);

    if (command.mode === "image") return prepareImage(project, source, command, taskId);
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

function prepareImage(project: CanvasProject, source: Record<string, any>, command: CanvasGenerationCommand, taskId: string): PreparedCanvasGenerationTarget {
    const metadata = record(source.metadata);
    const writeBackToTarget = record(command.params).writeBackToTarget === true;
    if (command.imageIds?.length) {
        const slots = Array.isArray(metadata.images) ? metadata.images : [];
        if (source.type !== "image" || command.imageIds.length !== countOf(command)
            || new Set(command.imageIds).size !== command.imageIds.length
            || command.imageIds.some((id) => !slots.some((slot: Record<string, unknown>) => String(slot.id || "") === id))) {
            throw new Error("图片结果槽与生成数量或目标节点不匹配，未启动模型");
        }
    }
    const useExisting = writeBackToTarget || (source.type === "image" && (Boolean(command.imageIds?.length) || !metadata.content));
    const count = countOf(command);
    if (useExisting) {
        const imageIds = command.imageIds?.length ? command.imageIds : Array.from({ length: count }, () => `image-slot-${crypto.randomUUID()}`);
        const createOperations: CanvasOperation[] = command.imageIds?.length || writeBackToTarget ? [] : [{
            type: "update_node",
            id: String(source.id),
            metadata: {
                prompt: String(command.prompt || ""),
                model: command.model,
                count,
                images: imageIds.map((id) => ({ id, status: "idle", content: "", naturalWidth: 0, naturalHeight: 0, bytes: 0, mimeType: "" })),
            },
        }];
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
function findResultPosition(project: CanvasProject, source: Record<string, any>, size: { width: number; height: number }) {
    const gap = 96;
    const sourcePosition = record(source.position);
    const x = Number(sourcePosition.x || 0) + Number(source.width || size.width) + gap;
    const startY = Number(sourcePosition.y || 0);
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
function countOf(command: CanvasGenerationCommand) { return Math.max(1, Math.min(4, Math.floor(Number(command.count || 1)))); }
function modeLabel(mode: CanvasGenerationCommand["mode"]) { return mode === "image" ? "图片" : mode === "video" ? "视频" : mode === "audio" ? "音频" : "文本"; }
function records(value: unknown): Array<Record<string, any>> { return Array.isArray(value) ? value.filter((item) => item && typeof item === "object" && !Array.isArray(item)) : []; }
function record(value: unknown): Record<string, any> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {}; }
