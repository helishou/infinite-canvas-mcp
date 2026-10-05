import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
import { directorProductionSchema, canonicalProduction, productionContractVersion, productionPreflightRequestSchema, type DirectorProduction, type ProductionDiagnostic, type ProductionPreflight } from "../drama/production-contract.js";
import { productionOperationContract, schemaDiagnostics, ProductionValidationError, applyDirectorSourcePatch, ref2vaPromptDiagnostics, continuityBoundaryDiagnostics } from "../drama/production-validation.js";

let discoveredPython: string | undefined;
/** Resolve once; a configured executable never silently falls back. */
export function resolveAchengPython() {
    if (process.env.ACHENG_PYTHON) {
        if (!fs.existsSync(process.env.ACHENG_PYTHON)) throw new Error("Configured ACHENG_PYTHON executable does not exist");
        return process.env.ACHENG_PYTHON;
    }
    if (!discoveredPython) {
        const launchers = process.platform === "win32" ? [["py", "-3"], ["python"]] : [["python3"]];
        for (const [launcher, ...flags] of launchers) {
            try {
                const candidate = execFileSync(launcher, [...flags, "-c", "import sys; print(sys.executable)"], { windowsHide: true, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
                if (path.isAbsolute(candidate) && fs.existsSync(candidate)) { discoveredPython = candidate; break; }
            } catch { /* A stale system launcher may coexist with a working Python. */ }
        }
        if (!discoveredPython && process.platform === "win32") {
            // Windows Store app aliases can run through PowerShell but not spawn directly.
            try {
                const prefix = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "python -c 'import sys; print(sys.base_prefix)'"], { windowsHide: true, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
                const candidate = path.join(prefix, "python.exe");
                if (path.isAbsolute(candidate) && fs.existsSync(candidate)) discoveredPython = candidate;
            } catch { /* Report unavailable below; never install a replacement interpreter. */ }
        }
        if (!discoveredPython) throw new Error("Cannot resolve Acheng Python; set ACHENG_PYTHON to an existing Python executable");
        if (!path.isAbsolute(discoveredPython) || !fs.existsSync(discoveredPython)) throw new Error("Resolved Acheng Python executable does not exist");
    }
    return discoveredPython;
}

function runAchengPython(args: string[], options: ExecFileSyncOptionsWithStringEncoding) {
    try { return execFileSync(resolveAchengPython(), args, options); }
    catch (error: any) {
        if (process.platform !== "win32" || process.env.ACHENG_PYTHON || !["EPERM", "ENOENT"].includes(error.code)) throw error;
        const literal = (s: string) => `'${s.replace(/'/g, "''")}'`;
        const invocation = `& python ${args.map(literal).join(" ")}`;
        const command = `$OutputEncoding=[Text.UTF8Encoding]::new($false); [Console]::InputEncoding=$OutputEncoding; [Console]::OutputEncoding=$OutputEncoding; $payload=[Console]::In.ReadToEnd(); if($payload.Length){$payload | ${invocation}}else{${invocation}}; exit $LASTEXITCODE`;
        return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], options);
    }
}

/** Compile the pinned source with its original compiler; never call a media model. */
/** Compiler prompts stay inside the package; media may use only exact verified resolver paths. */
export function readCompilationReference(output: string, filename: string, verifiedFiles: Array<string | undefined>) {
    const resolved = path.resolve(output, filename);
    const canonical = (file: string) => process.platform === "win32" ? path.resolve(file).toLowerCase() : path.resolve(file);
    const inside = canonical(resolved).startsWith(canonical(output) + path.sep);
    if (!inside && !verifiedFiles.some(file => file && canonical(file) === canonical(resolved))) throw new Error("Compiler reference path is not in the package or verified media snapshot");
    return fs.readFileSync(resolved);
}

export function compileAchengDirector(input: DirectorProduction, directory: string, resolveReferenceFile?: (targetId: string, label: string) => string | undefined) {
    const director = directorProductionSchema.parse(structuredClone(input));
    const runtime = resolveAchengRuntime(director.engine.runtimeId);
    if (runtime.commit !== director.engine.commit || runtime.patchVersion !== director.engine.patchVersion || runtime.version !== director.engine.version) throw new Error("Pinned engine identity differs from the production");
    if (JSON.stringify(director.source).includes('"legacy_fixture"')) throw new Error("Historical fixtures cannot be submitted as new production");
    fs.mkdirSync(directory, { recursive: true });
    const sourceFile = path.join(directory, "source.json"), output = path.join(directory, "compiled");
    const plans = (Array.isArray(director.source.asset_plan) ? director.source.asset_plan : []) as Array<Record<string, any>>;
    const style = director.source.style_lock as Record<string, any> | undefined;
    const sourceAdjustments: Array<{ path: string; before: string; after: string; reason: string }> = [];
    if (style?.approved_file && path.isAbsolute(style.approved_file) && resolveReferenceFile) {
        const frozen = resolveReferenceFile(style.anchor_asset_id, "asset");
        if (frozen && frozen !== style.approved_file) { sourceAdjustments.push({ path: "style_lock.approved_file", before: style.approved_file, after: frozen, reason: "Use frozen verified style input" }); style.approved_file = frozen; }
    }
    if (style?.approved_file && !path.isAbsolute(style.approved_file)) {
        const anchor = plans.find(p => p.id === style.anchor_asset_id);
        const original = anchor?.file && path.isAbsolute(anchor.file) ? anchor.file : resolveReferenceFile?.(style.anchor_asset_id, "asset");
        if (original) {
            const bytes = fs.readFileSync(original);
            if (crypto.createHash("sha256").update(bytes).digest("hex") !== style.approved_sha256) throw new Error("Style reference bytes changed");
            if (anchor?.file && path.isAbsolute(anchor.file)) {
                sourceAdjustments.push({ path: "style_lock.approved_file", before: style.approved_file, after: anchor.file, reason: "Resolve the same verified anchor file independently of the original working directory" });
                style.approved_file = anchor.file;
            } else {
                const destination = path.resolve(directory, style.approved_file);
                if (!destination.startsWith(directory + path.sep)) throw new Error("Style reference escapes the compilation directory");
                fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.writeFileSync(destination, bytes);
            }
        }
    }
    for (const plan of plans) if (plan.file && path.isAbsolute(plan.file) && resolveReferenceFile) {
        const original = resolveReferenceFile(String(plan.id || plan.asset_id), "asset");
        if (original && original !== plan.file) { sourceAdjustments.push({ path: `asset_plan.${plan.id || plan.asset_id}.file`, before: plan.file, after: original, reason: "Use frozen verified compilation input" }); plan.file = original; }
    }
    for (const plan of plans) if (plan.file && !path.isAbsolute(plan.file)) {
        const original = resolveReferenceFile?.(plan.id, "asset");
        const destination = path.resolve(directory, plan.file);
        if (!destination.startsWith(directory + path.sep)) throw new Error("Asset path escapes the compilation directory");
        if (original) { fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.copyFileSync(original, destination); }
    }
    for (const card of (Array.isArray(director.source.asset_cards) ? director.source.asset_cards : []) as Array<Record<string, any>>) {
        for (const ref of card.references || []) {
            if (!ref.file) continue;
            if (path.isAbsolute(ref.file)) {
                const frozen = (ref.asset_id ? resolveReferenceFile?.(ref.asset_id, "asset") : undefined) || resolveReferenceFile?.(card.id, ref.label || `<Picture ${ref.image}>`);
                if (frozen && frozen !== ref.file) { sourceAdjustments.push({ path: `asset_cards.${card.id}.references.${ref.label || ref.image}.file`, before: ref.file, after: frozen, reason: "Use frozen verified compilation input" }); ref.file = frozen; }
                continue;
            }
            const destination = path.resolve(directory, ref.file);
            if (!destination.startsWith(directory + path.sep)) throw new Error("Reference path escapes the compilation directory");
            const original = (ref.asset_id ? resolveReferenceFile?.(ref.asset_id, "asset") : undefined) || resolveReferenceFile?.(card.id, ref.label || `<Picture ${ref.image}>`);
            if (original) { fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.copyFileSync(original, destination); }
        }
    }
    // Every segment must name the same frozen file as its approved asset plan.
    // Matching bytes with different paths would otherwise become a blocked draft.
    for (const segment of (Array.isArray(director.source.segments) ? director.source.segments : []) as Array<Record<string, any>>) {
        for (const ref of segment.references || []) {
            const frozen = (ref.asset_id ? resolveReferenceFile?.(ref.asset_id, "asset") : undefined) || resolveReferenceFile?.(segment.id, ref.label || `<Picture ${ref.image}>`);
            if (frozen && ref.file !== frozen) {
                sourceAdjustments.push({ path: `segments.${segment.id}.references.${ref.label || ref.image}.file`, before: String(ref.file || ""), after: frozen, reason: "Keep approved asset and segment reference on the same verified frozen file" });
                ref.file = frozen;
            }
        }
    }
    director.sourceHash = crypto.createHash("sha256").update(canonicalProduction(director.source)).digest("hex");
    fs.writeFileSync(sourceFile, JSON.stringify(director.source), "utf8");
    const onlyAssets = !Array.isArray(director.source.segments) || !director.source.segments.length;
    let exitCode = 0;
    try {
        runAchengPython(["-B", "-X", "utf8", path.join(runtime.path, "scripts", onlyAssets ? "compile_assets.py" : "compile_h3.py"), sourceFile, "--out", output, "--draft"], { cwd: runtime.path, windowsHide: true, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (error: any) {
        exitCode = error.status;
        if (exitCode !== 2 || !fs.existsSync(path.join(output, "index.json"))) throw new Error(`Acheng compiler failed: ${String(error.stderr || error.stdout || error.message).trim()}`);
    }
    const readFile = (name: string) => {
        const file = path.resolve(output, name);
        if (!file.startsWith(output + path.sep)) throw new Error("Compiler output path escapes its package");
        return fs.readFileSync(file);
    };
    const index = JSON.parse(readFile("index.json").toString("utf8"));
    const prior = director.artifacts;
    const diagnostics: ProductionDiagnostic[] = [];
    director.artifacts = [];
    for (const [kind, entries] of [["image", index.asset_prompts || index.assets || []], ["h3", index.segments || []]] as const) {
        for (const entry of entries) {
            const targetId = entry.asset_id || entry.segment_id;
            const prompt = readFile(entry.prompt_file || entry.file).toString("utf8");
            const sha256 = crypto.createHash("sha256").update(prompt).digest("hex");
            let ready = kind === "h3" ? entry.accepted === true && entry.format_pass === "PASSED" : ["PROMPT_READY", "ready-to-submit-not-generated"].includes(entry.status);
            const references: DirectorProduction["artifacts"][number]["references"] = [];
            for (const ref of entry.references || entry.binding_snapshot?.references || []) {
                if (!ref.file) continue;
                const label = ref.label || `<Picture ${ref.image}>`;
                const bytes = readCompilationReference(output, ref.file, [ref.asset_id ? resolveReferenceFile?.(ref.asset_id, "asset") : undefined, resolveReferenceFile?.(targetId, label)]);
                const digest = crypto.createHash("sha256").update(bytes).digest("hex");
                const asset = ref.asset_id ? director.assets[ref.asset_id] : undefined;
                const old = prior.find(a => a.targetId === targetId && a.kind === kind)?.references.find(r => r.label === label && r.sha256 === digest);
                const binding = asset?.nodeId && asset.storageKey && asset.sha256 === digest ? asset : old;
                if (!binding?.nodeId || !binding.storageKey || ref.sha256 !== digest) {
                    diagnostics.push({ code: "MISSING_REFERENCE_BINDING", path: `artifacts.${kind}-${targetId}.references`, targetId, message: `No matching Canvas media binding for ${label}`, severity: "error" });
                    ready = false; continue;
                }
                const assetId = ref.asset_id || Object.keys(director.assets).find(id => director.assets[id].nodeId === binding.nodeId && director.assets[id].storageKey === binding.storageKey);
                const card = (director.source.asset_cards as Array<Record<string, any>> || []).find(card => card.id === targetId);
                const sourceRef = card?.references?.find((item: Record<string, any>) => item.image === ref.image);
                references.push({ label, nodeId: binding.nodeId, storageKey: binding.storageKey, sha256: digest, role: ref.role || old?.role || "reference",
                    ...(assetId ? { assetId, assetVersion: director.assets[assetId]?.version } : {}),
                    ...(sourceRef?.preserve !== undefined ? { preserve: sourceRef.preserve } : {}), ...(sourceRef?.exclude !== undefined ? { exclude: sourceRef.exclude } : {}) });
            }
            director.artifacts.push({ id: `${kind}-${targetId}`, kind, targetId, prompt, sha256, sourceHash: director.sourceHash, status: ready ? "ready" : "draft", references,
                receipt: { sourceHash: director.sourceHash, promptHash: sha256, engineRuntimeId: runtime.runtimeId, validator: onlyAssets ? "compile_assets/validate_asset_entries" : "compile_h3/validate_package",
                    diagnostics: { englishWords: entry.detailed_description_english_words ?? null, detailPolicy: entry.h3_detail_policy ?? null, blockers: entry.blockers || [], formatPass: entry.format_pass || null, accepted: entry.accepted ?? ready } } });
        }
    }
    const audit = JSON.parse(readFile("audit.json").toString("utf8"));
    for (const gate of audit.gates || []) if (gate.status === "FAIL") {
        for (const message of gate.errors || []) diagnostics.push({ code: "COMPILER_GATE_FAILED", path: `audit.${gate.gate}`, message, severity: "error" });
    }
    diagnostics.push(...preflightDirector(director).diagnostics.filter(d => d.severity === "error"));
    return { director, exitCode, diagnostics, audit, sourceAdjustments, acceptance: JSON.parse(readFile("delivery.acceptance.json").toString("utf8")) };
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
    if (!runtime.sourceContract) return [...ref2vaPromptDiagnostics(director, 2900), ...continuityBoundaryDiagnostics(director, stage), { code: "SOURCE_CONTRACT_UNAVAILABLE", path: "director.engine", message: "Historical runtime: source checks remain with its original compiler", severity: "unverified" }];
    const response = runAchengPython(["-B", "-X", "utf8", path.join(runtime.path, "scripts", "canvas_source_contract.py")], {
        cwd: runtime.path, windowsHide: true, encoding: "utf8", input: JSON.stringify({ source: director.source, artifacts: director.artifacts || [], stage }),
    });
    return [...JSON.parse(response).diagnostics, ...continuityBoundaryDiagnostics(director, stage)];
}

export function assertAchengSource(director: DirectorProduction, stage: "edit" | "publish" | "generate") {
    const diagnostics = validateAchengSource(director, stage).filter(item => item.severity === "error");
    if (diagnostics.length) throw new ProductionValidationError(diagnostics);
}

/** Stage-aware, read-only compilation checks; the pinned compiler still validates final output. */
export function preflightCompilationDirector(raw: unknown, resolveReferenceFile?: (targetId: string, label: string) => string | undefined): ProductionPreflight {
    const parsed = directorProductionSchema.safeParse(raw);
    // Previous receipts are replaced by compilation, so their staleness must not block rebuilding.
    const result = preflightDirector(parsed.success ? { ...parsed.data, artifacts: [] } : raw, "edit");
    result.compileReady = false;
    if (parsed.success) {
        const decisions = continuityBoundaryDiagnostics(parsed.data, "compile");
        result.diagnostics = result.diagnostics.filter(item => !decisions.some(issue => issue.code === item.code && issue.targetId === item.targetId));
        result.diagnostics.push(...decisions);
    }
    if (result.diagnostics.some(item => item.severity === "error" && /CONTINUITY/.test(item.code))) { result.valid = false; result.nextActions = [{ action: "correct_source", message: "先逐项登记连续性边界，再重新编译源稿。" }]; return result; }
    if (result.diagnostics.some(item => ["INVALID_SCHEMA", "ENGINE_UNAVAILABLE", "ENGINE_MISMATCH"].includes(item.code))) return result;
    const director = directorProductionSchema.parse(structuredClone(raw));
    if (JSON.stringify(director.source).includes('"legacy_fixture"')) {
        result.diagnostics.push({ code: "COMPILE_HISTORICAL_FIXTURE", path: "director.source", message: "历史示例不能作为新制作输入；请使用本次实际撰写的源稿。", severity: "error" });
        result.valid = false;
        return result;
    }
    const runtime = resolveAchengRuntime(director.engine.runtimeId);
    const source = director.source;
    const plans = (Array.isArray(source.asset_plan) ? source.asset_plan : []).filter(plan => plan && typeof plan === "object") as Array<Record<string, any>>;
    for (const plan of plans) if (typeof plan.file === "string" && plan.file && !path.isAbsolute(plan.file)) {
        const file = resolveReferenceFile?.(String(plan.id || plan.asset_id), "asset");
        if (file) plan.file = file;
    }
    const style = source.style_lock as Record<string, any> | undefined;
    if (typeof style?.approved_file === "string" && style.approved_file && !path.isAbsolute(style.approved_file)) {
        const anchor = plans.find(plan => plan.id === style.anchor_asset_id);
        const file = anchor?.file && path.isAbsolute(anchor.file) ? anchor.file : resolveReferenceFile?.(style.anchor_asset_id, "asset");
        if (file) style.approved_file = file;
    }
    for (const card of (Array.isArray(source.asset_cards) ? source.asset_cards : []).filter(card => card && typeof card === "object") as Array<Record<string, any>>) {
        for (const ref of Array.isArray(card.references) ? card.references : []) if (ref && typeof ref.file === "string" && ref.file && !path.isAbsolute(ref.file)) {
            const file = resolveReferenceFile?.(card.id, ref.label || `<Picture ${ref.image}>`);
            if (file) ref.file = file;
        }
    }
    try {
        const response = runAchengPython(["-B", "-X", "utf8", fileURLToPath(new URL("./compile-preflight.py", import.meta.url)), runtime.path], {
            cwd: runtime.path, windowsHide: true, encoding: "utf8", input: JSON.stringify({ source }),
        });
        result.diagnostics.push(...JSON.parse(response).diagnostics);
    } catch (error) {
        result.diagnostics.push({ code: "COMPILE_PREFLIGHT_UNAVAILABLE", path: "director.engine", message: error instanceof Error ? error.message : String(error), severity: "error" });
    }
    result.valid = !result.diagnostics.some(item => item.severity === "error");
    result.compileReady = result.valid;
    result.nextActions = result.diagnostics.filter(item => item.severity === "error").map(item => item.nextAction || { action: "correct_source", message: item.message });
    return result;
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
    if (input.action === "compile" && input.request.director) director = structuredClone(input.request.director);
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
        const checked = input.action === "compile" ? preflightCompilationDirector(director) : preflightDirector(director, input.action === "edit" ? "edit" : input.action === "publish" ? "publish" : "generate");
        diagnostics.push(...checked.diagnostics); result.engine = checked.engine;
        result.compileReady = input.action === "compile" && checked.compileReady;
    } else diagnostics.push({ code: "ONLINE_CONTEXT_UNVERIFIED", path: "production", message: "Current production and Backend checks remain unverified", severity: "unverified" });
    result.valid = !diagnostics.some(item => item.severity === "error");
    return result;
}
