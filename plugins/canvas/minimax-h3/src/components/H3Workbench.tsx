import { useEffect, useRef, useState } from "@infinite-canvas/plugin-sdk";
import type { CanvasNodeContentProps } from "@infinite-canvas/plugin-sdk";
import type { H3Ref, H3Segment } from "../types";
import { segmentsFor } from "../hooks/useH3Segments";
import { refsForSegment, resultUrl, withSegmentRefs } from "../services/h3-data";
import { normalizeDroppedH3Ref, readH3Refs } from "../services/h3-refs";
import { patchSelectedSegment } from "../services/h3-segment-utils";
import { H3PaneHandles, H3PlayheadStyle, H3PreviewPlayer, H3RulerScrubber, requestH3Run } from "./H3WorkbenchPrimitives";
import { SmartStoryboardModal } from "./SmartStoryboardModal";
import { H3CurrentClipPanel } from "./H3CurrentClipPanel";
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
    const outputs = [...(Array.isArray(metadata.materials) ? metadata.materials : []), ...segments.flatMap((item, index) => [...(item.results || []), ...(resultUrl(item.result) ? [{ url: resultUrl(item.result), type: "video", name: `Clip ${index + 1}`, storageKey: item.resultStorageKey, segmentId: item.id }] : [])])].map((item, index) => { const value = item && typeof item === "object" ? item as Record<string, unknown> : { url: String(item) } as Record<string, unknown>; const url = String(value.url || value.video_url || value.content || ""); const type = String(value.type || value.kind || "video").startsWith("image") ? "image" : String(value.type || value.kind || "video").startsWith("audio") ? "audio" : "video"; const segmentId = typeof value.segmentId === "string" ? value.segmentId : outputSegmentId(url); return url ? { url, type, name: String(value.name || `Clip ${index + 1}`), storageKey: typeof value.storageKey === "string" ? value.storageKey : undefined, segmentId } as H3Ref : null; }).filter((item): item is H3Ref => Boolean(item)).filter((item, index, all) => all.findIndex((other) => other.url === item.url) === index).reverse();
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
    const previewH = Math.max(130, Math.min(760, Number(metadata.minimaxPreviewH || 220)));
    const videoTrackH = Math.max(48, Math.min(180, Number(metadata.minimaxVideoTrackH || 74)));
    const libraryW = Math.max(170, Math.min(520, Number(metadata.minimaxLibraryW || 190)));
    const playRequest = Number(metadata.h3PlayRequest || 0);
    const [smartStoryboardOpen, setSmartStoryboardOpen] = useState(false);
    const [smartStoryboardUploads, setSmartStoryboardUploads] = useState<H3Ref[]>([]);
    const [canvasReferenceDragOver, setCanvasReferenceDragOver] = useState(false);
    const workbenchRef = useRef<HTMLDivElement | null>(null);
    const patchSelected = (patch: Partial<H3Segment>) => selected && patchSelectedSegment(ctx, { ...metadata, selectedSegmentId: selected.id }, patch);
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
        const ref: H3Ref = { url, type: "image", name: String(detail.name || "图片"), storageKey: typeof detail.storageKey === "string" ? detail.storageKey : undefined };
        const mode = String(selected.mode || selected.taskMode || "ref2va");
        if (mode === "t2v") return;
        const refs = refsForSegment(selected);
        const max = mode === "i2v" ? 1 : mode === "fl2v" ? 2 : 9;
        if (refs.filter((item) => item.type === "image").length >= max || refs.some((item) => item.url === ref.url)) return;
        const refTrack = workbenchRef.current?.querySelector<HTMLElement>(".minimax-ref-track");
        const x = Number(detail.clientX);
        const y = Number(detail.clientY);
        const rect = refTrack?.getBoundingClientRect();
        const inRefTrack = rect && Number.isFinite(x) && Number.isFinite(y) && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
        const time = inRefTrack ? Math.max(0, Math.min(1, (x - rect.left) / Math.max(1, rect.width))) * total : 0;
        const target = inRefTrack ? segments.find((item) => time >= Number(item.start || 0) && time < Number(item.start || 0) + Math.max(0.5, Number(item.duration || 1))) || selected : selected;
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
        <H3Runner ctx={ctx} />
        <H3PaneHandles ctx={ctx} />
        <H3PlayheadStyle percent={total ? (playhead / total) * 100 : 0} />
        <H3RulerScrubber ctx={ctx} total={total} previewH={previewH} libraryW={libraryW} />
        <H3WorkbenchToolbar ctx={ctx} metadata={metadata} segments={segments} selected={selected} selectedIndex={selectedIndex} outputs={outputs} playhead={playhead} total={total} fmt={fmt} onPlayAll={playAll} status={String(metadata.status || selected?.status || "idle")} error={String(metadata.errorDetails || metadata.error || "")} onRetry={() => requestH3Run(ctx)} />
        <SmartStoryboardModal ctx={ctx} metadata={metadata} upstream={upstream} open={smartStoryboardOpen} uploads={smartStoryboardUploads} setUploads={setSmartStoryboardUploads} onClose={() => setSmartStoryboardOpen(false)} />
        <style>{`.minimax-canvas-workbench{--minimax-library-w:${libraryW}px;--minimax-preview-h:${previewH}px;--minimax-video-h:${videoTrackH}px;--minimax-ref-h:144px}.minimax-canvas-workbench .minimax-wb-body{grid-template-columns:${libraryW}px minmax(0,1fr)}.minimax-canvas-workbench .minimax-wb-main{grid-template-rows:var(--minimax-preview-h) calc(28px + var(--minimax-video-h) + var(--minimax-ref-h)) minmax(150px,1fr)}.minimax-canvas-workbench .minimax-edit-timeline{grid-template-rows:28px var(--minimax-video-h) var(--minimax-ref-h)}`}</style>
        <div className="minimax-wb-body"><H3MaterialLibrary ctx={ctx} outputs={outputs} segments={segments} selected={selected} patchSelected={patchSelected} />
            <main className="minimax-wb-main"><div className="minimax-player-stage"><H3PreviewPlayer ctx={ctx} url={preview} kind={previewKind} storageKey={previewStorageKey} name={previewName} playhead={resultUrl(selected?.result) ? Math.max(0, playhead - Number(selected?.start || 0)) : playhead} timelineOffset={resultUrl(selected?.result) ? Number(selected?.start || 0) : 0} clipDuration={resultUrl(selected?.result) ? Number(selected?.duration || 0) : undefined} playRequest={playRequest} nextUrl={nextUrl} onEnded={advancePlayback} /></div>
                <H3Timeline ctx={ctx} segments={segments} selected={selected} total={total} onRemoveRef={removeTimelineRef} onPlayAll={playAll} fmt={fmt} />
                <H3CurrentClipPanel ctx={ctx} metadata={metadata} selected={selected} selectedIndex={selectedIndex} imageRefs={imageRefs} videoRefs={videoRefs} audioRefs={audioRefs} patchSelected={patchSelected} fmt={fmt} onOpenStoryboard={() => setSmartStoryboardOpen(true)} />
            </main>
        </div>
    </div>;
}
