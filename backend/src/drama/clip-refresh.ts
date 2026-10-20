import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { compilationScopeInput, currentCompilationArtifact } from "@basketikun/canvas-agent/drama/compilation-scope";
import type { DirectorProduction } from "@basketikun/canvas-agent/drama/production-contract";
import type { EpisodeProductionService } from "./production.js";
import type { ProductionCompilationService } from "./compilation.js";

type Status = "queued" | "checking" | "compiling" | "applying" | "succeeded" | "blocked" | "failed" | "superseded" | "interrupted";
export type ClipRefreshJob = {
    owner: { kind: string; id: string }; operationId: string; parentOperationId: string; compilationOperationId: string; continuityOperationId: string;
    segmentId: string; savedRevision: number; sourceHash: string; inputHash: string; status: Status;
    snapshot: DirectorProduction; affectedTargets: string[]; diagnostics: any[]; timings: Record<string, number>;
    createdAt: string; updatedAt: string; preparedId?: string; application?: any; compileRevision?: number; continuityRevision?: number;
    translationOperationId?: string; translationExpectedRevision?: number; translationError?: string;
};
const activeStatuses = ["queued", "checking", "compiling", "applying"];
/** Terminal jobs never resume, so their embedded DirectorProduction snapshot is dead weight (multi-MB rows made currentBySegment scan seconds). */
const prunedOwners = new Set<string>();
export const clipRefreshScope = (segmentId: string) => ({ targetIds: [segmentId], output: "selected" as const });

export class ClipRefreshStore {
    constructor(private db: DatabaseSync, readonly owner: { kind: string; id: string }) {}
    register(parentOperationId: string, savedRevision: number, before: DirectorProduction, snapshot: DirectorProduction, segmentId: string) {
        const operationId = `${parentOperationId}:clip:${segmentId}`;
        const suffix = crypto.createHash("sha256").update(JSON.stringify({ owner: this.owner, operationId })).digest("hex");
        const job: ClipRefreshJob = { owner: this.owner, operationId, parentOperationId, compilationOperationId: `clip-refresh:${suffix}`, continuityOperationId: `clip-continuity:${suffix}`,
            segmentId, savedRevision, sourceHash: snapshot.sourceHash, inputHash: compilationScopeInput(snapshot, clipRefreshScope(segmentId)).inputHash,
            snapshot, affectedTargets: before.artifacts.filter(a => a.kind === "h3" && currentCompilationArtifact(before, a) && !currentCompilationArtifact(snapshot, a)).map(a => a.targetId),
            status: "queued", diagnostics: [], timings: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
        this.db.prepare("INSERT INTO production_clip_refresh_jobs(owner_kind, owner_id, operation_id, parent_operation_id, compilation_id, status, job_json) VALUES (?, ?, ?, ?, ?, ?, ?)")
            .run(this.owner.kind, this.owner.id, operationId, parentOperationId, job.compilationOperationId, job.status, JSON.stringify(job));
        return job;
    }
    get(compilationId: string): ClipRefreshJob | undefined {
        const row = this.db.prepare("SELECT job_json FROM production_clip_refresh_jobs WHERE owner_kind=? AND owner_id=? AND (compilation_id=? OR operation_id=?)").get(this.owner.kind, this.owner.id, compilationId, compilationId);
        return row ? JSON.parse(String(row.job_json)) : undefined;
    }
    byEdit(operationId: string): ClipRefreshJob | undefined {
        const row = this.db.prepare("SELECT job_json FROM production_clip_refresh_jobs WHERE owner_kind=? AND owner_id=? AND parent_operation_id=? ORDER BY operation_id LIMIT 1").get(this.owner.kind, this.owner.id, operationId);
        return row ? JSON.parse(String(row.job_json)) : undefined;
    }
    byEditAll(operationId: string): ClipRefreshJob[] {
        return this.db.prepare("SELECT job_json FROM production_clip_refresh_jobs WHERE owner_kind=? AND owner_id=? AND parent_operation_id=? ORDER BY operation_id").all(this.owner.kind, this.owner.id, operationId).map(r => JSON.parse(String(r.job_json)));
    }
    bySegment(segmentId: string): ClipRefreshJob[] {
        return this.db.prepare("SELECT job_json FROM production_clip_refresh_jobs WHERE owner_kind=? AND owner_id=? AND json_extract(job_json,'$.segmentId')=? ORDER BY json_extract(job_json,'$.savedRevision') DESC, json_extract(job_json,'$.updatedAt') DESC")
            .all(this.owner.kind, this.owner.id, segmentId).map(r => JSON.parse(String(r.job_json)));
    }
    pending(): ClipRefreshJob[] {
        return this.db.prepare("SELECT job_json FROM production_clip_refresh_jobs WHERE owner_kind=? AND owner_id=? AND status IN ('queued','checking','compiling','applying')").all(this.owner.kind, this.owner.id).map(r => JSON.parse(String(r.job_json)));
    }
    currentBySegment(): ClipRefreshJob[] {
        const ownerKey = `${this.owner.kind}:${this.owner.id}`;
        if (!prunedOwners.has(ownerKey)) {
            this.db.prepare("UPDATE production_clip_refresh_jobs SET job_json=json_remove(job_json,'$.snapshot') WHERE owner_kind=? AND owner_id=? AND status NOT IN ('queued','checking','compiling','applying') AND json_extract(job_json,'$.snapshot') IS NOT NULL")
                .run(this.owner.kind, this.owner.id);
            prunedOwners.add(ownerKey);
        }
        const query = "SELECT job_json FROM (SELECT job_json, ROW_NUMBER() OVER(PARTITION BY json_extract(job_json,'$.segmentId') ORDER BY json_extract(job_json,'$.updatedAt') DESC, operation_id DESC) AS rank FROM production_clip_refresh_jobs WHERE owner_kind=? AND owner_id=?) WHERE rank=1";
        return this.db.prepare(query).all(this.owner.kind, this.owner.id).map(row => JSON.parse(String(row.job_json)));
    }
    owners(): string[] {
        return this.db.prepare("SELECT DISTINCT owner_id FROM production_clip_refresh_jobs WHERE owner_kind=? AND status IN ('queued','checking','compiling','applying')").all(this.owner.kind).map(r => String(r.owner_id));
    }
    save(job: ClipRefreshJob) {
        job.updatedAt = new Date().toISOString();
        const payload = activeStatuses.includes(job.status) ? job : { ...job, snapshot: undefined };
        this.db.prepare("UPDATE production_clip_refresh_jobs SET status=?, job_json=? WHERE owner_kind=? AND owner_id=? AND compilation_id=?")
            .run(job.status, JSON.stringify(payload), this.owner.kind, this.owner.id, job.compilationOperationId);
    }
}

export function clipRefreshReceipt(job: ClipRefreshJob) {
    return { sourceSaved: true, operationId: job.operationId, status: job.status, segmentId: job.segmentId, savedRevision: job.savedRevision,
        sourceHash: job.sourceHash, compilationOperationId: job.compilationOperationId, selectedTargets: [job.segmentId],
        createdAt: job.createdAt, updatedAt: job.updatedAt,
        affectedTargets: job.affectedTargets, affectedReason: "Registered target inputs changed", blockingDiagnostic: job.diagnostics[0],
        timings: job.timings, ...(job.translationOperationId ? { translationOperationId: job.translationOperationId } : {}),
        ...(job.translationError ? { translationError: job.translationError } : {}),
        ...(job.application ? { application: { revision: job.application.revision, sourceHash: job.application.sourceHash,
            referenceSync: (job.application.referenceSync || []).map((item: any) => ({ targetId: item.targetId, status: item.status,
                referenceCount: item.referenceCount, ...(item.diagnostics?.length ? { diagnostics: item.diagnostics } : {}) })) } } : {}), mediaSubmitted: false };
}

/** Durable orchestration only: compiler packets and canvas ops remain authoritative. */
export class ClipRefreshCoordinator {
    private active = new Set<string>();
    constructor(private service: EpisodeProductionService, private compilations: ProductionCompilationService, private owner: string) {}
    recover() { for (const id of this.service.clipRefreshStore("").owners()) this.wake(id); }
    wake(id: string) {
        let store: ClipRefreshStore;
        try { store = this.service.clipRefreshStore(id); } catch { return; }
        const pending = store.pending();
        const latestBySegment = new Map<string, ClipRefreshJob>();
        for (const job of pending) {
            const latest = latestBySegment.get(job.segmentId);
            if (!latest || job.savedRevision > latest.savedRevision || job.savedRevision === latest.savedRevision && job.createdAt > latest.createdAt) latestBySegment.set(job.segmentId, job);
        }
        for (const job of pending) {
            if (latestBySegment.get(job.segmentId) === job) continue;
            if (job.compileRevision !== undefined) this.compilations.cancel(id, this.owner, job.compilationOperationId);
            job.status = "superseded";
            job.diagnostics = [...job.diagnostics, { code: "CLIP_REFRESH_SUPERSEDED", targetId: job.segmentId, message: "同一 Clip 已保存更新版本，旧刷新已替代。" }];
            store.save(job);
        }
        for (const job of latestBySegment.values()) {
            for (const prior of store.bySegment(job.segmentId)) {
                if (prior.operationId !== job.operationId && prior.savedRevision <= job.savedRevision && prior.translationOperationId) {
                    this.service.cancelCompiledPromptTranslation(id, prior.translationOperationId);
                }
            }
            void this.advance(id, job, store);
        }
    }
    wakeSourceCanvas(projectId: string, nodeIds: string[], revision: number, eventId: string) {
        const consumers = this.service.subjectClipConsumers(projectId, nodeIds);
        for (const consumer of consumers) {
            let record: any;
            try { record = this.service.get(consumer.owner_id); } catch { continue; }
            const director = record.draft.director as DirectorProduction | undefined;
            if (!director || !clipRefreshScope(consumer.segment_id).targetIds.every(target => (director.source.segments as any[] || []).some(segment => segment.id === target))) continue;
            let resolved: DirectorProduction;
            try { resolved = this.service.resolveSubjectPictureInputs(consumer.owner_id, director, [consumer.segment_id], true, undefined, []); }
            catch (error) {
                const store = this.service.clipRefreshStore(consumer.owner_id);
                const parent = `smart-result:${projectId}:${revision}:${eventId}`;
                const prior = store.byEditAll(parent).some(job => job.segmentId === consumer.segment_id);
                if (!prior) store.register(parent, record.revision, director, director, consumer.segment_id);
                this.wake(consumer.owner_id);
                continue;
            }
            const priorInput = compilationScopeInput(director, clipRefreshScope(consumer.segment_id)).inputHash;
            const nextInput = compilationScopeInput(resolved, clipRefreshScope(consumer.segment_id)).inputHash;
            if (priorInput === nextInput) continue;
            const store = this.service.clipRefreshStore(consumer.owner_id), parent = `smart-result:${projectId}:${revision}:${eventId}`;
            if (!store.byEditAll(parent).some(job => job.segmentId === consumer.segment_id)) store.register(parent, record.revision, director, resolved, consumer.segment_id);
            this.wake(consumer.owner_id);
        }
    }
    inspect(id: string, operationId: string, view: "status" | "targets" | "diagnostics" = "status", offset = 0, pageSize?: number) {
        const store = this.service.clipRefreshStore(id);
        const exact = store.get(operationId);
        const jobs = exact ? [exact] : store.byEditAll(operationId);
        if (!jobs.length) return undefined;
        const targetReceipt = (job: ClipRefreshJob) => {
            const receipt = clipRefreshReceipt(job);
            const referenceSync = job.application?.referenceSync?.filter((sync: any) => sync.targetId === job.segmentId) || [];
            let compiler: Record<string, unknown> | undefined;
            if (job.compileRevision !== undefined) {
                try {
                    const status = this.compilations.getCompilation(id, this.owner, job.compilationOperationId);
                    const targets: any = this.compilations.getCompilation(id, this.owner, job.compilationOperationId, "targets", 0, 1);
                    compiler = { status: status.status, verdict: status.verdict, preparedId: status.preparedId, blockingDiagnostic: status.blockingDiagnostic,
                        targets: (targets.items || []).map((item: any) => ({ targetId: item.targetId, status: item.status, diagnostics: item.diagnostics?.slice(0, 2) || [] })) };
                } catch { /* Keep the durable refresh receipt readable if its compiler packet was pruned. */ }
            }
            return { ...receipt, referenceSync, ...(receipt.application ? { application: { ...receipt.application, referenceSync } } : {}), ...(compiler ? { compiler } : {}),
                ...(job.translationOperationId ? { translation: this.service.compiledPromptTranslationStatus(id, job.translationOperationId, job.translationExpectedRevision ?? job.savedRevision, [job.segmentId]) } : {}),
            };
        };
        if (jobs.length > 1) {
            const targets = jobs.map(targetReceipt);
            const statuses = targets.map(item => String(item.status));
            const status = statuses.every(item => item === "succeeded") ? "succeeded"
                : statuses.some(item => activeStatuses.includes(item as Status)) ? "running"
                : statuses.some(item => item === "blocked") ? "blocked"
                : statuses.some(item => item === "failed") ? "failed"
                : statuses.some(item => item === "interrupted") ? "interrupted" : "superseded";
            const translations = targets.flatMap(item => item.translation ? [String(item.translation.status)] : []);
            const translationStatus = translations.length === 0 ? "not_started"
                : translations.every(item => item === "committed") ? "committed"
                : translations.some(item => ["queued", "translating", "applying"].includes(item)) ? "translating"
                : translations.some(item => item === "retry_required") ? "retry_required"
                : translations.some(item => item === "rejected_stale") ? "rejected_stale" : "pending";
            const summary = { sourceSaved: true, operationId, status, targetCount: targets.length, targetIds: targets.map(item => item.segmentId),
                counts: { ready: statuses.filter(item => item === "succeeded").length, running: statuses.filter(item => activeStatuses.includes(item as Status)).length,
                    blocked: statuses.filter(item => item === "blocked").length, failed: statuses.filter(item => item === "failed").length,
                    translated: translations.filter(item => item === "committed").length, translating: translations.filter(item => ["queued", "translating", "applying"].includes(item)).length,
                    translationRetryRequired: translations.filter(item => item === "retry_required").length, translationRejectedStale: translations.filter(item => item === "rejected_stale").length },
                phases: { source: "saved", compilation: statuses.every(item => item === "succeeded") ? "succeeded" : status,
                application: targets.every(item => item.referenceSync.some((sync: any) => sync.status === "ready")) ? "ready" : "pending",
                    translation: translationStatus, mediaSubmitted: false },
                mediaSubmitted: false, targets: targets.map(item => ({ segmentId: item.segmentId, status: item.status, compilationOperationId: item.compilationOperationId,
                    referenceSync: item.referenceSync, ...(item.compiler ? { compiler: item.compiler } : {}),
                    ...(item.translation ? { translation: item.translation } : {}), ...(item.blockingDiagnostic ? { blockingDiagnostic: item.blockingDiagnostic } : {}) })),
                nextAction: status === "running" ? { action: "wait", tool: "production_get_compilation", input: { id, kind: this.owner.startsWith("/canvas/") ? "canvas" : this.owner.startsWith("/drama/scenes/") ? "scene" : "episode", operationId } }
                    : status === "succeeded" ? { action: "done" } : { action: "review_targets", message: "先处理阻塞目标的诊断；已就绪目标无需重复编译。" } };
            if (view === "status") return summary;
            if (!pageSize) throw new Error("查询编译列表必须指定 pageSize");
            const items = view === "diagnostics" ? targets.flatMap(item => item.blockingDiagnostic ? [{ targetId: item.segmentId, ...item.blockingDiagnostic }] : []) : summary.targets;
            return { ...summary, items: items.slice(offset, offset + pageSize), total: items.length, nextOffset: offset + pageSize < items.length ? offset + pageSize : null };
        }
        const job = jobs[0];
        const target = targetReceipt(job);
        const targetSync = job.application?.referenceSync?.find((sync: any) => sync.targetId === job.segmentId);
        const base = { ...target, operationId,
            phases: { source: "saved", compilation: target.compiler?.status || job.status,
                application: targetSync?.status === "ready" ? "ready" : job.application ? "blocked" : "pending",
                translation: target.translation?.status || "not_started", mediaSubmitted: false },
            nextAction: { action: activeStatuses.includes(job.status) ? "wait" : job.status === "succeeded" ? "done" : "review_diagnostic", message: activeStatuses.includes(job.status) ? "沿原 operationId 查询" : "按目标诊断处理；不自动重新提交" } };
        if (view === "status") return base;
        if (!pageSize) throw new Error("查询编译列表必须指定 pageSize");
        const items = view === "diagnostics" ? job.diagnostics : [{ targetId: job.segmentId, status: job.status }];
        return { ...base, items: items.slice(offset, offset + pageSize), total: items.length, nextOffset: offset + pageSize < items.length ? offset + pageSize : null };
    }
    private async advance(id: string, job: ClipRefreshJob, store: ClipRefreshStore) {
        const key = job.compilationOperationId;
        if (this.active.has(key)) return;
        this.active.add(key);
        const step = (status: Status) => { job.status = status; store.save(job); };
        const measure = <T>(name: string, fn: () => T): T => { const start = performance.now(); try { return fn(); } finally { job.timings[name] = (job.timings[name] || 0) + performance.now() - start; store.save(job); } };
        try {
            let compilation: any;
            // Recover original application even if inputs have since changed.
            if (job.compileRevision !== undefined) compilation = this.compilations.getCompilation(id, this.owner, key);
            if (compilation?.application) {
                job.application = compilation.application;
                job.status = this.syncStatus(job); store.save(job);
                if (job.status === "succeeded") await this.queueCompiledPromptTranslation(id, job, store);
                return;
            }
            const current = this.service.get(id), stored = current.draft.director;
            if (!stored) { step("superseded"); return; }
            const d = this.service.resolveSubjectPictureInputs(id, stored, [job.segmentId], true, undefined, []);
            if (compilationScopeInput(d, clipRefreshScope(job.segmentId)).inputHash !== job.inputHash) { step("superseded"); return; }
            const occupied = this.service.targetOccupancy(id, [job.segmentId]);
            if (occupied.length) { job.diagnostics = occupied.map(o => ({ code: "TARGET_OCCUPIED", targetId: job.segmentId, message: o.nextAction.message, nextAction: o.nextAction })); step("blocked"); return; }
            if (!compilation) {
                step("checking");
                // Persist intent before enqueue; an enqueue crash can be recovered by its exact identity.
                job.compileRevision = current.revision; store.save(job);
                compilation = measure("enqueueMs", () => this.compilations.enqueue(id, this.owner, key, current.revision, undefined, clipRefreshScope(job.segmentId)));
            }
            if (["queued", "running"].includes(compilation.status)) { step("compiling"); return; }
            if (compilation.status !== "succeeded") {
                job.diagnostics = compilation.blockingDiagnostic ? [compilation.blockingDiagnostic] : [{ code: "COMPILATION_" + compilation.status.toUpperCase(), message: compilation.nextAction?.message }];
                step(compilation.status === "interrupted" ? "interrupted" : compilation.status === "blocked" ? "blocked" : "failed"); return;
            }
            const targets: any = this.compilations.getCompilation(id, this.owner, key, "targets", 0, 1);
            if (targets.items?.[0]?.status !== "ready" || targets.total !== 1) {
                const diagnostics = (targets.items || []).flatMap((item: any) => Array.isArray(item.diagnostics) ? item.diagnostics : []);
                job.diagnostics = diagnostics.length ? diagnostics.slice(0, 4) : [{ code: "CLIP_COMPILATION_NOT_READY", targetId: job.segmentId, message: "目标产物未就绪" }];
                step("blocked"); return;
            }
            job.preparedId = compilation.preparedId; step("applying");
            job.application = measure("applyMs", () => this.compilations.apply(id, this.owner, job.preparedId!));
            job.status = this.syncStatus(job);
            job.timings.totalMs = Date.now() - Date.parse(job.createdAt); store.save(job);
            if (job.status === "succeeded") await this.queueCompiledPromptTranslation(id, job, store);
        } catch (error) {
            const code = String((error as any)?.code || "CLIP_REFRESH_FAILED");
            job.diagnostics = (error as any)?.diagnostics || [{ code, targetId: job.segmentId, message: error instanceof Error ? error.message : String(error) }];
            step(code === "SUBJECT_PROMPT_COMPILER_UNSUPPORTED" || (error as any)?.diagnostics ? "blocked" : "failed");
        } finally { this.active.delete(key); }
    }
    private syncStatus(job: ClipRefreshJob): Status {
        const sync = job.application?.referenceSync?.find((r: any) => r.targetId === job.segmentId);
        if (!sync || sync.status !== "ready") {
            job.diagnostics = sync?.diagnostics?.length ? sync.diagnostics : [{ code: "CLIP_REFERENCE_SYNC_REQUIRED", targetId: job.segmentId, message: "编译已应用，画布目标尚未就绪" }];
            return "blocked";
        }
        return "succeeded";
    }
    private async queueCompiledPromptTranslation(id: string, job: ClipRefreshJob, store: ClipRefreshStore) {
        job.translationOperationId ||= `clip-refresh-translation:${crypto.createHash("sha256").update(job.operationId).digest("hex")}`;
        store.save(job);
        try {
            const production = this.service.get(id);
            job.translationExpectedRevision ??= production.revision;
            store.save(job);
            await this.service.translateCompiledPrompts(id, {
                expectedRevision: job.translationExpectedRevision,
                operationId: job.translationOperationId,
                targetIds: [job.segmentId],
            });
            delete job.translationError;
            store.save(job);
        } catch (error) {
            job.translationError = error instanceof Error ? error.message : String(error);
            store.save(job);
        }
    }
}
