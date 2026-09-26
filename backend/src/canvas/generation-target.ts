import crypto from "node:crypto";

import type { CanvasGenerationCommand, CanvasLoopPrepare } from "@basketikun/canvas-agent/generation-contract";
import type { CanvasProject } from "../db.js";
import type { Stores } from "../stores/types.js";
import type { CanvasOperation } from "./project-ops.js";

export type PreparedCanvasGenerationTarget = {
    command: CanvasGenerationCommand;
    project: CanvasProject | null;
    createOperations: CanvasOperation[];
    targetSize?: { width: number; height: number };
};

export type PreparedCanvasLoopRun = { runId: string; outputGroupId: string; slotNodeIds: string[]; totalRounds: number };

/** Create or extend the one ordered output group used by every round of a loop run. */
export function prepareCanvasLoopRun(stores: Stores, input: CanvasLoopPrepare): PreparedCanvasLoopRun {
    const project = stores.projects.get(input.projectId);
    if (!project) throw new Error(`画布不存在：${input.projectId}`);
    const nodes = records(project.nodes);
    const loop = nodes.find((node) => String(node.id || "") === input.loopNodeId && node.type === "loop");
    if (!loop) throw new Error("循环节点不存在");
    const projectConnections = records(project.connections);
    if (input.roundInputNodeIds.length !== input.totalRounds) throw new Error("逐轮输入槽数量与循环轮数不一致");
    const inputGroups = new Set(projectConnections.filter((connection) => String(connection.toNodeId || "") === input.loopNodeId)
        .map((connection) => String(connection.fromNodeId || ""))
        .filter((id) => nodes.some((node) => String(node.id || "") === id && node.type === "group")));
    const allowedInputs = new Set(projectConnections.filter((connection) => String(connection.toNodeId || "") === input.loopNodeId)
        .map((connection) => String(connection.fromNodeId || "")));
    for (const groupId of inputGroups) {
        const group = nodes.find((node) => String(node.id || "") === groupId)!;
        const groupSlots = record(group.metadata).groupSlots;
        for (const id of Array.isArray(groupSlots) ? groupSlots.map(String) : []) allowedInputs.add(id);
        for (const child of nodes.filter((node) => String(record(node.metadata).groupId || "") === groupId)) allowedInputs.add(String(child.id || ""));
    }
    for (const ids of input.roundInputNodeIds) {
        if (new Set(ids).size !== ids.length) throw new Error("同一轮输入槽重复");
        for (const id of ids) {
            const source = nodes.find((node) => String(node.id || "") === id);
            if (!source || !allowedInputs.has(id) || source.type === "group" || record(source.metadata).loopOutputSlot === true) {
                throw new Error(`逐轮输入节点不属于循环左侧：${id}`);
            }
        }
    }
    const existingGroup = nodes.find((node) => node.type === "group" && (
        record(node.metadata).loopSourceId === input.loopNodeId && (record(node.metadata).loopOutputGroup === true || record(node.metadata).loopOutputSlot === true)
        || record(node.metadata).orderedGroup === true && projectConnections.some((connection) => String(connection.fromNodeId || "") === input.loopNodeId && String(connection.toNodeId || "") === String(node.id || ""))
    ));
    const groupBaseId = `loop-output-group-${input.loopNodeId}`;
    let groupId = String(existingGroup?.id || groupBaseId);
    if (!existingGroup && nodes.some((node) => String(node.id || "") === groupId)) {
        let suffix = 2;
        while (nodes.some((node) => String(node.id || "") === `${groupBaseId}-${suffix}`)) suffix += 1;
        groupId = `${groupBaseId}-${suffix}`;
    }
    const previousPlans = Array.isArray(record(existingGroup?.metadata).loopPreparedRuns)
        ? record(existingGroup?.metadata).loopPreparedRuns as Array<Record<string, unknown>> : [];
    const prior = previousPlans.find((plan) => plan.runId === input.runId);
    if (prior) {
        if (prior.mode !== input.mode || Number(prior.totalRounds) !== input.totalRounds || !Array.isArray(prior.slotNodeIds)
            || JSON.stringify(prior.roundInputNodeIds) !== JSON.stringify(input.roundInputNodeIds)) {
            throw new Error("循环运行 ID 已用于不同的轮次计划");
        }
        return { runId: input.runId, outputGroupId: groupId, slotNodeIds: prior.slotNodeIds.map(String), totalRounds: input.totalRounds };
    }

    const byId = new Map(nodes.map((node) => [String(node.id || ""), node]));
    const outgoing = new Map<string, string[]>();
    for (const connection of records(project.connections)) {
        const from = String(connection.fromNodeId || "");
        const to = String(connection.toNodeId || "");
        if (!from || !to) continue;
        outgoing.set(from, [...(outgoing.get(from) || []), to]);
    }
    const orderedExisting: string[] = [];
    const seen = new Set<string>([input.loopNodeId]);
    const walk = (nodeId: string) => {
        if (seen.has(nodeId)) return;
        seen.add(nodeId);
        const node = byId.get(nodeId);
        if (!node) return;
        if (isLoopOutputTarget(node) && nodeId !== groupId) orderedExisting.push(nodeId);
        for (const childId of outgoing.get(nodeId) || []) walk(childId);
    };
    for (const childId of outgoing.get(input.loopNodeId) || []) walk(childId);
    const rawRecordedSlots = record(existingGroup?.metadata).groupSlots;
    const recordedSlots = (Array.isArray(rawRecordedSlots)
        ? rawRecordedSlots.map(String)
        : nodes.filter((node) => record(node.metadata).groupId === groupId).map((node) => String(node.id || "")))
        .filter((id) => byId.has(id) && isLoopOutputTarget(byId.get(id)!));
    const detachedSlots = nodes.filter((node) => record(node.metadata).loopOutputSlot === true
        && record(node.metadata).loopSourceId === input.loopNodeId && record(node.metadata).groupId !== groupId)
        .sort((a, b) => Number(record(a.metadata).loopSlotIndex || 0) - Number(record(b.metadata).loopSlotIndex || 0))
        .map((node) => String(node.id || ""));
    const candidateIds = [...new Set([...recordedSlots, ...orderedExisting, ...detachedSlots])].filter((id) => id !== groupId);
    const slotNodeIds = Array.from({ length: input.totalRounds }, (_, index) => {
        if (candidateIds[index]) return candidateIds[index];
        const base = `${groupId}-slot-${index + 1}`;
        if (!byId.has(base)) return base;
        let suffix = 2;
        while (byId.has(`${base}-${suffix}`)) suffix += 1;
        return `${base}-${suffix}`;
    });
    const columns = Math.min(4, Math.max(1, input.totalRounds));
    const rows = Math.ceil(input.totalRounds / columns);
    const cellWidth = 340;
    const cellHeight = 240;
    const gap = 14;
    const width = 48 + columns * cellWidth + (columns - 1) * gap;
    const height = 76 + rows * cellHeight + (rows - 1) * gap;
    const loopPosition = record(loop.position);
    const groupPosition = existingGroup?.position || { x: Number(loopPosition.x || 0) + Number(loop.width || 380) + 96, y: Number(loopPosition.y || 0) };
    const operations: CanvasOperation[] = [];
    if (!existingGroup) operations.push({
        type: "add_node", id: groupId, nodeType: "group", title: "循环输出",
        position: groupPosition, width, height,
        metadata: { orderedGroup: true, orderedGroupColumns: columns, groupSlots: slotNodeIds, loopOutputGroup: true, loopOutputSlot: true, loopSourceId: input.loopNodeId, loopRootId: input.loopNodeId },
    });

    for (let index = 0; index < slotNodeIds.length; index += 1) {
        const slotId = slotNodeIds[index];
        const source = byId.get(slotId);
        const oldMetadata = record(source?.metadata);
        const activeTaskId = String(oldMetadata.runtimeTaskId || "");
        if (activeTaskId && ["queued", "running"].includes(String(stores.tasks.get(activeTaskId)?.status || ""))) {
            throw new Error(`输出槽 ${source?.title || slotId} 正在生成，循环尚未修改`);
        }
        const history = [...(Array.isArray(oldMetadata.loopOutputHistory) ? oldMetadata.loopOutputHistory as unknown[] : [])];
        const latestHistory = history.at(-1) as Record<string, unknown> | undefined;
        if (source && (oldMetadata.content || oldMetadata.storageKey) && !(latestHistory?.content === oldMetadata.content
            && latestHistory?.storageKey === oldMetadata.storageKey && latestHistory?.generationTaskId === oldMetadata.generationTaskId)) {
            history.push({ mode: oldMetadata.generationMode || source.type, content: oldMetadata.content, storageKey: oldMetadata.storageKey,
                prompt: oldMetadata.prompt, model: oldMetadata.model, generationTaskId: oldMetadata.generationTaskId });
        }
        const cellX = 24 + (index % columns) * (cellWidth + gap);
        const cellY = 52 + Math.floor(index / columns) * (cellHeight + gap);
        const metadata = {
            ...oldMetadata,
            smart: true,
            groupId,
            model: loop.metadata?.model,
            prompt: loop.metadata?.prompt,
            composerContent: loop.metadata?.composerContent,
            generationMode: input.mode,
            loopOutputSlot: true,
            loopSourceId: input.loopNodeId,
            loopRootId: input.loopNodeId,
            loopOutputGroupId: groupId,
            loopSlotIndex: index,
            loopOutputHistory: history,
        };
        if (source) {
            operations.push({ type: "update_node", id: slotId,
                patch: { type: "config", position: { x: Number(groupPosition.x) + cellX, y: Number(groupPosition.y) + cellY }, width: cellWidth, height: cellHeight },
                metadata, metadataDelete: ["runtimeTaskId", "errorDetails"] });
        } else {
            operations.push({ type: "add_node", id: slotId, nodeType: "config", title: `第 ${index + 1} 轮`,
                position: { x: Number(groupPosition.x) + cellX, y: Number(groupPosition.y) + cellY }, width: cellWidth, height: cellHeight,
                metadata: { ...metadata, status: "idle", images: [], texts: [] } });
        }
    }
    operations.push({ type: "update_node", id: groupId,
        patch: { width, height, title: "循环输出" },
        metadata: { orderedGroup: true, orderedGroupColumns: columns, groupSlots: slotNodeIds,
            loopOutputGroup: true, loopOutputSlot: true, loopSourceId: input.loopNodeId, loopRootId: input.loopNodeId, loopOutputMode: input.mode },
        metadataDelete: [] });
    const slotSet = new Set(slotNodeIds);
    const legacyOutputSet = new Set([...candidateIds, ...seen].filter((id) => id !== input.loopNodeId && id !== groupId));
    for (const connection of records(project.connections)) {
        const from = String(connection.fromNodeId || "");
        const to = String(connection.toNodeId || "");
        if ((from === input.loopNodeId && legacyOutputSet.has(to)) || (legacyOutputSet.has(from) && legacyOutputSet.has(to))) {
            operations.push({ type: "delete_connections", ids: [String(connection.id || "")] });
        }
    }
    const selectedSlots = new Set(slotNodeIds);
    const referencePrefix = `loop-input-ref-${input.loopNodeId}-`;
    const oldReferenceIds = projectConnections.filter((connection) => String(connection.id || "").startsWith(referencePrefix)
        && String(connection.role || "") === "loop-input-reference").map((connection) => String(connection.id));
    if (oldReferenceIds.length) operations.push({ type: "delete_connections", ids: oldReferenceIds });
    for (const [slotIndex, inputIds] of input.roundInputNodeIds.entries()) {
        for (const sourceId of inputIds) {
            const hash = crypto.createHash("sha256").update(`${sourceId}:${slotNodeIds[slotIndex]}`).digest("hex").slice(0, 16);
            operations.push({ type: "connect_nodes", id: `${referencePrefix}${slotIndex}-${hash}`,
                fromNodeId: sourceId, toNodeId: slotNodeIds[slotIndex], role: "loop-input-reference" });
        }
    }
    for (const id of recordedSlots.filter((slotId) => !selectedSlots.has(slotId))) {
        const oldSlot = byId.get(id)!;
        if (record(oldSlot.metadata).groupId !== groupId) continue;
        operations.push({ type: "update_node", id,
            patch: { position: { x: Number(groupPosition.x) + width + 96, y: Number(groupPosition.y) + (recordedSlots.indexOf(id) * 264) } },
            metadataDelete: ["groupId"] });
    }
    if (!records(project.connections).some((connection) => String(connection.fromNodeId || "") === input.loopNodeId && String(connection.toNodeId || "") === groupId)) {
        operations.push({ type: "connect_nodes", id: `connection-${groupId}-${input.loopNodeId}`, fromNodeId: input.loopNodeId, toNodeId: groupId });
    }
    const runPlans = [...previousPlans.filter((plan) => plan.runId !== input.runId), { runId: input.runId, mode: input.mode, totalRounds: input.totalRounds, slotNodeIds, roundInputNodeIds: input.roundInputNodeIds }].slice(-64);
    operations.push({ type: "update_node", id: groupId, metadata: { loopPreparedRuns: runPlans }, metadataDelete: [] });
    stores.projects.applyOperations(input.projectId, Number(project.revision || 0), operations,
        { operationId: `loop-run-prepare:${input.runId}`, runtimeWrite: true, source: { clientId: `loop:${input.loopNodeId}`, kind: "task", label: "循环输出准备" } });
    return { runId: input.runId, outputGroupId: groupId, slotNodeIds, totalRounds: input.totalRounds };
}

function isLoopOutputTarget(node: Record<string, any>) {
    const metadata = record(node.metadata);
    return node.type === "image" || node.type === "video" || node.type === "audio" || node.type === "text"
        || node.type === "config" && metadata.smart === true;
}

/**
 * Media result-node creation belongs to Backend so browser, MCP and Agent runs
 * get the same IDs, placement and initial state.
 */
export function prepareCanvasGenerationTarget(
    stores: Stores,
    command: CanvasGenerationCommand,
    taskId: string,
): PreparedCanvasGenerationTarget {
    if (command.loopOutput && (!command.projectId || !command.nodeId)) throw new Error("循环输出槽缺少 projectId 或 nodeId");
    if (!command.projectId || !command.nodeId || !["image", "video", "audio", "text"].includes(command.mode)) {
        return { command, project: null, createOperations: [] };
    }
    const project = stores.projects.get(command.projectId);
    const source = project && records(project.nodes).find((node) => String(node.id || "") === command.nodeId);
    if (!project || !source) throw new Error(`画布${modeLabel(command.mode)}生成目标不存在，未启动模型`);

    if (command.loopOutput) {
        if (command.mode === "image") return prepareLoopImageOutput(stores, project, source, command, taskId);
        if (command.mode === "video") return prepareLoopVideoOutput(stores, project, source, command, taskId);
        return prepareLoopOtherOutput(stores, project, source, command);
    }
    if (command.mode === "image") return prepareImage(stores, project, source, command, taskId);
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
    if (source.type !== "image" && source.type !== "loop" && !(source.type === "config" && record(source.metadata).smart === true && (record(source.metadata).generationMode || "image") === "image")) {
        throw new Error("循环输出槽只支持图片生成节点");
    }
    const size = { width: 340, height: 240 };
    const resolved = resolveLoopOutputSlot(stores, project, source, command, "image", size, taskId);
    const { loop } = resolved;
    // 首次运行：先把「组 + 全部轮次槽」建出来，本轮写入自己那一槽。
    if (resolved.pendingGroup) {
        const imageId = `image-slot-${crypto.randomUUID()}`;
        const image = { id: imageId, status: "loading", content: "", naturalWidth: 0, naturalHeight: 0, bytes: 0, mimeType: "", generationSnapshot: imageGenerationSnapshot(record(resolved.pendingSlotMetadata), command, 1) };
        const slotMetadata = { ...resolved.pendingSlotMetadata, images: [image], primaryImageId: imageId, activeImageHistoryId: imageId, activeImageHistoryExplicit: false, loopRoundIndex: loop.roundIndex, loopSlotIndex: loop.slotIndex };
        const createOperations: CanvasOperation[] = [
            ...resolved.pendingGroup.operations,
            { type: "update_node", id: resolved.pendingSlotId, metadata: slotMetadata, metadataDelete: ["content", "url", "storageKey", "mimeType", "bytes", "naturalWidth", "naturalHeight"] },
        ];
        return { command: { ...command, nodeId: resolved.pendingSlotId, sourceNodeId: String(source.id), imageIds: [imageId] }, project, createOperations, targetSize: size };
    }
    const existing = resolved.existing;
    // 组已存在但槽数不足：先补建缺失槽、同步 groupSlots，再写本轮结果。
    const padOps: CanvasOperation[] = resolved.paddingGroup ? [...resolved.paddingGroup] : [];
    if (resolved.nextGroupSlots && resolved.groupId) {
        padOps.push({ type: "update_node", id: resolved.groupId, metadata: { groupSlots: resolved.nextGroupSlots }, metadataDelete: [] });
    }
    const imageId = `image-slot-${crypto.randomUUID()}`;
    const image = { id: imageId, status: "loading", content: "", naturalWidth: 0, naturalHeight: 0, bytes: 0, mimeType: "", generationSnapshot: imageGenerationSnapshot(record(source.metadata), command, 1) };
    const tags = { loopOutputSlot: true, loopSourceId: loop.loopNodeId, loopRootId: loop.loopNodeId, loopRoundIndex: loop.roundIndex, loopSlotIndex: loop.slotIndex };
    const metadataDelete = ["content", "url", "storageKey", "mimeType", "bytes", "naturalWidth", "naturalHeight"];
    // 本轮槽在这一轮里刚好被补建出来时，结果直接写进那个槽，
    // 不能退回 createResultOperations 另建一个游离节点 —— 那正是「两张图被送进同一个/多出的节点」。
    const paddedSlotId = resolved.paddedSlotId;
    if (paddedSlotId) {
        const metadata = { ...tags, images: [image], primaryImageId: imageId, activeImageHistoryId: imageId, activeImageHistoryExplicit: false };
        return {
            command: { ...command, nodeId: paddedSlotId, sourceNodeId: String(source.id), imageIds: [imageId] },
            project,
            createOperations: [...padOps, { type: "update_node", id: paddedSlotId, metadata, metadataDelete }],
            targetSize: size,
        };
    }
    const outputId = String(existing?.id || `loop-image-${taskId}`);
    const metadata = { ...tags, images: [...records(record(existing?.metadata).images), image], primaryImageId: imageId, activeImageHistoryId: imageId, activeImageHistoryExplicit: false };
    const targetSize = existing ? { width: Number(existing.width || size.width), height: Number(existing.height || size.height) } : size;
    const createOperations: CanvasOperation[] = existing
        ? [...padOps, { type: "update_node", id: outputId, metadata, metadataDelete }]
        : [...padOps, ...createResultOperations(project, source, command, taskId, outputId, targetSize)];
    if (!existing) {
        // 注意：有 padOps 时 createOperations[0] 是补建槽，不是本轮结果节点，要按类型找。
        const add = createOperations.find((operation) => operation.type === "add_node" && operation.id === outputId) as Record<string, any> | undefined;
        if (add) {
            const sourceY = Number(record(source.position).y || 0);
            add.position = findResultPosition(project, source, targetSize, sourceY + loop.slotIndex * (targetSize.height + 28));
            add.title = `Image ${loop.roundIndex}`;
            add.metadata = { ...record(add.metadata), ...metadata };
        }
    }
    return { command: { ...command, nodeId: outputId, sourceNodeId: String(source.id), imageIds: [imageId] }, project, createOperations, targetSize };
}

function prepareLoopVideoOutput(stores: Stores, project: CanvasProject, source: Record<string, any>, command: CanvasGenerationCommand, taskId: string): PreparedCanvasGenerationTarget {
    if (source.type !== "video" && source.type !== "loop" && !(source.type === "config" && record(source.metadata).smart === true && record(source.metadata).generationMode === "video")) {
        throw new Error("循环视频输出槽只支持视频生成节点");
    }
    const size = { width: 340, height: 190 };
    const resolved = resolveLoopOutputSlot(stores, project, source, command, "video", size, taskId);
    const { loop } = resolved;
    const metadataDelete = ["content", "url", "storageKey", "mimeType", "bytes", "naturalWidth", "naturalHeight", "durationMs"];
    if (resolved.pendingGroup) {
        const createOperations: CanvasOperation[] = [
            ...resolved.pendingGroup.operations,
            { type: "update_node", id: resolved.pendingSlotId, metadata: { ...resolved.pendingSlotMetadata, loopRoundIndex: loop.roundIndex, loopSlotIndex: loop.slotIndex }, metadataDelete },
        ];
        return { command: { ...command, nodeId: resolved.pendingSlotId, sourceNodeId: String(source.id) }, project, createOperations, targetSize: size };
    }
    const existing = resolved.existing;
    const outputId = String(existing?.id || `loop-video-${taskId}`);
    const previous = record(existing?.metadata);
    const history = [...records(previous.loopOutputHistory)];
    const latestHistory = history.at(-1) as Record<string, unknown> | undefined;
    if ((previous.content || previous.storageKey) && !(latestHistory?.content === previous.content && latestHistory?.storageKey === previous.storageKey
        && latestHistory?.generationTaskId === previous.generationTaskId)) {
        history.push({ mode: previous.generationMode || "video", content: previous.content, storageKey: previous.storageKey, mimeType: previous.mimeType, bytes: previous.bytes, naturalWidth: previous.naturalWidth, naturalHeight: previous.naturalHeight, durationMs: previous.durationMs, generationTaskId: previous.generationTaskId });
    }
    const tags = { loopOutputSlot: true, loopSourceId: loop.loopNodeId, loopRootId: loop.loopNodeId, loopRoundIndex: loop.roundIndex, loopSlotIndex: loop.slotIndex };
    const targetSize = existing ? { width: Number(existing.width || size.width), height: Number(existing.height || size.height) } : size;
    const createOperations: CanvasOperation[] = existing
        ? [{ type: "update_node", id: outputId, metadata: { ...tags, loopOutputHistory: history }, metadataDelete }]
        : createResultOperations(project, source, command, taskId, outputId, targetSize);
    if (!existing) {
        const add = createOperations[0] as Record<string, any>;
        const sourceY = Number(record(source.position).y || 0);
        add.position = findResultPosition(project, source, targetSize, sourceY + loop.slotIndex * (targetSize.height + 28));
        add.title = `Video ${loop.roundIndex}`;
        add.metadata = { ...record(add.metadata), ...tags };
    }
    return { command: { ...command, nodeId: outputId, sourceNodeId: String(source.id) }, project, createOperations, targetSize };
}

function prepareLoopOtherOutput(stores: Stores, project: CanvasProject, source: Record<string, any>, command: CanvasGenerationCommand): PreparedCanvasGenerationTarget {
    const mode = command.mode;
    if (mode !== "audio" && mode !== "text") throw new Error("不支持的循环输出模式");
    const resolved = resolveLoopOutputSlot(stores, project, source, command, mode, defaultSize(mode), "");
    const existing = resolved.existing;
    if (!existing) throw new Error("循环输出槽不存在，请重新准备循环结果组");
    const metadata = record(existing.metadata);
    const history = [...(Array.isArray(metadata.loopOutputHistory) ? metadata.loopOutputHistory : [])];
    const latestHistory = history.at(-1) as Record<string, unknown> | undefined;
    if ((metadata.content || metadata.storageKey) && !(latestHistory?.content === metadata.content && latestHistory?.storageKey === metadata.storageKey
        && latestHistory?.generationTaskId === metadata.generationTaskId)) history.push({
        mode: metadata.generationMode || mode,
        content: metadata.content,
        storageKey: metadata.storageKey,
        mimeType: metadata.mimeType,
        bytes: metadata.bytes,
        durationMs: metadata.durationMs,
        prompt: metadata.prompt,
        model: metadata.model,
        generationTaskId: metadata.generationTaskId,
    });
    const tags = { loopOutputSlot: true, loopSourceId: resolved.loop.loopNodeId, loopRootId: resolved.loop.loopNodeId,
        loopOutputGroupId: String(record(existing.metadata).groupId || command.loopOutput?.outputGroupId || ""),
        loopRoundIndex: resolved.loop.roundIndex, loopSlotIndex: resolved.loop.slotIndex };
    return {
        command,
        project,
        createOperations: [{ type: "update_node", id: String(existing.id),
            metadata: { ...tags, status: "idle", generationMode: mode, model: command.model, prompt: command.prompt || "", loopOutputHistory: history },
            metadataDelete: ["runtimeTaskId", "errorDetails"] }],
        targetSize: { width: Number(existing.width || defaultSize(mode).width), height: Number(existing.height || defaultSize(mode).height) },
    };
}

function resolveLoopOutputSlot(stores: Stores, project: CanvasProject, source: Record<string, any>, command: CanvasGenerationCommand, mode: CanvasGenerationCommand["mode"], slotSize: { width: number; height: number }, taskId: string) {
    const loop = command.loopOutput!;
    const nodes = records(project.nodes);
    const loopNode = nodes.find((node) => String(node.id || "") === loop.loopNodeId && node.type === "loop");
    if (loop.slotNodeId) {
        const slot = nodes.find((node) => String(node.id || "") === loop.slotNodeId);
        const groupId = String(loop.outputGroupId || record(slot?.metadata).loopOutputGroupId || "");
        const group = nodes.find((node) => node.type === "group" && String(node.id || "") === groupId
            && record(node.metadata).loopOutputGroup === true && record(node.metadata).loopSourceId === loop.loopNodeId);
        const groupSlots = Array.isArray(record(group?.metadata).groupSlots) ? record(group?.metadata).groupSlots.map(String) : [];
        const actualSlotIndex = groupSlots.indexOf(String(slot?.id || ""));
        if (!loopNode || !group || !slot || String(source.id || "") !== loop.slotNodeId
            || actualSlotIndex !== loop.slotIndex || loop.totalRounds !== undefined && loop.slotIndex >= loop.totalRounds
            || String(record(slot.metadata).groupId || "") !== groupId
            || record(slot.metadata).loopSourceId !== loop.loopNodeId
            || record(slot.metadata).loopOutputSlot !== true
            || slot.type !== "config" || record(slot.metadata).smart !== true
            || (record(slot.metadata).generationMode || "image") !== mode) {
            throw new Error("循环输出槽与当前循环或生成模式不匹配");
        }
        const activeTaskId = String(record(slot.metadata).runtimeTaskId || "");
        if (activeTaskId && ["queued", "running"].includes(String(stores.tasks.get(activeTaskId)?.status || ""))) {
            throw new Error("该循环轮次的输出槽正在生成");
        }
        return { loop, existing: slot, groupId };
    }
    // 循环节点自己就是生成源时，source 就是循环节点本身，不存在「循环 → 生成节点」这条连线。
    // 只有当生成源是另一个下游节点时，才要求它真的挂在循环下游。
    const sourceIsLoop = String(source.id) === loop.loopNodeId;
    if (!loopNode || (!sourceIsLoop && !isDownstreamOf(project, loop.loopNodeId, String(source.id)))) {
        throw new Error("循环节点未连接到本次生成节点");
    }
    const isSlot = (node: Record<string, any>) => {
        const value = record(node.metadata);
        if (value.loopOutputSlot !== true || value.loopSourceId !== loop.loopNodeId || value.loopRootId !== source.id) return false;
        // 槽既可能是旧的独立 image/video 结果节点，也可能是新结构里的智能生成节点。
        return node.type === mode || (node.type === "config" && value.smart === true);
    };
    const candidates = nodes.filter(isSlot);
    const existing = candidates.find((node) => Number(record(node.metadata).loopRoundIndex) === loop.roundIndex)
        || candidates.find((node) => Number(record(node.metadata).loopSlotIndex) === loop.slotIndex);
    // 组还没建（首次运行）时，先把「组 + 全部轮次槽」一次性建出来。
    // 组的查找不能依赖 existing：首次运行时 existing 是 undefined，但组可能已经
    // 由上一轮建好（那一轮跑的是别的槽）。要独立按 loopSourceId + loopRootId 找组，
    // 否则每轮都会重复建一个新组，组内槽也会被重复创建。
    const group = nodes.find((node) => {
        const value = record(node.metadata);
        return node.type === "group" && value.loopOutputSlot === true
            && value.loopSourceId === loop.loopNodeId && value.loopRootId === String(source.id);
    });
    // 真实轮次只能来自前端：auto 模式下实际轮次由上游素材数算出（resolveLoopInputPlan），
    // 和用户设置的 loopCount 无关。绝不能拿 loopCount 或"已有槽数"当兜底 ——
    // loopCount 默认是 1，会把 2 张组图压成 1 个槽；candidates.length 是已建出的数量，
    // 用它兜底会让组永远补不满。拿不到就按 1 处理，宁可少建也不要建错。
    const totalRounds = Math.max(1, Math.min(100, Math.floor(Number(loop.totalRounds) || 1)));
    if (!group) {
        const built = buildLoopOutputGroupOperations(project, loop, source, totalRounds, taskId, slotSize);
        const slot = built.operations.find((operation) => operation.type === "add_node" && operation.id === built.address.groupSlotId) as Record<string, any> | undefined;
        return { loop, existing: undefined, pendingGroup: built, pendingSlotId: built.address.groupSlotId, pendingSlotMetadata: record(slot?.metadata) };
    }
    // 组已存在但槽数不足（例如第一次运行时 totalRounds 传错、或之后调大了轮次），
    // 补建缺失的槽并同步 groupSlots，否则本轮的槽根本不存在。
    // groupSlots 是字符串数组，records() 只保留对象，这里必须自己取值。
    const rawSlots = record(group.metadata).groupSlots;
    const groupSlots: string[] = Array.isArray(rawSlots) ? rawSlots.map((entry) => String(entry)).filter(Boolean) : [];
    if (groupSlots.length < totalRounds) {
        const missing = Array.from({ length: totalRounds - groupSlots.length }, (_, offset) => `${group.id}-slot-${groupSlots.length + offset + 1}`);
        const columnCount = Math.min(4, totalRounds);
        const rows = Math.ceil(totalRounds / columnCount);
        const slotSizeForPad = { width: Number(group.width || 340) / Math.max(1, columnCount) - 28, height: (Number(group.height || 240) - 32) / Math.max(1, rows) - 28 };
        const created = missing.map((slotId, offset) => {
            const index = groupSlots.length + offset;
            return {
                type: "add_node",
                id: slotId,
                nodeType: "config",
                title: `第 ${index + 1} 轮`,
                position: {
                    x: Number(record(group.position).x || 0) + 16 + (index % columnCount) * (slotSizeForPad.width + 28),
                    y: Number(record(group.position).y || 0) + 16 + Math.floor(index / columnCount) * (slotSizeForPad.height + 28),
                },
                width: Math.max(180, slotSizeForPad.width),
                height: Math.max(140, slotSizeForPad.height),
                metadata: {
                    smart: true,
                    groupId: group.id,
                    model: loopNode.metadata?.model,
                    size: loopNode.metadata?.size,
                    quality: loopNode.metadata?.quality,
                    background: loopNode.metadata?.background,
                    generationMode: loopNode.metadata?.generationMode || "image",
                    status: "idle",
                    loopOutputSlot: true,
                    loopSourceId: loop.loopNodeId,
                    loopRootId: String(source.id),
                    loopRoundIndex: index + 1,
                    loopSlotIndex: index,
                },
            } satisfies CanvasOperation;
        });
        const activeTaskId = String(record(existing?.metadata).runtimeTaskId || "");
        if (activeTaskId && ["queued", "running"].includes(String(stores.tasks.get(activeTaskId)?.status || ""))) throw new Error("该循环轮次的输出槽正在生成");
        // 本轮的槽如果正好在这次补建范围内，直接指向它，结果写进补建出来的槽。
        const paddedSlotId = missing.find((slotId) => Number(slotId.slice(slotId.lastIndexOf("-") + 1)) - 1 === loop.slotIndex);
        return { loop, existing, paddingGroup: created, nextGroupSlots: [...groupSlots, ...missing], groupId: group.id, paddedSlotId };
    }
    const activeTaskId = String(record(existing?.metadata).runtimeTaskId || "");
    if (activeTaskId && ["queued", "running"].includes(String(stores.tasks.get(activeTaskId)?.status || ""))) throw new Error("该循环轮次的输出槽正在生成");
    return { loop, existing };
}

/**
 * 循环输出槽的定位信息。`groupId`/`groupSlotId` 指向预先建好的有序组与组内槽。
 */
type LoopOutputSlotAddress = {
    groupId: string;
    groupSlotId: string;
    roundIndex: number;
    slotIndex: number;
};

/**
 * 预先建好「一个有序组 + N 个智能生成节点槽」。
 *
 * 循环开始运行前一次性建好全部轮次槽，之后每轮只往自己的槽写结果，
 * 不再每轮新建一个游离的结果节点。槽是智能生成节点（config + smart），
 * 配置继承循环节点，但参考图由调用方按轮次注入。
 */
export function buildLoopOutputGroupOperations(
    project: CanvasProject,
    loopOutput: { loopNodeId: string; roundIndex: number; slotIndex: number },
    source: Record<string, any>,
    total: number,
    taskId: string,
    size: { width: number; height: number },
    groupLayout?: { startX: number; startY: number },
): { operations: CanvasOperation[]; address: LoopOutputSlotAddress } {
    const loopNode = records(project.nodes).find((node) => String(node.id || "") === loopOutput.loopNodeId);
    // 槽的配置继承真正的生成参数来源：生成源就是循环节点时读循环节点，
    // 否则（下游智能生成节点）读那个生成源。否则槽会拿到空 model，跑不出正确结果。
    const configSource = String(source.id) === loopOutput.loopNodeId ? loopNode : source;
    const loopMetadata = record(configSource?.metadata);
    const rounds = Math.max(1, Math.min(100, Math.floor(Number(total) || 1)));
    const groupId = `loop-output-group-${loopOutput.loopNodeId}-${taskId}`;
    const startX = groupLayout?.startX ?? (Number(record(source.position).x || 0) + Number(source.width || size.width) + 96);
    const startY = groupLayout?.startY ?? Number(record(source.position).y || 0);
    // 组容器要能装下全部槽位；每行最多 4 个，成员按顺序从左到右、从上到下排列。
    const columns = Math.min(4, rounds);
    const rows = Math.ceil(rounds / columns);
    const groupWidth = columns * (size.width + 28) + 32;
    const groupHeight = rows * (size.height + 28) + 32;

    const operations: CanvasOperation[] = [{
        type: "add_node",
        id: groupId,
        nodeType: "group",
        title: "循环输出",
        position: { x: startX, y: startY },
        width: groupWidth,
        height: groupHeight,
        metadata: {
            orderedGroup: true,
            orderedGroupColumns: columns,
            groupSlots: Array.from({ length: rounds }, (_, index) => `${groupId}-slot-${index + 1}`),
            loopOutputSlot: true,
            loopSourceId: loopOutput.loopNodeId,
            loopRootId: String(source.id),
        },
        }];

    for (let index = 0; index < rounds; index++) {
        const slotId = `${groupId}-slot-${index + 1}`;
        operations.push({
            type: "add_node",
            id: slotId,
            nodeType: "config",
            title: `第 ${index + 1} 轮`,
            position: {
                x: startX + 16 + (index % columns) * (size.width + 28),
                y: startY + 16 + Math.floor(index / columns) * (size.height + 28),
            },
            width: size.width,
            height: size.height,
            metadata: {
                smart: true,
                groupId,
                // 槽的配置继承循环节点；参考图由每轮生成时按 roundIndex 注入。
                model: loopMetadata.model,
                size: loopMetadata.size,
                quality: loopMetadata.quality,
                background: loopMetadata.background,
                seconds: loopMetadata.seconds,
                vquality: loopMetadata.vquality,
                generateAudio: loopMetadata.generateAudio,
                watermark: loopMetadata.watermark,
                audioVoice: loopMetadata.audioVoice,
                audioFormat: loopMetadata.audioFormat,
                audioSpeed: loopMetadata.audioSpeed,
                audioInstructions: loopMetadata.audioInstructions,
                reasoningEffort: loopMetadata.reasoningEffort,
                generationMode: loopMetadata.generationMode || "image",
                status: "idle",
                loopOutputSlot: true,
                loopSourceId: loopOutput.loopNodeId,
                loopRootId: String(source.id),
                loopRoundIndex: index + 1,
                loopSlotIndex: index,
            },
        });
        operations.push({ type: "connect_nodes", id: `connection-${groupId}-${index + 1}`, fromNodeId: String(source.id), toNodeId: slotId });
    }

    const slotIndex = Math.min(rounds - 1, Math.max(0, Math.floor(Number(loopOutput.slotIndex) || 0)));
    return { operations, address: { groupId, groupSlotId: `${groupId}-slot-${slotIndex + 1}`, roundIndex: loopOutput.roundIndex, slotIndex } };
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
