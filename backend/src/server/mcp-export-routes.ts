import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Express } from "express";
import type { CanvasProjectStore } from "../stores/types.js";
import { DATA_DIR } from "../config.js";

export class McpSnapshotExports {
    constructor(private readonly root = path.join(DATA_DIR, "mcp-exports")) {}

    private file(sha256: string) {
        if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("INVALID_EXPORT_HASH");
        return path.join(this.root, `${sha256}.json`);
    }

    async create(project: Record<string, unknown>) {
        // Same serialization as the previous Backend MCP compactProject export.
        const { viewport: _viewport, ...snapshot } = project;
        const bytes = Buffer.from(JSON.stringify({ ...snapshot, nodes: Array.isArray(project.nodes) ? project.nodes : [], connections: Array.isArray(project.connections) ? project.connections : [] }), "utf8");
        const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
        const target = this.file(sha256);
        await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
        try {
            const existing = await fs.readFile(target);
            if (!existing.equals(bytes)) throw new Error("EXPORT_INTEGRITY_ERROR");
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            const temporary = path.join(this.root, `${sha256}-${crypto.randomUUID()}.tmp`);
            try {
                await fs.writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
                try { await fs.link(temporary, target); }
                catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
            } finally { await fs.rm(temporary, { force: true }); }
        }
        return { projectId: project.id || project.projectId, revision: project.revision, sha256, bytes: bytes.length,
            mimeType: "application/json", filename: `${sha256}.json`, downloadPath: `/mcp/exports/${sha256}` };
    }

    async read(sha256: string) {
        const bytes = await fs.readFile(this.file(sha256));
        if (crypto.createHash("sha256").update(bytes).digest("hex") !== sha256) throw new Error("EXPORT_INTEGRITY_ERROR");
        return bytes;
    }
}

/** Register only after the Backend's normal authentication middleware. */
export function registerMcpExportRoutes(app: Express, projects: Pick<CanvasProjectStore, "get">, exports = new McpSnapshotExports()) {
    app.post("/canvas/projects/:id/mcp-export", async (req, res) => {
        try {
            const project = projects.get(String(req.params.id));
            if (!project) return void res.status(404).json({ ok: false, error: "画布项目不存在" });
            res.json({ ok: true, export: await exports.create(project as unknown as Record<string, unknown>) });
        } catch (error) { res.status(500).json({ ok: false, error: error instanceof Error ? error.message : "导出失败" }); }
    });
    app.get("/mcp/exports/:sha256", async (req, res) => {
        try {
            const sha256 = String(req.params.sha256);
            const bytes = await exports.read(sha256);
            res.type("application/json").set("Content-Disposition", `attachment; filename="${sha256}.json"`).send(bytes);
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            res.status(code === "ENOENT" ? 404 : (error as Error).message === "INVALID_EXPORT_HASH" ? 400 : 500).json({ ok: false, error: code === "ENOENT" ? "导出文件不存在" : (error as Error).message });
        }
    });
}
