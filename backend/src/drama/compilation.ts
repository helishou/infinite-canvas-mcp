import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { Worker } from "node:worker_threads";
import { compileAchengDirector, resolveAchengEngine, achengEngineIdentity } from "@basketikun/canvas-agent/skills/acheng";
import { canonicalProduction, diagnosticBlocksAction, directorProductionSchema, isSubjectPromptAssembly, type DirectorProduction, type ProductionBlockingAction, type ProductionDiagnostic } from "@basketikun/canvas-agent/drama/production-contract";
import { EpisodeProductionService, ProductionConflictError } from "./production.js";
import { ProductionValidationError } from "@basketikun/canvas-agent/drama/production-validation";
import { continuityTargetBlockers } from "./continuity-reports.js";
import { WorkPool } from "@basketikun/canvas-agent/agent/production";
import { compilationScopeInput, currentCompilationArtifact, preserveCompilationProvenance, scopedCompilerInput, type CompilationScope } from "@basketikun/canvas-agent/drama/compilation-scope";

const hash = (value: unknown) => crypto.createHash("sha256").update(canonicalProduction(value)).digest("hex");
/**
 * A frozen compilation may be applied only while the authored input and the runtime
 * captured for this request still match. The saved draft keeps the engine stamp of the
 * last applied compilation until an apply succeeds, so comparing that stamp would
 * invalidate the first compile after any compiler activation; compare the runtime in
 * the freshly resolved input instead. A runtime switched while the job runs still
 * blocks, because the worker would not have used the engine frozen into the packet.
 */
export function compilationInputsUnchanged(
    identity: { engineRuntimeId: string; compilerInputFingerprint: string; baselineHash: string; scope?: CompilationScope; scopeHash?: string | undefined },
    latest: { director?: DirectorProduction; input?: DirectorProduction; manifestHash: string },
) {
    if (!latest.director || !latest.input) return false;
    if (latest.input.engine.runtimeId !== identity.engineRuntimeId) return false;
    if (latest.manifestHash !== identity.compilerInputFingerprint) return false;
    return identity.scope
        ? compilationScopeInput(latest.input, identity.scope).inputHash === identity.scopeHash
        : hash(latest.director) === identity.baselineHash;
}
type Compiler = typeof compileAchengDirector;
type MaterialItem = { bytes: Buffer; digest: string; extension: string; file: string };
type CompilationJob = { operationId: string; owner: string; id: string; expectedRevision: number; requestHash: string; requestFingerprint?: string; baselineHash: string; preparedId: string; director: DirectorProduction; references: Record<string, string>; scope?: CompilationScope; scopeHash?: string; compilerInputFingerprint?: string; reusedFromOperationId?: string; status: "queued" | "running" | "succeeded" | "blocked" | "failed" | "interrupted"; diagnostics: any[]; result?: any; continuityReceipt?: any; application?: any; createdAt: string };
const compilerPool = new WorkPool(3);
type DiagnosticLike = Partial<ProductionDiagnostic> & { severity?: string; blockingActions?: string[] };
// Only these known source/engine failures invalidate the whole compilation request.
// A missing targetId is not evidence that an otherwise valid diagnostic is global.
const GLOBAL_COMPILE_BLOCKER_CODES = [
    "COMPILE_STAGE_NOT_READY",
    "COMPILE_HISTORICAL_FIXTURE",
    "COMPILE_PREFLIGHT_UNAVAILABLE",
    "ENGINE_UNAVAILABLE",
    "ENGINE_MISMATCH",
    "INVALID_SCHEMA",
    "SOURCE_HASH_MISMATCH",
] as const;
const diagnosticForAction = (item: DiagnosticLike, action: ProductionBlockingAction) => diagnosticBlocksAction({
    code: String(item.code || "UNKNOWN_COMPILATION_DIAGNOSTIC"),
    path: String(item.path || "compile"),
    message: String(item.message || ""),
    severity: item.severity === "warning" || item.severity === "unverified" ? item.severity : "error",
    ...(item.targetId ? { targetId: String(item.targetId) } : {}),
    ...(Array.isArray(item.blockingActions) ? { blockingActions: item.blockingActions as ProductionBlockingAction[] } : {}),
    ...(typeof item.blocksCompilation === "boolean" ? { blocksCompilation: item.blocksCompilation } : {}),
}, action);
const isGlobalCompilationBlocker = (item: DiagnosticLike) =>
    !item.targetId && diagnosticForAction(item, "compile") && GLOBAL_COMPILE_BLOCKER_CODES.includes(item.code as typeof GLOBAL_COMPILE_BLOCKER_CODES[number]);
const hasUnusableCompilerResult = (exitCode: number, artifacts: unknown) =>
    exitCode !== 0 && Array.isArray(artifacts) && artifacts.length === 0;
const hasBlockingArtifactDiagnostics = (value: unknown) => {
    if (Array.isArray(value)) return value.some(item => item && typeof item === "object" && diagnosticForAction(item as DiagnosticLike, "compile"));
    if (!value || typeof value !== "object") return false;
    const report = value as Record<string, unknown>;
    if (Array.isArray(report.blockers)) return report.blockers.length > 0;
    return false;
};
function resolveCompilerSourceFiles(source: any, boundFiles: Record<string, string | undefined>) {
    const walk = (node: any, assetId?: string): any => {
        if (Array.isArray(node)) return node.map(item => walk(item, assetId));
        if (node && typeof node === "object") {
            const out: Record<string, any> = {};
            const currentAssetId = (typeof node._compiler_source_asset_id === "string" ? node._compiler_source_asset_id : undefined)
                || (typeof node.id === "string" ? node.id : undefined) || assetId;
            for (const [key, value] of Object.entries(node)) {
                if ((key === "file" || key === "approved_file") && typeof value === "string" && !path.isAbsolute(value) && currentAssetId) {
                    out[key] = boundFiles[`${currentAssetId}\0asset`] ?? value;
                } else out[key] = walk(value, currentAssetId);
            }
            return out;
        }
        return node;
    };
    return walk(source);
}
function resolveCompilerDirectorFiles(director: DirectorProduction, boundFiles: Record<string, string | undefined>): DirectorProduction {
    const source = resolveCompilerSourceFiles(director.source, boundFiles);
    return { ...director, source, sourceHash: hash(source) };
}
function schedule(work: () => Promise<void>, _createdAt: string) {
    void compilerPool.submit(work).catch(error => console.error("COMPILATION_RECEIPT_WRITE_FAILED", error instanceof Error ? error.name : "Error"));
}
const activeJobs = new Set<string>();
export const productionCompilationBusy = () => activeJobs.size > 0;
const hasFatalCompilationError = (diagnostics: DiagnosticLike[]) => diagnostics.some(isGlobalCompilationBlocker);
type CompilationAlias = { operationId: string; owner: string; id: string; expectedRevision: number; requestHash: string; requestFingerprint?: string; compilerInputFingerprint: string; reusedFromOperationId: string; createdAt: string };

/** SQLite holds frozen compiler packets; only the existing ops transaction edits production. */
export class ProductionCompilationService {
    onSettled?: (id: string) => void;
    private readonly cancelledJobs = new Set<string>();
    private readonly workers = new Map<string, Worker>();
    constructor(private service: EpisodeProductionService, private root: string, private compiler: Compiler = compileAchengDirector) {}

    private database() { return (this.service as any).storageDatabase?.(); }
    private encode(value: unknown) { return gzipSync(Buffer.from(JSON.stringify(value), "utf8")); }
    private decode<T>(value: unknown): T {
        if (!value) throw new Error("编译记录缺少持久化数据");
        return JSON.parse(gunzipSync(Buffer.from(value as Uint8Array)).toString("utf8")) as T;
    }
    private jobKey(owner: string, operationId: string) { return `${owner}\0${operationId}`; }
    private mapPersistentMediaPaths<T>(value: T, direction: "store" | "load"): T {
        const service = this.service as any;
        const visit = (item: any): any => {
            if (Array.isArray(item)) return item.map(visit);
            if (!item || typeof item !== "object") {
                if (typeof item !== "string") return item;
                if (direction === "store" && path.isAbsolute(item)) {
                    const storageKey = service.mediaStorageKeyForPath?.(item);
                    return storageKey ? `storage-key://${storageKey}` : item;
                }
                if (direction === "load" && item.startsWith("storage-key://")) return service.mediaPathForStorageKey?.(item.slice("storage-key://".length)) || item;
                return item;
            }
            const out: Record<string, unknown> = {};
            for (const [key, child] of Object.entries(item)) {
                if (direction === "store" && key === "references" && child && typeof child === "object" && !Array.isArray(child)) {
                    out[key] = Object.fromEntries(Object.entries(child as Record<string, unknown>).map(([identity, file]) => {
                        const storageKey = typeof file === "string" && path.isAbsolute(file) ? service.mediaStorageKeyForPath?.(file) : undefined;
                        return [identity, storageKey ? `storage-key://${storageKey}` : visit(file)];
                    }));
                } else out[key] = visit(child);
            }
            return out;
        };
        return visit(value);
    }
    private stabilizeCompiledDirector(value: DirectorProduction): DirectorProduction {
        const director = this.mapPersistentMediaPaths(value, "store");
        const unresolved: string[] = [];
        const inspect = (item: any, at = "director.source") => {
            if (Array.isArray(item)) return item.forEach((child, index) => inspect(child, `${at}[${index}]`));
            if (!item || typeof item !== "object") return;
            for (const [key, child] of Object.entries(item)) {
                if (["file", "approved_file"].includes(key) && typeof child === "string" && path.isAbsolute(child)) unresolved.push(`${at}.${key}`);
                else inspect(child, `${at}.${key}`);
            }
        };
        inspect(director.source);
        if (this.database() && unresolved.length) throw Object.assign(new Error(`编译产物仍含未登记的绝对媒体路径：${unresolved.join(", ")}`), { code: "COMPILATION_MEDIA_NOT_ARCHIVED" });
        const sourceChanged = hash(value.source) !== hash(director.source);
        const sourceHash = sourceChanged ? hash(director.source) : value.sourceHash;
        director.sourceHash = sourceHash;
        if (sourceChanged) for (const artifact of director.artifacts) {
            artifact.sourceHash = sourceHash;
            artifact.receipt = { ...artifact.receipt, sourceHash,
                ...(artifact.receipt.sourceMap ? { sourceMap: { ...artifact.receipt.sourceMap, sourceHash } } : {}),
                ...(artifact.receipt.compilationScope ? { compilationScope: { ...artifact.receipt.compilationScope, projectedSourceHash: sourceHash } } : {}) };
        }
        if (sourceChanged && director.workflow.currentWork) director.workflow.currentWork = { ...director.workflow.currentWork, sourceHash };
        return director;
    }

    private compilationDirector(input: DirectorProduction) {
        const director = directorProductionSchema.parse(structuredClone(input));
        preserveCompilationProvenance(director);
        if (this.compiler === compileAchengDirector) {
            const runtime = resolveAchengEngine();
            if (isSubjectPromptAssembly(director.source) && !((runtime.sourceContract as any)?.promptAssemblyVersions || []).includes(2)) {
                throw Object.assign(new Error("当前激活的 Acheng 编译器尚未支持 Subject Prompt v2；源稿已保存，尚未生成或同步 Prompt。"), { code: "SUBJECT_PROMPT_COMPILER_UNSUPPORTED" });
            }
            // Runtime metadata records the compiler used for this request. It is
            // refreshed on every compile and never selects future compiler code.
            director.engine = achengEngineIdentity(runtime);
        }
        return director;
    }

    /** Add the selected canvas image only to this compiler copy. The authored source keeps the node ID; compiled artifacts freeze its exact media binding. */
    private bindCanvasStyleAnchor(id: string, director: DirectorProduction) {
        const anchor = this.service.canvasStyleAnchorInput(id, director);
        if (!anchor) return director;
        const plans = new Map((Array.isArray(director.source.asset_plan) ? director.source.asset_plan : [])
            .filter(item => item && typeof item === "object").map((item: any) => [String(item.asset_id || item.id || ""), item]));
        for (const card of (Array.isArray(director.source.asset_cards) ? director.source.asset_cards : []).filter(item => item && typeof item === "object") as Array<Record<string, any>>) {
            const targetId = String(card.id || "");
            if (!targetId || String(plans.get(targetId)?.kind || plans.get(targetId)?.asset_type || "").toLowerCase() === "style") continue;
            const references = (Array.isArray(card.references) ? card.references : []).filter((ref: Record<string, any>) => ref && typeof ref === "object" && ref.canvas_style_anchor !== true);
            const image = references.reduce((max: number, ref: Record<string, any>) => Math.max(max, Number.isInteger(Number(ref.image)) ? Number(ref.image) : 0), 0) + 1;
            references.push({
                image,
                label: "CANVAS_STYLE_ANCHOR",
                role: "style",
                subject: "the visual rendering style",
                preserve: "medium, linework, palette, shading, and material response",
                exclude: "identity, pose, objects, composition, background, and exact lighting",
                file: anchor.filePath,
                sha256: anchor.sha256,
                canvas_style_anchor: true,
                canvas_node_id: anchor.nodeId,
                canvas_storage_key: anchor.storageKey,
            });
            card.references = references;
            card.reference_policy = "required";
        }
        return director;
    }

    private jobFile(operationId: string) { return path.join(this.root, "operations", hash(operationId) + ".json"); }
    private saveJob(job: CompilationJob | CompilationAlias, packet?: unknown, clearPacket = false) {
        const db = this.database();
        if (db) {
            const director = "director" in job ? job.director : undefined;
            const persistedJob = this.mapPersistentMediaPaths(job, "store");
            const persistedPacket = packet === undefined ? undefined : this.mapPersistentMediaPaths(packet, "store");
            const now = new Date().toISOString();
            db.db.prepare(`INSERT INTO production_compilation_jobs
                (owner, operation_id, prepared_id, status, expected_revision, source_hash, engine_runtime_id, compiler_hash, packet_gzip, packet_hash, job_gzip, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(owner, operation_id) DO UPDATE SET prepared_id=excluded.prepared_id,status=excluded.status,
                expected_revision=excluded.expected_revision,source_hash=excluded.source_hash,engine_runtime_id=excluded.engine_runtime_id,
                compiler_hash=excluded.compiler_hash,packet_gzip=CASE WHEN ? THEN NULL ELSE COALESCE(excluded.packet_gzip,production_compilation_jobs.packet_gzip) END,
                packet_hash=CASE WHEN ? THEN NULL ELSE COALESCE(excluded.packet_hash,production_compilation_jobs.packet_hash) END,
                job_gzip=excluded.job_gzip,updated_at=excluded.updated_at`).run(
                job.owner, job.operationId, "preparedId" in job ? job.preparedId : null, "status" in job ? job.status : "blocked",
                job.expectedRevision, director?.sourceHash || ("result" in job ? job.result?.sourceHash : null) || null,
                director?.engine?.runtimeId || null, director?.engine?.compilerHash || null, persistedPacket === undefined ? null : this.encode(persistedPacket),
                persistedPacket === undefined ? null : hash(persistedPacket), this.encode(persistedJob), now, now, clearPacket ? 1 : 0, clearPacket ? 1 : 0);
            return;
        }
        const file = this.jobFile(job.operationId);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const temporary = `${file}.${crypto.randomUUID()}.tmp`;
        fs.writeFileSync(temporary, JSON.stringify(job), "utf8"); fs.renameSync(temporary, file);
        if ("director" in job && this.reusableBlock(job)) {
            const index = path.join(this.root, "blocked-inputs", job.compilerInputFingerprint! + ".json");
            fs.mkdirSync(path.dirname(index), { recursive: true });
            const pending = `${index}.${crypto.randomUUID()}.tmp`;
            fs.writeFileSync(pending, JSON.stringify({ version: 1, operationId: job.operationId }), "utf8"); fs.renameSync(pending, index);
        }
    }
    private loadJob(operationId: string, owner?: string): CompilationJob | undefined {
        const db = this.database();
        if (db) {
            const rows = (owner
                ? db.db.prepare("SELECT job_gzip FROM production_compilation_jobs WHERE operation_id=? AND owner=?").all(operationId, owner)
                : db.db.prepare("SELECT job_gzip FROM production_compilation_jobs WHERE operation_id=? ORDER BY updated_at DESC").all(operationId)) as Array<{ job_gzip: Uint8Array }>;
            if (rows.length > 1 && !owner) throw new Error("编译 operationId 跨 owner 重复，无法安全解析");
            if (!rows.length) return undefined;
            const saved = this.mapPersistentMediaPaths(this.decode<CompilationJob | CompilationAlias>(rows[0].job_gzip), "load");
            if (!("director" in saved)) {
                const original = this.loadJob(saved.reusedFromOperationId, saved.owner);
                if (!original?.director || original.owner !== saved.owner || original.id !== saved.id || original.compilerInputFingerprint !== saved.compilerInputFingerprint || !this.reusableBlock(original)) throw new Error("INVALID_COMPILATION_ALIAS: 原阻塞回执不可恢复");
                return { ...original, ...saved };
            }
            return saved;
        }
        const file = this.jobFile(operationId);
        if (!fs.existsSync(file)) return undefined;
        const saved = JSON.parse(fs.readFileSync(file, "utf8")) as CompilationJob | CompilationAlias;
        if (!("director" in saved)) {
            const originalFile = this.jobFile(saved.reusedFromOperationId);
            const original = JSON.parse(fs.readFileSync(originalFile, "utf8")) as CompilationJob;
            if (!original.director || original.owner !== saved.owner || original.id !== saved.id || original.compilerInputFingerprint !== saved.compilerInputFingerprint || !this.reusableBlock(original)) throw new Error("INVALID_COMPILATION_ALIAS: 原阻塞回执不可恢复");
            return { ...original, ...saved };
        }
        return saved;
    }
    private loadPacket(preparedId: string, owner?: string, id?: string) {
        const db = this.database();
        if (db) {
            const row = db.db.prepare("SELECT owner, operation_id, packet_gzip, packet_hash FROM production_compilation_jobs WHERE prepared_id=?").get(preparedId) as { owner: string; operation_id: string; packet_gzip?: Uint8Array; packet_hash?: string } | undefined;
            if (!row?.packet_gzip) throw new Error("编译包不存在或已经完成应用归档");
            if (owner && row.owner !== owner) throw new Error("Compilation belongs to a different production");
            let storedPacket: any;
            try { storedPacket = this.decode<any>(row.packet_gzip); } catch { throw new Error("Frozen compilation bytes changed"); }
            if (!row.packet_hash || hash(storedPacket) !== row.packet_hash) throw new Error("Frozen compilation bytes changed");
            // resultHash covers the frozen, storage-key form written to SQLite.
            // Validate before expanding storage-key:// references to machine paths;
            // those runtime paths are intentionally not part of the persisted hash.
            if (!storedPacket.director || hash(storedPacket.director) !== storedPacket.resultHash) throw new Error("Frozen compilation bytes changed");
            const packet = this.mapPersistentMediaPaths(storedPacket, "load");
            if (id && packet.id !== id) throw new Error("编译包不存在或不属于当前制作对象");
            return packet;
        }
        const { packetHash, ...packet } = JSON.parse(fs.readFileSync(this.file(preparedId), "utf8"));
        if (hash(packet) !== packetHash) throw new Error("Frozen compilation bytes changed");
        if (!packet.director || hash(packet.director) !== packet.resultHash) throw new Error("Frozen compilation bytes changed");
        return packet;
    }
    private packetJob(preparedId: string) {
        const db = this.database();
        if (db) {
            const row = db.db.prepare("SELECT job_gzip FROM production_compilation_jobs WHERE prepared_id=?").get(preparedId) as { job_gzip: Uint8Array } | undefined;
            return row ? this.mapPersistentMediaPaths(this.decode<CompilationJob>(row.job_gzip), "load") : undefined;
        }
        const directory = path.join(this.root, "operations");
        if (!fs.existsSync(directory)) return undefined;
        for (const name of fs.readdirSync(directory).filter(name => name.endsWith(".json"))) {
            const job = JSON.parse(fs.readFileSync(path.join(directory, name), "utf8")) as CompilationJob;
            if (job.preparedId === preparedId) return job;
        }
        return undefined;
    }
    private workingDirectory(preparedId: string) {
        if (!/^[a-f0-9-]{36}$/i.test(preparedId)) throw new Error("Invalid compilation handle");
        return path.join(this.root, preparedId);
    }
    private savePreparedPacket(packet: any) {
        const operationId = String(packet.operationId || `compilation:${packet.preparedId}`);
        const job: CompilationJob = {
            operationId, owner: packet.owner, id: packet.id, expectedRevision: packet.expectedRevision,
            requestHash: hash({ preparedId: packet.preparedId }), baselineHash: packet.baselineHash,
            preparedId: packet.preparedId, director: packet.director, references: {}, scope: packet.scope,
            scopeHash: packet.scopeHash, status: "succeeded", diagnostics: packet.diagnostics || [],
            result: this.shortResult(packet.preparedId, packet), continuityReceipt: packet.continuityReceipt,
            createdAt: new Date().toISOString(),
        };
        this.saveJob(job, packet);
    }
    private markApplied(job: CompilationJob | undefined, receipt: any) {
        if (!job) return;
        const compact = { ...job, application: receipt, references: {}, director: { engine: job.director.engine, sourceHash: job.director.sourceHash, source: {}, artifacts: [] } as unknown as DirectorProduction };
        this.saveJob(compact, undefined, true);
    }
    private reusableBlock(job: CompilationJob) {
        const errors = job.diagnostics.filter((item: DiagnosticLike) => diagnosticForAction(item, "compile"));
        return job.status === "blocked" && Boolean(job.compilerInputFingerprint) && errors.length > 0
            && errors.every(item => item.code === "PROMPT_EXTERNAL_CONTEXT" && item.origin === "source" && item.blocksCompilation === true && item.targetId && item.path && item.matchedText);
    }
    private blockedInput(id: string, owner: string, fingerprint: string) {
        const db = this.database();
        if (db) {
            const rows = db.db.prepare("SELECT job_gzip FROM production_compilation_jobs WHERE owner=? AND status='blocked'").all(owner) as Array<{ job_gzip: Uint8Array }>;
            for (const row of rows) {
                const job = this.mapPersistentMediaPaths(this.decode<CompilationJob | CompilationAlias>(row.job_gzip), "load");
                if ("director" in job && job.id === id && job.compilerInputFingerprint === fingerprint && this.reusableBlock(job)) return job;
            }
            return undefined;
        }
        const index = path.join(this.root, "blocked-inputs", fingerprint + ".json");
        if (!fs.existsSync(index)) return undefined;
        const entry = JSON.parse(fs.readFileSync(index, "utf8"));
        if (entry.version !== 1 || typeof entry.operationId !== "string") throw new Error("UNKNOWN_COMPILATION_INDEX: 未知阻塞索引，保留原文件");
        const job = this.loadJob(entry.operationId, owner);
        return job && !job.reusedFromOperationId && job.id === id && job.owner === owner && job.compilerInputFingerprint === fingerprint && this.reusableBlock(job) ? job : undefined;
    }
    private effectiveInput(id: string, director: DirectorProduction, scope?: CompilationScope) {
        const projection = scope ? compilationScopeInput(director, scope) : undefined;
        const targetIds = projection?.targetIds || this.compilationTargets(director);
        const reusable = this.reusableArtifacts(id, director, targetIds);
        const pending = targetIds.filter(id => !reusable.some(artifact => artifact.targetId === id));
        const compileScope = scope && pending.length && reusable.length ? { ...scope, targetIds: pending } : scope;
        const compileProjection = compileScope === scope ? projection : compileScope ? compilationScopeInput(director, compileScope) : undefined;
        return { targetIds, reusable, input: compileProjection && compileScope ? scopedCompilerInput(compileProjection.director, compileScope) : director };
    }
    private inputManifestFingerprint(id: string, owner: string, director: DirectorProduction, scope?: CompilationScope) {
        const effective = this.effectiveInput(id, director, scope);
        const boundFiles = this.service.compilationReferenceFiles(id, effective.input);
        const material = this.collectMaterial(boundFiles, effective.input);
        this.resolveArchivedMaterial(material);
        const resolvedScopeSource = resolveCompilerSourceFiles(JSON.parse(JSON.stringify(effective.input.source)), boundFiles);
        const normalizedSource = JSON.parse(JSON.stringify(resolvedScopeSource), (_key, value) => {
            if (typeof value !== "string") return value;
            const match = [...material.values()].find(item => item.file === value);
            return match ? `sha256:${match.digest}` : value;
        });
        return hash({ version: 2, owner, id, source: normalizedSource, assets: effective.input.assets,
            shotInputs: effective.input.shotInputs, boundaries: effective.input.boundaries, engine: director.engine,
            scope: scope || null, targets: effective.targetIds,
            reusable: effective.reusable.map(item => ({ targetId: item.targetId, sha256: item.sha256 })),
            references: [...material].map(([identity, item]) => ({ identity, sha256: item.digest })).sort((a, b) => a.identity.localeCompare(b.identity)) });
    }
    getCompilation(id: string, owner: string, operationId: string, view: "status" | "targets" | "diagnostics" = "status", offset = 0, count?: number) {
        const job = this.loadJob(operationId, owner);
        if (!job || job.id !== id || job.owner !== owner) throw new Error("编译回执不存在或不属于当前制作对象");
        const kind = owner.includes("/canvas/") || owner === "canvas" ? "canvas" : owner.includes("/scenes/") || owner === "scene" ? "scene" : "episode";
        const application = job.application || this.applicationReceipt(job);
        const blocking = job.diagnostics.find((item: DiagnosticLike) => diagnosticForAction(item, "compile"));
        const blockingDiagnostic = blocking ? { code: blocking.code, path: blocking.path, targetId: blocking.targetId, shotId: blocking.shotId,
            origin: blocking.origin, matchedText: blocking.matchedText, blocksCompilation: blocking.blocksCompilation, message: blocking.message, nextAction: blocking.nextAction } : undefined;
        const nextAction = job.status === "queued" || job.status === "running"
            ? { action: "wait", tool: "production_get_compilation", input: { kind, id, operationId }, message: "沿原 operationId 查询；不要换 ID 重提。" }
            : job.status === "succeeded" ? { action: application ? "read_run" : "review", tool: application ? "production_get_compilation" : "production_apply_compilation", input: { kind, id, ...(application ? { operationId } : { preparedId: job.preparedId }) }, message: application ? "编译已应用，读取原应用回执。" : "编译成功，应用 preparedId。" }
            : blocking?.nextAction || { action: "correct_source", message: "读取本次诊断并定位原因；确认输入或故障条件改变后再提交。" };
        const hasCompileNotice = job.diagnostics.length > 0;
        const base = { operationId, status: job.status, verdict: job.status === "blocked" ? "blocked" : hasCompileNotice ? "passed_with_warnings" : "passed", expectedRevision: job.expectedRevision, sourceHash: job.result?.sourceHash || job.director.sourceHash,
            engineRuntimeId: job.director.engine.runtimeId, compilerHash: job.director.engine.compilerHash,
            ...(job.compilerInputFingerprint ? { compilerInputFingerprint: job.compilerInputFingerprint } : {}),
            ...(job.reusedFromOperationId ? { reused: true, reusedFromOperationId: job.reusedFromOperationId } : {}),
            ...(blockingDiagnostic ? { blockingDiagnostic } : {}), nextAction,
            ...(job.status === "succeeded" ? { preparedId: job.preparedId } : {}), ...(job.continuityReceipt ? { continuityReceipt: job.continuityReceipt } : {}), application, mediaSubmitted: false };
        if (view === "status") return { ...base, diagnosticCount: job.diagnostics.length, targetCount: job.result?.targets?.length || 0 };
        const items = view === "diagnostics" ? job.diagnostics : job.result?.targets || [];
        if (!count) throw new Error("查询编译列表必须指定 pageSize");
        return { ...base, items: items.slice(offset, offset + count), total: items.length, nextOffset: offset + count < items.length ? offset + count : null };
    }
    private applicationReceipt(job: CompilationJob) {
        if (job.status !== "succeeded") return undefined;
        const committed = this.service.operationReceipt?.(job.id, `compilation:${job.preparedId}`);
        return committed ? { revision: committed.revision, sourceHash: committed.draft.director?.sourceHash, operationId: `compilation:${job.preparedId}`, referenceSync: committed.referenceSync, mediaSubmitted: false } : undefined;
    }
    /** Subject Prompt v2 的源稿不保存 Clip 帧窗与时长（由 Shot 派生）；全量编译必须经 scoped 投影补齐这些编译字段，
     *  否则引擎预检报「视频段落编译字段缺失」。范围=全部 Segment 时 apply 走合并回写，不改写人工源稿。 */
    private authoredScope(candidate: DirectorProduction, scope?: CompilationScope) {
        if (scope) return scope;
        if (!isSubjectPromptAssembly(candidate.source)) return undefined;
        const segments = Array.isArray(candidate.source.segments) ? candidate.source.segments : [];
        // A Segment's stable compilation target is always segment.id. It may carry a
        // reference asset_id after Subject media resolution, which must not replace the
        // Clip scope identity.
        const targetIds = segments.map(segment => String((segment as Record<string, any>).id || "")).filter(Boolean);
        return targetIds.length ? { targetIds } : undefined;
    }

    enqueue(id: string, owner: string, operationId: string, expectedRevision: number, candidate?: DirectorProduction, scope?: CompilationScope) {
        const requestFingerprint = hash({ id, owner, expectedRevision, candidate: candidate ?? null, scope: scope ?? null });
        const prior = this.loadJob(operationId, owner);
        if (prior) {
            const sameRequest = prior.requestFingerprint
                ? prior.requestFingerprint === requestFingerprint
                : prior.id === id && prior.owner === owner && prior.expectedRevision === expectedRevision &&
                    (!candidate && !scope || prior.requestHash === hash({ id, owner, expectedRevision, candidate, scope: prior.scope }));
            if (!sameRequest) throw new Error("IDEMPOTENCY_CONFLICT: operationId 已用于不同编译请求");
            return { ...this.getCompilation(id, owner, operationId), replayed: true };
        }
        const current = this.service.get(id);
        if (expectedRevision > current.revision) throw new ProductionConflictError(current);
        if (!current.draft.director) throw new Error("缺少正式导演源稿");
        if (candidate && current.revision !== expectedRevision && hash(candidate) !== hash(current.draft.director)) throw new ProductionConflictError(current);
        const snapshotRevision = current.revision;
        scope = this.authoredScope(candidate || current.draft.director, scope);
        const requestHash = requestFingerprint;
        const compileInputDiagnostics: ProductionDiagnostic[] = [];
        const director = this.bindCanvasStyleAnchor(id, this.service.resolveSubjectPictureInputs(id, this.compilationDirector(candidate || current.draft.director), scope?.targetIds, true, undefined, compileInputDiagnostics));
        if (scope && this.compiler === compileAchengDirector && !resolveAchengEngine().sourceContract?.scopedCompilation) throw new Error("SCOPED_COMPILATION_UNSUPPORTED: 当前激活引擎不支持按场次编译，请更新本机引擎");
        const effective = this.effectiveInput(id, director, scope);
        const boundFiles = this.service.compilationReferenceFiles(id, effective.input);
        const material = this.collectMaterial(boundFiles, effective.input);
        // Resolve relative file references (asset_plan[].file, style_lock.approved_file) to the real media path so the
        // worker preflight can locate them; otherwise a shared STYLE_MOTHER with file="shared/X.png" crashes on
        // "approved style_lock file missing" because the compiler needs a resolved Backend media path.
        // Match by asset_id (not basename): the real media file is content-addressed (e.g. a62527ff-....png), so basename
        // never matches the authored "shared/STYLE_MOTHER.png". Walk asset_plan/style_lock and use each entry's id to look
        // up boundFiles[`${id}\0asset`].
        // Keep the frozen owner snapshot complete; only the compiler input is scoped.
        // The worker may narrow compilation to pending targets, but apply/reuse still need
        // the full source so existing target receipts can be verified against their scopes.
        const resolvedSource = resolveCompilerSourceFiles(JSON.parse(JSON.stringify(director.source)), boundFiles);
        // DEBUG: verify the fix actually resolves STYLE_MOTHER's relative path
        const debugPlan = (resolvedSource as any).asset_plan?.find((p: any) => p.id === "STYLE_MOTHER");
        if (debugPlan) console.error("[stylefix-debug] STYLE_MOTHER.file =", debugPlan.file);
        const debugLock = (resolvedSource as any).style_lock;
        if (debugLock) console.error("[stylefix-debug] style_lock.approved_file =", debugLock.approved_file, "anchor_asset_id =", debugLock.anchor_asset_id);
        const normalizedSource = JSON.parse(JSON.stringify(resolveCompilerSourceFiles(JSON.parse(JSON.stringify(effective.input.source)), boundFiles)), (_key, value) => {
            if (typeof value !== "string") return value;
            const match = [...material.values()].find(item => item.file === value);
            return match ? `sha256:${match.digest}` : value;
        });
        const compilerInputFingerprint = hash({ version: 2, owner, id, source: normalizedSource, assets: effective.input.assets, shotInputs: effective.input.shotInputs, boundaries: effective.input.boundaries, engine: director.engine,
            scope: scope || null, targets: effective.targetIds, reusable: effective.reusable.map(item => ({ targetId: item.targetId, sha256: item.sha256 })),
            references: [...material].map(([identity, item]) => ({ identity, sha256: item.digest })).sort((a, b) => a.identity.localeCompare(b.identity)) });
        const blocked = this.blockedInput(id, owner, compilerInputFingerprint);
        if (blocked) {
            this.saveJob({ operationId, owner, id, expectedRevision: snapshotRevision, requestHash, requestFingerprint, compilerInputFingerprint, reusedFromOperationId: blocked.operationId, createdAt: new Date().toISOString() });
            queueMicrotask(() => this.onSettled?.(id));
            return this.getCompilation(id, owner, operationId);
        }
        const preparedId = crypto.randomUUID(), directory = path.join(this.root, preparedId);
        const references = this.resolveArchivedMaterial(material);
        const projection = scope ? compilationScopeInput(director, scope) : undefined;
        const scopeHash = projection?.inputHash;
        // Store the resolved-source director so the worker preflight sees absolute media paths, not relative "shared/X.png".
        const job: CompilationJob = { operationId, owner, id, expectedRevision: snapshotRevision, requestHash, requestFingerprint, baselineHash: hash(current.draft.director), preparedId, director: { ...director, source: resolvedSource }, references, scope, scopeHash, compilerInputFingerprint, status: "queued", diagnostics: compileInputDiagnostics, createdAt: new Date().toISOString() };
        this.saveJob(job); this.scheduleJob(job);
        return this.getCompilation(id, owner, operationId);
    }

    /** Stop an obsolete queued or running compile while preserving its durable receipt. */
    cancel(id: string, owner: string, operationId: string) {
        const job = this.loadJob(operationId, owner);
        if (!job || job.id !== id || !["queued", "running"].includes(job.status)) return false;
        const key = this.jobKey(owner, operationId);
        this.cancelledJobs.add(key);
        this.workers.get(key)?.terminate();
        job.status = "interrupted";
        job.diagnostics = [...job.diagnostics, { code: "COMPILATION_SUPERSEDED", path: "compile", message: "目标输入已更新，旧编译已替代。", severity: "warning" }];
        this.saveJob(job);
        return true;
    }
    async preflight(id: string, expectedRevision: number, candidate?: DirectorProduction, scope?: CompilationScope) {
        const current = this.service.get(id);
        if (expectedRevision > current.revision) throw new ProductionConflictError(current);
        if (!current.draft.director) throw new Error("COMPILE_STAGE_NOT_READY: 请先保存正式导演源稿");
        if (candidate && current.revision !== expectedRevision && hash(candidate) !== hash(current.draft.director)) throw new ProductionConflictError(current);
        const snapshotRevision = current.revision;
        const compileInputDiagnostics: ProductionDiagnostic[] = [];
        const director = this.bindCanvasStyleAnchor(id, this.service.resolveSubjectPictureInputs(id, this.compilationDirector(candidate || current.draft.director), scope?.targetIds, true, undefined, compileInputDiagnostics));
        const scoped = scope ? compilationScopeInput(director, scope) : undefined;
        const references = this.service.compilationReferenceFiles(id, scoped?.director || director);
        const compileInputBase = scope ? scopedCompilerInput(scoped!.director, scope) : director;
        const compileInput = resolveCompilerDirectorFiles(compileInputBase, references);
        const result = await new Promise<any>((resolve, reject) => {
            const worker = new Worker(`const { parentPort, workerData } = require("node:worker_threads");
                (async () => { const engine = await import(workerData.module); parentPort.postMessage(engine.preflightCompilationDirector(workerData.director, (id, label) => workerData.references[id + "\\0" + label])); })().catch(error => parentPort.postMessage({ error: error.message }));`, { eval: true, workerData: { module: import.meta.resolve("@basketikun/canvas-agent/skills/acheng"), director: compileInput, references } });
            let delivered = false;
            worker.once("message", message => { delivered = true; message.error ? reject(new Error(message.error)) : resolve(message); }); worker.once("error", reject);
            worker.once("exit", code => { if (!delivered) reject(new Error(`预检执行单元退出 (${code})`)); });
        });
        const latest = this.service.get(id);
        const latestDirector = latest.draft.director;
        if (!latestDirector || latestDirector.engine.runtimeId !== director.engine.runtimeId
            || (scope ? compilationScopeInput(latestDirector, scope).inputHash !== compilationScopeInput(director, scope).inputHash
                : hash(latestDirector) !== hash(current.draft.director))) throw new ProductionConflictError(latest);
        return { ...result, diagnostics: [...compileInputDiagnostics, ...result.diagnostics], revision: snapshotRevision, scope };
    }
    recover(owner: string) {
        const db = this.database();
        if (db) {
            const rows = db.db.prepare("SELECT job_gzip FROM production_compilation_jobs WHERE owner=? ORDER BY created_at").all(owner) as Array<{ job_gzip: Uint8Array }>;
            for (const row of rows) {
                const job = this.mapPersistentMediaPaths(this.decode<CompilationJob | CompilationAlias>(row.job_gzip), "load");
                if (!("director" in job) || activeJobs.has(this.jobKey(owner, job.operationId))) continue;
                if (job.status === "queued") this.scheduleJob(job);
                else if (job.status === "running") {
                    const packet = this.tryLoadPacket(job.preparedId, owner, job.id);
                    if (packet) {
                        job.result = this.shortResult(job.preparedId, packet);
                        job.diagnostics = packet.diagnostics;
                        job.continuityReceipt = packet.continuityReceipt;
                        job.status = hasFatalCompilationError(job.diagnostics) || hasUnusableCompilerResult(packet.exitCode, packet.director?.artifacts) ? "blocked" : "succeeded";
                    } else {
                        job.status = "interrupted";
                        job.diagnostics = [{ code: "COMPILATION_INTERRUPTED", severity: "error", message: "服务重启中断编译；已确认未完成，不自动重跑" }];
                    }
                    this.saveJob(job);
                    fs.rmSync(this.workingDirectory(job.preparedId), { recursive: true, force: true });
                }
            }
            return;
        }
        const directory = path.join(this.root, "operations");
        if (!fs.existsSync(directory)) return;
        for (const name of fs.readdirSync(directory).filter(name => name.endsWith(".json"))) {
            const job: CompilationJob = JSON.parse(fs.readFileSync(path.join(directory, name), "utf8"));
            if (job.owner !== owner || activeJobs.has(this.jobFile(job.operationId))) continue;
            if (job.status === "queued") this.scheduleJob(job);
            else if (job.status === "running") {
                if (fs.existsSync(this.file(job.preparedId))) {
                    const { packetHash, ...packet } = JSON.parse(fs.readFileSync(this.file(job.preparedId), "utf8"));
                    if (hash(packet) === packetHash && packet.owner === owner && packet.id === job.id) {
                        job.result = this.shortResult(job.preparedId, packet); job.diagnostics = packet.diagnostics; job.continuityReceipt = packet.continuityReceipt; job.status = hasFatalCompilationError(job.diagnostics) || hasUnusableCompilerResult(packet.exitCode, packet.director?.artifacts) ? "blocked" : "succeeded";
                    } else { job.status = "interrupted"; job.diagnostics = [{ code: "INVALID_COMPILATION_PACKET", severity: "error", message: "恢复的编译包完整性校验失败" }]; }
                } else { job.status = "interrupted"; job.diagnostics = [{ code: "COMPILATION_INTERRUPTED", severity: "error", message: "服务重启中断编译；已确认未完成，不自动重跑" }]; }
                this.saveJob(job);
            }
        }
    }
    private tryLoadPacket(preparedId: string, owner: string, id: string) {
        try { return this.loadPacket(preparedId, owner, id); } catch { return undefined; }
    }
    private shortResult(preparedId: string, packet: any) {
        return { preparedId, sourceHash: packet.director.sourceHash, targets: packet.director.artifacts.filter((a: any) => !packet.targetIds || packet.targetIds.includes(a.targetId)).map((a: any) => ({ id: a.id, targetId: a.targetId, kind: a.kind, status: a.status, sha256: a.sha256, referenceCount: a.references.length })) };
    }
    private applyTargetCompileBlocks(director: DirectorProduction, diagnostics: DiagnosticLike[]) {
        const blocked = new Map<string, string[]>();
        for (const item of diagnostics) {
            if (!item.targetId || !diagnosticForAction(item, "compile")) continue;
            const messages = blocked.get(item.targetId) || [];
            messages.push(String(item.message || item.code || "目标编译受阻"));
            blocked.set(item.targetId, messages);
        }
        for (const [targetId, messages] of blocked) {
            const artifact = director.artifacts.find(item => item.targetId === targetId);
            if (!artifact) continue;
            const receiptDiagnostics = artifact.receipt.diagnostics && typeof artifact.receipt.diagnostics === "object"
                ? artifact.receipt.diagnostics as Record<string, unknown> : {};
            const prior = Array.isArray(receiptDiagnostics.blockers) ? receiptDiagnostics.blockers.map(String) : [];
            artifact.status = "draft";
            artifact.receipt = { ...artifact.receipt, diagnostics: { ...receiptDiagnostics, blockers: [...new Set([...prior, ...messages])] } };
        }
    }
    private applyContinuityGate(id: string, director: DirectorProduction, diagnostics: any[], targetIds?: string[]) {
        if ((director.source.ledger as any)?.contract_version !== 2 || typeof (this.service as any).continuityForDirector !== "function") return undefined;
        const artifacts = director.artifacts.filter(item => item.kind === "h3" && item.status === "ready" && (!targetIds || targetIds.includes(item.targetId)));
        let continuity = this.service.continuityForDirector(id, director);
        let autoChecked = false;
        if (artifacts.length && continuityTargetBlockers(continuity, [artifacts[0].targetId]).some(blocker => blocker.code === "CONTINUITY_REPORT_REQUIRED")) {
            // 编译前没有有效回执：自动执行一次正式连续性检查生成回执，再用新回执评估门禁；
            // 检查本身失败时回退为原有告警行为，不阻塞编译。
            try {
                continuity = this.service.autoRecordContinuityForDirector(id, director);
                autoChecked = true;
            } catch (error) {
                console.warn("COMPILATION_CONTINUITY_AUTO_CHECK_FAILED", error instanceof Error ? `${error.name}: ${error.message}` : String(error));
            }
        }
        for (const artifact of artifacts) {
            const blockers = continuityTargetBlockers(continuity, [artifact.targetId]);
            if (!blockers.length) continue;
            artifact.receipt = { ...artifact.receipt, continuityDiagnostics: blockers };
            diagnostics.push(...blockers.map(blocker => ({ code: blocker.code, path: `artifacts.${artifact.targetId}.continuity`, targetId: artifact.targetId,
                message: blocker.message, severity: "warning", blockingActions: [] })));
        }
        return { sourceHash: director.sourceHash, runtimeId: director.engine.runtimeId, reportSourceHash: continuity.report?.sourceHash || null,
            reportRuntimeId: continuity.report?.runtimeId || null, reportOperationId: continuity.report?.operationId || null,
            checkedAt: continuity.report?.checkedAt || null, status: continuity.status, ...(autoChecked ? { autoChecked: true } : {}) };
    }
    private reusableArtifacts(id: string, director: DirectorProduction, targetIds: string[]) {
        const styleAnchor = this.service.canvasStyleAnchorInput(id, director);
        const plan = new Map((Array.isArray(director.source.asset_plan) ? director.source.asset_plan : []).filter(item => item && typeof item === "object")
            .map((item: any) => [String(item.asset_id || item.id || ""), item]));
        return director.artifacts.filter(artifact => targetIds.includes(artifact.targetId) && artifact.status === "ready"
            && artifact.receipt.engineRuntimeId === director.engine.runtimeId && currentCompilationArtifact(director, artifact)
            && crypto.createHash("sha256").update(artifact.prompt, "utf8").digest("hex") === artifact.sha256
            && artifact.receipt.promptHash === artifact.sha256
            && !hasBlockingArtifactDiagnostics(artifact.receipt.diagnostics)
            && (!styleAnchor || artifact.kind !== "image" || String(plan.get(artifact.targetId)?.kind || plan.get(artifact.targetId)?.asset_type || "").toLowerCase() === "style"
                || artifact.references.at(-1)?.nodeId === styleAnchor.nodeId && artifact.references.at(-1)?.role === "style"
                && artifact.references.at(-1)?.storageKey === styleAnchor.storageKey && artifact.references.at(-1)?.sha256 === styleAnchor.sha256));
    }
    private compilationTargets(director: DirectorProduction) {
        const fields = isSubjectPromptAssembly(director.source) ? ["asset_cards", "segments"] : ["asset_plan", "asset_cards", "segments"];
        return [...new Set(fields.flatMap(field => {
            const entries = director.source[field];
            return Array.isArray(entries) ? entries.map(item => String(field === "segments" ? item.id || "" : item.asset_id || item.id || "")).filter(Boolean) : [];
        }))];
    }
    private scheduleJob(job: CompilationJob) {
        const key = this.jobKey(job.owner, job.operationId);
        if (activeJobs.has(key)) return;
        activeJobs.add(key);
        schedule(async () => {
            try {
                if (this.cancelledJobs.has(key)) throw Object.assign(new Error("编译已被较新的目标输入替代"), { code: "COMPILATION_SUPERSEDED" });
                job.status = "running"; this.saveJob(job);
                const directory = this.workingDirectory(job.preparedId);
                if (this.database()) await fs.promises.rm(directory, { recursive: true, force: true });
                if (this.cancelledJobs.has(key)) throw Object.assign(new Error("编译已被较新的目标输入替代"), { code: "COMPILATION_SUPERSEDED" });
                const projection = job.scope ? compilationScopeInput(job.director, job.scope) : undefined;
                const { targetIds, reusable, input: rawCompileInput } = this.effectiveInput(job.id, job.director, job.scope);
                const compileInput = resolveCompilerDirectorFiles(rawCompileInput, job.references);
                const pending = targetIds.filter(id => !reusable.some(artifact => artifact.targetId === id));
                let compiled: ReturnType<Compiler>;
                const cached = targetIds.length > 0 && !pending.length;
                if (cached) compiled = { director: structuredClone(projection?.director || job.director), exitCode: 0,
                    diagnostics: reusable.flatMap(artifact => artifact.receipt.diagnostics || []) as ReturnType<Compiler>["diagnostics"],
                    audit: { status: "REUSED", artifactIds: reusable.map(item => item.id) }, sourceAdjustments: [], acceptance: { reused: true } };
                else if (this.compiler !== compileAchengDirector) compiled = await this.compiler(structuredClone(compileInput), directory, (targetId, label) => job.references[`${targetId}\0${label}`]);
                else compiled = await new Promise((resolve, reject) => {
                    const worker = new Worker(`const { parentPort, workerData } = require("node:worker_threads");
                        (async () => { const engine = await import(workerData.module);
                          const contract = await import(workerData.contractModule);
                          const resolveRef = (targetId, label) => workerData.references[targetId + "\\0" + label];
                          const checked = engine.preflightCompilationDirector(workerData.director, resolveRef);
                          const blocking = checked.diagnostics.filter(item => contract.diagnosticBlocksAction(item, "compile"));
                          const globalCodes = new Set(workerData.globalCompileBlockerCodes);
                          const global = blocking.filter(item => !item.targetId && globalCodes.has(item.code));
                          if (global.length) { parentPort.postMessage({ blocked: global }); return; }
                          const compiled = engine.compileAchengDirector(workerData.director, workerData.directory, resolveRef);
                          compiled.diagnostics.push(...blocking);
                          parentPort.postMessage({ compiled });
                        })().catch(error => parentPort.postMessage({ error: error.message }));`, { eval: true, workerData: { module: import.meta.resolve("@basketikun/canvas-agent/skills/acheng"), contractModule: import.meta.resolve("@basketikun/canvas-agent/drama/production-contract"), globalCompileBlockerCodes: GLOBAL_COMPILE_BLOCKER_CODES, director: compileInput, references: job.references, directory } });
                    let delivered = false;
                    this.workers.set(key, worker);
                    worker.once("message", message => { delivered = true; if (message.error) reject(new Error(message.error)); else if (message.blocked) reject(new ProductionValidationError(message.blocked)); else resolve(message.compiled); });
                    worker.once("error", reject);
                    worker.once("exit", code => { if (!delivered) reject(new Error(`编译执行单元退出 (${code})`)); });
                });
                if (this.cancelledJobs.has(key)) throw Object.assign(new Error("编译已被较新的目标输入替代"), { code: "COMPILATION_SUPERSEDED" });
                if (projection && job.scope) {
                    // Reused targets may be absent from the narrowed compiler output.
                    compiled.director.artifacts = [...compiled.director.artifacts.filter(artifact => !reusable.some(prior => prior.targetId === artifact.targetId)), ...structuredClone(reusable)];
                    const projectedSourceHash = compiled.director.sourceHash;
                    const artifacts = compiled.director.artifacts.filter(artifact => projection.targetIds.includes(artifact.targetId)).map(artifact => {
                        const prior = reusable.find(item => item.kind === artifact.kind && item.targetId === artifact.targetId && item.sha256 === artifact.sha256);
                        if (prior) return prior;
                        const targetScope = { targetIds: [artifact.targetId], ...(job.scope?.output ? { output: job.scope.output } : {}) };
                        return { ...artifact, sourceHash: job.director.sourceHash, receipt: { ...artifact.receipt, sourceHash: job.director.sourceHash,
                            ...(artifact.receipt.sourceMap ? { sourceMap: { ...artifact.receipt.sourceMap, sourceHash: job.director.sourceHash } } : {}),
                            compilationScope: { scope: targetScope, inputHash: compilationScopeInput(job.director, targetScope).inputHash, engine: artifact.receipt.engine || job.director.engine, projectedSourceHash } } };
                    });
                    compiled.director = { ...structuredClone(job.director), artifacts: [...job.director.artifacts.filter(item => !projection.targetIds.includes(item.targetId)), ...artifacts] };
                }
                if (compiled.director.workflow.currentWork) compiled.director.workflow.currentWork = { ...compiled.director.workflow.currentWork, inputRevision: job.expectedRevision, sourceHash: compiled.director.sourceHash };
                compiled.diagnostics = [...job.diagnostics, ...compiled.diagnostics];
                this.applyTargetCompileBlocks(compiled.director, compiled.diagnostics);
                compiled.director = this.stabilizeCompiledDirector(compiled.director);
                const continuityReceipt = this.applyContinuityGate(job.id, compiled.director, compiled.diagnostics, projection?.targetIds);
                job.continuityReceipt = continuityReceipt;
                const latest = this.service.get(job.id), latestDirector = latest.draft.director;
                const latestDiagnostics: ProductionDiagnostic[] = [];
                const latestInput = latestDirector && this.bindCanvasStyleAnchor(job.id,
                    this.service.resolveSubjectPictureInputs(job.id, this.compilationDirector(latestDirector), job.scope?.targetIds, true, undefined, latestDiagnostics));
                let latestManifestHash = "";
                try { if (latestInput) latestManifestHash = this.inputManifestFingerprint(job.id, job.owner, latestInput, job.scope); }
                catch { /* A missing or changed media dependency makes this frozen result stale. */ }
                const inputsUnchanged = compilationInputsUnchanged({
                    engineRuntimeId: job.director.engine.runtimeId, compilerInputFingerprint: job.compilerInputFingerprint ?? "",
                    baselineHash: job.baselineHash, scope: job.scope, scopeHash: job.scopeHash,
                }, { director: latestDirector, input: latestInput, manifestHash: latestManifestHash });
                if (!inputsUnchanged) {
                    job.status = "blocked";
                    job.diagnostics = [...job.diagnostics, { code: "COMPILATION_INPUT_CHANGED", path: "compile.inputManifest", message: "编译期间目标输入或引擎版本已变化；旧结果未应用，请对当前目标重新发起编译。", severity: "error" }];
                    return;
                }
                const packet = { owner: job.owner, id: job.id, expectedRevision: job.expectedRevision, baselineHash: job.baselineHash, scope: job.scope, scopeHash: job.scopeHash, inputManifestHash: job.compilerInputFingerprint, targetIds: projection?.targetIds,
                    assetIds: Object.keys(projection?.director.assets || job.director.assets), operationId: `compilation:${job.preparedId}`, resultHash: hash(compiled.director), ...compiled, continuityReceipt };
                fs.mkdirSync(directory, { recursive: true });
                if (this.database()) this.saveJob(job, packet);
                else {
                    fs.mkdirSync(directory, { recursive: true });
                    const temporary = this.file(job.preparedId) + ".tmp";
                    fs.writeFileSync(temporary, JSON.stringify({ ...packet, packetHash: hash(packet) }), "utf8"); fs.renameSync(temporary, this.file(job.preparedId));
                }
                job.result = this.shortResult(job.preparedId, packet); job.diagnostics = compiled.diagnostics;
                job.status = hasFatalCompilationError(compiled.diagnostics) || hasUnusableCompilerResult(compiled.exitCode, compiled.director?.artifacts) ? "blocked" : "succeeded";
            } catch (error) {
                const superseded = this.cancelledJobs.has(key) || (error as any)?.code === "COMPILATION_SUPERSEDED";
                job.status = superseded ? "interrupted" : error instanceof ProductionValidationError ? "blocked" : "failed";
                const diagnostics = superseded ? [{ code: "COMPILATION_SUPERSEDED", path: "compile", message: "目标输入已更新，旧编译已替代。", severity: "warning" }]
                    : error instanceof ProductionValidationError ? error.diagnostics : [{ code: "COMPILATION_FAILED", path: "compile", message: error instanceof Error ? error.message : String(error), severity: "error" }];
                job.diagnostics = [...job.diagnostics, ...diagnostics];
            } finally {
                this.workers.delete(key);
                if (this.database()) await fs.promises.rm(this.workingDirectory(job.preparedId), { recursive: true, force: true }).catch(() => {});
                try { this.saveJob(job); }
                finally { activeJobs.delete(key); this.cancelledJobs.delete(key); this.onSettled?.(job.id); }
            }
        }, job.createdAt);
    }

    private file(preparedId: string) {
        if (!/^[a-f0-9-]{36}$/.test(preparedId)) throw new Error("Invalid compilation handle");
        return path.join(this.workingDirectory(preparedId), "packet.json");
    }

    /** Read indexed media bytes and retain their stable MediaStore paths for this compiler invocation. */
    private collectMaterial(boundFiles: Record<string, string | undefined>, input: DirectorProduction) {
        const material = new Map<string, MaterialItem>();
        const collect = (targetId: string, label: string, original?: string) => {
            const file = boundFiles[`${targetId}\0${label}`] || original;
            if (!file || !fs.existsSync(file)) return;
            const bytes = fs.readFileSync(file);
            material.set(`${targetId}\0${label}`, { bytes, digest: crypto.createHash("sha256").update(bytes).digest("hex"), extension: path.extname(file), file });
        };
        for (const [assetId, asset] of Object.entries(input.assets)) if (asset.storageKey) collect(assetId, "asset");
        for (const field of ["asset_cards", "segments"] as const) for (const card of (input.source[field] || []) as any[]) {
            for (const ref of card.references || []) collect(card.id, ref.label || `<Picture ${ref.image}>`, path.isAbsolute(ref.file || "") ? ref.file : undefined);
            if (field === "segments") for (const binding of card.audio_bindings || []) collect(String(card.id || ""), String(binding.label || ""));
        }
        return material;
    }
    private resolveArchivedMaterial(material: Map<string, MaterialItem>) {
        const references: Record<string, string> = {};
        for (const [identity, item] of material) {
            const archivedPathCheck = (this.service as any).isArchivedMediaPath;
            if (archivedPathCheck && !archivedPathCheck.call(this.service, item.file)) throw Object.assign(new Error(`编译引用尚未归档到 Backend MediaStore：${identity}`), { code: "COMPILATION_MEDIA_NOT_ARCHIVED" });
            if (!fs.existsSync(item.file) || crypto.createHash("sha256").update(fs.readFileSync(item.file)).digest("hex") !== item.digest) {
                throw Object.assign(new Error(`Backend MediaStore 文件缺失或摘要变化：${identity}`), { code: "COMPILATION_MEDIA_INTEGRITY_FAILED" });
            }
            const indexedDigest = (this.service as any).archivedMediaDigest?.(item.file);
            if (indexedDigest && indexedDigest !== item.digest) throw Object.assign(new Error(`Backend MediaStore 索引摘要与文件内容不一致：${identity}`), { code: "COMPILATION_MEDIA_INTEGRITY_FAILED" });
            references[identity] = item.file;
        }
        return references;
    }

    prepare(id: string, owner: string, expectedRevision: number, candidate?: DirectorProduction) {
        const current = this.service.get(id);
        if (expectedRevision > current.revision) throw new ProductionConflictError(current);
        if (!current.draft.director) throw new Error("Missing formal director source");
        if (candidate && current.revision !== expectedRevision && hash(candidate) !== hash(current.draft.director)) throw new ProductionConflictError(current);
        const snapshotRevision = current.revision;
        const scope = this.authoredScope(candidate || current.draft.director);
        const compileInputDiagnostics: ProductionDiagnostic[] = [];
        const director = this.bindCanvasStyleAnchor(id, this.service.resolveSubjectPictureInputs(id, this.compilationDirector(candidate || current.draft.director), scope?.targetIds, true, undefined, compileInputDiagnostics));
        const checked = this.service.preflight(id, { action: "compile", request: { expectedRevision: snapshotRevision, director } });
        const compileBlockers = checked.diagnostics.filter(item => diagnosticForAction(item, "compile"));
        const globalCompileBlockers = compileBlockers.filter(isGlobalCompilationBlocker);
        if (globalCompileBlockers.length) throw new ProductionValidationError(globalCompileBlockers);
        compileInputDiagnostics.push(...checked.diagnostics.filter(item => !compileInputDiagnostics.some(existing => existing.code === item.code && existing.targetId === item.targetId && existing.path === item.path)));
        const effective = this.effectiveInput(id, director, scope);
        const boundFiles = this.service.compilationReferenceFiles(id, effective.input);
        const references = this.resolveArchivedMaterial(this.collectMaterial(boundFiles, effective.input));
        const preparedId = crypto.randomUUID();
        const directory = path.join(this.root, preparedId);
        const targets = this.compilationTargets(director), reusable = this.reusableArtifacts(id, director, targets);
        const compileInput = resolveCompilerDirectorFiles(effective.input, references);
        let compiled: ReturnType<Compiler>;
        try {
            compiled = targets.length > 0 && targets.every(id => reusable.some(artifact => artifact.targetId === id))
                ? { director: structuredClone(compileInput), exitCode: 0, diagnostics: reusable.flatMap(artifact => artifact.receipt.diagnostics || []) as ReturnType<Compiler>["diagnostics"], audit: { status: "REUSED", artifactIds: reusable.map(item => item.id) }, sourceAdjustments: [], acceptance: { reused: true } }
                : this.compiler(compileInput, directory, (targetId, label) => references[`${targetId}\0${label}`], this.compiler === compileAchengDirector ? director.engine.runtimeId : undefined);
        } catch (error) { fs.rmSync(directory, { recursive: true, force: true }); throw error; }
        fs.rmSync(directory, { recursive: true, force: true });
        compiled.diagnostics = [...compileInputDiagnostics, ...compiled.diagnostics];
        this.applyTargetCompileBlocks(compiled.director, compiled.diagnostics);
        compiled.director = this.stabilizeCompiledDirector(compiled.director);
        const continuityReceipt = this.applyContinuityGate(id, compiled.director, compiled.diagnostics);
        if (compiled.director.workflow.currentWork) {
            compiled.director.workflow.currentWork = { ...compiled.director.workflow.currentWork, inputRevision: snapshotRevision, sourceHash: compiled.director.sourceHash };
        }
        const scopeHash = scope ? compilationScopeInput(director, scope).inputHash : undefined;
        const inputManifestHash = this.inputManifestFingerprint(id, owner, director, scope);
        const latest = this.service.get(id), latestDirector = latest.draft.director;
        const latestManifestInput = latestDirector && this.bindCanvasStyleAnchor(id,
            this.service.resolveSubjectPictureInputs(id, this.compilationDirector(latestDirector), scope?.targetIds, true));
        if (!latestDirector || latestDirector.engine.runtimeId !== director.engine.runtimeId
            || !latestManifestInput || this.inputManifestFingerprint(id, owner, latestManifestInput, scope) !== inputManifestHash
            || (scope ? compilationScopeInput(latestManifestInput, scope).inputHash !== scopeHash
                : hash(latestDirector) !== hash(current.draft.director))) throw new ProductionConflictError(latest);
        const packet = { owner, id, expectedRevision: snapshotRevision, baselineHash: hash(current.draft.director), inputManifestHash, assetIds: Object.keys(director.assets), operationId: `compilation:${preparedId}`, resultHash: hash(compiled.director), ...(scope ? { scope, scopeHash, targetIds: effective.targetIds } : {}), ...compiled, continuityReceipt };
        if (this.database()) this.savePreparedPacket({ ...packet, preparedId });
        else {
            fs.mkdirSync(directory, { recursive: true });
            fs.writeFileSync(this.file(preparedId), JSON.stringify({ ...packet, packetHash: hash(packet) }), { encoding: "utf8", flag: "wx" });
        }
        return { preparedId, operationId: packet.operationId, expectedRevision: snapshotRevision, sourceHash: compiled.director.sourceHash, engine: director.engine, continuityReceipt, diagnostics: compiled.diagnostics,
            audit: compiled.audit, sourceAdjustments: compiled.sourceAdjustments, targets: compiled.director.artifacts.map(a => ({ id: a.id, targetId: a.targetId, kind: a.kind, status: a.status, sha256: a.sha256, references: a.references, diagnostics: a.receipt.diagnostics })), mediaSubmitted: false };
    }

    apply(id: string, owner: string, preparedId: string) {
        const savedJob = this.packetJob(preparedId);
        if (savedJob?.application) {
            if (savedJob.owner !== owner || savedJob.id !== id) throw new Error("Compilation belongs to a different production");
            return { ...savedJob.application, replayed: true };
        }
        const packet = this.loadPacket(preparedId, owner, id);
        if (hasFatalCompilationError(packet.diagnostics)) throw new Error("Compilation has unresolved global errors; correct its source and prepare a new packet");
        const overwriteCompiledPromptTargets = new Set<string>(packet.director.artifacts
            .filter((artifact: any) => artifact.status === "ready"
                && (!Array.isArray(packet.targetIds) || packet.targetIds.includes(artifact.targetId)))
            .map((artifact: any) => String(artifact.targetId)));
        const current = this.service.get(id);
        const committed = this.service.operationReceipt(id, packet.operationId);
        if (committed) {
            const receipt = { revision: committed.revision, sourceHash: committed.draft.director?.sourceHash, referenceSync: committed.referenceSync, replayed: true, mediaSubmitted: false };
            this.markApplied(this.packetJob(preparedId), receipt);
            return receipt;
        }
        if (packet.inputManifestHash && current.draft.director) {
            const diagnostics: ProductionDiagnostic[] = [];
            const currentInput = this.bindCanvasStyleAnchor(id, this.service.resolveSubjectPictureInputs(id,
                this.compilationDirector(current.draft.director), packet.scope?.targetIds, true, undefined, diagnostics));
            if (this.inputManifestFingerprint(id, owner, currentInput, packet.scope) !== packet.inputManifestHash) throw new ProductionConflictError(current);
        }
        if (packet.scope) {
            const director = current.draft.director;
            if (!director) throw new ProductionConflictError(current);
            const applyDiagnostics: ProductionDiagnostic[] = [];
            const latest = this.service.resolveSubjectPictureInputs(id, { ...director, engine: packet.director.engine }, packet.scope?.targetIds, true, undefined, applyDiagnostics);
            const input = compilationScopeInput(latest, packet.scope);
            if (input.inputHash !== packet.scopeHash && input.legacyInputHash !== packet.scopeHash) throw new ProductionConflictError(current);
            const targets = new Set<string>(packet.targetIds);
            const preserved = structuredClone(latest); preserveCompilationProvenance(preserved);
            for (const assetId of packet.assetIds || []) if (packet.director.assets[assetId]) preserved.assets[assetId] = structuredClone(packet.director.assets[assetId]);
            const merged = { ...preserved, engine: packet.director.engine, artifacts: [...preserved.artifacts.filter(item => !targets.has(item.targetId)), ...packet.director.artifacts.filter((item: any) => targets.has(item.targetId))] };
            this.service.verifyCompilationBindings(id, merged);
            const result = this.service.edit(id, { operationId: packet.operationId, expectedRevision: current.revision, ops: [{ type: "set_director_production", director: merged }] }, undefined, false, undefined, undefined, overwriteCompiledPromptTargets);
            const receipt = { referenceSync: result.referenceSync, revision: result.revision, sourceHash: result.draft.director?.sourceHash, replayed: result.replayed === true, operationId: packet.operationId, mediaSubmitted: false };
            this.markApplied(this.packetJob(preparedId), receipt);
            return receipt;
        }

        const currentDirector = current.draft.director;
        if (!currentDirector || !packet.scope && hash(currentDirector) !== packet.baselineHash
            || packet.scope && compilationScopeInput(currentDirector, packet.scope).inputHash !== packet.scopeHash) throw new ProductionConflictError(current);
        this.service.verifyCompilationBindings(id, packet.director);
        const result = this.service.edit(id, { operationId: packet.operationId, expectedRevision: packet.expectedRevision, ops: [{ type: "set_director_production", director: packet.director }] }, undefined, false, undefined, undefined, overwriteCompiledPromptTargets);
        const receipt = { referenceSync: result.referenceSync, revision: result.revision, replayed: result.replayed === true, publishedVersion: result.publishedVersion, sourceHash: result.draft.director?.sourceHash, operationId: packet.operationId, mediaSubmitted: false };
        this.markApplied(this.packetJob(preparedId), receipt);
        return receipt;
    }
}
