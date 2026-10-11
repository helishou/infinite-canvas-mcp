import { Button, Checkbox, Empty } from "antd";
import type { WorkflowGraphJson } from "./workflow-graph-view";

/** 能产出文件的节点类型。选节点比选类型更准，但先按类型给出候选，减少无关项。 */
const OUTPUT_CLASS_HINTS = /Save|Preview|VHS|VideoCombine|ImageSave|Export/i;

type Candidate = { nodeId: string; label: string; classType: string };

function outputCandidates(graph: WorkflowGraphJson): Candidate[] {
    return Object.entries(graph || {}).map(([nodeId, node]) => ({
        nodeId,
        classType: node?.class_type || "",
        label: String((node as { _meta?: { title?: string } })?._meta?.title || node?.class_type || nodeId),
    })).filter((item) => OUTPUT_CLASS_HINTS.test(item.classType) || OUTPUT_CLASS_HINTS.test(item.label));
}

export function normalizeOutputNodeSelection(value: string[], graph: WorkflowGraphJson) {
    const available = new Set(outputCandidates(graph).map((item) => item.nodeId));
    return value.filter((nodeId) => available.has(nodeId));
}

/**
 * 输出节点选择器。只列出看起来会产出文件的节点（Save/Preview/导出类），
 * 未指定时保持不过滤，因此这里默认全不选而不是默认全选。
 */
export function OutputNodePicker({
    graph, value, onChange, title = "输出节点",
}: {
    graph: WorkflowGraphJson;
    value: string[];
    onChange: (next: string[]) => void;
    title?: string;
}) {
    const candidates = outputCandidates(graph);
    const normalizedValue = normalizeOutputNodeSelection(value, graph);
    const selected = new Set(normalizedValue);
    const toggle = (nodeId: string, checked: boolean) => {
        const next = checked ? [...normalizedValue, nodeId] : normalizedValue.filter((id) => id !== nodeId);
        onChange(next);
    };

    return (
        <div className="rounded-lg border border-stone-200 p-3 dark:border-stone-700">
            <div className="mb-2 flex items-center justify-between gap-2">
                <div>
                    <div className="text-sm font-medium">{title}</div>
                    <p className="text-xs text-stone-500">不勾选则保留工作流全部输出；勾选后只归档这些节点的产物。</p>
                </div>
                <div className="flex shrink-0 gap-2">
                    <Button size="small" disabled={!candidates.length} onClick={() => onChange(candidates.map((c) => c.nodeId))}>全选</Button>
                    <Button size="small" disabled={!normalizedValue.length} onClick={() => onChange([])}>清空</Button>
                </div>
            </div>
            {candidates.length === 0 ? (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="这个工作流里没找到 Save/Preview 类输出节点" />
            ) : (
                <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                    {candidates.map((item) => (
                        <label key={item.nodeId} className="flex min-w-0 items-center gap-2 py-1 text-xs">
                            <Checkbox checked={selected.has(item.nodeId)} onChange={(event) => toggle(item.nodeId, event.target.checked)} />
                            <span className="truncate" title={`${item.label} #${item.nodeId}`}>{item.label}</span>
                            <span className="shrink-0 text-stone-400">#{item.nodeId}</span>
                        </label>
                    ))}
                </div>
            )}
            {normalizedValue.length > 0 && (
                <div className="mt-2 text-xs text-stone-500">已选节点：{normalizedValue.join("、")}</div>
            )}
        </div>
    );
}
