import { request, type BackendRuntimeTask } from "@/services/backend-api";
import type { RunningHubConfig, RunningHubField, RunningHubSite, RunningHubWorkflowGraph, RunningHubWorkflowProfile } from "@basketikun/canvas-agent/generation-contract";
export type { RunningHubConfig, RunningHubField, RunningHubSite, RunningHubWorkflowGraph, RunningHubWorkflowProfile } from "@basketikun/canvas-agent/generation-contract";

/** 站点参数：default 表示跟随运行环境那条 RH 链路，ai / cn 固定到对应站点。 */
const siteQuery = (site?: RunningHubSite) => site && site !== "default" ? `?site=${site}` : "";

export const fetchRunningHubConfig = () => request<{ config: RunningHubConfig }>("GET", "/agent/runninghub/config");
export const saveRunningHubConfig = (config: Partial<RunningHubConfig>) => request<{ config: RunningHubConfig }>("PUT", "/agent/runninghub/config", config);
export const inspectRunningHubWorkflow = (workflowId: string) => request<{ workflowId: string; workflowJson: RunningHubWorkflowGraph; fields: RunningHubField[] }>("POST", "/agent/runninghub/workflow/inspect", { workflowId });
export const fetchRunningHubStatus = () => request<{ hasApiKey: boolean; url?: string; configured?: boolean; workflowTaskReplaySafe?: boolean }>("GET", "/agent/runninghub/status");
export const fetchRunningHubWorkflows = () => request<{ workflows: RunningHubWorkflowProfile[] }>("GET", "/agent/runninghub/workflows");
export const saveRunningHubWorkflow = (profile: RunningHubWorkflowProfile) => request<{ workflow: RunningHubWorkflowProfile }>("PUT", `/agent/runninghub/workflows/${encodeURIComponent(profile.id)}`, profile);
export const resyncRunningHubWorkflow = (profileId: string) => request<{ workflow: RunningHubWorkflowProfile }>("POST", `/agent/runninghub/workflows/${encodeURIComponent(profileId)}/resync`);
export const deleteRunningHubWorkflow = (profileId: string) => request<{ deleted: number }>("DELETE", `/agent/runninghub/workflows/${encodeURIComponent(profileId)}`);
// 运行端点返回 202 + { ok, task }，任务 ID 在 task.id 上；不要按本地工作流的 { taskId } 读。
export const runRunningHubWorkflow = (profileId: string, input: Record<string, unknown>, values: Record<string, unknown>, params: Record<string, unknown>, clientTaskId?: string) => request<{ task: BackendRuntimeTask }>("POST", `/agent/runninghub/workflows/${encodeURIComponent(profileId)}/run`, { input, values, params, clientTaskId });
export const fetchRunningHubWorkflowTasks = (profileId: string) => request<{ tasks: BackendRuntimeTask[] }>("GET", `/agent/runninghub/workflows/${encodeURIComponent(profileId)}/tasks`);
export const cancelRunningHubTask = (taskId: string) => request("POST", `/agent/runninghub/tasks/${encodeURIComponent(taskId)}/cancel`);
/** 网页会话状态；上传本地工作流走网页端接口，需要登录令牌而不是 OpenAPI Key。两个站点各一份。 */
export type RunningHubSessionStatus = { connected: boolean; source?: "browser" | "manual"; expiresAt?: number; expired?: boolean; updatedAt?: string; tokenHint?: string };
export const fetchRunningHubSession = (site?: RunningHubSite) => request<{ session: RunningHubSessionStatus }>("GET", `/agent/runninghub/session${siteQuery(site)}`);
export const saveRunningHubSession = (accessToken: string, site?: RunningHubSite) => request<{ session: RunningHubSessionStatus }>("PUT", "/agent/runninghub/session", { accessToken, site });
export const deleteRunningHubSession = (site?: RunningHubSite) => request<{ session: RunningHubSessionStatus }>("DELETE", `/agent/runninghub/session${siteQuery(site)}`);
export const importRunningHubBrowserSession = (site?: RunningHubSite) => request<{ session: RunningHubSessionStatus }>("POST", "/agent/runninghub/session/browser-import", { site });
/** 本地节点图上传到云端工作台并自动建档；cloudRead=false 表示平台还是草稿，OpenAPI 暂时读不回节点图。 */
export const uploadRunningHubWorkflow = (input: { name: string; graph: Record<string, unknown>; uiWorkflow?: Record<string, unknown>; site?: RunningHubSite }) => request<{ workflowId: string; profile: RunningHubWorkflowProfile; cloudRead: boolean; site: RunningHubSite; format?: "ui" | "api"; tail?: "added" | "added-video" | "video-no-image" | "already" | "no-sink" | "not-ui" }>("POST", "/agent/runninghub/workflows/upload", input);
