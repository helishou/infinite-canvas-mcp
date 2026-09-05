import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CanvasNodeContext } from "@infinite-canvas/plugin-sdk";
import type { H3Ref, H3Segment } from "../types";
import { defaultPrompt } from "../constants";
import { compactSegmentStarts } from "../hooks/useH3Segments";
import { refsForSegment, withSegmentRefs } from "../services/h3-data";
import { sameRef } from "../services/h3-compatibility";
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
    const trackScrollRef = useRef<HTMLDivElement | null>(null);
    const pendingScrollIdRef = useRef<string | null>(null);
    const restoredRef = useRef(false);
    const scrollPersistRafRef = useRef<number | null>(null);
    const [hasHorizontalOverflow, setHasHorizontalOverflow] = useState(false);
    // 时间轴宽度由父容器宽度决定（100% 跟随），同时保留总时长所需的最小宽度，
    // 这样 9s 总长时不会再在右边留出大段黑色空白，1.8s 间隔仍按 50px/秒等比放大。
    const timelineMinWidth = Math.max(500, total * 50);
    const playhead = Math.max(0, Math.min(total, Number(ctx.node.metadata?.playhead || 0)));
    // ruler 刻度根据滚动容器实测宽度动态生成：0~总时长用 1.6s 主刻度 + 0.4s 副刻度，
    // 超过总时长部分按 5s 间隔继续标记，避免右侧大片空白没刻度。
    const [trackWidth, setTrackWidth] = useState(timelineMinWidth);
    useLayoutEffect(() => {
        const node = trackScrollRef.current;
        if (!node) return;
        const measure = () => {
            const w = Math.max(node.clientWidth, timelineMinWidth);
            setTrackWidth(w);
            setHasHorizontalOverflow(node.scrollWidth > node.clientWidth + 1);
        };
        measure();
        if (typeof ResizeObserver === "undefined") return;
        const observer = new ResizeObserver(measure);
        observer.observe(node);
        return () => observer.disconnect();
    }, [timelineMinWidth]);
    const majorInterval = 1.6;
    const majorCount = Math.floor(total / majorInterval) + 1;
    const majorTicks = Array.from({ length: majorCount }, (_, index) => ({ time: index * majorInterval, left: index * majorInterval * 50 }));
    const minorInterval = 0.4;
    const minorCount = Math.floor(total / minorInterval) + 1;
    const minorTicks = Array.from({ length: minorCount }, (_, index) => ({ left: index * minorInterval * 50 }));
    // ruler 容器宽度可能比总时长宽很多（比如 20s 总时长但容器 40s 宽），
    // 0~总时长部分用 1.6s 主刻度，超过总时长部分用 5s 主刻度继续标记到 ruler 容器右边缘。
    // 但当容器剩余宽度 < 5s 时（如 total=20s 容器 22s 宽只多 2s），用 5s 间隔会落到容器外；
    // 此时用较小间隔（1.6s）继续铺，确保 ruler 容器内 0s 到右边缘都有连续刻度。
    const extendedInterval = 5;
    const containerSeconds = trackWidth / 50;
    const extendedStart = Math.ceil((total + 0.001) / extendedInterval) * extendedInterval;
    const extendedTicks: Array<{ time: number; left: number }> = [];
    if (extendedStart <= containerSeconds) {
        // 大间隔（5s）能塞进容器
        for (let t = extendedStart; t <= containerSeconds + 0.0001; t += extendedInterval) {
            extendedTicks.push({ time: t, left: t * 50 });
        }
    } else {
        // 容器剩余太窄，用 1.6s 继续铺到容器右边缘
        for (let t = Math.ceil(total / 1.6) * 1.6; t <= containerSeconds + 0.0001; t += 1.6) {
            extendedTicks.push({ time: Math.round(t * 10) / 10, left: t * 50 });
        }
    }
    // 节流持久化时间轴滚动位置，刷新后可恢复（避免每次 onScroll 都 updateMetadata）
    const persistScroll = useCallback((left: number) => {
        if (scrollPersistRafRef.current != null) return;
        scrollPersistRafRef.current = requestAnimationFrame(() => {
            scrollPersistRafRef.current = null;
            ctx.updateMetadata({ timelineScrollLeft: Math.round(left) });
        });
    }, [ctx]);
    // 把时间轴滚动到指定 clip：使其右边缘与可见区最右侧对齐（右侧对齐该 clip 最右侧）
    // 整个时间线（Ruler+Video+Refs）共用单一滚动容器，无需跨容器同步
    const scrollTimelineToSegment = useCallback((segment: H3Segment) => {
        const track = trackScrollRef.current;
        if (!track) return;
        const rightPx = (Number(segment.start || 0) + Math.max(0.5, Number(segment.duration || 1))) * 50;
        const target = Math.max(0, rightPx - track.clientWidth);
        track.scrollLeft = target;
        persistScroll(target);
    }, [persistScroll]);
    // 新增 Clip 后，在 DOM 提交（内容宽度已更新）后确定性地把时间轴滚到该 Clip 最右侧
    useLayoutEffect(() => {
        const id = pendingScrollIdRef.current;
        if (!id) return;
        const segment = segments.find((item) => item.id === id);
        if (!segment) return;
        pendingScrollIdRef.current = null;
        scrollTimelineToSegment(segment);
    });
    // 刷新后恢复时间轴滚动位置（仅挂载时执行一次；新增 Clip 的 pending 滚动会覆盖它，不会被拉回）
    useLayoutEffect(() => {
        if (restoredRef.current) return;
        restoredRef.current = true;
        const left = Number(ctx.node.metadata?.timelineScrollLeft || 0);
        if (left > 0 && trackScrollRef.current) {
            trackScrollRef.current.scrollLeft = left;
        }
    });
    // 卸载时清理 rAF，避免内存泄漏或已卸载组件的状态更新
    useEffect(() => {
        return () => {
            if (scrollPersistRafRef.current != null) cancelAnimationFrame(scrollPersistRafRef.current);
        };
    }, []);
    const startRefDrag = (event: React.DragEvent<HTMLDivElement>) => {
        const clip = (event.target as HTMLElement).closest<HTMLElement>(".minimax-ref-clip");
        const grid = clip?.parentElement;
        if (!clip || !grid) return;
        // 用 data-* 稳定定位，避免依赖 children 索引（.minimax-ref-content 内首个子元素是 playhead，会导致索引偏移 1）
        const segment = segments.find((item) => item.id === grid.dataset.segmentId);
        const refIndex = Number(clip.dataset.refIndex);
        const ref = segment && refsForSegment(segment)[refIndex];
        if (!segment || !ref) return;
        event.stopPropagation();
        event.dataTransfer.effectAllowed = "copy";
        event.dataTransfer.setData("application/x-infinite-canvas-ref", JSON.stringify(ref));
        event.dataTransfer.setData("application/x-infinite-canvas-ref-source", segment.id);
    };
    const addRef = (event: React.DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        event.stopPropagation();
        const ref = normalizeDroppedH3Ref(event);
        if (!ref) return;
        // 优先用光标下的元素精确判定落在哪个 clip（比时间换算更准，避免边界/滚动误差）
        const gridEl = (event.target as HTMLElement).closest<HTMLElement>(".minimax-ref-grid");
        let target: H3Segment | undefined;
        if (gridEl?.dataset.segmentId) target = segments.find((item) => item.id === gridEl.dataset.segmentId);
        if (!target) {
            const track = event.currentTarget as HTMLDivElement;
            const rect = track.getBoundingClientRect();
            // 内容坐标 = 已滚动偏移 + 鼠标在可见区内偏移；每单位 50px
            const contentX = track.scrollLeft + (event.clientX - rect.left);
            const time = Math.max(0, Math.min(total, contentX / 50));
            target = segments.find((item) => time >= Number(item.start || 0) && time < Number(item.start || 0) + Math.max(0.5, Number(item.duration || 1))) || selected;
        }
        if (!target) return;
        const mode = String(target.mode || target.taskMode || "ref2va");
        if (mode === "t2v" || (mode !== "ref2va" && ref.type !== "image")) return;
        const refs = refsForSegment(target);
        const maxImages = mode === "i2v" ? 1 : mode === "fl2v" ? 2 : 9;
        const sameTypeCount = refs.filter((item) => item.type === ref.type).length;
        if (sameTypeCount >= (ref.type === "image" ? maxImages : 3) || refs.some((item) => item.url === ref.url)) return;
        // refs 栏之间拖动为「复制」语义：来源 clip 保留该 ref，目标 clip 追加一份，不移除来源
        ctx.updateMetadata({
            selectedSegmentId: target.id,
            segments: segments.map((item) => item.id === target.id ? withSegmentRefs(item, [...refsForSegment(item), ref]) : item),
        });
    };
    const addSegment = () => {
        const previousIndex = selected ? segments.findIndex((segment) => segment.id === selected.id) : -1;
        const previous = previousIndex >= 0 ? segments[previousIndex] : segments[segments.length - 1];
        const inherited = previous ? (() => {
            const { id, start, result, resultStorageKey, results, status, progress, runtimeTaskId, refs, refItems, ...settings } = previous;
            return settings;
        })() : {};
        const nextSegment = {
            ...inherited,
            id: `segment-${Date.now()}`,
            prompt: defaultPrompt,
            duration: Number(previous?.duration || 5),
            status: "idle",
            progress: 0,
            result: "",
            results: [],
            refs: { image: [], video: [], audio: [] },
            refItems: [],
            runtimeTaskId: "",
        };
        const insertAt = previousIndex >= 0 ? previousIndex + 1 : segments.length;
        const next = compactSegmentStarts([...segments.slice(0, insertAt), nextSegment, ...segments.slice(insertAt)]);
        pendingScrollIdRef.current = nextSegment.id;
        // 与点击 clip 一致：同步把播放头（刻度线）指向新 clip 起点，并退出“全部播放”模式
        ctx.updateMetadata({ segments: next, selectedSegmentId: nextSegment.id, playhead: Number(nextSegment.start || 0), h3PlaybackAll: false });
    };
    const renderRefGrid = (segment: H3Segment) => {
        const refs = refsForSegment(segment);
        const mode = String(segment.mode || segment.taskMode || "ref2va");
        const slotCount = mode === "t2v" ? 0 : mode === "i2v" ? 1 : mode === "fl2v" ? 2 : 9;
        // 用 px 定位让 ref grid 跟随实际像素宽度（容器被拉宽时 clip 不会按比例缩成一条线）
        const left = Number(segment.start || 0) * 50;
        const width = Math.max(50, Number(segment.duration || 1) * 50);
        return <div key={segment.id} data-segment-id={segment.id} className={`minimax-ref-grid ${slotCount === 0 ? "is-disabled" : ""} ${segment.id === selected?.id ? "active" : ""}`} style={{ left: `${left}px`, width: `${width}px`, ...(slotCount > 0 && slotCount <= 3 ? { gridTemplateColumns: `repeat(${slotCount}, minmax(0, 1fr))`, gridTemplateRows: "minmax(0, 1fr)" } : {}) }} onClick={(event) => { event.stopPropagation(); ctx.updateMetadata({ selectedSegmentId: segment.id, playhead: Number(segment.start || 0) }); }}>{slotCount === 0 ? <span className="minimax-ref-empty-label">无需参考素材</span> : Array.from({ length: slotCount }).map((_, index) => { const ref = refs[index]; const label = mode === "i2v" ? "首帧" : mode === "fl2v" ? index === 0 ? "首帧" : "尾帧" : `Ref ${index + 1}`; return <div key={index} data-ref-index={index} draggable={ref ? true : undefined} className={`minimax-ref-clip ${ref ? "has-ref" : "is-empty"}`}>{ref ? <><div className="minimax-ref-media">{ref.type === "video" ? <video src={ref.url} muted playsInline preload="metadata" draggable={false} /> : ref.type === "image" ? <img src={ref.url} alt={ref.name} draggable={false} /> : <span>{ref.name}</span>}</div><span className="minimax-ref-type"><H3Icon name={ref.type === "image" ? "database" : ref.type === "video" ? "clapperboard" : "output"} /></span><span className="minimax-ref-counts">{ref.name || label}</span><button type="button" title="移除参考" onClick={(event) => { event.stopPropagation(); onRemoveRef(segment.id, ref); }}>×</button></> : <><H3Icon name="paperclip" /><span>{label}</span></>}</div>; })}</div>;
    };
    return <div className="minimax-edit-timeline">
        <div className="minimax-timeline-controls"><button type="button" title="连续播放全部 Clip" onClick={onPlayAll}><H3Icon name="play" /></button></div>
        <div className="minimax-left-labels">
            <div className="minimax-video-label">Video</div>
            <div className="minimax-ref-label">Refs</div>
        </div>
        <div className="minimax-add-gutter" />
        <div ref={trackScrollRef} className="minimax-tracks-scroll" style={{ overflowX: hasHorizontalOverflow ? "auto" : "hidden" }} onScroll={(event) => persistScroll(event.currentTarget.scrollLeft)}>
            <div className="minimax-track-body" style={{ minWidth: timelineMinWidth, width: "100%" }}>
                <div className="minimax-ruler-row" style={{ width: trackWidth }}>
                    {minorTicks.map((tick, index) => <span className="minimax-tick-minor" key={`m-${index}`} style={{ left: `${tick.left}px` }} />)}
                    {majorTicks.map((tick, index) => <span className="minimax-tick" key={`M-${index}`} style={{ left: `${tick.left}px` }}><b>{fmt(tick.time)}</b></span>)}
                    {extendedTicks.map((tick, index) => <span className="minimax-tick minimax-tick-extended" key={`E-${index}`} style={{ left: `${tick.left}px` }}><b>{fmt(tick.time)}</b></span>)}
                    <span className="minimax-playhead minimax-playhead-marker" style={{ left: `${playhead * 50}px` }} />
                </div>
                <div className="minimax-video-row">
                    <div className="minimax-track-content" style={{ minWidth: timelineMinWidth, width: "100%" }}>
                        {/* 视频行底部波形装饰条：只占总时长宽度（按 px），
                            避免 video-row 拉满后 ::after 跟着拉满铺满整行。 */}
                        {/* <div className="minimax-video-bottom-strip" style={{ width: timelineMinWidth }}>〰   〰   〰   〰</div> */}
                        <span className="minimax-playhead" style={{ left: `${playhead * 50}px` }} />
                        {segments.map((segment, index) => <H3ClipCard key={segment.id} ctx={ctx} segment={segment} index={index} segments={segments} selectedId={selected?.id} fmt={fmt} />)}
                    </div>
                </div>
                <div className="minimax-ref-row" onDragStart={startRefDrag} onDragOver={(event) => event.preventDefault()} onDrop={addRef}>
                    <div className="minimax-ref-content" style={{ minWidth: timelineMinWidth, width: "100%" }}>
                        <span className="minimax-playhead" style={{ left: `${playhead * 50}px` }} />
                        {segments.map(renderRefGrid)}
                    </div>
                </div>
            </div>
        </div>
        <div className="minimax-track-gutter">
            <button type="button" className="minimax-video-add" onClick={addSegment}><H3Icon name="plus" /></button>
        </div>
    </div>;
}
