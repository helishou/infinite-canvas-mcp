import { Empty, Select } from "antd";
import type { WorkflowGraphJson } from "./workflow-graph-view";
import { isStepPreviewBridge, previewNodeCandidates } from "./preview-node-candidates";

const NONE = "__no_preview_node__";

/**
 * 预览桥节点单选器。选中的节点只决定「生成态画面从哪来」：
 * 不改工作流图、不改节点编号、不改产物筛选与归档。
 */
export function PreviewNodePicker({
    graph, value, onChange, disabled,
}: {
    graph: WorkflowGraphJson;
    value?: string;
    onChange: (next: string) => void;
    disabled?: boolean;
}) {
    const candidates = previewNodeCandidates(graph);
    const selected = value || "";
    const missing = Boolean(selected) && !candidates.some((item) => item.nodeId === selected);
    const options = [
        { value: NONE, label: "不启用预览" },
        ...candidates.map((item) => ({
            value: item.nodeId,
            label: `#${item.nodeId} · ${item.classType}${item.label && item.label !== item.classType ? ` · ${item.label}` : ""} · ${isStepPreviewBridge(item.classType, item.label) ? "逐帧桥" : "节点完成帧"}`,
        })),
    ];
    return (
        <div className="rounded-lg border border-border p-3">
            <div className="mb-2 text-sm font-medium">预览桥节点（画布生成态）</div>
            <p className="mb-2 text-xs text-muted-foreground">
                只把该节点的预览帧推到画布节点的生成中画面，不改产物、不写归档。逐帧画面需要流里带 KJ 预览桥（如 ModelPreviewOverrideKJ）；其他节点只在执行完成时出一帧。仅本地 ComfyUI 生效。
            </p>
            {candidates.length === 0 ? (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="这个工作流里没找到 Preview/Save 类节点" />
            ) : (
                <Select
                    className="w-full"
                    size="small"
                    disabled={disabled}
                    value={missing || !selected ? NONE : selected}
                    onChange={(next) => onChange(next === NONE ? "" : String(next))}
                    options={options}
                />
            )}
            {missing ? (
                <p className="mt-2 text-xs text-amber-600">原选节点 #{selected} 已不在当前工作流中，预览已关闭，请重新选择。</p>
            ) : null}
        </div>
    );
}
