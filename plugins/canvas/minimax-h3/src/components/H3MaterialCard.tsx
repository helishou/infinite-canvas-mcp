import { useEffect, useRef, useState } from "@infinite-canvas/plugin-sdk";
import type { CanvasNodeContext } from "@infinite-canvas/plugin-sdk";
import { saveAs } from "file-saver";
import { createPortal } from "react-dom";
import { message } from "antd";
import type { H3Ref } from "../types";
import { H3Icon } from "./H3Icon";
import { h3Label, type H3Locale } from "../h3-locale";
import { h3ThemeVars } from "../h3-theme";

async function captureOutputFrame(url: string, position: "current" | "first" | "last") {
    const video = document.createElement("video");
    video.crossOrigin = "anonymous";
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.src = url;
    video.load();
    try {
        await new Promise<void>((resolve, reject) => {
            video.addEventListener("loadedmetadata", () => resolve(), { once: true });
            video.addEventListener("error", () => reject(new Error("视频无法读取当前帧")), { once: true });
        });
        if (!video.videoWidth || !video.videoHeight || !Number.isFinite(video.duration)) throw new Error("视频没有可读取的画面");
        const sourceTime = position === "first" ? 0 : position === "last" ? Math.max(0, video.duration - 0.001) : 0;
        if (Math.abs(video.currentTime - sourceTime) > 0.001 || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
            await new Promise<void>((resolve, reject) => {
                video.addEventListener("seeked", () => resolve(), { once: true });
                video.addEventListener("error", () => reject(new Error("视频帧定位失败")), { once: true });
                video.currentTime = sourceTime;
            });
        }
        const canvas = document.createElement("canvas");
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("无法创建截帧画布");
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
        if (!blob) throw new Error("截帧图片导出失败");
        return { blob, sourceTime };
    } finally {
        video.removeAttribute("src");
        video.load();
    }
}

export function H3MaterialCard({ ctx, ref, locale, compact = false, removable = false, onRestore, restoreTitle, onRemove, onOpenPreview, storyboardFrameTimes = [] }: { ctx: CanvasNodeContext; ref: H3Ref; locale: H3Locale; compact?: boolean; removable?: boolean; onRestore?: () => void; restoreTitle?: string; onRemove?: () => void; onOpenPreview?: () => void; storyboardFrameTimes?: number[] }) {
    const compactMedia = ctx.scale < 0.2;
    // Output 区域通过 removable 明确传入；不能依赖名称是否以 “Clip” 开头，
    // 旧输出可能叫“H3 输出”，但同样应该显示下载/还原按钮。
    const isOutput = compact && removable;
    const cardRef = useRef<HTMLDivElement | null>(null);
    const captureMenuRef = useRef<HTMLDivElement | null>(null);
    const [previewReady, setPreviewReady] = useState(false);
    const [captureMenu, setCaptureMenu] = useState<{ x: number; y: number } | null>(null);
    useEffect(() => {
        if (!isOutput) return;
        const card = cardRef.current;
        if (!card || typeof IntersectionObserver === "undefined") {
            setPreviewReady(true);
            return;
        }
        const observer = new IntersectionObserver(([entry]) => {
            if (!entry?.isIntersecting) return;
            setPreviewReady(true);
            observer.disconnect();
        }, { root: card.closest(".minimax-output-list"), rootMargin: "120px" });
        observer.observe(card);
        return () => observer.disconnect();
    }, [isOutput]);
    useEffect(() => {
        if (!captureMenu) return;
        const close = (event: PointerEvent) => {
            if (!(event.target instanceof Node) || !captureMenuRef.current?.contains(event.target)) setCaptureMenu(null);
        };
        const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setCaptureMenu(null); };
        document.addEventListener("pointerdown", close, true);
        window.addEventListener("keydown", onKey);
        return () => { document.removeEventListener("pointerdown", close, true); window.removeEventListener("keydown", onKey); };
    }, [captureMenu]);
    const mediaUrl = ref.storageKey ? ctx.mediaUrl(ref.storageKey) : ref.url;
    const cardClass = isOutput ? "minimax-material-card minimax-output-item" : compact ? "minimax-material-card minimax-asset-item" : "minimax-material-card";
    const dragStart = (event: React.DragEvent<HTMLDivElement>) => {
        event.dataTransfer.effectAllowed = "copy";
        const payload = JSON.stringify({ ...ref, ...(isOutput && ref.type === "video" ? { origin: "h3-output" } : {}) });
        event.dataTransfer.setData("application/x-infinite-canvas-ref", payload);
        event.dataTransfer.setData("text/plain", payload);
        if (isOutput && ref.type === "video") event.dataTransfer.setData("application/x-h3-output-video", "1");
    };
    const addFrameToStoryboard = async (position: "current" | "first" | "last") => {
        try {
            const captured = await captureOutputFrame(mediaUrl, position);
            window.dispatchEvent(new CustomEvent("minimax-h3-quick-storyboard-add-frame", { detail: { nodeId: ctx.node.id, blob: captured.blob, sourceTime: captured.sourceTime, name: ref.name || "H3 输出视频", position } }));
        } catch (error) { message.error(error instanceof Error ? error.message : String(error)); }
        finally { setCaptureMenu(null); }
    };
    const extractStoryboardFirstFrames = () => {
        window.dispatchEvent(new CustomEvent("minimax-h3-quick-storyboard-capture", { detail: { nodeId: ctx.node.id, url: mediaUrl, name: ref.name || "H3 输出视频", duration: 0, times: storyboardFrameTimes } }));
        setCaptureMenu(null);
    };
    return <div ref={cardRef} className={cardClass} draggable onDragStart={dragStart} onContextMenu={(event) => {
        if (!isOutput || ref.type !== "video") return;
        event.preventDefault(); event.stopPropagation();
        setCaptureMenu({ x: event.clientX, y: event.clientY });
    }} onDoubleClick={(event) => { event.stopPropagation(); onOpenPreview?.(); }} title={onOpenPreview ? "双击放大预览" : undefined} style={{ position: "relative", flex: `0 0 ${compact ? 82 : 118}px`, height: compact ? (isOutput ? 78 : 58) : 64, overflow: "hidden", border: `1px solid ${ctx.theme.node.stroke}`, borderRadius: 5, background: ctx.theme.node.fill, cursor: "grab" }}>
        {ref.type === "video" ? compactMedia || isOutput && !previewReady ? <H3Icon name="clapperboard" /> : <video src={mediaUrl} muted playsInline preload="metadata" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : ref.type === "image" ? <img src={mediaUrl} alt={ref.name} style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : <span style={{ padding: 16, fontSize: 22 }}>♫ {ref.name}</span>}
        {/* Output 卡片必须显示名字：历史输出同属一个 Clip 但有 N 个版本，类型标签无法区分。 */}
        {isOutput ? <span className="minimax-output-name" title={ref.name}>{ref.name}</span> : <span>{h3Label(locale, ref.type === "image" ? "image" : ref.type === "video" ? "video" : "audio")}</span>}
        {isOutput ? <span style={{ position: "absolute", right: 4, top: 4, display: "flex", gap: 3 }}><button type="button" title="放大预览" aria-label="放大预览" onClick={(event) => { event.stopPropagation(); onOpenPreview?.(); }}><H3Icon name="zoom" /></button><button type="button" title="下载输出视频" aria-label="下载输出视频" onClick={(event) => { event.stopPropagation(); saveAs(mediaUrl, ref.name || "h3-output"); }}><H3Icon name="download" /></button>{onRestore ? <button type="button" title={restoreTitle || "设为当前 Clip（还原提示词与参数）"} aria-label={restoreTitle || "设为当前 Clip（还原提示词与参数）"} onClick={(event) => { event.stopPropagation(); onRestore(); }}><H3Icon name="restore" /></button> : null}</span> : null}
        {removable && onRemove && !isOutput ? <button type="button" onClick={(event) => { event.stopPropagation(); onRemove(); }} style={{ position: "absolute", top: 2, right: 2, zIndex: 4 }}>×</button> : null}
        {captureMenu ? createPortal(<div ref={captureMenuRef} role="menu" className="minimax-output-context-menu" style={{ ...h3ThemeVars(ctx.theme), position: "fixed", zIndex: 9999, left: Math.max(8, Math.min(captureMenu.x, window.innerWidth - 230)), top: Math.max(8, Math.min(captureMenu.y, window.innerHeight - (storyboardFrameTimes.length ? 250 : 190))) }} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); }}>
            <button type="button" role="menuitem" onClick={(event) => { event.stopPropagation(); void addFrameToStoryboard("first"); }}>首帧截取到分镜板</button>
            <button type="button" role="menuitem" onClick={(event) => { event.stopPropagation(); void addFrameToStoryboard("last"); }}>尾帧截取到分镜板</button>
            <button type="button" role="menuitem" onClick={(event) => { event.stopPropagation(); void addFrameToStoryboard("current"); }}>当前帧截取到分镜板</button>
            {storyboardFrameTimes.length ? <button type="button" role="menuitem" onClick={(event) => { event.stopPropagation(); extractStoryboardFirstFrames(); }}>截取全部分镜首帧</button> : null}
        </div>, document.body) : null}
    </div>;
}
