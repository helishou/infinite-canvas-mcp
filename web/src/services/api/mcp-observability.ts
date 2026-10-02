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
    /** 已记录尺寸的调用数；早期事件缺 summary 时不参与均值。 */
    sizedCalls?: number;
    averageOutputChars?: number | null;
    maxOutputChars?: number | null;
    /** 4 字符 ≈ 1 token 的粗估。 */
    estimatedOutputTokens?: number | null;
    averageInputChars?: number | null;
    maxInputChars?: number | null;
};

export type McpObservabilityPayloadSummary = {
    outputSizedCalls: number;
    inputSizedCalls: number;
    totalInputChars: number;
    totalOutputChars: number;
    estimatedTotalInputTokens: number;
    estimatedTotalOutputTokens: number;
    averageOutputChars: number | null;
    maxOutputChars: number | null;
    maxOutputTokens: number | null;
    maxInputChars: number | null;
    warnThresholdChars: number;
    oversizedCalls: number;
    note?: string;
};

export type McpObservabilityReport = {
    generatedAt: string;
    filters?: {
        from: string | null;
        to: string | null;
    };
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
    payload?: McpObservabilityPayloadSummary;
    transitions: Array<{ fromTool: string; toTool: string; count: number }>;
    daily: Array<{
        date: string;
        calls: number;
        succeeded: number;
        failed: number;
        successRate: number | null;
        averageDurationMs: number | null;
        averageOutputChars?: number | null;
    }>;
    dailyByTool: Array<{
        date: string;
        tool: string;
        calls: number;
        succeeded: number;
        failed: number;
        successRate: number | null;
        averageDurationMs: number | null;
        averageOutputChars: number | null;
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

export type McpOptimizationMarker = {
    id: string;
    at: string;
    label: string;
    createdAt: string;
};

export async function fetchMcpObservabilityReport(options?: { from?: string; to?: string }) {
    const params = new URLSearchParams();
    if (options?.from) params.set("from", options.from);
    if (options?.to) params.set("to", options.to);
    const query = params.toString();
    const data = await request<{ ok: boolean; report: McpObservabilityReport }>("GET", `/mcp/observability/report${query ? `?${query}` : ""}`);
    return data.report;
}

export async function fetchMcpOptimizationMarkers() {
    const data = await request<{ ok: boolean; markers: McpOptimizationMarker[] }>("GET", "/mcp/observability/optimization-markers");
    return data.markers;
}

export async function saveMcpOptimizationMarker(input: { at?: string; label: string }) {
    const data = await request<{ ok: boolean; marker: McpOptimizationMarker }>("POST", "/mcp/observability/optimization-markers", input);
    return data.marker;
}

export async function deleteMcpOptimizationMarker(id: string) {
    await request<{ ok: boolean }>("DELETE", `/mcp/observability/optimization-markers/${encodeURIComponent(id)}`);
}

export async function fetchMcpObservabilityTrace(traceId: string) {
    const data = await request<{ ok: boolean; traceId: string; events: McpObservabilityEvent[] }>("GET", `/mcp/observability/traces/${encodeURIComponent(traceId)}`);
    return data.events;
}
