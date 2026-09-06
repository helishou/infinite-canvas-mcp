// ComfyUI 工作流管理：拉取 / 上传 / 删除 / 详情 / 运行
// 后端 API：backend/src/workflows/routes.ts
import { request } from "@/services/backend-api";

export type WorkflowItem = {
    name: string;
    description?: string;
    uploadedAt?: string;
    hasConfig?: boolean;
};

export type WorkflowDetail = {
    name: string;
    description?: string;
    workflow: Record<string, unknown>;
    config?: Record<string, unknown>;
};

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

// 极简 fields：生图工作台暂时只传 prompt 字段。
// 复杂字段（lora / sampler / …）等 workflows 页面配置面板加完 UI 再补。
export type WorkflowRunFields = {
    prompt?: string;
    references?: string[];
    [key: string]: unknown;
};

export function fetchWorkflows(): Promise<{ workflows: WorkflowItem[] }> {
    return request<{ workflows: WorkflowItem[] }>("GET", "/api/workflows");
}

export function fetchWorkflowDetail(name: string): Promise<WorkflowDetail> {
    return request<WorkflowDetail>("GET", `/api/workflows/${encodeURIComponent(name)}`);
}

export function runWorkflow(name: string, fields: WorkflowRunFields): Promise<WorkflowRunResult> {
    // 给一个空 config，避免后端 executor.run 第一行
    // processImageFields(config.fields, …) 抛 "Cannot read properties of
    // undefined (reading 'fields')"。用户后续在 workflows 页面配置
    // 完字段后，前端会再传带 fields 的真 config。
    return request<WorkflowRunResult>("POST", `/api/workflows/${encodeURIComponent(name)}/run`, {
        fields,
        config: { title: name, backend: "", operation: "", description: "", fields: [] },
    });
}

