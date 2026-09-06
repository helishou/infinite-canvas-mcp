import { useEffect, useRef, useState, useCallback } from "react";

type WorkflowJson = Record<string, { class_type?: string; inputs?: Record<string, unknown> }>;
type WorkflowField = { id: string; node: string; input: string; name: string; type: string };

type GraphNode = {
    id: string;
    classType: string;
    label: string;
    inputs: Record<string, unknown>;
    layer: number;
    x: number;
    y: number;
    hasExposed: boolean;
    exposedCount: number;
};

type GraphEdge = {
    from: string;
    to: string;
    fromX: number;
    fromY: number;
    toX: number;
    toY: number;
};

type GraphLayout = {
    nodes: GraphNode[];
    edges: GraphEdge[];
    width: number;
    height: number;
};

const NODE_W = 140;
const NODE_H = 56;
const X_GAP = 40;
const Y_GAP = 16;

function topologicalLayers(workflow: WorkflowJson): Map<string, number> {
    const layers = new Map<string, number>();
    const incoming = new Map<string, Set<string>>();

    // 初始化：incoming[id] = id 的上游节点集合（入边）
    for (const [id, node] of Object.entries(workflow)) {
        if (!incoming.has(id)) incoming.set(id, new Set());
        const inputs = node.inputs || {};
        for (const v of Object.values(inputs)) {
            // v = [from_node_id, slot]：当前 id 的输入来自 v[0]
            if (Array.isArray(v) && v.length === 2 && typeof v[0] === "string" && workflow[v[0]]) {
                // v[0] 是 id 的上游
                incoming.get(id)!.add(v[0]);
            }
        }
    }

    const queue: string[] = [];
    for (const [id, deps] of incoming) {
        if (deps.size === 0) {
            layers.set(id, 0);
            queue.push(id);
        }
    }

    while (queue.length > 0) {
        const id = queue.shift()!;
        const layer = layers.get(id)!;
        for (const [targetId, deps] of incoming) {
            if (deps.has(id)) {
                deps.delete(id);
                const newLayer = layer + 1;
                if (!layers.has(targetId) || layers.get(targetId)! < newLayer) {
                    layers.set(targetId, newLayer);
                }
                if (deps.size === 0) {
                    queue.push(targetId);
                }
            }
        }
    }

    for (const id of Object.keys(workflow)) {
        if (!layers.has(id)) layers.set(id, 0);
    }

    return layers;
}

function computeGraphLayout(
    workflow: WorkflowJson,
    fields: WorkflowField[]
): GraphLayout {
    const layers = topologicalLayers(workflow);
    const exposedCounts = new Map<string, number>();
    for (const f of fields) {
        exposedCounts.set(f.node, (exposedCounts.get(f.node) || 0) + 1);
    }

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
            const x = lv * (NODE_W + X_GAP) + 20;
            const y = idx * (NODE_H + Y_GAP) + 20;
            positions.set(id, { x, y });
            const node = workflow[id];
            const classType = node.class_type || "";
            const label = classType.length > 14 ? classType.slice(0, 14) + "…" : classType;
            const exposedCount = exposedCounts.get(id) || 0;
            nodes.push({
                id,
                classType,
                label,
                inputs: node.inputs || {},
                layer: lv,
                x,
                y,
                hasExposed: exposedCount > 0,
                exposedCount,
            });
        });
        maxRows = Math.max(maxRows, ids.length);
    }

    const totalW = sortedLevels.length * (NODE_W + X_GAP) + 40;
    const totalH = maxRows * (NODE_H + Y_GAP) + 40;

    const edges: GraphEdge[] = [];
    for (const [toId, node] of Object.entries(workflow)) {
        const inputs = node.inputs || {};
        const seen = new Set<string>();
        for (const v of Object.values(inputs)) {
            if (Array.isArray(v) && v.length === 2 && typeof v[0] === "string" && positions.has(v[0])) {
                const fromId = v[0];
                if (seen.has(fromId)) continue;
                seen.add(fromId);
                const from = positions.get(fromId)!;
                const to = positions.get(toId)!;
                edges.push({
                    from: fromId,
                    to: toId,
                    fromX: from.x + NODE_W,
                    fromY: from.y + NODE_H / 2,
                    toX: to.x,
                    toY: to.y + NODE_H / 2,
                });
            }
        }
    }

    return { nodes, edges, width: totalW, height: totalH };
}

type Props = {
    workflow: WorkflowJson;
    fields: WorkflowField[];
    onNodeClick?: (nodeId: string) => void;
};

export function WorkflowGraphPanel({ workflow, fields, onNodeClick }: Props) {
    const svgRef = useRef<SVGSVGElement>(null);
    const wrapRef = useRef<HTMLDivElement>(null);
    const [view, setView] = useState({ k: 1, x: 0, y: 0 });
    const [layout, setLayout] = useState<GraphLayout | null>(null);
    const [activeNodeId, setActiveNodeId] = useState<string | null>(null);
    const panRef = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);

    useEffect(() => {
        if (!workflow || Object.keys(workflow).length === 0) {
            setLayout(null);
            return;
        }
        try {
            const l = computeGraphLayout(workflow, fields);
            setLayout(l);
            setView({ k: 1, x: 0, y: 0 });
            setActiveNodeId(null);
        } catch {
            setLayout(null);
        }
    }, [workflow, fields]);

    const fitToView = useCallback(() => {
        if (!layout || !wrapRef.current) return;
        const wrap = wrapRef.current;
        const pad = 20;
        const kx = (wrap.clientWidth - pad * 2) / layout.width;
        const ky = (wrap.clientHeight - pad * 2) / layout.height;
        const k = Math.max(0.2, Math.min(2, Math.min(kx, ky)));
        setView({
            k,
            x: (wrap.clientWidth - layout.width * k) / 2,
            y: (wrap.clientHeight - layout.height * k) / 2,
        });
    }, [layout]);

    const handleWheel = useCallback(
        (e: React.WheelEvent) => {
            if (!layout) return;
            e.preventDefault();
            const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
            const newK = Math.max(0.2, Math.min(3, view.k * factor));
            const wrap = wrapRef.current!;
            const rect = wrap.getBoundingClientRect();
            const mx = e.clientX - rect.left;
            const my = e.clientY - rect.top;
            setView({
                k: newK,
                x: mx - (mx - view.x) * (newK / view.k),
                y: my - (my - view.y) * (newK / view.k),
            });
        },
        [view, layout]
    );

    const handleMouseDown = useCallback(
        (e: React.MouseEvent) => {
            if ((e.target as Element).closest(".gnode")) return;
            panRef.current = { sx: e.clientX, sy: e.clientY, ox: view.x, oy: view.y };
            (e.currentTarget as HTMLElement).classList.add("is-panning");
        },
        [view]
    );

    const handleMouseMove = useCallback(
        (e: React.MouseEvent) => {
            const pan = panRef.current;
            if (!pan) return;
            setView((v) => ({
                ...v,
                x: pan.ox + (e.clientX - pan.sx),
                y: pan.oy + (e.clientY - pan.sy),
            }));
        },
        []
    );

    const handleMouseUp = useCallback((e: React.MouseEvent) => {
        panRef.current = null;
        (e.currentTarget as HTMLElement).classList.remove("is-panning");
    }, []);

    if (!layout || layout.nodes.length === 0) {
        return (
            <div className="flex h-64 items-center justify-center text-sm text-stone-400">
                无可视化节点
            </div>
        );
    }

    return (
        <div className="relative h-full">
            <div className="absolute right-2 top-2 z-10 flex gap-1">
                <button
                    onClick={() => setView((v) => ({ ...v, k: Math.min(3, v.k * 1.2) }))}
                    className="rounded bg-white/80 px-2 py-1 text-xs shadow hover:bg-white"
                >
                    +
                </button>
                <button
                    onClick={() => setView((v) => ({ ...v, k: Math.max(0.2, v.k / 1.2) }))}
                    className="rounded bg-white/80 px-2 py-1 text-xs shadow hover:bg-white"
                >
                    −
                </button>
                <button
                    onClick={fitToView}
                    className="rounded bg-white/80 px-2 py-1 text-xs shadow hover:bg-white"
                >
                    适应
                </button>
                <span className="rounded bg-white/80 px-2 py-1 text-xs shadow">
                    {Math.round(view.k * 100)}%
                </span>
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
                <svg ref={svgRef} className="h-full w-full">
                    <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
                        {layout.edges.map((edge, i) => {
                            const cx = (edge.fromX + edge.toX) / 2;
                            return (
                                <path
                                    key={i}
                                    d={`M ${edge.fromX} ${edge.fromY} C ${cx} ${edge.fromY}, ${cx} ${edge.toY}, ${edge.toX} ${edge.toY}`}
                                    fill="none"
                                    stroke="#94a3b8"
                                    strokeWidth={1.5}
                                />
                            );
                        })}
                        {layout.nodes.map((node) => (
                            <g
                                key={node.id}
                                className={`gnode ${node.hasExposed ? "has-exposed" : ""} ${activeNodeId === node.id ? "is-active" : ""}`}
                                transform={`translate(${node.x},${node.y})`}
                                onClick={() => {
                                    setActiveNodeId(node.id);
                                    onNodeClick?.(node.id);
                                }}
                                style={{ cursor: "pointer" }}
                            >
                                <rect
                                    width={NODE_W}
                                    height={NODE_H}
                                    rx={8}
                                    fill={node.hasExposed ? "#dbeafe" : "#ffffff"}
                                    stroke={activeNodeId === node.id ? "#3b82f6" : node.hasExposed ? "#60a5fa" : "#d1d5db"}
                                    strokeWidth={activeNodeId === node.id ? 2 : 1}
                                />
                                <text x={10} y={20} fontSize={11} fill="#1e293b" fontWeight={600}>
                                    {node.label}
                                </text>
                                <text x={10} y={38} fontSize={9} fill="#64748b">
                                    #{node.id}
                                </text>
                                {node.exposedCount > 0 && (
                                    <text x={NODE_W - 8} y={42} fontSize={9} textAnchor="end" fill="#2563eb" fontWeight={500}>
                                        {node.exposedCount} 字段
                                    </text>
                                )}
                            </g>
                        ))}
                    </g>
                </svg>
            </div>

            {activeNodeId && workflow[activeNodeId] && (
                <NodePopup
                    nodeId={activeNodeId}
                    node={workflow[activeNodeId]}
                    fields={fields.filter((f) => f.node === activeNodeId)}
                    onClose={() => setActiveNodeId(null)}
                />
            )}
        </div>
    );
}

function NodePopup({
    nodeId,
    node,
    fields,
    onClose,
}: {
    nodeId: string;
    node: { class_type?: string; inputs?: Record<string, unknown> };
    fields: WorkflowField[];
    onClose: () => void;
}) {
    const inputs = Object.entries(node.inputs || {}).filter(
        ([, v]) => !(Array.isArray(v) && v.length === 2 && typeof v[0] === "string")
    );

    return (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/20" onClick={onClose}>
            <div
                className="w-80 rounded-lg border border-stone-200 bg-white p-4 shadow-xl dark:border-stone-700 dark:bg-stone-800"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="mb-3 flex items-center justify-between">
                    <div>
                        <div className="font-medium">{node.class_type || "Unknown"}</div>
                        <div className="text-xs text-stone-500">#{nodeId}</div>
                    </div>
                    <button onClick={onClose} className="text-stone-400 hover:text-stone-600">
                        ✕
                    </button>
                </div>
                {fields.length > 0 && (
                    <div className="mb-2 border-b border-stone-100 pb-2">
                        <div className="mb-1 text-xs font-medium text-blue-600">已映射字段</div>
                        {fields.map((f) => (
                            <div key={f.id} className="flex items-center justify-between text-xs">
                                <span className="text-stone-600">{f.name}</span>
                                <span className="text-stone-400">{f.input}</span>
                            </div>
                        ))}
                    </div>
                )}
                <div className="max-h-40 overflow-y-auto">
                    {inputs.length === 0 ? (
                        <div className="text-xs text-stone-400">无配置输入</div>
                    ) : (
                        inputs.map(([key, value]) => (
                            <div key={key} className="flex items-center justify-between border-b border-stone-50 py-1 text-xs">
                                <span className="text-stone-600">{key}</span>
                                <span className="max-w-32 truncate text-stone-400">
                                    {typeof value === "object" ? JSON.stringify(value) : String(value)}
                                </span>
                            </div>
                        ))
                    )}
                </div>
            </div>
        </div>
    );
}
