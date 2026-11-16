import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Express, Request, Response } from "express";

/**
 * 技能广场（借鉴影策 Skill Market 形态，文件系统存储，无数据库）。
 *
 * 设计：
 * - 技能本体落在 workspace 的 `.agents/skills/<name>/SKILL.md`（与 Codex SkillStore 同构，安装后立即可被 Agent 使用）。
 * - 用户状态（收藏/加入/分类/autoUpdate/来源）集中在 `.canvas-runtime/skill-market/state.json`，
 *   用 sha256 revision 乐观锁，避免多标签页互相覆盖。
 * - 广场列表 = 内置技能（项目根 + 站点工作区）+ 用户安装技能，由 frontmatter 解析元数据。
 * - 内置技能不可覆盖、不可卸载；用户安装的同名技能也不允许覆盖，须先卸载。
 */

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = [path.resolve(moduleDirectory, "../../.."), path.resolve(moduleDirectory, "../..")]
    .find((candidate) => fs.existsSync(path.join(candidate, ".agents/skills/acheng-director"))) || path.resolve(moduleDirectory, "../../..");

const NAME_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const CATEGORIES = ["drama", "ecommerce", "creative", "social", "others"] as const;
type MarketCategory = typeof CATEGORIES[number];
const MAX_SKILL_BYTES = 2 * 1024 * 1024;
const MAX_FILES_PER_SKILL = 64;
const MAX_FILE_BYTES = 512 * 1024;

type SkillSource = "builtin" | "markdown" | "zip";
type MarketEntry = {
    tag: MarketCategory;
    liked: boolean;
    added: boolean;
    autoUpdate: boolean;
    source: SkillSource;
    sourceRef: string;
    installedAt: string;
};
type MarketState = { version: 1; entries: Record<string, MarketEntry> };

type MarketSkill = {
    name: string;
    title: string;
    description: string;
    tag: MarketCategory;
    source: SkillSource;
    sourceRef: string;
    builtin: boolean;
    liked: boolean;
    added: boolean;
    autoUpdate: boolean;
    installedAt: string;
    fileCount: number;
    totalBytes: number;
    version: string;
    path: string;
    glyph: string;
};

const digest = (value: Buffer | string) => crypto.createHash("sha256").update(value).digest("hex");
const nowIso = () => new Date().toISOString();

function emptyState(): MarketState {
    return { version: 1, entries: {} };
}

function statePath(workspacePath: string) {
    return path.join(workspacePath, ".canvas-runtime", "skill-market", "state.json");
}

function readState(workspacePath: string): { state: MarketState; bytes: Buffer; revision: string } {
    const file = statePath(workspacePath);
    try {
        const bytes = fs.readFileSync(file);
        const parsed = JSON.parse(bytes.toString("utf8")) as MarketState;
        if (parsed.version !== 1 || typeof parsed.entries !== "object" || !parsed.entries) throw new Error("技能广场状态文件格式不正确");
        return { state: parsed, bytes, revision: digest(bytes) };
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            const bytes = Buffer.from(`${JSON.stringify(emptyState(), null, 2)}\n`, "utf8");
            return { state: emptyState(), bytes, revision: digest(bytes) };
        }
        throw error;
    }
}

/** 原子写状态文件，带 revision 乐观锁；成功返回新 revision。 */
function writeState(workspacePath: string, next: MarketState, expectedRevision?: string): string {
    const file = statePath(workspacePath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const current = readState(workspacePath);
    if (expectedRevision !== undefined && current.revision !== expectedRevision) {
        const error = new Error("技能广场状态已被其他窗口修改，请刷新后重试") as Error & { status: number };
        error.status = 409;
        throw error;
    }
    const bytes = Buffer.from(`${JSON.stringify(next, null, 2)}\n`, "utf8");
    const temporary = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
    fs.writeFileSync(temporary, bytes, { encoding: "utf8", flag: "wx" });
    try { fs.renameSync(temporary, file); }
    catch (error) { fs.rmSync(temporary, { force: true }); throw error; }
    return digest(bytes);
}

/** 校验技能名并解析到已安装技能目录（禁止越界与符号链接）。 */
function safeDirectory(workspacePath: string, name: unknown, mustExist: boolean) {
    if (typeof name !== "string" || !NAME_PATTERN.test(name)) {
        const error = new Error("技能名不合法（只允许小写字母、数字与短横线）") as Error & { status: number };
        error.status = 400;
        throw error;
    }
    const skillsRoot = path.resolve(workspacePath, ".agents", "skills");
    const absolute = path.resolve(skillsRoot, name);
    if (path.dirname(absolute) !== skillsRoot) {
        const error = new Error("技能路径越界") as Error & { status: number };
        error.status = 400;
        throw error;
    }
    if (mustExist) {
        try {
            const stat = fs.lstatSync(absolute);
            if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("技能目录不存在");
        } catch {
            const error = new Error("找不到该技能") as Error & { status: number };
            error.status = 404;
            throw error;
        }
    }
    return { skillsRoot, absolute, relative: `.agents/skills/${name}` };
}

function parseFrontmatter(source: string): Record<string, string> {
    const result: Record<string, string> = {};
    const match = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(source);
    if (!match) return result;
    for (const line of match[1].split(/\r?\n/)) {
        const item = /^([A-Za-z][\w.-]*)[ \t]*:[ \t]*(.*)$/.exec(line);
        if (!item) continue;
        let value = item[2].trim();
        if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) value = value.slice(1, -1);
        result[item[1]] = value;
    }
    return result;
}

function directoryStats(directory: string): { fileCount: number; totalBytes: number } {
    let fileCount = 0;
    let totalBytes = 0;
    const walk = (current: string) => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            if (entry.isSymbolicLink()) continue;
            const absolute = path.join(current, entry.name);
            if (entry.isDirectory()) walk(absolute);
            else if (entry.isFile()) { fileCount += 1; totalBytes += fs.statSync(absolute).size; }
        }
    };
    walk(directory);
    return { fileCount, totalBytes };
}

function isBuiltin(name: string) {
    const projectSkill = path.join(repositoryRoot, ".agents", "skills", name, "SKILL.md");
    return fs.existsSync(projectSkill);
}

function loadSkill(workspacePath: string, name: string, state: MarketState): MarketSkill | null {
    const { absolute, relative } = safeDirectory(workspacePath, name, true);
    const entryFile = path.join(absolute, "SKILL.md");
    if (!fs.existsSync(entryFile)) return null;
    let source: string;
    try { source = fs.readFileSync(entryFile, "utf8"); }
    catch { return null; }
    const frontmatter = parseFrontmatter(source);
    const title = frontmatter.name || name;
    const description = frontmatter.description || "暂无描述";
    const version = frontmatter.version || "";
    const custom = state.entries[name];
    const builtin = isBuiltin(name);
    const rawTag = custom?.tag;
    const tag: MarketCategory = rawTag && (CATEGORIES as readonly string[]).includes(rawTag) ? rawTag as MarketCategory : "creative";
    const stats = directoryStats(absolute);
    return {
        name, title, description, tag,
        source: builtin ? "builtin" : custom?.source || "markdown",
        sourceRef: custom?.sourceRef || "",
        builtin,
        liked: Boolean(custom?.liked),
        added: builtin || Boolean(custom?.added),
        autoUpdate: Boolean(custom?.autoUpdate),
        installedAt: custom?.installedAt || "",
        fileCount: stats.fileCount,
        totalBytes: stats.totalBytes,
        version,
        path: relative,
        glyph: Array.from(title.trim())[0] || "技",
    };
}

/** workspace 技能目录 + 项目内置技能目录（后者只读呈现，属于同一广场）。 */
function collectSkillNames(workspacePath: string): string[] {
    const names = new Set<string>();
    for (const root of [path.join(repositoryRoot, ".agents", "skills"), path.resolve(workspacePath, ".agents", "skills")]) {
        try {
            for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
                if (entry.isDirectory() && !entry.isSymbolicLink() && NAME_PATTERN.test(entry.name) && fs.existsSync(path.join(root, entry.name, "SKILL.md"))) names.add(entry.name);
            }
        } catch { /* 目录不存在时忽略 */ }
    }
    return [...names].sort((a, b) => a.localeCompare(b, "zh-CN"));
}

function errorResponse(res: Response, error: unknown) {
    const status = typeof error === "object" && error && "status" in error ? Number((error as { status: number }).status) : 500;
    return res.status(status >= 400 && status < 600 ? status : 500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
}

function assertWorkspace(req: Request): string {
    const candidate = typeof req.body?.workspacePath === "string" ? req.body.workspacePath
        : typeof req.query?.workspacePath === "string" ? req.query.workspacePath : "";
    if (candidate && !path.isAbsolute(candidate)) {
        const error = new Error("工作区路径必须是绝对路径") as Error & { status: number };
        error.status = 400;
        throw error;
    }
    // 默认落在项目根：内置技能与用户安装技能都在同一棵 .agents/skills 下，网关 Agent 也读这里。
    return candidate ? path.resolve(candidate) : repositoryRoot;
}

function validRelativeFile(relative: unknown): string | null {
    if (typeof relative !== "string" || !relative || relative.includes("\0") || path.isAbsolute(relative)) return null;
    const normalized = path.posix.normalize(relative.replace(/\\/g, "/"));
    if (normalized.startsWith("..") || normalized.split("/").some(segment => segment === "..")) return null;
    return normalized;
}

export function registerSkillMarketRoutes(app: Express) {
    // 列表：内置 + 已安装 + 用户状态
    app.get("/api/skill-market/skills", (req, res) => {
        try {
            const workspacePath = assertWorkspace(req);
            const { state, revision } = readState(workspacePath);
            const skills = collectSkillNames(workspacePath).flatMap((name) => {
                try { const skill = loadSkill(workspacePath, name, state); return skill ? [skill] : []; }
                catch { return []; }
            });
            res.json({ ok: true, data: skills, revision });
        } catch (error) { errorResponse(res, error); }
    });

    // 单个技能详情（含 SKILL.md 正文）
    app.get("/api/skill-market/detail", (req, res) => {
        try {
            const workspacePath = assertWorkspace(req);
            const { absolute } = safeDirectory(workspacePath, req.query.name, true);
            const entryFile = path.join(absolute, "SKILL.md");
            if (!fs.existsSync(entryFile) || fs.lstatSync(entryFile).isSymbolicLink()) {
                return void res.status(404).json({ ok: false, error: "找不到技能入口 SKILL.md" });
            }
            const content = fs.readFileSync(entryFile, "utf8");
            const files = fs.readdirSync(absolute, { withFileTypes: true })
                .filter((item) => item.isFile() && !item.isSymbolicLink())
                .map((item) => item.name)
                .sort();
            res.json({ ok: true, data: { name: String(req.query.name), content, revision: digest(content), files } });
        } catch (error) { errorResponse(res, error); }
    });

    // 用户状态更新（收藏 / 加入 / 分类 / autoUpdate），带 revision 乐观锁
    app.post("/api/skill-market/state", (req, res) => {
        try {
            const workspacePath = assertWorkspace(req);
            const name = String(req.body?.name || "");
            if (!NAME_PATTERN.test(name)) return void res.status(400).json({ ok: false, error: "技能名不合法" });
            const patch = req.body?.patch;
            if (!patch || typeof patch !== "object") return void res.status(400).json({ ok: false, error: "缺少状态更新内容" });
            const expectedRevision = String(req.body?.expectedRevision || "");
            if (!expectedRevision) return void res.status(400).json({ ok: false, error: "缺少状态版本号" });
            const { state } = readState(workspacePath);
            const current = state.entries[name] || { tag: "creative" as MarketCategory, liked: false, added: false, autoUpdate: false, source: "markdown" as SkillSource, sourceRef: "", installedAt: "" };
            if ("tag" in patch) {
                if (!(CATEGORIES as readonly string[]).includes(String(patch.tag))) return void res.status(400).json({ ok: false, error: "技能分类不合法" });
                current.tag = patch.tag as MarketCategory;
            }
            if ("liked" in patch) current.liked = Boolean(patch.liked);
            if ("added" in patch) current.added = Boolean(patch.added);
            if ("autoUpdate" in patch) current.autoUpdate = Boolean(patch.autoUpdate);
            state.entries[name] = current;
            const revision = writeState(workspacePath, state, expectedRevision);
            res.json({ ok: true, data: { entry: current, revision } });
        } catch (error) { errorResponse(res, error); }
    });

    // 安装：Markdown（单文件）或 ZIP（base64，文件清单由前端 fflate 解出）
    app.post("/api/skill-market/install", (req, res) => {
        let installedDir: string | null = null;
        try {
            const workspacePath = assertWorkspace(req);
            const name = String(req.body?.name || "");
            const source = String(req.body?.source || "");
            if (source !== "markdown" && source !== "zip") return void res.status(400).json({ ok: false, error: "安装来源不合法" });
            const tagRaw = String(req.body?.tag || "creative");
            const tag: MarketCategory = (CATEGORIES as readonly string[]).includes(tagRaw) ? tagRaw as MarketCategory : "creative";
            const files = req.body?.files;
            if (!Array.isArray(files) || !files.length || files.length > MAX_FILES_PER_SKILL) return void res.status(400).json({ ok: false, error: `技能文件数量须在 1–${MAX_FILES_PER_SKILL} 之间` });
            const { absolute } = safeDirectory(workspacePath, name, false);
            if (fs.existsSync(absolute)) return void res.status(409).json({ ok: false, error: "同名技能已存在，请先卸载或更换名称" });
            if (isBuiltin(name)) return void res.status(409).json({ ok: false, error: "不能覆盖项目内置技能" });

            let totalBytes = 0;
            const entries: Array<{ relative: string; bytes: Buffer }> = [];
            for (const item of files) {
                const relative = validRelativeFile(item?.path);
                if (!relative) return void res.status(400).json({ ok: false, error: "技能文件路径不合法" });
                if (typeof item?.contentBase64 !== "string") return void res.status(400).json({ ok: false, error: "技能文件内容缺失" });
                const bytes = Buffer.from(item.contentBase64, "base64");
                if (bytes.length > MAX_FILE_BYTES) return void res.status(413).json({ ok: false, error: "单个技能文件不能超过 512 KB" });
                totalBytes += bytes.length;
                entries.push({ relative, bytes });
            }
            if (totalBytes > MAX_SKILL_BYTES) return void res.status(413).json({ ok: false, error: "技能包总大小不能超过 2 MB" });
            if (!entries.some((entry) => entry.relative.toLowerCase() === "skill.md")) {
                const entryWithSkillMd = entries.find((entry) => /(^|\/)SKILL\.md$/i.test(entry.relative));
                if (!entryWithSkillMd) return void res.status(400).json({ ok: false, error: "技能包缺少 SKILL.md 入口文件" });
            }

            const staging = `${absolute}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.staging`;
            fs.mkdirSync(staging, { recursive: true });
            try {
                for (const entry of entries) {
                    const target = path.resolve(staging, entry.relative);
                    if (!target.startsWith(staging + path.sep)) throw new Error("技能文件路径越界");
                    fs.mkdirSync(path.dirname(target), { recursive: true });
                    fs.writeFileSync(target, entry.bytes, { flag: "wx" });
                }
                fs.renameSync(staging, absolute);
                installedDir = absolute;
            } catch (error) {
                fs.rmSync(staging, { recursive: true, force: true });
                throw error;
            }

            const { state } = readState(workspacePath);
            state.entries[name] = { tag, liked: false, added: true, autoUpdate: false, source, sourceRef: "", installedAt: nowIso() };
            writeState(workspacePath, state);
            const skill = loadSkill(workspacePath, name, state);
            res.json({ ok: true, data: skill });
        } catch (error) {
            if (installedDir) { try { fs.rmSync(installedDir, { recursive: true, force: true }); } catch { /* 保留原始错误 */ } }
            errorResponse(res, error);
        }
    });

    // 卸载：仅用户安装的技能
    app.post("/api/skill-market/uninstall", (req, res) => {
        try {
            const workspacePath = assertWorkspace(req);
            const name = String(req.body?.name || "");
            if (isBuiltin(name)) return void res.status(400).json({ ok: false, error: "内置技能不能卸载" });
            const { absolute } = safeDirectory(workspacePath, name, true);
            fs.rmSync(absolute, { recursive: true, force: true });
            const { state } = readState(workspacePath);
            delete state.entries[name];
            writeState(workspacePath, state);
            res.json({ ok: true, data: { name } });
        } catch (error) { errorResponse(res, error); }
    });
}
