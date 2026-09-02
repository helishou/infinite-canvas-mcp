import { useEffect, useRef } from "@infinite-canvas/plugin-sdk";
import type { CanvasNodeContext } from "@infinite-canvas/plugin-sdk";
import type { H3Ref } from "../types";
import { resultUrl } from "../services/h3-data";
import { segmentsFor } from "../hooks/useH3Segments";

export function requestH3Run(ctx: CanvasNodeContext, all = false) {
    const node = ctx.getNode(ctx.node.id) || ctx.node;
    const metadata = node.metadata || {};
    if (["queued", "loading"].includes(String(metadata.status || ""))) return;
    const segments = segmentsFor(metadata);
    const selectedId = String(metadata.selectedSegmentId || segments[0]?.id || "");
    const selected = segments.find((segment) => segment.id === selectedId) || segments[0];
    const prompt = String(selected?.prompt || metadata.prompt || "");
    ctx.updateMetadata({
        selectedSegmentId: selectedId,
        prompt,
        segments: segments.map((segment) => all || segment.id === selectedId ? { ...segment, prompt: segment.id === selectedId ? prompt : segment.prompt, status: "queued", progress: 0, runtimeTaskId: "" } : segment),
        status: "queued",
        runRequestId: `h3-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        runRequestAll: all,
        runRequestConsumedId: "",
        cancelRequested: false,
        runtimeTaskId: "",
        runProgress: 0,
    });
}

export function resetH3Run(ctx: CanvasNodeContext) {
    const node = ctx.getNode(ctx.node.id) || ctx.node;
    const segments = segmentsFor(node.metadata || {}).map((segment) => ({ ...segment, result: "", results: [], status: "idle", progress: 0, runtimeTaskId: "" }));
    ctx.updateMetadata({ content: "", mimeType: undefined, naturalWidth: undefined, naturalHeight: undefined, durationMs: undefined, materials: [], segments, status: "idle", errorDetails: "", runtimeTaskId: "", runProgress: 0, runRequestId: "", runRequestConsumedId: "", cancelRequested: false, runFinishedAt: undefined });
}

export function H3StatusBadge({ status, error, onRetry }: { status: string; error: string; onRetry: () => void }) {
    if (!status || status === "idle") return null;
    const label = status === "queued" ? "排队中…" : status === "loading" ? "生成中…" : status === "success" ? "已完成" : status === "cancelled" ? "已取消" : status === "error" ? `失败：${error || "未知错误"}` : status;
    return <div className={`minimax-status-badge ${status}`}><span>{label}</span>{status === "error" ? <button type="button" onClick={(event) => { event.stopPropagation(); onRetry(); }}>重试</button> : null}</div>;
}

export function H3PlayheadStyle({ percent }: { percent: number }) {
    const safe = Math.max(0, Math.min(100, percent));
    const position = `calc(52px + ${safe}% - ${safe * 1.06}px)`;
    return <style>{`.minimax-canvas-workbench .minimax-edit-timeline::after{left:${position}}.minimax-canvas-workbench .minimax-edit-timeline::before{content:"";display:block;position:absolute;z-index:15;top:0;left:${position};width:0;height:0;border-left:6px solid transparent;border-right:6px solid transparent;border-top:8px solid #f8fafc;transform:translateX(-50%);pointer-events:none}`}</style>;
}

export function H3PaneHandles({ ctx }: { ctx: CanvasNodeContext }) {
    const handle = (pane: "library" | "preview" | "video" | "refs", className: string) => <H3ResizeHandle key={pane} ctx={ctx} pane={pane} className={className} />;
    return <div style={{ display: "contents" }}>{handle("library", "minimax-pane-resize minimax-library-resize")}{handle("preview", "minimax-pane-resize minimax-preview-resize")}{handle("video", "minimax-pane-resize minimax-video-resize")}{handle("refs", "minimax-pane-resize minimax-ref-resize")}</div>;
}

function H3ResizeHandle({ ctx, pane, className }: { ctx: CanvasNodeContext; pane: "library" | "preview" | "video" | "refs"; className: string }) {
    const drag = useRef<{ x: number; y: number; value: number } | null>(null);
    const onPointerDown = (event: React.PointerEvent<HTMLSpanElement>) => {
        event.preventDefault();
        event.stopPropagation();
        const metadata = ctx.node.metadata || {};
        const value = pane === "library" ? Number(metadata.minimaxLibraryW || 190) : pane === "preview" ? Number(metadata.minimaxPreviewH || 220) : pane === "video" ? Number(metadata.minimaxVideoTrackH || 74) : Number(metadata.minimaxRefLaneH || 36);
        drag.current = { x: event.clientX, y: event.clientY, value };
        event.currentTarget.setPointerCapture(event.pointerId);
    };
    const onPointerMove = (event: React.PointerEvent<HTMLSpanElement>) => {
        if (!drag.current) return;
        const bounds: Record<typeof pane, [number, number, number]> = { library: [170, 520, drag.current.value + event.clientX - drag.current.x], preview: [130, 760, drag.current.value + event.clientY - drag.current.y], video: [48, 180, drag.current.value + event.clientY - drag.current.y], refs: [30, 130, drag.current.value + event.clientY - drag.current.y] };
        const [min, max, next] = bounds[pane];
        const key = pane === "library" ? "minimaxLibraryW" : pane === "preview" ? "minimaxPreviewH" : pane === "video" ? "minimaxVideoTrackH" : "minimaxRefLaneH";
        ctx.updateMetadata({ [key]: Math.round(Math.max(min, Math.min(max, next))) });
    };
    return <span className={className} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={(event) => { drag.current = null; event.currentTarget.releasePointerCapture(event.pointerId); }} />;
}

export function H3RulerScrubber({ ctx, total, previewH, libraryW }: { ctx: CanvasNodeContext; total: number; previewH: number; libraryW: number }) {
    const apply = (event: React.PointerEvent<HTMLDivElement>) => {
        const rect = event.currentTarget.getBoundingClientRect();
        ctx.updateMetadata({ playhead: Math.max(0, Math.min(total, ((event.clientX - rect.left) / Math.max(1, rect.width)) * total)) });
    };
    return <div className="minimax-ruler-scrubber" style={{ left: `calc(${libraryW}px + 68px)`, top: `calc(50px + ${previewH}px + 8px)` }} onPointerDown={(event) => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); apply(event); }} onPointerMove={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) apply(event); }} />;
}

export function H3PreviewPlayer({ ctx, url, kind, storageKey, name, playhead, timelineOffset = 0, clipDuration, playRequest, nextUrl, onEnded }: { ctx: CanvasNodeContext; url: string; kind: H3Ref["type"]; storageKey?: string; name?: string; playhead: number; timelineOffset?: number; clipDuration?: number; playRequest: number; nextUrl?: string; onEnded?: () => void }) {
    const mediaRef = useRef<HTMLVideoElement | HTMLAudioElement | null>(null);
    const preloadRef = useRef<HTMLVideoElement | null>(null);
    const onEndedRef = useRef(onEnded);
    useEffect(() => { onEndedRef.current = onEnded; }, [onEnded]);
    // 监听 video/audio 原生 ended 事件（视频完整播完后触发，驱动 advancePlayback 换段）
    useEffect(() => {
        const media = mediaRef.current;
        if (!media) return;
        const handler = () => { onEndedRef.current?.(); };
        media.addEventListener("ended", handler);
        return () => media.removeEventListener("ended", handler);
    }, [url]);
    useEffect(() => { const media = mediaRef.current; if (!media || !playRequest) return; if (media.paused) void media.play().catch(() => undefined); else media.pause(); }, [playRequest]);
    // 预加载下一个 clip 的视频（只暖缓存，不手动切 DOM；切换统一走 advancePlayback → React 更新 src）
    useEffect(() => {
        if (!nextUrl) { preloadRef.current = null; return; }
        const video = document.createElement("video");
        video.src = nextUrl;
        video.preload = "auto";
        video.muted = true;
        preloadRef.current = video;
    }, [nextUrl]);
    // 支持把输出视频/图片拖到画布变成独立节点（复用 storageKey，不重新上传）
    const handleDragStart = (event: React.DragEvent<HTMLDivElement>) => {
        const payload = JSON.stringify({ url, type: kind, kind, name: name || "H3 输出", storageKey });
        event.dataTransfer.effectAllowed = "copy";
        event.dataTransfer.setData("application/x-infinite-canvas-ref", payload);
        event.dataTransfer.setData("application/json", payload);
        event.dataTransfer.setData("text/plain", payload);
    };
    if (!url) return <div className="minimax-player-content"><div className="minimax-player-empty">连接视频和角色参考图</div></div>;
    if (kind === "image") return <div className="minimax-player-content minimax-player-image" draggable onDragStart={handleDragStart}><img src={url} alt="H3 reference" draggable={false} /></div>;
    if (kind === "audio") return <div className="minimax-player-content" draggable onDragStart={handleDragStart}><div className="minimax-player-empty"><audio ref={(node) => { mediaRef.current = node; }} src={url} controls preload="metadata" draggable={false} /></div></div>;
    return <div className="minimax-player-content"><video ref={(node) => { mediaRef.current = node; }} src={resultUrl(url)} controls muted playsInline draggable={false} onLoadedMetadata={(event) => { event.currentTarget.currentTime = Math.max(0, Math.min(Number(event.currentTarget.duration || Infinity), playhead)); }} onTimeUpdate={(event) => { const media = event.currentTarget; const dur = Number(media.duration || 0); const effectiveDur = Number.isFinite(Number(clipDuration)) && Number(clipDuration) > 0 ? Math.min(Number(clipDuration), dur || Number(clipDuration)) : dur; const local = Math.max(0, Math.min(Number(media.currentTime || 0), effectiveDur)); const time = timelineOffset + local; if (Math.abs(time - Number(ctx.node.metadata?.playhead || 0)) > 0.2) ctx.updateMetadata({ playhead: time }); }} /></div>;
}
