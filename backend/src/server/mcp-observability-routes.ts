import type { Express, Request, Response } from "express";
import type { McpObservabilityEventInput } from "../db.js";
import type { McpObservabilityReportOptions, McpObservabilityStore } from "../stores/types.js";

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
    app.get("/mcp/observability/report", (req: Request, res: Response) => {
        const from = optionalDate(req.query.from);
        const to = optionalDate(req.query.to);
        if ((req.query.from && !from) || (req.query.to && !to)) {
            res.status(400).json({ ok: false, error: "from/to 必须是 YYYY-MM-DD" });
            return;
        }
        if (from && to && from > to) {
            res.status(400).json({ ok: false, error: "from 不能晚于 to" });
            return;
        }
        res.json({
            ok: true,
            report: store.report({ from, to }),
            filters: { from: from || null, to: to || null },
        });
    });
    app.get("/mcp/observability/optimization-markers", (_req: Request, res: Response) => {
        res.json({ ok: true, markers: store.optimizationMarkers() });
    });
    app.post("/mcp/observability/optimization-markers", (req: Request, res: Response) => {
        const body = recordOf(req.body);
        try {
            res.status(201).json({ ok: true, marker: store.saveOptimizationMarker({ at: optionalString(body.at), label: optionalString(body.label) }) });
        } catch (error) {
            res.status(400).json({ ok: false, error: error instanceof Error ? error.message : "保存优化标记失败" });
        }
    });
    app.delete("/mcp/observability/optimization-markers/:id", (req: Request, res: Response) => {
        const id = String(req.params.id || "");
        if (!store.deleteOptimizationMarker(id)) {
            res.status(404).json({ ok: false, error: "优化标记不存在" });
            return;
        }
        res.json({ ok: true });
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

function optionalDate(value: unknown) {
    const text = typeof value === "string" ? value.trim() : "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return undefined;
    const [year, month, day] = text.split("-").map(Number);
    const date = new Date(year, month - 1, day);
    return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? text : undefined;
}
