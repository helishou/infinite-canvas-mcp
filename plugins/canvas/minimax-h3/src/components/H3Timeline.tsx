import type { CanvasNodeContext } from "@infinite-canvas/plugin-sdk";
import type { H3Ref, H3Segment } from "../types";
import { defaultPrompt } from "../constants";
import { compactSegmentStarts } from "../hooks/useH3Segments";
import { refsForSegment, withSegmentRefs } from "../services/h3-data";
import { normalizeDroppedH3Ref } from "../services/h3-refs";
import { H3Icon } from "./H3Icon";
import { H3ClipCard } from "./H3ClipCard";

type H3TimelineProps = {
    ctx: CanvasNodeContext;
    segments: H3Segment[];
    selected?: H3Segment;
    total: number;
    onRemoveRef: (segmentId: string, ref: H3Ref) => void;
    onPlayAll: () => void;
    fmt: (value: number) => string;
};

export function H3Timeline({ ctx, segments, selected, total, onRemoveRef, onPlayAll, fmt }: H3TimelineProps) {
    const addRef = (event: React.DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        event.stopPropagation();
        const ref = normalizeDroppedH3Ref(event);
        if (!ref) return;
        const rect = event.currentTarget.getBoundingClientRect();
        const time = Math.max(0, Math.min(1, (event.clientX - rect.left) / Math.max(1, rect.width))) * total;
        const target = segments.find((item) => time >= Number(item.start || 0) && time < Number(item.start || 0) + Math.max(0.5, Number(item.duration || 1))) || selected;
        if (!target) return;
        const mode = String(target.mode || target.taskMode || "ref2va");
        if (mode === "t2v" || (mode !== "ref2va" && ref.type !== "image")) return;
        const refs = refsForSegment(target);
        const maxImages = mode === "i2v" ? 1 : mode === "fl2v" ? 2 : 9;
        const sameTypeCount = refs.filter((item) => item.type === ref.type).length;
        if (sameTypeCount >= (ref.type === "image" ? maxImages : 3) || refs.some((item) => item.url === ref.url)) return;
        ctx.updateMetadata({ selectedSegmentId: target.id, segments: segments.map((item) => item.id === target.id ? withSegmentRefs(item, [...refs, ref]) : item) });
    };
    const addSegment = () => {
        const next = compactSegmentStarts([...segments, { id: `segment-${Date.now()}`, prompt: defaultPrompt, duration: 5, status: "idle" }]);
        ctx.updateMetadata({ segments: next, selectedSegmentId: next[next.length - 1].id });
    };
    const renderRefGrid = (segment: H3Segment) => {
        const refs = refsForSegment(segment);
        const left = Number(segment.start || 0) / total * 100;
        const width = Math.max(5, Number(segment.duration || 1) / total * 100);
        return <div key={segment.id} className={`minimax-ref-grid ${segment.id === selected?.id ? "active" : ""}`} style={{ left: `${left}%`, width: `${width}%` }} onClick={(event) => { event.stopPropagation(); ctx.updateMetadata({ selectedSegmentId: segment.id, playhead: Number(segment.start || 0) }); }}>{Array.from({ length: 9 }).map((_, index) => { const ref = refs[index]; return <div key={index} className={`minimax-ref-clip ${ref ? "has-ref" : "is-empty"}`}>{ref ? <><div className="minimax-ref-media">{ref.type === "video" ? <video src={ref.url} muted playsInline preload="metadata" draggable={false} /> : ref.type === "image" ? <img src={ref.url} alt={ref.name} draggable={false} /> : <span>{ref.name}</span>}</div><span className="minimax-ref-type"><H3Icon name={ref.type === "image" ? "database" : ref.type === "video" ? "clapperboard" : "output"} /></span><span className="minimax-ref-counts">{ref.name || `Ref ${index + 1}`}</span><button type="button" title="移除参考" onClick={(event) => { event.stopPropagation(); onRemoveRef(segment.id, ref); }}>×</button></> : <><H3Icon name="paperclip" /><span>Ref {index + 1}</span></>}</div>; })}</div>;
    };
    return <div className="minimax-edit-timeline">
        <div className="minimax-timeline-controls"><button type="button" title="连续播放全部 Clip" onClick={onPlayAll}><H3Icon name="play" /></button></div>
        <div className="minimax-ruler"><div className="minimax-track-content">{Array.from({ length: 6 }).map((_, index) => <span className="minimax-tick" key={index} style={{ left: `${index * 20}%` }}><b>{fmt(total * index / 5)}</b></span>)}</div></div>
        <div className="minimax-add-gutter" />
        <div className="minimax-track-label minimax-video-label">Video</div>
        <div className="minimax-track minimax-video-track"><div className="minimax-track-content">{segments.map((segment, index) => <H3ClipCard key={segment.id} ctx={ctx} segment={segment} index={index} segments={segments} total={total} selectedId={selected?.id} fmt={fmt} />)}</div></div>
        <button type="button" className="minimax-video-add" onClick={addSegment}><H3Icon name="plus" /></button>
        <div className="minimax-track-label minimax-ref-label">Refs</div>
        <div className="minimax-ref-track" onDragOver={(event) => event.preventDefault()} onDrop={addRef}><div className="minimax-ref-content">{segments.map(renderRefGrid)}</div></div>
        <div className="minimax-ref-gutter" />
    </div>;
}
