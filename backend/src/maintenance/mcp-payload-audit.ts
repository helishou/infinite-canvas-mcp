/** Read-only acceptance audit: no edits, exports, or media submissions on real projects. */
import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { DB_FILE, loadConfig } from "../config.js";

type Cost = { calls: number; bytes: number; elapsedMs: number };
const hash = (value: string) => crypto.createHash("sha256").update(value).digest("hex");
const cfg = loadConfig();
const outputIndex = process.argv.indexOf("--output");
if (outputIndex >= 0 && !process.argv[outputIndex + 1]) throw new Error("--output 必须指定报告路径");
const db = new DatabaseSync(DB_FILE, { readOnly: true });
const histories = [
    { table: "episode_production_versions", key: "episode_id", kind: "episode", tool: "drama_get_production_version", base: "/drama/episodes" },
    { table: "canvas_production_versions", key: "project_id", kind: "canvas", tool: "canvas_get_production_version", base: "/canvas/projects" },
].flatMap(scope => {
    const row = db.prepare(`SELECT ${scope.key} ownerId, version, length(CAST(snapshot_json AS BLOB)) bytes FROM ${scope.table} ORDER BY bytes DESC LIMIT 1`).get() as { ownerId: string; version: number; bytes: number } | undefined;
    return row ? [{ ...scope, ...row }] : [];
});
db.close();
const client = new Client({ name: "mcp-read-only-payload-audit", version: "1" });
const rows: Record<string, unknown>[] = [];
const call = async (tool: string, input: Record<string, unknown>, cost: Cost) => {
    const started = performance.now();
    const result: any = await client.callTool({ name: tool, arguments: input });
    cost.calls++; cost.bytes += Buffer.byteLength(JSON.stringify(result)); cost.elapsedMs += performance.now() - started;
    if (result.isError) throw new Error(`Read-only audit failed: ${tool}`);
    return JSON.parse(result.content.find((item: any) => item.type === "text").text);
};
const cost = (): Cost => ({ calls: 0, bytes: 0, elapsedMs: 0 });
try {
    await client.connect(new StreamableHTTPClientTransport(new URL(cfg.url + "/mcp"), { requestInit: { headers: { Authorization: `Bearer ${cfg.token}` } } }));
    for (const history of histories) {
        const input = { [history.kind === "episode" ? "episodeId" : "projectId"]: history.ownerId, version: history.version };
        const response = await fetch(`${cfg.url}${history.base}/${encodeURIComponent(history.ownerId)}/production/versions/${history.version}`, { headers: { Authorization: `Bearer ${cfg.token}` } });
        if (!response.ok) throw new Error(`Historical HTTP baseline failed: ${response.status}`);
        const original = (await response.json() as any).version;
        const identity = { kind: history.kind, ownerHash: hash(history.ownerId).slice(0, 12), version: history.version };
        const summaryCost = cost();
        const summary = await call(history.tool, input, summaryCost);
        if (summary.version.sha256 !== hash(JSON.stringify(original.snapshot))) throw new Error("Historical summary identity mismatch");
        rows.push({ task: "historical_overview", ...identity, legacyRawBytes: Buffer.byteLength(JSON.stringify(original)), current: summaryCost, verified: true });
        const artifactCost = cost();
        const index = await call(history.tool, { ...input, view: "artifact_index", pageSize: 1 }, artifactCost);
        const first = index.version.snapshot.artifacts.items[0];
        if (first) {
            let cursor: string | undefined, prompt = "";
            do {
                const part = await call(history.tool, { ...input, view: "artifacts", targetIds: [first.targetId], chunkBytes: 65536, cursor }, artifactCost);
                prompt += part.version.snapshot.chunk.text; cursor = part.version.snapshot.chunk.nextCursor || undefined;
            } while (cursor);
            const expected = original.snapshot.director.artifacts.find((artifact: any) => artifact.targetId === first.targetId);
            if (prompt !== expected.prompt || hash(prompt) !== expected.sha256) throw new Error("Historical prompt reconstruction mismatch");
            rows.push({ task: "discover_and_read_one_artifact", ...identity, legacyRawBytes: Buffer.byteLength(JSON.stringify(original)), current: artifactCost, verified: true });
        }
        const fullCost = cost(); let cursor: string | undefined, text = "";
        do {
            const part = await call(history.tool, { ...input, view: "full", chunkBytes: 100000, cursor }, fullCost);
            text += part.version.snapshot.chunk.text; cursor = part.version.snapshot.chunk.nextCursor || undefined;
        } while (cursor);
        if (hash(text) !== summary.version.sha256) throw new Error("Historical full reconstruction mismatch");
        rows.push({ task: "read_complete_historical_snapshot", ...identity, legacyRawBytes: Buffer.byteLength(JSON.stringify(original.snapshot)), current: fullCost, verified: true });
    }
    const originalCatalog = await (await fetch(cfg.url + "/comfy/models?view=full", { headers: { Authorization: `Bearer ${cfg.token}` } })).json() as any;
    const catalogCost = cost(); const summary = await call("h3_list_models", {}, catalogCost);
    if (summary.error) throw new Error("ComfyUI catalog discovery is incomplete");
    rows.push({ task: "model_catalog_overview", legacyRawBytes: Buffer.byteLength(JSON.stringify(originalCatalog.data)), current: catalogCost, counts: summary.counts, verified: true });
    const selectionCost = cost(); await call("h3_list_models", {}, selectionCost);
    const entries: any[] = []; let cursor: string | undefined;
    do {
        const page = await call("h3_list_models", { view: "entries", categories: ["models"], pageSize: 5, cursor }, selectionCost);
        entries.push(...page.entries); cursor = page.nextCursor || undefined;
    } while (cursor);
    if (JSON.stringify(entries.map(item => item.value).sort()) !== JSON.stringify([...originalCatalog.data.models].sort())) throw new Error("Model pagination mismatch");
    rows.push({ task: "overview_and_read_all_h3_model_names", legacyRawBytes: Buffer.byteLength(JSON.stringify(originalCatalog.data)), current: selectionCost, entries: entries.length, verified: true });
} finally { await client.close(); }
const report = { capturedAt: new Date().toISOString(), source: "live_backend_read_only", byteMetric: "current includes entire MCP response envelopes; legacyRawBytes measures original full JSON payload", rows };
if (outputIndex >= 0) {
    const output = path.resolve(process.argv[outputIndex + 1]); await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, JSON.stringify(report, null, 2) + "\n", "utf8");
}
console.log(JSON.stringify(report, null, 2));
