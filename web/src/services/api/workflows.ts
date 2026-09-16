// ComfyUI 工作流管理：拉取 / 上传 / 删除 / 详情 / 运行
// 后端 API：backend/src/workflows/routes.ts
import { request } from "@/services/backend-api";

export type WorkflowItem = {
    name: string;
    description?: string;
    uploadedAt?: string;
    hasConfig?: boolean;
};

// 跟 backend/src/db.ts 的 WorkflowField / WorkflowConfig 对齐。
// 配置面板加完后这个类型可以删，本地前端 types 由 workflows 页面那侧维护。
export type WorkflowFieldType = "text" | "number" | "slider" | "boolean" | "dropdown" | "image" | "audio" | "video";
export type WorkflowField = {
    id: string;
    node: string;
    input: string;
    name: string;
    type: WorkflowFieldType;
    required?: boolean;
    default?: unknown;
    min?: number;
    max?: number;
    step?: number;
    options?: string[];
    randomEnabled?: boolean;
    isPrompt?: boolean;
};
export type WorkflowConfig = {
    title: string;
    backend: string;
    operation: string;
    description: string;
    fields: WorkflowField[];
    mediaInputs?: Record<string, unknown>;
    miniCards?: Record<string, unknown>;
};

export type WorkflowDetail = {
    name: string;
    description?: string;
    workflow: Record<string, unknown>;
    config?: WorkflowConfig;
};

export type WorkflowPackage = {
    format: "infinite-canvas-workflow";
    version: 1;
    name: string;
    workflow: Record<string, unknown>;
    config: WorkflowConfig;
};

export function isWorkflowImageField(field: WorkflowField, workflow?: Record<string, unknown>) {
    if (field.type === "image") return true;
    return field.node.split(",").some((nodeId) => (workflow?.[nodeId] as { class_type?: unknown } | undefined)?.class_type === "LoadImage");
}

export function isWorkflowAudioField(field: WorkflowField, workflow?: Record<string, unknown>) {
    if (field.type === "audio") return true;
    return field.node.split(",").some((nodeId) => (workflow?.[nodeId] as { class_type?: unknown } | undefined)?.class_type === "LoadAudio");
}

export function isWorkflowVideoField(field: WorkflowField, workflow?: Record<string, unknown>) {
    if (field.type === "video") return true;
    return field.node.split(",").some((nodeId) => /(?:^|_)LoadVideo/.test(String((workflow?.[nodeId] as { class_type?: unknown } | undefined)?.class_type || "")));
}

// 跟 backend/src/workflows/executor.ts 的 RunResult 对齐；
// fields 走 builder prompt 模式（workflow 顶层 prompt 节点），config 里的 fields 定义 UI 渲染。
export type WorkflowRunResult = {
    taskId?: string;
    promptId?: string;
    outputs?: Record<string, unknown>;
    media: Array<{ url: string; storageKey?: string; mimeType: string; filename?: string }>;
    status: { status_str?: string; completed?: boolean };
    error?: string;
};

// fields 字典：key = WorkflowField.id，value：
//   - image / audio / video 字段：Backend 媒体 URL（兼容旧 dataURL）
//   - text/number/... 字段：原始值
// 顶层 prompt 字段约定 key = "prompt"（与生图工作台传入对齐）
export type WorkflowRunFields = {
    prompt?: string;
    [fieldId: string]: unknown;
};

export function fetchWorkflows(): Promise<{ workflows: WorkflowItem[] }> {
    return request<{ workflows: WorkflowItem[] }>("GET", "/api/workflows");
}

export function fetchWorkflowDetail(name: string): Promise<WorkflowDetail> {
    return request<WorkflowDetail>("GET", `/api/workflows/${encodeURIComponent(name)}`);
}

export function exportWorkflowPackage(name: string): Promise<WorkflowPackage> {
    return request<WorkflowPackage>("GET", `/api/workflows/${encodeURIComponent(name)}/export`);
}

export function importWorkflowPackage(name: string, workflowPackage: WorkflowPackage): Promise<{ name: string }> {
    return request<{ name: string }>("POST", "/api/workflows/import", { name, package: workflowPackage });
}

// 仅重命名显示标题（title），不动底层文件名
export function renameWorkflowTitle(name: string, title: string): Promise<{ name: string; title: string }> {
    return request<{ name: string; title: string }>("PUT", `/api/workflows/${encodeURIComponent(name)}/title`, { title });
}

/** 拉取 ComfyUI 各节点 COMBO 输入的选项列表 */
export function fetchWorkflowComboOptions(name: string): Promise<{ options: Record<string, Record<string, string[]>> }> {
    return request<{ options: Record<string, Record<string, string[]>> }>("GET", `/api/workflows/${encodeURIComponent(name)}/combo-options`);
}

export function runWorkflow(name: string, fields: WorkflowRunFields, config?: WorkflowConfig, clientTaskId?: string): Promise<WorkflowRunResult> {
    // config 是 WorkflowExecutor.run 第一个会用到的字段（processImageFields 读
    // config.fields），前端如果漏传会让 executor 立刻崩
    // "Cannot read properties of undefined (reading 'fields')"。
    // 用户后续在 workflows 页面配完字段后，前端传真 config 让
    // processImageFields 能把 image 类型的 dataURL 上传到 ComfyUI。
    return request<WorkflowRunResult>("POST", `/api/workflows/${encodeURIComponent(name)}/run`, {
        fields,
        clientTaskId,
        config: config ?? {
            title: name.split("/").pop()?.replace(/\.json$/, "") || name,
            backend: "",
            operation: "",
            description: "",
            fields: [],
        },
    });
}
