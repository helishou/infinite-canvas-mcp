import { useMemo, useState } from "react";
import { App, Modal } from "antd";
import { BookOpen } from "lucide-react";

import { analyzeNovelChapters } from "@basketikun/canvas-agent/drama/novel-chapters";
import { buildEpisodeGroups, groupSynopsis, toChapterRows, type AdaptChapterRow } from "@/lib/drama/adapt";
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
const EPISODE_SOURCE_CHARS = 40000;

/**
 * 影策「原著还有 N 章 · 继续选章」的本地实现（受控 Modal 组件）。
 *
 * 真值只有一份：folder.productionPlan.sourceScript（原文）+ sourceSplit.excluded（预留章序号）。
 * 勾选预留章 → 写回 excluded（走 upsertBackendCanvasFolder，与剧目规划同源）→ 按共享拆章口径建集 → 立即建画布。
 * 不新增第二份章节真值；章数、编组全部由同一份拆章逻辑派生。
 */
export function StudioChapterPickerModal({ folder, episodes, open, onClose, onDone }: {
    folder: CanvasFolder | null;
    episodes: DramaEpisode[];
    open: boolean;
    onClose: () => void;
    onDone: () => void | Promise<void>;
}) {
    const { message } = App.useApp();
    const [overrides, setOverrides] = useState<Record<number, { selected?: boolean }>>({});
    const [creating, setCreating] = useState(false);

    const plan = (folder?.productionPlan || {}) as Record<string, unknown>;
    const sourceScript = String(plan.sourceScript || "");
    const split = (plan.sourceSplit || {}) as Record<string, unknown>;
    const excluded = Array.isArray(split.excluded) ? (split.excluded as number[]) : [];
    const perEpisode = Number(split.perEpisode) || 1;
    const maxChars = Number(split.maxChars) || DEFAULT_MAX_CHARS;
    const excludedKey = excluded.join(",");
    const reserved = useMemo(() => new Set(excluded), [excludedKey]);

    const analysis = useMemo(() => {
        if (!sourceScript.trim()) return null;
        return analyzeNovelChapters(sourceScript, { maxChars, minChars: DEFAULT_MIN_CHARS });
    }, [sourceScript, maxChars]);

    const rows = useMemo<AdaptChapterRow[]>(() => (analysis?.chapters || []).map((chapter) => ({
        ...chapter,
        // 弹窗只处理预留章（在 excluded 里的）；默认按 excluded 决定勾选，override 可改。
        selected: (overrides[chapter.index]?.selected ?? !reserved.has(chapter.index)) && reserved.has(chapter.index),
        titleOverride: "",
    })), [analysis, overrides, reserved]);

    const reservedRows = useMemo(() => rows.filter((row) => reserved.has(row.index)), [rows, reserved]);
    const selectedCount = reservedRows.filter((row) => row.selected).length;

    const startNumber = episodes.reduce((max, ep) => Math.max(max, ep.episodeNumber), 0) + 1;
    const groups = useMemo(() => buildEpisodeGroups(
        reservedRows.filter((r) => r.selected).map((r) => ({ ...r, selected: true })),
        { perEpisode, startNumber },
    ), [reservedRows, perEpisode, startNumber]);

    const toggle = (index: number, selected: boolean) => {
        setOverrides((current) => ({ ...current, [index]: { ...current[index], selected } }));
    };
    const selectAll = (selected: boolean) => {
        setOverrides(Object.fromEntries(reservedRows.map((row) => [row.index, { selected }])));
    };

    const handleOk = async () => {
        if (!folder || !sourceScript.trim() || !groups.length) return;
        setCreating(true);
        try {
            // 1) 先把 excluded 写回剧目规划（与 planning-source-tab 同源，显式 patch，避免集建好原文没落库）。
            const newlyAdded = new Set(reservedRows.filter((r) => r.selected).map((r) => r.index));
            const newExcluded = excluded.filter((n) => !newlyAdded.has(n));
            const productionPlan = { ...plan, sourceSplit: { ...split, excluded: newExcluded } };
            const result = await upsertBackendCanvasFolder({
                ...folder,
                productionPlan,
                expectedPlanningUpdatedAt: folder.updatedAt || folder.createdAt,
                updatedAt: new Date().toISOString(),
            });
            useCanvasStore.setState((state) => ({
                folders: state.folders.map((item) => item.id === folder.id ? result.folder as unknown as CanvasFolder : item),
            }));

            // 2) 按共享拆章口径建集 + 立即建画布。
            const selectedRows = reservedRows.filter((r) => r.selected);
            let created = 0;
            for (const group of groups) {
                try {
                    const res = await createBackendDramaEpisode(folder.id, {
                        episodeNumber: group.episodeNumber,
                        title: group.title.slice(0, 60),
                        synopsis: groupSynopsis(selectedRows, group, EPISODE_SOURCE_CHARS),
                    });
                    if (res.episode && !res.episode.canvasId) {
                        await ensureEpisodeCanvas(res.episode.id).catch(() => undefined);
                    }
                    created += 1;
                } catch (error) {
                    message.error(`${group.label}：${error instanceof Error ? error.message : String(error)}`);
                    break;
                }
            }
            if (created) {
                message.success(`已加入 ${created} 集到制作`);
                setOverrides({});
                onClose();
                await onDone();
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
            okButtonProps={{ disabled: creating || !reservedRows.length || selectedCount === 0 }}
            width={640}
            destroyOnClose
        >
            <div className="max-h-[55vh] space-y-3 overflow-y-auto">
                {!sourceScript.trim() ? (
                    <p className="text-xs text-muted-foreground">当前剧目没有原剧本正文，请先到「剧目规划 · 原剧本」录入或导入原文。</p>
                ) : reservedRows.length === 0 ? (
                    <p className="text-xs text-muted-foreground">原著章节已全部加入制作，没有预留章节。</p>
                ) : (
                    <>
                        <div className="flex items-center gap-3 text-xs">
                            <button type="button" className="text-primary hover:underline" onClick={() => selectAll(true)}>全选</button>
                            <button type="button" className="text-muted-foreground hover:underline" onClick={() => selectAll(false)}>全不选</button>
                            <span className="ml-auto text-muted-foreground">已选 {selectedCount} / {reservedRows.length} 章 · 将建成 {groups.length} 集（第 {startNumber} 集起）</span>
                        </div>
                        <div className="grid gap-1.5">
                            {reservedRows.map((row) => (
                                <label key={row.index} className={cn("flex cursor-pointer items-center gap-2 rounded-md border p-2 text-xs transition", row.selected ? "border-primary bg-primary/5" : "border-border hover:bg-muted/40")}>
                                    <input type="checkbox" className="size-3.5" checked={row.selected} onChange={(e) => toggle(row.index, e.target.checked)} />
                                    <span className="font-medium">第 {row.index} 章</span>
                                    <span className="min-w-0 flex-1 truncate text-muted-foreground">{row.title || ""}</span>
                                </label>
                            ))}
                        </div>
                        <p className="text-[10px] leading-relaxed text-muted-foreground">
                            勾选的预留章会按「每 {perEpisode} 章一集」建成新集追加在末尾，补原文梗概并立即建画布；建集前把分集口径写回剧目规划。要改分集口径请到「剧目规划 · 原剧本」页。
                        </p>
                    </>
                )}
            </div>
        </Modal>
    );
}
