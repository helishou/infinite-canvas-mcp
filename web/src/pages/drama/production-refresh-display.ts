type Refresh = { segmentId: string; savedRevision: number; status: string; sourceHash?: string; blockingDiagnostic?: { code: string; message: string } };
export function currentClipRefreshes<T extends Refresh>(jobs: T[], segmentIds: string[], sourceHash?: string): T[] {
    const active = new Set(segmentIds), latest = new Map<string, T>();
    for (const job of jobs) {
        if (!active.has(job.segmentId)) continue;
        const previous = latest.get(job.segmentId);
        if (!previous || job.savedRevision > previous.savedRevision) latest.set(job.segmentId, job);
    }
    return [...latest.values()].filter(job => !["superseded", "interrupted"].includes(job.status)
        && (!sourceHash || !job.sourceHash || job.sourceHash === sourceHash));
}
export function groupedRefreshIssues<T extends Refresh>(jobs: T[]) {
    const groups = new Map<string, { message: string; code: string; segmentIds: string[] }>();
    for (const job of jobs) {
        if (!["blocked", "failed"].includes(job.status) || !job.blockingDiagnostic) continue;
        const { code, message } = job.blockingDiagnostic, key = JSON.stringify([code, message]);
        const group = groups.get(key) || { code, message, segmentIds: [] };
        if (!group.segmentIds.includes(job.segmentId)) group.segmentIds.push(job.segmentId);
        groups.set(key, group);
    }
    return [...groups.values()];
}
