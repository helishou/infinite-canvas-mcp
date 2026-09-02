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
    refLanes: number;
    onRemoveRef: (segmentId: string, ref: H3Ref) => void;
    onPlayAll: () => void;
    fmt: (value: number) => string;
};

export function H3Timeline({ ctx, segments, selected, total, refLanes, onRemoveRef, onPlayAll, fmt }: H3TimelineProps) {
    const addRef = (event: React.DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        event.stopPropagation();
        const ref = normalizeDroppedH3Ref(event);
        if (!ref) return;
        const rect = event.currentTarget.getBoundingClientRect();
        const time = Math.max(0, Math.min(1, (event.clientX - rect.left) / Math.max(1, rect.width))) * total;
        const target = segments.find((item) => time >= Number(item.start || 0) && time < Number(item.start || 0) + Math.max(0.5, Number(item.duration || 1))) || selected;
        if (!target) return;
        const refs = refsForSegment(target);
        if (refs.some((item) => item.url === ref.url)) return;
        ctx.updateMetadata({ selectedSegmentId: target.id, segments: segments.map((item) => item.id === target.id ? withSegmentRefs(item, [...refs, ref]) : item) });
    };
    const addSegment = () => {
        const next = compactSegmentStarts([...segments, { id: `segment-${Date.now()}`, prompt: defaultPrompt, duration: 5, status: "idle" }]);
        ctx.updateMetadata({ segments: next, selectedSegmentId: next[next.length - 1].id });
    };
    return <div className="minimax-edit-timeline">
        <div className="minimax-timeline-controls"><button type="button" title="连续播放全部 Clip" onClick={onPlayAll}><H3Icon name="play" /></button></div>
        <div className="minimax-ruler"><div className="minimax-track-content">{Array.from({ length: 6 }).map((_, index) => <span className="minimax-tick" key={index} style={{ left: `${index * 20}%` }}><b>{fmt(total * index / 5)}</b></span>)}</div></div>
        <div className="minimax-add-gutter" />
        <div className="minimax-track-label minimax-video-label">Video</div>
        <div className="minimax-track minimax-video-track"><div className="minimax-track-content">{segments.map((segment, index) => <H3ClipCard key={segment.id} ctx={ctx} segment={segment} index={index} segments={segments} total={total} selectedId={selected?.id} fmt={fmt} />)}</div></div>
        <button type="button" className="minimax-video-add" onClick={addSegment}><H3Icon name="plus" /></button>
        <div className="minimax-track-label minimax-ref-label">Refs</div>
        <div className="minimax-ref-track" onDragOver={(event) => event.preventDefault()} onDrop={addRef}><div className="minimax-ref-content">{Array.from({ length: refLanes }).map((_, lane) => <div className="minimax-ref-lane" key={lane}>{segments.map((segment) => { const ref = refsForSegment(segment)[lane]; const left = Number(segment.start || 0) / total * 100; const width = Math.max(5, Number(segment.duration || 1) / total * 100); return <div key={segment.id} className={`minimax-ref-clip ${segment.id === selected?.id ? "active" : ""} ${ref ? "has-ref" : "is-empty"}`} style={{ left: `${left}%`, width: `${width}%` }} onClick={(event) => { event.stopPropagation(); ctx.updateMetadata({ selectedSegmentId: segment.id, playhead: Number(segment.start || 0) }); }}>{ref ? <div className="minimax-ref-media">{ref.type === "video" ? <video src={ref.url} muted playsInline preload="metadata" /> : ref.type === "image" ? <img src={ref.url} alt={ref.name} /> : <span>{ref.name}</span>}</div> : <div className="minimax-clip-empty"><H3Icon name="paperclip" /></div>}{ref ? <><span className="minimax-ref-counts">{ref.name || `Ref ${lane + 1}`}</span><button type="button" title="移除参考" onClick={(event) => { event.stopPropagation(); onRemoveRef(segment.id, ref); }}>×</button></> : null}</div>; })}</div>)}</div></div>
        <div className="minimax-ref-gutter" />
    </div>;
}
