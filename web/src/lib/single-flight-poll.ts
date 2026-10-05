export interface PollTimerScheduler {
    setTimeout(callback: () => void, delayMs: number): unknown;
    clearTimeout(handle: unknown): void;
}

const browserTimers: PollTimerScheduler = {
    setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
    clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export type SingleFlightPoller = {
    refreshNow(): void;
    pause(): void;
    resume(): void;
    stop(): void;
};

/** Schedule the next poll only after the current one settles; refresh signals coalesce. */
export function startSingleFlightPoller(options: {
    poll: () => Promise<unknown>;
    intervalMs: number;
    initiallyPaused?: boolean;
    scheduler?: PollTimerScheduler;
    onError?: (error: unknown) => void;
}): SingleFlightPoller {
    if (!Number.isFinite(options.intervalMs) || options.intervalMs < 1) throw new Error("intervalMs must be a positive number");

    const scheduler = options.scheduler || browserTimers;
    let active = true;
    let paused = Boolean(options.initiallyPaused);
    let inFlight = false;
    let refreshQueued = false;
    let timer: unknown | null = null;

    const clearTimer = () => {
        if (timer === null) return;
        scheduler.clearTimeout(timer);
        timer = null;
    };

    const scheduleNext = () => {
        if (!active || paused || timer !== null) return;
        timer = scheduler.setTimeout(() => {
            timer = null;
            void run();
        }, options.intervalMs);
    };

    const run = async (): Promise<void> => {
        if (!active || paused) return;
        if (inFlight) {
            refreshQueued = true;
            return;
        }
        inFlight = true;
        try {
            await options.poll();
        } catch (error) {
            try { options.onError?.(error); } catch { /* Error reporting must not break scheduling. */ }
        } finally {
            inFlight = false;
            if (!active || paused) return;
            if (refreshQueued) {
                refreshQueued = false;
                void run();
                return;
            }
            scheduleNext();
        }
    };

    if (!paused) void run();

    return {
        refreshNow() {
            if (!active || paused) return;
            clearTimer();
            if (inFlight) {
                refreshQueued = true;
                return;
            }
            void run();
        },
        pause() {
            if (!active) return;
            paused = true;
            clearTimer();
        },
        resume() {
            if (!active || !paused) return;
            paused = false;
            refreshQueued = false;
            void run();
        },
        stop() {
            if (!active) return;
            active = false;
            refreshQueued = false;
            clearTimer();
        },
    };
}
