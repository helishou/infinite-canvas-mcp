import { Button } from "antd";
import { Check, ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { PLANNING_STEPS, type PlanningStepKey, type PlanningStepState } from "./planning-topic-logic";

/**
 * 剧目级步骤条：选题 → 大纲 → 剧本 → 资产 → 分镜 → 导演包。
 * 前四个的完成度由剧目级字段派生；分镜与导演包在分集制作里，只当入口，不假装完成。
 */
export function PlanningStepBar({ states, next, onOpen }: {
    states: PlanningStepState[];
    next: PlanningStepKey | null;
    onOpen: (key: PlanningStepKey) => void;
}) {
    const { t } = useTranslation();
    const ordered = PLANNING_STEPS.map((key) => states.find((state) => state.key === key)).filter((state): state is PlanningStepState => Boolean(state));
    const doneCount = ordered.filter((state) => state.done).length;
    return <nav aria-label={t("planningSteps.label")} className="flex flex-wrap items-center gap-1.5 rounded-xl border border-border/70 bg-muted/[0.12] px-2.5 py-2" data-planning-steps>
        <span className="mr-1 shrink-0 rounded-full bg-muted/60 px-2 py-0.5 text-[10px] tabular-nums text-muted-foreground">{doneCount}/{ordered.length}</span>
        {ordered.map((state, index) => <div key={state.key} className="flex min-w-0 items-center gap-2">
            {index > 0 ? <ChevronRight className="size-3 shrink-0 text-muted-foreground/35" /> : null}
            <button type="button" data-planning-step={state.key} data-state={state.done ? "done" : state.key === next ? "current" : "todo"}
                onClick={() => onOpen(state.key)}
                className={`flex min-w-0 items-center gap-1.5 rounded-lg px-2 py-1 text-xs transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary ${state.done ? "text-muted-foreground hover:bg-muted/50 hover:text-foreground" : state.key === next ? "bg-primary/15 font-medium text-foreground ring-1 ring-inset ring-primary/35" : "text-muted-foreground/80 hover:bg-muted/50 hover:text-foreground"}`}>
                <span className={`grid size-4 shrink-0 place-items-center rounded-full border text-[10px] tabular-nums ${state.done ? "border-emerald-500/45 bg-emerald-500/10 text-emerald-400" : state.key === next ? "border-primary/60 bg-primary/10 text-primary" : "border-border"}`}>{state.done ? <Check className="size-2.5" /> : index + 1}</span>
                <span className="truncate">{t(state.labelKey)}</span>
            </button>
        </div>)}
        <span className="min-w-0 flex-1" />
        {next ? <Button size="small" type="primary" className="ml-1" onClick={() => onOpen(next)} data-planning-next>{t("planningSteps.next", { step: t(`planningSteps.${next}`) })}</Button> : null}
    </nav>;
}
