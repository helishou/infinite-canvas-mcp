import { CanvasNodeType, type CanvasNodeData, type Position } from "@/types/canvas";
import { orderedGroupSlots } from "@/lib/canvas/ordered-group";

export type CanvasReferenceRole = "character_turnaround" | "storyboard" | "scene" | "motion_reference" | "audio_reference";
export type CanvasReferenceDrag = { nodeId: string; url: string; type: "image"; name: string; storageKey?: string; mimeType?: string; role?: CanvasReferenceRole; subjectId?: string };
// 角色派发：H3 端按 characterGroupInput 建/复用角色组，由 group 派生 outfit image refs + voice audio ref
export type CharacterReferenceDrag = {
    nodeId: string;
    type: "character";
    kind: "character";
    characterAssetId?: string;
    characterNodeId?: string;
    characterName: string;
    characterImages: Array<{ url: string; name: string; storageKey?: string; mimeType?: string }>;
    characterPrimaryIndex?: number;
    characterVoiceUrl?: string;
    characterVoiceName?: string;
    characterVoiceDescription?: string;
    characterVoiceStorageKey?: string;
    characterVoiceAssetId?: string;
    voice?: string;
    voiceName?: string;
    voiceDescription?: string;
    voiceAssetId?: string;
};
export type AnyReferenceDrag = CanvasReferenceDrag | CharacterReferenceDrag;

export function buildCanvasReferenceDragPayload(node: CanvasNodeData | undefined): AnyReferenceDrag | undefined {
    if (!node) return undefined;
    if (node.type === CanvasNodeType.Image) {
        const url = String(node.metadata?.content || "").trim();
        if (!url) return undefined;
        const role = canvasReferenceRole(node);
        return {
            nodeId: node.id,
            url,
            type: "image",
            name: node.title || "图片",
            storageKey: node.metadata?.storageKey,
            mimeType: node.metadata?.mimeType,
            role,
            subjectId: role === "character_turnaround" ? node.id : undefined,
        };
    }
    if (node.type === CanvasNodeType.Character) {
        const images = (node.metadata?.characterImages || []).filter((image) => image.url);
        return {
            nodeId: node.id,
            type: "character",
            kind: "character",
            characterNodeId: node.id,
            characterName: node.title || "角色",
            characterImages: images.map((image) => ({ url: image.url, name: image.outfit || image.name || "outfit", storageKey: image.storageKey, mimeType: image.mimeType })),
            characterPrimaryIndex: node.metadata?.characterPrimaryIndex || 0,
            characterVoiceUrl: node.metadata?.characterVoiceUrl,
            characterVoiceName: node.metadata?.characterVoiceName,
            characterVoiceDescription: node.metadata?.characterVoiceDescription,
            characterVoiceStorageKey: node.metadata?.characterVoiceStorageKey,
            characterVoiceAssetId: node.metadata?.characterVoiceAssetId,
        };
    }
    if (node.type === CanvasNodeType.Scene) {
        const image = node.metadata?.sceneImage;
        return image?.url
            ? { nodeId: node.id, url: image.url, type: "image", name: node.title || "场景", storageKey: image.storageKey, mimeType: image.mimeType, role: "scene" }
            : undefined;
    }
    return undefined;
}

function canvasReferenceRole(node: CanvasNodeData): CanvasReferenceRole | undefined {
    const value = `${node.type} ${node.title || ""}`.toLowerCase();
    // 角色节点是身份资产，不是四视图；拖到 ref 槽时只展开为普通 image ref。
    if (/四视图|turnaround/.test(value)) return "character_turnaround";
    if (/分镜|storyboard/.test(value)) return "storyboard";
    if (/场景|scene/.test(value)) return "scene";
    return undefined;
}

export type CanvasNodeDragSelection = {
    movedIds: Set<string>;
    initialSelectedNodes: Map<string, Position>;
    hasMovedGroup: boolean;
    movingNodes: CanvasNodeData[];
    groupDropCandidates: CanvasNodeData[];
};

export function buildCanvasNodeDragSelection(nodes: CanvasNodeData[], selectedNodeIds: ReadonlySet<string>): CanvasNodeDragSelection {
    const movedIds = new Set(selectedNodeIds);
    nodes.forEach((node) => {
        if (!selectedNodeIds.has(node.id) || node.type !== CanvasNodeType.Group) return;
        const childIds = node.metadata?.orderedGroup
            ? orderedGroupSlots(node, nodes)
            : nodes.filter((child) => child.metadata?.groupId === node.id).map((child) => child.id);
        childIds.forEach((childId) => movedIds.add(childId));
    });
    const movedNodes = nodes.filter((node) => movedIds.has(node.id));
    return {
        movedIds,
        initialSelectedNodes: new Map(movedNodes.map((node) => [node.id, node.position])),
        hasMovedGroup: movedNodes.some((node) => node.type === CanvasNodeType.Group),
        movingNodes: movedNodes.filter((node) => node.type !== CanvasNodeType.Group),
        groupDropCandidates: nodes.filter((node) => node.type === CanvasNodeType.Group && !movedIds.has(node.id) && !node.metadata?.groupLocked),
    };
}

export function canvasNodeDragOffset(start: Position, pointer: Position, zoom: number): Position {
    return {
        x: (pointer.x - start.x) / zoom,
        y: (pointer.y - start.y) / zoom,
    };
}

export function hasCanvasNodeDragMoved(start: Position, pointer: Position, threshold = 3) {
    return Math.abs(pointer.x - start.x) > threshold || Math.abs(pointer.y - start.y) > threshold;
}

export function canvasNodeDragPreviewPositions(initialPositions: ReadonlyMap<string, Position>, offset: Position) {
    return new Map([...initialPositions].map(([id, initial]) => [id, { x: initial.x + offset.x, y: initial.y + offset.y }]));
}
