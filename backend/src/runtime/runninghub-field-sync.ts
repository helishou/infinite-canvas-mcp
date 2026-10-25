/**
 * 上传到 RunningHub 时，把本地已配置的字段"点亮"到云端档案。
 *
 * 平台自动发现的输入默认全是 `enabled: false`（设计上要人工勾选），
 * 所以只传节点图的话，云端档案页看到的是一排空勾选框、运行表单也没有任何输入——
 * 用户在本地辛苦配好的名称、类型、默认值、提示词标记等于白配。
 * 这里按 `node::input` 对齐，把本地那份带上去。
 */
import type { RunningHubField } from "@basketikun/canvas-agent/generation-contract";

/** 本地工作流字段的最小结构（WorkflowField 的子集，避免 backend 反向依赖 web 类型）。 */
export type LocalWorkflowField = {
    node?: string;
    input?: string;
    name?: string;
    type?: string;
    default?: unknown;
    isPrompt?: boolean;
    required?: boolean;
};

const MEDIA_TYPES = new Set(["image", "video", "audio"]);

export function applyLocalFieldsToDiscovered(discovered: RunningHubField[], local: LocalWorkflowField[]): RunningHubField[] {
    if (!discovered.length || !local?.length) return discovered;

    const selection = new Map<string, LocalWorkflowField>();
    for (const field of local) {
        const input = String(field?.input || "").trim();
        if (!input) continue;
        // 一个本地字段可能映射多个节点（逗号分隔），逐节点登记。
        for (const node of String(field.node || "").split(",").map((item) => item.trim()).filter(Boolean)) {
            selection.set(`${node}::${input}`, field);
        }
    }
    if (!selection.size) return discovered;

    return discovered.map((field) => {
        const matched = selection.get(`${field.nodeId}::${field.fieldName}`);
        if (!matched) return field;
        const type = String(matched.type || "");
        const source = matched.isPrompt ? "prompt" as const : MEDIA_TYPES.has(type) ? type as "image" | "video" | "audio" : "constant" as const;
        return {
            ...field,
            enabled: true,
            source,
            ...(matched.name ? { label: matched.name } : {}),
            ...(type ? { fieldType: type } : {}),
            ...(matched.default !== undefined && matched.default !== null ? { fieldValue: matched.default } : {}),
            ...(matched.required ? { required: true } : {}),
        };
    });
}
