import { useEffect, useRef, useState, useCallback } from "@infinite-canvas/plugin-sdk";
import type { CanvasNodeContentProps } from "@infinite-canvas/plugin-sdk";
import type { H3Ref, H3Segment } from "../types";
import { segmentsFor } from "../hooks/useH3Segments";
import { refsForSegment, resultUrl, withSegmentRefs } from "../services/h3-data";
import { normalizeDroppedH3Ref, readH3Refs } from "../services/h3-refs";
import { patchSelectedSegment } from "../services/h3-segment-utils";
import { H3PaneHandles, H3PreviewPlayer, H3RulerScrubber, H3StatusBadge, h3SolveRows, requestH3Run } from "./H3WorkbenchPrimitives";
import { SmartStoryboardModal } from "./SmartStoryboardModal";
import { H3CurrentClipPanel } from "./H3CurrentClipPanel";
import { H3ClipSettingsPanel } from "./H3ClipSettingsPanel";
import { H3Timeline } from "./H3Timeline";
import { H3MaterialLibrary } from "./H3MaterialLibrary";
import { H3Runner } from "./H3Runner";
import { H3WorkbenchToolbar } from "./H3WorkbenchToolbar";

export function H3ContentExact({ ctx }: CanvasNodeContentProps) {
    const metadata = ctx.node.metadata || {};
    const segments = segmentsFor(metadata);
    const selected = segments.find((item) => item.id === String(metadata.selectedSegmentId || "")) || segments[0];
    const selectedIndex = Math.max(0, segments.findIndex((item) => item.id === selected?.id));
    const upstream = readH3Refs(ctx);
    const selectedRefs = selected ? refsForSegment(selected) : [];
    const outputSegmentId = (url: string) => segments.find((segment) => resultUrl(segment.result) === url || (segment.results || []).some((item) => item.url === url))?.id;
    const outputs = [...(Array.isArray(metadata.materials) ? metadata.materials : []), ...segments.flatMap((item, index) => [...(item.results || []), ...(resultUrl(item.result) ? [{ url: resultUrl(item.result), type: "video", name: `Clip ${index + 1}`, storageKey: item.resultStorageKey, segmentId: item.id }] : [])])].map((item, index) => { const value = item && typeof item === "object" ? item as Record<string, unknown> : { url: String(item) } as Record<string, unknown>; const url = String(value.url || value.video_url || value.content || ""); const type = String(value.type || value.kind || "video").startsWith("image") ? "image" : String(value.type || value.kind || "video").startsWith("audio") ? "audio" : "video"; const segmentId = typeof value.segmentId === "string" ? value.segmentId : outputSegmentId(url); return url ? { url, type, name: String(value.name || `Clip ${index + 1}`), storageKey: typeof value.storageKey === "string" ? value.storageKey : undefined, segmentId, params: value.params && typeof value.params === "object" ? value.params as Record<string, unknown> : undefined } as H3Ref : null; }).filter((item): item is H3Ref => Boolean(item)).filter((item, index, all) => all.findIndex((other) => other.url === item.url) === index).reverse();
    const total = Math.max(1, segments.reduce((sum, item) => sum + Math.max(0.5, Number(item.duration || 1)), 0));
    const playhead = Math.max(0, Math.min(total, Number(metadata.playhead || 0)));
    const fmt = (value: number) => `${Number(value || 0).toFixed(Number(value || 0) % 1 ? 1 : 0)}s`;
    const selectedVideo = selectedRefs.find((item) => item.type === "video");
    const selectedImage = selectedRefs.find((item) => item.type === "image");
    const selectedOwnPreview = resultUrl(selected?.result) || selectedVideo?.url || selectedImage?.url || "";
    const preview = selectedOwnPreview || (selectedIndex === 0 ? String(metadata.content || upstream.find((item) => item.type === "video")?.url || "") : "");
    const selectedResultRef = (selected?.results || []).find((item) => resultUrl(item.url) === preview || item.url === preview);
    const previewKind: H3Ref["type"] = selectedResultRef?.type || (resultUrl(selected?.result) ? "video" : selectedVideo ? "video" : selectedImage ? "image" : "video");
    const previewStorageKey = selectedResultRef?.storageKey || (resultUrl(selected?.result) ? selected?.resultStorageKey : (upstream.find((item) => item.url === preview)?.storageKey)) || undefined;
    const previewName = selectedResultRef?.name || (resultUrl(selected?.result) ? `Clip ${selectedIndex + 1}` : "H3 输出");
    const imageRefs = selectedRefs.filter((item) => item.type === "image");
    const videoRefs = selectedRefs.filter((item) => item.type === "video");
    const audioRefs = selectedRefs.filter((item) => item.type === "audio");
    const previewH = Math.max(130, Math.min(2000, Number(metadata.minimaxPreviewH || 220)));
    const promptW = Math.max(220, Math.min(900, Number(metadata.minimaxPromptW || 480)));
    const previewW = Math.max(280, Math.min(1400, Number(metadata.minimaxPreviewW || 960)));
    // 行高模型：行1(预览+当前Clip) 与 行2(时间轴) 固定 px，行3(Output 素材库) 吃剩余高度；
    // Refs 行高可独立调节；时间轴面板高度下限联动 Refs 行高：
    // 面板内部固定需求 = controls 44 + 刻度尺 28 + Video 行最低 ~110 + Refs 行高 + 余量，
    // 低于该值时 Refs 被压扁、刻度被裁、行与行重叠（历史 metadata 里的过小值会自动抬升）。
    const refLaneRaw = Math.max(60, Math.min(900, Number(metadata.minimaxRefLaneH || 150)));
    const timelineH = Math.max(190 + refLaneRaw, Math.min(2000, Number(metadata.minimaxTimelineH || 320)));
    const refLaneH = Math.min(refLaneRaw, timelineH - 190);
    // 行高预算：节点被画布手动压小、行1+行2+Output 装不下时连续收敛
    //（预览先让到 130 → 时间轴再让到 max(250, 190+Refs) 下限，Output 始终保底 80）。
    // 求解函数与拖拽侧共用（h3SolveRows）；挤压态的收敛值由 H3PaneHandles 回写 metadata，保持「存的值 = 看到的值」。
    const bodyRef = useRef<HTMLDivElement | null>(null);
    const [bodyH, setBodyH] = useState(0);
    useEffect(() => {
        const el = bodyRef.current;
        if (!el) return;
        const ro = new ResizeObserver(() => setBodyH(el.clientHeight));
        ro.observe(el);
        setBodyH(el.clientHeight);
        return () => ro.disconnect();
    }, []);
    const solved = bodyH > 0 ? h3SolveRows(bodyH, previewH, timelineH, refLaneH) : { p: previewH, t: timelineH, r: refLaneH };
    const effPreviewH = solved.p;
    const effTimelineH = solved.t;
    const effRefLaneH = solved.r;
    const playRequest = Number(metadata.h3PlayRequest || 0);
    const [smartStoryboardOpen, setSmartStoryboardOpen] = useState(false);
    const [smartStoryboardUploads, setSmartStoryboardUploads] = useState<H3Ref[]>([]);
    const [canvasReferenceDragOver, setCanvasReferenceDragOver] = useState(false);
    const workbenchRef = useRef<HTMLDivElement | null>(null);
    const patchSelected = useCallback((patch: Partial<H3Segment>) => selected && patchSelectedSegment(ctx, { ...metadata, selectedSegmentId: selected.id }, patch), [ctx, metadata, selected]);
    const removeTimelineRef = (segmentId: string, ref: H3Ref) => ctx.updateMetadata({ segments: segments.map((item) => item.id === segmentId ? { ...item, refItems: refsForSegment(item).filter((entry) => entry.url !== ref.url), refs: { image: refsForSegment(item).filter((entry) => entry.url !== ref.url && entry.type === "image"), video: refsForSegment(item).filter((entry) => entry.url !== ref.url && entry.type === "video"), audio: refsForSegment(item).filter((entry) => entry.url !== ref.url && entry.type === "audio") } } : item) });
    const addDroppedReference = (event: React.DragEvent<HTMLElement>) => {
        if ((event.target as HTMLElement).closest(".minimax-ref-track")) return;
        event.preventDefault();
        event.stopPropagation();
        const ref = normalizeDroppedH3Ref(event);
        if (!ref || !selected) return;
        const mode = String(selected.mode || selected.taskMode || "ref2va");
        if (mode === "t2v" || (mode !== "ref2va" && ref.type !== "image")) return;
        const refs = refsForSegment(selected);
        const max = ref.type === "image" ? (mode === "i2v" ? 1 : mode === "fl2v" ? 2 : 9) : 3;
        if (refs.filter((item) => item.type === ref.type).length >= max || refs.some((item) => item.url === ref.url)) return;
        ctx.updateMetadata({ selectedSegmentId: selected.id, segments: segments.map((item) => item.id === selected.id ? withSegmentRefs(item, [...refs, ref]) : item) });
    };
    const addCanvasReference = (detail: Record<string, unknown>) => {
        const url = String(detail.url || "").trim();
        if (!url || !selected) return;
        const ref: H3Ref = { url, type: "image", name: String(detail.name || "图片"), storageKey: typeof detail.storageKey === "string" ? detail.storageKey : undefined, mimeType: typeof detail.mimeType === "string" ? detail.mimeType : undefined };
        const x = Number(detail.clientX);
        const y = Number(detail.clientY);
        // 优先用鼠标实际命中的 ref 格子（精确），避免坐标换算误差导致落点与悬停位置不符
        let target: H3Segment | undefined;
        if (Number.isFinite(x) && Number.isFinite(y)) {
            const hit = document.elementFromPoint(x, y)?.closest<HTMLElement>(".minimax-ref-grid");
            if (hit?.dataset.segmentId) target = segments.find((item) => item.id === hit.dataset.segmentId);
            if (!target) {
                // 兜底：基于 refs 栏内容坐标（含横向滚动偏移，100px/单位）换算时间，修正旧版按可见宽度比例映射的错位
                const refTrack = workbenchRef.current?.querySelector<HTMLElement>(".minimax-ref-track");
                const rect = refTrack?.getBoundingClientRect();
                if (rect && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
                    const contentX = (refTrack?.scrollLeft || 0) + (x - rect.left);
                    const time = Math.max(0, Math.min(total, contentX / 100));
                    target = segments.find((item) => time >= Number(item.start || 0) && time < Number(item.start || 0) + Math.max(0.5, Number(item.duration || 1))) || selected;
                }
            }
        }
        target = target || selected;
        // t2v 段不接收参考素材（格子为「无需参考素材」）
        const targetMode = String(target.mode || target.taskMode || "ref2va");
        if (targetMode === "t2v") return;
        const max = targetMode === "i2v" ? 1 : targetMode === "fl2v" ? 2 : 9;
        const targetRefs = refsForSegment(target);
        if (targetRefs.filter((item) => item.type === "image").length >= max || targetRefs.some((item) => item.url === ref.url)) return;
        ctx.updateMetadata({ selectedSegmentId: target.id, segments: segments.map((item) => item.id === target.id ? withSegmentRefs(item, [...targetRefs, ref]) : item) });
    };
    useEffect(() => {
        const onStart = (event: Event) => { const detail = (event as CustomEvent<Record<string, unknown>>).detail || {}; if (detail.targetNodeId === ctx.node.id) setCanvasReferenceDragOver(true); };
        const onOver = (event: Event) => { const detail = (event as CustomEvent<Record<string, unknown>>).detail || {}; if (detail.targetNodeId === ctx.node.id) setCanvasReferenceDragOver(true); };
        const onDrop = (event: Event) => { const detail = (event as CustomEvent<Record<string, unknown>>).detail || {}; if (detail.targetNodeId !== ctx.node.id) return; setCanvasReferenceDragOver(false); addCanvasReference(detail); };
        const onEnd = (event: Event) => { const detail = (event as CustomEvent<Record<string, unknown>>).detail || {}; if (detail.targetNodeId === ctx.node.id) setCanvasReferenceDragOver(false); };
        window.addEventListener("canvas-reference-drag-start", onStart);
        window.addEventListener("canvas-reference-drag-over", onOver);
        window.addEventListener("canvas-reference-drop", onDrop);
        window.addEventListener("canvas-reference-drag-end", onEnd);
        return () => { window.removeEventListener("canvas-reference-drag-start", onStart); window.removeEventListener("canvas-reference-drag-over", onOver); window.removeEventListener("canvas-reference-drop", onDrop); window.removeEventListener("canvas-reference-drag-end", onEnd); };
    }, [ctx.node.id, selected, segments, total]);
    // 找到 playhead 所在的 segment，从该位置开始播全部
    const startSegment = segments.find((seg) => {
        const segStart = Number(seg.start || 0);
        const segEnd = segStart + Math.max(0.5, Number(seg.duration || 1));
        return playhead >= segStart && playhead < segEnd && resultUrl(seg.result);
    }) || segments.find((item) => Boolean(resultUrl(item.result))) || segments[0];

    const playAll = () => {
        const fromSegment = startSegment;
        // 保留 playhead 在当前 clip 内的相对位置
        const localPlayhead = Math.max(0, playhead - Number(fromSegment.start || 0));
        ctx.updateMetadata({ selectedSegmentId: fromSegment.id, playhead: Number(fromSegment.start || 0) + localPlayhead, h3PlayRequest: Number(metadata.h3PlayRequest || 0) + 1, h3PlaybackAll: true });
    };
    const advancePlayback = () => {
        if (metadata.h3PlaybackAll !== true) return;
        const next = segments.slice(selectedIndex + 1).find((item) => Boolean(resultUrl(item.result)));
        if (!next) { ctx.updateMetadata({ h3PlaybackAll: false, playhead: total }); return; }
        ctx.updateMetadata({ selectedSegmentId: next.id, playhead: Number(next.start || 0), h3PlayRequest: Number(metadata.h3PlayRequest || 0) + 1 });
    };
    const nextSegment = segments.slice(selectedIndex + 1).find((item) => Boolean(resultUrl(item.result)));
    const nextUrl = nextSegment ? resultUrl(nextSegment.result) : undefined;
    const themeStyle = {
        "--h3-panel": ctx.theme.node.panel,
        "--h3-fill": ctx.theme.node.fill,
        "--h3-border": ctx.theme.node.stroke,
        "--h3-text": ctx.theme.node.text,
        "--h3-muted": ctx.theme.node.muted,
        "--h3-faint": ctx.theme.node.faint,
        "--h3-active": ctx.theme.node.activeStroke,
        "--h3-toolbar": ctx.theme.toolbar.panel,
        "--h3-hover": ctx.theme.toolbar.itemHover,
        "--h3-active-bg": ctx.theme.toolbar.activeBg,
        "--h3-active-text": ctx.theme.toolbar.activeText,
    } as React.CSSProperties;
    return <div ref={workbenchRef} className={`minimax-canvas-workbench${canvasReferenceDragOver ? " is-canvas-ref-drag-over" : ""}`} data-canvas-no-zoom data-canvas-ref-drop-target={ctx.node.id} style={themeStyle} onMouseDown={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()} onWheel={(event) => event.stopPropagation()} onDragOver={(event) => { event.preventDefault(); event.stopPropagation(); }} onDrop={addDroppedReference}>
        <H3Runner key="runner" ctx={ctx} />
        <H3PaneHandles key="pane-handles" ctx={ctx} />
        <H3RulerScrubber key="ruler-scrubber" ctx={ctx} total={total} previewH={effPreviewH} />
        <H3WorkbenchToolbar key="workbench-toolbar" ctx={ctx} metadata={metadata} segments={segments} selected={selected} selectedIndex={selectedIndex} outputs={outputs} playhead={playhead} total={total} fmt={fmt} onPlayAll={playAll} />
        <SmartStoryboardModal key="storyboard-modal" ctx={ctx} metadata={metadata} upstream={upstream} open={smartStoryboardOpen} uploads={smartStoryboardUploads} setUploads={setSmartStoryboardUploads} onClose={() => setSmartStoryboardOpen(false)} />
        <style key="workbench-style">{`.minimax-canvas-workbench{--minimax-prompt-w:${promptW}px;--minimax-preview-w:${previewW}px;--minimax-preview-h:${effPreviewH}px;--minimax-timeline-h:${effTimelineH}px;--minimax-ref-h:${effRefLaneH}px}`}</style>
        <div key="workbench-body" ref={bodyRef} className="minimax-wb-body">
            <div key="player-stage" className="minimax-player-stage"><H3PreviewPlayer ctx={ctx} url={preview} kind={previewKind} storageKey={previewStorageKey} name={previewName} playhead={resultUrl(selected?.result) ? Math.max(0, playhead - Number(selected?.start || 0)) : playhead} timelineOffset={resultUrl(selected?.result) ? Number(selected?.start || 0) : 0} clipDuration={resultUrl(selected?.result) ? Number(selected?.duration || 0) : undefined} playRequest={playRequest} nextUrl={nextUrl} onEnded={advancePlayback} /></div>
            <div key="prompt-side" className="minimax-prompt-side"><H3ClipSettingsPanel ctx={ctx} metadata={metadata} selected={selected} patchSelected={patchSelected} /></div>
            <H3Timeline key="timeline" ctx={ctx} segments={segments} selected={selected} total={total} onRemoveRef={removeTimelineRef} onPlayAll={playAll} fmt={fmt} />
            <H3MaterialLibrary key="material-library" ctx={ctx} outputs={outputs} segments={segments} selected={selected} patchSelected={patchSelected} />
            <H3CurrentClipPanel key="current-clip-panel" ctx={ctx} selected={selected} selectedIndex={selectedIndex} imageRefs={imageRefs} videoRefs={videoRefs} audioRefs={audioRefs} patchSelected={patchSelected} fmt={fmt} onOpenStoryboard={() => setSmartStoryboardOpen(true)} />
        </div>
        <div key="status" className="minimax-wb-status"><H3StatusBadge status={String(metadata.status || selected?.status || "idle")} error={String(metadata.errorDetails || metadata.error || "")} onRetry={() => requestH3Run(ctx)} />{String(metadata.smartStoryboardStatus || "") === "loading" ? <span style={{ marginLeft: 8, color: "#f59e0b", fontSize: 24 }}>智能分镜正在分析参考图并生成提示词，请稍候…</span> : null}{String(metadata.smartStoryboardStatus || "") === "success" ? <span style={{ marginLeft: 8, color: "#22c55e", fontSize: 24 }}>智能分镜已完成</span> : null}{String(metadata.smartStoryboardStatus || "") === "error" ? <span style={{ marginLeft: 8, color: "#ef4444", fontSize: 24 }}>智能分镜生成失败</span> : null}</div>
    </div>;
}
