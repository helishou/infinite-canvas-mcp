import type { CanvasConnection, CanvasNodeData } from "@/types/canvas";

export type CanvasClipboard = {
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
};

export const CANVAS_CLIPBOARD_FORMAT = "application/x-infinite-canvas-nodes";

export function serializeCanvasClipboard(clipboard: CanvasClipboard) {
    return JSON.stringify({ format: CANVAS_CLIPBOARD_FORMAT, version: 1, ...clipboard });
}

export function parseCanvasClipboard(text: string): CanvasClipboard | null {
    try {
        const value = JSON.parse(text) as { format?: unknown; version?: unknown; nodes?: unknown; connections?: unknown };
        if (value.format !== CANVAS_CLIPBOARD_FORMAT || value.version !== 1 || !Array.isArray(value.nodes) || !Array.isArray(value.connections)) return null;
        const nodes = value.nodes.filter((node): node is CanvasNodeData => {
            if (!node || typeof node !== "object") return false;
            const item = node as Partial<CanvasNodeData>;
            return typeof item.id === "string" && typeof item.type === "string" && typeof item.title === "string" && typeof item.width === "number" && typeof item.height === "number" && Boolean(item.position) && typeof item.position?.x === "number" && typeof item.position?.y === "number";
        });
        if (!nodes.length) return null;
        const nodeIds = new Set(nodes.map((node) => node.id));
        const connections = value.connections.filter((connection): connection is CanvasConnection => {
            if (!connection || typeof connection !== "object") return false;
            const item = connection as Partial<CanvasConnection>;
            return typeof item.id === "string" && typeof item.fromNodeId === "string" && typeof item.toNodeId === "string" && (nodeIds.has(item.fromNodeId) || nodeIds.has(item.toNodeId));
        });
        return { nodes, connections };
    } catch {
        return null;
    }
}

export function isLegacyCanvasClipboardText(text: string) {
    try {
        const value = JSON.parse(text) as { format?: unknown };
        // 兼容历史格式名与当前格式（复制兜底时 JSON 会以纯文本进入系统剪贴板）。
        return value.format === "infinite-canvas-nodes" || value.format === CANVAS_CLIPBOARD_FORMAT;
    } catch {
        return false;
    }
}

export function findClipboardMediaType(item: Pick<ClipboardItem, "types">, kind: "image" | "video" | "audio") {
    return item.types.find((type) => type.startsWith(`${kind}/`) || type.startsWith(`web ${kind}/`));
}
