const slowOperationThresholdMs = 1_000;
const longTaskThresholdMs = 250;

let nextOperationId = 0;

function safePath(path: string) {
    return path.split("?", 1)[0]
        .replace(/\/(projects|nodes|tasks|assets|dramas|episodes|scenes|threads|sessions|workflows)\/[^/]+/gi, "/$1/:id")
        .replace(/\/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, "/:id");
}

/** Track browser-side API waits locally; no request body, response body, or credentials are recorded. */
export function watchSlowBrowserOperation(operation: string) {
    const operationId = `browser-slow-${(++nextOperationId).toString(36)}`;
    const startedAt = performance.now();
    let reportedPending = false;
    const timer = setTimeout(() => {
        reportedPending = true;
        console.warn("[slow-operation-pending]", {
            operationId,
            operation,
            thresholdMs: slowOperationThresholdMs,
            elapsedMs: Math.round(performance.now() - startedAt),
        });
    }, slowOperationThresholdMs);
    let finished = false;
    return (outcome: string) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        const durationMs = Math.round(performance.now() - startedAt);
        if (!reportedPending && durationMs < slowOperationThresholdMs) return;
        console.warn("[slow-operation-finished]", { operationId, operation, durationMs, outcome });
    };
}

export function browserOperationName(method: string, path: string) {
    return `${method.toUpperCase()} ${safePath(path)}`;
}

if (typeof window !== "undefined" && typeof PerformanceObserver !== "undefined") {
    try {
        const observer = new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
                if (entry.duration < longTaskThresholdMs) continue;
                console.warn("[slow-operation-main-thread]", {
                    durationMs: Math.round(entry.duration),
                    startTimeMs: Math.round(entry.startTime),
                });
            }
        });
        observer.observe({ type: "longtask", buffered: true });
    } catch { /* Long Task Timing is unavailable in this browser. */ }
}
