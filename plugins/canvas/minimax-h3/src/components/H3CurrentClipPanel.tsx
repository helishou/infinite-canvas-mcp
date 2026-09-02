import type { CanvasNodeContext } from "@infinite-canvas/plugin-sdk";
import type { H3Ref, H3Segment } from "../types";
import { H3Icon } from "./H3Icon";
import { H3MaterialCard } from "./H3MaterialCard";
import { segmentRefsPatch } from "../services/h3-data";
import { H3PromptSection } from "./H3PromptSection";
import { H3ClipSettingsPanel } from "./H3ClipSettingsPanel";

export function H3CurrentClipPanel({ ctx, metadata, selected, selectedIndex, selectedRefs, imageRefs, videoRefs, audioRefs, patchSelected, fmt }: { ctx: CanvasNodeContext; metadata: Record<string, unknown>; selected?: H3Segment; selectedIndex: number; selectedRefs: H3Ref[]; imageRefs: H3Ref[]; videoRefs: H3Ref[]; audioRefs: H3Ref[]; patchSelected: (patch: Partial<H3Segment>) => void; fmt: (value: number) => string }) {
    const removeRef = (ref: H3Ref) => { const next = selectedRefs.filter((item) => item.url !== ref.url); patchSelected(segmentRefsPatch(next)); };
    return <section className="minimax-current-panel">
        <div className="minimax-current-head"><div className="minimax-current-title"><span className="minimax-current-dot" /><b>Clip {selectedIndex + 1}</b><span>{fmt(Number(selected?.start || 0))} - {fmt(Number(selected?.start || 0) + Number(selected?.duration || 0))}</span></div><div className="minimax-current-refs"><span><H3Icon name="database" /> {imageRefs.length}</span><span><H3Icon name="clapperboard" /> {videoRefs.length}</span><span><H3Icon name="output" /> {audioRefs.length}</span></div></div>
        <div className="minimax-current-ref-items">{selectedRefs.map((ref) => <H3MaterialCard key={ref.url} ctx={ctx} ref={ref} compact removable onRemove={() => removeRef(ref)} />)}{!selectedRefs.length ? <span><H3Icon name="paperclip" /> Refs：从 Assets 拖入参考素材</span> : null}</div>
        <H3PromptSection ctx={ctx} selected={selected} imageRefs={imageRefs} videoRefs={videoRefs} audioRefs={audioRefs} patchSelected={patchSelected} />
        <H3ClipSettingsPanel ctx={ctx} metadata={metadata} selected={selected} patchSelected={patchSelected} />
    </section>;
}
