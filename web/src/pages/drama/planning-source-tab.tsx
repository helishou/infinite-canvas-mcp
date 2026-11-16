import { Alert, App, Button, Checkbox, Input, InputNumber, Switch, Tag } from "antd";
import { FileText, Loader2, Sparkles, Upload } from "lucide-react";
import { useDeferredValue, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { analyzeNovelChapters, type NovelChapterIssue } from "@basketikun/canvas-agent/drama/novel-chapters";
import { EPISODE_SOURCE_CHARS, MAX_CHAPTERS_PER_EPISODE } from "@basketikun/canvas-agent/drama/chapter-episodes";
import type { DramaSourceSplit } from "@basketikun/canvas-agent/drama/production-contract";
import { buildEpisodeGroups, chapterTitleOf, formatSeconds, groupSynopsis, summarizeGroups, toChapterRows, type AdaptChapterRow } from "@/lib/drama/adapt";
import { createBackendDramaEpisode, ensureEpisodeCanvas, fetchBackendDramaEpisodes, type DramaEpisode } from "@/services/backend-api";

const DEFAULT_MAX_CHARS = 3000;
const DEFAULT_MIN_CHARS = 200;

/**
 * 「原剧本」页签：原文 + 拆章 + 编排成集，一屏完成"把书变成集"。
 *
 * 原来这是导航里独立的「小说改编」屏，和这里的原文编辑各管一半、原文却只有一份；
 * 现在原文就是剧目规划草稿里的 sourceScript：上面编辑、下面按同一份文本拆章成集。
 * 建集前会先把原文与分集口径保存进剧目规划，避免"集建好了、原文没落库"。
 */
export function PlanningSourceTab({ dramaId, source, onSourceChange, split, episodes, onSaveSource, onEpisodesCreated }: {
    dramaId: string;
    source: string;
    onSourceChange: (value: string) => void;
    split: DramaSourceSplit;
    episodes: DramaEpisode[];
    /** 保存原文与分集口径（建集前静默调用），返回是否成功。 */
    onSaveSource: (patch: Partial<DramaSourceSplit>) => Promise<boolean>;
    onEpisodesCreated?: (episodes: DramaEpisode[]) => void;
}) {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const fileRef = useRef<HTMLInputElement>(null);
    const [fileName, setFileName] = useState("");
    const [maxChars, setMaxChars] = useState(split.maxChars || DEFAULT_MAX_CHARS);
    const [mergeShort, setMergeShort] = useState(false);
    const [perEpisode, setPerEpisode] = useState(split.perEpisode || 1);
    const [creating, setCreating] = useState<{ done: number; total: number } | null>(null);
    // 用户改过的标题/勾选按行位置记；其余全部从 analysis 派生，避免"状态与正文不同步"。
    const [overrides, setOverrides] = useState<Record<number, { titleOverride?: string; selected?: boolean }>>({});

    // 长篇正文每敲一个字都重新切书会很卡：切章跟随延后的文本，输入框本身即时。
    const deferredSource = useDeferredValue(source);
    const analysis = useMemo(() => {
        if (!deferredSource.trim()) return null;
        return analyzeNovelChapters(deferredSource, { maxChars, minChars: DEFAULT_MIN_CHARS, mergeShortChapters: mergeShort });
    }, [deferredSource, maxChars, mergeShort]);

    // 预留章（没勾选的章）默认不勾，继续加进来时一眼看到它们是"留着没做"的。
    const reserved = useMemo(() => new Set(split.excluded), [split.excluded]);
    const rows = useMemo<AdaptChapterRow[]>(() => (analysis?.chapters || []).map((chapter, index) => {
        const override = overrides[index];
        return {
            ...chapter,
            selected: override?.selected ?? !reserved.has(chapter.index),
            titleOverride: override?.titleOverride ?? "",
        };
    }), [analysis, overrides, reserved]);

    const selectedCount = rows.filter(row => row.selected).length;
    const startNumber = episodes.reduce((max, episode) => Math.max(max, episode.episodeNumber), 0) + 1;
    const existingEpisodes = useMemo(() => episodes.map(episode => ({ episodeNumber: episode.episodeNumber, title: episode.title })), [episodes]);
    const groups = useMemo(() => buildEpisodeGroups(rows, { perEpisode, startNumber, existingEpisodes }), [rows, perEpisode, startNumber, existingEpisodes]);
    const summary = summarizeGroups(groups);
    const blocked = groups.filter(group => group.oversized);

    const patchRow = (index: number, patch: { titleOverride?: string; selected?: boolean }) => {
        setOverrides(current => ({ ...current, [index]: { ...current[index], ...patch } }));
    };
    const selectAll = (selected: boolean) => {
        setOverrides(Object.fromEntries(rows.map((_, index) => [index, { selected }])));
    };

    const importFile = async (file: File) => {
        const text = await file.text();
        if (text.includes("\uFFFD") && text.replace(/[^\uFFFD]/g, "").length > text.length * 0.01) {
            message.warning(t("drama.adapt.encodingWarning"));
        }
        setOverrides({});
        onSourceChange(text);
        setFileName(file.name.replace(/\.[^.]+$/, ""));
    };

    const createEpisodes = async () => {
        if (!rows.length) return void message.warning(t("drama.adapt.blockedEmpty"));
        const pending = groups.filter(group => !group.existing);
        if (!pending.length) return void message.info(t("drama.adapt.allExisting"));
        if (blocked.length) return void message.error(t("drama.adapt.oversizeBlocked", { label: blocked[0].label, chars: blocked[0].chars, limit: EPISODE_SOURCE_CHARS }));
        // 先落盘原文与这次的分集口径，再建集：避免集建好了、原剧本还是旧的。
        const saved = await onSaveSource({ excluded: rows.filter(row => !row.selected).map(row => row.index), perEpisode, maxChars });
        if (!saved) return;
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
            if (fresh?.episodes) onEpisodesCreated?.(fresh.episodes);
        }
    };

    const issuesOf = (kind: NovelChapterIssue["kind"]) => (analysis?.issues || []).filter(issue => issue.kind === kind);

    return <div className="space-y-4 pt-1" data-planning-section="source" data-testid="novel-adapt-panel">
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
                {source ? <Button size="small" type="text" onClick={() => { setOverrides({}); onSourceChange(""); setFileName(""); }}>{t("drama.adapt.clear")}</Button> : null}
                {fileName ? <span className="ui-caption text-muted-foreground">{fileName}</span> : null}
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
                onChange={event => onSourceChange(event.target.value)}
                autoSize={{ minRows: 8, maxRows: 20 }}
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
                        <button type="button" className="text-primary hover:underline" onClick={() => selectAll(true)}>{t("drama.adapt.selectAll")}</button>
                        <button type="button" className="text-primary hover:underline" onClick={() => selectAll(false)}>{t("drama.adapt.selectNone")}</button>
                        <span>{t("drama.adapt.selection", { count: selectedCount })}</span>
                        {rows.length - selectedCount ? <span>{t("newDrama.split.reserved", { count: rows.length - selectedCount })}</span> : null}
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
                    <p className="mt-2 text-[11px] text-muted-foreground">{t("drama.adapt.autoSaveHint")}</p>
                    {blocked.length ? (
                        <Alert type="error" showIcon className="mt-2" message={t("drama.adapt.oversizeBlocked", { label: blocked[0].label, chars: blocked[0].chars, limit: EPISODE_SOURCE_CHARS })} />
                    ) : null}
                </>
            ) : (
                <p className="text-xs text-muted-foreground">{t("drama.adapt.blockedEmpty")}</p>
            )}
        </div>
    </div>;
}
