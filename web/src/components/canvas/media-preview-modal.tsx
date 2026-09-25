import { useCallback, useEffect, useRef, useState } from "react";
import { Modal } from "antd";

import type { CanvasMediaPreview } from "@/types/canvas-plugin";

/**
 * 画布里唯一的媒体预览弹窗：图片节点双击、插件素材库 / 参考弹窗的放大预览都走这里，
 * 插件不再自带灯箱 UI（通过 ctx.openMediaPreview 调起本弹窗）。
 * - image：单图；给 beforeUrl 时进入 Before / After 对比滑块
 * - video / audio：直接播放
 * - 标题统一显示名称 + 真实分辨率（从媒体自身量出，不依赖 metadata，避免陈旧或缺失）
 */
export type MediaPreviewItem = CanvasMediaPreview;

type Size = { width: number; height: number };

function loadImage(url: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error("image load failed"));
        img.src = url;
    });
}

function formatSize(size?: Size) {
    return size ? `${size.width} × ${size.height}` : "";
}

export function MediaPreviewModal({ item, onClose }: { item: MediaPreviewItem | null; onClose: () => void }) {
    const url = item?.url || "";
    const beforeUrl = item?.beforeUrl || "";
    const type = item?.type || "image";
    const open = Boolean(url);
    // 对比模式的统一显示尺寸（两张图取较大自然高度对齐）
    const [compareSize, setCompareSize] = useState<Size | null>(null);
    const [resolution, setResolution] = useState<{ before?: Size; after?: Size } | null>(null);
    const [sliderPos, setSliderPos] = useState(0);
    const containerRef = useRef<HTMLDivElement>(null);
    const draggingRef = useRef(false);

    // 换素材时清掉上一份测量结果，避免旧分辨率短暂串图
    useEffect(() => {
        setResolution(null);
        setCompareSize(null);
        setSliderPos(0);
    }, [url, beforeUrl, type]);

    // 对比模式：量出同高显示尺寸，顺带记录前后图分辨率
    useEffect(() => {
        if (!open || !beforeUrl || type !== "image") return;
        let cancelled = false;
        Promise.all([loadImage(beforeUrl), loadImage(url)]).then(([before, after]) => {
            if (cancelled) return;
            const maxH = window.innerHeight * 0.8;
            const maxW = window.innerWidth * 0.92;
            const targetH = Math.min(maxH, Math.max(before.naturalHeight, after.naturalHeight));
            const neededW = Math.max((before.naturalWidth * targetH) / before.naturalHeight, (after.naturalWidth * targetH) / after.naturalHeight);
            setCompareSize(neededW <= maxW ? { width: neededW, height: targetH } : { width: maxW, height: targetH * (maxW / neededW) });
            setResolution({
                before: { width: before.naturalWidth, height: before.naturalHeight },
                after: { width: after.naturalWidth, height: after.naturalHeight },
            });
        }).catch(() => {
            if (cancelled) return;
            setCompareSize({ width: window.innerWidth * 0.92, height: window.innerHeight * 0.8 });
            setResolution(null);
        });
        return () => {
            cancelled = true;
        };
    }, [open, beforeUrl, url, type]);

    // 单图模式：异步量出自然尺寸
    useEffect(() => {
        if (!open || beforeUrl || type !== "image") return;
        let cancelled = false;
        loadImage(url).then((img) => {
            if (!cancelled) setResolution({ after: { width: img.naturalWidth, height: img.naturalHeight } });
        }).catch(() => {
            if (!cancelled) setResolution(null);
        });
        return () => {
            cancelled = true;
        };
    }, [open, beforeUrl, url, type]);

    const updateSliderPos = useCallback((clientX: number) => {
        if (!containerRef.current) return;
        const rect = containerRef.current.getBoundingClientRect();
        const pct = Math.max(0, Math.min(100, ((clientX - rect.left) / rect.width) * 100));
        setSliderPos(pct);
    }, []);

    const handleMouseDown = useCallback((event: React.MouseEvent) => {
        event.preventDefault();
        draggingRef.current = true;
        updateSliderPos(event.clientX);
    }, [updateSliderPos]);

    const handleTouchStart = useCallback((event: React.TouchEvent) => {
        draggingRef.current = true;
        updateSliderPos(event.touches[0].clientX);
    }, [updateSliderPos]);

    useEffect(() => {
        if (!open || !beforeUrl) return;
        const handleMove = (event: MouseEvent) => {
            if (!draggingRef.current) return;
            event.preventDefault();
            updateSliderPos(event.clientX);
        };
        const handleTouchMove = (event: TouchEvent) => {
            if (!draggingRef.current) return;
            updateSliderPos(event.touches[0].clientX);
        };
        const end = () => { draggingRef.current = false; };
        window.addEventListener("mousemove", handleMove);
        window.addEventListener("mouseup", end);
        window.addEventListener("touchmove", handleTouchMove);
        window.addEventListener("touchend", end);
        return () => {
            window.removeEventListener("mousemove", handleMove);
            window.removeEventListener("mouseup", end);
            window.removeEventListener("touchmove", handleTouchMove);
            window.removeEventListener("touchend", end);
        };
    }, [open, beforeUrl, updateSliderPos]);

    const sizeText = resolution?.before && resolution?.after
        ? `前 ${formatSize(resolution.before)} · 后 ${formatSize(resolution.after)}`
        : formatSize(resolution?.after || resolution?.before);

    return (
        <Modal
            title={
                <span style={{ display: "inline-flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
                    <span>{item?.name || (type === "video" ? "视频" : type === "audio" ? "音频" : "图片")}</span>
                    {sizeText ? (
                        <span style={{ fontSize: 12, fontWeight: 400, color: "#94a3b8", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>{sizeText}</span>
                    ) : null}
                </span>
            }
            open={open}
            centered
            onCancel={onClose}
            footer={null}
            destroyOnHidden
            width="auto"
            styles={{ body: { padding: 0, display: "flex", justifyContent: "center", alignItems: "center", maxHeight: "80vh" } }}
        >
            {type === "audio" ? (
                <audio src={url} controls autoPlay style={{ width: "min(640px, 92vw)", margin: 24 }} />
            ) : type === "video" ? (
                <video
                    src={url}
                    controls
                    autoPlay
                    playsInline
                    style={{ maxWidth: "100%", maxHeight: "80vh", background: "#000" }}
                    onLoadedMetadata={(event) => {
                        const { videoWidth, videoHeight } = event.currentTarget;
                        if (videoWidth && videoHeight) setResolution({ after: { width: videoWidth, height: videoHeight } });
                    }}
                />
            ) : beforeUrl ? (
                compareSize ? (
                    <div
                        ref={containerRef}
                        style={{ position: "relative", width: compareSize.width, height: compareSize.height, overflow: "hidden", cursor: "ew-resize", userSelect: "none" }}
                        onMouseDown={handleMouseDown}
                        onTouchStart={handleTouchStart}
                    >
                        {/* 标签与对应图片共用裁切层，位置始终相对完整画幅固定。 */}
                        <div style={{ position: "absolute", inset: 0, clipPath: `inset(0 0 0 ${sliderPos}%)`, pointerEvents: "none" }}>
                            <img src={url} alt={item?.name} style={{ display: "block", width: "100%", height: "100%", objectFit: "contain", pointerEvents: "none" }} />
                            <div style={{ position: "absolute", top: 12, right: 12, background: "rgba(0,0,0,0.6)", color: "#fff", padding: "2px 8px", borderRadius: 4, fontSize: 12, pointerEvents: "none" }}>After</div>
                        </div>
                        <div style={{ position: "absolute", inset: 0, clipPath: `inset(0 ${100 - sliderPos}% 0 0)`, pointerEvents: "none" }}>
                            <img src={beforeUrl} alt={`${item?.name || ""} (before)`} style={{ display: "block", width: "100%", height: "100%", objectFit: "contain", pointerEvents: "none" }} />
                            <div style={{ position: "absolute", top: 12, left: 12, background: "rgba(0,0,0,0.6)", color: "#fff", padding: "2px 8px", borderRadius: 4, fontSize: 12, pointerEvents: "none" }}>Before</div>
                        </div>
                        <div style={{ position: "absolute", top: 0, bottom: 0, left: `${sliderPos}%`, width: 2, background: "#fff", boxShadow: "0 0 6px rgba(0,0,0,0.5)", transform: "translateX(-50%)", pointerEvents: "none" }} />
                        <div style={{ position: "absolute", top: "50%", left: `${sliderPos}%`, width: 28, height: 28, borderRadius: "50%", background: "#fff", boxShadow: "0 0 6px rgba(0,0,0,0.5)", transform: "translate(-50%, -50%)", pointerEvents: "none", display: "flex", alignItems: "center", justifyContent: "center" }}>
                            <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M5 3L2 8L5 13" stroke="#333" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /><path d="M11 3L14 8L11 13" stroke="#333" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
                        </div>
                    </div>
                ) : (
                    <div style={{ width: 480, height: 320, display: "flex", alignItems: "center", justifyContent: "center", color: "#94a3b8" }}>加载中…</div>
                )
            ) : (
                <img src={url} alt={item?.name} style={{ maxWidth: "100%", maxHeight: "80vh", objectFit: "contain" }} />
            )}
        </Modal>
    );
}
