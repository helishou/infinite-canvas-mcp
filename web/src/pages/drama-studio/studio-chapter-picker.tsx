import { useEffect, useMemo, useState } from "react";
import { App, InputNumber, Modal } from "antd";
import { AlertTriangle, BookOpen } from "lucide-react";

import { analyzeNovelChapters } from "@basketikun/canvas-agent/drama/novel-chapters";
import { buildEpisodeGroups, chapterCharsOf, groupSynopsis, type AdaptChapterRow } from "@/lib/drama/adapt";
import {
    createBackendDramaEpisode,
    ensureEpisodeCanvas,
    upsertBackendCanvasFolder,
    type DramaEpisode,
} from "@/services/backend-api";
import { useCanvasStore, type CanvasFolder } from "@/stores/canvas/use-canvas-store";
import { cn } from "@/lib/utils";

const DEFAULT_MAX_CHARS = 3000;
const DEFAULT_MIN_CHARS = 200;
/** 影策 novel-parse：单章原文上限（一次提示词读不完，超出必须拆开或取消选中）。 */
const EPISODE_SOURCE_CHARS = 12_000;
/** 影策 novel-parse：按章合并成集时每集原文上限。 */
const EPISODE_GROUP_CHARS = 40_000;
/** 影策 chapter-selection：章节多时默认只选“接下来”的 N 章，其余留给制作台再加。 */
const DEFAULT_SELECTED_CHAPTERS = 10;
const MAX_CHAPTERS_PER_EPISODE = 12;
const PREVIEW_CHARS = 8000;

/**
 * 影策「原著还有 N 章 · 继续选章」的本地实现（受控 Modal 组件）。
 *
 * 真值只有一份：folder.productionPlan.sourceScript（原文）+ sourceSplit.excluded（预留章序号）。
 * 勾选预留章 → 写回 excluded（走 upsertBackendCanvasFolder，与剧目规划同源）→ 按共享拆章口径建集 → 立即建画布。
 * 不新增第二份章节真值；章数、编组全部由同一份拆章逻辑派生。
 *
 * 与影策 chapter-picker.tsx 对齐的四点：默认只选接下来 N 章、列表显示字数/超长/已归属集号、
 * 超限时给出 problem 并禁用「加入制作」（不再静默截断原文）、加入后可选触发逐集改编。
 */
export function StudioChapterPickerModal({ folder, episodes, open, onClose, onDone, onProduced }: {
    folder: CanvasFolder | null;
    episodes: DramaEpisode[];
    open: boolean;
    onClose: () => void;
    onDone: () => void | Promise<void>;
    /** 父组件可接线：新集建立后触发逐集改编（入参为新集 id）。未接线时只给出提示。 */
    onProduced?: (episodeIds: string[]) => void | Promise<void>;
}) {
    const { message } = App.useApp();
    const [creating, setCreating] = useState(false);
    // 每集章数：真值在 folder.productionPlan.sourceSplit.perEpisode；弹窗内先编辑，点「加入制作」时与 excluded 一起显式 patch 落库。
    const [perEpisodeDraft, setPerEpisodeDraft] = useState(1);
    const [previewIndex, setPreviewIndex] = useState<number | null>(null);

    const plan = (folder?.productionPlan || {}) as Record<string, unknown>;
    const sourceScript = String(plan.sourceScript || "");
    const split = (plan.sourceSplit || {}) as Record<string, unknown>;
    const excluded = Array.isArray(split.excluded) ? (split.excluded as number[]) : [];
    const perEpisode = perEpisodeDraft;
    const maxChars = Number(split.maxChars) || DEFAULT_MAX_CHARS;
    const excludedKey = excluded.join(",");
    const reserved = useMemo(() => new Set(excluded), [excludedKey]);

    const analysis = useMemo(() => {
        if (!sourceScript.trim()) return null;
        return analyzeNovelChapters(sourceScript, { maxChars, minChars: DEFAULT_MIN_CHARS });
    }, [sourceScript, maxChars]);

    const rows = useMemo<AdaptChapterRow[]>(() => (analysis?.chapters || []).map((chapter) => ({
        ...chapter,
        // 勾选状态由下面的 selected 集合持有；这里只保留 AdaptChapterRow 的形状。
        selected: false,
        titleOverride: "",
    })), [analysis]);
    const reservedRows = useMemo(() => rows.filter((row) => reserved.has(row.index)), [rows, reserved]);

    // 默认只选“接下来”的 N 章（第一个预留章起连续的预留章），用户仍可手动勾选更多。
    const [selected, setSelected] = useState<Set<number>>(
        () => new Set(reservedRows.slice(0, DEFAULT_SELECTED_CHAPTERS).map((row) => row.index)),
    );
    const chosenRows = useMemo(() => reservedRows.filter((row) => selected.has(row.index)), [reservedRows, selected]);

    // 打开弹窗/换剧目时把可编辑字段同步回后端真值，避免上一次的草稿串到别的剧目。
    useEffect(() => {
        if (!open) return;
        const reservedSet = new Set(excluded);
        setSelected(new Set(
            (analysis?.chapters || [])
                .filter((chapter) => reservedSet.has(chapter.index))
                .slice(0, DEFAULT_SELECTED_CHAPTERS)
                .map((chapter) => chapter.index),
        ));
        setPreviewIndex(null);
        setPerEpisodeDraft(Math.max(1, Math.min(MAX_CHAPTERS_PER_EPISODE, Number(split.perEpisode) || 1)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, folder?.id, excludedKey, split.perEpisode]);

    // 原文预览：本地原文只有 folder.productionPlan.sourceScript 一份，章节由同一份拆章逻辑派生，body 即该章真实正文。
    const previewTarget = previewIndex ?? reservedRows[0]?.index ?? rows[0]?.index;
    const previewChapter = reservedRows.find((row) => row.index === previewTarget) ?? rows.find((row) => row.index === previewTarget);

    // 已归属第几集：从现有 episodes 派生。本地 groupSynopsis 把每章写成「【章】标题」，据此回查真实落库的集号；
    // 老数据没有该标记时，未 reserved 的章只能确认「已加入」，不编造集号。
    const chapterEpisode = useMemo(() => {
        const map = new Map<string, number>();
        for (const ep of [...episodes].sort((a, b) => a.episodeNumber - b.episodeNumber)) {
            for (const segment of String(ep.synopsis || "").split("【章】").slice(1)) {
                const title = segment.split("\n")[0].trim();
                if (title && !map.has(title)) map.set(title, ep.episodeNumber);
            }
        }
        return map;
    }, [episodes]);

    // 分析层把超长章二次切开时会记 issue；列表把它显式标出来（真值 chapter-picker 的 warn 语义）。
    const oversizedIssues = useMemo(() => new Set(
        (analysis?.issues || [])
            .filter((issue) => issue.kind === "oversized_split" && typeof issue.chapterIndex === "number")
            .map((issue) => issue.chapterIndex as number),
    ), [analysis]);

    const charsOf = (row: AdaptChapterRow) => chapterCharsOf(row);
    const isWarn = (row: AdaptChapterRow) => charsOf(row) > EPISODE_SOURCE_CHARS || oversizedIssues.has(row.index);
    const noteOf = (row: AdaptChapterRow) => {
        if (reserved.has(row.index)) return undefined; // 预留章还没加入制作
        const episodeNumber = chapterEpisode.get(row.title.trim());
        return episodeNumber ? `第 ${episodeNumber} 集` : "已加入";
    };

    const startNumber = episodes.reduce((max, ep) => Math.max(max, ep.episodeNumber), 0) + 1;
    const groups = useMemo(() => buildEpisodeGroups(
        chosenRows.map((row) => ({ ...row, selected: true })),
        { perEpisode, startNumber },
    ), [chosenRows, perEpisode, startNumber]);

    // 与影策 chapter-picker 的 problem 同源：单章超限（拆不开）或每集合计超限都要拦下，不再静默截断原文。
    const longChapters = chosenRows.filter((row) => charsOf(row) > EPISODE_SOURCE_CHARS).length;
    const oversizedGroup = groups.find((group) => group.chars > EPISODE_GROUP_CHARS);
    const problem = longChapters
        ? `选中的 ${longChapters} 章原文超过 ${EPISODE_SOURCE_CHARS / 10_000} 万字，请先在原文里拆开或取消选中`
        : oversizedGroup
            ? `${oversizedGroup.title}合计 ${oversizedGroup.chars.toLocaleString("zh-CN")} 字，每集原文不超过 ${EPISODE_GROUP_CHARS / 10_000} 万字，请减少每集章数`
            : "";

    const toggle = (index: number, checked: boolean) => {
        if (!reserved.has(index)) return; // 已加入制作的章不可改
        setSelected((current) => {
            const next = new Set(current);
            if (checked) next.add(index);
            else next.delete(index);
            return next;
        });
    };
    const selectAll = (checked: boolean) => {
        setSelected(checked ? new Set(reservedRows.map((row) => row.index)) : new Set());
    };

    const handleOk = async () => {
        if (!folder || !sourceScript.trim() || !chosenRows.length || problem) return;
        setCreating(true);
        try {
            // 1) 先把 excluded 写回剧目规划（与 planning-source-tab 同源，显式 patch，避免集建好原文没落库）。
            const newlyAdded = new Set(chosenRows.map((row) => row.index));
            const newExcluded = excluded.filter((n) => !newlyAdded.has(n));
            const productionPlan = { ...plan, sourceSplit: { ...split, excluded: newExcluded, perEpisode } };
            const result = await upsertBackendCanvasFolder({
                ...folder,
                productionPlan,
                expectedPlanningUpdatedAt: folder.updatedAt || folder.createdAt,
                updatedAt: new Date().toISOString(),
            });
            useCanvasStore.setState((state) => ({
                folders: state.folders.map((item) => item.id === folder.id ? result.folder as unknown as CanvasFolder : item),
            }));

            // 2) 按共享拆章口径建集 + 立即建画布。校验已拦下超限的章/组，这里传完整原文，不再静默截断。
            const createdIds: string[] = [];
            let created = 0;
            for (const group of groups) {
                try {
                    const res = await createBackendDramaEpisode(folder.id, {
                        episodeNumber: group.episodeNumber,
                        title: group.title.slice(0, 60),
                        synopsis: groupSynopsis(chosenRows, group, Number.MAX_SAFE_INTEGER),
                    });
                    if (res.episode) {
                        createdIds.push(res.episode.id);
                        if (!res.episode.canvasId) {
                            await ensureEpisodeCanvas(res.episode.id).catch(() => undefined);
                        }
                    }
                    created += 1;
                } catch (error) {
                    message.error(`${group.title}：${error instanceof Error ? error.message : String(error)}`);
                    break;
                }
            }
            if (created) {
                message.success(`已加入 ${created} 集到制作`);
                setSelected(new Set());
                onClose();
                await onDone();
                if (onProduced) {
                    try {
                        await onProduced(createdIds);
                    } catch (error) {
                        message.error(`改编触发失败：${error instanceof Error ? error.message : String(error)}`);
                    }
                } else {
                    message.info("新集已建立，可在制作页逐集改编");
                }
            }
        } catch (error) {
            message.error(`加入失败：${error instanceof Error ? error.message : String(error)}`);
        } finally {
            setCreating(false);
        }
    };

    return (
        <Modal
            open={open}
            title={<span className="flex items-center gap-2"><BookOpen className="size-4" /> 原著章节 · 继续选章</span>}
            onCancel={onClose}
            onOk={() => void handleOk()}
            okText={creating ? "建集中…" : "加入制作"}
            cancelText="取消"
            confirmLoading={creating}
            okButtonProps={{ disabled: creating || !reservedRows.length || selected.size === 0 || Boolean(problem) }}
            width={640}
            destroyOnClose
        >
            <div className="max-h-[55vh] space-y-3 overflow-y-auto">
                {!sourceScript.trim() ? (
                    <p className="text-xs text-muted-foreground">当前剧目没有原剧本正文，请先到「剧目规划 · 原剧本」录入或导入原文。</p>
                ) : rows.length === 0 ? (
                    <p className="text-xs text-muted-foreground">原文解析未产出章节，请到「剧目规划 · 原剧本」检查正文是否可用。</p>
                ) : (
                    <>
                        <div className="flex flex-wrap items-center gap-3 text-xs">
                            <span className="flex items-center gap-1"><span className="text-muted-foreground">每集</span>
                                <InputNumber size="small" min={1} max={MAX_CHAPTERS_PER_EPISODE} precision={0} value={perEpisode}
                                    onChange={(value) => setPerEpisodeDraft(Math.max(1, Math.min(MAX_CHAPTERS_PER_EPISODE, Number(value) || 1)))}
                                    aria-label="每集章数" />
                                <span className="text-muted-foreground">章（1–{MAX_CHAPTERS_PER_EPISODE}）</span>
                            </span>
                            <button type="button" className="text-primary hover:underline" onClick={() => selectAll(true)}>全选</button>
                            <button type="button" className="text-muted-foreground hover:underline" onClick={() => selectAll(false)}>全不选</button>
                            <span className="ml-auto text-muted-foreground">已选 {chosenRows.length} / {reservedRows.length} 章 · 将建成 {groups.length} 集（第 {startNumber} 集起）</span>
                        </div>
                        {problem ? (
                            <div className="flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/10 p-2 text-xs text-red-500" role="alert">
                                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                                <span>{problem}</span>
                            </div>
                        ) : null}
                        <div className="grid gap-1.5">
                            {rows.map((row) => {
                                const disabled = !reserved.has(row.index);
                                const warn = isWarn(row);
                                const note = noteOf(row);
                                return (
                                    <label key={row.index} className={cn(
                                        "flex cursor-pointer items-center gap-2 rounded-md border p-2 text-xs transition",
                                        disabled && "cursor-not-allowed opacity-60",
                                        !disabled && selected.has(row.index) ? "border-primary bg-primary/5" : "border-border hover:bg-muted/40",
                                        warn && "border-red-500/50 bg-red-500/5",
                                    )}>
                                        <input type="checkbox" className="size-3.5" disabled={disabled} checked={!disabled && selected.has(row.index)} onChange={(e) => toggle(row.index, e.target.checked)} />
                                        <span className="font-medium">第 {row.index} 章</span>
                                        <span className="min-w-0 flex-1 truncate text-muted-foreground">{row.title || ""}</span>
                                        <span className={cn("shrink-0 whitespace-nowrap tabular-nums", warn ? "font-semibold text-red-500" : "text-muted-foreground")}
                                            title={warn ? "超长或已被拆章，请核对原文" : undefined}>
                                            {warn ? <AlertTriangle className="mr-0.5 inline size-3 align-[-2px]" /> : null}
                                            {charsOf(row).toLocaleString("zh-CN")} 字{note ? ` · ${note}` : ""}
                                        </span>
                                        <button type="button" title="查看该章原文" onClick={(e) => { e.preventDefault(); e.stopPropagation(); setPreviewIndex(row.index); }}
                                            className="shrink-0 rounded px-1 text-[10px] text-primary hover:bg-primary/10">预览</button>
                                    </label>
                                );
                            })}
                        </div>
                        <div className="rounded-md border border-border bg-muted/20 p-2.5" data-studio-chapter-preview>
                            <div className="mb-1 flex items-baseline justify-between gap-2 text-[11px]">
                                <span className="font-medium">原文预览{previewChapter ? ` · ${previewChapter.title || `第 ${previewChapter.index} 章`}` : ""}</span>
                                <span className="shrink-0 text-muted-foreground">{previewChapter ? `${previewChapter.body.length} 字 · 最多展示 ${PREVIEW_CHARS} 字` : ""}</span>
                            </div>
                            <div className="max-h-32 overflow-y-auto whitespace-pre-wrap text-[11px] leading-relaxed text-muted-foreground">
                                {!previewChapter
                                    ? "没有可预览的章节。"
                                    : (previewChapter.body.slice(0, PREVIEW_CHARS) || "该章正文为空（可能只有章节标题），请到「剧目规划 · 原剧本」补充原文。")}
                            </div>
                        </div>
                        <p className="text-[10px] leading-relaxed text-muted-foreground">
                            默认只选接下来 {DEFAULT_SELECTED_CHAPTERS} 章，可手动增减；已加入制作的章不可再选并标注所属集号。勾选的预留章按「每 {perEpisode} 章一集」建成新集追加在末尾，点「加入制作」时把 excluded 和每集章数一起写回剧目规划。原文直接读取剧目规划已加载的 sourceScript，不另发请求；超限时先处理原文，不会截断。
                        </p>
                    </>
                )}
            </div>
        </Modal>
    );
}
