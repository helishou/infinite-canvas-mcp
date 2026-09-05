import { useEffect, useRef, useState } from "@infinite-canvas/plugin-sdk";
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

// 时间轴轨道按固定 50px/秒 铺（ruler tick 用 time*50px 定位，可横向滚动），
// 指针必须用同样的像素刻度定位，按轨道总宽百分比换算会在 total<10s（timelineWidth=500 兜底）时错位。
export function H3PlayheadStyle({ playhead, total }: { playhead: number; total: number }) {
    const safe = Math.max(0, Math.min(Number(total || 0), Number(playhead || 0)));
    const position = `calc(52px + ${safe * 50}px)`;
    return <style>{`.minimax-canvas-workbench .minimax-edit-timeline::after{left:${position};background:#3b82f6}.minimax-canvas-workbench .minimax-edit-timeline::before{content:"";display:block;position:absolute;z-index:15;top:0;left:${position};width:0;height:0;border-left:6px solid transparent;border-right:6px solid transparent;border-top:8px solid #3b82f6;transform:translateX(-50%);pointer-events:none}`}</style>;
}

export function H3PaneHandles({ ctx }: { ctx: CanvasNodeContext }) {
    const handle = (pane: "prompt" | "preview" | "previewWidth" | "refs" | "clip", className: string) => <H3ResizeHandle key={pane} ctx={ctx} pane={pane} className={className} />;
    return <div style={{ display: "contents" }}>{handle("prompt", "minimax-pane-resize minimax-prompt-resize")}{handle("previewWidth", "minimax-pane-resize minimax-preview-width-resize")}{handle("preview", "minimax-pane-resize minimax-preview-resize")}{handle("refs", "minimax-pane-resize minimax-ref-resize")}{handle("clip", "minimax-pane-resize minimax-clip-resize")}</div>;
}

function H3ResizeHandle({ ctx, pane, className }: { ctx: CanvasNodeContext; pane: "prompt" | "preview" | "previewWidth" | "refs" | "clip"; className: string }) {
    const drag = useRef<{ x: number; y: number; value: number } | null>(null);
    const onPointerDown = (event: React.PointerEvent<HTMLSpanElement>) => {
        event.preventDefault();
        event.stopPropagation();
        const metadata = ctx.node.metadata || {};
        const value = pane === "prompt" ? Number(metadata.minimaxPromptW || 480) : pane === "previewWidth" ? Number(metadata.minimaxPreviewW || 960) : pane === "preview" ? Number(metadata.minimaxPreviewH || 220) : pane === "clip" ? Number(metadata.minimaxClipPanelH || 220) : Number(metadata.minimaxRefLaneH || 36);
        drag.current = { x: event.clientX, y: event.clientY, value };
        event.currentTarget.setPointerCapture(event.pointerId);
    };
    const onPointerMove = (event: React.PointerEvent<HTMLSpanElement>) => {
        if (!drag.current) return;
        const bounds: Record<typeof pane, [number, number, number]> = { prompt: [220, 760, drag.current.value - (event.clientX - drag.current.x)], previewWidth: [280, 1100, drag.current.value + (event.clientX - drag.current.x)], preview: [130, 760, drag.current.value + event.clientY - drag.current.y], clip: [150, 440, drag.current.value + (drag.current.y - event.clientY)], refs: [30, 9999, drag.current.value + event.clientY - drag.current.y] };
        const [min, max, next] = bounds[pane];
        const clamped = Math.round(Math.max(min, Math.min(max, next)));
        const key = pane === "prompt" ? "minimaxPromptW" : pane === "previewWidth" ? "minimaxPreviewW" : pane === "preview" ? "minimaxPreviewH" : pane === "clip" ? "minimaxClipPanelH" : "minimaxRefLaneH";
        ctx.updateMetadata({ [key]: clamped });
    };
    return <span className={className} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={(event) => { drag.current = null; event.currentTarget.releasePointerCapture(event.pointerId); }} />;
}

export function H3RulerScrubber({ ctx, total, previewH }: { ctx: CanvasNodeContext; total: number; previewH: number }) {
    const scrubRef = useRef<HTMLDivElement | null>(null);
    const [origin, setOrigin] = useState<{ top: number; left: number; width: number; height: number } | null>(null);
    // 轨道几何直接取 ruler 的 offset*（本地 CSS px，与绝对定位同坐标系、不受画布 zoom 缩放），
    // getBoundingClientRect 量的是屏幕 px，缩放后必须再除以 scale 才能用回本地坐标。
    useEffect(() => {
        const host = scrubRef.current?.parentElement;
        // H3Timeline 的 ruler 行 class 名是 minimax-ruler-row（不是 .minimax-ruler，
        // 后者已不存在于 DOM）。这里必须匹配实际渲染的 class，否则 origin 永远为 null
        // 退回到 fallback（top: calc(58px + previewH + 10px), height: 28），scrubber
        // 会跟 H3 节点内部 ruler 错位甚至在节点外。
        const ruler = host?.querySelector<HTMLElement>(".minimax-ruler-row");
        if (!host || !ruler) return;
        const sync = () => {
            const next = { top: Math.round(ruler.offsetTop + ((ruler.offsetParent as HTMLElement | null)?.offsetTop ?? 0)), left: Math.round(ruler.offsetLeft), width: Math.round(ruler.offsetWidth), height: Math.round(ruler.offsetHeight) };
            setOrigin((cur) => cur && Math.abs(cur.top - next.top) < 1 && Math.abs(cur.left - next.left) < 1 && Math.abs(cur.width - next.width) < 1 && Math.abs(cur.height - next.height) < 1 ? cur : next);
        };
        sync();
        const ro = new ResizeObserver(sync);
        ro.observe(ruler);
        ro.observe(host);
        window.addEventListener("resize", sync);
        return () => { ro.disconnect(); window.removeEventListener("resize", sync); };
    }, [previewH]);
    const apply = (event: React.PointerEvent<HTMLDivElement>) => {
        const el = event.currentTarget as HTMLDivElement;
        const rect = el.getBoundingClientRect();
        // 画布节点带 zoom transform：屏幕距离 / 缩放系数 才等于本地 CSS px 距离。
        // 轨道内容按 50px/秒 铺（与 H3Timeline timelineWidth 一致）且可横向滚动，
        // 点击位置要加上 ruler 的 scroll 才是内容坐标，除以 50 得秒数。
        const host = scrubRef.current?.parentElement;
        const ruler = host?.querySelector<HTMLElement>(".minimax-ruler-row");
        const scale = el.offsetWidth > 0 ? rect.width / el.offsetWidth : 1;
        const scroll = ruler?.scrollLeft || 0;
        const px = Math.max(0, (event.clientX - rect.left) / scale + scroll);
        // 拖拽/点击 seek 的同时停掉播放循环，避免视频 onTimeUpdate 用自身 currentTime 把指针拉回去
        ctx.updateMetadata({ playhead: Math.max(0, Math.min(total, px / 50)), h3PlaybackAll: false, h3Scrubbing: true });
    };
    return <div ref={scrubRef} className="minimax-ruler-scrubber" style={{ top: origin?.top ?? `calc(58px + ${previewH}px + 10px)`, left: origin?.left ?? 62, width: origin?.width ?? "calc(100% - 126px)", height: origin?.height ?? 28 }} title="点击跳转播放指针" onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* synthetic/无指针ID 的测试事件无活动指针，忽略 */ } apply(event); }} onPointerMove={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) apply(event); }} onPointerUp={(event) => { try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* 同上 */ } ctx.updateMetadata({ h3Scrubbing: false }); }} onPointerCancel={() => { ctx.updateMetadata({ h3Scrubbing: false }); }} />;
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
    return <div className="minimax-player-content"><video ref={(node) => { mediaRef.current = node; }} src={resultUrl(url)} controls muted playsInline draggable={false} onLoadedMetadata={(event) => { event.currentTarget.currentTime = Math.max(0, Math.min(Number(event.currentTarget.duration || Infinity), playhead)); }} onTimeUpdate={(event) => { const media = event.currentTarget; const nodeNow = (ctx.getNode ? ctx.getNode(ctx.node.id) : ctx.node) || ctx.node; if (Number(nodeNow?.metadata?.h3Scrubbing)) return; const dur = Number(media.duration || 0); const effectiveDur = Number.isFinite(Number(clipDuration)) && Number(clipDuration) > 0 ? Math.min(Number(clipDuration), dur || Number(clipDuration)) : dur; const local = Math.max(0, Math.min(Number(media.currentTime || 0), effectiveDur)); const time = timelineOffset + local; if (Math.abs(time - Number(ctx.node.metadata?.playhead || 0)) > 0.2) ctx.updateMetadata({ playhead: time }); }} /></div>;
}
