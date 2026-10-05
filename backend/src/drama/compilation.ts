import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Worker } from "node:worker_threads";
import { compileAchengDirector } from "@basketikun/canvas-agent/skills/acheng";
import { canonicalProduction, directorProductionSchema, type DirectorProduction } from "@basketikun/canvas-agent/drama/production-contract";
import { EpisodeProductionService, ProductionConflictError } from "./production.js";
import { ProductionValidationError } from "@basketikun/canvas-agent/drama/production-validation";

const hash = (value: unknown) => crypto.createHash("sha256").update(canonicalProduction(value)).digest("hex");
type Compiler = typeof compileAchengDirector;
type CompilationJob = { operationId: string; owner: string; id: string; expectedRevision: number; requestHash: string; baselineHash: string; preparedId: string; director: DirectorProduction; references: Record<string, string>; status: "queued" | "running" | "succeeded" | "blocked" | "failed" | "interrupted"; diagnostics: any[]; result?: any; application?: any; createdAt: string };
const pending: Array<{ work: () => Promise<void>; createdAt: string }> = [];
let draining = false;
function schedule(work: () => Promise<void>, createdAt: string) {
    pending.push({ work, createdAt });
    pending.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    if (draining) return;
    draining = true;
    setImmediate(async () => {
        try {
            while (pending.length) {
                try { await pending.shift()!.work(); }
                catch (error) { console.error("COMPILATION_RECEIPT_WRITE_FAILED", error instanceof Error ? error.name : "Error"); }
            }
        } finally { draining = false; }
    });
}
const activeJobs = new Set<string>();

/** Frozen compiler packets are sidecar files; only the existing ops transaction edits production. */
export class ProductionCompilationService {
    constructor(private service: EpisodeProductionService, private root: string, private compiler: Compiler = compileAchengDirector) {}

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
        const base = { operationId, status: job.status, expectedRevision: job.expectedRevision, sourceHash: job.result?.sourceHash || job.director.sourceHash, ...(job.status === "succeeded" ? { preparedId: job.preparedId } : {}), application: job.application || this.applicationReceipt(job), mediaSubmitted: false };
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
    enqueue(id: string, owner: string, operationId: string, expectedRevision: number, candidate?: DirectorProduction) {
        const requestHash = hash({ id, owner, expectedRevision, candidate });
        const prior = this.loadJob(operationId);
        if (prior) {
            if (prior.requestHash !== requestHash) throw new Error("IDEMPOTENCY_CONFLICT: operationId 已用于不同编译请求");
            return { ...this.getCompilation(id, owner, operationId), replayed: true };
        }
        const current = this.service.get(id);
        if (current.revision !== expectedRevision) throw new ProductionConflictError(current);
        if (!current.draft.director) throw new Error("缺少正式导演源稿");
        const director = directorProductionSchema.parse(structuredClone(candidate || current.draft.director));
        if (hash(director.engine) !== hash(current.draft.director.engine)) throw new Error("ENGINE_MISMATCH: 必须使用制作对象固定引擎");
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
        const job: CompilationJob = { operationId, owner, id, expectedRevision, requestHash, baselineHash: hash(current.draft.director), preparedId, director, references, status: "queued", diagnostics: [], createdAt: new Date().toISOString() };
        this.saveJob(job); this.scheduleJob(job);
        return this.getCompilation(id, owner, operationId);
    }
    async preflight(id: string, expectedRevision: number, candidate?: DirectorProduction) {
        const current = this.service.get(id);
        if (current.revision !== expectedRevision) throw new ProductionConflictError(current);
        if (!current.draft.director) throw new Error("COMPILE_STAGE_NOT_READY: 请先保存正式导演源稿");
        const director = directorProductionSchema.parse(structuredClone(candidate || current.draft.director));
        if (hash(director.engine) !== hash(current.draft.director.engine)) throw new Error("ENGINE_MISMATCH: 必须使用制作固定引擎");
        const references = this.service.compilationReferenceFiles(id, director);
        const result = await new Promise<any>((resolve, reject) => {
            const worker = new Worker(`const { parentPort, workerData } = require("node:worker_threads");
                (async () => { const engine = await import(workerData.module); parentPort.postMessage(engine.preflightCompilationDirector(workerData.director, (id, label) => workerData.references[id + "\\0" + label])); })().catch(error => parentPort.postMessage({ error: error.message }));`, { eval: true, workerData: { module: import.meta.resolve("@basketikun/canvas-agent/skills/acheng"), director, references } });
            let delivered = false;
            worker.once("message", message => { delivered = true; message.error ? reject(new Error(message.error)) : resolve(message); }); worker.once("error", reject);
            worker.once("exit", code => { if (!delivered) reject(new Error(`预检执行单元退出 (${code})`)); });
        });
        return { ...result, revision: current.revision };
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
                        job.result = this.shortResult(job.preparedId, packet); job.diagnostics = packet.diagnostics; job.status = job.diagnostics.some(d => d.severity === "error") ? "blocked" : "succeeded";
                    } else { job.status = "interrupted"; job.diagnostics = [{ code: "INVALID_COMPILATION_PACKET", severity: "error", message: "恢复的编译包完整性校验失败" }]; }
                } else { job.status = "interrupted"; job.diagnostics = [{ code: "COMPILATION_INTERRUPTED", severity: "error", message: "服务重启中断编译；已确认未完成，不自动重跑" }]; }
                this.saveJob(job);
            }
        }
    }
    private shortResult(preparedId: string, packet: any) {
        return { preparedId, sourceHash: packet.director.sourceHash, targets: packet.director.artifacts.map((a: any) => ({ id: a.id, targetId: a.targetId, kind: a.kind, status: a.status, sha256: a.sha256, referenceCount: a.references.length })) };
    }
    private scheduleJob(job: CompilationJob) {
        const key = this.jobFile(job.operationId);
        if (activeJobs.has(key)) return;
        activeJobs.add(key);
        schedule(async () => {
            try {
                job.status = "running"; this.saveJob(job);
                const directory = path.join(this.root, job.preparedId);
                let compiled: ReturnType<Compiler>;
                if (this.compiler !== compileAchengDirector) compiled = this.compiler(structuredClone(job.director), directory, (targetId, label) => job.references[`${targetId}\0${label}`]);
                else compiled = await new Promise((resolve, reject) => {
                    const worker = new Worker(`const { parentPort, workerData } = require("node:worker_threads");
                        (async () => { const engine = await import(workerData.module);
                          const resolveRef = (targetId, label) => workerData.references[targetId + "\\0" + label];
                          const checked = engine.preflightCompilationDirector(workerData.director, resolveRef);
                          if (!checked.valid) { parentPort.postMessage({ blocked: checked.diagnostics }); return; }
                          parentPort.postMessage({ compiled: engine.compileAchengDirector(workerData.director, workerData.directory, resolveRef) });
                        })().catch(error => parentPort.postMessage({ error: error.message }));`, { eval: true, workerData: { module: import.meta.resolve("@basketikun/canvas-agent/skills/acheng"), director: job.director, references: job.references, directory } });
                    let delivered = false;
                    worker.once("message", message => { delivered = true; if (message.error) reject(new Error(message.error)); else if (message.blocked) reject(new ProductionValidationError(message.blocked)); else resolve(message.compiled); });
                    worker.once("error", reject);
                    worker.once("exit", code => { if (!delivered) reject(new Error(`编译执行单元退出 (${code})`)); });
                });
                if (compiled.director.workflow.currentWork) compiled.director.workflow.currentWork = { ...compiled.director.workflow.currentWork, inputRevision: job.expectedRevision, sourceHash: compiled.director.sourceHash };
                const packet = { owner: job.owner, id: job.id, expectedRevision: job.expectedRevision, baselineHash: job.baselineHash, operationId: `compilation:${job.preparedId}`, resultHash: hash(compiled.director), ...compiled };
                fs.mkdirSync(directory, { recursive: true });
                const temporary = this.file(job.preparedId) + ".tmp";
                fs.writeFileSync(temporary, JSON.stringify({ ...packet, packetHash: hash(packet) }), "utf8"); fs.renameSync(temporary, this.file(job.preparedId));
                job.result = this.shortResult(job.preparedId, packet); job.diagnostics = compiled.diagnostics;
                job.status = compiled.diagnostics.some(d => d.severity === "error") ? "blocked" : "succeeded";
            } catch (error) {
                job.status = error instanceof ProductionValidationError ? "blocked" : "failed";
                job.diagnostics = error instanceof ProductionValidationError ? error.diagnostics : [{ code: "COMPILATION_FAILED", path: "compile", message: error instanceof Error ? error.message : String(error), severity: "error" }];
            } finally { try { this.saveJob(job); } finally { activeJobs.delete(key); } }
        }, job.createdAt);
    }

    private file(preparedId: string) {
        if (!/^[a-f0-9-]{36}$/.test(preparedId)) throw new Error("Invalid compilation handle");
        return path.join(this.root, preparedId, "packet.json");
    }

    prepare(id: string, owner: string, expectedRevision: number, candidate?: DirectorProduction) {
        const current = this.service.get(id);
        if (current.revision !== expectedRevision) throw new ProductionConflictError(current);
        const checked = this.service.preflight(id, { action: "compile", request: { expectedRevision, ...(candidate ? { director: candidate } : {}) } });
        if (!checked.valid) throw new ProductionValidationError(checked.diagnostics);
        if (!current.draft.director) throw new Error("Missing formal director source");
        const director = directorProductionSchema.parse(structuredClone(candidate || current.draft.director));
        if (hash(director.engine) !== hash(current.draft.director.engine)) throw new Error("Compilation must use the production's pinned engine");
        this.service.verifyCompilationBindings(id, director);
        const preparedId = crypto.randomUUID();
        const directory = path.join(this.root, preparedId);
        const compiled = this.compiler(director, directory, (targetId, label) => this.service.compilationReferenceFile(id, director, targetId, label));
        if (compiled.director.workflow.currentWork) {
            compiled.director.workflow.currentWork = { ...compiled.director.workflow.currentWork, inputRevision: expectedRevision, sourceHash: compiled.director.sourceHash };
        }
        if (hash(this.service.get(id).draft.director) !== hash(current.draft.director) || this.service.get(id).revision !== expectedRevision) throw new ProductionConflictError(this.service.get(id));
        const packet = { owner, id, expectedRevision, baselineHash: hash(current.draft.director), operationId: `compilation:${preparedId}`, resultHash: hash(compiled.director), ...compiled };
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(this.file(preparedId), JSON.stringify({ ...packet, packetHash: hash(packet) }), { encoding: "utf8", flag: "wx" });
        return { preparedId, operationId: packet.operationId, expectedRevision, sourceHash: compiled.director.sourceHash, engine: director.engine, diagnostics: compiled.diagnostics,
            audit: compiled.audit, sourceAdjustments: compiled.sourceAdjustments, targets: compiled.director.artifacts.map(a => ({ id: a.id, targetId: a.targetId, kind: a.kind, status: a.status, sha256: a.sha256, references: a.references, diagnostics: a.receipt.diagnostics })), mediaSubmitted: false };
    }

    apply(id: string, owner: string, preparedId: string) {
        const { packetHash, ...packet } = JSON.parse(fs.readFileSync(this.file(preparedId), "utf8"));
        if (hash(packet) !== packetHash) throw new Error("Frozen compilation bytes changed");
        if (packet.owner !== owner || packet.id !== id) throw new Error("Compilation belongs to a different production");
        if (hash(packet.director) !== packet.resultHash) throw new Error("Frozen compilation bytes changed");
        if (packet.diagnostics.some((d: { severity: string }) => d.severity === "error")) throw new Error("Compilation has unresolved errors; correct its source and prepare a new packet");
        const current = this.service.get(id);
        // Let the ops service recover an already committed operation before its revision check.
        if (current.revision === packet.expectedRevision) {
            if (hash(current.draft.director) !== packet.baselineHash) throw new ProductionConflictError(current);
            this.service.verifyCompilationBindings(id, packet.director);
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
