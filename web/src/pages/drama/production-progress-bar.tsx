import { Check, LoaderCircle } from "lucide-react";
import { useTranslation } from "react-i18next";

import { readinessCounts, stageStates, type ProductionStageValue } from "./production-progress";

/**
 * 页面底部制作进度条：六段阶段 + 目标就绪计数 + 忙碌指示。
 * 只读已加载的数据，不发请求、不自己计时，避免给制作台增加轮询。
 */
export function ProductionProgressBar({ stage, targets, busy }: {
    stage: ProductionStageValue;
    targets?: ReadonlyArray<{ status: string }> | null;
    busy?: boolean;
}) {
    const { t } = useTranslation();
    const states = stageStates(stage);
    const counts = readinessCounts(targets);
    return <div data-production-progress className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border pt-3 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{t("drama.production.progress.title")}</span>
        {states.length === 0 ? <span data-production-progress-empty>{t("drama.production.progress.notInitialized")}</span> : <ol className="flex flex-wrap items-center gap-1.5" data-production-progress-stages>
            {states.map((item, index) => <li key={item.key}
                data-production-stage={item.key}
                data-production-stage-state={item.state}
                aria-current={item.state === "current" ? "step" : undefined}
                title={t(`drama.production.progress.stage.${item.key}`)}
                className={`flex items-center gap-1 rounded border px-1.5 py-0.5 ${item.state === "current"
                    ? "border-primary bg-primary/10 font-medium text-foreground"
                    : item.state === "done" ? "border-border text-foreground/70" : "border-dashed border-border/70 text-muted-foreground/70"}`}>
                {item.state === "done" ? <Check className="size-3" /> : <span className="tabular-nums">{index + 1}</span>}
                <span>{t(`drama.production.progress.stage.${item.key}`)}</span>
            </li>)}
        </ol>}
        {stage?.note ? <span data-production-progress-note className="max-w-[42ch] truncate" title={stage.note}>{t("drama.production.progress.note", { note: stage.note })}</span> : null}
        <span className="ml-auto flex items-center gap-3 whitespace-nowrap">
            {counts.total > 0 && <span data-production-progress-ready>{t("drama.production.progress.ready", { ready: counts.ready, total: counts.total })}</span>}
            {counts.blocked > 0 && <span data-production-progress-blocked className="text-amber-600 dark:text-amber-500">{t("drama.production.progress.blocked", { pending: counts.blocked })}</span>}
            {counts.review > 0 && <span>{t("drama.production.progress.review", { review: counts.review })}</span>}
            {busy && <span data-production-progress-busy className="flex items-center gap-1"><LoaderCircle className="size-3 animate-spin" />{t("drama.production.progress.busy")}</span>}
        </span>
    </div>;
}
