import type { Express, Request, Response } from "express";
import type { BackendDatabase } from "./db.js";

/** Attach the real frozen-command and H3 projection APIs to an isolated MCP test backend. */
export function registerMcpCommandTestRoutes(app: Express, db: BackendDatabase) {
  app.post("/mcp/commands/:operationId/prepare", (req: Request, res: Response) => {
    try { res.json({ ok: true, command: db.prepareMcpCommand({ operationId: String(req.params.operationId), ...req.body }) }); }
    catch (error) { const value = error as Error & { code?: string }; res.status(value.code === "OPERATION_ID_REUSED" ? 409 : 400).json({ ok: false, code: value.code, error: value.message }); }
  });
  app.get("/mcp/commands/:operationId", (req, res) => res.json({ ok: true, command: db.getMcpCommandReceipt(String(req.params.operationId)) }));
  app.post("/mcp/commands/:operationId/check", (req, res) => {
    try { res.json({ ok: true, command: db.getMcpCommandReceipt(String(req.params.operationId), req.body) }); }
    catch (error) { const value = error as Error & { code?: string }; res.status(value.code === "OPERATION_ID_REUSED" ? 409 : 400).json({ ok: false, code: value.code, error: value.message }); }
  });
  app.get("/canvas/projects/:id/h3-context", (req, res) => {
    const parseIds = (value: unknown) => {
      try {
        const parsed = JSON.parse(typeof value === "string" ? value : "[]");
        return Array.isArray(parsed) && parsed.every(item => typeof item === "string") ? parsed as string[] : [];
      } catch { return []; }
    };
    const project = db.getCanvasProjectH3Context(String(req.params.id), String(req.query.nodeId || ""), typeof req.query.segmentId === "string" ? req.query.segmentId : undefined, { sourceNodeIds: parseIds(req.query.sourceNodeIds), assetIds: parseIds(req.query.assetIds) });
    if (!project) return void res.status(404).json({ ok: false, error: "H3 节点不存在" });
    res.json({ ok: true, project });
  });
  app.get("/canvas/assets", (req, res) => {
    if (req.query.view === "summary") return void res.json({ ok: true, ...db.listAssetsPage({ kind: req.query.kind as string | undefined, keyword: req.query.keyword as string | undefined, page: Number(req.query.page) || 1, pageSize: Number(req.query.pageSize) || 20 }) });
    res.json({ ok: true, assets: db.listAssets({ kind: req.query.kind as string | undefined }) });
  });
  app.get("/canvas/assets/:id", (req, res) => {
    const asset = db.getAsset(String(req.params.id));
    if (!asset) return void res.status(404).json({ ok: false, code: "ASSET_NOT_FOUND", error: "素材不存在" });
    res.json({ ok: true, asset });
  });
  app.post("/canvas/assets/mcp-upsert-batch", (req, res) => {
    try {
      const receipt = db.commitMcpAssetCommand(req.body);
      res.json(receipt);
    } catch (error) { const value = error as Error & { code?: string }; res.status(409).json({ ok: false, code: value.code, error: value.message }); }
  });
  app.get("/mcp/observability/report", (req, res) => res.json({ ok: true, report: db.getMcpObservabilityReport({
    from: typeof req.query.from === "string" ? req.query.from : undefined,
    to: typeof req.query.to === "string" ? req.query.to : undefined,
    tool: typeof req.query.tool === "string" ? req.query.tool : undefined,
    view: req.query.view === "full" ? "full" : "summary",
  }) }));
  app.get("/mcp/observability/traces/:traceId", (req, res) => res.json({ ok: true, traceId: req.params.traceId, events: db.listMcpObservabilityEvents(String(req.params.traceId)) }));
}
