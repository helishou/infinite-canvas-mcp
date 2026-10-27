import { performance } from "node:perf_hooks";

type SlowOperationLogger = {
    warn: (message: string, details?: Record<string, unknown>) => unknown;
};

const configuredThreshold = Number(process.env.INFINITE_CANVAS_SLOW_OPERATION_MS);
export const SLOW_OPERATION_THRESHOLD_MS = Number.isFinite(configuredThreshold) && configuredThreshold >= 100
    ? configuredThreshold
    : 1_000;

let nextOperationId = 0;

function nextId() {
    return `slow-${Date.now().toString(36)}-${(++nextOperationId).toString(36)}`;
}

/** Log only operations that exceed the local threshold; never include input or output payloads. */
export function watchSlowOperation(
    logger: SlowOperationLogger,
    operation: string,
    details: Record<string, unknown> = {},
) {
    const operationId = nextId();
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

/**
 * Responses that stay open after the first byte. Their lifetime measures how long the client kept the
 * connection (SSE streams, media downloads), not how long the server needed to answer, so logging it as a
 * slow request buries the real ones.
 */
const STREAMING_CONTENT_TYPES = ["text/event-stream", "video/", "audio/", "application/octet-stream"];

function isStreamingContentType(contentType: string) {
    const value = contentType.toLowerCase();
    return STREAMING_CONTENT_TYPES.some((prefix) => value.startsWith(prefix));
}

/**
 * HTTP request telemetry. Streaming responses report time to first byte only; everything else reports the
 * full request duration. Never includes payloads.
 */
export function watchHttpOperation(
    logger: SlowOperationLogger,
    operation: string,
    details: Record<string, unknown> = {},
    contentTypeProbe?: () => string,
) {
    const operationId = nextId();
    const startedAt = performance.now();
    let firstByteAt: number | null = null;
    let streaming = false;
    let reportedPending = false;
    let finished = false;
    const pendingIsStreaming = () => streaming || (contentTypeProbe !== undefined && isStreamingContentType(contentTypeProbe()));
    const timer = setTimeout(() => {
        // SSE 连接建立后可能长时间不发第一个事件；headers 已声明流式就不再记 pending，
        // 否则每条挂着的 /mcp、/events 连接都会挤满慢请求统计。
        if (pendingIsStreaming()) return;
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

    return {
        /**
         * Record when the response started writing; idempotent, safe on repeated header flushes.
         * Streaming responses stop the pending timer here so a long-lived connection is never reported as slow.
         */
        markFirstByte(contentType = "") {
            if (firstByteAt !== null) return;
            firstByteAt = performance.now();
            if (isStreamingContentType(contentType)) {
                streaming = true;
                clearTimeout(timer);
            }
        },
        finish(outcome: string, contentType = "") {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            if (isStreamingContentType(contentType) || streaming || pendingIsStreaming()) {
                const streamType = (contentType || contentTypeProbe?.() || "").toLowerCase();
                // SSE 的首事件时刻是业务时机而非服务端应答延迟，不记 first-byte。
                if (streamType.startsWith("text/event-stream")) return;
                const firstByteMs = Math.round((firstByteAt ?? performance.now()) - startedAt);
                if (firstByteMs < SLOW_OPERATION_THRESHOLD_MS) return;
                logger.warn("slow-operation-first-byte", { operationId, operation, firstByteMs, outcome, ...details });
                return;
            }
            const durationMs = Math.round(performance.now() - startedAt);
            if (!reportedPending && durationMs < SLOW_OPERATION_THRESHOLD_MS) return;
            logger.warn("slow-operation-finished", { operationId, operation, durationMs, outcome, ...details });
        },
    };
}

/** Keep endpoint telemetry useful without persisting project, task, or other entity IDs. */
export function safeOperationPath(path: string) {
    return path.split("?", 1)[0]
        .replace(/\/(media|runtime\/media-file)\/[^/]+/gi, "/$1/:storageKey")
        .replace(/\/(projects|nodes|tasks|assets|dramas|episodes|scenes|threads|sessions|workflows)\/[^/]+/gi, "/$1/:id")
        .replace(/\/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, "/:id");
}
