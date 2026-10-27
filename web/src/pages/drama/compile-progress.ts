import { useEffect, useState } from "react";

/** Refresh-job phases that are still running in the Backend. */
export const activeCompileStatuses = ["queued", "checking", "compiling", "applying"] as const;

export function isCompileActive(status: string | undefined): boolean {
    return Boolean(status) && (activeCompileStatuses as readonly string[]).includes(String(status));
}

/** Elapsed seconds since the backend last changed the active refresh phase. */
export function compileElapsedSeconds(phaseUpdatedAt: string | undefined, now: number): number | undefined {
    if (!phaseUpdatedAt) return undefined;
    const started = Date.parse(phaseUpdatedAt);
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
