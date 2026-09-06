import { useEffect, useRef, useState, useCallback } from "react";
import type { WorkflowField } from "@/types/workflow";

type WorkflowJson = Record<string, { class_type?: string; inputs?: Record<string, unknown> }>;

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
    for (const [id, node] of Object.entries(workflow)) {
        if (!incoming.has(id)) incoming.set(id, new Set());
        for (const v of Object.values(node.inputs || {})) {
            if (Array.isArray(v) && v.length === 2 && typeof v[0] === "string" && workflow[v[0]]) {
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

function computeGraphLayout(workflow: WorkflowJson, fields: WorkflowField[]): GraphLayout {
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

    const totalW = sortedLevels.length * (NODE_W + X_GAP) + 40;
    const totalH = maxRows * (NODE_H + Y_GAP) + 40;

    const edges: GraphEdge[] = [];
    for (const [toId, node] of Object.entries(workflow)) {
        const seen = new Set<string>();
        for (const v of Object.values(node.inputs || {})) {
            if (Array.isArray(v) && v.length === 2 && typeof v[0] === "string" && positions.has(v[0])) {
                if (seen.has(v[0])) continue;
                seen.add(v[0]);
                const from = positions.get(v[0])!;
                const to = positions.get(toId)!;
                edges.push({ from: v[0], to: toId, fromX: from.x + NODE_W, fromY: from.y + NODE_H / 2, toX: to.x, toY: to.y + NODE_H / 2 });
            }
        }
    }

    return { nodes, edges, width: totalW, height: totalH };
}

// --- 类型猜测 ---
function guessType(rawValue: unknown, inputName: string): WorkflowField["type"] {
    const lc = (inputName || "").toLowerCase();
    if (typeof rawValue === "boolean") return "boolean";
    if (typeof rawValue === "number") {
        if (/strength|cfg|denoise|scale/.test(lc)) return "slider";
        return "number";
    }
    if (typeof rawValue === "string") {
        if (/prompt|text|description/.test(lc) || (rawValue && rawValue.length > 60)) return "text";
        if (/image|img|mask|filename|file/.test(lc) || /\.(png|jpe?g|webp|gif|bmp)/i.test(rawValue)) return "image";
        if (/video|movie|mp4/.test(lc)) return "text" as any;
        return "text";
    }
    return "text";
}

function friendlyInputName(key: string): string {
    return key.replace(/_/g, " ").replace(/([A-Z])/g, " $1").replace(/^./, s => s.toUpperCase());
}

type Props = {
    workflow: WorkflowJson;
    fields: WorkflowField[];
    onFieldsChange: (fields: WorkflowField[]) => void;
};

export function WorkflowGraphPanel({ workflow, fields, onFieldsChange }: Props) {
    const svgRef = useRef<SVGSVGElement>(null);
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

    // --- Pan & Zoom ---
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

    // --- 字段操作 ---
    const toggleField = (nodeId: string, inputKey: string, rawValue: unknown) => {
        const existing = fields.find(f => f.node === nodeId && f.input === inputKey);
        if (existing) {
            onFieldsChange(fields.filter(f => f !== existing));
        } else {
            const type = guessType(rawValue, inputKey);
            const newField: WorkflowField = {
                id: `f_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                node: nodeId,
                input: inputKey,
                name: friendlyInputName(inputKey),
                type,
                default: typeof rawValue === "object" ? null : rawValue as any,
            };
            if (type === "number" || type === "slider") {
                if (typeof rawValue === "number") {
                    newField.min = 0;
                    newField.max = Math.max(rawValue * 2, 10);
                    newField.step = rawValue > 0 && rawValue < 5 ? 0.1 : 1;
                }
                if (type === "number") newField.randomEnabled = false;
            }
            if (type === "dropdown") newField.options = [];
            onFieldsChange([...fields, newField]);
        }
    };

    const updateField = (fieldId: string, updates: Partial<WorkflowField>) => {
        onFieldsChange(fields.map(f => f.id === fieldId ? { ...f, ...updates } : f));
    };

    const removeField = (fieldId: string) => {
        onFieldsChange(fields.filter(f => f.id !== fieldId));
    };

    if (!layout || layout.nodes.length === 0) {
        return <div className="flex h-64 items-center justify-center text-sm text-stone-400">无可视化节点</div>;
    }

    const popupNode = popupNodeId ? workflow[popupNodeId] : null;

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
                <svg ref={svgRef} className="h-full w-full">
                    <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
                        {layout.edges.map((edge, i) => {
                            const cx = (edge.fromX + edge.toX) / 2;
                            return <path key={i} d={`M ${edge.fromX} ${edge.fromY} C ${cx} ${edge.fromY}, ${cx} ${edge.toY}, ${edge.toX} ${edge.toY}`} fill="none" stroke="#94a3b8" strokeWidth={1.5} />;
                        })}
                        {layout.nodes.map((node) => (
                            <g
                                key={node.id}
                                className={`gnode ${node.hasExposed ? "has-exposed" : ""} ${popupNodeId === node.id ? "is-active" : ""}`}
                                transform={`translate(${node.x},${node.y})`}
                                onClick={() => setPopupNodeId(popupNodeId === node.id ? null : node.id)}
                                style={{ cursor: "pointer" }}
                            >
                                <rect width={NODE_W} height={NODE_H} rx={8} fill={node.hasExposed ? "#dbeafe" : "#ffffff"} stroke={popupNodeId === node.id ? "#3b82f6" : node.hasExposed ? "#60a5fa" : "#d1d5db"} strokeWidth={popupNodeId === node.id ? 2 : 1} />
                                <text x={10} y={20} fontSize={11} fill="#1e293b" fontWeight={600}>{node.label}</text>
                                <text x={10} y={38} fontSize={9} fill="#64748b">#{node.id}</text>
                                {node.exposedCount > 0 && <text x={NODE_W - 8} y={42} fontSize={9} textAnchor="end" fill="#2563eb" fontWeight={500}>{node.exposedCount} 字段</text>}
                            </g>
                        ))}
                    </g>
                </svg>
            </div>

            {/* 节点浮窗 - 内联字段配置 */}
            {popupNode && popupNodeId && (
                <NodeFieldPopup
                    nodeId={popupNodeId}
                    node={popupNode}
                    fields={fields.filter(f => f.node === popupNodeId)}
                    onToggleField={(inputKey) => toggleField(popupNodeId, inputKey, popupNode.inputs?.[inputKey])}
                    onUpdateField={updateField}
                    onRemoveField={removeField}
                    onClose={() => setPopupNodeId(null)}
                />
            )}
        </div>
    );
}

// ─── 浮窗组件 ───
function NodeFieldPopup({
    nodeId, node, fields, onToggleField, onUpdateField, onRemoveField, onClose,
}: {
    nodeId: string;
    node: { class_type?: string; inputs?: Record<string, unknown> };
    fields: WorkflowField[];
    onToggleField: (inputKey: string) => void;
    onUpdateField: (fieldId: string, updates: Partial<WorkflowField>) => void;
    onRemoveField: (fieldId: string) => void;
    onClose: () => void;
}) {
    // 只显示非连接型输入（连接型是 [nodeId, slot] 数组）
    const inputs = Object.entries(node.inputs || {}).filter(
        ([, v]) => !(Array.isArray(v) && v.length === 2 && typeof v[0] === "string")
    );

    const fieldMap = new Map(fields.map(f => [f.input, f]));

    return (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/20" onClick={onClose}>
            <div
                className="w-[380px] max-h-[70vh] overflow-y-auto rounded-lg border border-stone-200 bg-white p-4 shadow-xl dark:border-stone-700 dark:bg-stone-800"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="mb-3 flex items-center justify-between border-b border-stone-100 pb-2">
                    <div>
                        <div className="font-medium">{node.class_type || "Unknown"}</div>
                        <div className="text-xs text-stone-500">#{nodeId}</div>
                    </div>
                    <button onClick={onClose} className="text-stone-400 hover:text-stone-600 text-xl leading-none">×</button>
                </div>

                {inputs.length === 0 ? (
                    <div className="py-4 text-center text-xs text-stone-400">无可配置输入</div>
                ) : (
                    <div className="space-y-2">
                        {inputs.map(([key, rawValue]) => {
                            const field = fieldMap.get(key);
                            const active = !!field;
                            return (
                                <InputRow
                                    key={key}
                                    inputKey={key}
                                    rawValue={rawValue}
                                    field={field}
                                    active={active}
                                    onToggle={() => onToggleField(key)}
                                    onUpdate={(u) => field && onUpdateField(field.id, u)}
                                    onRemove={() => field && onRemoveField(field.id)}
                                />
                            );
                        })}
                    </div>
                )}
            </div>
        </div>
    );
}

function InputRow({
    inputKey, rawValue, field, active, onToggle, onUpdate, onRemove,
}: {
    inputKey: string;
    rawValue: unknown;
    field?: WorkflowField;
    active: boolean;
    onToggle: () => void;
    onUpdate: (u: Partial<WorkflowField>) => void;
    onRemove: () => void;
}) {
    const friendlyName = friendlyInputName(inputKey);

    const valueBadge = (() => {
        if (typeof rawValue === "string") {
            const s = rawValue.length > 50 ? rawValue.slice(0, 50) + "…" : rawValue;
            return <span className="text-[11px] font-mono text-stone-600">"{s}"</span>;
        }
        if (typeof rawValue === "number") return <span className="text-[11px] font-mono font-bold text-blue-700">{rawValue}</span>;
        if (typeof rawValue === "boolean") return <span className={`text-[11px] font-bold ${rawValue ? "text-green-700" : "text-amber-700"}`}>{rawValue ? "✓ true" : "✗ false"}</span>;
        return <span className="text-[11px] text-stone-400">{String(rawValue)}</span>;
    })();

    return (
        <div className={`rounded border p-2 text-xs ${active ? "border-blue-300 bg-blue-50/50 dark:border-blue-700 dark:bg-blue-900/20" : "border-stone-200 dark:border-stone-700"}`}>
            {/* 复选框 + input name + value */}
            <div className="flex items-center gap-2">
                <button
                    onClick={onToggle}
                    className={`size-4 shrink-0 rounded border flex items-center justify-center transition ${active ? "bg-blue-500 border-blue-500 text-white" : "border-stone-300 dark:border-stone-600"}`}
                >
                    {active && <span className="text-[10px] leading-none">✓</span>}
                </button>
                <div className="flex-1 min-w-0">
                    <div className="font-medium truncate">{friendlyName}</div>
                    <div className="text-[10px] text-stone-400 truncate">默认: {valueBadge}</div>
                </div>
                {active && (
                    <button onClick={onRemove} className="text-red-400 hover:text-red-600 shrink-0">
                        <span className="text-sm">×</span>
                    </button>
                )}
            </div>

            {/* 编辑区 */}
            {active && field && (
                <div className="mt-2 space-y-2 border-t border-stone-200/50 pt-2">
                    {/* 显示名 */}
                    <div>
                        <label className="mb-0.5 block text-[10px] text-stone-500">显示名</label>
                        <input
                            value={field.name || ""}
                            onChange={(e) => onUpdate({ name: e.target.value })}
                            className="w-full rounded border border-stone-200 px-2 py-1 text-xs dark:border-stone-700 dark:bg-stone-900"
                            placeholder={friendlyName}
                        />
                    </div>

                    {/* 类型 */}
                    <div>
                        <label className="mb-0.5 block text-[10px] text-stone-500">类型</label>
                        <select
                            value={field.type}
                            onChange={(e) => {
                                const type = e.target.value as WorkflowField["type"];
                                const updates: Partial<WorkflowField> = { type };
                                if (type === "number" || type === "slider") {
                                    if (typeof rawValue === "number") {
                                        updates.min = 0;
                                        updates.max = Math.max(rawValue * 2, 10);
                                        updates.step = rawValue > 0 && rawValue < 5 ? 0.1 : 1;
                                    }
                                    updates.randomEnabled = type === "number" ? false : undefined;
                                } else if (type === "dropdown") {
                                    updates.options = field.options || [];
                                } else {
                                    updates.randomEnabled = undefined;
                                    updates.min = undefined;
                                    updates.max = undefined;
                                    updates.step = undefined;
                                }
                                onUpdate(updates);
                            }}
                            className="w-full rounded border border-stone-200 px-2 py-1 text-xs dark:border-stone-700 dark:bg-stone-900"
                        >
                            {["text", "number", "slider", "boolean", "dropdown", "image"].map(t => (
                                <option key={t} value={t}>{t === "text" ? "文本" : t === "number" ? "数字" : t === "slider" ? "滑块" : t === "boolean" ? "布尔" : t === "dropdown" ? "下拉" : "图片"}</option>
                            ))}
                        </select>
                    </div>

                    {/* 数字/滑块的 min/max/step/default */}
                    {(field.type === "number" || field.type === "slider") && (
                        <div className="grid grid-cols-2 gap-2">
                            <div>
                                <label className="mb-0.5 block text-[10px] text-stone-500">最小值</label>
                                <input type="number" value={field.min ?? ""} onChange={(e) => onUpdate({ min: e.target.value === "" ? undefined : parseFloat(e.target.value) })} className="w-full rounded border border-stone-200 px-2 py-1 text-xs dark:border-stone-700 dark:bg-stone-900" />
                            </div>
                            <div>
                                <label className="mb-0.5 block text-[10px] text-stone-500">最大值</label>
                                <input type="number" value={field.max ?? ""} onChange={(e) => onUpdate({ max: e.target.value === "" ? undefined : parseFloat(e.target.value) })} className="w-full rounded border border-stone-200 px-2 py-1 text-xs dark:border-stone-700 dark:bg-stone-900" />
                            </div>
                            <div>
                                <label className="mb-0.5 block text-[10px] text-stone-500">步长</label>
                                <input type="number" value={field.step ?? ""} onChange={(e) => onUpdate({ step: e.target.value === "" ? undefined : parseFloat(e.target.value) })} className="w-full rounded border border-stone-200 px-2 py-1 text-xs dark:border-stone-700 dark:bg-stone-900" />
                            </div>
                            <div>
                                <label className="mb-0.5 block text-[10px] text-stone-500">默认值</label>
                                <input type="number" value={field.default as number ?? ""} onChange={(e) => onUpdate({ default: e.target.value === "" ? undefined : parseFloat(e.target.value) })} className="w-full rounded border border-stone-200 px-2 py-1 text-xs dark:border-stone-700 dark:bg-stone-900" />
                            </div>
                        </div>
                    )}

                    {/* 数字类型随机开关 */}
                    {field.type === "number" && (
                        <label className="flex items-center gap-2 cursor-pointer">
                            <input type="checkbox" checked={!!field.randomEnabled} onChange={(e) => onUpdate({ randomEnabled: e.target.checked })} className="size-3" />
                            <span className="text-[11px]">允许随机值</span>
                        </label>
                    )}

                    {/* 默认值（非数字非下拉非图片） */}
                    {field.type !== "number" && field.type !== "slider" && field.type !== "image" && field.type !== "dropdown" && (
                        <div>
                            <label className="mb-0.5 block text-[10px] text-stone-500">默认值</label>
                            {field.type === "boolean" ? (
                                <select
                                    value={String(field.default ?? "")}
                                    onChange={(e) => onUpdate({ default: e.target.value === "true" })}
                                    className="w-full rounded border border-stone-200 px-2 py-1 text-xs dark:border-stone-700 dark:bg-stone-900"
                                >
                                    <option value="true">true</option>
                                    <option value="false">false</option>
                                </select>
                            ) : (
                                <input
                                    value={String(field.default ?? "")}
                                    onChange={(e) => onUpdate({ default: e.target.value })}
                                    className="w-full rounded border border-stone-200 px-2 py-1 text-xs dark:border-stone-700 dark:bg-stone-900"
                                />
                            )}
                        </div>
                    )}

                    {/* 图片类型 */}
                    {field.type === "image" && (
                        <div>
                            <label className="mb-0.5 block text-[10px] text-stone-500">默认图片 URL（可选）</label>
                            <input
                                value={String(field.default ?? "")}
                                onChange={(e) => onUpdate({ default: e.target.value })}
                                className="w-full rounded border border-stone-200 px-2 py-1 text-xs dark:border-stone-700 dark:bg-stone-900"
                                placeholder="http://..."
                            />
                        </div>
                    )}

                    {/* 下拉选项 */}
                    {field.type === "dropdown" && (
                        <div>
                            <label className="mb-1 block text-[10px] text-stone-500">选项列表</label>
                            <div className="space-y-1">
                                {(field.options || []).map((opt, i) => (
                                    <div key={i} className="flex items-center gap-1">
                                        <input
                                            value={opt}
                                            onChange={(e) => {
                                                const newOpts = [...(field.options || [])];
                                                newOpts[i] = e.target.value;
                                                onUpdate({ options: newOpts });
                                            }}
                                            className="flex-1 rounded border border-stone-200 px-2 py-1 text-xs dark:border-stone-700 dark:bg-stone-900"
                                        />
                                        <button onClick={() => onUpdate({ options: (field.options || []).filter((_, j) => j !== i) })} className="text-red-400 hover:text-red-600 text-xs">×</button>
                                    </div>
                                ))}
                            </div>
                            <button
                                onClick={() => onUpdate({ options: [...(field.options || []), ""] })}
                                className="mt-1 rounded border border-dashed border-stone-300 px-3 py-1 text-[11px] hover:border-stone-400 dark:border-stone-600"
                            >
                                + 添加选项
                            </button>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
