import type { CanvasNodeContext } from "@infinite-canvas/plugin-sdk";
import type { H3Ref, H3Segment } from "../types";
import { message } from "antd";
import { H3Icon } from "./H3Icon";
import { H3PromptSection } from "./H3PromptSection";
import { QuickStoryboardPanel } from "./QuickStoryboardPanel";
import { refsForSubmission } from "../services/h3-data";

export function H3CurrentClipPanel({ ctx, selected, selectedIndex, imageRefs, videoRefs, audioRefs, patchSelected, fmt, onOpenStoryboard }: { ctx: CanvasNodeContext; selected?: H3Segment; selectedIndex: number; imageRefs: H3Ref[]; videoRefs: H3Ref[]; audioRefs: H3Ref[]; patchSelected: (patch: Partial<H3Segment>) => void; fmt: (value: number) => string; onOpenStoryboard: () => void }) {
    const mode = String(selected?.mode || selected?.taskMode || "ref2va");
    const promptOrderedImages = selected ? refsForSubmission(selected).filter((ref) => ref.type === "image") : imageRefs;
    const visibleImages = mode === "t2v" ? [] : mode === "i2v" ? promptOrderedImages.slice(0, 1) : mode === "fl2v" ? promptOrderedImages.slice(0, 2) : promptOrderedImages;
    const visibleVideos = mode === "ref2va" ? videoRefs : [];
    const visibleAudios = mode === "ref2va" ? audioRefs : [];
    const copyClipId = async () => {
        if (!selected?.id) return;
        try { await navigator.clipboard.writeText(selected.id); message.success("已复制 Clip ID"); }
        catch { message.warning("复制失败，可悬停查看完整 ID"); }
    };
    return <section className="minimax-current-panel">
        <div className="minimax-current-head">
            <div className="minimax-current-title">
                <span className="minimax-current-dot" />
                <div className="minimax-current-labels">
                    <div className="minimax-current-primary"><b>Clip {selectedIndex + 1}</b><span>{fmt(Number(selected?.start || 0))} - {fmt(Number(selected?.start || 0) + Number(selected?.duration || 0))}</span></div>
                    {selected?.id ? <button type="button" className="minimax-current-id" title={`点击复制内部 ID：${selected.id}`} onClick={() => void copyClipId()}>内部 ID：{selected.id}</button> : null}
                </div>
            </div>
            <div className="minimax-current-refs"><span><H3Icon name="database" /> {visibleImages.length}</span><span><H3Icon name="clapperboard" /> {visibleVideos.length}</span><span><H3Icon name="output" /> {visibleAudios.length}</span></div>
        </div>
        <div className="minimax-current-main">
            <H3PromptSection ctx={ctx} selected={selected} imageRefs={visibleImages} videoRefs={visibleVideos} audioRefs={visibleAudios} patchSelected={patchSelected} onOpenStoryboard={onOpenStoryboard} />
            <QuickStoryboardPanel key={`quick-storyboard-${selected?.id || "none"}`} ctx={ctx} selected={selected} patchSelected={patchSelected} />
        </div>
    </section>;
}
