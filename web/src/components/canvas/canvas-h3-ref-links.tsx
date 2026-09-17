import { memo, useCallback, useMemo, useSyncExternalStore } from "react";

import { connectionStrokeStyle } from "@/components/canvas/canvas-connections";
import { canvasThemes } from "@/lib/canvas-theme";
import { getPluginNodeView } from "@/stores/canvas/plugin-node-view";
import { useThemeStore } from "@/stores/use-theme-store";
import type { CanvasNodeData, Position } from "@/types/canvas";

type RefLike = { url?: string; storageKey?: string; nodeId?: string; role?: string };
type SegmentLike = { id?: string; refItems?: RefLike[]; refs?: { image?: RefLike[]; video?: RefLike[]; audio?: RefLike[] } };
export type H3RefLink = { id: string; from: CanvasNodeData; to: CanvasNodeData };

// H3 导演台节点的 type 为 minimax-h3:video，历史类型还有 smart-minimax / minimax。
function isH3Node(node: CanvasNodeData) {
    return /^minimax|^smart-minimax/.test(String(node.type || ""));
}

function segmentRefs(segment: SegmentLike): RefLike[] {
    const items = segment.refItems?.length
        ? segment.refItems
        : [...(segment.refs?.image || []), ...(segment.refs?.video || []), ...(segment.refs?.audio || [])];
    return items.filter((item) => item && (item.url || item.storageKey) && item.role !== "character_identity");
}

function nodeMediaKeys(node: CanvasNodeData) {
    const meta = (node.metadata || {}) as Record<string, unknown>;
    const urls = [meta.content, meta.url, meta.localUrl, meta.sourceUrl]
        .filter((value): value is string => typeof value === "string" && Boolean(value));
    const storageKey = typeof meta.storageKey === "string" ? meta.storageKey : "";
    return { urls, storageKey };
}

// 当前选中 Clip 的参考图 → H3 节点。ref 通常没有 nodeId（拖放时未写入），
// 因此按 storageKey 优先、url 兜底反查画布节点，保证历史数据也能连上。
export function collectH3RefLinks(nodes: CanvasNodeData[], selectedSegmentIdForNode?: (node: CanvasNodeData) => unknown): H3RefLink[] {
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const byStorageKey = new Map<string, CanvasNodeData>();
    const byUrl = new Map<string, CanvasNodeData>();
    nodes.forEach((node) => {
        const { urls, storageKey } = nodeMediaKeys(node);
        if (storageKey && !byStorageKey.has(storageKey)) byStorageKey.set(storageKey, node);
        urls.forEach((url) => { if (!byUrl.has(url)) byUrl.set(url, node); });
    });

    const links: H3RefLink[] = [];
    nodes.forEach((node) => {
        if (!isH3Node(node)) return;
        const meta = (node.metadata || {}) as Record<string, unknown>;
        const segments = Array.isArray(meta.segments) ? (meta.segments as SegmentLike[]) : [];
        if (!segments.length) return;
        const selectedId = String(selectedSegmentIdForNode ? selectedSegmentIdForNode(node) || "" : meta.selectedSegmentId || "");
        const segment = segments.find((item) => item?.id === selectedId) || segments[0];
        const seen = new Set<string>();
        segmentRefs(segment).forEach((ref) => {
            const source = (ref.nodeId ? nodeById.get(String(ref.nodeId)) : undefined)
                || (ref.storageKey ? byStorageKey.get(String(ref.storageKey)) : undefined)
                || (ref.url ? byUrl.get(String(ref.url)) : undefined);
            if (!source || source.id === node.id || seen.has(source.id)) return;
            seen.add(source.id);
            links.push({ id: `${source.id}->${node.id}`, from: source, to: node });
        });
    });
    return links;
}

// 拖动中的节点用预览坐标，保证连线实时跟随，与真实连线行为一致。
function linkPath(from: CanvasNodeData, to: CanvasNodeData, dragPreviewPositions?: ReadonlyMap<string, Position>) {
    const fromPosition = dragPreviewPositions?.get(from.id) || from.position;
    const toPosition = dragPreviewPositions?.get(to.id) || to.position;
    const startX = fromPosition.x + from.width;
    const startY = fromPosition.y + from.height / 2;
    const endX = toPosition.x;
    const endY = toPosition.y + to.height / 2;
    const curvature = Math.max(Math.abs(endX - startX) * 0.5, 50);
    return `M ${startX} ${startY} C ${startX + curvature} ${startY}, ${endX - curvature} ${endY}, ${endX} ${endY}`;
}

// 当前 Clip 参考图的来源连线：区别于真实连线，用虚线且不参与交互。
export const CanvasH3RefLinks = memo(function CanvasH3RefLinks({ projectId, nodes, selectedNodeIds, dragPreviewPositions }: { projectId: string; nodes: CanvasNodeData[]; selectedNodeIds?: ReadonlySet<string>; dragPreviewPositions?: ReadonlyMap<string, Position> }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const h3NodeIds = useMemo(() => nodes.filter(isH3Node).map((node) => node.id), [nodes]);
    const subscribe = useCallback((listener: () => void) => {
        const releases = h3NodeIds.map((nodeId) => getPluginNodeView(projectId, nodeId).subscribe(listener));
        return () => releases.forEach((release) => release());
    }, [h3NodeIds, projectId]);
    const getLocalSelections = useCallback(() => h3NodeIds.map((nodeId) => String(getPluginNodeView(projectId, nodeId).getSnapshot().selectedSegmentId || "")).join("\0"), [h3NodeIds, projectId]);
    const localSelections = useSyncExternalStore(subscribe, getLocalSelections, getLocalSelections);
    const links = useMemo(() => collectH3RefLinks(nodes, (node) => getPluginNodeView(projectId, node.id).getSnapshot().selectedSegmentId), [localSelections, nodes, projectId]);
    if (!links.length) return null;

    return (
        <g style={{ pointerEvents: "none" }}>
            {links.map((link) => {
                // 与真实连线同一套规则：选中 H3 节点（或参考图节点）时这条引用关系也走强调色。
                const strokeStyle = connectionStrokeStyle(theme, Boolean(selectedNodeIds?.has(link.to.id) || selectedNodeIds?.has(link.from.id)));
                return (
                    <path
                        key={link.id}
                        d={linkPath(link.from, link.to, dragPreviewPositions)}
                        fill="none"
                        {...strokeStyle}
                        style={{ ...strokeStyle.style, pointerEvents: "none" }}
                    />
                );
            })}
        </g>
    );
});
