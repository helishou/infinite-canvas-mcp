import { App, Button, Input } from "antd";
import { Check, ChevronDown, Loader2, Sparkles } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ModelPicker } from "@/components/model-picker";
import { requestEpisodeScriptProposal, updateBackendDramaEpisode, type DramaEpisode } from "@/services/backend-api";
import { batchFailure, episodeHasScript, pendingScriptEpisodes } from "./planning-script-queue";
import { PlanningEmpty, PlanningToolbar } from "./planning-ui";

/**
 * 「剧本」分区：按集顺序写剧本大纲（分场）。
 *
 * 顺序引导：第一集没有剧本大纲时就是当前集，写完之后自动指向下一集。
 * 生成走文本模型，只回候选文本；点保存才写回 episode.fullPlot（与分集编辑器里那份是同一字段）。
 */
export function firstEpisodeWithoutScript(episodes: readonly DramaEpisode[]) {
    return [...episodes].sort((left, right) => left.episodeNumber - right.episodeNumber).find((episode) => !episodeHasScript(episode)) ?? null;
}

export function PlanningScriptTab({ episodes, model, config, onModelChange, onSaved, onAskDirector, askDisabled }: {
    episodes: DramaEpisode[];
    model: string;
    config: Parameters<typeof ModelPicker>[0]["config"];
    onModelChange: (model: string) => void;
    onSaved: (episodes: DramaEpisode[]) => void;
    onAskDirector?: () => void;
    askDisabled?: boolean;
}) {
    const { message, modal } = App.useApp();
    const { t } = useTranslation();
    const ordered = [...episodes].sort((left, right) => left.episodeNumber - right.episodeNumber);
    const current = firstEpisodeWithoutScript(ordered);
    const [openId, setOpenId] = useState<string | null>(current?.id ?? ordered[0]?.id ?? null);
    const [drafts, setDrafts] = useState<Record<string, string>>({});
    const [busy, setBusy] = useState<string | null>(null);
    const [saving, setSaving] = useState<string | null>(null);
    const [batch, setBatch] = useState<{ done: number; total: number; current: number } | null>(null);
    const stopRef = useRef(false);

    const draftOf = (episode: DramaEpisode) => drafts[episode.id] ?? String(episode.fullPlot || "");
    const setDraft = (episode: DramaEpisode, text: string) => setDrafts((current) => ({ ...current, [episode.id]: text }));

    const generate = async (episode: DramaEpisode) => {
        setBusy(episode.id);
        try {
            const result = await requestEpisodeScriptProposal(episode.id, { model: model || undefined });
            setDraft(episode, String(result.text || ""));
        } catch (error) {
            message.error(error instanceof Error ? error.message : String(error));
        } finally {
            setBusy(null);
        }
    };
    const save = async (episode: DramaEpisode) => {
        setSaving(episode.id);
        try {
            const result = await updateBackendDramaEpisode(episode.id, { fullPlot: draftOf(episode) });
            const fresh = ordered.map((item) => result.episode && item.id === result.episode.id ? result.episode : item);
            onSaved(fresh);
            setDrafts((current) => { const next = { ...current }; delete next[episode.id]; return next; });
            message.success(t("planningScript.saved"));
            const pending = firstEpisodeWithoutScript(fresh);
            setOpenId(pending?.id ?? episode.id);
        } catch (error) {
            message.error(error instanceof Error ? error.message : String(error));
        } finally {
            setSaving(null);
        }
    };

    /** 一键把没写的集按顺序写完：一集一集来，失败就停，前面写好的保留。 */
    const runBatch = async (pending: Array<Pick<DramaEpisode, "id" | "episodeNumber" | "fullPlot" | "synopsis">>) => {
        stopRef.current = false;
        let list = episodes;
        for (const [index, episode] of pending.entries()) {
            if (stopRef.current) break;
            setBatch({ done: index, total: pending.length, current: episode.episodeNumber });
            try {
                const proposal = await requestEpisodeScriptProposal(episode.id, { model: model || undefined });
                const saved = await updateBackendDramaEpisode(episode.id, { fullPlot: String(proposal.text || "") });
                list = list.map((item) => saved.episode && item.id === saved.episode.id ? saved.episode : item);
                onSaved(list);
                setBatch({ done: index + 1, total: pending.length, current: episode.episodeNumber });
            } catch (error) {
                message.error(batchFailure(episode.episodeNumber, error instanceof Error ? error.message : String(error)));
                break;
            }
        }
        setBatch(null);
        const rest = pendingScriptEpisodes(list);
        setOpenId(rest[0]?.id ?? null);
    };
    const writeAll = () => {
        const pending = pendingScriptEpisodes(episodes);
        if (!pending.length) { message.info(t("planningScript.allWritten")); return; }
        modal.confirm({
            title: t("planningScript.batchTitle", { count: pending.length }),
            content: t("planningScript.batchHint"),
            okText: t("planningScript.batchOk"),
            cancelText: t("common.cancel"),
            onOk: () => void runBatch(pending),
        });
    };

    if (!ordered.length) return <div className="pt-1" data-planning-section="script">
        <PlanningEmpty text={t("planningScript.noEpisodes")} />
    </div>;

    const writtenCount = ordered.filter((episode) => episodeHasScript(episode)).length;

    return <div className="space-y-3 pt-1" data-planning-section="script">
        <PlanningToolbar>
            <span className="flex items-baseline gap-2">
                <span className="text-[13px] font-semibold">{t("planningScript.title")}</span>
                <span className="text-[11px] text-muted-foreground">{t("planningScript.progress", { written: writtenCount, total: ordered.length })}</span>
            </span>
            <span className="min-w-0 flex-1" />
            <span className="hidden text-[11px] text-muted-foreground sm:inline">{t("outlineWizard.model")}</span>
            <ModelPicker config={config} capability="text" className="w-52" value={model} onChange={onModelChange} placeholder={t("outlineWizard.modelDefault")} />
            <Button size="small" data-planning-script-batch disabled={Boolean(batch)} onClick={writeAll}>{t("planningScript.batch")}</Button>
            {onAskDirector ? <Button size="small" data-planning-ask="script" disabled={Boolean(batch) || askDisabled} onClick={onAskDirector} icon={<Sparkles className="size-3.5" />}>{t("planningAsk.director")}</Button> : null}
        </PlanningToolbar>
        {batch ? <div className="flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/[0.07] px-3 py-2 text-xs" data-planning-script-progress>
            <Loader2 className="size-3.5 animate-spin text-primary" />
            <span className="min-w-0 flex-1">{t("planningScript.batchRunning", { done: batch.done, total: batch.total })}</span>
            <Button size="small" type="link" onClick={() => { stopRef.current = true; }}>{t("planningScript.batchStop")}</Button>
        </div> : null}
        <ol className="space-y-2">
            {ordered.map((episode, index) => {
                const written = episodeHasScript(episode);
                const open = openId === episode.id;
                const isCurrent = !written && episode.id === current?.id;
                const dirty = drafts[episode.id] !== undefined && drafts[episode.id] !== String(episode.fullPlot || "");
                return <li key={episode.id} className={`overflow-hidden rounded-xl border transition-colors ${open ? "border-primary/40 bg-muted/[0.14]" : "border-border/70 bg-muted/[0.06] hover:bg-muted/[0.12]"}`}
                    data-planning-script-episode={episode.episodeNumber} data-state={written ? "done" : isCurrent ? "current" : "todo"}>
                    <button type="button" className="flex w-full min-w-0 items-center gap-2.5 px-3 py-2 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary" onClick={() => setOpenId(open ? null : episode.id)}>
                        <span className={`grid size-5 shrink-0 place-items-center rounded-full border text-[10px] tabular-nums ${written ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-400" : isCurrent ? "border-primary/60 bg-primary/10 text-primary" : "border-border text-muted-foreground"}`}>
                            {written ? <Check className="size-3" /> : index + 1}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-xs">
                            <span className="text-muted-foreground">{t("planningScript.episode", { number: episode.episodeNumber })}</span>
                            <span className="mx-1.5 text-muted-foreground/40">·</span>
                            <span className="font-medium text-foreground">{episode.title || t("planningScript.untitled")}</span>
                        </span>
                        {written ? <span className="shrink-0 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] text-emerald-400">{t("planningScript.written")}</span> : null}
                        {isCurrent ? <span className="shrink-0 rounded-full bg-primary/15 px-2 py-0.5 text-[10px] text-primary">{t("planningScript.todo")}</span> : null}
                        {dirty ? <span className="size-1.5 shrink-0 rounded-full bg-amber-400" aria-label={t("planningScript.unsaved")} /> : null}
                        <ChevronDown className={`size-3.5 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />
                    </button>
                    {open ? <div className="space-y-2.5 border-t border-border/60 px-3 pb-3 pt-3">
                        {episode.synopsis ? <p className="line-clamp-3 rounded-lg bg-background/40 px-2.5 py-2 text-[11px] leading-relaxed text-muted-foreground">{t("planningScript.synopsis")}：{episode.synopsis}</p> : null}
                        <Input.TextArea rows={10} value={draftOf(episode)} onChange={(event) => setDraft(episode, event.target.value)} placeholder={t("planningScript.placeholder")} />
                        <div className="flex flex-wrap items-center gap-2">
                            <Button size="small" type="primary" loading={busy === episode.id} onClick={() => void generate(episode)} icon={busy === episode.id ? undefined : <Sparkles className="size-3.5" />}>{t("outlineWizard.start")}</Button>
                            <Button size="small" disabled={!dirty} loading={saving === episode.id} onClick={() => void save(episode)}>{t("planningScript.save")}</Button>
                            {dirty ? <span className="text-[11px] text-amber-400">{t("planningScript.unsaved")}</span> : null}
                        </div>
                    </div> : null}
                </li>;
            })}
        </ol>
    </div>;
}
