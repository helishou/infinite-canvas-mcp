import { useState } from "react";
import { Button, Checkbox, Empty } from "antd";
import type { WorkflowGraphJson } from "./workflow-graph-view";

/** 能产出文件的节点类型。选节点比选类型更准，但先按类型给出候选，减少无关项。 */
const OUTPUT_CLASS_HINTS = /Save|Preview|VHS|VideoCombine|ImageSave|Export/i;

type Candidate = { nodeId: string; label: string; classType: string };

function outputCandidates(graph: WorkflowGraphJson, excludeSaveImageToLocal: boolean): Candidate[] {
    return Object.entries(graph || {}).map(([nodeId, node]) => ({
        nodeId,
        classType: node?.class_type || "",
        label: String((node as { _meta?: { title?: string } })?._meta?.title || node?.class_type || nodeId),
    })).filter((item) => {
        if (excludeSaveImageToLocal && item.classType.toLowerCase() === "saveimagetolocal") return false;
        return OUTPUT_CLASS_HINTS.test(item.classType) || OUTPUT_CLASS_HINTS.test(item.label);
    });
}

export function normalizeOutputNodeSelection(value: string[], graph: WorkflowGraphJson, excludeSaveImageToLocal = false) {
    const available = new Set(outputCandidates(graph, excludeSaveImageToLocal).map((item) => item.nodeId));
    return value.filter((nodeId) => available.has(nodeId));
}

/** 连线来源节点：API 格式里就是 `[nodeId, slot]`。 */
function linkSource(value: unknown): string {
    return Array.isArray(value) && typeof value[0] === "string" ? value[0] : "";
}

/**
 * 每个节点到根的最长路径长度，等价于 UI 格式里的 `order`。
 * 一张图常有好几个输出节点（多个 PreviewImage + 一个 SaveImage），只有深度最大的那条是链路末端。
 */
function outputDepths(graph: WorkflowGraphJson): Map<string, number> {
    const depths = new Map<string, number>();
    const visiting = new Set<string>();
    const depthOf = (nodeId: string): number => {
        const cached = depths.get(nodeId);
        if (cached !== undefined) return cached;
        if (visiting.has(nodeId)) return 0; // 环保护
        visiting.add(nodeId);
        const inputs = (graph?.[nodeId] as { inputs?: Record<string, unknown> } | undefined)?.inputs || {};
        let best = 0;
        for (const value of Object.values(inputs)) {
            const from = linkSource(value);
            if (!from || !graph?.[from]) continue;
            best = Math.max(best, depthOf(from) + 1);
        }
        visiting.delete(nodeId);
        depths.set(nodeId, best);
        return best;
    };
    for (const nodeId of Object.keys(graph || {})) depthOf(nodeId);
    return depths;
}

/** id 大小比较：数字优先，非数字退化成字符串比较。 */
function compareNodeId(left: string, right: string): number {
    const a = Number(left);
    const b = Number(right);
    if (Number.isFinite(a) && Number.isFinite(b)) return a - b;
    return left.localeCompare(right);
}

/**
 * 默认勾选的输出节点：链路最末端的那一个（同深度时取编号大的）。
 * 与上传到 RunningHub 时「收尾链接在最后一个输出节点后面」用同一套判定，避免两处各选一个。
 */
export function lastOutputNodeId(graph: WorkflowGraphJson, excludeSaveImageToLocal = false): string {
    const candidates = outputCandidates(graph, excludeSaveImageToLocal);
    if (!candidates.length) return "";
    const depths = outputDepths(graph);
    return [...candidates].sort((left, right) =>
        (depths.get(right.nodeId) ?? 0) - (depths.get(left.nodeId) ?? 0) || compareNodeId(right.nodeId, left.nodeId))[0].nodeId;
}

export function pickerOutputNodeSelection(value: string[], graph: WorkflowGraphJson, excludeSaveImageToLocal = false, touched = false) {
    const normalized = normalizeOutputNodeSelection(value, graph, excludeSaveImageToLocal);
    if (touched || normalized.length) return normalized;
    // 没配置过就默认勾上最后一个有效输出节点；用户手动清空（touched）后不再自动补。
    const last = lastOutputNodeId(graph, excludeSaveImageToLocal);
    return last ? [last] : [];
}

/**
 * 输出节点选择器。只列出看起来会产出文件的节点（Save/Preview/导出类）。
 * 没配置过时默认勾选链路最末端那一个，用户清空后保持清空。
 */
export function OutputNodePicker({
    graph, value, onChange, disabled, title = "输出节点", excludeSaveImageToLocal = false,
}: {
    graph: WorkflowGraphJson;
    value: string[];
    onChange: (next: string[]) => void;
    title?: string;
    disabled?: boolean;
    excludeSaveImageToLocal?: boolean;
}) {
    const [touched, setTouched] = useState(false);
    const candidates = outputCandidates(graph, excludeSaveImageToLocal);
    const normalizedValue = pickerOutputNodeSelection(value, graph, excludeSaveImageToLocal, touched);
    const selected = new Set(normalizedValue);
    const toggle = (nodeId: string, checked: boolean) => {
        const next = checked ? [...normalizedValue, nodeId] : normalizedValue.filter((id) => id !== nodeId);
        setTouched(true);
        onChange(next);
    };
    const clear = () => {
        setTouched(true);
        onChange([]);
    };

    return (
        <div className="rounded-lg border border-border p-3 ">
            <div className="mb-2 flex items-center justify-between gap-2">
                <div>
                    <div className="text-sm font-medium">{title}</div>
                    <p className="text-xs text-muted-foreground">不勾选则保留工作流全部输出；勾选后只归档这些节点的产物。</p>
                </div>
                <div className="flex shrink-0 gap-2">
                    <Button size="small" disabled={disabled || !candidates.length} onClick={() => onChange(candidates.map((c) => c.nodeId))}>全选</Button>
                    <Button size="small" disabled={disabled || !normalizedValue.length} onClick={clear}>清空</Button>
                </div>
            </div>
            {candidates.length === 0 ? (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="这个工作流里没找到 Save/Preview 类输出节点" />
            ) : (
                <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                    {candidates.map((item) => (
                        <label key={item.nodeId} className="flex min-w-0 items-center gap-2 py-1 text-xs">
                            <Checkbox disabled={disabled} checked={selected.has(item.nodeId)} onChange={(event) => toggle(item.nodeId, event.target.checked)} />
                            <span className="truncate" title={`${item.label} #${item.nodeId}`}>{item.label}</span>
                            <span className="shrink-0 text-muted-foreground">#{item.nodeId}</span>
                        </label>
                    ))}
                </div>
            )}
            {normalizedValue.length > 0 && (
                <div className="mt-2 text-xs text-muted-foreground">已选节点：{normalizedValue.join("、")}</div>
            )}
        </div>
    );
}
