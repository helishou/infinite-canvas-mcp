import { useEffect, useRef, useState } from "@infinite-canvas/plugin-sdk";
import type { CanvasNodeContext } from "@infinite-canvas/plugin-sdk";
import { saveAs } from "file-saver";
import type { H3Ref } from "../types";
import { H3Icon } from "./H3Icon";
import { h3Label, type H3Locale } from "../h3-locale";

export function H3MaterialCard({ ctx, ref, locale, compact = false, removable = false, onRestore, restoreTitle, onRemove, onOpenPreview }: { ctx: CanvasNodeContext; ref: H3Ref; locale: H3Locale; compact?: boolean; removable?: boolean; onRestore?: () => void; restoreTitle?: string; onRemove?: () => void; onOpenPreview?: () => void }) {
    const compactMedia = ctx.scale < 0.2;
    // Output 区域通过 removable 明确传入；不能依赖名称是否以 “Clip” 开头，
    // 旧输出可能叫“H3 输出”，但同样应该显示下载/还原按钮。
    const isOutput = compact && removable;
    const cardRef = useRef<HTMLDivElement | null>(null);
    const [previewReady, setPreviewReady] = useState(false);
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
    const mediaUrl = ref.storageKey ? ctx.mediaUrl(ref.storageKey) : ref.url;
    const cardClass = isOutput ? "minimax-material-card minimax-output-item" : compact ? "minimax-material-card minimax-asset-item" : "minimax-material-card";
    const dragStart = (event: React.DragEvent<HTMLDivElement>) => {
        event.dataTransfer.effectAllowed = "copy";
        event.dataTransfer.setData("application/x-infinite-canvas-ref", JSON.stringify(ref));
        event.dataTransfer.setData("text/plain", JSON.stringify(ref));
    };
    return <div ref={cardRef} className={cardClass} draggable onDragStart={dragStart} onDoubleClick={(event) => { event.stopPropagation(); onOpenPreview?.(); }} title={onOpenPreview ? "双击放大预览" : undefined} style={{ position: "relative", flex: `0 0 ${compact ? 82 : 118}px`, height: compact ? (isOutput ? 78 : 58) : 64, overflow: "hidden", border: `1px solid ${ctx.theme.node.stroke}`, borderRadius: 5, background: ctx.theme.node.fill, cursor: "grab" }}>
        {ref.type === "video" ? compactMedia || isOutput && !previewReady ? <H3Icon name="clapperboard" /> : <video src={mediaUrl} muted playsInline preload="metadata" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : ref.type === "image" ? <img src={mediaUrl} alt={ref.name} style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : <span style={{ padding: 16, fontSize: 22 }}>♫ {ref.name}</span>}
        {/* Output 卡片必须显示名字：历史输出同属一个 Clip 但有 N 个版本，类型标签无法区分。 */}
        {isOutput ? <span className="minimax-output-name" title={ref.name}>{ref.name}</span> : <span>{h3Label(locale, ref.type === "image" ? "image" : ref.type === "video" ? "video" : "audio")}</span>}
        {isOutput ? <span style={{ position: "absolute", right: 4, top: 4, display: "flex", gap: 3 }}><button type="button" title="放大预览" aria-label="放大预览" onClick={(event) => { event.stopPropagation(); onOpenPreview?.(); }}><H3Icon name="zoom" /></button><button type="button" title="下载输出视频" aria-label="下载输出视频" onClick={(event) => { event.stopPropagation(); saveAs(mediaUrl, ref.name || "h3-output"); }}><H3Icon name="download" /></button>{onRestore ? <button type="button" title={restoreTitle || "设为当前 Clip（还原提示词与参数）"} aria-label={restoreTitle || "设为当前 Clip（还原提示词与参数）"} onClick={(event) => { event.stopPropagation(); onRestore(); }}><H3Icon name="restore" /></button> : null}</span> : null}
        {removable && onRemove && !isOutput ? <button type="button" onClick={(event) => { event.stopPropagation(); onRemove(); }} style={{ position: "absolute", top: 2, right: 2, zIndex: 4 }}>×</button> : null}
    </div>;
}
