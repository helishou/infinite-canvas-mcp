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

    /** 原子领取一条 queued job（priority DESC、created_at ASC）。 */
    claim(dramaId: string): JobRow | undefined {
        const row = this.db.prepare("SELECT * FROM drama_pipeline_jobs WHERE drama_id=? AND status='queued' ORDER BY priority DESC, created_at ASC LIMIT 1").get(dramaId) as JobRow | undefined;
        if (!row) return undefined;
        const now = new Date().toISOString();
        const changed = this.db.prepare("UPDATE drama_pipeline_jobs SET status='running', attempt=attempt+1, started_at=?, updated_at=? WHERE id=? AND status='queued'").run(now, now, row.id);
        if (changed.changes !== 1) return undefined;
        return { ...row, status: "running", attempt: row.attempt + 1 };
    }

    /** 原子领取指定 id 的 queued job（dispatch 选定具体 job 后用）。 */
    claimById(id: string): JobRow | undefined {
        const row = this.db.prepare("SELECT * FROM drama_pipeline_jobs WHERE id=? AND status='queued'").get(id) as JobRow | undefined;
        if (!row) return undefined;
        const now = new Date().toISOString();
        const changed = this.db.prepare("UPDATE drama_pipeline_jobs SET status='running', attempt=attempt+1, started_at=?, updated_at=? WHERE id=? AND status='queued'").run(now, now, id);
        if (changed.changes !== 1) return undefined;
        return { ...row, status: "running", attempt: row.attempt + 1 };
    }

    markRunning(id: string, taskId: string | null) {
        this.db.prepare("UPDATE drama_pipeline_jobs SET status='running', task_id=?, updated_at=? WHERE id=?").run(taskId, new Date().toISOString(), id);
    }

    succeed(id: string, result: Record<string, unknown>) {
        const now = new Date().toISOString();
        this.db.prepare("UPDATE drama_pipeline_jobs SET status='succeeded', finished_at=?, updated_at=? WHERE id=?").run(now, now, id);
        const row = this.db.prepare("SELECT attempts_json FROM drama_pipeline_jobs WHERE id=?").get(id) as { attempts_json?: string } | undefined;
        const attempts = parseJson(row?.attempts_json, []) as unknown[];
        attempts.push({ at: now, result });
        this.db.prepare("UPDATE drama_pipeline_jobs SET attempts_json=? WHERE id=?").run(JSON.stringify(attempts.slice(-20)), id);
    }

    fail(id: string, error: string) {
        const now = new Date().toISOString();
        this.db.prepare("UPDATE drama_pipeline_jobs SET status='failed', error=?, finished_at=?, updated_at=? WHERE id=?").run(String(error).slice(0, 2000), now, now, id);
    }

    requeue(id: string) {
        this.db.prepare("UPDATE drama_pipeline_jobs SET status='queued', error=NULL, updated_at=? WHERE id=?").run(new Date().toISOString(), id);
    }

    cancelQueued(dramaId: string) {
        this.db.prepare("UPDATE drama_pipeline_jobs SET status='canceled', finished_at=?, updated_at=? WHERE drama_id=? AND status IN ('queued','running')").run(new Date().toISOString(), new Date().toISOString(), dramaId);
    }

    listJobs(dramaId: string, statuses?: JobStatus[]): JobRow[] {
        if (statuses?.length) {
            const ph = statuses.map(() => "?").join(",");
            return this.db.prepare(`SELECT * FROM drama_pipeline_jobs WHERE drama_id=? AND status IN (${ph}) ORDER BY priority DESC, created_at ASC`).all(dramaId, ...statuses) as JobRow[];
        }
        return this.db.prepare("SELECT * FROM drama_pipeline_jobs WHERE drama_id=? ORDER BY priority DESC, created_at ASC").all(dramaId) as JobRow[];
    }

    job(id: string): JobRow | undefined {
        return this.db.prepare("SELECT * FROM drama_pipeline_jobs WHERE id=?").get(id) as JobRow | undefined;
    }

    jobPayload(job: JobRow): Record<string, unknown> {
        return parseJson(job.payload_json, {}) as Record<string, unknown>;
    }

    /** C6：依赖未就绪时把作业退回 queued 且回退 attempt（不消耗重试次数），等上游就绪后下一轮重排。 */
    deferDependency(id: string): void {
        this.db.prepare("UPDATE drama_pipeline_jobs SET status='queued', attempt=MAX(0,attempt-1), error=NULL, updated_at=? WHERE id=?")
            .run(new Date().toISOString(), id);
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
