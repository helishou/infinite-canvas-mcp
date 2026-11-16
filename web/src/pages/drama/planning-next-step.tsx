import { useCallback, useEffect, useState } from "react";
import { useAgentStore } from "@/stores/use-agent-store";
import { ArrowRight, Loader2, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { fetchDramaStage, type DramaStageReport } from "@/services/backend-api";

/**
 * 「下一步」条：直接显示后端派生的阶段结论——下一步做什么、用哪份技能。
 *
 * 不自己算阶段：判定只有一份（canvas-agent/drama/stage-contract），
 * 这里只负责把后端结论画出来，agent 每轮拿到的也是同一份。
 */
export function PlanningNextStep({ dramaId, onRefreshToken }: { dramaId: string; onRefreshToken?: number }) {
    const { t } = useTranslation();
    const [report, setReport] = useState<DramaStageReport | null>(null);
    const [loading, setLoading] = useState(false);
    const agentBusy = useAgentStore((state) => Boolean(state.sending || state.waiting || ["preparing", "running"].includes(state.conversation.status)));

    const load = useCallback(async () => {
        if (!dramaId) return;
        setLoading(true);
        try {
            setReport(await fetchDramaStage(dramaId));
        } catch {
            setReport(null);
        } finally {
            setLoading(false);
        }
    }, [dramaId]);

    useEffect(() => { void load(); }, [load, onRefreshToken]);
    // agent 在跑时快轮询，闲时慢轮询：页面上要能看到「导演正在做哪一段」。
    useEffect(() => {
        const timer = window.setInterval(() => { void load(); }, agentBusy ? 5000 : 25000);
        return () => window.clearInterval(timer);
    }, [load, agentBusy]);

    if (!dramaId) return null;
    if (!report) {
        return <div className="flex items-center gap-2 rounded-xl border border-border/70 bg-muted/[0.12] px-3 py-2 text-xs text-muted-foreground" data-planning-next-step="loading">
            {loading ? <Loader2 className="size-3.5 animate-spin" /> : null}{t("planningNext.loading")}
        </div>;
    }
    const next = report.next;
    const doneCount = report.states.filter((state) => state.done).length;

    return <div className="rounded-xl border border-border/70 bg-muted/[0.12]" data-planning-next-step={next.stage || "done"}>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2">
            <span className="rounded-full bg-muted/60 px-2 py-0.5 text-[10px] tabular-nums text-muted-foreground">{doneCount}/{report.states.length}</span>
            <span className="text-[13px] font-semibold text-foreground">{t("planningNext.title")}</span>
            <span className="flex min-w-0 items-center gap-1.5 text-xs">
                <ArrowRight className="size-3.5 shrink-0 text-primary" />
                <span className="min-w-0 truncate text-foreground" data-planning-next-action>{next.action}</span>
            </span>
            <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary" data-planning-next-skill>{next.skill}</span>
            {report.activity ? <span className="flex items-center gap-1.5 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] text-primary" data-planning-activity={report.activity.stage}>
                <span className="size-1.5 animate-pulse rounded-full bg-primary" />{report.activity.label}
            </span> : null}
            <span className="min-w-0 flex-1" />
            <button type="button" onClick={() => void load()} className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground" aria-label={t("planningNext.refresh")}>
                {loading ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
            </button>
        </div>
        {next.gaps.length ? <div className="flex flex-wrap gap-1.5 border-t border-border/60 px-3 py-2" data-planning-next-gaps>
            {next.gaps.slice(0, 6).map((gap) => <span key={gap} className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-500">{gap}</span>)}
            {next.gaps.length > 6 ? <span className="text-[11px] text-muted-foreground">+{next.gaps.length - 6}</span> : null}
        </div> : null}
        <div className="flex flex-wrap items-center gap-2 border-t border-border/60 px-3 py-1.5">
            {report.states.map((state) => <span key={state.key} className={`rounded px-1.5 py-0.5 text-[10px] tabular-nums ${state.done ? "bg-emerald-500/10 text-emerald-400" : report.activity?.stage === state.key ? "bg-primary/25 font-medium text-primary ring-1 ring-primary/40" : state.key === next.stage ? "bg-primary/15 text-primary" : "text-muted-foreground/70"}`}>
                {state.key}{state.total > 1 ? ` ${state.doneCount}/${state.total}` : ""}
            </span>)}
            <span className="min-w-0 flex-1" />
            <span className="flex min-w-0 items-center gap-1 text-[10px] text-muted-foreground/70"><span className="shrink-0 rounded bg-muted/50 px-1 py-0.5">{t("planningNext.skillLabel")}</span><span className="truncate font-mono" data-planning-next-skill-path>{next.skillPath}</span></span>
        </div>
    </div>;
}
