import { request } from "@/services/backend-api";
import type { RunningHubConfig, RunningHubField } from "@basketikun/canvas-agent/generation-contract";
export type { RunningHubConfig, RunningHubField } from "@basketikun/canvas-agent/generation-contract";

export const fetchRunningHubConfig = () => request<{ config: RunningHubConfig }>("GET", "/agent/runninghub/config");
export const saveRunningHubConfig = (config: Partial<RunningHubConfig>) => request<{ config: RunningHubConfig }>("PUT", "/agent/runninghub/config", config);
export const inspectRunningHubWorkflow = (workflowId: string) => request<{ workflowId: string; workflowJson: Record<string, unknown>; fields: RunningHubField[] }>("POST", "/agent/runninghub/workflow/inspect", { workflowId });
