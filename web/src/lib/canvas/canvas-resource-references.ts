import { imageReferenceLabel } from "@/lib/image-reference-prompt";
import i18n from "@/i18n";
import { getNodeDefinition } from "@/lib/canvas/node-registry";
import { getDataUrlByteSize, readImageMeta } from "@/lib/image-utils";
import { imageToDataUrl } from "@/services/image-storage";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";
import type { CanvasNodeResource } from "@/types/canvas-plugin";

export type CanvasResourceKind = "image" | "video" | "audio" | "text";

export type CanvasResourceReference = {
    id: string;
    nodeId: string;
    kind: CanvasResourceKind;
    label: string;
    title: string;
    previewUrl?: string;
    text?: string;
    active: boolean;
};

export type CanvasGraphIndex = {
    nodeById: Map<string, CanvasNodeData>;
    incomingByNodeId: Map<string, CanvasNodeData[]>;
    outgoingByNodeId: Map<string, CanvasNodeData[]>;
    groupChildrenById: Map<string, CanvasNodeData[]>;
};

export function buildCanvasGraphIndex(nodes: CanvasNodeData[], connections: CanvasConnection[]): CanvasGraphIndex {
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const incomingByNodeId = new Map<string, CanvasNodeData[]>();
    const outgoingByNodeId = new Map<string, CanvasNodeData[]>();
    connections.forEach((connection) => {
        const source = nodeById.get(connection.fromNodeId);
        const target = nodeById.get(connection.toNodeId);
        if (!source || !target) return;
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
    return { nodeById, incomingByNodeId, outgoingByNodeId, groupChildrenById };
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
        const dataUrl = await imageToDataUrl({ storageKey: metadata?.storageKey, url: reference.previewUrl });
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
    const ownInputs = expandGroupResourceNodes(getContextInputNodes(nodeId, nodes, connections, resolvedIndex), nodes, resolvedIndex);
    if (ownInputs.length) return ownInputs;
    const node = resolvedIndex.nodeById.get(nodeId);
    return node && isResourceNode(node) ? [node] : [];
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
    return (resolvedIndex.incomingByNodeId.get(nodeId) || []).filter((node) => isCanvasReferenceNode(node, nodes, resolvedIndex));
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
    return isResourceNode(node) || hasGroupResources(node, nodes, index);
}

function expandGroupResourceNodes(inputNodes: CanvasNodeData[], nodes: CanvasNodeData[], index?: CanvasGraphIndex) {
    const resources = inputNodes.flatMap((node) => (node.type === CanvasNodeType.Group ? getGroupResourceNodes(node.id, nodes, index) : [node]));
    return [...new Map(resources.map((node) => [node.id, node])).values()];
}

export function getGroupResourceNodes(groupId: string, nodes: CanvasNodeData[], index?: CanvasGraphIndex) {
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
                text: resource.text,
                active,
            };
        });
    });
}

export function nodeResourceItems(node: CanvasNodeData): CanvasNodeResource[] {
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

function resourceText(node: CanvasNodeData): string | undefined {
    if (node.type === CanvasNodeType.Text) return node.metadata?.content || node.metadata?.prompt;
    return nodeResourceItems(node).find((resource) => resource.kind === "text")?.text;
}

function resourceKind(node: CanvasNodeData): CanvasResourceKind | null {
    if (node.type === CanvasNodeType.Image && node.metadata?.content) return "image";
    if (node.type === CanvasNodeType.Video && node.metadata?.content) return "video";
    if (node.type === CanvasNodeType.Audio && node.metadata?.content) return "audio";
    if (node.type === CanvasNodeType.Text && (node.metadata?.content || node.metadata?.prompt)) return "text";
    // Plugin nodes declare their input eligibility through definition.resource.
    return nodeResourceItems(node)[0]?.kind || null;
}
