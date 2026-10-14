import { performance } from "node:perf_hooks";

type SlowOperationLogger = {
    warn: (message: string, details?: Record<string, unknown>) => unknown;
};

const configuredThreshold = Number(process.env.INFINITE_CANVAS_SLOW_OPERATION_MS);
export const SLOW_OPERATION_THRESHOLD_MS = Number.isFinite(configuredThreshold) && configuredThreshold >= 100
    ? configuredThreshold
    : 1_000;

let nextOperationId = 0;

/** Log only operations that exceed the local threshold; never include input or output payloads. */
export function watchSlowOperation(
    logger: SlowOperationLogger,
    operation: string,
    details: Record<string, unknown> = {},
) {
    const operationId = `slow-${Date.now().toString(36)}-${(++nextOperationId).toString(36)}`;
    const startedAt = performance.now();
    let reportedPending = false;
    let finished = false;
    const timer = setTimeout(() => {
        reportedPending = true;
        logger.warn("slow-operation-pending", {
            operationId,
            operation,
            thresholdMs: SLOW_OPERATION_THRESHOLD_MS,
            elapsedMs: Math.round(performance.now() - startedAt),
            ...details,
        });
    }, SLOW_OPERATION_THRESHOLD_MS);
    timer.unref?.();

    return (outcome: string) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        const durationMs = Math.round(performance.now() - startedAt);
        if (!reportedPending && durationMs < SLOW_OPERATION_THRESHOLD_MS) return;
        logger.warn("slow-operation-finished", { operationId, operation, durationMs, outcome, ...details });
    };
}

/** Keep endpoint telemetry useful without persisting project, task, or other entity IDs. */
export function safeOperationPath(path: string) {
    return path.split("?", 1)[0]
        .replace(/\/(projects|nodes|tasks|assets|dramas|episodes|scenes|threads|sessions|workflows)\/[^/]+/gi, "/$1/:id")
        .replace(/\/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, "/:id");
}
