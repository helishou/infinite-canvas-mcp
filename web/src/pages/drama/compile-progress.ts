import { useEffect, useState } from "react";

/** Refresh-job phases that are still running in the Backend. */
export const activeCompileStatuses = ["queued", "checking", "compiling", "applying"] as const;

export function isCompileActive(status: string | undefined): boolean {
    return Boolean(status) && (activeCompileStatuses as readonly string[]).includes(String(status));
}

/**
 * Elapsed seconds since the Backend created the refresh job. The compiler itself is a
 * single blocking call with no percentage, so the UI reports real elapsed time instead
 * of inventing progress.
 */
export function compileElapsedSeconds(createdAt: string | undefined, now: number): number | undefined {
    if (!createdAt) return undefined;
    const started = Date.parse(createdAt);
    if (!Number.isFinite(started)) return undefined;
    return Math.max(0, Math.floor((now - started) / 1000));
}

/** One shared one-second clock while any refresh job is active; it never issues requests. */
export function useCompileClock(active: boolean): number {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        if (!active) return;
        setNow(Date.now());
        const timer = window.setInterval(() => setNow(Date.now()), 1000);
        return () => window.clearInterval(timer);
    }, [active]);
    return now;
}
