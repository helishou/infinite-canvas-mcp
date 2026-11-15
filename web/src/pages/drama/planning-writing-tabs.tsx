import { Input } from "antd";
import { useTranslation } from "react-i18next";
import type { DramaEpisode } from "@/services/backend-api";
import type { DramaOutlineDetail } from "@basketikun/canvas-agent/drama/production-contract";
import { PlanningEmpty, PlanningField, PlanningSection } from "./planning-ui";

/**
 * 剧目级写作分区：原剧本、大纲。
 *
 * 都只是策划内容，保存进 folder.productionPlan，不参与任何制作真值：
 * - 原剧本（sourceScript）是原文备份与改编输入；
 * - 大纲（outlineDetail）只补故事线以外的几段：故事线就是 folder.outline 本身，不再存第二份。
 */

export function SourceScriptTab({ value, onChange }: { value: string; onChange: (value: string) => void }) {
    const { t } = useTranslation();
    return <div className="max-w-4xl space-y-3 pt-1" data-planning-section="source">
        <PlanningSection
            title={t("productionCanvas.writing.sourceScript")}
            hint={t("productionCanvas.writing.sourceScriptHint", { count: value.length })}
        >
            <Input.TextArea
                aria-label={t("productionCanvas.writing.sourceScript")}
                className="font-mono text-xs leading-relaxed"
                autoSize={{ minRows: 16, maxRows: 40 }}
                value={value}
                placeholder={t("productionCanvas.writing.sourceScriptPlaceholder")}
                onChange={(event) => onChange(event.target.value)}
            />
        </PlanningSection>
        <p className="pl-1 text-[11px] text-muted-foreground">{t("productionCanvas.writing.saveHint")}</p>
    </div>;
}

export function OutlineTab({ outline, detail, characters, episodes, onOutline, onDetail }: {
    outline: string;
    detail: DramaOutlineDetail;
    characters: string[];
    episodes: DramaEpisode[];
    onOutline: (value: string) => void;
    onDetail: (detail: DramaOutlineDetail) => void;
}) {
    const { t } = useTranslation();
    const acts = detail.threeActs.length >= 3 ? detail.threeActs : [...detail.threeActs, "", "", ""].slice(0, 3);
    const setAct = (index: number, value: string) => {
        const next = [...acts];
        next[index] = value;
        onDetail({ ...detail, threeActs: next });
    };
    return <div className="max-w-4xl space-y-3 pt-1" data-planning-section="outline">
        <PlanningSection title={t("productionCanvas.writing.outline.storyline")} hint={t("productionCanvas.writing.outline.storylineHint")} part="storyline">
            <Input.TextArea autoSize={{ minRows: 6, maxRows: 20 }} value={outline} onChange={(event) => onOutline(event.target.value)} />
        </PlanningSection>

        <PlanningSection title={t("productionCanvas.writing.outline.episodes")} hint={t("productionCanvas.writing.outline.episodesHint")} part="episodes">
            {episodes.length ? <ol className="grid gap-1.5 sm:grid-cols-2" data-outline-episodes>
                {episodes.map((episode) => <li key={episode.id} className="flex min-w-0 items-baseline gap-2 rounded-lg bg-background/40 px-2.5 py-1.5">
                    <span className="shrink-0 rounded bg-muted/70 px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground">{t("productionCanvas.writing.outline.episodeNumber", { number: episode.episodeNumber })}</span>
                    <span className="shrink-0 max-w-[45%] truncate text-xs font-medium text-foreground">{episode.title || t("productionCanvas.writing.outline.untitled")}</span>
                    {episode.synopsis ? <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">{episode.synopsis}</span> : null}
                </li>)}
            </ol> : <PlanningEmpty text={t("productionCanvas.writing.outline.episodesEmpty")} />}
        </PlanningSection>

        <PlanningSection title={t("productionCanvas.writing.outline.characters")} hint={t("productionCanvas.writing.outline.charactersHint")} part="characters">
            {characters.length ? <div className="flex flex-wrap gap-1.5">{characters.map((name) => <span key={name} className="rounded-full bg-muted/70 px-2.5 py-1 text-[11px] text-foreground">{name}</span>)}</div>
                : <PlanningEmpty text={t("productionCanvas.writing.outline.charactersEmpty")} />}
        </PlanningSection>

        <PlanningSection title={t("productionCanvas.writing.outline.worldContext")} part="world">
            <Input.TextArea autoSize={{ minRows: 4, maxRows: 12 }} value={detail.worldContext} onChange={(event) => onDetail({ ...detail, worldContext: event.target.value })} />
        </PlanningSection>

        <PlanningSection title={t("productionCanvas.writing.outline.threeActs")} part="acts">
            <div className="grid gap-2.5 md:grid-cols-3">{acts.map((act, index) => <PlanningField key={index} label={t(`productionCanvas.writing.outline.act.${index}`)}>
                <Input.TextArea className="text-xs" autoSize={{ minRows: 5, maxRows: 14 }} value={act} onChange={(event) => setAct(index, event.target.value)} />
            </PlanningField>)}</div>
        </PlanningSection>

        <PlanningSection title={t("productionCanvas.writing.outline.ending")} hint={t("productionCanvas.writing.outline.endingHint")} part="ending">
            <Input.TextArea autoSize={{ minRows: 4, maxRows: 12 }} value={detail.ending} onChange={(event) => onDetail({ ...detail, ending: event.target.value })} />
        </PlanningSection>

        <p className="pl-1 text-[11px] text-muted-foreground">{t("productionCanvas.writing.saveHint")}</p>
    </div>;
}
