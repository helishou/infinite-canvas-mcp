import { request, type BackendRuntimeTask } from "@/services/backend-api";
import type { RunningHubConfig, RunningHubField, RunningHubWorkflowProfile } from "@basketikun/canvas-agent/generation-contract";
export type { RunningHubConfig, RunningHubField, RunningHubWorkflowProfile } from "@basketikun/canvas-agent/generation-contract";

export const fetchRunningHubConfig = () => request<{ config: RunningHubConfig }>("GET", "/agent/runninghub/config");
export const saveRunningHubConfig = (config: Partial<RunningHubConfig>) => request<{ config: RunningHubConfig }>("PUT", "/agent/runninghub/config", config);
export const inspectRunningHubWorkflow = (workflowId: string) => request<{ workflowId: string; workflowJson: Record<string, unknown>; fields: RunningHubField[] }>("POST", "/agent/runninghub/workflow/inspect", { workflowId });
export const fetchRunningHubStatus = () => request<{ hasApiKey: boolean }>("GET", "/agent/runninghub/status");
export const fetchRunningHubWorkflows = () => request<{ workflows: RunningHubWorkflowProfile[] }>("GET", "/agent/runninghub/workflows");
export const saveRunningHubWorkflow = (profile: RunningHubWorkflowProfile) => request<{ workflow: RunningHubWorkflowProfile }>("PUT", `/agent/runninghub/workflows/${encodeURIComponent(profile.id)}`, profile);
export const deleteRunningHubWorkflow = (profileId: string) => request<{ deleted: number }>("DELETE", `/agent/runninghub/workflows/${encodeURIComponent(profileId)}`);
export const runRunningHubWorkflow = (profileId: string, input: Record<string, unknown>, values: Record<string, unknown>, params: Record<string, unknown>) => request<{ taskId: string }>("POST", `/agent/runninghub/workflows/${encodeURIComponent(profileId)}/run`, { input, values, params });
export const fetchRunningHubWorkflowTasks = (profileId: string) => request<{ tasks: BackendRuntimeTask[] }>("GET", `/agent/runninghub/workflows/${encodeURIComponent(profileId)}/tasks`);
export const cancelRunningHubTask = (taskId: string) => request("POST", `/agent/runninghub/tasks/${encodeURIComponent(taskId)}/cancel`);
