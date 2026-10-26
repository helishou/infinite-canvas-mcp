import fs from "node:fs";
import { currentCompilationArtifact } from "../drama/compilation-scope.js";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { execFile, execFileSync, spawnSync, type ExecFileSyncOptionsWithStringEncoding, type SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import { directorModules, directorProductionSchema, productionOperationSchema, canonicalProduction, isSubjectPromptAssembly, resolveSubjectPictureBindingIds, productionContractVersion, productionPreflightRequestSchema, diagnosticBlocksAction, type DirectorProduction, type ProductionDiagnostic, type ProductionPreflight } from "../drama/production-contract.js";
import { productionOperationContract, schemaDiagnostics, ProductionValidationError, applyDirectorSourcePatch, ref2vaPromptDiagnostics, continuityBoundaryDiagnostics } from "../drama/production-validation.js";

const canvasRepositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const defaultAchengHome = () => path.resolve(process.env.INFINITE_CANVAS_ACHENG_HOME || path.join(canvasRepositoryRoot, ".canvas-runtime"));

let discoveredPython: string | undefined;
let discoveredPythonLauncher: string[] | undefined;
let useDiscoveredPythonLauncher = false;
/** Only isolated compilation copies consume Backend-approved bindings; never change authored source. */
function hydrateScopedApprovedInputs(director: DirectorProduction, resolver?: (targetId: string, label: string) => string | undefined) {
    if (!director.source._canvas_compilation_scope || !resolver) return;
    const scope = director.source._canvas_compilation_scope as Record<string, any>;
    for (const segment of (director.source.segments || []) as Array<Record<string, any>>) {
        const shift = scope.frameShifts?.[segment.shot_ids?.[0]] || 0;
        for (const ref of [...(segment.references || []), ...(segment.subjects || [])]) {
            if (typeof ref.start_frame !== "number" || typeof ref.end_frame !== "number") continue;
            const outside = ref.start_frame < segment.start_frame || ref.end_frame > segment.end_frame;
            if (outside && ref.start_frame + shift >= segment.start_frame && ref.end_frame + shift <= segment.end_frame) {
                ref.start_frame += shift; ref.end_frame += shift;
            }
        }
    }
    const plans = Array.isArray(director.source.asset_plan) ? director.source.asset_plan as Array<Record<string, any>> : [];
    const files = new Map<string, string>();
    for (const plan of plans) {
        const id = String(plan.asset_id || plan.id || ""), asset = director.assets[id];
        if (!asset || !["approved", "generated"].includes(asset.status)) continue;
        const file = resolver(id, "asset");
        if (!file || !fs.existsSync(file)) throw new Error(`素材 ${id} 缺少真实编译输入`);
        if (!asset.sha256 || crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") !== asset.sha256) throw new Error(`素材 ${id} 字节已变化`);
        if (plan.version && String(plan.version) !== asset.version) throw new Error(`素材 ${id} 的源版本未更新`);
        plan.status = asset.status; plan.file = file; plan.sha256 = asset.sha256;
        files.set(id, file);
    }
    const source = director.source as Record<string, any>;
    const anchor = source.style_lock && director.assets[source.style_lock.anchor_asset_id];
    const anchorFile = source.style_lock && files.get(source.style_lock.anchor_asset_id);
    if (anchorFile && anchor && ["approved", "generated"].includes(anchor.status)) {
        if (source.style_lock.anchor_version !== anchor.version) throw new Error("风格母图版本与风格绑定不符");
        source.style_lock.status = anchor.status;
        source.style_lock.approved_file = anchorFile;
        source.style_lock.approved_sha256 = anchor.sha256;
    }
    for (const item of [...(source.asset_cards || []), ...(source.segments || [])]) for (const ref of item.references || []) {
        const id = String(ref.asset_id || ""), asset = director.assets[id], file = files.get(id);
        if (!file || !asset) continue;
        if (ref.asset_version && ref.asset_version !== asset.version || ref.sha256 && ref.sha256 !== asset.sha256) throw new Error(`参考 ${id} 声明的批准版本已过期`);
        ref.file = file; ref.sha256 = asset.sha256;
    }
    director.sourceHash = crypto.createHash("sha256").update(canonicalProduction(director.source)).digest("hex");
}

/** Freeze only the selected Subject and keyframe image results into the compiler's scratch source. */
function hydrateSubjectPictureSources(director: DirectorProduction, resolver?: (targetId: string, label: string) => string | undefined) {
    if (!isSubjectPromptAssembly(director.source) || !resolver) return;
    const subjects = (Array.isArray(director.source.subject_registry) ? director.source.subject_registry : []) as Array<Record<string, any>>;
    const subjectById = new Map(subjects.map(subject => [String(subject.id), subject]));
    const selected = new Map<string, { assetId: string; subjectId: string; kind: "subject" | "keyframe" | "composition"; role: string; binding: Record<string, any> }>();
    const segments = (Array.isArray(director.source.segments) ? director.source.segments : []) as Array<Record<string, any>>;
    const videoShotIds = new Set(segments
        .flatMap(segment => (segment.shot_ids || []).map(String)));
    // Scoped incremental compiles only freeze Subject pictures required by
    // Ref2VA outputs. Other modes still carry subject usage for continuity,
    // but their compiler input must not require picture files that the scope
    // deliberately omitted.
    const subjectReferenceShotIds = new Set(segments.filter(segment => String(segment.mode) === "Ref2VA")
        .flatMap(segment => (segment.shot_ids || []).map(String)));
    for (const shot of (Array.isArray(director.source.shots) ? director.source.shots : []) as Array<Record<string, any>>) {
        if (!videoShotIds.has(String(shot.id))) continue;
        for (const usage of subjectReferenceShotIds.has(String(shot.id)) && Array.isArray(shot.subject_usages) ? shot.subject_usages : []) {
            const subjectId = String(usage.subjectId || "");
            const subject = subjectById.get(subjectId);
            for (const bindingId of resolveSubjectPictureBindingIds(subject, usage).bindingIds) {
                const binding = (subject?.pictureBindings || []).find((item: Record<string, any>) => String(item.id) === bindingId);
                if (binding) selected.set(bindingId, { assetId: String(binding.assetId), subjectId, kind: "subject", role: String((binding.provides || [])[0] || "identity"), binding });
            }
        }
        for (const frame of (Array.isArray(shot.keyframes) ? shot.keyframes.filter((item: Record<string, any>) => item.requiredForSubmission && item.anchor !== "composition") : []) as Array<Record<string, any>>) {
            selected.set(String(frame.id), { assetId: String(frame.assetId || frame.id), subjectId: String((frame.subjectIds || [])[0] || ""), kind: "keyframe", role: "keyframe", binding: frame });
        }
        for (const reference of (Array.isArray(shot.reference_requirements) ? shot.reference_requirements.filter((item: Record<string, any>) => item.requiredForSubmission) : []) as Array<Record<string, any>>) {
            selected.set(String(reference.id || reference.asset_id), { assetId: String(reference.asset_id), subjectId: String((reference.subjectIds || [])[0] || ""), kind: "composition", role: "composition", binding: reference });
        }
        for (const frame of (Array.isArray(shot.keyframes) ? shot.keyframes.filter((item: Record<string, any>) => item.requiredForSubmission && item.anchor === "composition") : []) as Array<Record<string, any>>) {
            selected.set(String(frame.id), { assetId: String(frame.assetId || frame.id), subjectId: String((frame.subjectIds || [])[0] || ""), kind: "composition", role: "composition", binding: frame });
        }
    }
    const snapshots: Record<string, Record<string, unknown>> = {};
    for (const [bindingId, item] of selected) {
        const asset = director.assets[item.assetId];
        const file = resolver(item.assetId, "asset");
        if (!asset?.storageKey || !asset.sha256 || !file || !fs.existsSync(file)) throw new Error("Subject picture " + bindingId + " has no frozen verified compiler file");
        const digest = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
        if (digest !== asset.sha256) throw new Error("Subject picture " + bindingId + " bytes differ from the frozen source result");
        const selectedResult = asset.selectedResult && typeof asset.selectedResult === "object"
            ? asset.selectedResult as Record<string, unknown>
            : undefined;
        snapshots[bindingId] = {
            id: bindingId, assetId: item.assetId, assetVersion: asset.version, subjectId: item.subjectId, kind: item.kind, role: item.role,
            file, sha256: digest, storageKey: asset.storageKey, nodeId: asset.nodeId || item.binding.sourceNode?.nodeId,
            resultId: item.binding.selection?.resultId || selectedResult?.imageId || "",
            generationTaskId: asset.generationTaskId || selectedResult?.taskId || "",
            retain: item.binding.retain || [], exclude: item.binding.exclude || [],
            purpose: item.binding.purpose,
            applicableState: item.binding.applicableState || {}, defaultFor: item.binding.defaultFor || [],
            anchor: item.binding.anchor, localFrame: item.binding.localFrame, requiredForSubmission: item.binding.requiredForSubmission === true,
        };
    }
    (director.source as Record<string, unknown>)._canvas_subject_picture_sources = snapshots;
    (director.source as Record<string, unknown>)._canvas_subject_source_hash = director.sourceHash;
}
/** Freeze exact source-owned audio bytes for the compiler without restoring legacy Segment.references in authored source. */
function hydrateSubjectAudioSources(director: DirectorProduction, resolver?: (targetId: string, label: string) => string | undefined) {
    if (!isSubjectPromptAssembly(director.source) || !resolver) return;
    const snapshots: Record<string, Record<string, unknown>> = {};
    for (const segment of (Array.isArray(director.source.segments) ? director.source.segments : []) as Array<Record<string, any>>) {
        for (const binding of Array.isArray(segment.audio_bindings) ? segment.audio_bindings as Array<Record<string, any>> : []) {
            const id = String(binding.id || ""), label = String(binding.label || ""), file = resolver(String(segment.id || ""), label);
            if (!id || !file || !fs.existsSync(file)) throw new Error("Subject Prompt v2 audio binding " + id + " has no frozen compiler file");
            const bytes = fs.readFileSync(file), digest = crypto.createHash("sha256").update(bytes).digest("hex");
            if (digest !== String(binding.sha256 || "")) throw new Error("Subject Prompt v2 audio binding " + id + " bytes differ from its source hash");
            snapshots[id] = { file, sha256: digest, storageKey: String(binding.storageKey || ""), nodeId: String(binding.sourceNode?.nodeId || "") };
        }
    }
    (director.source as Record<string, unknown>)._canvas_subject_audio_sources = snapshots;
}
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
                if (path.isAbsolute(candidate) && fs.existsSync(candidate)) {
                    discoveredPython = candidate;
                    discoveredPythonLauncher = [launcher, ...flags];
                    useDiscoveredPythonLauncher = process.platform === "win32" && candidate.toLowerCase().includes(`${path.sep}windowsapps${path.sep}`);
                    break;
                }
            } catch { /* A stale system launcher may coexist with a working Python. */ }
        }
        if (!discoveredPython && process.platform === "win32") {
            // Windows Store app aliases can run through PowerShell but not spawn directly.
            try {
                const prefix = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "python -c 'import sys; print(sys.base_prefix)'"], { windowsHide: true, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
                const candidate = path.join(prefix, "python.exe");
                if (path.isAbsolute(candidate) && fs.existsSync(candidate)) {
                    discoveredPython = candidate;
                    discoveredPythonLauncher = ["python"];
                    useDiscoveredPythonLauncher = candidate.toLowerCase().includes(`${path.sep}windowsapps${path.sep}`);
                }
            } catch { /* Report unavailable below; never install a replacement interpreter. */ }
        }
        if (!discoveredPython) throw new Error("Cannot resolve Acheng Python; set ACHENG_PYTHON to an existing Python executable");
        if (!path.isAbsolute(discoveredPython) || !fs.existsSync(discoveredPython)) throw new Error("Resolved Acheng Python executable does not exist");
    }
    return discoveredPython;
}

export function runAchengPython(args: string[], options: ExecFileSyncOptionsWithStringEncoding) {
    const python = resolveAchengPython();
    const runDiscoveredLauncher = () => {
        if (!discoveredPythonLauncher) return undefined;
        const result = spawnSync(discoveredPythonLauncher[0], [...discoveredPythonLauncher.slice(1), ...args], options as SpawnSyncOptionsWithStringEncoding);
        if (result.error) throw result.error;
        if (result.status !== 0) {
            const error = new Error(String(result.stderr || result.stdout || `Acheng Python exited with ${result.status ?? result.signal ?? "unknown status"}`)) as NodeJS.ErrnoException & { status?: number; stdout?: string; stderr?: string; signal?: NodeJS.Signals | null };
            error.status = result.status ?? undefined;
            error.stdout = result.stdout || "";
            error.stderr = result.stderr || "";
            error.signal = result.signal;
            throw error;
        }
        return result.stdout || "";
    };
    if (process.platform === "win32" && !process.env.ACHENG_PYTHON && useDiscoveredPythonLauncher) return runDiscoveredLauncher()!;
    try { return execFileSync(python, args, options); }
    catch (error: any) {
        if (process.platform !== "win32" || process.env.ACHENG_PYTHON || !["EPERM", "ENOENT", "EBUSY"].includes(error.code)) throw error;
        if (discoveredPythonLauncher) {
            useDiscoveredPythonLauncher = true;
            try { return runDiscoveredLauncher()!; }
            catch (launcherError: any) {
                if (!["EPERM", "ENOENT", "EBUSY"].includes(launcherError?.code)) throw launcherError;
            }
        }
        const literal = (s: string) => `'${s.replace(/'/g, "''")}'`;
        const invocation = `& python ${args.map(literal).join(" ")}`;
        const command = `$OutputEncoding=[Text.UTF8Encoding]::new($false); [Console]::InputEncoding=$OutputEncoding; [Console]::OutputEncoding=$OutputEncoding; $payload=[Console]::In.ReadToEnd(); if($payload.Length){$payload | ${invocation}}else{${invocation}}; exit $LASTEXITCODE`;
        return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], options);
    }
}

const execFileAsync = (file: string, args: string[], options: ExecFileSyncOptionsWithStringEncoding): Promise<string> => {
    const { input, ...execOptions } = options;
    const effectiveOptions = input === undefined ? execOptions : { ...execOptions, stdio: ["pipe", "pipe", "pipe"] as const };
    return new Promise((resolve, reject) => {
        const child = execFile(file, args, effectiveOptions, (error, stdout, stderr) => {
            if (error) {
                Object.assign(error, { stdout: stdout || "", stderr: stderr || "" });
                reject(error);
            } else resolve(String(stdout || ""));
        });
        if (input !== undefined) child.stdin?.end(input as string | Buffer);
        else child.stdin?.end();
    });
};

export async function resolveAchengPythonAsync(): Promise<string> {
    if (process.env.ACHENG_PYTHON) {
        if (!fs.existsSync(process.env.ACHENG_PYTHON)) throw new Error("Configured ACHENG_PYTHON executable does not exist");
        return process.env.ACHENG_PYTHON;
    }
    if (discoveredPython) return discoveredPython;
    const launchers = process.platform === "win32" ? [["py", "-3"], ["python"]] : [["python3"]];
    for (const [launcher, ...flags] of launchers) {
        try {
            const candidate = (await execFileAsync(launcher, [...flags, "-c", "import sys; print(sys.executable)"], { windowsHide: true, encoding: "utf8" })).trim();
            if (path.isAbsolute(candidate) && fs.existsSync(candidate)) {
                discoveredPython = candidate;
                discoveredPythonLauncher = [launcher, ...flags];
                useDiscoveredPythonLauncher = process.platform === "win32" && candidate.toLowerCase().includes(`${path.sep}windowsapps${path.sep}`);
                break;
            }
        } catch { /* Try the next installed launcher; never install or substitute an interpreter. */ }
    }
    if (!discoveredPython && process.platform === "win32") {
        try {
            const prefix = (await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "python -c 'import sys; print(sys.base_prefix)'"], { windowsHide: true, encoding: "utf8" })).trim();
            const candidate = path.join(prefix, "python.exe");
            if (path.isAbsolute(candidate) && fs.existsSync(candidate)) {
                discoveredPython = candidate;
                discoveredPythonLauncher = ["python"];
                useDiscoveredPythonLauncher = candidate.toLowerCase().includes(`${path.sep}windowsapps${path.sep}`);
            }
        } catch { /* Report unavailable below; never install a replacement interpreter. */ }
    }
    if (!discoveredPython) throw new Error("Cannot resolve Acheng Python; set ACHENG_PYTHON to an existing Python executable");
    if (!path.isAbsolute(discoveredPython) || !fs.existsSync(discoveredPython)) throw new Error("Resolved Acheng Python executable does not exist");
    return discoveredPython;
}

/** runAchengPython 的异步镜像：同一 Windows 发现启动器 / PowerShell 回退链，但把 Python 子进程放异步，不阻塞调用方的事件循环。execFileAsync 的错误形状（spawn 失败 code=EPERM/ENOENT/EBUSY、非零退出 code=数字）与回退判断兼容，错误原样上抛。 */
export async function runAchengPythonAsync(args: string[], options: ExecFileSyncOptionsWithStringEncoding): Promise<string> {
    const python = await resolveAchengPythonAsync();
    const runDiscoveredLauncher = async (): Promise<string | undefined> => {
        if (!discoveredPythonLauncher) return undefined;
        return await execFileAsync(discoveredPythonLauncher[0], [...discoveredPythonLauncher.slice(1), ...args], options);
    };
    if (process.platform === "win32" && !process.env.ACHENG_PYTHON && useDiscoveredPythonLauncher) return (await runDiscoveredLauncher())!;
    try {
        return await execFileAsync(python, args, options);
    } catch (error: any) {
        if (process.platform !== "win32" || process.env.ACHENG_PYTHON || !["EPERM", "ENOENT", "EBUSY"].includes(error.code)) throw error;
        if (discoveredPythonLauncher) {
            useDiscoveredPythonLauncher = true;
            try { return (await runDiscoveredLauncher())!; }
            catch (launcherError: any) {
                if (!["EPERM", "ENOENT", "EBUSY"].includes(launcherError?.code)) throw launcherError;
            }
        }
        const literal = (s: string) => `'${s.replace(/'/g, "''")}'`;
        const invocation = `& python ${args.map(literal).join(" ")}`;
        const command = `$OutputEncoding=[Text.UTF8Encoding]::new($false); [Console]::InputEncoding=$OutputEncoding; [Console]::OutputEncoding=$OutputEncoding; $payload=[Console]::In.ReadToEnd(); if($payload.Length){$payload | ${invocation}}else{${invocation}}; exit $LASTEXITCODE`;
        return await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], options);
    }
}

/** Compile authored source using the locally active compiler; never call a media model. */
/** Compiler prompts stay inside the package; media may use only exact verified resolver paths. */
export function readCompilationReference(output: string, filename: string, verifiedFiles: Array<string | undefined>) {
    // The compiler reports reference files relative to the compilation root that stages `assets/`
    // (the parent of the package output), and may report an absolute frozen path. Try the package
    // first, then that root; both stay behind the same inside-package-or-verified-snapshot check.
    const roots = [output, path.dirname(output)];
    const candidates = path.isAbsolute(filename) ? [filename] : roots.map(root => path.resolve(root, filename));
    const canonical = (file: string) => process.platform === "win32" ? path.resolve(file).toLowerCase() : path.resolve(file);
    for (const resolved of candidates) {
        const inside = roots.some(root => canonical(resolved).startsWith(canonical(root) + path.sep));
        if (!inside && !verifiedFiles.some(file => file && canonical(file) === canonical(resolved))) continue;
        if (fs.existsSync(resolved)) return fs.readFileSync(resolved);
    }
    throw new Error("Compiler reference path is not in the package or verified media snapshot");
}

function storyboardBindingIdForAsset(assetId: string) {
    if (!assetId.startsWith("storyboard:")) return "";
    try { return decodeURIComponent(assetId.slice("storyboard:".length)); }
    catch { return ""; }
}

function isSelectedArchivedKeyframe(director: DirectorProduction, assetId: string, storageKey: string, digest: string) {
    const asset = director.assets[assetId];
    if (!asset || asset.nodeId || asset.storageKey !== storageKey || asset.sha256 !== digest || !storyboardBindingIdForAsset(assetId)) return false;
    return (Array.isArray(director.source.shots) ? director.source.shots : []).some((shot: any) =>
        (Array.isArray(shot.keyframes) ? shot.keyframes : []).some((frame: any) =>
            String(frame.assetId || frame.id || "") === assetId
            && frame.requiredForSubmission !== false && frame.anchor !== "composition"
            && !frame.sourceNode
            && frame.selection?.mode === "selected_result"
            && String(frame.selection.resultId || "") === storageKey));
}

export function compileAchengDirector(input: DirectorProduction, directory: string, resolveReferenceFile?: (targetId: string, label: string) => string | undefined, selectedRuntimeId?: string) {
    const director = directorProductionSchema.parse(structuredClone(input));
    hydrateScopedApprovedInputs(director, resolveReferenceFile);
    // Runtime metadata in the source is descriptive, never a compiler selector.
    void selectedRuntimeId;
    const runtime = resolveAchengEngine();
    director.engine = achengEngineIdentity(runtime);
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
    hydrateSubjectPictureSources(director, resolveReferenceFile);
    hydrateSubjectAudioSources(director, resolveReferenceFile);
   fs.writeFileSync(sourceFile, JSON.stringify(director.source), "utf8");
    const onlyAssets = !Array.isArray(director.source.segments) || !director.source.segments.length;
    let exitCode = 0;
    try {
        const liveCompiler = runtime.liveCompiler;
        const projectAssetCompiler = liveCompiler
            ? path.resolve(liveCompiler.directory, "../../.agents/skills/acheng-director/scripts/compile_assets.py")
            : "";
        const useProjectAssetCompiler = Boolean(onlyAssets && liveCompiler && fs.existsSync(projectAssetCompiler));
        const compiler = useProjectAssetCompiler
            ? projectAssetCompiler
            : path.join(runtime.path, "scripts", onlyAssets ? "compile_assets.py" : "compile_h3.py");
        const useLiveCompiler = Boolean(liveCompiler && (!onlyAssets || useProjectAssetCompiler));
        const args = useLiveCompiler && liveCompiler
            ? ["-B", "-X", "utf8", liveCompiler.runnerPath, compiler, liveCompiler.directory, sourceFile, "--out", output, "--draft"]
            : ["-B", "-X", "utf8", compiler, sourceFile, "--out", output, "--draft"];
        runAchengPython(args, { cwd: runtime.path, windowsHide: true, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
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
            for (const item of Array.isArray(entry.quality_diagnostics) ? entry.quality_diagnostics : []) {
                const actions = Array.isArray(item.blockingActions) ? item.blockingActions.filter((action: unknown): action is NonNullable<ProductionDiagnostic["blockingActions"]>[number] =>
                    ["edit", "compile", "apply", "publish", "generate"].includes(String(action))) : [];
                diagnostics.push({
                    code: String(item.code || "PROMPT_QUALITY"), path: String(item.path || `artifacts.${targetId}`), targetId,
                    message: String(item.message || "提示词质量建议"), severity: item.severity === "error" ? "error" : "warning", origin: "compiler", blockingActions: actions,
                });
            }
            for (const message of Array.isArray(entry.blockers) ? entry.blockers : []) {
                const missingReference = entry.status === "DRAFT_MISSING_REFERENCES";
                diagnostics.push({
                    code: missingReference ? "COMPILED_REFERENCE_NOT_READY" : "COMPILED_TARGET_INVALID",
                    path: `artifacts.${targetId}.references`, targetId, message: String(message),
                    severity: missingReference ? "warning" : "error", origin: "compiler",
                    blocksCompilation: !missingReference, blockingActions: [missingReference ? "generate" : "compile"],
                });
            }
            const references: DirectorProduction["artifacts"][number]["references"] = [];
            for (const ref of entry.references || entry.binding_snapshot?.references || []) {
                if (!ref.file) continue;
                const label = ref.label || `<Picture ${ref.image}>`;
                const bytes = readCompilationReference(output, ref.file, [ref.asset_id ? resolveReferenceFile?.(ref.asset_id, "asset") : undefined, resolveReferenceFile?.(targetId, label)]);
                const digest = crypto.createHash("sha256").update(bytes).digest("hex");
                const asset = ref.asset_id ? director.assets[ref.asset_id] : undefined;
                const segmentSource = (director.source.segments as Array<Record<string, any>> || []).find(segment => segment.id === targetId);
                const authoredAudio = (segmentSource?.audio_bindings as Array<Record<string, any>> || []).find(binding =>
                    binding.label === label && binding.sha256 === digest && binding.sourceNode?.nodeId && binding.storageKey);
                const old = prior.find(a => a.targetId === targetId && a.kind === kind)?.references.find(r => r.label === label && r.sha256 === digest);
                const canvasStyleAnchorId = String(director.source.style_anchor_node_id || "");
                const canvasStyleBinding = ref.canvas_style_anchor === true && ref.role === "style"
                    && String(ref.canvas_node_id || "") === canvasStyleAnchorId
                    && typeof ref.canvas_storage_key === "string" && ref.canvas_storage_key
                    ? { nodeId: canvasStyleAnchorId, storageKey: ref.canvas_storage_key, sha256: digest }
                    : undefined;
                const audioBinding = authoredAudio ? { nodeId: authoredAudio.sourceNode.nodeId, storageKey: authoredAudio.storageKey } : undefined;
                const assetId = String(ref.asset_id || "");
                const directStoryboardBinding = assetId && asset?.storageKey && isSelectedArchivedKeyframe(director, assetId, String(asset.storageKey), digest)
                    ? { assetId, bindingId: storyboardBindingIdForAsset(assetId), storageKey: String(asset.storageKey), sha256: digest }
                    : undefined;
                const binding: { nodeId?: string; bindingId?: string; assetId?: string; storageKey?: string; sha256?: string; version?: string; role?: string } | undefined =
                    asset?.nodeId && asset.storageKey && asset.sha256 === digest ? asset : canvasStyleBinding || old || audioBinding || directStoryboardBinding;
                if (!binding || !binding.storageKey || binding.sha256 !== digest || (!binding.nodeId && !binding.bindingId)) {
                    diagnostics.push({ code: "MISSING_REFERENCE_BINDING", path: `artifacts.${kind}-${targetId}.references`, targetId,
                        message: `No matching Canvas media binding for ${label}`, severity: "warning", blocksCompilation: false, blockingActions: ["generate"] });
                    ready = false; continue;
                }
                const resolvedAssetId = ref.asset_id || Object.keys(director.assets).find(id => director.assets[id].nodeId === binding.nodeId && director.assets[id].storageKey === binding.storageKey);
                const card = (director.source.asset_cards as Array<Record<string, any>> || []).find(card => card.id === targetId);
                const sourceRef = card?.references?.find((item: Record<string, any>) => item.image === ref.image);
                references.push({ label, ...(binding.nodeId ? { nodeId: binding.nodeId } : {}),
                    ...(binding.bindingId ? { bindingId: binding.bindingId } : {}),
                    ...(binding.assetId || resolvedAssetId ? { assetId: binding.assetId || resolvedAssetId } : {}),
                    storageKey: binding.storageKey, sha256: digest, role: ref.role || old?.role || "reference",
                    ...(resolvedAssetId ? { assetVersion: director.assets[resolvedAssetId]?.version } : {}),
                    ...(sourceRef?.preserve !== undefined ? { preserve: sourceRef.preserve } : {}), ...(sourceRef?.exclude !== undefined ? { exclude: sourceRef.exclude } : {}) });
            }
            director.artifacts.push({ id: `${kind}-${targetId}`, kind, targetId, prompt, sha256, sourceHash: director.sourceHash, status: ready ? "ready" : "draft", references,
               receipt: { sourceHash: director.sourceHash, promptHash: sha256, engineRuntimeId: runtime.runtimeId, engine: director.engine, validator: onlyAssets ? "compile_assets/validate_asset_entries" : "compile_h3/validate_package",
                    ...(entry.source_map ? { sourceMap: entry.source_map } : {}),
                   diagnostics: { englishWords: entry.detailed_description_english_words ?? null, detailPolicy: entry.h3_detail_policy ?? null, blockers: entry.blockers || [], formatPass: entry.format_pass || null, accepted: entry.accepted ?? ready } } });
        }
    }
    if (Array.isArray(director.source.asset_cards)) {
        director.source.asset_cards = (director.source.asset_cards as Array<Record<string, any>>).map(card => ({
            ...card,
            references: Array.isArray(card.references) ? card.references.filter((ref: Record<string, any>) => ref.canvas_style_anchor !== true) : card.references,
        }));
    }
    delete (director.source as Record<string, unknown>)._canvas_subject_picture_sources;
    delete (director.source as Record<string, unknown>)._canvas_subject_source_hash;
    delete (director.source as Record<string, unknown>)._canvas_subject_audio_sources;
    director.sourceHash = crypto.createHash("sha256").update(canonicalProduction(director.source)).digest("hex");
    for (const artifact of director.artifacts) {
        artifact.sourceHash = director.sourceHash;
        artifact.receipt.sourceHash = director.sourceHash;
    }
    const audit = JSON.parse(readFile("audit.json").toString("utf8"));
    const located: ProductionDiagnostic[] = Array.isArray(audit.diagnostics) ? audit.diagnostics.filter((item: ProductionDiagnostic) => item.code === "PROMPT_EXTERNAL_CONTEXT")
        .map((item: ProductionDiagnostic) => ({ ...item, severity: "warning" as const, blocksCompilation: false, blockingActions: [] })) : [];
    diagnostics.push(...located);
    for (const gate of audit.gates || []) if (gate.status === "FAIL") {
        for (const message of gate.errors || []) {
            if (located.length && (message.startsWith("Prompt depends on external prose:") || message.startsWith("external-context dependency:"))) continue;
            diagnostics.push({ code: "COMPILER_GATE_FAILED", path: `audit.${gate.gate}`, message, severity: "warning", origin: "compiler", blocksCompilation: false, blockingActions: [] });
        }
    }
    diagnostics.push(...validateAchengSourceInCompileWorker(director, "edit", runtime).filter(d => diagnosticBlocksAction(d, "compile")));
    return { director, exitCode, diagnostics, audit, sourceAdjustments, acceptance: JSON.parse(readFile("delivery.acceptance.json").toString("utf8")) };
}

const H3_COMPILER_FILES = [
    "scripts/compile_h3.py", "scripts/canvas_subject_prompt_v2.py", "scripts/canvas_source_contract.py",
    "scripts/canvas_h3_prompt_policy.py", "scripts/h3_contract.py", "scripts/h3_delivery.py", "scripts/h3_final_format.py",
    "scripts/style_anchor.py", "scripts/reference_bindings.py", "scripts/prompt_delivery.py", "scripts/contract_core.py",
    "scripts/audit_storyboard_quality.py", "scripts/story_contract.py", "scripts/continuity_v2.py",
];
const IMAGE_COMPILER_FILES = [
    "scripts/compile_assets.py", "scripts/asset_plan.py", "scripts/canvas_model_contract.py", "scripts/asset_delivery.py",
    "scripts/prompt_delivery.py", "scripts/reference_bindings.py", "scripts/contract_core.py", "scripts/audit_storyboard_quality.py",
    "scripts/render_delivery_view.py", "scripts/style_anchor.py", "scripts/story_contract.py", "scripts/delivery_integrity.py",
];
type AchengCompilerHashes = { h3: string; image: string };

function digestCompilerFiles(files: Array<{ key: string; path: string }>) {
    const digest = crypto.createHash("sha256");
    for (const file of files) {
        digest.update(file.key).update("\0");
        digest.update(fs.existsSync(file.path) ? fs.readFileSync(file.path) : "<missing>").update("\0");
    }
    return digest.digest("hex");
}

function compilerHashesFor(runtimePath: string, overlayDirectory?: string): AchengCompilerHashes {
    const runtimeModule = fileURLToPath(import.meta.url);
    const projectRoot = overlayDirectory ? path.resolve(overlayDirectory, "../..") : "";
    const projectSkillScripts = projectRoot ? path.join(projectRoot, ".agents/skills/acheng-director/scripts") : "";
    const runtimeFiles = (files: string[]) => files.map(file => ({ key: `runtime:${file}`, path: path.join(runtimePath, file) }));
    const overlayFiles = (files: string[]) => overlayDirectory ? files.map(file => ({ key: `overlay:${file}`, path: path.join(overlayDirectory, file) })) : [];
    const assetFiles = [
        "compile_assets.py", "asset_plan.py", "post_hooks.py", "asset_delivery.py", "prompt_delivery.py",
        "reference_bindings.py", "contract_core.py", "audit_storyboard_quality.py", "render_delivery_view.py",
    ];
    const projectAssetFiles = projectSkillScripts ? assetFiles.map(file => ({ key: `project:${file}`, path: path.join(projectSkillScripts, file) })) : [];
    const sharedModule = [{ key: "acheng-runtime-module", path: runtimeModule }];
    return {
        h3: digestCompilerFiles([
            ...runtimeFiles(H3_COMPILER_FILES),
            ...overlayFiles(["canvas_subject_prompt_v2.py", "source-contract.py", "live-compile.py"]),
            ...sharedModule,
        ]),
        image: digestCompilerFiles([
            ...runtimeFiles(IMAGE_COMPILER_FILES),
            ...overlayFiles(["live-compile.py"]),
            ...projectAssetFiles,
            ...sharedModule,
        ]),
    };
}

/** Resolve the active engine and, in the dev watcher, the current project-owned compiler overlays. */
function liveCompilerOverlay(runtimePath: string) {
    if (process.env.INFINITE_CANVAS_DEV_WATCH !== "1") return undefined;
    const candidates = [
        path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../scripts/acheng"),
        path.resolve(process.cwd(), "../scripts/acheng"),
    ];
    const directory = candidates.find(candidate => ["canvas_subject_prompt_v2.py", "source-contract.py", "live-compile.py"]
        .every(file => fs.existsSync(path.join(candidate, file))));
    if (!directory) return undefined;
    const digest = crypto.createHash("sha256");
    for (const file of ["canvas_subject_prompt_v2.py", "source-contract.py", "live-compile.py"]) {
        digest.update(file).update("\0").update(fs.readFileSync(path.join(directory, file))).update("\0");
    }
    const projectRoot = path.resolve(directory, "../..");
    const assetCompilerFiles = [
        "compile_assets.py", "asset_plan.py", "post_hooks.py", "asset_delivery.py",
        "prompt_delivery.py", "reference_bindings.py", "contract_core.py",
        "audit_storyboard_quality.py", "render_delivery_view.py",
    ];
    for (const file of assetCompilerFiles) {
        const target = path.join(projectRoot, ".agents/skills/acheng-director/scripts", file);
        if (fs.existsSync(target)) digest.update(file).update("\0").update(fs.readFileSync(target)).update("\0");
    }
    const runtimeModule = fileURLToPath(import.meta.url);
    digest.update("acheng-runtime-module").update("\0").update(fs.readFileSync(runtimeModule)).update("\0");
    return { directory, runnerPath: path.join(directory, "live-compile.py"), compilerHash: digest.digest("hex"), compilerHashes: compilerHashesFor(runtimePath, directory) };
}

export function resolveAchengEngine(home = defaultAchengHome()): AchengRuntime {
    const base = path.resolve(home, "skill-runtimes", "acheng-director");
    const state = JSON.parse(fs.readFileSync(path.join(base, "active.json"), "utf8")) as { active: { path: string; runtimeId: string; commit: string; patchVersion: string; version: string } };
    const resolved = resolveAchengRuntime(state.active.runtimeId, home);
    if (path.resolve(state.active.path) !== resolved.path) throw new Error("Acheng 激活路径与运行包不一致");
    const liveCompiler = liveCompilerOverlay(resolved.path);
    const compilerHashes = liveCompiler?.compilerHashes || compilerHashesFor(resolved.path);
    return liveCompiler ? { ...resolved, liveCompiler, compilerHash: liveCompiler.compilerHash, compilerHashes } : { ...resolved, compilerHashes };
}

// 运行时完整性校验的指纹缓存：先用微秒级 stat 比对 mtime/size，全部未变才复用上次完整校验结果；
// 任何文件被升级、替换或篡改（内容改动必然伴随大小或修改时间变化）都会触发重新 sha256 全量复核。
type ResolvedAchekRuntime = { runtimeId: string; commit: string; patchVersion: string; version: string; path: string; skillPath: string; sourceContract: any };
const runtimeVerificationCache = new Map<string, { fingerprint: string; result: ResolvedAchekRuntime }>();
export function resetAchengRuntimeCache() { runtimeVerificationCache.clear(); }

export function resolveAchengRuntime(runtimeId: string, home = defaultAchengHome()): ResolvedAchekRuntime {
    const base = path.resolve(home, "skill-runtimes", "acheng-director");
    if (!/^[a-f0-9]{40}-[a-f0-9]{16}$/.test(runtimeId)) throw new Error("Acheng runtimeId 无效");
    const directory = path.join(base, "versions", runtimeId);
    if (!directory.startsWith(`${path.join(base, "versions")}${path.sep}`)) throw new Error("Acheng 运行版本不在受管理目录");
    const manifestPath = path.join(directory, "canvas-engine.json");
    const manifestStat = fs.statSync(manifestPath);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { runtimeId: string; commit: string; patchVersion: string; version: string; files: Record<string, string> };
    if (manifest.runtimeId !== runtimeId) throw new Error("Acheng 激活记录与运行版本不一致");
    const fingerprintParts = [`${manifestStat.mtimeMs}:${manifestStat.size}`, ...Object.keys(manifest.files).sort().map(file => {
        const st = fs.statSync(path.resolve(directory, file));
        return `${file}:${st.mtimeMs}:${st.size}`;
    }), `contract:${fs.existsSync(path.join(directory, "canvas-source-contract.json")) ? JSON.stringify(fs.statSync(path.join(directory, "canvas-source-contract.json")).mtimeMs) + ":" + "" : "absent"}`];
    const cacheKey = `${home}\u0000${runtimeId}`;
    const cached = runtimeVerificationCache.get(cacheKey);
    if (cached && cached.fingerprint === fingerprintParts.join("\u0000")) return cached.result;
    for (const [file, hash] of Object.entries(manifest.files)) {
        const target = path.resolve(directory, file);
        if (!target.startsWith(`${directory}${path.sep}`) || crypto.createHash("sha256").update(fs.readFileSync(target)).digest("hex") !== hash) throw new Error(`Acheng 运行版本已改变：${file}`);
    }
    const contractPath = path.join(directory, "canvas-source-contract.json");
    const sourceContract = fs.existsSync(contractPath) ? JSON.parse(fs.readFileSync(contractPath, "utf8")) : null;
    const resolved: ResolvedAchekRuntime = { runtimeId, commit: manifest.commit, patchVersion: manifest.patchVersion, version: manifest.version, path: directory, skillPath: path.join(directory, "SKILL.md"), sourceContract };
    runtimeVerificationCache.set(cacheKey, { fingerprint: fingerprintParts.join("\u0000"), result: resolved });
    if (runtimeVerificationCache.size >= 16) { const firstKey = runtimeVerificationCache.keys().next().value; if (firstKey) runtimeVerificationCache.delete(firstKey); }
    return resolved;
}

export function getProductionContract(
    runtimeId?: string,
    operationType?: string,
    moduleId?: typeof directorModules[number],
    includeDetails: { requests?: boolean; patchFields?: boolean; sourceContract?: boolean; moduleFile?: string; chunkBytes?: number; cursor?: string } = {},
) {
    if (!operationType && !moduleId && !includeDetails.requests && !includeDetails.patchFields && !includeDetails.sourceContract) {
        const operationTypes = productionOperationSchema.options.map(option => option.shape.type.value);
        const runtime = resolveAchengEngine();
        return {
            queryGuide: {
                purpose: "按需读取当前激活 Acheng 引擎的制作合同。省略查询范围时只返回本指南。",
                operationType: "传 contract.operations[].type 中的精确值，读取单个操作的 schema、示例和前置条件。",
                moduleId: "传 story、assets、shots、performance、effects、model 或 continuity，读取该模块说明。",
                optionalDetails: {
                    includeRequests: "与 operationType 一起传入，读取 edit/publish/compile/generate 请求 schema。",
                    includePatchFields: "与 operationType 一起传入，读取完整 patch_director_source 字段 allowlist。",
                    includeSourceContract: "与 operationType 一起传入，读取完整源稿校验合同。",
                },
                examples: [
                    { operationType: "set_director_brief" },
                    { moduleId: "shots" },
                    { operationType: "patch_director_source", includePatchFields: true },
                ],
                availableOperationTypes: operationTypes,
                availableModuleIds: directorModules,
            },
            engine: { runtimeId: runtime.runtimeId, commit: runtime.commit, patchVersion: runtime.patchVersion, version: runtime.version },
            ...(runtimeId ? { notice: "runtimeId is deprecated and does not select a compiler; this contract uses the locally active Acheng runtime." } : {}),
        };
    }
    const runtime = resolveAchengEngine();
    const moduleRegistryPath = path.join(runtime.path, "data", "module-registry.json");
    const moduleRegistry = JSON.parse(fs.readFileSync(moduleRegistryPath, "utf8"));
    const moduleRow = moduleId ? moduleRegistry.modules.find((item: any) => item.id === moduleId) : undefined;
    if (moduleId && !moduleRow) throw new Error(`Active Acheng runtime does not define module ${moduleId}`);
    const modulePaths = moduleRow ? [...new Set([moduleRow.entry, ...moduleRow.reads] as string[])] : [];
    const moduleFile = includeDetails.moduleFile;
    if (moduleFile && !modulePaths.includes(moduleFile)) throw new Error(`Unknown module file for ${moduleId}: ${moduleFile}`);
    const moduleFiles = moduleRow ? modulePaths.map((relative: string) => {
        const file = path.resolve(runtime.path, relative);
        if (!file.startsWith(`${path.resolve(runtime.path)}${path.sep}`)) throw new Error("Module resource escaped its runtime");
        const bytes = fs.readFileSync(file);
        const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
        return { path: relative, sha256, bytes: bytes.length, characters: bytes.toString("utf8").length, ...(relative === moduleFile ? { content: bytes.toString("utf8") } : {}) };
    }) : undefined;
    let moduleChunk: Record<string, unknown> | undefined;
    if (moduleFile) {
        const selected = moduleFiles!.find((file: any) => file.path === moduleFile)!;
        const value = selected.content as string;
        delete selected.content;
        const bytes = new TextEncoder().encode(value), chunkBytes = Math.min(65536, Math.max(1, Math.floor(includeDetails.chunkBytes || 32768)));
        const selection = JSON.stringify({ runtimeId: runtime.runtimeId, moduleId, moduleFile, sha256: selected.sha256 });
        let offset = 0;
        if (includeDetails.cursor) {
            let cursor: any;
            try { cursor = JSON.parse(decodeURIComponent(includeDetails.cursor)); } catch { throw new Error("INVALID_CURSOR"); }
            if (cursor.selection !== selection) throw new Error("READ_CURSOR_EXPIRED: 运行版本或模块文件已变化，请重新读取模块目录");
            offset = Number(cursor.offset);
            if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("INVALID_CURSOR");
        }
        if (offset > bytes.length || (offset < bytes.length && (bytes[offset] & 0xc0) === 0x80)) throw new Error("INVALID_CURSOR: 非 UTF-8 边界");
        let end = Math.min(bytes.length, offset + chunkBytes);
        while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
        if (end === offset && offset < bytes.length) throw new Error("CHUNK_TOO_SMALL: chunkBytes 无法容纳下一个字符");
        moduleChunk = { path: moduleFile, sha256: selected.sha256, bytes: bytes.length, offset,
            text: new TextDecoder("utf-8", { fatal: true }).decode(bytes.slice(offset, end)),
            nextCursor: end < bytes.length ? encodeURIComponent(JSON.stringify({ selection, offset: end })) : null };
    }
    const contract = operationType ? productionOperationContract(operationType, includeDetails) : { contractVersion: productionContractVersion };
    const includeSourceContract = !operationType && !moduleId || includeDetails.sourceContract;
    return { ...contract, engine: { runtimeId: runtime.runtimeId, commit: runtime.commit, patchVersion: runtime.patchVersion, version: runtime.version },
        ...(includeSourceContract ? { sourceContract: runtime.sourceContract, sourceContractNotice: runtime.sourceContract ? undefined : "The active runtime has no machine-readable Canvas source contract; compiler validation remains authoritative." } : {}),
        ...(includeSourceContract ? { ref2vaMaximumWords: runtime.sourceContract ? runtime.sourceContract.ref2vaMaximumWords : 2900 } : {}),
        ...(moduleRow ? { module: { id: moduleRow.id, owns: moduleRow.owns, checks_with: moduleRow.checks_with, check_focus: moduleRow.check_focus,
            files: moduleFiles, ...(moduleChunk ? { fileChunk: moduleChunk } : {}),
            ...(!moduleFile && moduleFiles?.length ? { nextRead: { tool: "production_get_contract", input: { moduleId, moduleFile: moduleFiles[0].path, chunkBytes: 32768 } } } : {}) } } : {}),
        ...(runtimeId ? { notice: "runtimeId is deprecated and does not select a compiler; this contract uses the locally active Acheng runtime." } : {}) };
}

export type AchengRuntime = ReturnType<typeof resolveAchengRuntime> & {
    compilerHash?: string;
    compilerHashes?: AchengCompilerHashes;
    liveCompiler?: { directory: string; runnerPath: string; compilerHash: string; compilerHashes: AchengCompilerHashes };
};
export type AchengSourceValidationScope = { shotIds: string[] };
export function achengEngineIdentity(runtime: AchengRuntime): DirectorProduction["engine"] {
    return { runtimeId: runtime.runtimeId, commit: runtime.commit, patchVersion: runtime.patchVersion, version: runtime.version,
        ...(runtime.compilerHash ? { compilerHash: runtime.compilerHash } : {}),
        ...(runtime.compilerHashes ? { compilerHashes: runtime.compilerHashes } : {}) };
}

/** Each new check follows the locally active runtime; its report records the actual validator. */
export async function auditAchengContinuity(director: DirectorProduction, targetIds?: string[], diagnosticOnly = false) {
    const runtime = resolveAchengEngine();
    const response = await runAchengPythonAsync(["-B", "-X", "utf8", path.join(runtime.path, "scripts", "continuity_v2.py")], {
        cwd: runtime.path, windowsHide: true, encoding: "utf8", input: JSON.stringify({ source: director.source, target_ids: targetIds }),
    });
    return { ...JSON.parse(response), validatorRuntimeId: runtime.runtimeId, validatorEngine: achengEngineIdentity(runtime), diagnosticOnly };
}

// 源稿契约校验的响应缓存（按 runtime+payload 哈希）。运行时升级会换 runtimeId，键自动失效；
const sourceContractResponseCache = new Map<string, string>();
export function resetAchengSourceValidationCache() { sourceContractResponseCache.clear(); }

/** Compile workers may retain the synchronous validator because they are already isolated from the Backend event loop. */
function validateAchengSourceInCompileWorker(director: DirectorProduction, stage: "edit" | "publish" | "generate", runtime: AchengRuntime): ProductionDiagnostic[] {
    if (!runtime.sourceContract) return [...ref2vaPromptDiagnostics(director, 2900), continuityBoundaryDiagnostics(director, stage), { code: "SOURCE_CONTRACT_UNAVAILABLE", path: "director.engine", message: "Active runtime has no source contract; final checks remain with the compiler", severity: "unverified" }].flat() as ProductionDiagnostic[];
    const inputJson = JSON.stringify({ source: director.source, artifacts: director.artifacts || [], stage });
    const scriptPath = path.join(runtime.path, "scripts", "canvas_source_contract.py");
    const cacheKey = crypto.createHash("sha256").update(`${runtime.runtimeId}\\u0000${scriptPath}\\u0000${inputJson}`).digest("hex");
    let response = sourceContractResponseCache.get(cacheKey);
    if (response === undefined) {
        response = runAchengPython(["-B", "-X", "utf8", scriptPath], { cwd: runtime.path, windowsHide: true, encoding: "utf8", input: inputJson });
        if (sourceContractResponseCache.size >= 256) sourceContractResponseCache.clear();
        sourceContractResponseCache.set(cacheKey, response);
    }
    const diagnostics: ProductionDiagnostic[] = JSON.parse(response).diagnostics;
    for (const item of diagnostics) if (String(item.code).startsWith("CONTINUITY_")) item.severity = "warning";
    return [...diagnostics, ...continuityBoundaryDiagnostics(director, stage)];
}

export async function validateAchengSource(director: DirectorProduction, stage: "edit" | "publish" | "generate", runtime = resolveAchengEngine(), scope?: AchengSourceValidationScope): Promise<ProductionDiagnostic[]> {
    if (!runtime.sourceContract) return [...ref2vaPromptDiagnostics(director, 2900), ...(scope ? [] : continuityBoundaryDiagnostics(director, stage)), { code: "SOURCE_CONTRACT_UNAVAILABLE", path: "director.engine", message: "Active runtime has no source contract; final checks remain with the compiler", severity: "unverified" }];
    const source = isSubjectPromptAssembly(director.source) && scope?.shotIds.length
        ? { ...director.source, _canvas_source_validation_scope: { shotIds: scope.shotIds } }
        : director.source;
    const inputJson = JSON.stringify({ source, artifacts: director.artifacts || [], stage });
    const scriptPath = path.join(runtime.path, "scripts", "canvas_source_contract.py");
    // 内容寻址缓存：同 runtime + 同 payload 的重复校验直接复用，不再每次起 Python 子进程。
    const cacheKey = crypto.createHash("sha256").update(`${runtime.runtimeId}\u0000${scriptPath}\u0000${inputJson}`).digest("hex");
    let response = sourceContractResponseCache.get(cacheKey);
    if (response === undefined) {
        response = await runAchengPythonAsync(["-B", "-X", "utf8", scriptPath], { cwd: runtime.path, windowsHide: true, encoding: "utf8", input: inputJson });
        if (sourceContractResponseCache.size >= 256) sourceContractResponseCache.clear();
        sourceContractResponseCache.set(cacheKey, response);
    }
    const sourceDiagnostics: ProductionDiagnostic[] = JSON.parse(response).diagnostics;
    for (const item of sourceDiagnostics) {
        if (item.code === "INVALID_SUBJECT_SOURCE" && item.path.includes("subject_usages.pictureBindingIds")
            && item.message.startsWith("Missing or ambiguous default binding for ")) {
            item.blockingActions = ["generate"];
            item.blocksCompilation = false;
        }
    }
    // Continuity readiness is target-scoped and comes from the persisted Backend
    // report. Source validation keeps a partial authored draft editable/publishable.
    for (const item of sourceDiagnostics) if (String(item.code).startsWith("CONTINUITY_")) item.severity = "warning";
    return [...sourceDiagnostics, ...(scope ? [] : continuityBoundaryDiagnostics(director, stage))];
}

export async function assertAchengSource(director: DirectorProduction, stage: "edit" | "publish" | "generate", runtime = resolveAchengEngine(), scope?: AchengSourceValidationScope) {
    const diagnostics = (await validateAchengSource(director, stage, runtime, scope)).filter(item => diagnosticBlocksAction(item, stage));
    if (diagnostics.length) throw new ProductionValidationError(diagnostics);
}

/** Read-only checks use the active compiler, or the runtime captured for this compilation request. */
export async function preflightCompilationDirector(raw: unknown, resolveReferenceFile?: (targetId: string, label: string) => string | undefined, selectedRuntimeId?: string): Promise<ProductionPreflight> {
    let runtime: AchengRuntime;
    void selectedRuntimeId;
    try { runtime = resolveAchengEngine(); }
    catch (error) { return { valid: false, compileReady: false, generationReady: false, contractVersion: productionContractVersion, engine: null, revision: null,
        diagnostics: [{ code: "ENGINE_UNAVAILABLE", path: "director.engine", message: error instanceof Error ? error.message : String(error), severity: "error" }] }; }
    const parsed = directorProductionSchema.safeParse(raw);
    // Previous receipts are replaced by compilation, so their staleness must not block rebuilding.
    const result = await preflightDirector(parsed.success ? { ...parsed.data, artifacts: [] } : raw, "edit", runtime);
    result.compileReady = false;
    if (parsed.success) {
        const decisions = continuityBoundaryDiagnostics(parsed.data, "compile");
        result.diagnostics = result.diagnostics.filter(item => !decisions.some(issue => issue.code === item.code && issue.targetId === item.targetId));
        result.diagnostics.push(...decisions.map(issue => ({ ...issue, severity: "warning" as const, blocksCompilation: false, blockingActions: [] })));
    }
    result.diagnostics = result.diagnostics.map(item => String(item.code).startsWith("CONTINUITY_")
        ? { ...item, severity: "warning", blocksCompilation: false, blockingActions: [] } : item);
    if (result.diagnostics.some(item => diagnosticBlocksAction(item, "compile") && ["INVALID_SCHEMA", "ENGINE_UNAVAILABLE", "ENGINE_MISMATCH"].includes(item.code))) return result;
    const director = directorProductionSchema.parse(structuredClone(raw));
    hydrateScopedApprovedInputs(director, resolveReferenceFile);
    if (JSON.stringify(director.source).includes('"legacy_fixture"')) {
        result.diagnostics.push({ code: "COMPILE_HISTORICAL_FIXTURE", path: "director.source", message: "历史示例不能作为新制作输入；请使用本次实际撰写的源稿。", severity: "error" });
        result.valid = false;
        return result;
    }
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
        const preflightScript = fileURLToPath(new URL("./compile-preflight.py", import.meta.url));
        const args = runtime.liveCompiler
            ? ["-B", "-X", "utf8", runtime.liveCompiler.runnerPath, preflightScript, runtime.liveCompiler.directory, runtime.path]
            : ["-B", "-X", "utf8", preflightScript, runtime.path];
        const response = await runAchengPythonAsync(args, {
            cwd: runtime.path, windowsHide: true, encoding: "utf8", input: JSON.stringify({ source }),
        });
        result.diagnostics.push(...JSON.parse(response).diagnostics);
    } catch (error) {
        result.diagnostics.push({ code: "COMPILE_PREFLIGHT_UNAVAILABLE", path: "director.engine", message: error instanceof Error ? error.message : String(error), severity: "error" });
    }
    result.valid = !result.diagnostics.some(item => diagnosticBlocksAction(item, "compile"));
    result.compileReady = result.valid;
    result.nextActions = result.diagnostics.filter(item => diagnosticBlocksAction(item, "compile")).map(item => item.nextAction || { action: "correct_source", message: item.message });
    return result;
}

/** Shared file/Backend check. File checks cannot establish online ownership. */
export async function preflightDirector(raw: unknown, stage: "edit" | "publish" | "generate" = "edit", selectedRuntime?: AchengRuntime): Promise<ProductionPreflight> {
    const diagnostics = schemaDiagnostics(directorProductionSchema, raw, "director");
    const result: ProductionPreflight = { valid: false, contractVersion: productionContractVersion, engine: null, revision: null, diagnostics, generationReady: false };
    if (diagnostics.length) return result;
    const director = directorProductionSchema.parse(raw);
    result.engine = director.engine;
    const digest = (value: string) => crypto.createHash("sha256").update(value).digest("hex");
    if (digest(canonicalProduction(director.source)) !== director.sourceHash) diagnostics.push({ code: "SOURCE_HASH_MISMATCH", path: "director.sourceHash", message: "Source hash differs from the full authored source", severity: "error" });
    for (const [index, artifact] of director.artifacts.entries()) {
        if (digest(artifact.prompt) !== artifact.sha256) diagnostics.push({ code: "PROMPT_HASH_MISMATCH", path: `director.artifacts.${index}.sha256`, targetId: artifact.targetId, message: "Prompt byte hash differs", severity: "error" });
        if (artifact.status === "ready" && (!currentCompilationArtifact(director, artifact) || artifact.receipt.promptHash !== artifact.sha256)) diagnostics.push({ code: "STALE_RECEIPT", path: `director.artifacts.${index}.receipt`, targetId: artifact.targetId, message: "Receipt differs from its source or prompt", severity: "error" });
    }
    try { const runtime = selectedRuntime || resolveAchengEngine(); result.engine = achengEngineIdentity(runtime); diagnostics.push(...await validateAchengSource(director, stage, runtime)); }
    catch (error) { diagnostics.push({ code: "ENGINE_UNAVAILABLE", path: "director.engine", message: error instanceof Error ? error.message : String(error), severity: "error" }); }
    diagnostics.push({ code: "ONLINE_CONTEXT_UNVERIFIED", path: "director.assets", message: "Media ownership, approvals, model availability and current revision require Backend preflight", severity: "unverified" });
    result.valid = !diagnostics.some(item => diagnosticBlocksAction(item, stage));
    return result;
}

/** Offline formal-request envelope; missing Backend context stays unverified. */
export async function preflightProductionRequest(raw: unknown, production?: { revision: number; draft: { director?: DirectorProduction }; published?: { director?: DirectorProduction } | null; publishedVersion?: number }): Promise<ProductionPreflight> {
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
    if (!diagnostics.some(item => diagnosticBlocksAction(item, input.action)) && director) {
        const checked = input.action === "compile" ? await preflightCompilationDirector(director) : await preflightDirector(director, input.action === "edit" ? "edit" : input.action === "publish" ? "publish" : "generate");
        diagnostics.push(...checked.diagnostics); result.engine = checked.engine;
        result.compileReady = input.action === "compile" && checked.compileReady;
    } else diagnostics.push({ code: "ONLINE_CONTEXT_UNVERIFIED", path: "production", message: "Current production and Backend checks remain unverified", severity: "unverified" });
    result.valid = !diagnostics.some(item => diagnosticBlocksAction(item, input.action));
    return result;
}
