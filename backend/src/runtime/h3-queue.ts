import type { RuntimeTask } from "../db.js";
import type { SettingStore, TaskStore } from "../stores/types.js";

export type H3Provider = "local" | "runninghub";
export type H3ExecutionMode = "auto" | H3Provider;
type Job = { provider: H3Provider; work: () => Promise<void> };

export function h3ExecutionMode(value: unknown): H3ExecutionMode {
    if (value === undefined || value === null || value === "" || value === "comfyui") return "local";
    if (value === "auto" || value === "local" || value === "runninghub") return value;
    throw new Error(`不支持的 H3 运行方式：${String(value)}`);
}

/** Backend 内所有 H3 入口共享槽位；任务事件保存排队/派发边界，重启不重复提交。 */
export class H3ExecutionQueue {
    private readonly pending = new Map<string, Job>();
    private readonly active = new Map<string, H3Provider>();
    private readonly reserved = new Map<string, H3Provider>();
    constructor(private readonly tasks: TaskStore, private readonly settings: SettingStore, private paused = false) {}

    status() {
        const config = this.settings.get("runninghub.config") as { concurrency?: unknown } | undefined;
        const value = Number(config?.concurrency ?? 1);
        const limit = Number.isSafeInteger(value) && value > 0 ? value : 1;
        const stats = (provider: H3Provider, capacity: number) => ({ capacity, active: [...this.active.values()].filter((item) => item === provider).length, queued: [...this.pending.values()].filter((item) => item.provider === provider).length + [...this.reserved.values()].filter((item) => item === provider).length });
        return { local: stats("local", 1), runninghub: stats("runninghub", limit) };
    }

    select(mode: H3ExecutionMode, remoteReady: boolean, localOnlyReason = "", reservationId?: string, localReady = true): H3Provider {
        const provider = this.choose(mode, remoteReady, localOnlyReason, localReady);
        if (reservationId) this.reserved.set(reservationId, provider);
        return provider;
    }

    unreserve(id: string) { this.reserved.delete(id); }

    private choose(mode: H3ExecutionMode, remoteReady: boolean, localOnlyReason: string, localReady: boolean): H3Provider {
        if (mode === "runninghub") {
            if (localOnlyReason) throw new Error(`${localOnlyReason}，请选择本地或自动分流`);
            if (!remoteReady) throw new Error("RunningHub 未配置 API Key、工作流 ID 或输入映射");
            return "runninghub";
        }
        if (mode === "local" || localOnlyReason || !remoteReady) return "local";
        const { local, runninghub } = this.status();
        if (!localReady) return "runninghub";
        if (local.active + local.queued < local.capacity) return "local";
        if (runninghub.active + runninghub.queued < runninghub.capacity) return "runninghub";
        // 满额时按已承诺的工作量选队列，选定后保持任务身份与执行器一致。
        return (local.active + local.queued) / local.capacity <= (runninghub.active + runninghub.queued) / runninghub.capacity ? "local" : "runninghub";
    }

    enqueue(task: RuntimeTask, provider: H3Provider, work: () => Promise<void>, detail: Record<string, unknown> = {}) {
        this.reserved.delete(task.id);
        if (this.pending.has(task.id) || this.active.has(task.id)) return;
        if (!this.tasks.events(task.id).some((event) => event.type === "h3_queued")) this.tasks.addEvent(task.id, "h3_queued", { provider, ...detail });
        this.pending.set(task.id, { provider, work });
        this.drain();
    }

    /** 远端已提交任务直接恢复观察，并占住槽位；不等待容量、也不重新提交。 */
    recover(task: RuntimeTask, provider: H3Provider, work: () => Promise<void>) {
        if (this.active.has(task.id)) return;
        this.pending.delete(task.id);
        this.launch(task.id, { provider, work }, false);
    }

    cancel(id: string) { this.pending.delete(id); this.reserved.delete(id); this.drain(); }
    activate() { this.paused = false; this.drain(); }
    refresh() { this.drain(); }

    private drain() {
        if (this.paused) return;
        for (const [id, job] of this.pending) {
            const task = this.tasks.get(id);
            if (!task || task.status !== "queued") { this.pending.delete(id); continue; }
            const stats = this.status()[job.provider];
            if (stats.active >= stats.capacity) continue;
            this.pending.delete(id);
            this.launch(id, job, true);
        }
    }

    private launch(id: string, job: Job, dispatched: boolean) {
        this.active.set(id, job.provider);
        if (dispatched) this.tasks.addEvent(id, "h3_dispatching", { provider: job.provider });
        void Promise.resolve().then(job.work).finally(() => { this.active.delete(id); this.drain(); }).catch(() => {});
    }
}

export function h3CanResumeQueued(tasks: TaskStore, id: string) {
    const events = tasks.events(id);
    return events.some((event) => event.type === "h3_queued") && !events.some((event) => event.type === "h3_dispatching" || event.type === "submitted");
}

export function h3LocalOnlyReason(params: Record<string, unknown>) {
    if (params.motionContextEnabled === true || params.continuationTask) return "Motion Context 潜变量连续生成需要本地 ComfyUI";
    if (params.latentConfirmationPhase || params.confirmSecondPass || params.latentUpscaleEnabled === true && params.latentUpscaleConfirmationMode === true || params.faceRefineEnabled === true && params.confirmationMode === true) return "分阶段确认需要本地 ComfyUI";
    return "";
}
