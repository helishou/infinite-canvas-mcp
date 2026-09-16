import { randomUUID } from "node:crypto";
import type { CanvasOperation } from "./canvas/project-ops.js";

export type BackendEvent = {
    id: string;
    type: string;
    entityId?: string;
    revision?: number;
    createdAt: string;
    payload: unknown;
};

type Listener = (event: BackendEvent) => void;

/** 进程内实时通知总线；REST 快照仍是重连后的权威数据源。 */
export class BackendEventBus {
    private readonly instanceId = randomUUID();
    private sequence = 0;
    private readonly history: BackendEvent[] = [];
    private readonly listeners = new Set<Listener>();

    publish(input: Omit<BackendEvent, "id" | "createdAt">): BackendEvent {
        const event = { ...input, id: `${this.instanceId}:${++this.sequence}`, createdAt: new Date().toISOString() };
        this.history.push(event);
        if (this.history.length > 1000) this.history.shift();
        for (const listener of this.listeners) listener(event);
        return event;
    }

    publishCanvasDelta(input: { entityId: string; revision: number; operations: CanvasOperation[]; updatedAt?: string; operationResults?: unknown[] }) {
        return this.publish({
            type: "canvas.updated",
            entityId: input.entityId,
            revision: input.revision,
            payload: {
                operations: input.operations,
                ...(input.operationResults ? { operationResults: input.operationResults } : {}),
                ...(input.updatedAt ? { updatedAt: input.updatedAt } : {}),
            },
        });
    }

    publishCanvasSnapshot(input: { entityId?: string; revision?: number; payload: unknown }) {
        return this.publish({ type: "canvas.updated", ...input });
    }

    publishCanvasFolder(input: { entityId: string; payload: unknown }) {
        return this.publish({ type: "canvas-folder.updated", entityId: input.entityId, payload: input.payload });
    }

    since(lastEventId?: string): BackendEvent[] {
        return this.replay(lastEventId).events;
    }

    replay(lastEventId?: string) {
        const cursor = `${this.instanceId}:${this.sequence}`;
        if (!lastEventId) return { cursor, reset: true, events: [...this.history] };
        const prefix = `${this.instanceId}:`;
        const after = lastEventId.startsWith(prefix) ? Number(lastEventId.slice(prefix.length)) : NaN;
        const firstAvailable = this.sequence - this.history.length + 1;
        const reset = !Number.isSafeInteger(after) || after < firstAvailable - 1 || after > this.sequence;
        return { cursor, reset, events: reset ? [] : this.history.slice(after - firstAvailable + 1) };
    }

    subscribe(listener: Listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
}
