import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Worker } from "node:worker_threads";
import { compileAchengDirector, resolveAchengEngine, resolveAchengRuntime, achengEngineIdentity } from "@basketikun/canvas-agent/skills/acheng";
import { canonicalProduction, directorProductionSchema, type DirectorProduction } from "@basketikun/canvas-agent/drama/production-contract";
import { EpisodeProductionService, ProductionConflictError } from "./production.js";
import { ProductionValidationError } from "@basketikun/canvas-agent/drama/production-validation";
import { continuityTargetBlockers } from "./continuity-reports.js";
import { WorkPool } from "@basketikun/canvas-agent/agent/production";
import { compilationScopeInput, currentCompilationArtifact, preserveCompilationProvenance, scopedCompilerInput, type CompilationScope } from "@basketikun/canvas-agent/drama/compilation-scope";

const hash = (value: unknown) => crypto.createHash("sha256").update(canonicalProduction(value)).digest("hex");
type Compiler = typeof compileAchengDirector;
type CompilationJob = { operationId: string; owner: string; id: string; expectedRevision: number; requestHash: string; baselineHash: string; preparedId: string; director: DirectorProduction; references: Record<string, string>; scope?: CompilationScope; scopeHash?: string; status: "queued" | "running" | "succeeded" | "blocked" | "failed" | "interrupted"; diagnostics: any[]; result?: any; continuityReceipt?: any; application?: any; createdAt: string };
const compilerPool = new WorkPool(3);
function schedule(work: () => Promise<void>, _createdAt: string) {
    void compilerPool.submit(work).catch(error => console.error("COMPILATION_RECEIPT_WRITE_FAILED", error instanceof Error ? error.name : "Error"));
}
const activeJobs = new Set<string>();
const hasFatalCompilationError = (diagnostics: Array<{ severity?: string; targetId?: string }>) => diagnostics.some(item => item.severity === "error" && !item.targetId);

/** Frozen compiler packets are sidecar files; only the existing ops transaction edits production. */
export class ProductionCompilationService {
    onSettled?: (id: string) => void;
    constructor(private service: EpisodeProductionService, private root: string, private compiler: Compiler = compileAchengDirector) {}

    private compilationDirector(input: DirectorProduction) {
        const director = directorProductionSchema.parse(structuredClone(input));
        preserveCompilationProvenance(director);
        if (this.compiler === compileAchengDirector) director.engine = achengEngineIdentity(resolveAchengEngine());
        return director;
    }

    private jobFile(operationId: string) { return path.join(this.root, "operations", hash(operationId) + ".json"); }
    private saveJob(job: CompilationJob) {
        const file = this.jobFile(job.operationId);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const temporary = `${file}.${crypto.randomUUID()}.tmp`;
        fs.writeFileSync(temporary, JSON.stringify(job), "utf8"); fs.renameSync(temporary, file);
    }
    private loadJob(operationId: string): CompilationJob | undefined {
        const file = this.jobFile(operationId); return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : undefined;
    }
    getCompilation(id: string, owner: string, operationId: string, view: "status" | "targets" | "diagnostics" = "status", offset = 0, count?: number) {
        const job = this.loadJob(operationId);
        if (!job || job.id !== id || job.owner !== owner) throw new Error("编译回执不存在或不属于当前制作对象");
        const base = { operationId, status: job.status, verdict: job.diagnostics.some((item: any) => item.severity === "error") ? "blocked" : "passed", expectedRevision: job.expectedRevision, sourceHash: job.result?.sourceHash || job.director.sourceHash, ...(job.status === "succeeded" ? { preparedId: job.preparedId } : {}), ...(job.continuityReceipt ? { continuityReceipt: job.continuityReceipt } : {}), application: job.application || this.applicationReceipt(job), mediaSubmitted: false };
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
    enqueue(id: string, owner: string, operationId: string, expectedRevision: number, candidate?: DirectorProduction, scope?: CompilationScope) {
        const requestHash = hash({ id, owner, expectedRevision, candidate, scope });
        const prior = this.loadJob(operationId);
        if (prior) {
            if (prior.requestHash !== requestHash) throw new Error("IDEMPOTENCY_CONFLICT: operationId 已用于不同编译请求");
            return { ...this.getCompilation(id, owner, operationId), replayed: true };
        }
        const current = this.service.get(id);
        if (current.revision !== expectedRevision) throw new ProductionConflictError(current);
        if (!current.draft.director) throw new Error("缺少正式导演源稿");
        const director = this.compilationDirector(candidate || current.draft.director);
        if (scope && this.compiler === compileAchengDirector && !resolveAchengRuntime(director.engine.runtimeId).sourceContract?.scopedCompilation) throw new Error("SCOPED_COMPILATION_UNSUPPORTED: 当前激活引擎不支持按场次编译，请更新本机引擎");
        const boundFiles = this.service.compilationReferenceFiles(id, director);
        const preparedId = crypto.randomUUID(), directory = path.join(this.root, preparedId);
        const references: Record<string, string> = {};
        const freeze = (targetId: string, label: string, original?: string) => {
            const file = boundFiles[`${targetId}\0${label}`] || original;
            if (!file || !fs.existsSync(file)) return;
            const bytes = fs.readFileSync(file), digest = crypto.createHash("sha256").update(bytes).digest("hex");
            const destination = path.join(directory, "inputs", digest + path.extname(file));
            fs.mkdirSync(path.dirname(destination), { recursive: true });
            if (!fs.existsSync(destination)) fs.writeFileSync(destination, bytes);
            references[`${targetId}\0${label}`] = destination;
        };
        for (const [assetId, asset] of Object.entries(director.assets)) if (asset.storageKey) freeze(assetId, "asset");
        for (const card of (director.source.asset_cards || []) as any[]) for (const ref of card.references || []) freeze(card.id, ref.label || `<Picture ${ref.image}>`, path.isAbsolute(ref.file || "") ? ref.file : undefined);
        const scopeHash = scope ? compilationScopeInput(director, scope).inputHash : undefined;
        const job: CompilationJob = { operationId, owner, id, expectedRevision, requestHash, baselineHash: hash(current.draft.director), preparedId, director, references, scope, scopeHash, status: "queued", diagnostics: [], createdAt: new Date().toISOString() };
        this.saveJob(job); this.scheduleJob(job);
        return this.getCompilation(id, owner, operationId);
    }
    async preflight(id: string, expectedRevision: number, candidate?: DirectorProduction, scope?: CompilationScope) {
        const current = this.service.get(id);
        if (current.revision !== expectedRevision) throw new ProductionConflictError(current);
        if (!current.draft.director) throw new Error("COMPILE_STAGE_NOT_READY: 请先保存正式导演源稿");
        const director = this.compilationDirector(candidate || current.draft.director);
        const references = this.service.compilationReferenceFiles(id, director);
        const compileInput = scope ? scopedCompilerInput(compilationScopeInput(director, scope).director, scope) : director;
        const result = await new Promise<any>((resolve, reject) => {
            const worker = new Worker(`const { parentPort, workerData } = require("node:worker_threads");
                (async () => { const engine = await import(workerData.module); parentPort.postMessage(engine.preflightCompilationDirector(workerData.director, (id, label) => workerData.references[id + "\\0" + label], workerData.director.engine.runtimeId)); })().catch(error => parentPort.postMessage({ error: error.message }));`, { eval: true, workerData: { module: import.meta.resolve("@basketikun/canvas-agent/skills/acheng"), director: compileInput, references } });
            let delivered = false;
            worker.once("message", message => { delivered = true; message.error ? reject(new Error(message.error)) : resolve(message); }); worker.once("error", reject);
            worker.once("exit", code => { if (!delivered) reject(new Error(`预检执行单元退出 (${code})`)); });
        });
        return { ...result, revision: current.revision, scope };
    }
    recover(owner: string) {
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
                        job.result = this.shortResult(job.preparedId, packet); job.diagnostics = packet.diagnostics; job.continuityReceipt = packet.continuityReceipt; job.status = hasFatalCompilationError(job.diagnostics) ? "blocked" : "succeeded";
                    } else { job.status = "interrupted"; job.diagnostics = [{ code: "INVALID_COMPILATION_PACKET", severity: "error", message: "恢复的编译包完整性校验失败" }]; }
                } else { job.status = "interrupted"; job.diagnostics = [{ code: "COMPILATION_INTERRUPTED", severity: "error", message: "服务重启中断编译；已确认未完成，不自动重跑" }]; }
                this.saveJob(job);
            }
        }
    }
    private shortResult(preparedId: string, packet: any) {
        return { preparedId, sourceHash: packet.director.sourceHash, targets: packet.director.artifacts.filter((a: any) => !packet.targetIds || packet.targetIds.includes(a.targetId)).map((a: any) => ({ id: a.id, targetId: a.targetId, kind: a.kind, status: a.status, sha256: a.sha256, referenceCount: a.references.length })) };
    }
    private applyContinuityGate(id: string, director: DirectorProduction, diagnostics: any[], targetIds?: string[]) {
        if ((director.source.ledger as any)?.contract_version !== 2) return undefined;
        const continuity = this.service.continuityForDirector(id, director);
        for (const artifact of director.artifacts.filter(item => item.kind === "h3" && item.status === "ready" && (!targetIds || targetIds.includes(item.targetId)))) {
            const blockers = continuityTargetBlockers(continuity, [artifact.targetId]);
            if (!blockers.length) continue;
            artifact.status = "draft";
            artifact.receipt = { ...artifact.receipt, continuityDiagnostics: blockers };
            diagnostics.push(...blockers.map(blocker => ({ code: blocker.code, path: `artifacts.${artifact.targetId}.continuity`, targetId: artifact.targetId,
                message: blocker.message, severity: "error" })));
        }
        return { sourceHash: director.sourceHash, runtimeId: director.engine.runtimeId, reportSourceHash: continuity.report?.sourceHash || null,
            reportRuntimeId: continuity.report?.runtimeId || null, reportOperationId: continuity.report?.operationId || null,
            checkedAt: continuity.report?.checkedAt || null, status: continuity.status };
    }
    private scheduleJob(job: CompilationJob) {
        const key = this.jobFile(job.operationId);
        if (activeJobs.has(key)) return;
        activeJobs.add(key);
        schedule(async () => {
            try {
                job.status = "running"; this.saveJob(job);
                const directory = path.join(this.root, job.preparedId);
                const projection = job.scope ? compilationScopeInput(job.director, job.scope) : undefined;
                const compileInput = projection && job.scope ? scopedCompilerInput(projection.director, job.scope) : job.director;
                let compiled: ReturnType<Compiler>;
                const cached = projection && projection.targetIds.length > 0 && projection.targetIds.every(targetId => job.director.artifacts.some(item => item.targetId === targetId && item.status === "ready" && item.receipt.engineRuntimeId === job.director.engine.runtimeId && currentCompilationArtifact(job.director, item)));
                if (cached) compiled = { director: structuredClone(compileInput), exitCode: 0, diagnostics: [], audit: { status: "REUSED", artifactIds: compileInput.artifacts.map(item => item.id) }, sourceAdjustments: [], acceptance: { reused: true } };
                else if (this.compiler !== compileAchengDirector) compiled = await this.compiler(structuredClone(compileInput), directory, (targetId, label) => job.references[`${targetId}\0${label}`]);
                else compiled = await new Promise((resolve, reject) => {
                    const worker = new Worker(`const { parentPort, workerData } = require("node:worker_threads");
                        (async () => { const engine = await import(workerData.module);
                          const resolveRef = (targetId, label) => workerData.references[targetId + "\\0" + label];
                          const checked = engine.preflightCompilationDirector(workerData.director, resolveRef, workerData.director.engine.runtimeId);
                          if (!checked.valid) { parentPort.postMessage({ blocked: checked.diagnostics }); return; }
                          parentPort.postMessage({ compiled: engine.compileAchengDirector(workerData.director, workerData.directory, resolveRef, workerData.director.engine.runtimeId) });
                        })().catch(error => parentPort.postMessage({ error: error.message }));`, { eval: true, workerData: { module: import.meta.resolve("@basketikun/canvas-agent/skills/acheng"), director: compileInput, references: job.references, directory } });
                    let delivered = false;
                    worker.once("message", message => { delivered = true; if (message.error) reject(new Error(message.error)); else if (message.blocked) reject(new ProductionValidationError(message.blocked)); else resolve(message.compiled); });
                    worker.once("error", reject);
                    worker.once("exit", code => { if (!delivered) reject(new Error(`编译执行单元退出 (${code})`)); });
                });
                if (projection && job.scope) {
                    const projectedSourceHash = compiled.director.sourceHash;
                    const artifacts = compiled.director.artifacts.filter(artifact => projection.targetIds.includes(artifact.targetId)).map(artifact => {
                        const prior = job.director.artifacts.find(item => item.kind === artifact.kind && item.targetId === artifact.targetId && item.sha256 === artifact.sha256 && item.receipt.engineRuntimeId === artifact.receipt.engineRuntimeId && currentCompilationArtifact(job.director, item));
                        if (prior) return prior;
                        const targetScope = { targetIds: [artifact.targetId] };
                        return { ...artifact, sourceHash: job.director.sourceHash, receipt: { ...artifact.receipt, sourceHash: job.director.sourceHash,
                            compilationScope: { scope: targetScope, inputHash: compilationScopeInput(job.director, targetScope).inputHash, engine: artifact.receipt.engine || job.director.engine, projectedSourceHash } } };
                    });
                    compiled.director = { ...structuredClone(job.director), artifacts: [...job.director.artifacts.filter(item => !projection.targetIds.includes(item.targetId)), ...artifacts] };
                }
                if (compiled.director.workflow.currentWork) compiled.director.workflow.currentWork = { ...compiled.director.workflow.currentWork, inputRevision: job.expectedRevision, sourceHash: compiled.director.sourceHash };
                const continuityReceipt = this.applyContinuityGate(job.id, compiled.director, compiled.diagnostics, projection?.targetIds);
                job.continuityReceipt = continuityReceipt;
                const packet = { owner: job.owner, id: job.id, expectedRevision: job.expectedRevision, baselineHash: job.baselineHash, scope: job.scope, scopeHash: job.scopeHash, targetIds: projection?.targetIds, operationId: `compilation:${job.preparedId}`, resultHash: hash(compiled.director), ...compiled, continuityReceipt };
                fs.mkdirSync(directory, { recursive: true });
                const temporary = this.file(job.preparedId) + ".tmp";
                fs.writeFileSync(temporary, JSON.stringify({ ...packet, packetHash: hash(packet) }), "utf8"); fs.renameSync(temporary, this.file(job.preparedId));
                job.result = this.shortResult(job.preparedId, packet); job.diagnostics = compiled.diagnostics;
                job.status = hasFatalCompilationError(compiled.diagnostics) ? "blocked" : "succeeded";
            } catch (error) {
                job.status = error instanceof ProductionValidationError ? "blocked" : "failed";
                job.diagnostics = error instanceof ProductionValidationError ? error.diagnostics : [{ code: "COMPILATION_FAILED", path: "compile", message: error instanceof Error ? error.message : String(error), severity: "error" }];
            } finally { try { this.saveJob(job); } finally { activeJobs.delete(key); this.onSettled?.(job.id); } }
        }, job.createdAt);
    }

    private file(preparedId: string) {
        if (!/^[a-f0-9-]{36}$/.test(preparedId)) throw new Error("Invalid compilation handle");
        return path.join(this.root, preparedId, "packet.json");
    }

    prepare(id: string, owner: string, expectedRevision: number, candidate?: DirectorProduction) {
        const current = this.service.get(id);
        if (current.revision !== expectedRevision) throw new ProductionConflictError(current);
        if (!current.draft.director) throw new Error("Missing formal director source");
        const director = this.compilationDirector(candidate || current.draft.director);
        const checked = this.service.preflight(id, { action: "compile", request: { expectedRevision, director } }, this.compiler === compileAchengDirector ? director.engine.runtimeId : undefined);
        if (!checked.valid) throw new ProductionValidationError(checked.diagnostics);
        this.service.verifyCompilationBindings(id, director);
        const preparedId = crypto.randomUUID();
        const directory = path.join(this.root, preparedId);
        const compiled = this.compiler(director, directory, (targetId, label) => this.service.compilationReferenceFile(id, director, targetId, label), this.compiler === compileAchengDirector ? director.engine.runtimeId : undefined);
        const continuityReceipt = this.applyContinuityGate(id, compiled.director, compiled.diagnostics);
        if (compiled.director.workflow.currentWork) {
            compiled.director.workflow.currentWork = { ...compiled.director.workflow.currentWork, inputRevision: expectedRevision, sourceHash: compiled.director.sourceHash };
        }
        if (hash(this.service.get(id).draft.director) !== hash(current.draft.director) || this.service.get(id).revision !== expectedRevision) throw new ProductionConflictError(this.service.get(id));
        const packet = { owner, id, expectedRevision, baselineHash: hash(current.draft.director), operationId: `compilation:${preparedId}`, resultHash: hash(compiled.director), ...compiled, continuityReceipt };
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(this.file(preparedId), JSON.stringify({ ...packet, packetHash: hash(packet) }), { encoding: "utf8", flag: "wx" });
        return { preparedId, operationId: packet.operationId, expectedRevision, sourceHash: compiled.director.sourceHash, engine: director.engine, continuityReceipt, diagnostics: compiled.diagnostics,
            audit: compiled.audit, sourceAdjustments: compiled.sourceAdjustments, targets: compiled.director.artifacts.map(a => ({ id: a.id, targetId: a.targetId, kind: a.kind, status: a.status, sha256: a.sha256, references: a.references, diagnostics: a.receipt.diagnostics })), mediaSubmitted: false };
    }

    apply(id: string, owner: string, preparedId: string) {
        const { packetHash, ...packet } = JSON.parse(fs.readFileSync(this.file(preparedId), "utf8"));
        if (hash(packet) !== packetHash) throw new Error("Frozen compilation bytes changed");
        if (packet.owner !== owner || packet.id !== id) throw new Error("Compilation belongs to a different production");
        if (hash(packet.director) !== packet.resultHash) throw new Error("Frozen compilation bytes changed");
        if (hasFatalCompilationError(packet.diagnostics)) throw new Error("Compilation has unresolved global errors; correct its source and prepare a new packet");
        const current = this.service.get(id);
        if (packet.scope) {
            const committed = this.service.operationReceipt(id, packet.operationId);
            if (committed) return { revision: committed.revision, sourceHash: committed.draft.director?.sourceHash, referenceSync: committed.referenceSync, replayed: true, mediaSubmitted: false };
            const director = current.draft.director;
            if (!director) throw new ProductionConflictError(current);
            const input = compilationScopeInput({ ...director, engine: packet.director.engine }, packet.scope);
            if (input.inputHash !== packet.scopeHash && input.legacyInputHash !== packet.scopeHash) throw new ProductionConflictError(current);
            const targets = new Set<string>(packet.targetIds);
            const preserved = structuredClone(director); preserveCompilationProvenance(preserved);
            const merged = { ...preserved, engine: packet.director.engine, artifacts: [...preserved.artifacts.filter(item => !targets.has(item.targetId)), ...packet.director.artifacts.filter((item: any) => targets.has(item.targetId))] };
            this.service.verifyCompilationBindings(id, merged);
            if ((merged.source.ledger as any)?.contract_version === 2) {
                const readyTargets = merged.artifacts.filter(item => targets.has(item.targetId) && item.kind === "h3" && item.status === "ready").map(item => item.targetId);
                if (readyTargets.length) {
                    const blockers = continuityTargetBlockers(this.service.continuityForDirector(id, merged), readyTargets);
                    if (blockers.length) throw new Error(`CONTINUITY_PACKET_BLOCKED: ${blockers.map(item => item.message).join("；")}`);
                }
            }
            const result = this.service.edit(id, { operationId: packet.operationId, expectedRevision: current.revision, ops: [{ type: "set_director_production", director: merged }] });
            return { referenceSync: result.referenceSync, revision: result.revision, sourceHash: result.draft.director?.sourceHash, replayed: result.replayed === true, operationId: packet.operationId, mediaSubmitted: false };
        }

        // Let the ops service recover an already committed operation before its revision check.
        if (current.revision === packet.expectedRevision) {
            if (hash(current.draft.director) !== packet.baselineHash) throw new ProductionConflictError(current);
            this.service.verifyCompilationBindings(id, packet.director);
            if (packet.continuityReceipt) {
                const readyTargets = packet.director.artifacts.filter((item: any) => item.kind === "h3" && item.status === "ready").map((item: any) => item.targetId);
                if (readyTargets.length) {
                    const continuity = this.service.continuityForDirector(id, packet.director);
                    if (continuity.report?.sourceHash !== packet.continuityReceipt.reportSourceHash || continuity.report?.runtimeId !== packet.continuityReceipt.reportRuntimeId ||
                        (continuity.report?.operationId || null) !== packet.continuityReceipt.reportOperationId) throw new Error("CONTINUITY_PACKET_STALE: 连续性检查回执在编译后已变化，请重新编译");
                    const blockers = continuityTargetBlockers(continuity, readyTargets);
                    if (blockers.length) throw new Error(`CONTINUITY_PACKET_BLOCKED: ${blockers.map(item => item.message).join("；")}`);
                }
            }
        }
        const result = this.service.edit(id, { operationId: packet.operationId, expectedRevision: packet.expectedRevision, ops: [{ type: "set_director_production", director: packet.director }] });
        const receipt = { referenceSync: result.referenceSync, revision: result.revision, replayed: result.replayed === true, publishedVersion: result.publishedVersion, sourceHash: result.draft.director?.sourceHash, operationId: packet.operationId, mediaSubmitted: false };
        const operations = path.join(this.root, "operations");
        if (fs.existsSync(operations)) for (const name of fs.readdirSync(operations).filter(name => name.endsWith(".json"))) {
            const job: CompilationJob = JSON.parse(fs.readFileSync(path.join(operations, name), "utf8"));
            if (job.preparedId === preparedId && job.owner === owner && job.id === id) { job.application = receipt; this.saveJob(job); break; }
        }
        return receipt;
    }
}
