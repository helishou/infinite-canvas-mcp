import { useCallback, useEffect, useMemo, useRef, useState } from "@infinite-canvas/plugin-sdk";
import type { CanvasNodeContext } from "@infinite-canvas/plugin-sdk";
import type { H3Ref, H3Segment } from "../types";
import { buildRestoreParamsPatch } from "../services/h3-segment-utils";
import { segmentsFor } from "../hooks/useH3Segments";
import { H3Icon } from "./H3Icon";
import { H3MaterialCard } from "./H3MaterialCard";
import { message } from "antd";
import { h3Label, useH3Locale } from "../h3-locale";
import { buildH3OutputPreview } from "../services/h3-output-preview";

type Props = { ctx: CanvasNodeContext; outputs: H3Ref[]; segments: H3Segment[]; selected?: H3Segment; patchSelected: (patch: Partial<H3Segment>) => void };
const HISTORY_PAGE_SIZE = 40;

/** 历史输出卡片的时间后缀：MM-DD HH:mm:ss，跨天也能区分；解析失败返回空串。 */
function formatOutputTime(value?: string): string {
    if (!value) return "";
    const at = new Date(value);
    if (Number.isNaN(at.getTime())) return "";
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
}

export function H3MaterialLibrary({ ctx, outputs, segments, selected }: Props) {
    const locale = useH3Locale();
    const [outputFilter, setOutputFilter] = useState<"all" | "current">(String(ctx.node.metadata?.minimaxOutputFilter || "") === "current" ? "current" : "all");
    const [historyOutputs, setHistoryOutputs] = useState<H3Ref[]>([]);
    const [historyLoading, setHistoryLoading] = useState(false);
    const [historyHasMore, setHistoryHasMore] = useState(true);
    const historyStateRef = useRef<{ key: string; offset: number; loading: boolean; hasMore: boolean; perSegmentCount: Map<string, number>; seenLogIds: Set<string> }>({ key: "", offset: 0, loading: false, hasMore: true, perSegmentCount: new Map(), seenLogIds: new Set() });
    // Output 固定单行横向滚动：卡片高度实测面板可用高度自适应（78–380px），宽度=高度×2 保持 2:1。
    const listRef = useRef<HTMLDivElement | null>(null);
    const [cardH, setCardH] = useState(78);
    // Output 区域滚轮横向滚动：在滚动条区域滚动时把纵向转为横向
    useEffect(() => {
        const el = listRef.current;
        if (!el) return;
        const onWheel = (e: WheelEvent) => {
            if (e.deltaY !== 0) {
                e.preventDefault();
                el.scrollLeft += e.deltaY;
            }
        };
        el.addEventListener("wheel", onWheel, { passive: false });
        return () => el.removeEventListener("wheel", onWheel);
    }, []);
    const segmentKey = segments.map((item) => item.id).join("|");
    const segmentIndexes = useMemo(() => new Map(segments.map((item, index) => [item.id, index])), [segmentKey]);
    const historyQueryKey = `${ctx.projectId}:${ctx.node.id}:${segmentKey}`;
    const loadNextHistoryPage = useCallback(async () => {
        const state = historyStateRef.current;
        if (state.key !== historyQueryKey || state.loading || !state.hasMore) return;
        state.loading = true;
        setHistoryLoading(true);
        const pageOffset = state.offset;
        try {
            const logs = await ctx.generationLogs.list({ projectId: ctx.projectId, nodeId: ctx.node.id, limit: HISTORY_PAGE_SIZE, offset: pageOffset });
            if (historyStateRef.current !== state) return;
            state.offset += logs.length;
            state.hasMore = logs.length === HISTORY_PAGE_SIZE;
            setHistoryHasMore(state.hasMore);
            const refs: H3Ref[] = [];
            // 同一个 Clip 会跑出多条历史输出；序号跨分页累计，不能用 log.outputs 的下标。
            for (const log of logs) {
                if (state.seenLogIds.has(log.id)) continue;
                state.seenLogIds.add(log.id);
                for (const item of log.outputs || []) {
                    const value = item && typeof item === "object" ? item as Record<string, unknown> : {};
                    const url = String(value.url || value.video_url || "");
                    if (!url) continue;
                    const mimeType = String(value.mimeType || "video/mp4");
                    const type: H3Ref["type"] = mimeType.startsWith("image/") ? "image" : mimeType.startsWith("audio/") ? "audio" : "video";
                    const clipKey = String(log.segmentId || "");
                    const seq = (state.perSegmentCount.get(clipKey) || 0) + 1;
                    state.perSegmentCount.set(clipKey, seq);
                    const clipNo = clipKey ? segmentIndexes.get(clipKey) ?? -1 : -1;
                    const clipLabel = clipNo >= 0 ? `Clip ${clipNo + 1}` : clipKey ? "已删除 Clip" : "未知 Clip";
                    const stamp = formatOutputTime(log.finishedAt || log.createdAt);
                    refs.push({
                        url,
                        type,
                        name: String(value.name || `${clipLabel} · #${seq}${stamp ? ` · ${stamp}` : ""}`),
                        storageKey: typeof value.storageKey === "string" ? value.storageKey : undefined,
                        mimeType,
                        segmentId: log.segmentId,
                        generationLogId: log.id,
                        taskId: log.runtimeTaskId,
                        params: { ...(log.params || {}), ...(log.prompt ? { prompt: log.prompt } : {}), refs: log.references || [] },
                    });
                }
            }
            setHistoryOutputs((current) => pageOffset === 0 ? refs : [...current, ...refs]);
        } catch {
            state.hasMore = false;
            setHistoryHasMore(false);
            if (pageOffset === 0) setHistoryOutputs([]);
        } finally {
            if (historyStateRef.current === state) {
                state.loading = false;
                setHistoryLoading(false);
            }
        }
    }, [ctx.generationLogs, ctx.node.id, ctx.projectId, historyQueryKey, segmentIndexes]);
    useEffect(() => {
        const state = { key: historyQueryKey, offset: 0, loading: false, hasMore: true, perSegmentCount: new Map<string, number>(), seenLogIds: new Set<string>() };
        historyStateRef.current = state;
        setHistoryOutputs([]);
        setHistoryHasMore(true);
        void loadNextHistoryPage();
    }, [historyQueryKey, loadNextHistoryPage]);
    useEffect(() => {
        const list = listRef.current;
        if (outputFilter === "all" && !historyLoading && historyHasMore && list?.clientWidth && list.scrollWidth <= list.clientWidth) void loadNextHistoryPage();
    }, [historyOutputs.length, historyLoading, historyHasMore, outputFilter, loadNextHistoryPage]);
    useEffect(() => {
        // 测量父容器（.minimax-library）的可用高度，而非 listRef 自身：
        // listRef 是 grid 容器，其高度由 --h3-out-card-h 决定，若测量自身会形成
        // cardH → CSS → 容器高度 → ResizeObserver → cardH 的死循环，导致卡片尺寸持续跳变。
        const parent = listRef.current?.parentElement;
        if (!parent) return;
        const measure = () => {
            const style = window.getComputedStyle(parent);
            // 从 grid-template-rows 解析第一行（header）高度，避免魔法数
            const gridRows = style.gridTemplateRows.split(" ");
            const headerRowH = parseFloat(gridRows[0]) || 60;
            const availH = parent.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom) - headerRowH;
            if (availH <= 40) return;
            const next = Math.round(Math.max(78, Math.min(380, availH)));
            setCardH((prev) => (Math.abs(prev - next) > 1 ? next : prev));
        };
        const ro = new ResizeObserver(measure);
        ro.observe(parent);
        measure();
        return () => ro.disconnect();
    }, []);
    const changeOutputFilter = (next: "all" | "current") => { setOutputFilter(next); ctx.updateMetadata({ minimaxOutputFilter: next }); };
    const allOutputs = useMemo(() => {
        const seenUrls = new Set<string>();
        const seenStorageKeys = new Set<string>();
        const unique: H3Ref[] = [];
        for (const item of [...historyOutputs, ...outputs]) {
            if (seenUrls.has(item.url) || item.storageKey && seenStorageKeys.has(item.storageKey)) continue;
            seenUrls.add(item.url);
            if (item.storageKey) seenStorageKeys.add(item.storageKey);
            unique.push(item);
        }
        return unique;
    }, [historyOutputs, outputs]);
    const currentUrls = new Set((selected?.results || []).map((item) => item.url).concat(selected?.result ? [String(selected.result)] : []));
    const visibleOutputs = outputFilter === "current" ? allOutputs.filter((item) => currentUrls.has(item.url) || item.segmentId === selected?.id) : allOutputs;
    const restoreOutput = async (ref: H3Ref) => {
        // 输出卡片的点击可能发生在多个 metadata 更新之后，不能使用渲染时的旧 segments。
        // 从最新节点重新解析源 Clip，确保 prompt 和生成参数来自当前权威状态。
        const liveMetadata = ctx.getNode(ctx.node.id)?.metadata || ctx.node.metadata || {};
        const liveSegments = segmentsFor(liveMetadata);
        let source = ref.generationLogId ? ref : historyOutputs.find((item) => (item.storageKey && item.storageKey === ref.storageKey) || item.url === ref.url);
        if (!source?.generationLogId || !selected?.id) { message.error("缺少可验证的生成日志，无法还原输出"); return; }
        const generationLogId = source.generationLogId;
        const formal = Boolean(liveSegments.find(segment => segment.id === selected.id)?.productionClipProjection);
        if (formal && source.segmentId !== selected.id) { message.error("该历史输出属于其他 Clip，请先选择对应 Clip 再选用"); return; }
        try {
            if (!formal && source.taskId && !source.params) {
                const logs = await ctx.generationLogs.list({ projectId: ctx.projectId, nodeId: ctx.node.id, runtimeTaskId: source.taskId, limit: 1 });
                const log = logs.find((item) => item.id === generationLogId);
                if (log) source = { ...source, params: { ...log.params, ...(log.prompt ? { prompt: log.prompt } : {}), refs: log.references || [] } };
            }
            await ctx.flush();
            await ctx.ai.restoreH3Output({
                nodeId: ctx.node.id, segmentId: selected.id, generationLogId,
                storageKey: source.storageKey, settings: formal ? {} : buildRestoreParamsPatch(liveSegments, source, selected) as Record<string, unknown>,
            });
            if (!formal) message.success("已还原当前 Clip 的输出与参数");
        } catch (error) {
            message.error(error instanceof Error ? error.message : String(error));
        }
    };
    return <aside className="minimax-library">
        <div key="library-head" className="minimax-library-head"><H3Icon name="output" /> <span>{h3Label(locale, "output")}</span><span className="minimax-output-actions"><button type="button" aria-label="切换输出筛选" aria-pressed={outputFilter === "current"} title={outputFilter === "all" ? "当前显示全部输出，点击只显示当前 Clip" : "当前只显示当前 Clip，点击显示全部输出"} onClick={() => changeOutputFilter(outputFilter === "all" ? "current" : "all")} className={`minimax-output-filter${outputFilter === "current" ? " active" : ""}`}><H3Icon name={outputFilter === "all" ? "filter-all" : "filter-current"} /></button></span></div>
        <div key="library-list" ref={listRef} className="minimax-library-list minimax-output-list" style={{ "--h3-out-card-h": `${cardH}px` } as React.CSSProperties} onScroll={(event) => { const list = event.currentTarget; if (outputFilter === "all" && list.scrollLeft + list.clientWidth >= list.scrollWidth - 240) void loadNextHistoryPage(); }}>{visibleOutputs.map((ref, index) => <H3MaterialCard key={ref.generationLogId ? `log:${ref.generationLogId}:${ref.storageKey || ref.url}` : `media:${ref.segmentId || ref.type}:${ref.storageKey || ref.url}`} ctx={ctx} ref={ref} locale={locale} compact removable restoreTitle={selected?.productionClipProjection ? "设为当前输出（保留当前提示词与参数）" : undefined} onRestore={() => void restoreOutput(ref)} onOpenPreview={() => { const preview = buildH3OutputPreview(visibleOutputs, index, ctx.mediaUrl); if (preview) ctx.openMediaPreview(preview); }} />)}{!visibleOutputs.length ? <div key="empty-output" className="minimax-library-empty"><H3Icon name="output" /><span>{h3Label(locale, "output")}</span></div> : null}</div>
    </aside>;
}
