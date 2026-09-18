import { memo, useCallback, useMemo, useSyncExternalStore } from "react";

import { connectionStrokeStyle } from "@/components/canvas/canvas-connections";
import { useCanvasDragPreviewPair } from "@/lib/canvas/canvas-drag-preview";
import { canvasThemes, type CanvasTheme } from "@/lib/canvas-theme";
import { getPluginNodeView } from "@/stores/canvas/plugin-node-view";
import { useThemeStore } from "@/stores/use-theme-store";
import type { CanvasNodeData, Position } from "@/types/canvas";

type RefLike = { url?: string; storageKey?: string; nodeId?: string; role?: string };
type SegmentLike = { id?: string; refItems?: RefLike[]; refs?: { image?: RefLike[]; video?: RefLike[]; audio?: RefLike[] } };
export type H3RefLink = { id: string; from: CanvasNodeData; to: CanvasNodeData };
type H3RefLookup = {
    nodeById: ReadonlyMap<string, CanvasNodeData>;
    byStorageKey: ReadonlyMap<string, CanvasNodeData>;
    byUrl: ReadonlyMap<string, CanvasNodeData>;
};

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

function buildH3RefLookup(nodes: CanvasNodeData[]): H3RefLookup {
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const byStorageKey = new Map<string, CanvasNodeData>();
    const byUrl = new Map<string, CanvasNodeData>();
    nodes.forEach((node) => {
        const { urls, storageKey } = nodeMediaKeys(node);
        if (storageKey && !byStorageKey.has(storageKey)) byStorageKey.set(storageKey, node);
        urls.forEach((url) => { if (!byUrl.has(url)) byUrl.set(url, node); });
    });
    return { nodeById, byStorageKey, byUrl };
}

// 当前选中 Clip 的参考图 → H3 节点。ref 通常没有 nodeId（拖放时未写入），
// 因此按 storageKey 优先、url 兜底反查画布节点，保证历史数据也能连上。
export function collectH3RefLinks(nodes: CanvasNodeData[], selectedSegmentIdForNode?: (node: CanvasNodeData) => unknown, targetNodeIds?: ReadonlySet<string>, lookup?: H3RefLookup): H3RefLink[] {
    const resolvedLookup = lookup || buildH3RefLookup(nodes);

    const links: H3RefLink[] = [];
    nodes.forEach((node) => {
        if (!isH3Node(node) || (targetNodeIds && !targetNodeIds.has(node.id))) return;
        const meta = (node.metadata || {}) as Record<string, unknown>;
        const segments = Array.isArray(meta.segments) ? (meta.segments as SegmentLike[]) : [];
        if (!segments.length) return;
        const selectedId = String(selectedSegmentIdForNode ? selectedSegmentIdForNode(node) || "" : meta.selectedSegmentId || "");
        const segment = segments.find((item) => item?.id === selectedId) || segments[0];
        const seen = new Set<string>();
        segmentRefs(segment).forEach((ref) => {
            const source = (ref.nodeId ? resolvedLookup.nodeById.get(String(ref.nodeId)) : undefined)
                || (ref.storageKey ? resolvedLookup.byStorageKey.get(String(ref.storageKey)) : undefined)
                || (ref.url ? resolvedLookup.byUrl.get(String(ref.url)) : undefined);
            if (!source || source.id === node.id || seen.has(source.id)) return;
            seen.add(source.id);
            links.push({ id: `${source.id}->${node.id}`, from: source, to: node });
        });
    });
    return links;
}

// 拖动中的节点用预览坐标，保证连线实时跟随，与真实连线行为一致。
function linkPath(from: CanvasNodeData, to: CanvasNodeData, fromPosition?: Position, toPosition?: Position) {
    const resolvedFromPosition = fromPosition || from.position;
    const resolvedToPosition = toPosition || to.position;
    const startX = resolvedFromPosition.x + from.width;
    const startY = resolvedFromPosition.y + from.height / 2;
    const endX = resolvedToPosition.x;
    const endY = resolvedToPosition.y + to.height / 2;
    const curvature = Math.max(Math.abs(endX - startX) * 0.5, 50);
    return `M ${startX} ${startY} C ${startX + curvature} ${startY}, ${endX - curvature} ${endY}, ${endX} ${endY}`;
}

// 当前 Clip 参考图的来源连线：区别于真实连线，用虚线且不参与交互。
const H3RefLinkPath = memo(function H3RefLinkPath({ projectId, link, theme, active }: { projectId: string; link: H3RefLink; theme: CanvasTheme; active: boolean }) {
    const { fromPosition, toPosition } = useCanvasDragPreviewPair(projectId, link.from.id, link.to.id);
    const strokeStyle = connectionStrokeStyle(theme, active);
    return <path d={linkPath(link.from, link.to, fromPosition, toPosition)} fill="none" {...strokeStyle} style={{ ...strokeStyle.style, pointerEvents: "none" }} />;
});

export const CanvasH3RefLinks = memo(function CanvasH3RefLinks({ projectId, nodes, visibleNodes, selectedNodeIds }: { projectId: string; nodes: CanvasNodeData[]; visibleNodes?: CanvasNodeData[]; selectedNodeIds?: ReadonlySet<string> }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const targetNodes = visibleNodes || nodes;
    const sourceLookup = useMemo(() => buildH3RefLookup(nodes), [nodes]);
    const h3NodeIds = useMemo(() => targetNodes.filter(isH3Node).map((node) => node.id), [targetNodes]);
    const subscribe = useCallback((listener: () => void) => {
        const releases = h3NodeIds.map((nodeId) => getPluginNodeView(projectId, nodeId).subscribe(listener));
        return () => releases.forEach((release) => release());
    }, [h3NodeIds, projectId]);
    const getLocalSelections = useCallback(() => h3NodeIds.map((nodeId) => String(getPluginNodeView(projectId, nodeId).getSnapshot().selectedSegmentId || "")).join("\0"), [h3NodeIds, projectId]);
    const localSelections = useSyncExternalStore(subscribe, getLocalSelections, getLocalSelections);
    const links = useMemo(() => collectH3RefLinks(targetNodes, (node) => getPluginNodeView(projectId, node.id).getSnapshot().selectedSegmentId, undefined, sourceLookup), [localSelections, projectId, sourceLookup, targetNodes]);
    if (!links.length) return null;

    return (
        <g style={{ pointerEvents: "none" }}>
            {links.map((link) => {
                // 与真实连线同一套规则：选中 H3 节点（或参考图节点）时这条引用关系也走强调色。
                return (
                    <H3RefLinkPath
                        key={link.id}
                        projectId={projectId}
                        link={link}
                        theme={theme}
                        active={Boolean(selectedNodeIds?.has(link.to.id) || selectedNodeIds?.has(link.from.id))}
                    />
                );
            })}
        </g>
    );
});
