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
    /** 重排计数与下次尝试时间：异步校验期间被其它编辑打断时按退避重排，而不是直接 failed。 */
    attempts?: number; nextAttemptAt?: string; retryReason?: string;
    /** 实际投给编译器的 operationId；首次等于 compilationOperationId，重排后追加 :rN 以避开同 id 幂等重放。 */
    compileOperationId?: string;
    translationOperationId?: string; translationExpectedRevision?: number; translationError?: string;
};
const activeStatuses = ["queued", "checking", "compiling", "applying"];
/** 多会话同时编辑同一份制作稿时，异步校验窗口内被改写属于常态；这类失败重排就能过，不该落成终态。 */
const MAX_REFRESH_ATTEMPTS = 3;const REFRESH_BACKOFF_MS = [400, 1200, 2500];
const RETRYABLE_REFRESH_CODES = new Set(["SOURCE_CHANGED_DURING_VALIDATION", "PRODUCTION_CONFLICT", "COMPILATION_INPUT_CHANGED", "REVISION_CONFLICT"]);
/** 判断一次刷新失败是否只是「别人在我校验期间改了稿」，属于可重排的瞬时冲突。 */
export function retryableRefreshFailure(error: unknown) {
    const code = String((error as any)?.code || "");
    const message = error instanceof Error ? error.message : String(error ?? "");
    if (RETRYABLE_REFRESH_CODES.has(code)) return true;
    if (/^\s*(SOURCE_CHANGED_DURING_VALIDATION|PRODUCTION_CONFLICT|REVISION_CONFLICT)/i.test(message)) return true;
    if (error instanceof Error && "current" in error && error.message.includes("制作稿版本已变化")) return true;
    return /SOURCE_CHANGED_DURING_VALIDATION/i.test(message);
}
/** Terminal jobs never resume, so their embedded DirectorProduction snapshot is dead weight (multi-MB rows made currentBySegment scan seconds). */
const prunedOwners = new Set<string>();
export const clipRefreshScope = (segmentId: string) => ({ targetIds: [segmentId], output: "selected" as const });
/**
 * 同一次编辑的多片段合并编译，默认关闭（PRODUCTION_BATCH_CLIP_COMPILE=1 才启用）。
 * 实测该路径会让部分片段读到的批量回执不含自己的目标，落成
 * CLIP_REFRESH_FAILED「编译回执不存在或不属于当前制作对象」；修复前不要默认开启。
 */
const batchClipCompile = process.env.PRODUCTION_BATCH_CLIP_COMPILE === "1";

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
        timings: job.timings,
        ...(job.attempts ? { attempts: job.attempts, retryReason: job.retryReason, nextAttemptAt: job.nextAttemptAt } : {}), ...(job.translationOperationId ? { translationOperationId: job.translationOperationId } : {}),
        ...(job.translationError ? { translationError: job.translationError } : {}),
        ...(job.application ? { application: { revision: job.application.revision, sourceHash: job.application.sourceHash,
            referenceSync: (job.application.referenceSync || []).map((item: any) => ({ targetId: item.targetId, status: item.status,
                referenceCount: item.referenceCount, ...(item.diagnostics?.length ? { diagnostics: item.diagnostics } : {}) })) } } : {}), mediaSubmitted: false };
}

/** Durable orchestration only: compiler packets and canvas ops remain authoritative. */
export class ClipRefreshCoordinator {
    private active = new Set<string>();
    private wakeTimers = new Map<string, ReturnType<typeof setTimeout>>();
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
            if (job.compileRevision !== undefined) this.compilations.cancel(id, this.owner, job.compileOperationId || job.compilationOperationId);
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
            // 退避等待期内不推进，到点再自己唤醒；否则每次 compilation 结束都会白跑一轮。
            const due = job.nextAttemptAt ? Date.parse(job.nextAttemptAt) : 0;
            if (due > Date.now()) { this.scheduleWake(id, job, due - Date.now()); continue; }
            void this.advance(id, job, store);
        }
    }
    /**
     * 一次编辑改了多个片段时，把这些片段合并成一次编译。
     * 实测编译开销对目标数是次线性的（1 个片段 2.3s、18 个片段 5.9s），
     * 逐个片段编译会把同一份固定开销重复 N 次。
     * 只改投编译的 scope，片段自身的 inputHash 预检仍按单片段判定，不参与合并结论。
     */
    private batchScope(job: ClipRefreshJob, store: ClipRefreshStore) {
        if (!batchClipCompile) return undefined;
        // 重排过的任务已换过编译 id，合并会命中旧的终态回执，直接走单片段路径。
        if (job.attempts || job.compileOperationId) return undefined;
        const siblings = store.byEditAll(job.parentOperationId)
            .filter(item => item.savedRevision === job.savedRevision)
            .map(item => item.segmentId).sort();
        if (siblings.length < 2) return undefined;
        const operationId = `clip-refresh-batch:${crypto.createHash("sha256")
            .update(`${this.owner}\0${job.parentOperationId}\0${job.savedRevision}`).digest("hex").slice(0, 32)}`;
        return { operationId, scope: { targetIds: siblings, output: "selected" as const } };
    }
    private scheduleWake(id: string, job: ClipRefreshJob, delayMs: number) {
        const key = `${id}:${job.operationId}`;
        if (this.wakeTimers.has(key)) return;
        const timer = setTimeout(() => {
            this.wakeTimers.delete(key);
            let store: ClipRefreshStore;
            try { store = this.service.clipRefreshStore(id); } catch { return; }
            const current = store.get(job.operationId);
            if (!current || !activeStatuses.includes(current.status)) return;
            void this.advance(id, current, store);
        }, Math.max(0, delayMs));
        timer.unref?.();
        this.wakeTimers.set(key, timer);
    }
    /**
     * 异步校验期间被别的编辑改写时，原 operationId 的编译已落在 blocked/failed 终态，
     * 同 id 重放拿不到新结果——所以换一个 `:rN` 的编译 id 重新排队，刷新任务本身的
     * operationId 保持不变，客户端仍按原 id 查询进度。
     */
    private retryLater(id: string, job: ClipRefreshJob, store: ClipRefreshStore, reason: string): boolean {
        const attempts = (job.attempts || 0) + 1;
        if (attempts > MAX_REFRESH_ATTEMPTS) return false;
        job.attempts = attempts;
        job.retryReason = reason;
        job.nextAttemptAt = new Date(Date.now() + REFRESH_BACKOFF_MS[Math.min(attempts, REFRESH_BACKOFF_MS.length) - 1]).toISOString();
        job.compileOperationId = `${job.compilationOperationId}:r${attempts}`;
        job.compileRevision = undefined;
        job.preparedId = undefined;
        job.application = undefined;
        job.diagnostics = [{ code: "CLIP_REFRESH_RETRY_SCHEDULED", targetId: job.segmentId, severity: "warning",
            message: `刷新在异步校验期间与其它编辑冲突（${reason}），已按退避重排第 ${attempts}/${MAX_REFRESH_ATTEMPTS} 次；同一 operationId 继续查询即可` }];
        job.status = "queued";
        store.save(job);
        this.scheduleWake(id, job, Date.parse(job.nextAttemptAt) - Date.now());
        return true;
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
                    const compileKey = job.compileOperationId || job.compilationOperationId;
                    const status = this.compilations.getCompilation(id, this.owner, compileKey);
                    const targets: any = this.compilations.getCompilation(id, this.owner, compileKey, "targets", 0, 1);
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
        // 走到这里说明退避等待已到期（或首次执行），下一次冲突要重新计时。
        job.nextAttemptAt = undefined;
        const compileKey = job.compileOperationId || key;
        // 同一次编辑产生的多个片段刷新共用一次编译；operationId 只由 (owner, 父操作, 保存版本) 决定，
        // 重启后与其它片段算出的值一致，能命中同一份编译回执。
        const batch = this.batchScope(job, store);
        const activeCompileKey = batch ? batch.operationId : compileKey;
        const step = (status: Status) => { job.status = status; store.save(job); };
        const measure = <T>(name: string, fn: () => T): T => { const start = performance.now(); try { return fn(); } finally { job.timings[name] = (job.timings[name] || 0) + performance.now() - start; store.save(job); } };
        const measureAsync = async <T>(name: string, fn: () => Promise<T>): Promise<T> => { const start = performance.now(); try { return await fn(); } finally { job.timings[name] = (job.timings[name] || 0) + performance.now() - start; store.save(job); } };
        try {
            let compilation: any;
            // Recover original application even if inputs have since changed.
            if (job.compileRevision !== undefined) compilation = this.compilations.getCompilation(id, this.owner, activeCompileKey);
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
                // 合并编译必须用同一个「保存版本」作基线：兄弟片段中先回写的那一个会把
                // 当前 revision 推高，若各自拿 current.revision 入队，指纹不同会被判成
                // 幂等冲突，合并就退化成各自单编。
                const enqueueRevision = batch ? job.savedRevision : current.revision;
                job.compileRevision = enqueueRevision; store.save(job);
                // 单目标编译有约 2 秒的固定开销（实测 1 个片段 2.3s、18 个片段 5.9s），
                // 同一次编辑产生的多个片段刷新合并成一次编译能省掉 N-1 份固定开销。
                // 合并只改投编译的 scope，inputHash 预检仍按单片段比对，避免误判 superseded。
                const batched = batch;
                const target = batched ? batched.scope : clipRefreshScope(job.segmentId);
                const enqueueKey = batched ? batched.operationId : compileKey;
                try {
                    compilation = measure("enqueueMs", () => this.compilations.enqueue(id, this.owner, enqueueKey, enqueueRevision, undefined, target));
                } catch (error) {
                    if (!batched) throw error;
                    compilation = measure("enqueueMs", () => this.compilations.enqueue(id, this.owner, compileKey, current.revision, undefined, clipRefreshScope(job.segmentId)));
                }
            }
            if (["queued", "running"].includes(compilation.status)) { step("compiling"); return; }
            if (compilation.status !== "succeeded") {
                const blocking = compilation.blockingDiagnostic as Record<string, any> | undefined;
                job.diagnostics = blocking ? [blocking] : [{ code: "COMPILATION_" + compilation.status.toUpperCase(), message: compilation.nextAction?.message }];
                // 编译期间输入被改写 → 换新 revision 重排即可通过，属于瞬时冲突。
                if (blocking?.code === "COMPILATION_INPUT_CHANGED" && this.retryLater(id, job, store, "编译期间输入被改写")) return;
                step(compilation.status === "interrupted" ? "interrupted" : compilation.status === "blocked" ? "blocked" : "failed"); return;
            }
            const targets: any = this.compilations.getCompilation(id, this.owner, compileKey, "targets", 0, 1);
            if (targets.items?.[0]?.status !== "ready" || targets.total !== 1) {
                const diagnostics = (targets.items || []).flatMap((item: any) => Array.isArray(item.diagnostics) ? item.diagnostics : []);
                job.diagnostics = diagnostics.length ? diagnostics.slice(0, 4) : [{ code: "CLIP_COMPILATION_NOT_READY", targetId: job.segmentId, message: "目标产物未就绪" }];
                step("blocked"); return;
            }
            job.preparedId = compilation.preparedId; step("applying");
            job.application = await measureAsync("applyMs", () => this.compilations.apply(id, this.owner, job.preparedId!));
            job.status = this.syncStatus(job);
            job.timings.totalMs = Date.now() - Date.parse(job.createdAt); store.save(job);
            if (job.status === "succeeded") await this.queueCompiledPromptTranslation(id, job, store);
        } catch (error) {
            const code = String((error as any)?.code || "CLIP_REFRESH_FAILED");
            job.diagnostics = (error as any)?.diagnostics || [{ code, targetId: job.segmentId, message: error instanceof Error ? error.message : String(error) }];
            const blockedByValidation = code === "SUBJECT_PROMPT_COMPILER_UNSUPPORTED" || Boolean((error as any)?.diagnostics);
            // 只有「别的编辑在异步校验窗口里改了稿」才重排；真正的校验错误必须留给用户处理。
            if (!blockedByValidation && retryableRefreshFailure(error) && this.retryLater(id, job, store, String((error as Error)?.message || code).slice(0, 120))) return;
            step(blockedByValidation ? "blocked" : "failed");
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
