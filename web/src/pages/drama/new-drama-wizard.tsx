import { App, Button, Checkbox, Input, InputNumber, Radio, Switch } from "antd";
import { requestDramaTopicProposal } from "@/services/backend-api";
import { FileText, Plus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { DirectorReviewPolicy, DramaProductionPlan, DramaTopic } from "@basketikun/canvas-agent/drama/production-contract";
import { analyzeNovelChapters } from "@basketikun/canvas-agent/drama/novel-chapters";
import { MAX_CHAPTERS_PER_EPISODE, EPISODE_SOURCE_CHARS } from "@basketikun/canvas-agent/drama/chapter-episodes";
import { ModelPicker } from "@/components/model-picker";
import { chaptersFromAnalysis, estimateProductionTasks, formatSeconds, NOVEL_MAX_CHARS, NOVEL_MIN_CHARS, type AdaptChapterRow, type EpisodeGroupRow } from "@/lib/drama/adapt";
import { TOPIC_OPTIONS, toggleThemes, toggleValue } from "./planning-topic-logic";
import { PlanningChip, PlanningField } from "./planning-ui";

/**
 * 新建剧目向导：三页签走完「定位 → 素材 → 生成设置」。
 *
 * 选项表逐字照抄导演大师的 Topic.vue（`planning-topic-logic.ts` 的 TOPIC_OPTIONS），
 * 每个字段都带它在那边同样有的「自定义」入口（回车添加），不要自己删选项或改控件形态：
 * 画风 35 个、每集时长是「模型决定 + 1~10 + 自定义」、集数 1/10/30/60/80/100 + 数字框。
 */

export const NEW_DRAMA_STEPS = ["positioning", "material", "delivery"] as const;
export type NewDramaStep = typeof NEW_DRAMA_STEPS[number];

/** 章节列表一次最多画多少行；更长的书用全选/清空处理，避免几百个复选框拖慢弹层。 */
const CHAPTER_LIST_LIMIT = 200;

/** 审阅预设 → 共享审核与场次审核同档；mixed 不在新建向导里暴露。 */
function reviewPolicyFor(mode: string): DirectorReviewPolicy {
    if (mode === "automatic") return { mode: "automatic", shared: "automatic", scene: "automatic" };
    if (mode === "manual") return { mode: "manual", shared: "manual", scene: "manual" };
    return { mode: "none", shared: "none", scene: "none" };
}

/** 通用「chip 组 + 自定义回车添加」，对应导演大师每个字段右侧那条输入框。 */
function ChipPicker({ label, hint, options, active, multi, onPick, onCustom, customPlaceholder }: {
    label: string;
    hint?: string;
    options: readonly string[];
    active: string[];
    multi?: boolean;
    onPick: (value: string) => void;
    onCustom: (value: string) => void;
    customPlaceholder: string;
}) {
    const [draft, setDraft] = useState("");
    const commit = () => {
        const value = draft.trim();
        if (!value) return;
        onCustom(value);
        setDraft("");
    };
    // 已选但不在预设里的自定义值也要显示出来（否则选完看不见）
    const extras = active.filter((value) => !options.includes(value));
    return <PlanningField label={label} hint={hint}>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
            {options.map((option) => <PlanningChip key={option} active={active.includes(option)} onClick={() => onPick(option)}>{option}</PlanningChip>)}
            {extras.map((option) => <PlanningChip key={option} active onClick={() => onPick(option)}>{option}</PlanningChip>)}
            <Input size="small" className="w-40" allowClear value={draft} placeholder={customPlaceholder}
                onChange={(event) => setDraft(event.target.value)}
                onPressEnter={commit}
                suffix={<button type="button" aria-label={customPlaceholder} className="text-muted-foreground hover:text-foreground" onClick={commit}><Plus className="size-3.5" /></button>} />
            {multi ? null : null}
        </div>
    </PlanningField>;
}

export function NewDramaWizard({ step, name, onName, plan, onPlan, styleMode, onStyleMode, styleImageFile, onStyleImageFile, stylePrompt, onStylePrompt, autoEpisodes, onAutoEpisodes, handoff, onHandoff, config }: {
    step: number;
    name: string;
    onName: (value: string) => void;
    plan: DramaProductionPlan;
    onPlan: (patch: Partial<DramaProductionPlan> | ((current: DramaProductionPlan) => DramaProductionPlan)) => void;
    styleMode: "upload" | "prompt" | "none";
    onStyleMode: (mode: "upload" | "prompt" | "none") => void;
    styleImageFile: File | undefined;
    onStyleImageFile: (file: File | undefined) => void;
    stylePrompt: string;
    onStylePrompt: (value: string) => void;
    autoEpisodes: boolean;
    onAutoEpisodes: (value: boolean) => void;
    handoff: boolean;
    onHandoff: (value: boolean) => void;
    config: Parameters<typeof ModelPicker>[0]["config"];
}) {
    const { t } = useTranslation();
    const topic: DramaTopic = plan.topic || ({} as DramaTopic);
    // 函数式更新：连点 chip 不会拿旧 plan 覆盖回去。
    const setTopic = (patch: Partial<DramaTopic> | ((current: DramaTopic) => Partial<DramaTopic>)) =>
        onPlan((current) => ({ ...current, topic: { ...(current.topic || {}), ...(typeof patch === "function" ? patch(current.topic || ({} as DramaTopic)) : patch) } }));
    const themes = topic.themes || [];
    const tones = topic.tones || [];
    const { message } = App.useApp();
    const [extracting, setExtracting] = useState(false);
    const [extracted, setExtracted] = useState("");
    // 粘贴剧本 → 一次模型调用归纳选题；只回填候选值，用户还能改。
    const extractFromSource = async () => {
        const source = String(plan.sourceScript || "").trim();
        if (source.replace(/\s/g, "").length < 100) {
            message.warning(t("newDrama.needSource"));
            return;
        }
        setExtracting(true);
        try {
            const result = await requestDramaTopicProposal({ source });
            const proposal = result.topic;
            // 剧名还是占位默认值时，用模型归纳的剧名替换（用户手写过的就不动）
            const currentName = String(name || "").trim();
            if (proposal.title && (!currentName || currentName === t("drama.defaultProjectName"))) onName(proposal.title);
            onPlan((current) => ({ ...current, topic: {
                ...current.topic,
                themes: proposal.themes.length ? proposal.themes : current.topic?.themes || [],
                tones: proposal.tones.length ? proposal.tones : current.topic?.tones || [],
                gender: proposal.gender || current.topic?.gender || "",
                age: proposal.age || current.topic?.age || "",
                ending: proposal.ending || current.topic?.ending || "",
                language: proposal.language || current.topic?.language || "",
                artStyle: proposal.artStyle || current.topic?.artStyle || "",
                episodes: proposal.episodes || current.topic?.episodes || 0,
                episodeMinutes: proposal.episodeMinutes || current.topic?.episodeMinutes || 0,
                logline: proposal.logline || current.topic?.logline || "",
            } }));
            setExtracted([proposal.themes.join("、"), proposal.tones.join("、"), proposal.ending, proposal.artStyle, proposal.episodes ? `${proposal.episodes} 集` : ""].filter(Boolean).join(" · "));
            message.success(t("newDrama.extractDone"));
        } catch (error) {
            message.error(`${t("newDrama.extractFailed")}：${error instanceof Error ? error.message : String(error)}`);
        } finally {
            setExtracting(false);
        }
    };
    const scriptLength = (plan.sourceScript || "").replace(/\s/g, "").length;
    const split = plan.sourceSplit ?? { excluded: [], perEpisode: 1, maxChars: 0 };
    // 拆章只在原文变化时算一次；勾选与每集章数是廉价派生，不重复切书。
    const analysis = useMemo(
        () => (plan.sourceScript || "").trim() ? analyzeNovelChapters(plan.sourceScript, { maxChars: split.maxChars || NOVEL_MAX_CHARS, minChars: NOVEL_MIN_CHARS }) : null,
        [plan.sourceScript, split.maxChars],
    );
    const excludedKey = split.excluded.join(",");
    const { rows: chapterRows, groups } = useMemo<{ rows: AdaptChapterRow[]; groups: EpisodeGroupRow[] }>(
        () => chaptersFromAnalysis(analysis, { excluded: split.excluded, perEpisode: split.perEpisode }),
        [analysis, excludedKey, split.perEpisode], // eslint-disable-line react-hooks/exhaustive-deps
    );
    const estimate = useMemo(() => estimateProductionTasks(groups), [groups]);
    const selectedChapters = chapterRows.filter(row => row.selected).length;
    const blockedGroups = groups.filter(group => group.oversized);
    const reservedChapters = chapterRows.length - selectedChapters;
    const patchSplit = (patch: Partial<{ excluded: number[]; perEpisode: number; maxChars: number }>) =>
        onPlan(current => ({ ...current, sourceSplit: { ...(current.sourceSplit ?? { excluded: [], perEpisode: 1, maxChars: 0 }), ...patch } }));
    const setChapterSelected = (index: number, selected: boolean) => {
        const excluded = new Set(split.excluded);
        if (selected) excluded.delete(index);
        else excluded.add(index);
        patchSplit({ excluded: [...excluded].sort((left, right) => left - right) });
    };
    const selectAllChapters = (selected: boolean) => patchSplit({ excluded: selected ? [] : chapterRows.map(row => row.index) });

    if (step === 0) {
        return <div className="grid gap-6" data-new-drama-step="positioning">
            <section className="grid gap-2 rounded-xl border border-primary/25 bg-primary/[0.04] p-4" data-new-drama-autofill>
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-[13px] font-medium">{t("newDrama.autoFillTitle")}</span>
                    <span className="flex items-center gap-2 text-[11px] text-muted-foreground">
                        <span data-new-drama-source-count>{t("newDrama.sourceCount", { count: scriptLength })}</span>
                        <Button size="small" type="primary" loading={extracting} onClick={extractFromSource} data-new-drama-autofill-action>{t("newDrama.autoFillAction")}</Button>
                    </span>
                </div>
                <Input.TextArea rows={5} value={plan.sourceScript || ""} placeholder={t("newDrama.autoFillPlaceholder")}
                    onChange={(event) => onPlan({ sourceScript: event.target.value })} data-new-drama-source />
                <span className="text-[11px] text-muted-foreground">{extracted ? t("newDrama.extractApplied", { value: extracted }) : t("newDrama.autoFillHint")}</span>
            </section>

            <section className="grid gap-4">
                <PlanningField label={`${t("newDrama.name")} *`} hint={t("newDrama.nameHint")}>
                    <Input autoFocus value={name} onChange={(event) => onName(event.target.value)} placeholder={t("drama.createProjectPrompt")} />
                </PlanningField>
                <PlanningField label={t("topic.logline")} hint={t("newDrama.loglineHint")}>
                    <Input.TextArea autoSize={{ minRows: 2, maxRows: 4 }} value={topic.logline || ""} onChange={(event) => setTopic({ logline: event.target.value })} placeholder={t("newDrama.loglinePlaceholder")} />
                </PlanningField>
            </section>

            <section className="grid gap-3 border-t border-border/70 pt-5">
                <ChipPicker label={t("topic.themes")} options={TOPIC_OPTIONS.themes} multi
                    hint={themes.length >= 2 ? t("newDrama.themesFull") : t("newDrama.selected", { count: themes.length, max: 2 })}
                    active={themes} customPlaceholder={t("newDrama.addCustomTheme")}
                    onPick={(theme) => setTopic((current) => ({ themes: toggleThemes(current.themes || [], theme) }))}
                    onCustom={(theme) => setTopic((current) => ({ themes: toggleThemes(current.themes || [], theme) }))} />
                <ChipPicker label={t("topic.tone")} options={TOPIC_OPTIONS.tones} multi
                    hint={t("newDrama.selected", { count: tones.length, max: TOPIC_OPTIONS.tones.length })}
                    active={tones} customPlaceholder={t("newDrama.addCustomTone")}
                    onPick={(tone) => setTopic((current) => ({ tones: toggleValue(current.tones || [], tone) }))}
                    onCustom={(tone) => setTopic((current) => ({ tones: toggleValue(current.tones || [], tone) }))} />
                <div className="grid gap-3 sm:grid-cols-2">
                    <ChipPicker label={t("topic.gender")} options={TOPIC_OPTIONS.gender} active={topic.gender ? [topic.gender] : []}
                        customPlaceholder={t("newDrama.addCustomAudience")}
                        onPick={(gender) => setTopic({ gender })} onCustom={(gender) => setTopic({ gender })} />
                    <ChipPicker label={t("topic.age")} options={TOPIC_OPTIONS.age} active={topic.age ? [topic.age] : []}
                        customPlaceholder={t("newDrama.addCustomAudience")}
                        onPick={(age) => setTopic({ age })} onCustom={(age) => setTopic({ age })} />
                </div>
            </section>

            <section className="grid gap-3 border-t border-border/70 pt-5">
                <div className="grid gap-3 sm:grid-cols-2">
                    <PlanningField label={t("topic.episodes")} hint={t("newDrama.episodesHint")}>
                        <div className="flex flex-wrap items-center gap-2">
                            {TOPIC_OPTIONS.episodePresets.map((count) => <PlanningChip key={count} numeric active={topic.episodes === count} onClick={() => setTopic({ episodes: count })}>{count}</PlanningChip>)}
                            <InputNumber className="w-24" size="small" addonAfter={t("topic.unitEpisodes")} min={1} max={200} placeholder={t("topic.custom")}
                                value={(TOPIC_OPTIONS.episodePresets as readonly number[]).includes(topic.episodes) ? undefined : topic.episodes || undefined}
                                onChange={(value) => setTopic({ episodes: Math.min(200, Math.max(1, Number(value) || 0)) })} />
                        </div>
                    </PlanningField>
                    <PlanningField label={t("topic.minutes")} hint={t("topic.minutesHint")}>
                        <div className="flex flex-wrap items-center gap-2">
                            <PlanningChip active={!topic.episodeMinutes} onClick={() => setTopic({ episodeMinutes: 0 })}>{t("topic.modelDecides")}</PlanningChip>
                            {TOPIC_OPTIONS.minutePresets.map((minutes) => <PlanningChip key={minutes} numeric active={topic.episodeMinutes === minutes} onClick={() => setTopic({ episodeMinutes: minutes })}>{minutes}</PlanningChip>)}
                            <InputNumber className="w-32" size="small" addonAfter={t("topic.unitMinutes")} min={1} max={180} placeholder={t("topic.custom")}
                                value={(TOPIC_OPTIONS.minutePresets as readonly number[]).includes(topic.episodeMinutes) ? undefined : topic.episodeMinutes || undefined}
                                onChange={(value) => setTopic({ episodeMinutes: Number(value) || 0 })} />
                        </div>
                    </PlanningField>
                </div>
            </section>
        </div>;
    }

    if (step === 1) {
        return <div className="grid gap-6" data-new-drama-step="material">
            <section className="grid gap-2">
                <div className="flex flex-wrap items-center justify-between gap-3">
                    <span className="text-[13px] font-medium">{t("newDrama.source")}</span>
                    <span className="flex items-center gap-2 text-[11px] text-muted-foreground">
                        <span data-new-drama-source-brief>{t("newDrama.sourceCount", { count: scriptLength })}</span>
                        <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-border px-2 py-1 hover:border-primary/40">
                            <FileText className="size-3.5" />
                            {t("newDrama.uploadScript")}
                            <input type="file" accept=".txt,.md,text/plain" className="hidden" onChange={async (event) => {
                                const file = event.target.files?.[0];
                                if (file) onPlan({ sourceScript: await file.text() });
                            }} />
                        </label>
                    </span>
                </div>
                <p className="rounded-lg border border-border/70 bg-card/40 px-3 py-2 text-[12px] text-muted-foreground">{scriptLength ? t("newDrama.sourceBrief", { count: scriptLength, head: (plan.sourceScript || "").trim().slice(0, 40) }) : t("newDrama.sourceEmpty")}</p>
                <span className="text-[11px] text-muted-foreground">{t("newDrama.sourceHint")}</span>
            </section>

            {analysis && chapterRows.length ? (
                <section className="grid gap-3 border-t border-border/70 pt-5" data-new-drama-split>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-[13px] font-medium">{t("newDrama.split.title")}</span>
                        <span className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                            <span data-new-drama-split-count>{t("newDrama.split.count", { total: chapterRows.length, selected: selectedChapters })}</span>
                            <Button size="small" type="text" onClick={() => selectAllChapters(true)}>{t("newDrama.split.all")}</Button>
                            <Button size="small" type="text" onClick={() => selectAllChapters(false)}>{t("newDrama.split.none")}</Button>
                        </span>
                    </div>
                    <PlanningField label={t("newDrama.split.perEpisode")} hint={t("newDrama.split.perEpisodeHint")}>
                        <div className="flex flex-wrap items-center gap-2">
                            {[1, 2, 3, 4, 5, 8].map((count) => (
                                <PlanningChip key={count} numeric active={split.perEpisode === count} onClick={() => patchSplit({ perEpisode: count })}>{count}</PlanningChip>
                            ))}
                            <InputNumber className="w-24" size="small" min={1} max={MAX_CHAPTERS_PER_EPISODE} placeholder={t("topic.custom")}
                                aria-label={t("newDrama.split.perEpisode")}
                                value={[1, 2, 3, 4, 5, 8].includes(split.perEpisode) ? undefined : split.perEpisode}
                                onChange={(value) => patchSplit({ perEpisode: Math.min(MAX_CHAPTERS_PER_EPISODE, Math.max(1, Number(value) || 1)) })} />
                        </div>
                    </PlanningField>
                    <div className="max-h-56 overflow-auto rounded-lg border border-border/70 thin-scrollbar" data-new-drama-chapters>
                        {chapterRows.slice(0, CHAPTER_LIST_LIMIT).map((row) => (
                            <label key={`${row.index}-${row.title}`} className={`flex cursor-pointer items-center gap-2 border-b border-border/50 px-3 py-1.5 text-[12px] last:border-b-0 ${row.selected ? "" : "opacity-50"}`}>
                                <Checkbox checked={row.selected} onChange={(event) => setChapterSelected(row.index, event.target.checked)} />
                                <span className="min-w-0 flex-1 truncate" title={row.title}>{row.title}</span>
                                <span className={row.body.length > EPISODE_SOURCE_CHARS ? "shrink-0 text-amber-600 dark:text-amber-500" : "shrink-0 text-muted-foreground"}>
                                    {t("newDrama.split.chapterChars", { count: row.body.length })}
                                </span>
                            </label>
                        ))}
                    </div>
                    {chapterRows.length > CHAPTER_LIST_LIMIT ? (
                        <span className="text-[11px] text-muted-foreground">{t("newDrama.split.truncated", { count: chapterRows.length - CHAPTER_LIST_LIMIT })}</span>
                    ) : null}
                    {blockedGroups.length ? (
                        <p className="text-[11px] text-amber-600 dark:text-amber-500" data-new-drama-split-blocked>
                            {t("newDrama.split.oversize", { label: blockedGroups[0].label, chars: blockedGroups[0].chars, limit: EPISODE_SOURCE_CHARS })}
                        </p>
                    ) : null}
                    <div className="grid gap-1 rounded-lg border border-border/70 bg-card/40 px-3 py-2 text-[12px]" data-new-drama-estimate>
                        <span data-new-drama-will-build>{t("newDrama.split.willBuild", { count: groups.length })}</span>
                        <span className="text-muted-foreground">
                            {t("newDrama.split.estimate", {
                                episodes: estimate.episodes,
                                shots: estimate.shots,
                                segments: estimate.segments,
                                duration: formatSeconds(estimate.seconds),
                                images: estimate.storyboardImages,
                                videos: estimate.videoTasks,
                            })}
                        </span>
                        {reservedChapters ? <span className="text-muted-foreground">{t("newDrama.split.reserved", { count: reservedChapters })}</span> : null}
                        <span className="text-[11px] text-muted-foreground">{t("newDrama.split.estimateHint")}</span>
                    </div>
                </section>
            ) : null}

            <section className="grid gap-3 border-t border-border/70 pt-5">
                <ChipPicker label={t("topic.artStyle")} options={TOPIC_OPTIONS.artStyle}
                    hint={t("topic.artStyleHint")} active={topic.artStyle ? [topic.artStyle] : []}
                    customPlaceholder={t("newDrama.addCustomStyle")}
                    onPick={(artStyle) => setTopic({ artStyle })} onCustom={(artStyle) => setTopic({ artStyle })} />
                <div className="grid gap-3 sm:grid-cols-2">
                    <ChipPicker label={t("topic.ending")} options={TOPIC_OPTIONS.ending} active={topic.ending ? [topic.ending] : []}
                        customPlaceholder={t("newDrama.addCustomEnding")}
                        onPick={(ending) => setTopic({ ending })} onCustom={(ending) => setTopic({ ending })} />
                    <ChipPicker label={t("topic.language")} options={TOPIC_OPTIONS.language} active={topic.language ? [topic.language] : []}
                        customPlaceholder={t("newDrama.addCustomLang")}
                        onPick={(language) => setTopic({ language })} onCustom={(language) => setTopic({ language })} />
                </div>
            </section>

            <section className="grid gap-3 border-t border-border/70 pt-5">
                <PlanningField label={t("drama.createStyleReference")} hint={t("drama.createStyleReferenceHint")}>
                    <div className="space-y-2">
                        <Radio.Group value={styleMode} onChange={(event) => onStyleMode(event.target.value as "upload" | "prompt" | "none")}
                            options={[{ value: "upload", label: t("drama.uploadStyleReference") }, { value: "prompt", label: t("drama.generateStyleReference") }, { value: "none", label: t("drama.skipStyleReference") }]} />
                        {styleMode === "upload" && <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-dashed border-border px-3 py-3 text-[12px] text-muted-foreground hover:border-primary/40">
                            <FileText className="size-4" />
                            {styleImageFile ? styleImageFile.name : t("newDrama.pickStyleImage")}
                            <input type="file" accept="image/*" className="hidden" onChange={(event) => onStyleImageFile(event.target.files?.[0])} />
                        </label>}
                        {styleMode === "prompt" && <Input.TextArea rows={3} value={stylePrompt} onChange={(event) => onStylePrompt(event.target.value)} placeholder={t("drama.styleReferencePrompt")} />}
                    </div>
                </PlanningField>
            </section>
        </div>;
    }

    return <div className="grid gap-5" data-new-drama-step="delivery">
        <section className="grid gap-2.5 rounded-xl border border-border/80 bg-card/50 p-4" data-new-drama-summary>
            <span className="text-[11px] font-medium tracking-wide text-muted-foreground">{t("newDrama.summary")}</span>
            <div className="grid gap-2 text-[13px] sm:grid-cols-2">
                <SummaryRow label={t("newDrama.summaryName")} value={name || t("newDrama.unnamed")} />
                <SummaryRow label={t("newDrama.summaryThemes")} value={themes.join("、") || "—"} />
                <SummaryRow label={t("newDrama.summaryTones")} value={tones.join("、") || "—"} />
                <SummaryRow label={t("newDrama.summaryAudience")} value={[topic.gender, topic.age].filter(Boolean).join(" · ") || "—"} />
                <SummaryRow label={t("newDrama.summaryEpisodes")} value={topic.episodes ? `${topic.episodes} 集 × ${topic.episodeMinutes || t("topic.modelDecides")}` : "—"} />
                <SummaryRow label={t("newDrama.summarySplit")} value={groups.length ? t("newDrama.split.willBuild", { count: groups.length }) : "—"} />
                <SummaryRow label={t("newDrama.summaryScript")} value={t("newDrama.sourceCount", { count: scriptLength })} />
                <SummaryRow label={t("newDrama.summaryStyle")} value={`${topic.artStyle || "—"} · ${styleMode === "upload" ? t("newDrama.anchorUpload") : styleMode === "prompt" ? t("newDrama.anchorPrompt") : t("newDrama.anchorNone")}`} />
            </div>
        </section>

        <section className="grid gap-3 border-t border-border/70 pt-5">
            <div><h3 className="text-sm font-medium">{t("newDrama.stepsModels")}</h3><p className="mt-1 text-xs text-muted-foreground">{t("newDrama.stepsModelsHint")}</p></div>
            <PlanningField label={t("newDrama.textModel")} hint={t("newDrama.textModelHint")}>
                <ModelPicker config={config} capability="text" fullWidth value={plan.outlineModel || undefined} onChange={(outlineModel) => onPlan({ outlineModel })} />
            </PlanningField>
            <PlanningField label={t("productionCanvas.generalImageModel")}>
                <ModelPicker config={config} capability="image" fullWidth value={plan.imageModel || undefined} onChange={(imageModel) => onPlan({ imageModel })} />
            </PlanningField>
            <div className="grid gap-3 sm:grid-cols-2">
                {(["character", "scene", "prop", "keyframe"] as const).map((kind) => (
                    <label key={kind} className="grid gap-1 text-[12px]">
                        <span className="text-muted-foreground">{t(`newDrama.modelKind.${kind}`)}</span>
                        <ModelPicker config={config} capability="image" fullWidth
                            value={plan.imageModelsByKind?.[kind] || undefined}
                            onChange={(model) => onPlan(current => ({ ...current, imageModelsByKind: { ...(current.imageModelsByKind || {}), [kind]: model || undefined } }))} />
                    </label>
                ))}
            </div>
            <PlanningField label={t("newDrama.videoModel")} hint={t("newDrama.videoModelHint")}>
                <ModelPicker config={config} capability="video" fullWidth value={plan.h3Model || undefined} onChange={(h3Model) => onPlan({ h3Model })} />
            </PlanningField>
            <label className="flex items-start justify-between gap-3">
                <span className="text-[13px]">
                    {t("newDrama.storyboardImages")}
                    <span className="mt-0.5 block text-[11px] text-muted-foreground">{t("newDrama.storyboardImagesHint")}</span>
                </span>
                <Switch size="small" checked={plan.storyboardImageMode !== "skip"}
                    onChange={(on) => onPlan(current => ({ ...current, storyboardImageMode: on ? "generate" : "skip" }))} />
            </label>
        </section>

        <section className="grid gap-3 border-t border-border/70 pt-5">
            <div><h3 className="text-sm font-medium">{t("newDrama.pacing.title")}</h3><p className="mt-1 text-xs text-muted-foreground">{t("newDrama.pacing.subtitle")}</p></div>
            <PlanningField label={t("newDrama.pacing.mode")} hint={t("newDrama.pacing.modeHint")}>
                <Radio.Group value={plan.mediaProductionMode === "automatic" ? "automatic" : plan.mediaProductionMode === "prompt_only" ? "prompt_only" : "per_item"} onChange={(event) => onPlan({ mediaProductionMode: event.target.value })}
                    options={[
                        { value: "prompt_only", label: t("newDrama.pacing.promptOnly") },
                        { value: "per_item", label: t("newDrama.pacing.perItem") },
                        { value: "automatic", label: t("newDrama.pacing.automatic") },
                    ]} />
            </PlanningField>
            <PlanningField label={t("newDrama.pacing.review")}>
                <Radio.Group value={plan.reviewPolicy?.mode || "none"} onChange={(event) => onPlan({ reviewPolicy: reviewPolicyFor(event.target.value) })}
                    options={[
                        { value: "none", label: t("newDrama.pacing.reviewNone") },
                        { value: "automatic", label: t("newDrama.pacing.reviewAuto") },
                        { value: "manual", label: t("newDrama.pacing.reviewManual") },
                    ]} />
            </PlanningField>
            <label className="flex items-start justify-between gap-3">
                <span className="text-[13px]">
                    {t("newDrama.pacing.parallel")}
                    <span className="mt-0.5 block text-[11px] text-muted-foreground">{t("newDrama.pacing.parallelHint")}</span>
                </span>
                <Switch size="small" checked={plan.parallelScenes !== false} onChange={(on) => onPlan({ parallelScenes: on })} />
            </label>
        </section>

        <section className="grid gap-3 border-t border-border/70 pt-5">
            <label className="flex items-start justify-between gap-3">
                <span className="text-[13px]">
                    {t("newDrama.autoEpisodes")}
                    <span className="mt-0.5 block text-[11px] text-muted-foreground">
                        {groups.length ? t("newDrama.autoEpisodesFromSource", { count: groups.length }) : topic.episodes ? t("newDrama.autoEpisodesHint", { count: topic.episodes }) : t("newDrama.autoEpisodesHintEmpty")}
                    </span>
                </span>
                <Switch size="small" checked={groups.length > 0 || autoEpisodes} disabled={!topic.episodes || groups.length > 0} onChange={onAutoEpisodes} />
            </label>
            <label className="flex items-start justify-between gap-3 border-t border-border/60 pt-3">
                <span className="text-[13px]">
                    {t("newDrama.handoff")}
                    <span className="mt-0.5 block text-[11px] text-muted-foreground">{t("newDrama.handoffHint")}</span>
                </span>
                <Switch size="small" checked={handoff} onChange={onHandoff} />
            </label>
        </section>
    </div>;
}

function SummaryRow({ label, value }: { label: string; value: string }) {
    return <span className="flex min-w-0 gap-2"><span className="shrink-0 text-muted-foreground">{label}</span><span className="min-w-0 truncate text-foreground/90">{value}</span></span>;
}

export function newDramaStepValid(step: number, { name, plan, styleMode, styleImageFile, stylePrompt }: {
    name: string;
    plan: DramaProductionPlan;
    styleMode: "upload" | "prompt" | "none";
    styleImageFile?: File;
    stylePrompt: string;
}): boolean {
    if (step === 0) return Boolean(name.trim());
    if (step === 1) return styleMode === "none" || (styleMode === "upload" ? Boolean(styleImageFile) : Boolean(stylePrompt.trim()));
    return true;
}

export function NewDramaFooter({ step, busy, valid, blockedHint, onPrev, onNext, onCreate, onCancel }: {
    step: number;
    busy: boolean;
    valid: boolean;
    blockedHint?: string;
    onPrev: () => void;
    onNext: () => void;
    onCreate: () => void;
    onCancel: () => void;
}) {
    const { t } = useTranslation();
    const last = step === NEW_DRAMA_STEPS.length - 1;
    return <div className="sticky bottom-0 -mx-6 -mb-6 mt-5 flex flex-wrap items-center justify-between gap-2 border-t border-border bg-card/95 px-6 py-3 backdrop-blur">
        <span className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
            <span data-new-drama-progress>{t("newDrama.stepProgress", { current: step + 1, total: NEW_DRAMA_STEPS.length })}</span>
            {!valid && blockedHint ? <span className="text-amber-500" data-new-drama-blocked>{blockedHint}</span> : null}
        </span>
        <span className="flex items-center gap-2">
            <Button onClick={onCancel} disabled={busy}>{t("common.cancel")}</Button>
            {step > 0 && <Button onClick={onPrev} disabled={busy}>{t("newDrama.prev")}</Button>}
            {last
                ? <Button type="primary" loading={busy} disabled={!valid} onClick={onCreate} data-new-drama-create>{t("drama.createProject")}</Button>
                : <Button type="primary" disabled={!valid} onClick={onNext} data-new-drama-next>{t("newDrama.next")}</Button>}
        </span>
    </div>;
}
