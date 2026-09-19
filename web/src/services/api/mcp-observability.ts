import { request } from "@/services/backend-api";

export type McpObservabilityMetric = {
    tool: string;
    calls: number;
    succeeded: number;
    failed: number;
    successRate: number | null;
    averageDurationMs: number | null;
    maxDurationMs: number | null;
    p95DurationMs: number | null;
    ordinaryP95DurationMs?: number | null;
};

export type McpObservabilityReport = {
    generatedAt: string;
    calls: {
        started: number;
        completed: number;
        incomplete: number;
        succeeded: number;
        failed: number;
        successRate: number | null;
        averageDurationMs: number | null;
        maxDurationMs: number | null;
        p95DurationMs: number | null;
    };
    sessions: {
        total: number;
        averageCalls: number | null;
        maxCalls: number;
    };
    recovery: {
        suggested: number;
        followed: number;
        succeeded: number;
        followRate: number | null;
        successRate: number | null;
        followedSuccessRate?: number | null;
        observation?: string;
    };
    byTool: McpObservabilityMetric[];
    errors: Array<{ code: string; count: number }>;
    failuresByTool: Array<{ tool: string; code: string; count: number; latestTraceId?: string }>;
    taskStatuses: Array<{ status: string; count: number }>;
    taskOutcomesByTool: Array<{ tool: string; status: string; count: number }>;
    taskAssociation?: { incomplete: boolean; note: string };
    latency?: {
        ordinary: McpObservabilityDurationSummary;
        waiting: McpObservabilityDurationSummary;
    };
    transitions: Array<{ fromTool: string; toTool: string; count: number }>;
    daily: Array<{
        date: string;
        calls: number;
        succeeded: number;
        failed: number;
        successRate: number | null;
        averageDurationMs: number | null;
    }>;
    diagnostics: Array<{
        severity: "success" | "info" | "warning" | "error";
        code: string;
        title: string;
        detail: string;
        tool?: string;
    }>;
};

export type McpObservabilityDurationSummary = {
    calls: number;
    averageDurationMs: number | null;
    maxDurationMs: number | null;
    p95DurationMs: number | null;
};

export type McpObservabilityEvent = {
    id: string;
    sessionId: string;
    traceId: string;
    event: "tool.started" | "tool.succeeded" | "tool.failed";
    tool: string;
    projectId?: string;
    nodeId?: string;
    operationId?: string;
    taskId?: string;
    durationMs?: number;
    errorCode?: string;
    recoverable?: boolean;
    suggestedTool?: string;
    inputSummary?: Record<string, unknown>;
    outputSummary?: Record<string, unknown>;
    createdAt: string;
};

export async function fetchMcpObservabilityReport() {
    const data = await request<{ ok: boolean; report: McpObservabilityReport }>("GET", "/mcp/observability/report");
    return data.report;
}

export async function fetchMcpObservabilityTrace(traceId: string) {
    const data = await request<{ ok: boolean; traceId: string; events: McpObservabilityEvent[] }>("GET", `/mcp/observability/traces/${encodeURIComponent(traceId)}`);
    return data.events;
}
