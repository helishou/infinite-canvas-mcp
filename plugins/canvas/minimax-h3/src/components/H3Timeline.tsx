import type { CanvasNodeContext } from "@infinite-canvas/plugin-sdk";
import type { H3Segment } from "../types";
import { defaultPrompt } from "../constants";
import { compactSegmentStarts } from "../hooks/useH3Segments";
import { H3Icon } from "./H3Icon";
import { H3ClipCard } from "./H3ClipCard";

type H3TimelineProps = {
    ctx: CanvasNodeContext;
    segments: H3Segment[];
    selected?: H3Segment;
    total: number;
    fmt: (value: number) => string;
};

export function H3Timeline({ ctx, segments, selected, total, fmt }: H3TimelineProps) {
    const addSegment = () => {
        const next = compactSegmentStarts([...segments, { id: `segment-${Date.now()}`, prompt: defaultPrompt, duration: 5, status: "idle" }]);
        ctx.updateMetadata({ segments: next, selectedSegmentId: next[next.length - 1].id });
    };
    return <div className="minimax-edit-timeline">
        <div className="minimax-timeline-controls"><button type="button" onClick={() => { const playhead = Number(ctx.node.metadata?.playhead || 0); ctx.updateMetadata({ playhead: playhead >= total ? 0 : total }); }}><H3Icon name="play" /></button></div>
        <div className="minimax-ruler"><div className="minimax-track-content">{Array.from({ length: 6 }).map((_, index) => <span className="minimax-tick" key={index} style={{ left: `${index * 20}%` }}><b>{fmt(total * index / 5)}</b></span>)}</div></div>
        <div className="minimax-add-gutter" />
        <div className="minimax-track-label minimax-video-label">Video</div>
        <div className="minimax-track minimax-video-track"><div className="minimax-track-content">{segments.map((segment, index) => <H3ClipCard key={segment.id} ctx={ctx} segment={segment} index={index} segments={segments} total={total} selectedId={selected?.id} fmt={fmt} />)}</div></div>
        <button type="button" className="minimax-video-add" onClick={addSegment}><H3Icon name="plus" /></button>
    </div>;
}
