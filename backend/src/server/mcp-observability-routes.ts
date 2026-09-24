import type { Express, Request, Response } from "express";
import type { McpObservabilityEventInput } from "../db.js";
import type { McpObservabilityStore } from "../stores/types.js";

export function registerMcpObservabilityRoutes(app: Express, store: McpObservabilityStore) {
    app.post("/mcp/observability/events", (req: Request, res: Response) => {
        const body = recordOf(req.body);
        const event = String(body.event || "");
        if (!body.sessionId || !body.traceId || !body.tool || !["tool.started", "tool.succeeded", "tool.failed"].includes(event)) {
            res.status(400).json({ ok: false, error: "sessionId、traceId、tool 和有效 event 必填" });
            return;
        }
        const saved = store.record({
            sessionId: String(body.sessionId),
            traceId: String(body.traceId),
            event: event as McpObservabilityEventInput["event"],
            tool: String(body.tool),
            projectId: optionalString(body.projectId),
            nodeId: optionalString(body.nodeId),
            operationId: optionalString(body.operationId),
            taskId: optionalString(body.taskId),
            durationMs: body.durationMs == null ? undefined : Number(body.durationMs),
            errorCode: optionalString(body.errorCode),
            recoverable: typeof body.recoverable === "boolean" ? body.recoverable : undefined,
            suggestedTool: optionalString(body.suggestedTool),
            inputSummary: recordOf(body.inputSummary),
            outputSummary: recordOf(body.outputSummary),
        });
        res.status(201).json({ ok: true, event: saved });
    });
    app.get("/mcp/observability/report", (_req: Request, res: Response) => {
        res.json({ ok: true, report: store.report() });
    });
    app.get("/mcp/observability/traces/:traceId", (req: Request, res: Response) => {
        res.json({ ok: true, traceId: req.params.traceId, events: store.trace(String(req.params.traceId || "")) });
    });
}

function recordOf(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function optionalString(value: unknown) {
    const text = typeof value === "string" ? value.trim() : "";
    return text || undefined;
}
