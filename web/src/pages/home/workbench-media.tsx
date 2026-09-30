import { useState } from "react";
import { ImageOff, Music, Play, Workflow } from "lucide-react";
import { backendMediaUrl } from "@/services/backend-api";
import type { WorkbenchMedia } from "./workbench-data";

/** Media stays paused until a deliberate pointer/focus interaction; no thumbnail downloads. */
export function WorkbenchMediaPreview({ media, label, controls = false }: { media: WorkbenchMedia | null; label: string; controls?: boolean }) {
    const src = media?.storageKey ? backendMediaUrl(media.storageKey) : media?.url || "";
    const [failedSource, setFailedSource] = useState("");
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
    return <img src={src} alt={label} loading="lazy" className={`h-full w-full ${controls ? "object-contain" : "object-cover"}`} onError={() => setFailedSource(src)} />;
}
