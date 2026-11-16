import { Input, InputNumber } from "antd";
import { Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { DramaTopic } from "@basketikun/canvas-agent/drama/production-contract";
import { TOPIC_OPTIONS, artStyleOptions, toggleThemes, toggleValue } from "./planning-topic-logic";
import { ChipAdder, PlanningChip, PlanningChipRow, PlanningField, PlanningSection } from "./planning-ui";

/**
 * 选题卡：chip 点选，不再让用户手打字段。
 * 数据仍落 productionPlan.topic，一按钮保存；这里不碰制作真值。
 */
export function TopicCard({ topic, onChange, onAskDirector, askDisabled }: { topic: DramaTopic; onChange: (topic: DramaTopic) => void; onAskDirector?: () => void; askDisabled?: boolean }) {
    const { t } = useTranslation();
    const set = (patch: Partial<DramaTopic>) => onChange({ ...topic, ...patch });

    const single = (values: readonly string[], selected: string, apply: (value: string) => void, group: string) =>
        values.map((value) => <PlanningChip key={value} group={group} active={selected === value} onClick={() => apply(selected === value ? "" : value)}>{value}</PlanningChip>);

    return <div className="max-w-3xl space-y-3 pt-1" data-planning-section="topic">
        <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
                <h2 className="text-[15px] font-semibold tracking-tight">{t("productionCanvas.writing.topicTitle")}</h2>
                <p className="mt-0.5 text-xs text-muted-foreground">{t("productionCanvas.writing.topicHintNew")}</p>
            </div>
            {onAskDirector ? <button type="button" disabled={askDisabled} onClick={onAskDirector} data-planning-ask="topic"
                className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-border px-3 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50">
                <Sparkles className="size-3.5" />{t("planningAsk.director")}
            </button> : null}
        </div>

        <PlanningSection title={t("topic.title")} hint={t("topic.titlePlaceholder")}>
            <Input.TextArea autoSize={{ minRows: 2, maxRows: 4 }} value={topic.logline} onChange={(event) => set({ logline: event.target.value })} placeholder={t("topic.titlePlaceholder")} />
        </PlanningSection>

        <PlanningSection title={t("topic.genres")} hint={t("topic.genresHint")}>
            <div className="flex flex-wrap gap-1.5">
                {TOPIC_OPTIONS.themes.map((value) => <PlanningChip key={value} group="themes" active={(topic.themes || []).includes(value)} onClick={() => set({ themes: toggleThemes(topic.themes || [], value) })}>{value}</PlanningChip>)}
                <ChipAdder placeholder={t("newDrama.addCustomTheme")} onAdd={(value) => set({ themes: toggleThemes(topic.themes || [], value) })} />
            </div>
        </PlanningSection>

        <PlanningSection title={t("topic.audience")} hint={t("topic.optionalHint")}>
            <PlanningChipRow label={t("topic.gender")}>{single(TOPIC_OPTIONS.gender, topic.gender, (value) => set({ gender: value }), "gender")}</PlanningChipRow>
            <PlanningChipRow label={t("topic.age")}>{single(TOPIC_OPTIONS.age, topic.age, (value) => set({ age: value }), "age")}</PlanningChipRow>
        </PlanningSection>

        <PlanningSection title={t("topic.tone")} hint={t("topic.optionalHint")}>
            <div className="flex flex-wrap gap-1.5">
                {TOPIC_OPTIONS.tones.map((value) => <PlanningChip key={value} group="tones" active={(topic.tones || []).includes(value)} onClick={() => set({ tones: toggleValue(topic.tones || [], value) })}>{value}</PlanningChip>)}
                <ChipAdder placeholder={t("newDrama.addCustomTone")} onAdd={(value) => set({ tones: toggleValue(topic.tones || [], value) })} />
            </div>
        </PlanningSection>

        <PlanningSection title={t("topic.episodes")} hint={t("topic.minutesHint")}>
            <PlanningChipRow label={t("topic.episodes")}>
                {TOPIC_OPTIONS.episodePresets.map((count) => <PlanningChip key={count} numeric group="episodes" active={topic.episodes === count} onClick={() => set({ episodes: topic.episodes === count ? 0 : count })}>{count}</PlanningChip>)}
                <InputNumber className="w-24" size="small" addonAfter={t("topic.unitEpisodes")} min={0} max={999} value={(TOPIC_OPTIONS.episodePresets as readonly number[]).includes(topic.episodes) ? undefined : topic.episodes || undefined} placeholder={t("topic.custom")} onChange={(value) => set({ episodes: Number(value) || 0 })} />
            </PlanningChipRow>
            <PlanningChipRow label={t("topic.minutes")}>
                <PlanningChip group="minutes" active={!topic.episodeMinutes} onClick={() => set({ episodeMinutes: 0 })}>{t("topic.modelDecides")}</PlanningChip>
                {TOPIC_OPTIONS.minutePresets.map((minutes) => <PlanningChip key={minutes} numeric group="minutes" active={topic.episodeMinutes === minutes} onClick={() => set({ episodeMinutes: minutes })}>{minutes}</PlanningChip>)}
                <InputNumber className="w-28" size="small" addonAfter={t("topic.unitMinutes")} min={0} max={180} value={(TOPIC_OPTIONS.minutePresets as readonly number[]).includes(topic.episodeMinutes) ? undefined : topic.episodeMinutes || undefined} placeholder={t("topic.custom")} onChange={(value) => set({ episodeMinutes: Number(value) || 0 })} />
            </PlanningChipRow>
        </PlanningSection>

        <PlanningSection title={t("topic.artStyle")} hint={t("topic.artStyleHint")}>
            <div className="flex flex-wrap gap-1.5">
                {artStyleOptions(topic.artStyle || "").map((value) => <PlanningChip key={value} group="artStyle" active={topic.artStyle === value} onClick={() => set({ artStyle: topic.artStyle === value ? "" : value })}>{value}</PlanningChip>)}
                <ChipAdder placeholder={t("newDrama.addCustomStyle")} onAdd={(value) => set({ artStyle: value })} />
            </div>
        </PlanningSection>

        <PlanningSection title={t("topic.ending")} hint={t("topic.optionalHint")}>
            <PlanningChipRow label={t("topic.ending")}>{single(TOPIC_OPTIONS.ending, topic.ending, (value) => set({ ending: value }), "ending")}</PlanningChipRow>
            <PlanningChipRow label={t("topic.language")}>{single(TOPIC_OPTIONS.language, topic.language, (value) => set({ language: value }), "language")}</PlanningChipRow>
        </PlanningSection>

        <details className="group rounded-xl border border-border/70 bg-muted/[0.12]">
            <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-2.5 marker:content-none">
                <span className="text-[13px] font-semibold">{t("topic.extra")}</span>
                <span className="text-[11px] text-foreground/50">{t("topic.extraHint")}</span>
            </summary>
            <div className="space-y-3 border-t border-border/60 px-4 py-3.5">
                <PlanningField label={t("topic.sellingPoint")}><Input.TextArea autoSize={{ minRows: 2, maxRows: 4 }} value={topic.sellingPoint} onChange={(event) => set({ sellingPoint: event.target.value })} /></PlanningField>
                <PlanningField label={t("topic.differentiation")}><Input.TextArea autoSize={{ minRows: 2, maxRows: 4 }} value={topic.differentiation} onChange={(event) => set({ differentiation: event.target.value })} /></PlanningField>
            </div>
        </details>

        <p className="pl-1 text-[11px] text-muted-foreground">{t("productionCanvas.writing.saveHint")}</p>
    </div>;
}
