import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

/** API 格式工作流：节点 ID → 节点定义。本地 ComfyUI JSON 与 RunningHub 同形。 */
export type WorkflowGraphJson = Record<string, { class_type?: string; inputs?: Record<string, unknown> }>;

/** 节点图上标「已暴露字段数」用的最小形状，调用方传任何含 node 的字段数组即可。 */
export type GraphFieldRef = { node: string };

type GraphNode = {
    id: string;
    classType: string;
    label: string;
    layer: number;
    x: number;
    y: number;
    hasExposed: boolean;
    exposedCount: number;
};

type GraphEdge = {
    fromX: number;
    fromY: number;
    toX: number;
    toY: number;
};

export type GraphLayout = {
    nodes: GraphNode[];
    edges: GraphEdge[];
    width: number;
    height: number;
};

const NODE_W = 140;
const NODE_H = 56;
const X_GAP = 40;
const Y_GAP = 16;

/** 连线型输入在 API 格式里是 ["节点ID", 端口序号]，不能当可填写字段。 */
export function isGraphLinkValue(value: unknown): value is [string, number] {
    return Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && typeof value[1] === "number";
}

function topologicalLayers(workflow: WorkflowGraphJson): Map<string, number> {
    const layers = new Map<string, number>();
    const incoming = new Map<string, Set<string>>();
    for (const [id, node] of Object.entries(workflow)) {
        if (!incoming.has(id)) incoming.set(id, new Set());
        for (const v of Object.values(node.inputs || {})) {
            if (isGraphLinkValue(v) && workflow[v[0]]) {
                incoming.get(id)!.add(v[0]);
            }
        }
    }
    const queue: string[] = [];
    for (const [id, deps] of incoming) {
        if (deps.size === 0) { layers.set(id, 0); queue.push(id); }
    }
    while (queue.length > 0) {
        const id = queue.shift()!;
        const layer = layers.get(id)!;
        for (const [targetId, deps] of incoming) {
            if (deps.has(id)) {
                deps.delete(id);
                const n = layer + 1;
                if (!layers.has(targetId) || layers.get(targetId)! < n) layers.set(targetId, n);
                if (deps.size === 0) queue.push(targetId);
            }
        }
    }
    for (const id of Object.keys(workflow)) if (!layers.has(id)) layers.set(id, 0);
    return layers;
}

/** 拓扑分层 + 按层排布，产出可直接画的节点与连线坐标。 */
export function computeGraphLayout(workflow: WorkflowGraphJson, fields: GraphFieldRef[]): GraphLayout {
    const layers = topologicalLayers(workflow);
    const exposedCounts = new Map<string, number>();
    for (const f of fields) exposedCounts.set(f.node, (exposedCounts.get(f.node) || 0) + 1);

    const buckets = new Map<number, string[]>();
    for (const [id, layer] of layers) {
        if (!buckets.has(layer)) buckets.set(layer, []);
        buckets.get(layer)!.push(id);
    }

    const nodes: GraphNode[] = [];
    const positions = new Map<string, { x: number; y: number }>();
    const sortedLevels = [...buckets.keys()].sort((a, b) => a - b);
    let maxRows = 0;

    for (const lv of sortedLevels) {
        const ids = buckets.get(lv)!.sort((a, b) => parseInt(a) - parseInt(b));
        ids.forEach((id, idx) => {
            positions.set(id, { x: lv * (NODE_W + X_GAP) + 20, y: idx * (NODE_H + Y_GAP) + 20 });
            const node = workflow[id];
            const classType = node.class_type || "";
            const label = classType.length > 14 ? classType.slice(0, 14) + "…" : classType;
            nodes.push({ id, classType, label, layer: lv, x: positions.get(id)!.x, y: positions.get(id)!.y, hasExposed: (exposedCounts.get(id) || 0) > 0, exposedCount: exposedCounts.get(id) || 0 });
        });
        maxRows = Math.max(maxRows, ids.length);
    }

    const edges: GraphEdge[] = [];
    for (const [toId, node] of Object.entries(workflow)) {
        const seen = new Set<string>();
        for (const v of Object.values(node.inputs || {})) {
            if (!isGraphLinkValue(v)) continue;
            const fromId = v[0];
            if (seen.has(fromId) || !positions.has(fromId)) continue;
            seen.add(fromId);
            const from = positions.get(fromId)!;
            const to = positions.get(toId)!;
            edges.push({ fromX: from.x + NODE_W, fromY: from.y + NODE_H / 2, toX: to.x, toY: to.y + NODE_H / 2 });
        }
    }

    return { nodes, edges, width: sortedLevels.length * (NODE_W + X_GAP) + 40, height: maxRows * (NODE_H + Y_GAP) + 40 };
}

type Props = {
    workflow: WorkflowGraphJson;
    /** 用于在节点上标出已暴露字段数；调用方决定什么算「已暴露」。 */
    fields: GraphFieldRef[];
    /** 渲染节点浮窗；close 由本组件持有，浮窗必须通过它关闭，否则选中态无法清除。 */
    renderNodePopup: (nodeId: string, close: () => void) => ReactNode;
};

/**
 * 节点图只读渲染层：拓扑分层、SVG 连线、平移缩放、适应、点击选中节点。
 * 字段如何配置由调用方的 renderNodePopup 决定，本组件不碰任何持久化。
 */
export function WorkflowGraphView({ workflow, fields, renderNodePopup }: Props) {
    const { t } = useTranslation();
    const wrapRef = useRef<HTMLDivElement>(null);
    const [view, setView] = useState({ k: 1, x: 0, y: 0 });
    const [layout, setLayout] = useState<GraphLayout | null>(null);
    const [popupNodeId, setPopupNodeId] = useState<string | null>(null);
    const panRef = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);

    useEffect(() => {
        if (!workflow || Object.keys(workflow).length === 0) { setLayout(null); return; }
        try { setLayout(computeGraphLayout(workflow, fields)); setView({ k: 1, x: 0, y: 0 }); } catch { setLayout(null); }
    }, [workflow, fields]);

    const fitToView = useCallback(() => {
        if (!layout || !wrapRef.current) return;
        const w = wrapRef.current;
        const pad = 20;
        const k = Math.max(0.2, Math.min(2, Math.min((w.clientWidth - pad * 2) / layout.width, (w.clientHeight - pad * 2) / layout.height)));
        setView({ k, x: (w.clientWidth - layout.width * k) / 2, y: (w.clientHeight - layout.height * k) / 2 });
    }, [layout]);

    const handleWheel = useCallback((e: React.WheelEvent) => {
        if (!layout) return;
        e.preventDefault();
        const f = e.deltaY < 0 ? 1.15 : 1 / 1.15;
        const nk = Math.max(0.2, Math.min(3, view.k * f));
        const r = wrapRef.current!.getBoundingClientRect();
        const mx = e.clientX - r.left, my = e.clientY - r.top;
        setView({ k: nk, x: mx - (mx - view.x) * (nk / view.k), y: my - (my - view.y) * (nk / view.k) });
    }, [view, layout]);

    const handleMouseDown = useCallback((e: React.MouseEvent) => {
        if ((e.target as Element).closest(".gnode")) return;
        panRef.current = { sx: e.clientX, sy: e.clientY, ox: view.x, oy: view.y };
        (e.currentTarget as HTMLElement).classList.add("is-panning");
    }, [view]);

    const handleMouseMove = useCallback((e: React.MouseEvent) => {
        const p = panRef.current;
        if (!p) return;
        setView(v => ({ ...v, x: p.ox + (e.clientX - p.sx), y: p.oy + (e.clientY - p.sy) }));
    }, []);

    const handleMouseUp = useCallback((e: React.MouseEvent) => {
        panRef.current = null;
        (e.currentTarget as HTMLElement).classList.remove("is-panning");
    }, []);

    if (!layout || layout.nodes.length === 0) {
        return <div className="flex h-64 items-center justify-center text-sm text-stone-400">无可视化节点</div>;
    }

    return (
        <div className="relative h-full">
            <div className="absolute right-2 top-2 z-10 flex gap-1">
                <button onClick={() => setView(v => ({ ...v, k: Math.min(3, v.k * 1.2) }))} className="rounded bg-white/80 px-2 py-1 text-xs shadow hover:bg-white">+</button>
                <button onClick={() => setView(v => ({ ...v, k: Math.max(0.2, v.k / 1.2) }))} className="rounded bg-white/80 px-2 py-1 text-xs shadow hover:bg-white">−</button>
                <button onClick={fitToView} className="rounded bg-white/80 px-2 py-1 text-xs shadow hover:bg-white">适应</button>
                <span className="rounded bg-white/80 px-2 py-1 text-xs shadow">{Math.round(view.k * 100)}%</span>
            </div>

            <div
                ref={wrapRef}
                className="graph-svg-wrap h-full w-full overflow-hidden rounded border border-stone-200 bg-stone-50 dark:border-stone-700 dark:bg-stone-900"
                onWheel={handleWheel}
                onMouseDown={handleMouseDown}
                onMouseMove={handleMouseMove}
                onMouseUp={handleMouseUp}
                onMouseLeave={handleMouseUp}
            >
                <svg className="h-full w-full">
                    <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
                        {layout.edges.map((edge, i) => {
                            const cx = (edge.fromX + edge.toX) / 2;
                            return <path key={i} d={`M ${edge.fromX} ${edge.fromY} C ${cx} ${edge.fromY}, ${cx} ${edge.toY}, ${edge.toX} ${edge.toY}`} fill="none" stroke="#94a3b8" strokeWidth={1.5} />;
                        })}
                        {layout.nodes.map((node) => (
                            <g
                                key={node.id}
                                className={`gnode ${node.hasExposed ? "has-exposed" : ""} ${popupNodeId === node.id ? "is-active" : ""}`}
                                aria-label={`${node.classType} #${node.id}`}
                                transform={`translate(${node.x},${node.y})`}
                                onClick={() => setPopupNodeId(popupNodeId === node.id ? null : node.id)}
                                style={{ cursor: "pointer" }}
                            >
                                <title>{node.classType} #{node.id}</title>
                                <rect width={NODE_W} height={NODE_H} rx={8} fill={node.hasExposed ? "#dbeafe" : "#ffffff"} stroke={popupNodeId === node.id ? "#3b82f6" : node.hasExposed ? "#60a5fa" : "#d1d5db"} strokeWidth={popupNodeId === node.id ? 2 : 1} />
                                <text x={10} y={20} fontSize={11} fill="#1e293b" fontWeight={600}>{node.classType === "PromptTemplateSuffix" ? t("workflowGraph.promptTemplateSuffix") : node.label}</text>
                                <text x={10} y={38} fontSize={9} fill="#64748b">#{node.id}</text>
                                {node.exposedCount > 0 && <text x={NODE_W - 8} y={42} fontSize={9} textAnchor="end" fill="#2563eb" fontWeight={500}>{node.exposedCount} 字段</text>}
                            </g>
                        ))}
                    </g>
                </svg>
            </div>

            {popupNodeId ? renderNodePopup(popupNodeId, () => setPopupNodeId(null)) : null}
        </div>
    );
}
