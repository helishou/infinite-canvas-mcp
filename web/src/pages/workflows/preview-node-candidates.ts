import { workflowDisplayGraph } from "./workflow-source";
import type { WorkflowGraphJson } from "./workflow-graph-view";

/**
 * 预览桥候选判定（纯函数，不依赖 React/antd，便于单测与后端规则对齐）。
 * 复用 workflowDisplayGraph 的只读投影，因此 UI 格式（nodes/links）与 API 格式都能识别，
 * 且节点 id 与提交给 ComfyUI 的图保持一致。
 */
export type PreviewNodeCandidate = { nodeId: string; label: string; classType: string };

/** 能作为预览源的节点：Preview/Save/视频合成类。刻意不含通用 Bridge，避免语义桥节点混入。 */
const PREVIEW_NODE_HINTS = /Preview|Save|VideoCombine|VHS_Video|ImageSave|Export/i;
/** 会发 `kj_preview_override` 的 KJ 系预览桥：这类节点给的是采样过程逐帧画面。 */
const KJ_BRIDGE_HINTS = /ModelPreviewOverride|PreviewBridge|KJPreview|PreviewOverride|PreviewImageKJ/i;

export function isStepPreviewBridge(classType: string, label = "") {
    return KJ_BRIDGE_HINTS.test(classType) || KJ_BRIDGE_HINTS.test(label);
}

export function previewNodeCandidates(graph: WorkflowGraphJson): PreviewNodeCandidate[] {
    return Object.entries(workflowDisplayGraph(graph))
        // mode 2 = muted，mode 4 = bypass/禁用，两者都不会执行，列出来只会误导。
        .filter(([, node]) => node.mode !== 2 && node.mode !== 4)
        .map(([nodeId, node]) => ({
            nodeId,
            classType: node?.class_type || "",
            label: String(node?._meta?.title || node?.class_type || nodeId),
        }))
        .filter((item) => PREVIEW_NODE_HINTS.test(item.classType) || PREVIEW_NODE_HINTS.test(item.label));
}

/**
 * 推荐值：只在流里恰好有一个逐帧预览桥时自动选中它。
 * 多个桥时 `kj_preview_override` 不带节点 id，归属有歧义，必须让用户单选，不能猜。
 */
export function preferredPreviewNodeId(graph: WorkflowGraphJson): string {
    const bridges = previewNodeCandidates(graph).filter((item) => isStepPreviewBridge(item.classType, item.label));
    return bridges.length === 1 ? bridges[0].nodeId : "";
}
