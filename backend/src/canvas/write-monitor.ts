export const REFERENCE_WRITE_MONITOR_WINDOW_MS = 10_000;
export const REFERENCE_WRITE_MONITOR_ALERT_THRESHOLD = 20;

export type ReferenceWriteMonitorEvent = {
    projectId: string;
    assetId: string;
    changed: boolean;
};

export type ReferenceWriteMonitorAlert = ReferenceWriteMonitorEvent & {
    attempts: number;
    windowMs: number;
};

type RecordedWrite = ReferenceWriteMonitorEvent & { at: number };

export class ReferenceWriteMonitor {
    private readonly writes: RecordedWrite[] = [];
    private readonly alertedAt = new Map<string, number>();

    constructor(private readonly onAlert?: (alert: ReferenceWriteMonitorAlert) => void) {}

    record(event: ReferenceWriteMonitorEvent, now = Date.now()) {
        this.prune(now);
        const recorded = { ...event, at: now };
        this.writes.push(recorded);
        const key = `${event.projectId}\u0000${event.assetId}`;
        const attempts = this.writes.filter((write) => write.projectId === event.projectId && write.assetId === event.assetId).length;
        const previousAlert = this.alertedAt.get(key);
        if (attempts >= REFERENCE_WRITE_MONITOR_ALERT_THRESHOLD && (previousAlert === undefined || now - previousAlert >= REFERENCE_WRITE_MONITOR_WINDOW_MS)) {
            this.alertedAt.set(key, now);
            this.onAlert?.({ ...event, attempts, windowMs: REFERENCE_WRITE_MONITOR_WINDOW_MS });
        }
    }

    snapshot(projectId: string, now = Date.now()) {
        this.prune(now);
        const writes = this.writes.filter((write) => write.projectId === projectId);
        const byAsset = new Map<string, { assetId: string; attempts: number; changed: number }>();
        for (const write of writes) {
            const current = byAsset.get(write.assetId) || { assetId: write.assetId, attempts: 0, changed: 0 };
            current.attempts++;
            if (write.changed) current.changed++;
            byAsset.set(write.assetId, current);
        }
        return {
            windowMs: REFERENCE_WRITE_MONITOR_WINDOW_MS,
            alertThreshold: REFERENCE_WRITE_MONITOR_ALERT_THRESHOLD,
            attempts: writes.length,
            changed: writes.filter((write) => write.changed).length,
            assets: [...byAsset.values()].sort((left, right) => right.attempts - left.attempts),
        };
    }

    private prune(now: number) {
        const cutoff = now - REFERENCE_WRITE_MONITOR_WINDOW_MS;
        let firstLive = 0;
        while (firstLive < this.writes.length && this.writes[firstLive].at < cutoff) firstLive++;
        if (firstLive) this.writes.splice(0, firstLive);
        for (const [key, at] of this.alertedAt) if (at < cutoff) this.alertedAt.delete(key);
    }
}
