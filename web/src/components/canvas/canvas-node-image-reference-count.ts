import { buildNodeGenerationContext } from "./canvas-node-generation";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

/** Settings must describe the inputs used by the next generation, not the @ candidate list. */
export function getNodeImageReferenceCount(
    node: CanvasNodeData,
    nodes: CanvasNodeData[],
    connectedNodes: CanvasNodeData[],
    prompt: string,
    loopInputCount = 0,
    historyReferenceCount?: number,
): number {
    if (historyReferenceCount !== undefined) return historyReferenceCount;
    // Fixed sources and the current loop's input count are supplied separately by the panel.
    const connections = connectedNodes.map((source) => ({ id: source.id, fromNodeId: source.id, toNodeId: node.id }));
    const context = buildNodeGenerationContext(node.id, nodes, connections, prompt);
    // The ordinary image editor sends its own image; smart generators never do so implicitly.
    const ownImageCount = node.type === CanvasNodeType.Image && node.metadata?.content ? 1 : 0;
    return context.referenceImages.length + ownImageCount + loopInputCount;
}
