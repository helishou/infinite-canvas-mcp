import { imageReferenceLabel } from "@/lib/image-reference-prompt";
import { shallow } from "zustand/vanilla/shallow";
import i18n from "@/i18n";
import { getNodeDefinition } from "@/lib/canvas/node-registry";
import { getDataUrlByteSize, readImageMeta } from "@/lib/image-utils";
import { imageToDataUrl } from "@/services/image-storage";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";
import type { CanvasNodeResource } from "@/types/canvas-plugin";
import { buildCanvasSpatialIndex, type CanvasSpatialIndex } from "@/lib/canvas/canvas-spatial-index";
import { orderedGroupSlots } from "@/lib/canvas/ordered-group";

export type CanvasResourceKind = "image" | "video" | "audio" | "text";

export type CanvasCharacterReferenceSelection = {
    imageKeys?: string[];
    voiceEnabled?: boolean;
};

export function characterReferenceKey(image: { storageKey?: string; url?: string; name?: string }, index: number) {
    return image.storageKey || image.url || image.name || `image-${index}`;
}

export type CanvasResourceReference = {
    id: string;
    nodeId: string;
    kind: CanvasResourceKind;
    label: string;
    title: string;
    previewUrl?: string;
    storageKey?: string;
    text?: string;
    active: boolean;
};

export type CanvasGraphIndex = {
    nodeById: Map<string, CanvasNodeData>;
    incomingByNodeId: Map<string, CanvasNodeData[]>;
    outgoingByNodeId: Map<string, CanvasNodeData[]>;
    connectionsByNodeId: Map<string, CanvasConnection[]>;
    groupChildrenById: Map<string, CanvasNodeData[]>;
    nodeSpatialIndex: CanvasSpatialIndex<CanvasNodeData>;
    connectionSpatialIndex: CanvasSpatialIndex<CanvasConnection>;
};

function connectionBounds(connection: CanvasConnection, nodeById: Map<string, CanvasNodeData>) {
    const from = nodeById.get(connection.fromNodeId);
    const to = nodeById.get(connection.toNodeId);
    if (!from || !to) return null;
    const startX = from.position.x + from.width;
    const startY = from.position.y + from.height / 2;
    const endX = to.position.x;
    const endY = to.position.y + to.height / 2;
    const curvature = Math.max(Math.abs(endX - startX) * 0.5, 50);
    return {
        left: Math.min(startX, endX - curvature),
        top: Math.min(startY, endY),
        right: Math.max(startX + curvature, endX),
        bottom: Math.max(startY, endY),
    };
}

export function buildCanvasGraphIndex(nodes: CanvasNodeData[], connections: CanvasConnection[]): CanvasGraphIndex {
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const incomingByNodeId = new Map<string, CanvasNodeData[]>();
    const outgoingByNodeId = new Map<string, CanvasNodeData[]>();
    const connectionsByNodeId = new Map<string, CanvasConnection[]>();
    connections.forEach((connection) => {
        const source = nodeById.get(connection.fromNodeId);
        const target = nodeById.get(connection.toNodeId);
        if (!source || !target) return;
        for (const nodeId of [source.id, target.id]) {
            const related = connectionsByNodeId.get(nodeId) || [];
            related.push(connection);
            connectionsByNodeId.set(nodeId, related);
        }
        const incoming = incomingByNodeId.get(target.id) || [];
        incoming.push(source);
        incomingByNodeId.set(target.id, incoming);
        const outgoing = outgoingByNodeId.get(source.id) || [];
        outgoing.push(target);
        outgoingByNodeId.set(source.id, outgoing);
    });
    const groupChildrenById = new Map<string, CanvasNodeData[]>();
    nodes.forEach((node) => {
        const groupId = node.metadata?.groupId;
        if (!groupId) return;
        const children = groupChildrenById.get(groupId) || [];
        children.push(node);
        groupChildrenById.set(groupId, children);
    });
    const nodeSpatialIndex = buildCanvasSpatialIndex(nodes, (node) => ({ left: node.position.x, top: node.position.y, right: node.position.x + node.width, bottom: node.position.y + node.height }));
    const connectionSpatialIndex = buildCanvasSpatialIndex(connections, (connection) => connectionBounds(connection, nodeById));
    return { nodeById, incomingByNodeId, outgoingByNodeId, connectionsByNodeId, groupChildrenById, nodeSpatialIndex, connectionSpatialIndex };
}

function graphIndex(nodes: CanvasNodeData[], connections: CanvasConnection[], index?: CanvasGraphIndex) {
    return index || buildCanvasGraphIndex(nodes, connections);
}

export function buildNodeMentionReferences(node: CanvasNodeData, nodes: CanvasNodeData[], connections: CanvasConnection[], index?: CanvasGraphIndex) {
    return labelResourceNodes(getMentionResourceNodes(node.id, nodes, connections, index), true);
}

export function buildCanvasResourceReferences(nodes: CanvasNodeData[]) {
    return labelResourceNodes(nodes, true);
}

export async function resolveCanvasReferenceImages(references: CanvasResourceReference[], nodes: CanvasNodeData[]) {
    const nodesById = new Map(nodes.map((node) => [node.id, node]));
    return Promise.all(references.filter((reference) => reference.kind === "image").map(async (reference) => {
        const node = nodesById.get(reference.nodeId);
        if (!node) throw new Error(i18n.t("agent.composer.mentions.resourceMissing", { title: reference.title }));
        const metadata = node.metadata;
        const dataUrl = await imageToDataUrl({ storageKey: reference.storageKey || metadata?.storageKey, url: reference.previewUrl });
        if (!dataUrl.startsWith("data:image/")) throw new Error(i18n.t("agent.composer.mentions.imageReadFailed", { title: reference.title }));
        const meta = metadata?.naturalWidth && metadata.naturalHeight
            ? { width: metadata.naturalWidth, height: metadata.naturalHeight, mimeType: metadata.mimeType || dataUrl.match(/^data:([^;]+)/)?.[1] || "image/png" }
            : await readImageMeta(dataUrl);
        return {
            id: `canvas:${node.id}`,
            name: reference.title,
            type: metadata?.mimeType || meta.mimeType,
            size: metadata?.bytes || getDataUrlByteSize(dataUrl),
            width: meta.width,
            height: meta.height,
            url: reference.previewUrl || dataUrl,
            dataUrl,
        };
    }));
}

export function getMentionResourceNodes(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[], index?: CanvasGraphIndex) {
    const resolvedIndex = graphIndex(nodes, connections, index);
    const configInputs = expandGroupResourceNodes(getConnectedConfigInputNodes(nodeId, nodes, connections, resolvedIndex), nodes, resolvedIndex);
    if (configInputs.length) return configInputs;
    const fixedInputs = getFixedReferenceNodes(nodeId, nodes, resolvedIndex);
    const ownInputs = expandGroupResourceNodes(fixedInputs.length ? fixedInputs : getContextInputNodes(nodeId, nodes, connections, resolvedIndex), nodes, resolvedIndex);
    if (ownInputs.length) return ownInputs;
    const node = resolvedIndex.nodeById.get(nodeId);
    return node && isResourceNode(node) ? [node] : [];
}

/** 相同资源内容保留数组引用，让未受影响节点的 React.memo 生效。 */
export function createMentionReferenceSelector() {
    let previous = new Map<string, CanvasResourceReference[]>();
    return (visibleNodes: CanvasNodeData[], nodes: CanvasNodeData[], connections: CanvasConnection[], index: CanvasGraphIndex) => {
        const next = new Map<string, CanvasResourceReference[]>();
        for (const node of visibleNodes) {
            const references = buildNodeMentionReferences(node, nodes, connections, index);
            const cached = previous.get(node.id);
            next.set(node.id, cached && cached.length === references.length && cached.every((item, i) => shallow(item, references[i])) ? cached : references);
        }
        previous = next;
        return next;
    };
}

export function getGenerationResourceNodes(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[], index?: CanvasGraphIndex) {
    const resolvedIndex = graphIndex(nodes, connections, index);
    const configInputs = getConnectedConfigInputNodes(nodeId, nodes, connections, resolvedIndex);
    if (configInputs.length) return configInputs;
    const ownInputs = getContextInputNodes(nodeId, nodes, connections, resolvedIndex);
    if (ownInputs.length) return ownInputs;
    return [];
}

function getContextInputNodes(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[], index?: CanvasGraphIndex) {
    const resolvedIndex = graphIndex(nodes, connections, index);
    const variableIds = loopVariableSourceIds(nodeId, nodes, resolvedIndex);
    return (resolvedIndex.incomingByNodeId.get(nodeId) || []).filter((node) => !variableIds.has(node.id) && isCanvasReferenceNode(node, nodes, resolvedIndex));
}

/** A loop's sources remain iteration inputs even if old canvases also link them to the generator. */
function loopVariableSourceIds(nodeId: string, nodes: CanvasNodeData[], index: CanvasGraphIndex) {
    const ids = new Set<string>();
    for (const loop of index.incomingByNodeId.get(nodeId) || []) {
        if (loop.type !== CanvasNodeType.Loop) continue;
        for (const source of loopSourceRoles(loop, nodes, index).variable) {
            ids.add(source.id);
            if (source.type === CanvasNodeType.Group) {
                for (const child of getGroupResourceNodes(source.id, nodes, index)) ids.add(child.id);
            }
        }
    }
    return ids;
}

function loopSourceRoles(loop: CanvasNodeData, nodes: CanvasNodeData[], index: CanvasGraphIndex) {
    const sources = index.incomingByNodeId.get(loop.id) || [];
    const hasMedia = (node: CanvasNodeData) => node.type === CanvasNodeType.Character || nodeResourceItems(node).some((item) => item.kind === "image" || item.kind === "video");
    const groups = sources.filter((source) => source.type === CanvasNodeType.Group && getGroupResourceNodes(source.id, nodes, index).some(hasMedia));
    return {
        variable: groups.length ? groups : sources.filter(hasMedia),
        fixed: groups.length ? sources.filter((source) => source.type !== CanvasNodeType.Group && hasMedia(source)) : [],
    };
}

export function getFixedReferenceNodes(nodeId: string, nodes: CanvasNodeData[], index: CanvasGraphIndex) {
    const variableIds = loopVariableSourceIds(nodeId, nodes, index);
    const incoming = index.incomingByNodeId.get(nodeId) || [];
    const direct = incoming.filter((node) => node.type !== CanvasNodeType.Loop && !variableIds.has(node.id));
    const throughLoops = incoming.filter((node) => node.type === CanvasNodeType.Loop).flatMap((loop) => loopSourceRoles(loop, nodes, index).fixed);
    return [...new Map([...direct, ...throughLoops].map((node) => [node.id, node])).values()];
}

function getConnectedConfigInputNodes(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[], index?: CanvasGraphIndex) {
    const resolvedIndex = graphIndex(nodes, connections, index);
    const configNode = (resolvedIndex.outgoingByNodeId.get(nodeId) || []).find((node) => node.type === CanvasNodeType.Config);
    if (!configNode) return [];
    return getContextInputNodes(configNode.id, nodes, connections, resolvedIndex).filter((node) => node.id !== nodeId);
}

function hasGroupResources(node: CanvasNodeData, nodes: CanvasNodeData[], index?: CanvasGraphIndex) {
    return node.type === CanvasNodeType.Group && getGroupResourceNodes(node.id, nodes, index).length > 0;
}

export function isCanvasReferenceNode(node: CanvasNodeData, nodes: CanvasNodeData[], index?: CanvasGraphIndex) {
    return node.type === CanvasNodeType.Character || isResourceNode(node) || hasGroupResources(node, nodes, index) || hasLoopResources(node, nodes, index);
}

function expandGroupResourceNodes(inputNodes: CanvasNodeData[], nodes: CanvasNodeData[], index?: CanvasGraphIndex) {
    const resources = inputNodes.flatMap((node) => (node.type === CanvasNodeType.Group ? getGroupResourceNodes(node.id, nodes, index) : [node]));
    return [...new Map(resources.map((node) => [node.id, node])).values()];
}

export function getGroupResourceNodes(groupId: string, nodes: CanvasNodeData[], index?: CanvasGraphIndex) {
    const group = index?.nodeById.get(groupId) || nodes.find((node) => node.id === groupId);
    if (group?.metadata?.orderedGroup) {
        const byId = index?.nodeById || new Map(nodes.map((node) => [node.id, node]));
        return orderedGroupSlots(group, nodes).map((id) => byId.get(id)).filter((node): node is CanvasNodeData => Boolean(node && isResourceNode(node)));
    }
    return (index?.groupChildrenById.get(groupId) || nodes.filter((node) => node.metadata?.groupId === groupId)).filter(isResourceNode);
}

function labelResourceNodes(nodes: CanvasNodeData[], active: boolean) {
    const counts: Record<CanvasResourceKind, number> = { image: 0, video: 0, audio: 0, text: 0 };
    return nodes.flatMap((node): CanvasResourceReference[] => {
        return nodeResourceItems(node).map((resource, resourceIndex) => {
            const index = counts[resource.kind]++;
            const label = labelForKind(resource.kind, index);
            return {
                id: `${node.id}:${resourceIndex}`,
                nodeId: node.id,
                kind: resource.kind,
                label,
                title: nodeResourceTitle(node, resource, resourceIndex, label),
                previewUrl: resource.url,
                storageKey: resource.storageKey,
                text: resource.text,
                active,
            };
        });
    });
}

/** 判断节点是否为「图像类生成节点」：专用生图节点，或智能生成节点且生成模式为 image。 */
export function isImageGenerationNode(node?: CanvasNodeData | null): boolean {
    if (!node) return false;
    if (node.type === CanvasNodeType.Image && Boolean(node.metadata?.content || node.metadata?.images?.length)) return true;
    if (node.type === CanvasNodeType.Config && node.metadata?.smart === true) {
        const mode = node.metadata?.generationMode || "image";
        return mode === "image";
    }
    return false;
}

/** 判断节点是否为「音频类生成节点」：专用音频节点，或智能生成节点且生成模式为 audio。 */
export function isAudioGenerationNode(node?: CanvasNodeData | null): boolean {
    if (!node) return false;
    if (node.type === CanvasNodeType.Audio) return true;
    if (node.type === CanvasNodeType.Config && node.metadata?.smart === true) {
        const mode = node.metadata?.generationMode || "image";
        return mode === "audio";
    }
    return false;
}

/** 判断节点是否为「文本类生成节点」：专用文本节点（创建菜单「文本生成」），或智能生成节点且生成模式为 text。 */
export function isTextGenerationNode(node?: CanvasNodeData | null): boolean {
    if (!node) return false;
    if (node.type === CanvasNodeType.Text) return true;
    if (node.type === CanvasNodeType.Config && node.metadata?.smart === true) {
        const mode = node.metadata?.generationMode || "image";
        return mode === "text";
    }
    return false;
}

export function nodeResourceItems(node: CanvasNodeData): CanvasNodeResource[] {
    if (node.type === CanvasNodeType.Loop && node.metadata?.loopPromptEnabled) {
        const prompt = node.metadata.loopPrompts !== undefined
            ? node.metadata.loopPrompts.map((value) => value.trim()).filter(Boolean).join("\n")
            : node.metadata.loopPrompt?.trim();
        if (prompt) return [{ kind: "text", text: prompt }];
    }
    const smartMode = node.type === CanvasNodeType.Config && node.metadata?.smart === true ? node.metadata?.generationMode || "image" : undefined;
    if (smartMode === "image") {
        const images = node.metadata?.images || [];
        const primaryImageId = node.metadata?.primaryImageId || images[0]?.id;
        const primaryImage = images.find((image) => image.id === primaryImageId && Boolean(image.content || image.storageKey));
        if (primaryImage) return [{ kind: "image" as const, url: primaryImage.content || undefined, storageKey: primaryImage.storageKey }];
        if (node.metadata?.content) return [{ kind: "image", url: node.metadata.content, storageKey: node.metadata.storageKey }];
    }
    if (smartMode === "video" && node.metadata?.content) return [{ kind: "video", url: node.metadata.content, storageKey: node.metadata.storageKey }];
    if (smartMode === "audio" && node.metadata?.content) return [{ kind: "audio", url: node.metadata.content, storageKey: node.metadata.storageKey }];
    if (smartMode === "text" && (node.metadata?.content || node.metadata?.prompt)) return [{ kind: "text", text: node.metadata.content || node.metadata.prompt }];
    if (node.type === CanvasNodeType.Image && node.metadata?.content) return [{ kind: "image", url: node.metadata.content, storageKey: node.metadata.storageKey }];
    if (node.type === CanvasNodeType.Video && node.metadata?.content) return [{ kind: "video", url: node.metadata.content, storageKey: node.metadata.storageKey }];
    if (node.type === CanvasNodeType.Audio && node.metadata?.content) return [{ kind: "audio", url: node.metadata.content, storageKey: node.metadata.storageKey }];
    if (node.type === CanvasNodeType.Text && (node.metadata?.content || node.metadata?.prompt)) return [{ kind: "text", text: node.metadata.content || node.metadata.prompt }];
    const resource = getNodeDefinition(node.type)?.resource?.(node);
    return Array.isArray(resource) ? resource : resource ? [resource] : [];
}

function nodeResourceTitle(node: CanvasNodeData, resource: CanvasNodeResource, index: number, fallback: string) {
    if (resource.text && node.type === CanvasNodeType.Text) return node.title || fallback;
    return nodeResourceItems(node).length > 1 ? `${node.title || "输出"} · Clip ${index + 1}` : node.title || fallback;
}

function labelForKind(kind: CanvasResourceKind, index: number) {
    if (kind === "image") return imageReferenceLabel(index);
    if (kind === "video") return i18n.t("canvas.configNode.videoReferences") + ` ${index + 1}`;
    if (kind === "audio") return i18n.t("canvas.configNode.audioReferences") + ` ${index + 1}`;
    return i18n.t("canvas.composer.resources.text", { index: index + 1 });
}

function isResourceNode(node: CanvasNodeData) {
    return Boolean(resourceKind(node));
}

function hasLoopResources(node: CanvasNodeData, nodes: CanvasNodeData[], index?: CanvasGraphIndex): boolean {
    if (node.type !== CanvasNodeType.Loop) return false;
    const metadata = node.metadata;
    if (metadata?.loopPromptEnabled && (metadata.loopPrompts !== undefined ? metadata.loopPrompts.some((value) => value.trim()) : metadata.loopPrompt?.trim())) return true;
    const resolvedIndex = graphIndex(nodes, [], index);
    return (resolvedIndex.incomingByNodeId.get(node.id) || []).some((source) => source.type === CanvasNodeType.Loop
        ? hasLoopResources(source, nodes, resolvedIndex)
        : (source.type === CanvasNodeType.Group ? getGroupResourceNodes(source.id, nodes, resolvedIndex) : [source])
            .some((item) => nodeResourceItems(item).some((resource) => resource.kind === "image" || resource.kind === "video" || metadata?.loopPromptEnabled && resource.kind === "text")));
}

function resourceText(node: CanvasNodeData): string | undefined {
    if (node.type === CanvasNodeType.Text) return node.metadata?.content || node.metadata?.prompt;
    return nodeResourceItems(node).find((resource) => resource.kind === "text")?.text;
}

function resourceKind(node: CanvasNodeData): CanvasResourceKind | null {
    const smartMode = node.type === CanvasNodeType.Config && node.metadata?.smart === true ? node.metadata?.generationMode || "image" : undefined;
    if (smartMode && nodeResourceItems(node).some((resource) => resource.kind === smartMode)) return smartMode;
    if (node.type === CanvasNodeType.Image && node.metadata?.content) return "image";
    if (node.type === CanvasNodeType.Video && node.metadata?.content) return "video";
    if (node.type === CanvasNodeType.Audio && node.metadata?.content) return "audio";
    if (node.type === CanvasNodeType.Text && (node.metadata?.content || node.metadata?.prompt)) return "text";
    // Plugin nodes declare their input eligibility through definition.resource.
    return nodeResourceItems(node)[0]?.kind || null;
}
