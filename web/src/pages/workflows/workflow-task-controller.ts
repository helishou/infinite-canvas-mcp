import type { BackendRuntimeTask } from "@/services/backend-api";
import type { WorkflowRunResult } from "@/services/api/workflows";

export type TaskReceipt = { task?: BackendRuntimeTask; taskId?: string; events?: unknown[] };
export type WorkflowRunState = {
    taskId: string;
    running: boolean;
    submitting: boolean;
    cancelling: boolean;
    unknown: boolean;
    retryable?: boolean;
    cancellationAcknowledged?: boolean;
    remoteTaskId?: string;
    error?: string;
    cancellation?: "pending" | "confirmed" | "unconfirmed" | "local";
    result: WorkflowRunResult | null;
};
export class WorkflowSubmissionRejected extends Error {}

const terminal = (status: string) => ["succeeded", "failed", "cancelled"].includes(status);

export function workflowTaskResult(task: BackendRuntimeTask): WorkflowRunResult {
    return {
        taskId: task.id,
        media: (task.result?.media || task.result?.images || []) as WorkflowRunResult["media"],
        texts: task.result?.texts,
        status: { status_str: task.status === "succeeded" ? "success" : task.status, completed: terminal(task.status) },
        ...(task.error ? { error: task.error } : {}),
    };
}

/** UI receipts only. Backend task IDs remain authoritative across navigation and retries. */
export class WorkflowTaskController {
    private states = new Map<string, WorkflowRunState>();
    private listeners = new Set<() => void>();
    private submissions = new Map<string, () => Promise<TaskReceipt>>();
    private reading = new Set<string>();
    subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
    get = (owner: string) => this.states.get(owner);
    private update(owner: string, state: WorkflowRunState) {
        this.states.set(owner, state);
        this.listeners.forEach((listener) => listener());
    }
    private patch(owner: string, taskId: string, patch: Partial<WorkflowRunState>) {
        const state = this.get(owner);
        if (state?.taskId === taskId) this.update(owner, { ...state, ...patch });
    }
    async start(owner: string, taskId: string, submit: () => Promise<TaskReceipt>, retryable = false) {
        const current = this.get(owner);
        if (current?.running || current?.submitting || current?.unknown || current?.cancellation && current.cancellation !== "confirmed" && !current.cancellationAcknowledged) return;
        this.submissions.set(owner, submit);
        this.update(owner, { taskId, running: true, submitting: true, cancelling: false, unknown: false, retryable, result: null });
        await this.submit(owner, taskId, submit);
    }
    private async submit(owner: string, taskId: string, submit: () => Promise<TaskReceipt>) {
        try {
            const receipt = await submit();
            const receivedId = receipt.task?.id || receipt.taskId;
            if (!receivedId) throw new Error("Task receipt missing");
            if (this.get(owner)?.taskId !== taskId) return;
            // Commit the POST receipt before any GET. A failed read must never erase a real server ID.
            this.patch(owner, taskId, { taskId: receivedId, submitting: false, unknown: false, error: undefined, ...(receivedId !== taskId ? { retryable: false } : {}) });
            if (receipt.task) this.receive(owner, receipt);
        } catch (error) {
            if (error instanceof WorkflowSubmissionRejected) {
                this.patch(owner, taskId, { submitting: false, running: false, unknown: false, result: { taskId, media: [], status: { status_str: "failed", completed: true }, error: error.message } });
                return;
            }
            // A lost response is not proof that the paid submission failed.
            this.patch(owner, taskId, { submitting: false, unknown: true, error: error instanceof Error ? error.message : String(error) });
        }
    }
    acknowledgeCancellation(owner: string) {
        const state = this.get(owner);
        if (state?.cancellation && state.cancellation !== "confirmed") this.patch(owner, state.taskId, { cancellationAcknowledged: true });
    }
    async retrySubmission(owner: string) {
        const current = this.get(owner);
        const submit = this.submissions.get(owner);
        if (!current?.unknown || !current.retryable || current.submitting || !submit) return;
        this.patch(owner, current.taskId, { submitting: true });
        await this.submit(owner, current.taskId, submit);
    }
    receive(owner: string, { task, events = [] }: TaskReceipt) {
        if (!task || this.get(owner)?.taskId !== task.id) return;
        const current = this.get(owner)!;
        if (current.result?.status.completed && !terminal(task.status)) return;
        if (current.result?.status.status_str === "success" && task.status !== "succeeded") return;
        const eventTypes = events.map((event) => (event as { type?: string }).type);
        const remoteSubmitted = eventTypes.includes("submitted");
        const remoteCancelled = eventTypes.includes("remote_cancelled");
        const remoteFailed = eventTypes.includes("remote_cancel_failed");
        const cancelled = task.status === "cancelled";
        const cancellation = cancelled
            ? remoteFailed ? "unconfirmed" : remoteCancelled ? "confirmed" : remoteSubmitted ? "pending" : "local"
            : undefined;
        this.patch(owner, task.id, {
            running: !terminal(task.status),
            remoteTaskId: (events.find((event) => (event as { type?: string }).type === "submitted") as { payload?: { taskId?: string } } | undefined)?.payload?.taskId || current.remoteTaskId,
            submitting: false,
            unknown: false,
            error: undefined,
            cancellation,
            result: terminal(task.status) ? workflowTaskResult(task) : null,
        });
    }
    adopt(owner: string, task: BackendRuntimeTask) {
        const current = this.get(owner);
        if (current?.running || current?.submitting || current?.unknown) return;
        this.update(owner, { taskId: task.id, running: !terminal(task.status), submitting: false, cancelling: false, unknown: false, result: terminal(task.status) ? workflowTaskResult(task) : null });
    }
    async poll(owner: string, read: (id: string) => Promise<TaskReceipt>) {
        const state = this.get(owner);
        if (!state || state.submitting || this.reading.has(state.taskId)) return;
        const taskId = state.taskId;
        this.reading.add(taskId);
        try {
            const receipt = await read(taskId);
            if (!receipt.task) throw new Error("Task not found");
            this.receive(owner, receipt);
        } catch (error) {
            this.patch(owner, taskId, { error: error instanceof Error ? error.message : String(error) });
        } finally { this.reading.delete(taskId); }
    }
    async cancel(owner: string, cancel: (id: string) => Promise<unknown>, read: (id: string) => Promise<TaskReceipt>) {
        const state = this.get(owner);
        if (!state || state.cancelling || state.submitting || !state.running) return;
        const taskId = state.taskId;
        this.patch(owner, taskId, { cancelling: true });
        try {
            await cancel(taskId);
            // HTTP success only means Backend accepted the cancellation. Inspect its task/events.
            const receipt = await read(taskId);
            if (!receipt.task) throw new Error("Task not found");
            this.receive(owner, receipt);
        } catch (error) {
            this.patch(owner, taskId, { error: error instanceof Error ? error.message : String(error) });
        } finally { this.patch(owner, taskId, { cancelling: false }); }
    }
}
