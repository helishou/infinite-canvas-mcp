// ComfyUI 工作流管理：拉取 / 上传 / 删除 / 详情
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

export function fetchWorkflows(): Promise<{ workflows: WorkflowItem[] }> {
    return request<{ workflows: WorkflowItem[] }>("GET", "/api/workflows");
}

export function fetchWorkflowDetail(name: string): Promise<WorkflowDetail> {
    return request<WorkflowDetail>("GET", `/api/workflows/${encodeURIComponent(name)}`);
}
