import { useEffect } from "react";
import { createPortal } from "react-dom";
import type { H3Ref } from "../types";
import { H3Icon } from "./H3Icon";

interface H3PreviewLightboxProps {
    item: H3Ref | null;
    onClose: () => void;
}

/**
 * 共享预览灯箱。Output 区（素材库 H3MaterialLibrary）与 Refs 区（时间轴参考槽 H3Timeline）
 * 复用同一实现，避免两份近似逻辑：
 * - 支持 image / video / audio 三类媒体的大图 / 播放预览
 * - 点遮罩、点关闭按钮、按 Esc 均可关闭
 * - 媒体分支与命名 fallback 与历史实现保持一致
 */
export function H3PreviewLightbox({ item, onClose }: H3PreviewLightboxProps) {
    useEffect(() => {
        if (!item) return;
        const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [item, onClose]);

    if (!item) return null;

    const previewUrl = String(item.url || "").trim();
    const media = !previewUrl ? <div style={{ padding: 24, color: "#f59e0b" }}>缺少预览 URL：{item.name || "未命名素材"}</div> : item.type === "video" ? (
                    <video src={previewUrl} controls autoPlay playsInline style={{ maxWidth: "92vw", maxHeight: "86vh", borderRadius: 8, background: "#000" }} />
                ) : item.type === "image" ? (
                    <img src={previewUrl} alt={item.name} style={{ maxWidth: "92vw", maxHeight: "86vh", borderRadius: 8 }} />
                ) : (
                    <audio src={previewUrl} controls autoPlay style={{ width: "min(640px, 92vw)" }} />
                );

    return createPortal(
        <div key="h3-preview-lightbox" className="minimax-lightbox" onClick={onClose}>
            <button type="button" className="minimax-lightbox-close" aria-label="关闭预览" onClick={(event) => { event.stopPropagation(); onClose(); }}><H3Icon name="close" /></button>
            <div className="minimax-lightbox-body" onClick={(event) => event.stopPropagation()}>
                {media}
                <div className="minimax-lightbox-name">{item.name || (item.type === "video" ? "视频" : item.type === "image" ? "图片" : "音频")}</div>
            </div>
        </div>,
        document.body,
    );
}
