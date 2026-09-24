import type { CanvasReferenceService } from "@/types/canvas-plugin";

function stableReferenceSignature(input: Parameters<CanvasReferenceService["upsert"]>[0] & { id: string }) {
    const sortValue = (value: unknown): unknown => {
        if (Array.isArray(value)) return value.map(sortValue);
        if (!value || typeof value !== "object") return value;
        return Object.fromEntries(
            Object.entries(value as Record<string, unknown>)
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([key, item]) => [key, sortValue(item)]),
        );
    };
    return JSON.stringify(sortValue(input));
}

type ReferenceAsset = Awaited<ReturnType<CanvasReferenceService["upsert"]>>;
type NamedInput = Parameters<CanvasReferenceService["upsert"]>[0] & { id: string };
type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void };
type PendingWrite = { kind: "upsert"; signature: string; input: NamedInput; deferred: Deferred<ReferenceAsset> };
type RunningWrite = { kind: "upsert"; signature: string; input: NamedInput; deferred: Deferred<ReferenceAsset> };
type RunningRemove = { kind: "remove"; assetId: string; deferred: Deferred<void> };
type RemoveIntent = { kind: "remove"; assetId: string; deferred: Deferred<void> };
type LaneIntent = PendingWrite | RemoveIntent;
type Lane = { running?: RunningWrite | RunningRemove; pending?: LaneIntent; drain?: Promise<void> };

function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
    return { promise, resolve, reject };
}

function follow<T>(from: Deferred<T>, target: Promise<T>) {
    void target.then(from.resolve, from.reject);
}

/**
 * Project-scoped latest-intent coordinator for named reference writes.
 * Explicit batches pass through unchanged so one call stays one Backend batch.
 */
export function createReferenceWriteCoordinator(delegate: CanvasReferenceService): CanvasReferenceService {
    const lanes = new Map<string, Lane>();

    const getLane = (assetId: string) => {
        let lane = lanes.get(assetId);
        if (!lane) {
            lane = {};
            lanes.set(assetId, lane);
        }
        return lane;
    };

    const clearRunning = (assetId: string, running: RunningWrite | RunningRemove) => {
        const lane = lanes.get(assetId);
        if (lane?.running !== running) return;
        lane.running = undefined;
    };

    const startWrite = (assetId: string, lane: Lane, pending: PendingWrite): RunningWrite => {
        const running: RunningWrite = { ...pending };
        let settled = false;
        const settle = (value: ReferenceAsset | unknown) => {
            if (settled) return;
            settled = true;
            clearRunning(assetId, running);
        };
        const request = Promise.resolve().then(() => delegate.upsert(pending.input));
        lane.running = running;
        void request.then(
            (value) => { settle(value); pending.deferred.resolve(value); },
            (error) => { settle(error); pending.deferred.reject(error); },
        );
        return running;
    };

    const drain = (assetId: string, lane: Lane) => {
        if (lane.drain) return lane.drain;
        const task = (async () => {
            while (true) {
                const running = lane.running;
                if (running) {
                    try { await running.deferred.promise; }
                    catch { /* the original caller receives the request failure */ }
                }
                const pending = lane.pending;
                if (!pending) {
                    lane.drain = undefined;
                    if (!lane.running && !lane.pending) lanes.delete(assetId);
                    return;
                }
                lane.pending = undefined;
                if (pending.kind === "remove") {
                    const running: RunningRemove = { ...pending };
                    let settled = false;
                    const settle = () => {
                        if (settled) return;
                        settled = true;
                        clearRunning(assetId, running);
                    };
                    lane.running = running;
                    const request = Promise.resolve().then(() => delegate.remove(pending.assetId));
                    void request.then(
                        () => { settle(); running.deferred.resolve(); },
                        (error) => { settle(); running.deferred.reject(error); },
                    );
                    try {
                        await running.deferred.promise;
                    } catch {
                        /* the original caller receives the removal failure */
                    }
                    continue;
                }
                startWrite(assetId, lane, pending);
            }
        })();
        lane.drain = task;
        return task;
    };

    return {
        ...delegate,
        upsert: (input) => {
            const assetId = input.id;
            if (typeof assetId !== "string" || !assetId) return delegate.upsert(input);
            const namedInput: NamedInput = { ...input, id: assetId };
            const signature = stableReferenceSignature(namedInput);
            const lane = getLane(assetId);
            const current = lane.running;

            if (current?.kind === "upsert" && current.signature === signature) {
                const cancelled = lane.pending;
                if (cancelled) {
                    lane.pending = undefined;
                    if (cancelled.kind === "upsert") follow(cancelled.deferred, current.deferred.promise);
                    else cancelled.deferred.resolve();
                }
                return current.deferred.promise;
            }

            if (lane.pending?.kind === "upsert" && lane.pending.signature === signature) {
                return lane.pending.deferred.promise;
            }

            const next: PendingWrite = { kind: "upsert", signature, input: namedInput, deferred: deferred<ReferenceAsset>() };
            const superseded = lane.pending;
            if (superseded?.kind === "upsert") follow(superseded.deferred, next.deferred.promise);
            else if (superseded) superseded.deferred.reject(new ReferenceWriteSupersededError(assetId));
            lane.pending = next;
            void drain(assetId, lane);
            return next.deferred.promise;
        },
        upsertMany: (inputs) => {
            if (!inputs.length) return Promise.resolve([]);
            if (inputs.some((input) => typeof input.id !== "string" || !input.id)) {
                return Promise.reject(new Error("匿名资产不支持批量写入"));
            }
            return delegate.upsertMany(inputs);
        },
        list: () => delegate.list(),
        remove: (assetId) => {
            const lane = getLane(assetId);
            if (lane.running?.kind === "remove") return lane.running.deferred.promise;
            if (lane.pending?.kind === "remove") return lane.pending.deferred.promise;
            const next: RemoveIntent = { kind: "remove", assetId, deferred: deferred<void>() };
            const superseded = lane.pending;
            if (superseded?.kind === "upsert") {
                lane.pending = undefined;
                superseded.deferred.reject(new ReferenceWriteSupersededError(assetId));
            }
            lane.pending = next;
            void drain(assetId, lane);
            return next.deferred.promise;
        },
    };
}

export class ReferenceWriteSupersededError extends Error {
    constructor(assetId: string) {
        super(`参考资产写入已被同资产的最新意图替代：${assetId}`);
        this.name = "ReferenceWriteSupersededError";
    }
}
