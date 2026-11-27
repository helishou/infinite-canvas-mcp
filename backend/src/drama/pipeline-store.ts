/**
 * 全自动流水线持久化（对齐影策 drama_jobs / drama_productions 状态记录）。
 *
 * 独立 DatabaseSync 连接指向同一个 runtime.sqlite（WAL 模式允许多连接，本仓本来就是多连接
 * 架构）。这样无需把方法塞进 BackendDatabase 大类、也不用升 schema version——表由
 * DRAMA_PIPELINE_DDL 在 BackendDatabase 构造时补建。
 */
import { DatabaseSync } from "node:sqlite";
import { DB_FILE } from "../config.js";

export type PipelineStatus = "running" | "paused" | "completed";
export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "canceled";

export type PipelineRow = {
    drama_id: string;
    status: PipelineStatus;
    review_mode: string;
    media_mode: string;
    pause_reason: string | null;
    last_tick_at: string | null;
    revision: number;
    created_at: string;
    updated_at: string;
};

export type JobRow = {
    id: string;
    drama_id: string;
    episode_id: string | null;
    kind: string;
    stage: string;
    status: JobStatus;
    priority: number;
    attempt: number;
    dedupe_key: string;
    task_id: string | null;
    label: string;
    payload_json: string;
    attempts_json: string;
    error: string | null;
    started_at: string | null;
    finished_at: string | null;
    created_at: string;
    updated_at: string;
};

const parseJson = (value: unknown, fallback: unknown) => {
    try {
        const parsed = typeof value === "string" ? JSON.parse(value) : value;
        return parsed ?? fallback;
    } catch { return fallback; }
};

export class PipelineStore {
    private db: DatabaseSync;

    constructor(file: string = DB_FILE) {
        this.db = new DatabaseSync(file);
        this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    }

    close() { this.db.close(); }

    // ── pipelines ────────────────────────────────────────────────────────
    get(dramaId: string): PipelineRow | undefined {
        return this.db.prepare("SELECT * FROM drama_pipelines WHERE drama_id=?").get(dramaId) as PipelineRow | undefined;
    }

    /** 创建或更新流水线意图；已存在时只在显式传值处更新，revision CAS 递增。 */
    upsert(input: { dramaId: string; status?: PipelineStatus; reviewMode?: string; mediaMode?: string; pauseReason?: string | null }): PipelineRow {
        const now = new Date().toISOString();
        const existing = this.get(input.dramaId);
        if (!existing) {
            this.db.prepare("INSERT INTO drama_pipelines(drama_id,status,review_mode,media_mode,pause_reason,revision,created_at,updated_at) VALUES(?,?,?,?,?,0,?,?)")
                .run(input.dramaId, input.status ?? "running", input.reviewMode ?? "auto", input.mediaMode ?? "auto", input.pauseReason ?? null, now, now);
        } else {
            this.db.prepare("UPDATE drama_pipelines SET status=?, review_mode=?, media_mode=?, pause_reason=?, revision=revision+1, updated_at=? WHERE drama_id=?")
                .run(input.status ?? existing.status, input.reviewMode ?? existing.review_mode, input.mediaMode ?? existing.media_mode,
                    input.pauseReason !== undefined ? input.pauseReason : existing.pause_reason, now, input.dramaId);
        }
        return this.get(input.dramaId)!;
    }

    setStatus(dramaId: string, status: PipelineStatus, pauseReason?: string | null) {
        const now = new Date().toISOString();
        if (pauseReason === undefined) {
            this.db.prepare("UPDATE drama_pipelines SET status=?, revision=revision+1, updated_at=? WHERE drama_id=?").run(status, now, dramaId);
        } else {
            this.db.prepare("UPDATE drama_pipelines SET status=?, pause_reason=?, revision=revision+1, updated_at=? WHERE drama_id=?").run(status, pauseReason, now, dramaId);
        }
    }

    touch(dramaId: string) {
        this.db.prepare("UPDATE drama_pipelines SET last_tick_at=? WHERE drama_id=?").run(new Date().toISOString(), dramaId);
    }

    running(limit = 20): PipelineRow[] {
        return this.db.prepare("SELECT * FROM drama_pipelines WHERE status='running' ORDER BY last_tick_at ASC LIMIT ?").all(limit) as PipelineRow[];
    }

    all(): PipelineRow[] {
        return this.db.prepare("SELECT * FROM drama_pipelines ORDER BY updated_at DESC").all() as PipelineRow[];
    }

    // ── 闸门放行记录（持久化；重启后恢复） ──────────────────────────────
    /** kind='approve' → target=episodeId；kind='release' → target=媒体 target。幂等。 */
    addApproval(dramaId: string, kind: "approve" | "release", target: string): void {
        this.db.prepare("INSERT OR IGNORE INTO drama_pipeline_approvals(drama_id,kind,target,created_at) VALUES(?,?,?,?)")
            .run(dramaId, kind, target, new Date().toISOString());
    }

    /** 读回某剧目某类闸门的全部放行目标（持久化真值，供 status/重启恢复用）。 */
    approvalTargets(dramaId: string, kind: "approve" | "release"): string[] {
        const rows = this.db.prepare("SELECT target FROM drama_pipeline_approvals WHERE drama_id=? AND kind=? ORDER BY created_at ASC").all(dramaId, kind) as Array<{ target: string }>;
        return rows.map(row => row.target);
    }

    /** 供自恢复用：某剧目是否已持久化了某条放行。 */
    hasApproval(dramaId: string, kind: "approve" | "release", target: string): boolean {
        return Boolean(this.db.prepare("SELECT 1 FROM drama_pipeline_approvals WHERE drama_id=? AND kind=? AND target=?").get(dramaId, kind, target));
    }

    // ── jobs ─────────────────────────────────────────────────────────────
    /** 幂等入队：dedupe_key 已存在则跳过，返回是否新建。 */
    enqueue(input: {
        id: string; dramaId: string; episodeId?: string | null; kind: string; stage: string;
        priority?: number; dedupeKey: string; label?: string; payload?: Record<string, unknown>;
    }): boolean {
        const now = new Date().toISOString();
        if (this.db.prepare("SELECT 1 FROM drama_pipeline_jobs WHERE dedupe_key=?").get(input.dedupeKey)) return false;
        this.db.prepare("INSERT INTO drama_pipeline_jobs(id,drama_id,episode_id,kind,stage,status,priority,attempt,dedupe_key,label,payload_json,attempts_json,created_at,updated_at) VALUES(?,?,?,?,?,'queued',?,0,?,?,?,'[]',?,?)")
            .run(input.id, input.dramaId, input.episodeId ?? null, input.kind, input.stage, input.priority ?? 0, input.dedupeKey, input.label ?? "", JSON.stringify(input.payload ?? {}), now, now);
        return true;
    }

    /** 原子领取一条 queued job（集号 ASC、priority DESC、created_at ASC）。领取即清掉暂停留下的 error。 */
    claim(dramaId: string): JobRow | undefined {
        const row = this.db.prepare("SELECT * FROM drama_pipeline_jobs WHERE drama_id=? AND status='queued' ORDER BY COALESCE(json_extract(payload_json, '$.episodeNumber'), 999999) ASC, priority DESC, created_at ASC LIMIT 1").get(dramaId) as JobRow | undefined;
        if (!row) return undefined;
        const now = new Date().toISOString();
        const changed = this.db.prepare("UPDATE drama_pipeline_jobs SET status='running', attempt=attempt+1, started_at=?, error=NULL, updated_at=? WHERE id=? AND status='queued'").run(now, now, row.id);
        if (changed.changes !== 1) return undefined;
        return { ...row, status: "running", attempt: row.attempt + 1, error: null };
    }

    /** 原子领取指定 id 的 queued job（dispatch 选定具体 job 后用）。领取即清掉暂停留下的 error。 */
    claimById(id: string): JobRow | undefined {
        const row = this.db.prepare("SELECT * FROM drama_pipeline_jobs WHERE id=? AND status='queued'").get(id) as JobRow | undefined;
        if (!row) return undefined;
        const now = new Date().toISOString();
        const changed = this.db.prepare("UPDATE drama_pipeline_jobs SET status='running', attempt=attempt+1, started_at=?, error=NULL, updated_at=? WHERE id=? AND status='queued'").run(now, now, id);
        if (changed.changes !== 1) return undefined;
        return { ...row, status: "running", attempt: row.attempt + 1, error: null };
    }

    /** 记录作业当前任务号；已暂停（status 不再是 running）时不复活作业状态。 */
    markRunning(id: string, taskId: string | null) {
        this.db.prepare("UPDATE drama_pipeline_jobs SET status='running', task_id=?, updated_at=? WHERE id=? AND status='running'").run(taskId, new Date().toISOString(), id);
    }

    /**
     * 追加一条逐次尝试记录 {at, attempt?, error?, result?}：读改写，保留最近 20 条。
     * 成功与失败共用同一格式，前端队列详情按它逐条列出每次尝试的原因与时间。
     */
    private appendAttempt(id: string, entry: Record<string, unknown>) {
        const row = this.db.prepare("SELECT attempts_json FROM drama_pipeline_jobs WHERE id=?").get(id) as { attempts_json?: string } | undefined;
        const parsed = parseJson(row?.attempts_json, []);
        const attempts = Array.isArray(parsed) ? parsed : [];
        attempts.push(entry);
        this.db.prepare("UPDATE drama_pipeline_jobs SET attempts_json=? WHERE id=?").run(JSON.stringify(attempts.slice(-20)), id);
    }

    succeed(id: string, result: Record<string, unknown>) {
        const now = new Date().toISOString();
        this.db.prepare("UPDATE drama_pipeline_jobs SET status='succeeded', finished_at=?, updated_at=? WHERE id=?").run(now, now, id);
        const row = this.db.prepare("SELECT attempt FROM drama_pipeline_jobs WHERE id=?").get(id) as { attempt?: number } | undefined;
        this.appendAttempt(id, { at: now, attempt: Number(row?.attempt || 0), result });
    }

    /** 失败：终态错误照旧写 error；同时把本次失败（含第几次）追加进 attempts_json，供事后排查。 */
    fail(id: string, error: string) {
        const now = new Date().toISOString();
        const message = String(error).slice(0, 2000);
        this.db.prepare("UPDATE drama_pipeline_jobs SET status='failed', error=?, finished_at=?, updated_at=? WHERE id=?").run(message, now, now, id);
        const row = this.db.prepare("SELECT attempt FROM drama_pipeline_jobs WHERE id=?").get(id) as { attempt?: number } | undefined;
        this.appendAttempt(id, { at: now, attempt: Number(row?.attempt || 0), error: message });
    }

    /** 熔断终态：failed 且 attempt 顶到硬上限，使 retryFailed/launchJob 都不再重排（等人工介入）。 */
    failCircuit(id: string, error: string, attempt: number) {
        const now = new Date().toISOString();
        const message = String(error).slice(0, 2000);
        this.db.prepare("UPDATE drama_pipeline_jobs SET status='failed', error=?, attempt=?, finished_at=?, updated_at=? WHERE id=?")
            .run(message, attempt, now, now, id);
        this.appendAttempt(id, { at: now, attempt, error: message });
    }

    /**
     * 退回 queued。created_at 是队列 FIFO 的排序键（listJobs/claim 按 priority DESC、created_at ASC），
     * 重新入队必须取新时间戳，否则重试作业仍占旧槽位，插到后来真正先提交的同阶段作业前面。
     */
    requeue(id: string) {
        const now = new Date().toISOString();
        this.db.prepare("UPDATE drama_pipeline_jobs SET status='queued', error=NULL, created_at=?, updated_at=? WHERE id=?").run(now, now, id);
    }

    /** 手动/分级重试：退回 queued 且重置 attempt，让重跑从干净计数开始（避免历史 attempt 累加触发硬上限死循环）。 */
    requeueForRetry(id: string) {
        const now = new Date().toISOString();
        this.db.prepare("UPDATE drama_pipeline_jobs SET status='queued', error=NULL, attempt=0, task_id=NULL, started_at=NULL, finished_at=NULL, created_at=?, updated_at=? WHERE id=?")
            .run(now, now, id);
    }

    /**
     * 用户暂停：把本剧目所有 running 作业退回 queued（保留 dedupe/阶段依赖与恢复点），
     * attempt 回退一格（取消不是作业失败，不该消耗重试次数），task_id 清空避免恢复时误用旧任务号，
     * error 记暂停原因供前端/status 辨认。返回被退回的作业数。
     */
    pauseRunning(dramaId: string, reason = "paused_by_user"): number {
        const now = new Date().toISOString();
        const changed = this.db.prepare(
            "UPDATE drama_pipeline_jobs SET status='queued', error=?, attempt=MAX(0,attempt-1), task_id=NULL, started_at=NULL, created_at=?, updated_at=? WHERE drama_id=? AND status='running'",
        ).run(reason, now, now, dramaId);
        return Number(changed.changes || 0);
    }

    /**
     * 单条在跑作业退回可恢复排队：暂停时执行 Promise 迟到的结果不得把作业写成 succeeded/failed。
     * 只对仍处于 running 的行生效，已被 pauseRunning 退回的作业保持原样（幂等）。
     */
    markPaused(id: string, reason = "paused_by_user"): boolean {
        const now = new Date().toISOString();
        const changed = this.db.prepare(
            "UPDATE drama_pipeline_jobs SET status='queued', error=?, attempt=MAX(0,attempt-1), task_id=NULL, started_at=NULL, created_at=?, updated_at=? WHERE id=? AND status='running'",
        ).run(reason, now, now, id);
        return Number(changed.changes || 0) === 1;
    }

    /**
     * 进程重启后，内存中的执行 Promise 随之消失，但数据库里的 job 仍是 running，
     * 后续阶段因前置依赖未 succeeded 永远无法入队（队列整体卡死）。
     * 这里把 started_at 超过 TTL 的 running 作业退回 queued，让调度器重新执行。
     * TTL 取 30 分钟，大于正常单作业耗时，避免误伤真正在跑的长任务。
     */
    recoverStaleRunning(dramaId: string, ttlMs: number): number {
        const cutoff = new Date(Date.now() - ttlMs).toISOString();
        const rows = this.db.prepare("SELECT id FROM drama_pipeline_jobs WHERE drama_id=? AND status='running' AND (started_at IS NULL OR started_at < ?)").all(dramaId, cutoff) as Array<{ id: string }>;
        const now = new Date().toISOString();
        const update = this.db.prepare("UPDATE drama_pipeline_jobs SET status='queued', error=NULL, task_id=NULL, started_at=NULL, created_at=?, updated_at=? WHERE id=?");
        for (const row of rows) update.run(now, now, row.id);
        return rows.length;
    }

    cancelQueued(dramaId: string) {
        this.db.prepare("UPDATE drama_pipeline_jobs SET status='canceled', finished_at=?, updated_at=? WHERE drama_id=? AND status IN ('queued','running')").run(new Date().toISOString(), new Date().toISOString(), dramaId);
    }

    /**
     * 按章改编重拆镜：把本集全部阶段作业（script/assets/prompts/video/render）原子重置为 queued，
     * 对齐影策 CancelQueuedDramaJobs + requestDramaWork。dedupe_key 不变，重排不会堆重复作业；
     * 清掉 task_id/attempt/error/退避起点，让重跑从干净态开始。可选 scriptPatch 透传本次改编指令
     * （前端按章编辑后计算的 instruction/model 写进 script job payload，runScript 真消费）。
     * 返回被重置的作业数；没有作业时返回 0（调用方再走 plan 幂等补齐）。
     */
    resetJobsForEpisode(dramaId: string, episodeId: string, scriptPatch?: Record<string, unknown>): number {
        const rows = this.listJobs(dramaId).filter(job => job.episode_id === episodeId);
        const now = new Date().toISOString();
        const update = this.db.prepare("UPDATE drama_pipeline_jobs SET status='queued', error=NULL, attempt=0, task_id=NULL, started_at=NULL, finished_at=NULL, payload_json=?, created_at=?, updated_at=? WHERE id=?");
        for (const job of rows) {
            const base = this.jobPayload(job);
            const payload = scriptPatch && job.stage === "script" ? { ...base, ...scriptPatch } : base;
            update.run(JSON.stringify(payload), now, now, job.id);
        }
        return rows.length;
    }

    /**
     * 重写提示词后的下游重排：只把本集指定阶段的作业重置为 queued，不动其它阶段。
     * 对齐影策 invalidateDramaSegment：提示词改了，用旧提示词生成的 video/render 必须作废重跑，
     * 但 script/assets 已完成的不该被牵连。dedupe_key 保留，重排不堆重复作业。
     */
    resetJobsForEpisodeStages(dramaId: string, episodeId: string, stages: string[], scriptPatch?: Record<string, unknown>): number {
        const wanted = new Set(stages);
        const rows = this.listJobs(dramaId).filter(job => job.episode_id === episodeId && wanted.has(job.stage));
        const now = new Date().toISOString();
        const update = this.db.prepare("UPDATE drama_pipeline_jobs SET status='queued', error=NULL, attempt=0, task_id=NULL, started_at=NULL, finished_at=NULL, payload_json=?, created_at=?, updated_at=? WHERE id=?");
        for (const job of rows) {
            const base = this.jobPayload(job);
            const payload = scriptPatch && job.stage === "script" ? { ...base, ...scriptPatch } : base;
            update.run(JSON.stringify(payload), now, now, job.id);
        }
        return rows.length;
    }

    /**
     * 按集号优先、集内按阶段（priority DESC）排序：兑现设置页「排队顺序先按集号」的口径。
     * 影策是每集独立阶段机，不是全剧先 script 再全剧 assets；集号从 payload 真值取，
     * 没有集号的手工/旧作业排在有集号的作业之后，避免凭空抢到队首。
     */
    listJobs(dramaId: string, statuses?: JobStatus[]): JobRow[] {
        const order = "ORDER BY COALESCE(json_extract(payload_json, '$.episodeNumber'), 999999) ASC, priority DESC, created_at ASC";
        if (statuses?.length) {
            const ph = statuses.map(() => "?").join(",");
            return this.db.prepare(`SELECT * FROM drama_pipeline_jobs WHERE drama_id=? AND status IN (${ph}) ${order}`).all(dramaId, ...statuses) as JobRow[];
        }
        return this.db.prepare(`SELECT * FROM drama_pipeline_jobs WHERE drama_id=? ${order}`).all(dramaId) as JobRow[];
    }

    job(id: string): JobRow | undefined {
        return this.db.prepare("SELECT * FROM drama_pipeline_jobs WHERE id=?").get(id) as JobRow | undefined;
    }

    jobPayload(job: JobRow): Record<string, unknown> {
        return parseJson(job.payload_json, {}) as Record<string, unknown>;
    }

    /** C6：依赖未就绪时把作业退回 queued 且回退 attempt（不消耗重试次数），等上游就绪后下一轮重排。 */
    deferDependency(id: string): void {
        const now = new Date().toISOString();
        this.db.prepare("UPDATE drama_pipeline_jobs SET status='queued', attempt=MAX(0,attempt-1), error=NULL, created_at=?, updated_at=? WHERE id=?")
            .run(now, now, id);
    }

    /** 幂等写 job 的恢复点（如 render 已合成成片的 storageKey）；重放时复用，避免二次提交 provider task。 */
    setJobRecovery(id: string, patch: Record<string, unknown>): void {
        const job = this.job(id);
        if (!job) return;
        const payload = { ...this.jobPayload(job), ...patch };
        this.db.prepare("UPDATE drama_pipeline_jobs SET payload_json=?, updated_at=? WHERE id=?")
            .run(JSON.stringify(payload), new Date().toISOString(), id);
    }

    // ── events（日志） ────────────────────────────────────────────────────
    log(dramaId: string, message: string, level = "info", episodeId?: string | null, jobId?: string | null) {
        this.db.prepare("INSERT INTO drama_pipeline_events(drama_id,job_id,episode_id,level,message,created_at) VALUES(?,?,?,?,?,?)")
            .run(dramaId, jobId ?? null, episodeId ?? null, level, String(message).slice(0, 1000), new Date().toISOString());
    }

    logs(dramaId: string, limit = 100): Array<Record<string, unknown>> {
        return this.db.prepare("SELECT * FROM drama_pipeline_events WHERE drama_id=? ORDER BY id DESC LIMIT ?").all(dramaId, limit) as Array<Record<string, unknown>>;
    }

    /** 阶段游标：存 director.workflow.pipelineStages，但队列状态用本表 job.stage 聚合即可。 */
    stageCounts(dramaId: string): Record<string, number> {
        const rows = this.db.prepare("SELECT stage, COUNT(*) AS n FROM drama_pipeline_jobs WHERE drama_id=? GROUP BY stage").all(dramaId) as Array<{ stage: string; n: number }>;
        return Object.fromEntries(rows.map(r => [r.stage, r.n]));
    }
}
