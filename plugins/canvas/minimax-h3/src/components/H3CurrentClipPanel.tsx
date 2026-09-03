import { useRef } from "@infinite-canvas/plugin-sdk";
import type { CanvasNodeContext } from "@infinite-canvas/plugin-sdk";
import type { H3Ref, H3Segment } from "../types";
import { H3Icon } from "./H3Icon";
import { H3ClipSettingsPanel } from "./H3ClipSettingsPanel";

export function H3CurrentClipPanel({ ctx, metadata, selected, selectedIndex, imageRefs, videoRefs, audioRefs, patchSelected, fmt, onOpenStoryboard }: { ctx: CanvasNodeContext; metadata: Record<string, unknown>; selected?: H3Segment; selectedIndex: number; imageRefs: H3Ref[]; videoRefs: H3Ref[]; audioRefs: H3Ref[]; patchSelected: (patch: Partial<H3Segment>) => void; fmt: (value: number) => string; onOpenStoryboard: () => void }) {
    const settingsWidth = Math.max(240, Math.min(520, Number(metadata.minimaxClipSettingsW || 300)));
    const drag = useRef<{ x: number; width: number } | null>(null);
    const resizeSettings = (event: React.PointerEvent<HTMLSpanElement>) => {
        if (!drag.current) return;
        const panel = event.currentTarget.parentElement;
        const max = Math.max(240, (panel?.getBoundingClientRect().width || 0) - 288);
        ctx.updateMetadata({ minimaxClipSettingsW: Math.round(Math.max(240, Math.min(520, Math.min(max, drag.current.width - (event.clientX - drag.current.x))))) });
    };
    const mode = String(selected?.mode || selected?.taskMode || "ref2va");
    const visibleImages = mode === "t2v" ? [] : mode === "i2v" ? imageRefs.slice(0, 1) : mode === "fl2v" ? imageRefs.slice(0, 2) : imageRefs;
    const visibleVideos = mode === "ref2va" ? videoRefs : [];
    const visibleAudios = mode === "ref2va" ? audioRefs : [];
    return <section className="minimax-current-panel" style={{ "--minimax-clip-settings-w": `${settingsWidth}px` } as React.CSSProperties}>
        <div className="minimax-current-head"><div className="minimax-current-title"><span className="minimax-current-dot" /><b>Clip {selectedIndex + 1}</b><span>{fmt(Number(selected?.start || 0))} - {fmt(Number(selected?.start || 0) + Number(selected?.duration || 0))}</span></div><div className="minimax-current-refs"><span><H3Icon name="database" /> {visibleImages.length}</span><span><H3Icon name="clapperboard" /> {visibleVideos.length}</span><span><H3Icon name="output" /> {visibleAudios.length}</span></div></div>
        <div className="minimax-current-preview">
            {selected?.result ? <video src={selected.result} controls muted playsInline preload="metadata" /> : <div><H3Icon name="clapperboard" /><span>当前 Clip 暂无输出</span></div>}
        </div>
        <span className="minimax-current-resize" role="separator" aria-label="调整 Prompt 与 Clip settings 宽度" title="拖动调整 Prompt 与 Clip settings 宽度" onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); drag.current = { x: event.clientX, width: settingsWidth }; event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={resizeSettings} onPointerUp={(event) => { drag.current = null; event.currentTarget.releasePointerCapture(event.pointerId); }} />
        <H3ClipSettingsPanel ctx={ctx} metadata={metadata} selected={selected} imageRefs={visibleImages} videoRefs={visibleVideos} audioRefs={visibleAudios} patchSelected={patchSelected} onOpenStoryboard={onOpenStoryboard} />
    </section>;
}
