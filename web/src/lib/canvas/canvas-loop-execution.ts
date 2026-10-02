import { CanvasNodeType, type CanvasConnection, type CanvasNodeData, type CanvasNodeMetadata } from "@/types/canvas";

export function upstreamLoopForGeneration(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const node = byId.get(nodeId);
    if (node?.type === CanvasNodeType.Loop) return node;
    const loopSourceId = node?.metadata?.loopSourceId;
    if (node?.metadata?.loopOutputSlot === true && loopSourceId) {
        const loop = byId.get(loopSourceId);
        if (loop?.type === CanvasNodeType.Loop) return loop;
    }
    return connections.filter((connection) => connection.toNodeId === nodeId)
        .map((connection) => byId.get(connection.fromNodeId))
        .find((source) => source?.type === CanvasNodeType.Loop);
}

export function resolveLoopInputPlan(metadata: CanvasNodeMetadata, imageCount: number, videoCount: number, audioCount = 0, promptCount = 0) {
    const start = Math.max(1, Math.floor(Number(metadata.loopStart) || 1));
    const mode = metadata.loopMediaMode || (metadata.loopVideoEnabled ? "video" : metadata.loopImageEnabled ? "image" : "auto");
    const availableKinds: Array<"image" | "video" | "audio"> = [imageCount ? "image" : "", videoCount ? "video" : "", audioCount ? "audio" : ""].filter((kind): kind is "image" | "video" | "audio" => Boolean(kind));
    const mediaKind: "image" | "video" | "audio" | null = mode === "image" || mode === "video" || mode === "audio" ? mode
        : availableKinds.length === 1 ? availableKinds[0] : null;
    const batchSize = Math.max(1, Math.min(100, Math.floor(Number(mediaKind === "video" ? metadata.loopVideoBatchSize : mediaKind === "audio" ? metadata.loopAudioBatchSize : metadata.loopImageBatchSize) || 1)));
    const sourceCount = mediaKind === "image" ? imageCount : mediaKind === "video" ? videoCount : mediaKind === "audio" ? audioCount : promptCount;
    const availableRounds = Math.ceil(Math.max(0, sourceCount - start + 1) / batchSize);
    const rounds = sourceCount > 0 ? Math.min(100, availableRounds) : mediaKind ? 0 : 1;
    return { mediaKind, rounds, start, batchSize, sourceCount, availableRounds, countMode: "auto" as const };
}

/** Run one independently bound output slot per round with a shared concurrency limit. */
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
