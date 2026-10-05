import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ImageOff, Music, Play, Workflow } from "lucide-react";
import { backendMediaUrl } from "@/services/backend-api";
import { ensureImagePreview, previewUrlFor, subscribeImagePreview } from "@/services/image-storage";
import type { WorkbenchMedia } from "./workbench-data";

/** Cards reuse the canvas preview cache; the explicit preview always opens original media. */
export function WorkbenchMediaPreview({ media, label, controls = false }: { media: WorkbenchMedia | null; label: string; controls?: boolean }) {
    const src = media?.storageKey ? backendMediaUrl(media.storageKey) : media?.url || "";
    const container = useRef<HTMLDivElement>(null);
    const [visible, setVisible] = useState(false);
    const active = controls || visible;
    const previewKey = !controls && media?.kind === "image" ? media.storageKey : undefined;
    const subscribe = useCallback((listener: () => void) => subscribeImagePreview(previewKey, listener), [previewKey, src]);
    const getPreview = useCallback(() => previewUrlFor(previewKey), [previewKey, src]);
    const preview = useSyncExternalStore(subscribe, getPreview, () => undefined);
    const [checkedSource, setCheckedSource] = useState("");
    const [failedSource, setFailedSource] = useState("");

    useEffect(() => {
        if (active) return;
        if (typeof IntersectionObserver === "undefined") {
            setVisible(true);
            return;
        }
        const observer = new IntersectionObserver(([entry]) => {
            if (entry.isIntersecting) {
                setVisible(true);
                observer.disconnect();
            }
        });
        if (container.current) observer.observe(container.current);
        return () => observer.disconnect();
    }, [active]);

    useEffect(() => {
        if (!active || !previewKey) return;
        let disposed = false;
        void ensureImagePreview(previewKey).catch(() => undefined).then(() => {
            if (!disposed) setCheckedSource(src);
        });
        return () => { disposed = true; };
    }, [active, previewKey, src]);

    if (!active || (previewKey && !preview && checkedSource !== src))
        return <div ref={container} className="h-full min-h-24 w-full bg-muted/50" />;
    if (!media || !src || failedSource === src)
        return (
            <div className="flex h-full min-h-24 w-full flex-col items-center justify-center gap-2 bg-muted/50 text-muted-foreground">
                {media ? <ImageOff className="size-7" /> : <Workflow className="size-9 opacity-50" />}
                <span className="px-3 text-center text-xs">{label}</span>
            </div>
        );
    if (media.kind === "audio")
        return controls ? (
            <audio src={src} controls className="w-full" onError={() => setFailedSource(src)} />
        ) : (
            <div className="flex h-full items-center justify-center bg-muted">
                <Music className="size-8 text-muted-foreground" />
            </div>
        );
    if (media.kind === "video")
        return (
            <div className="relative h-full w-full bg-muted">
                <video
                    src={src}
                    controls={controls}
                    muted={!controls}
                    playsInline
                    preload="metadata"
                    className={`h-full w-full ${controls ? "object-contain" : "object-cover"}`}
                    onError={() => setFailedSource(src)}
                    onPointerEnter={(event) => {
                        if (!controls && event.pointerType === "mouse" && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) void event.currentTarget.play().catch(() => {});
                    }}
                    onPointerLeave={(event) => {
                        if (!controls) event.currentTarget.pause();
                    }}
                />
                {!controls && (
                    <span className="pointer-events-none absolute bottom-2 right-2 rounded bg-black/65 p-1 text-white">
                        <Play className="size-3" />
                    </span>
                )}
            </div>
        );
    return <img src={preview || src} alt={label} loading={controls ? "eager" : "lazy"} decoding="async" className={`h-full w-full ${controls ? "object-contain" : "object-cover"}`} onError={() => setFailedSource(src)} />;
}
