import fs from "node:fs";
import path from "node:path";
import { directorRoleModules, directorWorkInput, type DirectorRole, type DirectorWorkPackage, type DirectorWorkPolicy } from "@basketikun/canvas-agent/agent/work-package";
import { compilationHash } from "@basketikun/canvas-agent/drama/compilation-scope";
import { resolveAchengEngine, resolveAchengRuntime, type AchengRuntime } from "@basketikun/canvas-agent/skills/acheng";
import type { DirectorProduction } from "@basketikun/canvas-agent/drama/production-contract";

export function productionWorkPackage(owner: DirectorWorkPackage["owner"], projectId: string, revision: number, director: DirectorProduction, role: DirectorRole, scope?: DirectorWorkPackage["scope"], runtime: AchengRuntime = resolveAchengEngine(), policy?: DirectorWorkPolicy): DirectorWorkPackage {
    const professional = professionalContract(role, runtime);
    const input = directorWorkInput(director, scope);
    input.director.workflow = {}; input.director.artifacts = [];
    return { schemaVersion: 1, owner, projectId, revision, sourceHash: director.sourceHash, inputHash: input.inputHash, scope, ...professional, director: input.director, ...(policy ? { policy } : {}) };
}
export function professionalContract(role: DirectorRole, runtime: AchengRuntime = resolveAchengEngine()) {
    const modules = directorRoleModules[role];
    const skillPaths = [runtime.skillPath, ...modules.map(module => path.join(runtime.path, "modules", module, "SKILL.md")),
        ...(role === "review" ? [path.join(runtime.path, "references", "94-delivery-integrity.md")] : [])];
    for (const file of skillPaths) if (!fs.existsSync(file)) throw new Error("WORK_CONTRACT_MISSING: 专业合同文件不可读");
    return { runtimeId: runtime.runtimeId, contractHash: compilationHash({ sourceContract: runtime.sourceContract, files: skillPaths.map(file => fs.readFileSync(file, "utf8")) }), modules, skillPaths };
}
export function verifyWorkRuntime(packet: Pick<DirectorWorkPackage, "runtimeId" | "contractHash" | "skillPaths">) {
    const runtime = resolveAchengRuntime(packet.runtimeId);
    if (packet.skillPaths.some(file => !path.resolve(file).startsWith(runtime.path + path.sep))) throw new Error("WORK_CONTRACT_PATH_CHANGED");
    const contractHash = compilationHash({ sourceContract: runtime.sourceContract, files: packet.skillPaths.map(file => fs.readFileSync(file, "utf8")) });
    if (contractHash !== packet.contractHash) throw new Error("WORK_CONTRACT_CHANGED: 原专业合同已变化");
    return runtime;
}
/** Mandatory professional modules enter the request deterministically; references remain on-demand. */
export function loadWorkContract(packet: Pick<DirectorWorkPackage, "runtimeId" | "contractHash" | "skillPaths">) {
    const runtime = verifyWorkRuntime(packet);
    const text = packet.skillPaths.map(file => `\n--- 已核验并预载的专业文件 ${file} ---\n${fs.readFileSync(file, "utf8")}`).join("\n");
    return { runtime, text };
}
