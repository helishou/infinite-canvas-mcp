import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

/** Resolve, never install or update, the engine selected by the local manager. */
export function resolveAchengEngine(home = process.env.CODEX_HOME || path.join(os.homedir(), ".codex")) {
    const base = path.resolve(home, "skill-runtimes", "acheng-director");
    const state = JSON.parse(fs.readFileSync(path.join(base, "active.json"), "utf8")) as { active: { path: string; runtimeId: string; commit: string; patchVersion: string; version: string } };
    const resolved = resolveAchengRuntime(state.active.runtimeId, home);
    if (path.resolve(state.active.path) !== resolved.path) throw new Error("Acheng 激活路径与固定版本不一致");
    return resolved;
}

export function resolveAchengRuntime(runtimeId: string, home = process.env.CODEX_HOME || path.join(os.homedir(), ".codex")) {
    const base = path.resolve(home, "skill-runtimes", "acheng-director");
    if (!/^[a-f0-9]{40}-[a-f0-9]{16}$/.test(runtimeId)) throw new Error("Acheng runtimeId 无效");
    const directory = path.join(base, "versions", runtimeId);
    if (!directory.startsWith(`${path.join(base, "versions")}${path.sep}`)) throw new Error("Acheng 运行版本不在受管理目录");
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, "canvas-engine.json"), "utf8")) as { runtimeId: string; commit: string; patchVersion: string; version: string; files: Record<string, string> };
    if (manifest.runtimeId !== runtimeId) throw new Error("Acheng 激活记录与运行版本不一致");
    for (const [file, hash] of Object.entries(manifest.files)) {
        const target = path.resolve(directory, file);
        if (!target.startsWith(`${directory}${path.sep}`) || crypto.createHash("sha256").update(fs.readFileSync(target)).digest("hex") !== hash) throw new Error(`Acheng 运行版本已改变：${file}`);
    }
    return { runtimeId, commit: manifest.commit, patchVersion: manifest.patchVersion, version: manifest.version, path: directory, skillPath: path.join(directory, "SKILL.md") };
}
