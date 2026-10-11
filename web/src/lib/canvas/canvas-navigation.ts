import type { CanvasNodeData, ViewportTransform } from "@/types/canvas";

export function canvasNodeSearchText(node: CanvasNodeData, typeLabel = "") {
    const metadata = node.metadata || {};
    const text = node.type === "text" || metadata.generationMode === "text" ? metadata.content : "";
    const segments = (metadata as Record<string, unknown>).segments;
    const clipPrompts = Array.isArray(segments) ? segments.flatMap((segment: unknown) => {
        const prompt = segment && typeof segment === "object" ? (segment as { prompt?: unknown }).prompt : undefined;
        return typeof prompt === "string" ? [prompt] : [];
    }) : [];
    return [node.id, node.title, typeLabel, metadata.prompt, text, metadata.characterName, metadata.sceneName, metadata.propName, metadata.propDescription, ...clipPrompts].filter((value) => typeof value === "string").join(" ").toLocaleLowerCase();
}

/** Use the same fit margin and zoom range as the existing single-node focus. */
export function viewportForCanvasNodes(nodes: CanvasNodeData[], size: { width: number; height: number }): ViewportTransform | null {
    const valid = nodes.filter((node) => [node.position.x, node.position.y, node.width, node.height].every(Number.isFinite) && node.width >= 0 && node.height >= 0);
    if (!valid.length || size.width <= 0 || size.height <= 0) return null;
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    for (const node of valid) {
        left = Math.min(left, node.position.x); top = Math.min(top, node.position.y);
        right = Math.max(right, node.position.x + node.width); bottom = Math.max(bottom, node.position.y + node.height);
    }
    const k = Math.min(Math.max(Math.min(size.width * .6 / Math.max(1, right - left), size.height * .6 / Math.max(1, bottom - top)), .05), 1);
    return { x: size.width / 2 - (left + right) / 2 * k, y: size.height / 2 - (top + bottom) / 2 * k, k };
}

/** Preserve the captured canvas order; IDs and all non-title fields remain untouched. */
export function canvasRenamePreview(nodes: CanvasNodeData[], prefix: string, start: number | null) {
    if (start === null || !Number.isSafeInteger(start) || start < 1 || start > Number.MAX_SAFE_INTEGER - Math.max(0, nodes.length - 1)) return [];
    return nodes.map((node, index) => ({ id: node.id, before: node.title, title: `${prefix.trim()}${prefix.trim() ? " " : ""}${String(start + index).padStart(2, "0")}` }));
}
