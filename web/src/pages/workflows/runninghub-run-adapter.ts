// RunningHub 档案 → 本地 WorkflowConfig 的字段适配。
//
// 运行页签与字段表单都按 WorkflowConfig / WorkflowField 渲染，本地与云端共用
// 同一套 UI；这里把 RunningHub 的字段语义（source / paramKey / index）翻译成
// 本地字段形状，只翻译「这一栏显示什么、填什么值」，不改变平台提交时的映射。
import type { WorkflowConfig, WorkflowField } from "@/services/api/workflows";
import type { RunningHubField, RunningHubWorkflowProfile } from "@/services/api/runninghub";

/** 本地字段的 input 取值；RunningHub 侧只用到 text/image/video/audio 与自定义参数。 */
function fieldTypeOf(field: RunningHubField): WorkflowField["type"] {
    if (field.fieldType === "image" || field.fieldType === "video" || field.fieldType === "audio") return field.fieldType;
    if (field.fieldType === "number") return "number";
    if (field.fieldType === "boolean") return "boolean";
    if (field.fieldType === "slider") return "slider";
    if (field.fieldType === "dropdown") return "dropdown";
    return "text";
}

/**
 * 单个 RunningHub 字段 → 本地字段。
 *
 * - source=prompt 标为 isPrompt，生成时把提示词正文注入；
 * - source=param/constant 用 paramKey 或 fieldName 作为本地字段 id，填写的值
 *   作为本次运行的参数值提交，不写回档案；
 * - 媒体字段（image/video/audio）只声明占位，实际素材按 source + index 顺序注入。
 */
export function runningHubFieldToLocal(field: RunningHubField): WorkflowField | null {
    const source = field.source || "constant";
    const type = fieldTypeOf(field);
    const media = type === "image" || type === "video" || type === "audio";
    const id = field.paramKey?.trim() || field.fieldName;
    return {
        id,
        node: field.nodeId,
        input: field.fieldName,
        name: field.label || `${field.nodeId}.${field.fieldName}`,
        type,
        ...(field.required ? { required: true } : {}),
        ...(media ? {} : { default: field.fieldValue as never }),
        ...(source === "prompt" ? { isPrompt: true } : {}),
    };
}

/** 档案 → 可直接喂给 RunTab 的 WorkflowConfig。 */
export function runningHubProfileToConfig(profile: RunningHubWorkflowProfile): WorkflowConfig {
    return {
        title: profile.name,
        backend: "runninghub",
        operation: "",
        description: `RunningHub workflow ${profile.workflowId}`,
        fields: (profile.fields || [])
            .filter((field) => field.enabled !== false)
            .map(runningHubFieldToLocal)
            .filter((field): field is WorkflowField => field !== null),
    };
}

/**
 * 本次运行提交给平台的参数值。
 *
 * 字段 id 与 runningHubFieldToLocal 一致（paramKey 优先），所以表单里填的
 * duration / seed / steps 等能原样回到平台节点。提示词不在这份里——它走 input。
 */
export function runningHubValuesFromForm(form: Record<string, string>): Record<string, unknown> {
    const values: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(form)) {
        if (raw === undefined || raw === "") continue;
        const numeric = Number(raw);
        values[key] = raw !== "" && Number.isFinite(numeric) ? numeric : raw;
    }
    return values;
}

/** 档案中由本次请求注入媒体的字段，按 source + index 排序，供运行页签提示用。 */
export function runningHubMediaSlots(profile: RunningHubWorkflowProfile) {
    const order: Record<string, number> = { image: 0, video: 1, audio: 2 };
    return (profile.fields || [])
        .filter((field) => field.enabled !== false && ["image", "video", "audio"].includes(field.source || ""))
        .sort((a, b) => (order[a.source || "image"] ?? 0) - (order[b.source || "image"] ?? 0) || (a.index || 1) - (b.index || 1))
        .map((field, position) => ({
            id: field.paramKey?.trim() || field.fieldName,
            label: field.label || `${field.nodeId}.${field.fieldName}`,
            kind: field.source as "image" | "video" | "audio",
            position,
        }));
}
