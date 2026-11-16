import { App, Button, Input, Select, Tag } from "antd";
import { Check, ChevronDown, Loader2, Sparkles } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { requestDramaOutlineProposal } from "@/services/backend-api";
import { episodeLinesFromSource } from "@/lib/drama/adapt";
import { ModelPicker } from "@/components/model-picker";
import type { DramaProductionPlan } from "@basketikun/canvas-agent/drama/production-contract";
import {
    buildStepInstruction,
    firstPendingStep,
    outlineStepStates,
    OUTLINE_WIZARD_STEPS,
    stepLocked,
    type OutlineWizardStep,
} from "./planning-outline-steps";

export { OUTLINE_WIZARD_STEPS, firstPendingStep, outlineStepStates, parseActLines, parseEpisodeLines, proposalLines, stepLocked, buildStepInstruction } from "./planning-outline-steps";
export type { OutlineStepState, OutlineWizardStep } from "./planning-outline-steps";

/**
 * 按顺序引导生成大纲：一步一确认，前一步没落笔就不往下走。
 *
 * 顺序与「大纲」分区的六段一致（分集目录→角色→时空背景→故事线→三幕和节奏→结局与卡点），
 * 完成状态全部由已存字段推导，不额外维护进度表。
 * 生成只产生候选文本；点「写入」才落到 draft，随后由剧目规划的保存按钮统一入库。
 */
export function OutlineWizard({ dramaId, plan, outline, episodeCount, registryCharacters, model, config, onModelChange, onApply, onAskDirector, askDisabled }: {
    dramaId: string;
    plan: DramaProductionPlan;
    outline: string;
    episodeCount: number;
    registryCharacters: number;
    model: string;
    config: Parameters<typeof ModelPicker>[0]["config"];
    onModelChange: (model: string) => void;
    onApply: (step: OutlineWizardStep, text: string) => Promise<void> | void;
    onAskDirector?: () => void;
    askDisabled?: boolean;
}) {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const states = outlineStepStates({ plan, outline, episodeCount, registryCharacters });
    const current = firstPendingStep(states);
    // 这块是「按顺序生成大纲」的工具，不是大纲页的常驻内容：
    // 还有没写的步骤时默认展开；六步都写完（或正在生成）时收起，点标题可再展开。
    const [manualOpen, setManualOpen] = useState<boolean | null>(null);
    const expanded = manualOpen ?? Boolean(current);
    const [openStep, setOpenStep] = useState<OutlineWizardStep | null>(current);
    const [mode, setMode] = useState<"rewrite" | "fill">("fill");
    const [depth, setDepth] = useState<"brief" | "standard" | "detailed">("standard");
    const [extra, setExtra] = useState("");
    const [busy, setBusy] = useState<OutlineWizardStep | null>(null);
    const [proposal, setProposal] = useState<{ step: OutlineWizardStep; text: string } | null>(null);
    const [applying, setApplying] = useState(false);
    // 既没原剧本也没大纲时，模型只能编「待补」；先让人补输入，别产出废稿。
    const hasSource = Boolean(String(plan.sourceScript || "").trim() || String(outline || "").trim());

    const generate = async (step: OutlineWizardStep) => {
        setBusy(step);
        setProposal(null);
        try {
            const result = await requestDramaOutlineProposal(dramaId, { step, model: model || undefined, instruction: buildStepInstruction(mode, depth, extra) });
            setProposal({ step, text: String(result.text || "") });
        } catch (error) {
            message.error(error instanceof Error ? error.message : String(error));
        } finally {
            setBusy(null);
        }
    };
    const apply = async () => {
        if (!proposal) return;
        setApplying(true);
        try {
            await onApply(proposal.step, proposal.text);
            const next = OUTLINE_WIZARD_STEPS[OUTLINE_WIZARD_STEPS.indexOf(proposal.step) + 1] ?? null;
            setProposal(null);
            setOpenStep(next);
            message.success(t("outlineWizard.applied"));
        } catch (error) {
            message.error(error instanceof Error ? error.message : String(error));
        } finally {
            setApplying(false);
        }
    };

    return <section className="overflow-hidden rounded-xl border border-border/70 bg-muted/[0.12]" data-outline-wizard data-collapsed={expanded ? "false" : "true"}>
        <header className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border/60 bg-muted/[0.18] px-4 py-2">
            <button type="button" className="flex min-w-0 items-center gap-2 rounded-md px-1 py-0.5 text-left hover:bg-muted/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary" onClick={() => setManualOpen(!expanded)} aria-expanded={expanded} data-outline-wizard-toggle>
                <Sparkles className="size-3.5 shrink-0 text-primary" />
                <h3 className="text-[13px] font-semibold tracking-tight">{t("outlineWizard.title")}</h3>
                <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] ${current ? "bg-primary/15 text-primary" : "bg-emerald-500/10 text-emerald-400"}`}>
                    {current ? t("outlineWizard.current", { step: t(`outlineWizard.step.${current}`) }) : t("outlineWizard.allDone")}
                </span>
                <ChevronDown className={`size-3.5 shrink-0 text-muted-foreground transition-transform ${expanded ? "rotate-180" : ""}`} />
            </button>
            <span className="min-w-0 flex-1" />
            <span className="hidden text-[11px] text-muted-foreground sm:inline">{t("outlineWizard.model")}</span>
            <ModelPicker config={config} capability="text" className="w-52" value={model} onChange={onModelChange} placeholder={t("outlineWizard.modelDefault")} />
            {onAskDirector ? <Button size="small" disabled={askDisabled} onClick={onAskDirector} data-planning-ask="outline">{t("planningAsk.director")}</Button> : null}
        </header>
        {expanded ? <div className="px-4 py-3">
        <p className="mb-2 text-[11px] text-muted-foreground">{t("outlineWizard.orderHint")}</p>
        <ol className="space-y-2">
            {states.map((state, index) => {
                const locked = stepLocked(states, state.key);
                const open = openStep === state.key && !locked;
                return <li key={state.key} className={`overflow-hidden rounded-lg border transition-colors ${open ? "border-primary/40 bg-muted/[0.14]" : locked ? "border-border/50 bg-transparent" : "border-border/70 bg-muted/[0.06] hover:bg-muted/[0.12]"}`}
                    data-outline-wizard-step={state.key} data-state={state.done ? "done" : locked ? "locked" : "current"}>
                    <button type="button" disabled={locked} className="flex w-full min-w-0 items-center gap-2.5 px-2.5 py-2 text-left text-xs disabled:cursor-not-allowed disabled:opacity-45 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary" onClick={() => setOpenStep(open ? null : state.key)}>
                        <span className={`grid size-5 shrink-0 place-items-center rounded-full border text-[10px] tabular-nums ${state.done ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-400" : locked ? "border-border text-muted-foreground" : "border-primary/60 bg-primary/10 text-primary"}`}>
                            {state.done ? <Check className="size-3" /> : index + 1}
                        </span>
                        <span className={`min-w-0 flex-1 truncate ${state.done ? "text-muted-foreground" : "font-medium text-foreground"}`}>{t(state.labelKey)}</span>
                        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] ${state.done ? "bg-emerald-500/10 text-emerald-400" : locked ? "text-muted-foreground/70" : "bg-primary/15 text-primary"}`}>{state.done ? t("outlineWizard.done") : locked ? t("outlineWizard.locked") : t("outlineWizard.todo")}</span>
                    </button>
                    {open ? <div className="space-y-2.5 border-t border-border/60 px-3 py-3" data-outline-wizard-panel>
                        <p className="text-xs text-muted-foreground">{t(`outlineWizard.goal.${state.key}`)}</p>
                        {hasSource ? null : <p className="text-xs text-amber-600 dark:text-amber-500" data-outline-wizard-no-source>{t("outlineWizard.needSource")}</p>}
                        <div className="flex flex-wrap items-center gap-2">
                            <Select className="w-40" value={mode} onChange={setMode} options={[
                                { value: "fill", label: t("outlineWizard.modeFill") },
                                { value: "rewrite", label: t("outlineWizard.modeRewrite") },
                            ]} />
                            <Select className="w-36" value={depth} onChange={setDepth} options={[
                                { value: "brief", label: t("outlineWizard.depthBrief") },
                                { value: "standard", label: t("outlineWizard.depthStandard") },
                                { value: "detailed", label: t("outlineWizard.depthDetailed") },
                            ]} />
                            <Input className="min-w-40 flex-1" placeholder={t("outlineWizard.extraPlaceholder")} value={extra} onChange={(event) => setExtra(event.target.value)} />
                            <Button type="primary" disabled={!hasSource} loading={busy === state.key} icon={busy === state.key ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />} onClick={() => void generate(state.key)}>{t("outlineWizard.start")}</Button>
                            {state.key === "episodes" && plan.sourceScript?.trim() ? <Button data-outline-wizard-local-split onClick={() => setProposal({ step: "episodes", text: episodeLinesFromSource(plan.sourceScript).join("\n") })}>{t("outlineWizard.splitLocal")}</Button> : null}
                        </div>
                        {proposal?.step === state.key ? <div className="space-y-2 rounded-lg border border-border/60 bg-background/30 p-2.5" data-outline-wizard-proposal>
                            <Input.TextArea rows={8} value={proposal.text} onChange={(event) => setProposal({ step: state.key, text: event.target.value })} />
                            <div className="flex items-center gap-2">
                                <Button type="primary" loading={applying} onClick={() => void apply()}>{t("outlineWizard.apply")}</Button>
                                <Button onClick={() => setProposal(null)}>{t("outlineWizard.discard")}</Button>
                                <span className="text-[11px] text-muted-foreground">{t("outlineWizard.applyHint")}</span>
                            </div>
                        </div> : null}
                    </div> : null}
                </li>;
            })}
        </ol>
        <p className="mt-3 text-[11px] text-muted-foreground">{t("productionCanvas.writing.saveHint")}</p>
        </div> : null}
    </section>;
}
