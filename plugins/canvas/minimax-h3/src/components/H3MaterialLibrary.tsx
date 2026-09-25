import { useEffect, useRef, useState } from "@infinite-canvas/plugin-sdk";
import type { CanvasNodeContext } from "@infinite-canvas/plugin-sdk";
import type { H3Ref, H3Segment } from "../types";
import { buildRestoreParamsPatch } from "../services/h3-segment-utils";
import { segmentsFor } from "../hooks/useH3Segments";
import { H3Icon } from "./H3Icon";
import { H3MaterialCard } from "./H3MaterialCard";
import { H3PreviewLightbox } from "./H3PreviewLightbox";
import { message } from "antd";

type Props = { ctx: CanvasNodeContext; outputs: H3Ref[]; segments: H3Segment[]; selected?: H3Segment; patchSelected: (patch: Partial<H3Segment>) => void };

export function H3MaterialLibrary({ ctx, outputs, segments, selected }: Props) {
    const [outputFilter, setOutputFilter] = useState<"all" | "current">(String(ctx.node.metadata?.minimaxOutputFilter || "") === "current" ? "current" : "all");
    const [historyOutputs, setHistoryOutputs] = useState<H3Ref[]>([]);
    const [previewRef, setPreviewRef] = useState<H3Ref | null>(null);
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
    const outputRevision = outputs.map((item) => `${item.storageKey || item.url}:${item.segmentId || ""}`).join("|");
    useEffect(() => {
        let active = true;
        void ctx.generationLogs.list({ projectId: ctx.projectId, nodeId: ctx.node.id, limit: 200 }).then((logs) => {
            if (!active) return;
        const refs: H3Ref[] = [];
        for (const log of logs) {
            for (const [index, item] of (log.outputs || []).entries()) {
                const value = item && typeof item === "object" ? item as Record<string, unknown> : {};
                const url = String(value.url || value.video_url || "");
                if (!url) continue;
                const mimeType = String(value.mimeType || "video/mp4");
                const type: H3Ref["type"] = mimeType.startsWith("image/") ? "image" : mimeType.startsWith("audio/") ? "audio" : "video";
                refs.push({
                    url,
                    type,
                    name: String(value.name || `历史输出 ${index + 1}`),
                    storageKey: typeof value.storageKey === "string" ? value.storageKey : undefined,
                    mimeType,
                    segmentId: log.segmentId,
                    generationLogId: log.id,
                    params: { ...(log.params || {}), ...(log.prompt ? { prompt: log.prompt } : {}), refs: log.references || [] },
                });
            }
        }
            setHistoryOutputs(refs);
        }).catch(() => { if (active) setHistoryOutputs([]); });
        return () => { active = false; };
    }, [ctx.generationLogs, ctx.node.id, ctx.projectId, outputRevision]);
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
    const allOutputs = [...historyOutputs, ...outputs].filter((item, index, items) => items.findIndex((candidate) => candidate.url === item.url || (item.storageKey && candidate.storageKey === item.storageKey)) === index);
    const currentUrls = new Set((selected?.results || []).map((item) => item.url).concat(selected?.result ? [String(selected.result)] : []));
    const visibleOutputs = outputFilter === "current" ? allOutputs.filter((item) => currentUrls.has(item.url) || item.segmentId === selected?.id) : allOutputs;
    const restoreOutput = async (ref: H3Ref) => {
        // 输出卡片的点击可能发生在多个 metadata 更新之后，不能使用渲染时的旧 segments。
        // 从最新节点重新解析源 Clip，确保 prompt 和生成参数来自当前权威状态。
        const liveMetadata = ctx.getNode(ctx.node.id)?.metadata || ctx.node.metadata || {};
        const liveSegments = segmentsFor(liveMetadata);
        const source = ref.generationLogId ? ref : historyOutputs.find((item) => (item.storageKey && item.storageKey === ref.storageKey) || item.url === ref.url);
        if (!source?.generationLogId || !selected?.id) { message.error("缺少可验证的生成日志，无法还原输出"); return; }
        try {
            await ctx.flush();
            await ctx.ai.restoreH3Output({
                nodeId: ctx.node.id, segmentId: selected.id, generationLogId: source.generationLogId,
                storageKey: source.storageKey, settings: buildRestoreParamsPatch(liveSegments, source) as Record<string, unknown>,
            });
            message.success("已还原当前 Clip 的输出与参数");
        } catch (error) {
            message.error(error instanceof Error ? error.message : String(error));
        }
    };
    return <aside className="minimax-library">
        <div key="library-head" className="minimax-library-head"><H3Icon name="output" /> <span>Output</span><span className="minimax-output-actions"><button type="button" aria-label="切换输出筛选" aria-pressed={outputFilter === "current"} title={outputFilter === "all" ? "当前显示全部输出，点击只显示当前 Clip" : "当前只显示当前 Clip，点击显示全部输出"} onClick={() => changeOutputFilter(outputFilter === "all" ? "current" : "all")} className={`minimax-output-filter${outputFilter === "current" ? " active" : ""}`}><H3Icon name={outputFilter === "all" ? "filter-all" : "filter-current"} /></button></span></div>
        <div key="library-list" ref={listRef} className="minimax-library-list minimax-output-list" style={{ "--h3-out-card-h": `${cardH}px` } as React.CSSProperties}>{visibleOutputs.map((ref, index) => <H3MaterialCard key={`${ref.generationLogId || ref.type}-${ref.url}-${index}`} ctx={ctx} ref={ref} compact removable onRestore={() => void restoreOutput(ref)} onOpenPreview={() => setPreviewRef(ref)} />)}{!visibleOutputs.length ? <div key="empty-output" className="minimax-library-empty"><H3Icon name="output" /><span>Output</span></div> : null}</div>
        {previewRef ? <H3PreviewLightbox item={{ ...previewRef, url: previewRef.storageKey ? ctx.mediaUrl(previewRef.storageKey) : previewRef.url }} onClose={() => setPreviewRef(null)} /> : null}
    </aside>;
}
