import { h3ClipNumber } from "../services/h3-data";
import { useEffect, useRef, useState } from "@infinite-canvas/plugin-sdk";
import type { CanvasNodeContext } from "@infinite-canvas/plugin-sdk";
import type { H3Segment } from "../types";
import { compactSegmentStarts } from "../hooks/useH3Segments";
import { h3OutputName, refsForSegment, resultUrl, withSegmentRefs } from "../services/h3-data";
import { normalizeDroppedH3Ref } from "../services/h3-refs";
import { H3Icon } from "./H3Icon";
import { useH3Locale } from "../h3-locale";

export function H3ClipCard({ ctx, segment, index, segments, selectedId, fmt, motionGroup }: { ctx: CanvasNodeContext; segment: H3Segment; index: number; segments: H3Segment[]; selectedId?: string; fmt: (value: number) => string; motionGroup?: { head: number; tail: number } | null }) {
    const locale = useH3Locale();
    const group = motionGroup;
    const groupLabel = group ? `${locale === "en-US" ? "Motion group" : "接续组"} ${h3ClipNumber(ctx, segments[group.head], group.head)}–${h3ClipNumber(ctx, segments[group.tail], group.tail)}` : "";
    const cardRef = useRef<HTMLDivElement | null>(null);
    const resultIdentity = String(segment.resultStorageKey || segment.result || "");
    // 每张卡片读自己输出视频的真实尺寸，显示在 "Clip N" 上方；换结果时先清掉旧值。
    // 直接渲染 <video preload="metadata">：浏览器只拉 moov 元数据（几 KB~几十 KB），
    // 不依赖 IntersectionObserver 判定进入视口后才挂载——之前用观察者懒加载，初次打开或
    // 容器布局时机不对时观察者可能不回调，导致 success 的 Clip 也不显示分辨率徽标。
    // 时间线 Clip 数量有限，整排 metadata 预加载的带宽与 DOM 开销可控。
    const [mediaSize, setMediaSize] = useState<{ width: number; height: number } | null>(null);
    useEffect(() => { setMediaSize(null); }, [resultIdentity]);
    const left = Number(segment.start || 0) * 100;
    const width = Math.max(100, Number(segment.duration || 1) * 100);
    // 卡片按时长变宽；不足 160px 时大号 "864 × 480" 会被截断或折成三行，改用紧凑单行。
    const compactResolution = width < 160;
    const refs = refsForSegment(segment);
    const selected = segment.id === selectedId;
    // 之前 H3ClipCard 完全不读 segment.status，导致 H3Runner catch 块写了 status: "error"
    // 时时间轴 Clip 卡片没有任何视觉变化、Output 面板也没新视频（因为 result 也没写），
    // 用户感知为「Clip 卡片不更新」。这里把 status 读出来，加状态 className 让 CSS
    // 可以把失败/loading 视觉化。
    const segStatus = String(segment.status || "idle");
    const statusClass = segStatus === "error" ? "is-error" : segStatus === "loading" || segStatus === "queued" ? "is-loading" : segStatus === "success" ? "is-success" : segStatus === "cancelled" ? "is-cancelled" : "";
    const updateSegments = (next: H3Segment[]) => ctx.updateMetadata({ segments: next });
    return <div ref={cardRef} key={segment.id} data-segment-id={segment.id} draggable title={`Clip ${h3ClipNumber(ctx, segment, index)} · 内部 ID：${segment.id}${segStatus === "error" ? `\n${String(segment.errorDetails || "生成失败，请查看右侧状态详情或重试")}` : ""}`} onPointerEnter={() => {
        const url = segment.resultStorageKey ? ctx.mediaUrl(segment.resultStorageKey) : resultUrl(segment.result);
        if (url) window.dispatchEvent(new CustomEvent("minimax-h3-preload-clip", { detail: { nodeId: ctx.node.id, url } }));
    }} onDragStart={(event) => {
        event.stopPropagation();
        event.dataTransfer.effectAllowed = "copyMove";
        event.dataTransfer.setData("application/x-infinite-canvas-clip", segment.id);
        const url = segment.resultStorageKey ? ctx.mediaUrl(segment.resultStorageKey) : resultUrl(segment.result);
        if (url) {
            const result = segment.results?.find((item) => segment.resultStorageKey
                ? item.storageKey === segment.resultStorageKey
                : Boolean(segment.result && item.url === segment.result));
            const payload = JSON.stringify({
                type: "video",
                origin: "h3-output",
                url,
                storageKey: segment.resultStorageKey || result?.storageKey,
                name: h3OutputName(ctx.node, h3ClipNumber(ctx, segment, index)),
                mimeType: result?.mimeType || "video/mp4",
            });
            event.dataTransfer.setData("application/x-infinite-canvas-ref", payload);
            event.dataTransfer.setData("text/plain", payload);
            event.dataTransfer.setData("application/x-h3-output-video", "1");
        }
    }} onDragOver={(event) => event.preventDefault()} onDrop={(event) => {
        event.preventDefault();
        event.stopPropagation();
        const id = event.dataTransfer.getData("application/x-infinite-canvas-clip");
        const from = segments.findIndex((item) => item.id === id);
        const to = segments.findIndex((item) => item.id === segment.id);
        if (id && from >= 0 && to >= 0) {
            if (from === to) return;
            const next = [...segments];
            const [moved] = next.splice(from, 1);
            next.splice(to, 0, moved);
            ctx.updateMetadata({ segments: compactSegmentStarts(next), selectedSegmentId: id });
            return;
        }
        const ref = normalizeDroppedH3Ref(event);
        if (!ref || refs.some((item) => item.url === ref.url)) return;
        const nextRefs = [...refs, ref];
        updateSegments(segments.map((item) => item.id === segment.id ? withSegmentRefs(item, nextRefs) : item));
    }} onClick={() => { window.dispatchEvent(new CustomEvent("minimax-h3-select-clip", { detail: { projectId: ctx.projectId, nodeId: ctx.node.id, segmentId: segment.id } })); ctx.updateMetadata({ selectedSegmentId: segment.id, playhead: Number(segment.start || 0), h3PlaybackAll: false }); }} className={`minimax-tl-clip ${selected ? "active" : ""} ${statusClass}`} style={{ left: `${left}px`, width: `${width}px` }}>
        <div className="minimax-clip-media">{resultIdentity ? <video src={segment.resultStorageKey ? ctx.mediaUrl(segment.resultStorageKey) : segment.result} muted playsInline preload="metadata" draggable={false} onLoadedMetadata={(event) => { const { videoWidth, videoHeight } = event.currentTarget; if (videoWidth && videoHeight) setMediaSize({ width: videoWidth, height: videoHeight }); }} onError={() => { /* 媒体不可读（loading/cancelled/error 的旧 resultStorageKey 可能指向不存在或已失效对象）时静默，不显示分辨率徽标 */ }} /> : <div className="minimax-clip-empty">{segStatus === "error" ? <H3Icon name="close" /> : <H3Icon name="clapperboard" />}</div>}</div>
        <div className="minimax-clip-meta">{mediaSize ? <span className={`minimax-clip-resolution${compactResolution ? " is-compact" : ""}`}>{mediaSize.width}{compactResolution ? "×" : " × "}{mediaSize.height}</span> : null}<b>Clip {h3ClipNumber(ctx, segment, index)}{group ? <small title={groupLabel}> · {groupLabel}</small> : null}</b><span>{fmt(Number(segment.start || 0))} - {fmt(Number(segment.start || 0) + Number(segment.duration || 0))}</span></div>
        {segments.length > 1 ? segment.productionClipProjection?.targetId ? <button type="button" className="minimax-clip-delete" title="删除 Clip（同步制作台）" onClick={(event) => { event.stopPropagation(); if (!ctx.production?.deleteClip) return; void ctx.production.deleteClip({ nodeId: ctx.node.id, segmentId: segment.id }).catch(error => window.dispatchEvent(new CustomEvent("minimax-h3:production-edit-error", { detail: { message: error instanceof Error ? error.message : String(error) } }))); }}><H3Icon name="close" /></button> : <button type="button" className="minimax-clip-delete" title="删除 Clip" onClick={(event) => { event.stopPropagation(); const next = segments.filter((item) => item.id !== segment.id); ctx.updateMetadata({ segments: compactSegmentStarts(next), selectedSegmentId: next[Math.max(0, index - 1)]?.id || "" }); }}><H3Icon name="close" /></button> : null}
    </div>;
}
