import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const hash = (value: unknown) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");

export type ContinuityConsumerResult = {
    status?: string;
    sourceHash?: string;
    runtime?: { runtimeId?: string };
    report?: { stale?: boolean; sourceHash?: string; runtimeId?: string; selectedTargets?: string[]; diagnostics?: Array<{ code?: string; message?: string; severity?: string; affectedTargets?: string[] }> } | null;
};

export type ContinuityConsumerBlocker = { code: "CONTINUITY_REPORT_REQUIRED" | "CONTINUITY_SCOPE_INCOMPLETE" | "CONTINUITY_BLOCKED"; message: string; targetId?: string };

/** Shared H3 readiness rule for publication, readiness summaries, and native execution. */
export function continuityTargetBlockers(result: ContinuityConsumerResult, targetIds: string[]): ContinuityConsumerBlocker[] {
    const report = result.report;
    if (!report || report.stale || !result.sourceHash || !result.runtime?.runtimeId || report.sourceHash !== result.sourceHash || report.runtimeId !== result.runtime.runtimeId ||
        !["passed", "partial", "blocked", "unresolved"].includes(String(result.status))) {
        return [{ code: "CONTINUITY_REPORT_REQUIRED", message: "当前制作源和固定运行包缺少有效连续性检查回执" }];
    }
    const selected = new Set(Array.isArray(report.selectedTargets) ? report.selectedTargets : []);
    const blockers: ContinuityConsumerBlocker[] = targetIds.filter(targetId => !selected.has(targetId)).map(targetId => ({
        code: "CONTINUITY_SCOPE_INCOMPLETE", message: `连续性检查没有覆盖片段 ${targetId}`, targetId,
    }));
    const requested = new Set(targetIds);
    for (const issue of report.diagnostics || []) {
        if (issue.severity === "warning") continue;
        const affected = Array.isArray(issue.affectedTargets) ? issue.affectedTargets : [];
        if (affected.length && !affected.some(targetId => requested.has(targetId))) continue;
        blockers.push({ code: "CONTINUITY_BLOCKED", message: `${issue.code || "CONTINUITY_ISSUE"}: ${issue.message || "连续性检查存在未解决问题"}`,
            ...(affected.length === 1 ? { targetId: affected[0] } : {}) });
    }
    return blockers;
}

export class ProductionContinuityReports {
    constructor(private readonly root: string) {}

    private ownerDirectory(owner: { kind: string; id: string }) {
        return path.join(this.root, hash(owner));
    }

    get(owner: { kind: string; id: string }, snapshot: "draft" | "published", current: { sourceHash?: string; runtimeId?: string; snapshotVersion?: number }, view: string, targetId?: string, objectId?: string, pageSize = 20, cursor?: string) {
        const directory = this.ownerDirectory(owner);
        const reports = fs.existsSync(directory) ? fs.readdirSync(directory).filter(name => name.startsWith("report-") && name.endsWith(".json")).flatMap(name => {
            try { return [JSON.parse(fs.readFileSync(path.join(directory, name), "utf8"))]; } catch { return []; }
        }).filter(report => report.owner?.kind === owner.kind && report.owner?.id === owner.id && report.snapshot === snapshot).sort((a, b) => String(b.checkedAt).localeCompare(String(a.checkedAt))) : [];
        const prior = (reports.find(report => report.sourceHash === current.sourceHash && report.runtimeId === current.runtimeId &&
            (snapshot === "draft" || report.snapshotVersion === current.snapshotVersion)) || reports[0]) as any;
        if (!prior) return { status: "unchecked", report: null, total: 0, items: [], nextCursor: null };
        const currentReport = prior.sourceHash === current.sourceHash && prior.runtimeId === current.runtimeId &&
            (snapshot === "draft" || prior.snapshotVersion === current.snapshotVersion);
        const status = currentReport ? prior.verdict : "stale";
        const selection = JSON.stringify({ owner, snapshot, snapshotVersion: snapshot === "published" ? current.snapshotVersion : undefined,
            sourceHash: current.sourceHash || "", runtimeId: current.runtimeId || "", view, targetId, objectId });
        let offset = 0;
        if (cursor) {
            try {
                const parsed = JSON.parse(decodeURIComponent(cursor));
                if (parsed.selection !== selection) throw new Error();
                offset = parsed.offset;
            } catch { throw new Error("READ_CURSOR_EXPIRED: 连续性报告已变化，请重新读取"); }
        }
        let items: unknown[] = [];
        if (view === "issues") items = (prior.diagnostics || []).filter((item: any) => !targetId || item.targetId === targetId || item.affectedTargets?.includes(targetId));
        else if (view === "timeline") items = Object.entries(prior.trajectories || {}).filter(([shotId, trajectory]: [string, any]) =>
            (!targetId || shotId === targetId) && (!objectId || Object.keys(trajectory.end || {}).some(key => prior.factObjects?.[key]?.id === objectId)));
        else if (view === "shot") items = Object.entries(prior.trajectories || {}).filter(([shotId]) => shotId === targetId);
        const end = offset + pageSize;
        return { status,
            report: { ...prior, stale: !currentReport }, total: items.length, items: items.slice(offset, end),
            nextCursor: end < items.length ? encodeURIComponent(JSON.stringify({ selection, offset: end })) : null };
    }

    operation(owner: { kind: string; id: string }, operationId: string) {
        const directory = this.ownerDirectory(owner);
        const file = path.join(directory, `operation-${hash(operationId)}.json`);
        return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : undefined;
    }

    persist(owner: { kind: string; id: string }, operationId: string, requestHash: string, report: Record<string, unknown>) {
        const directory = this.ownerDirectory(owner);
        fs.mkdirSync(directory, { recursive: true });
        const reportFile = path.join(directory, `report-${hash({ sourceHash: report.sourceHash, runtimeId: report.runtimeId, operationId })}.json`);
        const operationFile = path.join(directory, `operation-${hash(operationId)}.json`);
        const result = { status: "succeeded", verdict: report.verdict, report, mediaSubmitted: false };
        for (const [file, value] of [[reportFile, report], [operationFile, { requestHash, result }]] as const) {
            const temporary = `${file}.${crypto.randomUUID()}.tmp`;
            fs.writeFileSync(temporary, JSON.stringify(value), { encoding: "utf8", flag: "wx" });
            fs.renameSync(temporary, file);
        }
        return result;
    }
}
