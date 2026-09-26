import { CanvasNodeType, type CanvasConnection, type CanvasNodeData, type CanvasNodeMetadata, type CanvasNodeTypeId, type Position } from "@/types/canvas";

export function upstreamLoopForGeneration(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const node = byId.get(nodeId);
    if (node?.type === CanvasNodeType.Loop) return node;
    return connections.filter((connection) => connection.toNodeId === nodeId)
        .map((connection) => byId.get(connection.fromNodeId))
        .find((source) => source?.type === CanvasNodeType.Loop);
}

export function singleLoopPanelTarget(loopNodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[], isTarget: (node: CanvasNodeData) => boolean) {
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const targets = connections.filter((connection) => connection.fromNodeId === loopNodeId)
        .map((connection) => byId.get(connection.toNodeId))
        .filter((node): node is CanvasNodeData => Boolean(node && isTarget(node)));
    return targets.length === 1 ? targets[0] : null;
}

export function resolveLoopInputPlan(metadata: CanvasNodeMetadata, imageCount: number, videoCount: number) {
    const start = Math.max(1, Math.floor(Number(metadata.loopStart) || 1));
    const mode = metadata.loopMediaMode || (metadata.loopVideoEnabled ? "video" : metadata.loopImageEnabled ? "image" : "auto");
    const mediaKind = mode === "image" || mode === "video" ? mode
        : mode === "off" ? null
        : imageCount && !videoCount ? "image" : videoCount && !imageCount ? "video" : null;
    const batchSize = Math.max(1, Math.min(100, Math.floor(Number(mediaKind === "video" ? metadata.loopVideoBatchSize : metadata.loopImageBatchSize) || 1)));
    const sourceCount = mediaKind === "image" ? imageCount : mediaKind === "video" ? videoCount : 0;
    const availableRounds = mediaKind ? Math.ceil(Math.max(0, sourceCount - start + 1) / batchSize) : 0;
    const configured = Math.max(1, Math.min(100, Math.floor(Number(metadata.loopCount) || 1)));
    const countMode = metadata.loopCountMode || (configured === 1 ? "auto" : "manual");
    const rounds = mediaKind
        ? countMode === "auto" ? Math.min(100, availableRounds) : Math.min(configured, availableRounds)
        : configured;
    return { mediaKind, rounds, start, batchSize, sourceCount, availableRounds, countMode };
}

/**
 * 循环节点没有连任何生成节点时，运行时自动补一个智能生成节点并接上连线。
 *
 * 以前这里直接 `message.warning(noTarget)` 拒绝运行，强制用户先手动连下游。
 * 现在改为自动创建，三个要点：
 *   1. 必须是智能生成节点（Config + `smart:true`），否则渲染不出来也拿不到参数；
 *   2. 必须带提示词。`buildNodeGenerationContext` 对 smart 节点有两条分支：
 *      提示词含 `@[node:<id>]` 时走 composer，把 token 换成参考标签（`图片1` 之类）；
 *      不含 token 时走普通分支，图片仍会进 `loopInputImages`，
 *      但 token 字面量或空提示词会原样发给模型。所以带 token 才是正确写法。
 *   3. 参考不写死在 metadata 里，靠连线在运行时按轮次现场算，所以连线必须一起建。
 *
 * 类型跟随循环已开启的媒体模式（image/video），未开启时默认图片。
 */
export function createLoopFallbackOutput(
    loopNodeId: string,
    loopNode: CanvasNodeData,
    createNode: (type: CanvasNodeTypeId, position: Position, metadata?: CanvasNodeMetadata) => CanvasNodeData,
    position: Position,
): { node: CanvasNodeData; connection: CanvasConnection } {
    const mode = loopNode.metadata?.loopMediaMode
        || (loopNode.metadata?.loopVideoEnabled ? "video" : loopNode.metadata?.loopImageEnabled ? "image" : "image");
    const generationMode = mode === "video" ? "video" : "image";
    // 空数组是"逐条轮换"，undefined 才是"沿用文本字段"；循环没提示词时留空，避免写空数组复活旧文本。
    const loopPrompts = loopNode.metadata?.loopPrompts ?? (loopNode.metadata?.loopPrompt?.trim()
        ? [loopNode.metadata.loopPrompt.trim()]
        : undefined);
    const prompt = `@[node:${loopNodeId}]`;
    const node = createNode(CanvasNodeType.Config, position, {
        smart: true,
        generationMode,
        prompt,
        composerContent: prompt,
        ...(loopPrompts ? { loopPrompts } : {}),
    });
    return { node, connection: { id: `conn-loop-${loopNodeId}-${node.id}`, fromNodeId: loopNodeId, toNodeId: node.id } as CanvasConnection };
}

/** Order every reachable generation node after its upstream dependencies. */
export function buildLoopGenerationStages(
    loopNodeId: string,
    nodes: CanvasNodeData[],
    connections: CanvasConnection[],
    isTarget: (node: CanvasNodeData) => boolean,
) {
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const children = new Map<string, string[]>();
    for (const connection of [...connections].sort((a, b) => (a.order || 0) - (b.order || 0))) {
        const next = children.get(connection.fromNodeId) || [];
        next.push(connection.toNodeId);
        children.set(connection.fromNodeId, next);
    }
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const order: CanvasNodeData[] = [];
    const walk = (id: string) => {
        if (visiting.has(id)) throw new Error("循环节点的下游连线形成了环");
        if (visited.has(id)) return;
        visiting.add(id);
        for (const childId of [...(children.get(id) || [])].reverse()) {
            const child = byId.get(childId);
            if (child && child.type !== CanvasNodeType.Loop && child.metadata?.loopOutputSlot !== true) walk(childId);
        }
        visiting.delete(id);
        visited.add(id);
        const node = byId.get(id);
        if (node) order.push(node);
    };
    walk(loopNodeId);
    const levelById = new Map<string, number>([[loopNodeId, 0]]);
    const stages: CanvasNodeData[][] = [];
    for (const node of order.reverse()) {
        const level = levelById.get(node.id) || 0;
        const target = node.id !== loopNodeId && isTarget(node);
        if (target) (stages[level] ||= []).push(node);
        for (const childId of children.get(node.id) || []) {
            if (byId.get(childId)?.type === CanvasNodeType.Loop || byId.get(childId)?.metadata?.loopOutputSlot === true) continue;
            levelById.set(childId, Math.max(levelById.get(childId) || 0, level + Number(target)));
        }
    }
    return stages.filter(Boolean);
}

export async function runLoopGenerationStages<T>(stages: T[][], controller: AbortController, run: (target: T) => Promise<void>) {
    for (const stage of stages) {
        controller.signal.throwIfAborted();
        for (const target of stage) {
            controller.signal.throwIfAborted();
            await run(target);
        }
        controller.signal.throwIfAborted();
    }
}

/** Parallelism applies to whole rounds; every round keeps its own sequential dependency chain. */
export async function runLoopGenerationRounds(
    roundCount: number,
    limit: number,
    controller: AbortController,
    run: (round: number) => Promise<void>,
) {
    let next = 0;
    let firstFailure: unknown;
    const workers = Array.from({ length: Math.min(roundCount, Math.max(1, Math.floor(limit) || 1)) }, async () => {
        while (next < roundCount && !controller.signal.aborted) {
            const round = next++;
            try {
                await run(round);
            } catch (error) {
                if (firstFailure === undefined) firstFailure = error;
                controller.abort();
            }
        }
    });
    await Promise.all(workers);
    if (firstFailure !== undefined) throw firstFailure;
    controller.signal.throwIfAborted();
}
