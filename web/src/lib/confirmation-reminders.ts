import type { AgentPendingApproval, AgentPendingToolCall } from "../stores/use-agent-store";
import type { BackendRuntimeTask, EpisodeProduction, ProductionCanvasContext, ProductionReadiness } from "../services/backend-api";
import { productionObjectPath, type ProductionObject } from "./production-object";

export type ConfirmationReminder = { id: string; kind: "approval" | "tool" | "decision" | "review" | "task"; path: string; threadId?: string; object?: ProductionObject };
export type TaskConfirmationReminder = { id: string; taskId: string; projectId: string; nodeId?: string; segmentId?: string };

export function taskConfirmationReminders(tasks: BackendRuntimeTask[], projectId: string): TaskConfirmationReminder[] {
    const byId = new Map(tasks.map(task => [task.id, task]));
    return tasks.filter(task => task.projectId === projectId && task.status === "awaiting_confirmation").flatMap(task => {
        const confirmation = task.result?.confirmation;
        const knownSlots = Array.isArray(confirmation?.pending) ? confirmation.pending.filter(item => item && typeof item.nodeId === "string" && typeof item.segmentId === "string") : [];
        const slots = knownSlots.length ? knownSlots : [{ nodeId: task.nodeId, segmentId: task.segmentId, firstPassFingerprint: "" }];
        const parent = task.parentTaskId ? byId.get(task.parentTaskId) : undefined;
        const parentSlots = parent?.result?.confirmation?.pending;
        return slots.filter(slot => !(parent?.projectId === projectId && parent.status === "awaiting_confirmation" && Array.isArray(parentSlots) && parentSlots.some(item => item && item.nodeId === slot.nodeId && item.segmentId === slot.segmentId)))
            .map(slot => ({ id: `task:${task.id}:${confirmation?.revision ?? ""}:${slot.nodeId || ""}:${slot.segmentId || ""}:${slot.firstPassFingerprint}`, taskId: task.id, projectId, nodeId: slot.nodeId, segmentId: slot.segmentId }));
    });
}

/** Only authoritative pending states; assistant prose and automatic reviews are not prompts. */
export function collectConfirmationReminders(input: {
    approvals: AgentPendingApproval[]; pendingTool: AgentPendingToolCall | null; threadId: string; route: string;
    context: ProductionCanvasContext | null; production: EpisodeProduction | null; readiness: ProductionReadiness | null;
    taskConfirmations?: TaskConfirmationReminder[];
}): ConfirmationReminder[] {
    const reminders: ConfirmationReminder[] = [];
    for (const approval of input.approvals) {
        if (approval.deciding || approval.threadId && approval.threadId !== input.threadId) continue;
        reminders.push({ id: `approval:${approval.threadId || input.threadId}:${approval.requestId}`, kind: "approval", path: input.route, threadId: approval.threadId || input.threadId });
    }
    if (input.pendingTool) {
        const projectId = input.pendingTool.input?.projectId;
        const path = typeof projectId === "string" && projectId
            ? input.context?.owner && input.context.canvasId === projectId
                ? productionObjectPath({ owner: input.context.owner, canvasId: projectId, workspace: "overview", title: "" })
                : `/canvas/${encodeURIComponent(projectId)}` : input.route;
        reminders.push({ id: `tool:${input.threadId}:${input.pendingTool.requestId}`, kind: "tool", path, threadId: input.threadId });
    }
    const { context, production, readiness } = input;
    for (const task of input.taskConfirmations || []) {
        const owner = context?.canvasId === task.projectId ? context.owner : undefined;
        const query = new URLSearchParams();
        if (task.nodeId) query.set("nodeId", task.nodeId);
        if (task.segmentId) query.set("segmentId", task.segmentId);
        const path = owner ? productionObjectPath({ owner, canvasId: task.projectId, workspace: "production", nodeId: task.nodeId, segmentId: task.segmentId, title: "" })
            : `/canvas/${encodeURIComponent(task.projectId)}${query.size ? `?${query}` : ""}`;
        reminders.push({ id: task.id, kind: "task", path });
    }
    if (!context?.owner || !production || context.owner.id !== production.episodeId) return reminders;
    const director = production.draft.director;
    if (!director) return reminders;
    const ownerKey = `${context.owner.kind}:${context.owner.id}`;
    for (const decision of director.workflow.pendingDecisions || []) if (decision.status === "pending") {
        reminders.push({ id: `decision:${ownerKey}:${decision.workId}:${decision.id}:${decision.sourceHash}`, kind: "decision", path: productionObjectPath({ owner: context.owner, canvasId: context.canvasId, workspace: "overview", title: "" }), threadId: director.workflow.agentThreadId });
    }
    const mediaMode = director.workflow.mediaProductionMode || (production.draft.settings.mode === "auto" ? "automatic" : "per_item");
    if (mediaMode !== "per_item") return reminders;
    for (const target of readiness?.targets || []) {
        if (target.status !== "needs_review" || !["asset", "keyframe"].includes(target.kind)) continue;
        const frame = target.kind === "keyframe" ? production.draft.keyframes[target.targetId] : undefined;
        const assetId = target.kind === "keyframe" ? director.shotInputs[target.targetId]?.keyframeAssetId : target.targetId;
        const asset = assetId ? director.assets[assetId] : undefined;
        const storageKey = frame?.storageKey || asset?.storageKey;
        if (!storageKey) continue;
        const object: ProductionObject = { owner: context.owner, canvasId: context.canvasId, workspace: target.kind === "keyframe" ? "shots" : "assets",
            targetKind: target.kind === "keyframe" ? "shot" : "asset", targetId: target.targetId, nodeId: frame?.nodeId || asset?.nodeId, title: target.title };
        reminders.push({ id: `review:${ownerKey}:${target.id}:${storageKey}:${asset?.sha256 || ""}:${production.publishedVersion}`, kind: "review", path: productionObjectPath(object), object });
    }
    return reminders;
}

type NotificationHandle = { close(): void };
export type ReminderEnvironment = {
    background(): boolean; allowed(): boolean;
    show(items: ConfirmationReminder[], click: () => void, fail: (error: unknown) => void): NotificationHandle;
    activate(item: ConfirmationReminder): void;
    remember(ids: string[]): void;
    failed(error: unknown): void;
};

/** UI-only notification lifecycle; never decides approvals, edits production, or submits tasks. */
export class ConfirmationReminderController {
    private seen: Set<string>;
    private origins = new Map<string, ConfirmationReminder>();
    private pending = new Map<string, ConfirmationReminder>();
    private notification: NotificationHandle | null = null;
    private notificationTarget = "";
    private notificationToken: object | null = null;
    private failed = false;
    constructor(private environment: ReminderEnvironment, remembered: string[] = []) { this.seen = new Set(remembered); }

    update(items: ConfirmationReminder[], enabled: boolean) {
        this.pending = new Map(items.map(item => [item.id, item]));
        for (const id of this.origins.keys()) if (!this.pending.has(id)) this.origins.delete(id);
        for (const item of items) if (!this.origins.has(item.id)) this.origins.set(item.id, item);
        if (this.notification && !this.pending.has(this.notificationTarget)) {
            const remaining = this.pending.keys().next().value;
            if (remaining) this.notificationTarget = remaining; else this.close();
        }
        if (!enabled || !this.environment.background()) { this.close(); return; }
        if (this.failed || !this.environment.allowed()) return;
        const fresh = items.filter(item => !this.seen.has(item.id));
        if (!fresh.length) return;
        const target = fresh[0].id;
        try {
            this.close();
            this.notificationTarget = target;
            const token = {}; this.notificationToken = token;
            const notification = this.environment.show(items, () => {
                if (this.notificationToken !== token) return;
                const activeTarget = this.notificationTarget;
                this.close();
                if (!this.pending.has(activeTarget)) return;
                this.environment.activate(this.origins.get(activeTarget)!);
            }, error => {
                if (this.notificationToken !== token) return;
                for (const item of fresh) this.seen.delete(item.id);
                this.environment.remember([...this.pending.keys()].filter(id => this.seen.has(id)));
                this.close(); this.failed = true; this.environment.failed(error);
            });
            if (this.failed) { notification.close(); return; }
            this.notification = notification;
            for (const item of items) this.seen.add(item.id);
            this.environment.remember(items.map(item => item.id));
        } catch (error) { this.failed = true; this.environment.failed(error); }
    }
    retry() { this.failed = false; }
    close() { this.notification?.close(); this.notification = null; this.notificationTarget = ""; this.notificationToken = null; }
}
