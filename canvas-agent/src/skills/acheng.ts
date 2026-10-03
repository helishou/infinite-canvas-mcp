import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { directorProductionSchema, canonicalProduction, productionContractVersion, productionPreflightRequestSchema, type DirectorProduction, type ProductionDiagnostic, type ProductionPreflight } from "../drama/production-contract.js";
import { productionOperationContract, schemaDiagnostics, ProductionValidationError, applyDirectorSourcePatch, ref2vaPromptDiagnostics } from "../drama/production-validation.js";

let discoveredPython: string | undefined;
/** Resolve once; a configured executable never silently falls back. */
export function resolveAchengPython() {
    if (process.env.ACHENG_PYTHON) return process.env.ACHENG_PYTHON;
    if (!discoveredPython) {
        const launcher = process.platform === "win32" ? "py" : "python3";
        const args = [...(process.platform === "win32" ? ["-3"] : []), "-c", "import sys; print(sys.executable)"];
        try { discoveredPython = execFileSync(launcher, args, { windowsHide: true, encoding: "utf8" }).trim(); }
        catch { throw new Error("Cannot resolve Acheng Python; set ACHENG_PYTHON to an existing Python executable"); }
        if (!path.isAbsolute(discoveredPython) || !fs.existsSync(discoveredPython)) throw new Error("Resolved Acheng Python executable does not exist");
    }
    return discoveredPython;
}

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
    const contractPath = path.join(directory, "canvas-source-contract.json");
    const sourceContract = fs.existsSync(contractPath) ? JSON.parse(fs.readFileSync(contractPath, "utf8")) : null;
    return { runtimeId, commit: manifest.commit, patchVersion: manifest.patchVersion, version: manifest.version, path: directory, skillPath: path.join(directory, "SKILL.md"), sourceContract };
}

export function getProductionContract(runtimeId?: string, operationType?: string) {
    const runtime = runtimeId ? resolveAchengRuntime(runtimeId) : resolveAchengEngine();
    return { ...productionOperationContract(operationType), engine: { runtimeId: runtime.runtimeId, commit: runtime.commit, patchVersion: runtime.patchVersion, version: runtime.version },
        sourceContract: runtime.sourceContract, ref2vaMaximumWords: runtime.sourceContract ? runtime.sourceContract.ref2vaMaximumWords : 2900,
        ...(runtime.sourceContract ? {} : { notice: "This pinned historical runtime has no machine-readable Canvas source contract; its original compiler remains authoritative." }) };
}

export function validateAchengSource(director: DirectorProduction, stage: "edit" | "publish" | "generate"): ProductionDiagnostic[] {
    const runtime = resolveAchengRuntime(director.engine.runtimeId);
    if (runtime.commit !== director.engine.commit || runtime.patchVersion !== director.engine.patchVersion || runtime.version !== director.engine.version) {
        return [{ code: "ENGINE_MISMATCH", path: "director.engine", message: "Pinned runtime identity differs from the production receipt", severity: "error" }];
    }
    if (!runtime.sourceContract) return [...ref2vaPromptDiagnostics(director, 2900), { code: "SOURCE_CONTRACT_UNAVAILABLE", path: "director.engine", message: "Historical runtime: source checks remain with its original compiler", severity: "unverified" }];
    const response = execFileSync(resolveAchengPython(), ["-B", "-X", "utf8", path.join(runtime.path, "scripts", "canvas_source_contract.py")], {
        cwd: runtime.path, windowsHide: true, encoding: "utf8", input: JSON.stringify({ source: director.source, artifacts: director.artifacts || [], stage }),
    });
    return JSON.parse(response).diagnostics;
}

export function assertAchengSource(director: DirectorProduction, stage: "edit" | "publish" | "generate") {
    const diagnostics = validateAchengSource(director, stage).filter(item => item.severity === "error");
    if (diagnostics.length) throw new ProductionValidationError(diagnostics);
}

/** Shared file/Backend check. File checks cannot establish online ownership. */
export function preflightDirector(raw: unknown, stage: "edit" | "publish" | "generate" = "edit"): ProductionPreflight {
    const diagnostics = schemaDiagnostics(directorProductionSchema, raw, "director");
    const result: ProductionPreflight = { valid: false, contractVersion: productionContractVersion, engine: null, revision: null, diagnostics, generationReady: false };
    if (diagnostics.length) return result;
    const director = directorProductionSchema.parse(raw);
    result.engine = director.engine;
    const digest = (value: string) => crypto.createHash("sha256").update(value).digest("hex");
    if (digest(canonicalProduction(director.source)) !== director.sourceHash) diagnostics.push({ code: "SOURCE_HASH_MISMATCH", path: "director.sourceHash", message: "Source hash differs from the full authored source", severity: "error" });
    for (const [index, artifact] of director.artifacts.entries()) {
        if (digest(artifact.prompt) !== artifact.sha256) diagnostics.push({ code: "PROMPT_HASH_MISMATCH", path: `director.artifacts.${index}.sha256`, targetId: artifact.targetId, message: "Prompt byte hash differs", severity: "error" });
        if (artifact.status === "ready" && (artifact.sourceHash !== director.sourceHash || artifact.receipt.sourceHash !== director.sourceHash || artifact.receipt.promptHash !== artifact.sha256 || artifact.receipt.engineRuntimeId !== director.engine.runtimeId)) diagnostics.push({ code: "STALE_RECEIPT", path: `director.artifacts.${index}.receipt`, targetId: artifact.targetId, message: "Receipt differs from the fixed source/prompt/runtime", severity: "error" });
    }
    try { diagnostics.push(...validateAchengSource(director, stage)); }
    catch (error) { diagnostics.push({ code: "ENGINE_UNAVAILABLE", path: "director.engine", message: error instanceof Error ? error.message : String(error), severity: "error" }); }
    diagnostics.push({ code: "ONLINE_CONTEXT_UNVERIFIED", path: "director.assets", message: "Media ownership, approvals, model availability and current revision require Backend preflight", severity: "unverified" });
    result.valid = !diagnostics.some(item => item.severity === "error");
    return result;
}

/** Offline formal-request envelope; missing Backend context stays unverified. */
export function preflightProductionRequest(raw: unknown, production?: { revision: number; draft: { director?: DirectorProduction }; published?: { director?: DirectorProduction } | null; publishedVersion?: number }): ProductionPreflight {
    const diagnostics = schemaDiagnostics(productionPreflightRequestSchema, raw);
    const result: ProductionPreflight = { valid: false, contractVersion: productionContractVersion, engine: production?.draft.director?.engine || null, revision: production?.revision ?? null, diagnostics, generationReady: false };
    if (diagnostics.length) return result;
    const input = productionPreflightRequestSchema.parse(raw);
    if (production && input.request.expectedRevision !== production.revision) diagnostics.push({ code: "REVISION_CONFLICT", path: "request.expectedRevision", message: `Snapshot revision is ${production.revision}`, severity: "error" });
    let director = structuredClone(input.action === "generate" ? production?.published?.director : production?.draft.director);
    if (input.action === "generate" && production && production.publishedVersion !== input.request.version) diagnostics.push({ code: "VERSION_CONFLICT", path: "request.version", message: "Published snapshot version differs", severity: "error" });
    if (input.action === "edit") for (const [index, operation] of input.request.ops.entries()) {
        try {
            if (operation.type === "set_director_production") director = structuredClone(operation.director);
            else if (operation.type === "patch_director_source") {
                if (!director) throw new Error("缺少 Acheng 制作稿");
                applyDirectorSourcePatch(director, operation.entity, operation.id, operation.patch);
            } else if (operation.type === "set_director_brief" && director) applyDirectorSourcePatch(director, "brief", undefined, { value: operation.brief });
            else if (operation.type === "set_director_workflow" && director) director.workflow = { ...director.workflow, ...operation.patch };
            else diagnostics.push({ code: "OPERATION_CONTEXT_UNVERIFIED", path: `request.ops.${index}`, message: "This operation requires Backend object/ownership checks", severity: "unverified" });
        } catch (error) { diagnostics.push({ code: "INVALID_OPERATION", path: `request.ops.${index}`, targetId: "id" in operation ? String(operation.id) : undefined, message: error instanceof Error ? error.message : String(error), severity: "error" }); break; }
    }
    if (!diagnostics.some(item => item.severity === "error") && director) {
        const checked = preflightDirector(director, input.action === "edit" ? "edit" : input.action === "publish" ? "publish" : "generate");
        diagnostics.push(...checked.diagnostics); result.engine = checked.engine;
    } else diagnostics.push({ code: "ONLINE_CONTEXT_UNVERIFIED", path: "production", message: "Current production and Backend checks remain unverified", severity: "unverified" });
    result.valid = !diagnostics.some(item => item.severity === "error");
    return result;
}
