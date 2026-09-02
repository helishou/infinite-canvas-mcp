import type { CanvasNodeContext } from "@infinite-canvas/plugin-sdk";
import type { H3Segment } from "../types";
import { compactSegmentStarts } from "../hooks/useH3Segments";
import { refsForSegment, withSegmentRefs } from "../services/h3-data";
import { normalizeDroppedH3Ref } from "../services/h3-refs";
import { H3Icon } from "./H3Icon";

export function H3ClipCard({ ctx, segment, index, segments, total, selectedId, fmt }: { ctx: CanvasNodeContext; segment: H3Segment; index: number; segments: H3Segment[]; total: number; selectedId?: string; fmt: (value: number) => string }) {
    const left = Number(segment.start || 0) / total * 100;
    const width = Math.max(5, Number(segment.duration || 1) / total * 100);
    const refs = refsForSegment(segment);
    const selected = segment.id === selectedId;
    const updateSegments = (next: H3Segment[]) => ctx.updateMetadata({ segments: next });
    return <div key={segment.id} draggable onDragStart={(event) => { event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("application/x-infinite-canvas-clip", segment.id); }} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); event.stopPropagation(); const ref = normalizeDroppedH3Ref(event); if (ref) { if (refs.some((item) => item.url === ref.url)) return; const nextRefs = [...refs, ref]; updateSegments(segments.map((item) => item.id === segment.id ? withSegmentRefs(item, nextRefs) : item)); return; } const id = event.dataTransfer.getData("application/x-infinite-canvas-clip"); if (!id || id === segment.id) return; const from = segments.findIndex((item) => item.id === id); const to = segments.findIndex((item) => item.id === segment.id); if (from < 0 || to < 0) return; const next = [...segments]; const [moved] = next.splice(from, 1); next.splice(to, 0, moved); ctx.updateMetadata({ segments: compactSegmentStarts(next), selectedSegmentId: id }); }} onClick={() => ctx.updateMetadata({ selectedSegmentId: segment.id, playhead: Number(segment.start || 0), h3PlaybackAll: false })} className={`minimax-tl-clip ${selected ? "active" : ""}`} style={{ left: `${left}%`, width: `${width}%` }}>
        <div className="minimax-clip-media">{segment.result ? <video src={segment.result} muted playsInline preload="metadata" /> : <div className="minimax-clip-empty"><H3Icon name="clapperboard" /></div>}</div>
        <button type="button" className={`minimax-clip-motion ${segment.motionContextEnabled === false ? "off" : ""}`} title="Motion Context" onClick={(event) => { event.stopPropagation(); updateSegments(segments.map((item) => item.id === segment.id ? { ...item, motionContextEnabled: item.motionContextEnabled === false } : item)); }}><H3Icon name="waves" /></button>
        <div className="minimax-clip-meta"><b>Clip {index + 1}</b><span>{fmt(Number(segment.start || 0))} - {fmt(Number(segment.start || 0) + Number(segment.duration || 0))}</span></div>
        {refs.length ? <span className="minimax-clip-ref-count"><H3Icon name="paperclip" /> {refs.length}</span> : null}
        {segments.length > 1 ? <button type="button" className="minimax-clip-delete" onClick={(event) => { event.stopPropagation(); const next = segments.filter((item) => item.id !== segment.id); ctx.updateMetadata({ segments: compactSegmentStarts(next), selectedSegmentId: next[Math.max(0, index - 1)]?.id || "" }); }}><H3Icon name="close" /></button> : null}
    </div>;
}
