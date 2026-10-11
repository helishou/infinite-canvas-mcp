import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveAchengEngine } from "./acheng.js";

const PRODUCTION_SKILL_NAME = "canvas-video-production-sop";
const ACHENG_SKILL_NAME = "acheng-director";
const warningsByWorkspace = new Map<string, Array<{ path: string; message: string }>>();

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

function sourceFiles(root: string, directory = root, excludedTopLevel = new Set<string>()): string[] {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        if (directory === root && excludedTopLevel.has(entry.name)) return [];
        const absolute = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) throw new Error(`Bundled skill contains a link: ${absolute}`);
        return entry.isDirectory() ? sourceFiles(root, absolute, excludedTopLevel) : entry.isFile() ? [path.relative(root, absolute)] : [];
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

/** Copy an immutable Skill source into the site workspace without replacing local edits. */
function installManagedSkill(workspacePath: string, bundledPath: string, skillName: string, manifestName: string, label: string, excludedTopLevel = new Set<string>()): string[] {
    const warnings: string[] = [];
    const agentsPath = path.join(workspacePath, ".agents");
    const skillsPath = path.join(agentsPath, "skills");
    const target = path.join(skillsPath, skillName);
    const manifestPath = path.join(agentsPath, manifestName);
    try {
        if (!fs.existsSync(path.join(bundledPath, "SKILL.md"))) throw new Error(`${label}安装包缺少 SKILL.md`);
        if (fs.existsSync(agentsPath) && !plainDirectory(agentsPath)) throw new Error(".agents 不是普通目录");
        if (fs.existsSync(skillsPath) && !plainDirectory(skillsPath)) throw new Error(".agents/skills 不是普通目录");
        if (fs.existsSync(manifestPath) && fs.lstatSync(manifestPath).isSymbolicLink()) throw new Error("SOP 清单不是普通文件");
        fs.mkdirSync(skillsPath, { recursive: true });
        const current = readManifest(manifestPath);
        if (fs.existsSync(target) && !current) {
            warnings.push(`站点工作空间已有 ${label}，未覆盖用户版本`);
            return warnings;
        }
        if (fs.existsSync(target) && (!fs.lstatSync(target).isDirectory() || fs.lstatSync(target).isSymbolicLink())) {
            warnings.push(`${label} 目标路径不是普通目录，未安装内置版本`);
            return warnings;
        }
        fs.mkdirSync(target, { recursive: true });
        const previous = current?.files || {};
        const next: Manifest = { files: { ...previous } };
        for (const relative of sourceFiles(bundledPath, bundledPath, excludedTopLevel)) {
            const key = relative.split(path.sep).join("/");
            const source = path.join(bundledPath, relative);
            const destination = path.join(target, relative);
            if (!destinationParentsArePlain(target, destination)) {
                warnings.push(`${label} 父目录已被替换，未覆盖：${key}`);
                continue;
            }
            const bundledBytes = fs.readFileSync(source);
            const bundledHash = hash(bundledBytes);
            const existing = fs.existsSync(destination) ? fs.lstatSync(destination) : null;
            if (existing && (!existing.isFile() || existing.isSymbolicLink())) {
                warnings.push(`${label} 文件已被替换，未覆盖：${key}`);
                continue;
            }
            const existingHash = existing ? hash(fs.readFileSync(destination)) : "";
            if ((existing && previous[key] && existingHash !== previous[key] && existingHash !== bundledHash) || (!existing && previous[key])) {
                warnings.push(`${label} 有本地修改，未覆盖：${key}`);
                continue;
            }
            if (existing && !previous[key] && existingHash !== bundledHash) {
                warnings.push(`${label} 文件未被内置版本管理，未覆盖：${key}`);
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
        warnings.push(`安装 ${label} 失败：${error instanceof Error ? error.message : String(error)}`);
    }
    return warnings;
}

/** Install the Canvas adapter bundled with Canvas Agent. */
export function installBundledProductionSkill(workspacePath: string, bundledPath: string) {
    return installManagedSkill(workspacePath, bundledPath, PRODUCTION_SKILL_NAME, "bundled-production-sop.json", "画布生产 SOP");
}

/** Mirror the locally active, verified Acheng skill runtime, excluding its generated output directory. */
export function installAchengSkill(workspacePath: string, runtimePath: string) {
    return installManagedSkill(workspacePath, runtimePath, ACHENG_SKILL_NAME, "bundled-acheng-director.json", "Acheng Director", new Set([".git", "output"]));
}

export function syncBundledProductionSkills(workspacePath: string, bundledPath: string, achengRuntimePath?: string) {
    const warnings: Array<{ path: string; message: string }> = installBundledProductionSkill(workspacePath, bundledPath).map(message => ({ path: PRODUCTION_SKILL_NAME, message }));
    try {
        const runtimePath = achengRuntimePath || resolveAchengEngine().path;
        warnings.push(...installAchengSkill(workspacePath, runtimePath).map(message => ({ path: ACHENG_SKILL_NAME, message })));
    } catch (error) {
        warnings.push({ path: ACHENG_SKILL_NAME, message: `Acheng 引擎不可用，项目 Skill 未安装且不得退回旧流程：${error instanceof Error ? error.message : String(error)}` });
    }
    warningsByWorkspace.set(workspacePath, warnings);
}

export function bundledSkillWarnings(workspacePath: string) {
    return [...(warningsByWorkspace.get(workspacePath) || [])];
}
