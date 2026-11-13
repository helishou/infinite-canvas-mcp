import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Express, Request, Response } from "express";
import { defaultAchengHome } from "@basketikun/canvas-agent/skills/acheng";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = [path.resolve(moduleDirectory, "../../.."), path.resolve(moduleDirectory, "../..")]
    .find((candidate) => fs.existsSync(path.join(candidate, ".agents/skills/acheng-director"))) || path.resolve(moduleDirectory, "../../..");
const skillRoots = [".agents/skills/acheng-director", ".agents/skills/canvas-video-production-sop"];
const roots = skillRoots.map((relative) => path.resolve(repositoryRoot, relative));
const sourceRegistryPath = path.join(repositoryRoot, ".agents", "skills", "acheng-director", "data", "module-registry.json");
const maxFileBytes = 512 * 1024;
const digest = (value: Buffer | string) => crypto.createHash("sha256").update(value).digest("hex");
const execFileAsync = promisify(execFile);

function readSourceRegistry() {
    const bytes = fs.readFileSync(sourceRegistryPath);
    const registry = JSON.parse(bytes.toString("utf8"));
    return { bytes, registry };
}

function resolveMarkdown(relative: unknown) {
    if (typeof relative !== "string" || !relative.endsWith(".md") || relative.includes("\0")) return null;
    const absolute = path.resolve(repositoryRoot, relative);
    if (!roots.some((root) => absolute.startsWith(root + path.sep))) return null;
    const segments = path.relative(repositoryRoot, absolute).split(path.sep);
    let current = repositoryRoot;
    try {
        for (const segment of segments) {
            current = path.join(current, segment);
            if (fs.lstatSync(current).isSymbolicLink()) return null;
        }
    } catch { return null; }
    return { absolute, relative: segments.join("/") };
}

function collect(directory: string): string[] {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const absolute = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) return [];
        if (entry.isDirectory()) return collect(absolute);
        return entry.isFile() && /^SKILL(?:\.disabled)?\.md$/i.test(entry.name) ? [absolute] : [];
    });
}

function readSkill(file: string) {
    const relative = path.relative(repositoryRoot, file).split(path.sep).join("/");
    const content = fs.readFileSync(file, "utf8");
    const title = content.match(/^name:\s*["']?(.+?)["']?\s*$/m)?.[1] || content.match(/^#\s+(.+)$/m)?.[1] || path.basename(path.dirname(file));
    const description = content.match(/^description:\s*(.+)$/m)?.[1] || "项目维护的 Acheng 创作技能";
    const group = relative.includes("/modules/") ? "Acheng 创作模块" : relative.includes("/subskills/") ? "画布生产模块" : relative.includes("canvas-video-production-sop") ? "画布生产入口" : "Acheng Director";
    return { path: relative, content, revision: digest(content), title: title.trim(), description: description.trim(), group };
}

function activeRuntimeState() {
    const activeFile = path.join(defaultAchengHome(repositoryRoot), "skill-runtimes", "acheng-director", "active.json");
    const state = JSON.parse(fs.readFileSync(activeFile, "utf8"));
    const safeRuntime = (runtime: any) => runtime ? ({ runtimeId: runtime.runtimeId, commit: runtime.commit, patchVersion: runtime.patchVersion, version: runtime.version }) : null;
    const versionsRoot = path.resolve(defaultAchengHome(repositoryRoot), "skill-runtimes", "acheng-director", "versions");
    const activePath = path.resolve(String(state.active?.path || ""));
    if (!activePath.startsWith(versionsRoot + path.sep)) throw new Error("Acheng active.json points outside the managed versions directory");
    const activeRegistryBytes = fs.readFileSync(path.join(activePath, "data", "module-registry.json"));
    const activeRegistry = JSON.parse(activeRegistryBytes.toString("utf8"));
    const source = readSourceRegistry();
    return {
        active: safeRuntime(state.active), previous: safeRuntime(state.previous),
        registry: { version: activeRegistry.version, modules: activeRegistry.modules, revision: digest(activeRegistryBytes) },
        sourceRevision: digest(source.bytes),
    };
}

function errorResponse(res: Response, error: unknown) {
    const status = typeof error === "object" && error && "status" in error ? Number((error as { status: number }).status)
        : typeof error === "object" && error && "code" in error && (error as { code: string }).code === "ENOENT" ? 404 : 500;
    return res.status(status).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
}

export function registerAchengSkillsRoutes(app: Express) {
    app.get("/api/acheng-skills", (_req, res) => {
        try {
            const skills = roots.flatMap((root) => {
                try { const stat = fs.lstatSync(root); return stat.isDirectory() && !stat.isSymbolicLink() ? collect(root).filter((file) => path.basename(file).toLowerCase() === "skill.md") : []; }
                catch { return []; }
            }).map(readSkill).sort((a, b) => a.group.localeCompare(b.group, "zh-CN") || a.title.localeCompare(b.title, "zh-CN"));
            res.json({ ok: true, data: skills });
        } catch (error) { errorResponse(res, error); }
    });

    app.get("/api/acheng-skills/runtime", (_req, res) => {
        try { res.json({ ok: true, data: activeRuntimeState() }); }
        catch (error) { errorResponse(res, error); }
    });

    app.post("/api/acheng-skills/runtime/rollback", async (_req, res) => {
        try {
            const script = path.join(repositoryRoot, "scripts", "acheng-engine.mjs");
            const { stdout: output } = await execFileAsync(process.execPath, [script, "rollback"], { cwd: repositoryRoot, encoding: "utf8", windowsHide: true });
            JSON.parse(output);
            res.json({ ok: true, data: activeRuntimeState() });
        } catch (error) { errorResponse(res, error); }
    });

    app.post("/api/acheng-skills/modules/:moduleId/enabled", async (req, res) => {
        let previousBytes: Buffer | undefined;
        let updatedBytes: Buffer | undefined;
        try {
            const moduleId = String(req.params.moduleId || "");
            if (!/^[a-z][a-z0-9-]{0,63}$/.test(moduleId) || typeof req.body?.enabled !== "boolean" || typeof req.body?.expectedRevision !== "string") {
                return void res.status(400).json({ ok: false, error: "模块、启用状态和注册表版本必填" });
            }
            const sourceStat = fs.lstatSync(sourceRegistryPath);
            if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) return void res.status(400).json({ ok: false, error: "项目模块注册表路径不安全" });
            const current = readSourceRegistry();
            previousBytes = current.bytes;
            if (digest(current.bytes) !== req.body.expectedRevision) return void res.status(409).json({ ok: false, error: "模块注册表已被修改，请刷新后重试" });
            const module = current.registry.modules.find((item: { id?: string }) => item.id === moduleId);
            if (!module) return void res.status(404).json({ ok: false, error: "模块不在 Acheng 注册表中" });
            module.enabled = req.body.enabled;
            updatedBytes = Buffer.from(`${JSON.stringify(current.registry, null, 2)}\n`, "utf8");
            const tempPath = `${sourceRegistryPath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
            fs.writeFileSync(tempPath, updatedBytes, { flag: "wx" });
            fs.renameSync(tempPath, sourceRegistryPath);

            // Build and verify a new immutable Acheng runtime from the project skill source.
            const script = path.join(repositoryRoot, "scripts", "acheng-engine.mjs");
            const { stdout } = await execFileAsync(process.execPath, [script, "update", "--working-tree"], { cwd: repositoryRoot, encoding: "utf8", windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
            const update = JSON.parse(stdout);
            if (!update.activated) throw new Error("Acheng update did not activate the edited module registry");
            res.json({ ok: true, data: activeRuntimeState() });
        } catch (error) {
            if (previousBytes && updatedBytes && fs.existsSync(sourceRegistryPath)) {
                try {
                    if (digest(fs.readFileSync(sourceRegistryPath)) === digest(updatedBytes)) {
                        const restorePath = `${sourceRegistryPath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.restore`;
                        fs.writeFileSync(restorePath, previousBytes, { flag: "wx" });
                        fs.renameSync(restorePath, sourceRegistryPath);
                    }
                } catch { /* Preserve the activation error; a concurrent edit must not be overwritten. */ }
            }
            errorResponse(res, error);
        }
    });

    app.get("/api/acheng-skills/file", (req, res) => {
        try {
            const target = resolveMarkdown(req.query.path);
            if (!target) return void res.status(400).json({ ok: false, error: "文件路径不在项目技能目录中" });
            const stat = fs.lstatSync(target.absolute);
            if (!stat.isFile() || stat.isSymbolicLink()) return void res.status(404).json({ ok: false, error: "找不到技能文件" });
            const content = fs.readFileSync(target.absolute, "utf8");
            res.json({ ok: true, path: target.relative, content, revision: digest(content) });
        } catch (error) { errorResponse(res, error); }
    });

    app.put("/api/acheng-skills/file", (req, res) => {
        try {
            const target = resolveMarkdown(req.body?.path);
            if (!target || typeof req.body?.content !== "string" || typeof req.body?.expectedRevision !== "string") return void res.status(400).json({ ok: false, error: "文件、内容和版本号必填" });
            if (Buffer.byteLength(req.body.content, "utf8") > maxFileBytes) return void res.status(413).json({ ok: false, error: "技能文件不能超过 512 KB" });
            if (req.body.content.startsWith("\uFEFF")) return void res.status(400).json({ ok: false, error: "文件内容不能带 UTF-8 BOM" });
            const stat = fs.lstatSync(target.absolute);
            if (!stat.isFile() || stat.isSymbolicLink()) return void res.status(404).json({ ok: false, error: "找不到技能文件" });
            const current = fs.readFileSync(target.absolute);
            if (digest(current) !== req.body.expectedRevision) return void res.status(409).json({ ok: false, error: "文件已被其他操作修改，请重新载入后再保存" });
            const temporary = `${target.absolute}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
            fs.writeFileSync(temporary, req.body.content, { encoding: "utf8", flag: "wx" });
            fs.renameSync(temporary, target.absolute);
            const content = fs.readFileSync(target.absolute, "utf8");
            res.json({ ok: true, path: target.relative, content, revision: digest(content) });
        } catch (error) { errorResponse(res, error); }
    });

}
