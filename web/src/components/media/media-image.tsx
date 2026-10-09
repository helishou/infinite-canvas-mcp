import { useMediaPreviewStore } from "@/stores/use-media-preview-store";

const VIDEO_PATTERN = /\.(mp4|webm|mov)(?:$|\?)/i;
const AUDIO_PATTERN = /\.(mp3|wav|m4a|ogg|aac|flac)(?:$|\?)/i;

/**
 * 统一缩略图：替代 antd Image 自带预览，点击后交给全局 MediaPreviewHost，
 * 全站只有一套预览弹窗与交互。布局与普通 img 完全一致（不额外包一层容器）。
 */
export function MediaImage({ src, alt, name, type, className, preview = true }: {
    src: string;
    alt: string;
    name?: string;
    type?: "image" | "video" | "audio";
    className?: string;
    preview?: boolean;
}) {
    const open = useMediaPreviewStore(state => state.open);
    const resolved = type || (VIDEO_PATTERN.test(src) ? "video" : AUDIO_PATTERN.test(src) ? "audio" : "image");
    if (!preview) return <img src={src} alt={alt} className={className} loading="lazy" />;
    return <img
        src={src}
        alt={alt}
        className={className}
        loading="lazy"
        style={{ cursor: "zoom-in" }}
        onClick={event => { event.stopPropagation(); open({ url: src, name: name || alt, type: resolved }); }}
    />;
}
