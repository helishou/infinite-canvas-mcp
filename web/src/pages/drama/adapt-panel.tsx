import { Alert, App, Button, Checkbox, Input, InputNumber, Switch, Tag } from "antd";
import { FileText, Loader2, Sparkles, Upload } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { analyzeNovelChapters, type NovelChapterIssue } from "@basketikun/canvas-agent/drama/novel-chapters";
import { EPISODE_SOURCE_CHARS, MAX_CHAPTERS_PER_EPISODE } from "@basketikun/canvas-agent/drama/chapter-episodes";
import {
    buildEpisodeGroups,
    chapterTitleOf,
    formatSeconds,
    groupSynopsis,
    summarizeGroups,
    toChapterRows,
    type AdaptChapterRow,
} from "@/lib/drama/adapt";
import { createBackendDramaEpisode, ensureEpisodeCanvas, fetchBackendDramaEpisodes, upsertBackendCanvasFolder, type DramaEpisode } from "@/services/backend-api";
import { useCanvasStore, type CanvasFolder } from "@/stores/canvas/use-canvas-store";
import { dramaProductionPlanSchema } from "@basketikun/canvas-agent/drama/production-contract";
import { AdaptStoryboardPanel } from "./adapt-storyboard-panel";

const DEFAULT_MAX_CHARS = 3000;
const DEFAULT_MIN_CHARS = 200;
const DRAFT_PREFIX = "infinite-canvas:drama-adapt:";

type AdaptDraft = {
    source: string;
    fileName: string;
    maxChars: number;
    mergeShort: boolean;
    perEpisode: number;
    overrides: Array<{ titleOverride: string; selected: boolean }>;
};

/** 建集后父级会重拉分集并短暂卸载本面板，草稿落到 sessionStorage，回来还能接着改。 */
function readDraft(dramaId: string): AdaptDraft | null {
    if (typeof window === "undefined") return null;
    try {
        const raw = window.sessionStorage.getItem(`${DRAFT_PREFIX}${dramaId}`);
        return raw ? JSON.parse(raw) as AdaptDraft : null;
    } catch {
        return null;
    }
}

function writeDraft(dramaId: string, draft: AdaptDraft) {
    if (typeof window === "undefined") return;
    try {
        window.sessionStorage.setItem(`${DRAFT_PREFIX}${dramaId}`, JSON.stringify(draft));
    } catch {
        // 存不下就不存，不影响使用。
    }
}

/**
 * 小说改编（方案 A）：导入 → 拆章 → 编排成集。
 *
 * 这一屏只做「把书变成集」这一段，建出来的集带着原文 synopsis，之后进分镜草案屏
 * 生成带【镜头】标记的需求正文与 Shot/Clip。规则与影策短剧对齐：一章一集为默认，
 * 可改成每 N 章一集（≤12），单集原文 ≤40000 字，只合并相邻章。
 */
export function NovelAdaptPanel({ dramaId, onEpisodesChanged }: { dramaId: string; onEpisodesChanged?: () => void }) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const fileRef = useRef<HTMLInputElement>(null);

    const restored = useRef<AdaptDraft | null>(readDraft(dramaId));
    const overridesRef = useRef(restored.current?.overrides || []);
    const [source, setSource] = useState(restored.current?.source || "");
    const [fileName, setFileName] = useState(restored.current?.fileName || "");
    const [maxChars, setMaxChars] = useState(restored.current?.maxChars || DEFAULT_MAX_CHARS);
    const [mergeShort, setMergeShort] = useState(restored.current?.mergeShort || false);
    const [rows, setRows] = useState<AdaptChapterRow[]>([]);
    const [perEpisode, setPerEpisode] = useState(restored.current?.perEpisode || 1);
    const [episodes, setEpisodes] = useState<DramaEpisode[]>([]);
    const [creating, setCreating] = useState<{ done: number; total: number } | null>(null);
    const [savingSource, setSavingSource] = useState(false);
    const folders = useCanvasStore(state => state.folders);
    const folder = folders.find(item => item.id === dramaId);
    const savedSource = String(folder?.productionPlan?.sourceScript || "");

    // 原剧本只有一份：改编面板没草稿时，直接用剧目规划里存的原剧本。
    useEffect(() => {
        if (restored.current?.source) return;
        const text = String(useCanvasStore.getState().folders.find(item => item.id === dramaId)?.productionPlan?.sourceScript || "");
        if (text.trim()) setSource(text);
    }, [dramaId]);

    /** 把当前原文写回剧目规划的「原剧本」，两边就是同一份。 */
    const saveAsSourceScript = async () => {
        const target = useCanvasStore.getState().folders.find(item => item.id === dramaId);
        if (!target) return void message.error(t("drama.adapt.sourceSaveFailed"));
        setSavingSource(true);
        try {
            const plan = dramaProductionPlanSchema.parse(target.productionPlan || {});
            const result = await upsertBackendCanvasFolder({
                ...target,
                productionPlan: { ...plan, sourceScript: source },
                expectedPlanningUpdatedAt: String(target.updatedAt || ""),
                updatedAt: new Date().toISOString(),
            });
            useCanvasStore.setState(state => ({ folders: state.folders.map(item => item.id === dramaId ? result.folder as unknown as CanvasFolder : item) }));
            message.success(t("drama.adapt.sourceSaved"));
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("drama.adapt.sourceSaveFailed"));
        } finally {
            setSavingSource(false);
        }
    };

    useEffect(() => {
        let disposed = false;
        void fetchBackendDramaEpisodes(dramaId)
            .then(result => { if (!disposed) setEpisodes(result.episodes || []); })
            .catch(() => { if (!disposed) setEpisodes([]); });
        return () => { disposed = true; };
    }, [dramaId]);

    const analysis = useMemo(() => {
        if (!source.trim()) return null;
        return analyzeNovelChapters(source, { maxChars, minChars: DEFAULT_MIN_CHARS, mergeShortChapters: mergeShort });
    }, [source, maxChars, mergeShort]);

    // 重新拆章时保留用户已改的标题与勾选：按行位置对齐，长度变化时多出的行用默认值。
    useEffect(() => {
        if (!analysis) { setRows([]); return; }
        setRows(analysis.chapters.map((chapter, index) => {
            const override = overridesRef.current[index];
            return {
                ...chapter,
                selected: override?.selected ?? true,
                titleOverride: override?.titleOverride ?? "",
            };
        }));
    }, [analysis]);

    useEffect(() => {
        writeDraft(dramaId, { source, fileName, maxChars, mergeShort, perEpisode, overrides: overridesRef.current });
        // rows 也要跟：勾选与改标题只动 rows 与 overridesRef，不写进依赖就会在建集后的重挂载里丢掉。
    }, [dramaId, source, fileName, maxChars, mergeShort, perEpisode, rows]);

    const selectedCount = rows.filter(row => row.selected).length;
    const startNumber = episodes.reduce((max, episode) => Math.max(max, episode.episodeNumber), 0) + 1;
    const existingTitles = useMemo(() => episodes.map(episode => episode.title), [episodes]);
    const groups = useMemo(
        () => buildEpisodeGroups(rows, { perEpisode, startNumber, existingTitles }),
        [rows, perEpisode, startNumber, existingTitles],
    );
    const summary = summarizeGroups(groups);
    const blocked = groups.filter(group => group.oversized);

    const patchRow = (index: number, patch: Partial<AdaptChapterRow>) => {
        const current = overridesRef.current[index] || { titleOverride: "", selected: true };
        overridesRef.current = [...overridesRef.current];
        overridesRef.current[index] = { ...current, ...patch };
        setRows(rows => rows.map((row, position) => position === index ? { ...row, ...patch } : row));
    };

    const importFile = async (file: File) => {
        const text = await file.text();
        if (text.includes("\uFFFD") && text.replace(/[^\uFFFD]/g, "").length > text.length * 0.01) {
            message.warning(t("drama.adapt.encodingWarning"));
        }
        setSource(text);
        setFileName(file.name.replace(/\.[^.]+$/, ""));
    };

    const createEpisodes = async () => {
        if (!rows.length) return void message.warning(t("drama.adapt.blockedEmpty"));
        const pending = groups.filter(group => !group.existing);
        if (!pending.length) return void message.info(t("drama.adapt.allExisting"));
        if (blocked.length) return void message.error(t("drama.adapt.oversizeBlocked", { label: blocked[0].label, chars: blocked[0].chars, limit: EPISODE_SOURCE_CHARS }));
        setCreating({ done: 0, total: pending.length });
        let created = 0;
        for (const group of pending) {
            try {
                const result = await createBackendDramaEpisode(dramaId, {
                    episodeNumber: group.episodeNumber,
                    title: group.title.slice(0, 60),
                    synopsis: groupSynopsis(rows, group),
                });
                // 建集必须立刻建画布：不带 canvasId 的分集点进去是「画布不存在」。
                if (result.episode && !result.episode.canvasId) {
                    await ensureEpisodeCanvas(result.episode.id).catch(error => {
                        message.warning(`${group.label}：画布建立失败（${error instanceof Error ? error.message : String(error)}），可稍后在分集管理里补建`);
                    });
                }
                created += 1;
            } catch (error) {
                message.error(`${group.label}：${error instanceof Error ? error.message : String(error)}`);
                break;
            } finally {
                setCreating(current => current ? { ...current, done: current.done + 1 } : current);
            }
        }
        setCreating(null);
        if (created) {
            message.success(t("drama.adapt.created", { count: created }));
            const fresh = await fetchBackendDramaEpisodes(dramaId).catch(() => null);
            if (fresh?.episodes) setEpisodes(fresh.episodes);
            onEpisodesChanged?.();
        }
    };

    const issuesOf = (kind: NovelChapterIssue["kind"]) => (analysis?.issues || []).filter(issue => issue.kind === kind);

    return (
        <section className="min-w-0 space-y-4" data-testid="novel-adapt-panel">
            <header className="flex flex-wrap items-end justify-between gap-3">
                <div>
                    <h2 className="text-lg font-medium tracking-tight">{t("drama.adapt.title")}</h2>
                    <p className="mt-1 text-xs text-muted-foreground">{t("drama.adapt.subtitle")}</p>
                </div>
                {fileName ? <span className="ui-caption text-muted-foreground">{fileName}</span> : null}
            </header>

            <div className="rounded-xl border border-border bg-background p-4">
                <div className="mb-3 flex flex-wrap items-center gap-2">
                    <h3 className="text-sm font-medium">{t("drama.adapt.importTitle")}</h3>
                    <input
                        ref={fileRef}
                        type="file"
                        accept=".txt,.md,text/plain"
                        className="hidden"
                        onChange={event => {
                            const file = event.target.files?.[0];
                            event.target.value = "";
                            if (file) void importFile(file);
                        }}
                    />
                    <Button size="small" icon={<Upload className="size-3.5" />} onClick={() => fileRef.current?.click()}>{t("drama.adapt.chooseFile")}</Button>
                    {source ? <Button size="small" type="text" onClick={() => { setSource(""); setFileName(""); }}>{t("drama.adapt.clear")}</Button> : null}
                    {source.trim() && source !== savedSource ? <Button size="small" loading={savingSource} onClick={() => void saveAsSourceScript()}>{t("drama.adapt.saveAsSource")}</Button> : null}
                    {source.trim() && source === savedSource ? <Tag color="green">{t("drama.adapt.isSource")}</Tag> : null}
                    <span className="ml-auto flex items-center gap-3 text-xs text-muted-foreground">
                        <span>{t("drama.adapt.maxChars")}</span>
                        <InputNumber size="small" min={500} max={12000} step={500} value={maxChars} onChange={value => setMaxChars(Math.max(500, Number(value) || DEFAULT_MAX_CHARS))} aria-label={t("drama.adapt.maxChars")} />
                        <span className="inline-flex items-center gap-1.5">
                            <Switch size="small" checked={mergeShort} onChange={setMergeShort} aria-label={t("drama.adapt.mergeShort")} />
                            {t("drama.adapt.mergeShort")}
                        </span>
                    </span>
                </div>

                <Input.TextArea
                    value={source}
                    onChange={event => setSource(event.target.value)}
                    autoSize={{ minRows: 4, maxRows: 10 }}
                    placeholder={t("drama.adapt.importPlaceholder")}
                    aria-label={t("drama.adapt.importPlaceholder")}
                    data-testid="novel-adapt-source"
                />

                {analysis ? (
                    <div className="mt-3 space-y-2">
                        <div className="flex flex-wrap items-center gap-2 text-xs">
                            <Tag color="blue">{t("drama.adapt.analyzed", { count: analysis.chapters.length, words: analysis.chapters.reduce((sum, chapter) => sum + chapter.body.length, 0) })}</Tag>
                            {analysis.removedNoiseLines ? <Tag>{t("drama.adapt.noiseRemoved", { count: analysis.removedNoiseLines })}</Tag> : null}
                            {issuesOf("no_heading").length ? <Tag color="orange">{t("drama.adapt.noHeading")}</Tag> : null}
                            {issuesOf("duplicate").map(issue => <Tag key={issue.message} color="orange">{issue.message}</Tag>)}
                            {issuesOf("oversized_split").map(issue => <Tag key={issue.message} color="orange">{issue.message}</Tag>)}
                        </div>
                        <div className="max-h-[320px] overflow-auto rounded-lg border border-border">
                            {rows.map((row, index) => (
                                <div key={`${row.index}-${row.startOffset}`} className="flex items-center gap-2 border-b border-border/60 px-2 py-1.5 last:border-b-0" data-testid="novel-adapt-chapter">
                                    <Checkbox checked={row.selected} onChange={event => patchRow(index, { selected: event.target.checked })} aria-label={chapterTitleOf(row)} />
                                    <span className="w-8 shrink-0 text-xs text-muted-foreground">{row.index}</span>
                                    <Input
                                        size="small"
                                        variant="borderless"
                                        value={row.titleOverride || row.title}
                                        onChange={event => patchRow(index, { titleOverride: event.target.value === row.title ? "" : event.target.value })}
                                        aria-label={t("drama.adapt.chapterTitle")}
                                    />
                                    <span className="shrink-0 text-xs text-muted-foreground">{row.body.length}</span>
                                </div>
                            ))}
                        </div>
                        <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                            <button type="button" className="text-primary hover:underline" onClick={() => setRows(current => current.map(row => ({ ...row, selected: true })))}>{t("drama.adapt.selectAll")}</button>
                            <button type="button" className="text-primary hover:underline" onClick={() => setRows(current => current.map(row => ({ ...row, selected: false })))}>{t("drama.adapt.selectNone")}</button>
                            <span>{t("drama.adapt.selection", { count: selectedCount })}</span>
                        </div>
                    </div>
                ) : (
                    <p className="mt-3 text-xs text-muted-foreground">{t("drama.adapt.empty")}</p>
                )}
            </div>

            <div className="rounded-xl border border-border bg-background p-4">
                <div className="mb-3 flex flex-wrap items-center gap-2">
                    <h3 className="text-sm font-medium">{t("drama.adapt.planTitle")}</h3>
                    <span className="flex items-center gap-2 text-xs text-muted-foreground">
                        {t("drama.adapt.perEpisode")}
                        <InputNumber size="small" min={1} max={MAX_CHAPTERS_PER_EPISODE} precision={0} value={perEpisode} onChange={value => setPerEpisode(Math.min(MAX_CHAPTERS_PER_EPISODE, Math.max(1, Number(value) || 1)))} aria-label={t("drama.adapt.perEpisode")} />
                        {t("drama.adapt.perEpisodeUnit")}
                    </span>
                    <Tag>{t("drama.adapt.episodeCount", { chapters: selectedCount, episodes: groups.length })}</Tag>
                    <Button type="primary" size="small" className="ml-auto" loading={Boolean(creating)} disabled={!groups.length || blocked.length > 0} onClick={() => void createEpisodes()}>
                        {creating ? t("drama.adapt.creating", creating) : t("drama.adapt.createEpisodes")}
                    </Button>
                </div>

                {groups.length ? (
                    <>
                        <div className="overflow-auto rounded-lg border border-border">
                            <div className="grid grid-cols-[3rem_1fr_5rem_4rem_4rem_5rem_5rem] items-center gap-2 border-b border-border bg-muted/40 px-2 py-1.5 text-xs text-muted-foreground">
                                <span>{t("drama.adapt.colEpisodes")}</span>
                                <span>{t("drama.adapt.colTitle")}</span>
                                <span className="text-right">{t("drama.adapt.colChars")}</span>
                                <span className="text-right">{t("drama.adapt.colShots")}</span>
                                <span className="text-right">{t("drama.adapt.colSegments")}</span>
                                <span className="text-right">{t("drama.adapt.colDuration")}</span>
                                <span className="text-right">{t("drama.adapt.colStatus")}</span>
                            </div>
                            {groups.map(group => (
                                <div key={`${group.index}-${group.label}`} className="grid grid-cols-[3rem_1fr_5rem_4rem_4rem_5rem_5rem] items-center gap-2 border-b border-border/60 px-2 py-1.5 text-xs last:border-b-0" data-testid="novel-adapt-group">
                                    <span className="text-muted-foreground">{group.episodeNumber}</span>
                                    <span className="min-w-0 truncate" title={group.label}>{group.title}</span>
                                    <span className="text-right">{group.chars}</span>
                                    <span className="text-right">{group.scale.shots}</span>
                                    <span className="text-right">{group.scale.segments}</span>
                                    <span className="text-right">{formatSeconds(group.scale.seconds)}</span>
                                    <span className="text-right">
                                        {group.oversized ? <Tag color="red">{t("drama.adapt.statusOversized")}</Tag>
                                            : group.existing ? <Tag>{t("drama.adapt.statusExisting")}</Tag>
                                                : <Tag color="green">{t("drama.adapt.statusNew")}</Tag>}
                                    </span>
                                </div>
                            ))}
                        </div>
                        <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                            <span><FileText className="mr-1 inline size-3" />{t("drama.adapt.summary", { episodes: summary.episodes, shots: summary.shots, segments: summary.segments, duration: formatSeconds(summary.seconds) })}</span>
                            <span className="inline-flex items-center gap-1"><Sparkles className="size-3" />{t("drama.adapt.estimateHint")}</span>
                            {creating ? <span className="inline-flex items-center gap-1"><Loader2 className="size-3 animate-spin" />{t("drama.adapt.creating", creating)}</span> : null}
                        </div>
                        {blocked.length ? (
                            <Alert type="error" showIcon className="mt-2" message={t("drama.adapt.oversizeBlocked", { label: blocked[0].label, chars: blocked[0].chars, limit: EPISODE_SOURCE_CHARS })} />
                        ) : null}
                    </>
                ) : (
                    <p className="text-xs text-muted-foreground">{t("drama.adapt.blockedEmpty")}</p>
                )}
            </div>

            <AdaptStoryboardPanel dramaId={dramaId} episodes={episodes} onWritten={onEpisodesChanged} />
        </section>
    );
}
