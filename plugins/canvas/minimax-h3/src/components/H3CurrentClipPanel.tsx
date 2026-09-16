import type { CanvasNodeContext } from "@infinite-canvas/plugin-sdk";
import type { H3Ref, H3Segment } from "../types";
import { H3Icon } from "./H3Icon";
import { H3PromptSection } from "./H3PromptSection";

export function H3CurrentClipPanel({ ctx, selected, selectedIndex, imageRefs, videoRefs, audioRefs, patchSelected, fmt, onOpenStoryboard }: { ctx: CanvasNodeContext; selected?: H3Segment; selectedIndex: number; imageRefs: H3Ref[]; videoRefs: H3Ref[]; audioRefs: H3Ref[]; patchSelected: (patch: Partial<H3Segment>) => void; fmt: (value: number) => string; onOpenStoryboard: () => void }) {
    const mode = String(selected?.mode || selected?.taskMode || "ref2va");
    const visibleImages = mode === "t2v" ? [] : mode === "i2v" ? imageRefs.slice(0, 1) : mode === "fl2v" ? imageRefs.slice(0, 2) : imageRefs;
    const visibleVideos = mode === "ref2va" ? videoRefs : [];
    const visibleAudios = mode === "ref2va" ? audioRefs : [];
    return <section className="minimax-current-panel">
        <div className="minimax-current-head"><div className="minimax-current-title"><span className="minimax-current-dot" /><b>Clip {selectedIndex + 1}</b><span>{fmt(Number(selected?.start || 0))} - {fmt(Number(selected?.start || 0) + Number(selected?.duration || 0))}</span></div><div className="minimax-current-refs"><span><H3Icon name="database" /> {visibleImages.length}</span><span><H3Icon name="clapperboard" /> {visibleVideos.length}</span><span><H3Icon name="output" /> {visibleAudios.length}</span></div></div>
        <div className="minimax-current-main">
            <H3PromptSection ctx={ctx} selected={selected} imageRefs={visibleImages} videoRefs={visibleVideos} audioRefs={visibleAudios} patchSelected={patchSelected} onOpenStoryboard={onOpenStoryboard} />
        </div>
    </section>;
}
