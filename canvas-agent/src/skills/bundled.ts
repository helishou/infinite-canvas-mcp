import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveAchengEngine } from "./acheng.js";

const SKILL_NAME = "canvas-video-production-sop";
const MANIFEST_NAME = "bundled-production-sop.json";
const warningsByWorkspace = new Map<string, string[]>();

type Manifest = { files: Record<string, string> };

function hash(data: Buffer) {
    return crypto.createHash("sha256").update(data).digest("hex");
}

function readManifest(file: string): Manifest | null {
    try {
        const value = JSON.parse(fs.readFileSync(file, "utf8")) as Manifest;
        return value && typeof value.files === "object" && !Array.isArray(value.files) ? value : null;
    } catch {
        return null;
    }
}

function sourceFiles(root: string, directory = root): string[] {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const absolute = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) throw new Error(`Bundled skill contains a link: ${absolute}`);
        return entry.isDirectory() ? sourceFiles(root, absolute) : entry.isFile() ? [path.relative(root, absolute)] : [];
    });
}

function plainDirectory(directory: string) {
    const stat = fs.lstatSync(directory);
    return stat.isDirectory() && !stat.isSymbolicLink();
}

function destinationParentsArePlain(root: string, destination: string) {
    let current = root;
    for (const segment of path.relative(root, path.dirname(destination)).split(path.sep).filter(Boolean)) {
        current = path.join(current, segment);
        if (fs.existsSync(current) && !plainDirectory(current)) return false;
    }
    return true;
}

/** Copy bundled SOP files to the site workspace without replacing local edits. */
export function installBundledProductionSkill(workspacePath: string, bundledPath: string): string[] {
    const warnings: string[] = [];
    const agentsPath = path.join(workspacePath, ".agents");
    const skillsPath = path.join(agentsPath, "skills");
    const target = path.join(skillsPath, SKILL_NAME);
    const manifestPath = path.join(agentsPath, MANIFEST_NAME);
    try {
        if (!fs.existsSync(path.join(bundledPath, "SKILL.md"))) throw new Error("安装包缺少画布生产 SOP");
        if (fs.existsSync(agentsPath) && !plainDirectory(agentsPath)) throw new Error(".agents 不是普通目录");
        if (fs.existsSync(skillsPath) && !plainDirectory(skillsPath)) throw new Error(".agents/skills 不是普通目录");
        if (fs.existsSync(manifestPath) && fs.lstatSync(manifestPath).isSymbolicLink()) throw new Error("SOP 清单不是普通文件");
        fs.mkdirSync(skillsPath, { recursive: true });
        const current = readManifest(manifestPath);
        if (fs.existsSync(target) && !current) {
            warnings.push("站点工作空间已有画布生产 SOP，未覆盖用户版本");
            return warnings;
        }
        if (fs.existsSync(target) && (!fs.lstatSync(target).isDirectory() || fs.lstatSync(target).isSymbolicLink())) {
            warnings.push("画布生产 SOP 目标路径不是普通目录，未安装内置版本");
            return warnings;
        }
        fs.mkdirSync(target, { recursive: true });
        const previous = current?.files || {};
        const next: Manifest = { files: { ...previous } };
        for (const relative of sourceFiles(bundledPath)) {
            const key = relative.split(path.sep).join("/");
            const source = path.join(bundledPath, relative);
            const destination = path.join(target, relative);
            if (!destinationParentsArePlain(target, destination)) {
                warnings.push(`画布生产 SOP 父目录已被替换，未覆盖：${key}`);
                continue;
            }
            const bundledBytes = fs.readFileSync(source);
            const bundledHash = hash(bundledBytes);
            const existing = fs.existsSync(destination) ? fs.lstatSync(destination) : null;
            if (existing && (!existing.isFile() || existing.isSymbolicLink())) {
                warnings.push(`画布生产 SOP 文件已被替换，未覆盖：${key}`);
                continue;
            }
            const existingHash = existing ? hash(fs.readFileSync(destination)) : "";
            if ((existing && previous[key] && existingHash !== previous[key] && existingHash !== bundledHash) || (!existing && previous[key])) {
                warnings.push(`画布生产 SOP 有本地修改，未覆盖：${key}`);
                continue;
            }
            if (existing && !previous[key] && existingHash !== bundledHash) {
                warnings.push(`画布生产 SOP 文件未被内置版本管理，未覆盖：${key}`);
                continue;
            }
            if (existingHash !== bundledHash) {
                fs.mkdirSync(path.dirname(destination), { recursive: true });
                fs.writeFileSync(destination, bundledBytes);
            }
            next.files[key] = bundledHash;
        }
        const temporary = `${manifestPath}.${process.pid}.tmp`;
        fs.writeFileSync(temporary, JSON.stringify(next, null, 2), "utf8");
        fs.renameSync(temporary, manifestPath);
    } catch (error) {
        warnings.push(`安装画布生产 SOP 失败：${error instanceof Error ? error.message : String(error)}`);
    }
    return warnings;
}

export function syncBundledProductionSkill(workspacePath: string, bundledPath: string) {
    const warnings = installBundledProductionSkill(workspacePath, bundledPath);
    try { resolveAchengEngine(); }
    catch (error) { warnings.push(`Acheng 引擎不可用，制作不得退回旧流程：${error instanceof Error ? error.message : String(error)}`); }
    warningsByWorkspace.set(workspacePath, warnings);
}

export function bundledProductionSkillWarnings(workspacePath: string) {
    return (warningsByWorkspace.get(workspacePath) || []).map((message) => ({ path: SKILL_NAME, message }));
}
