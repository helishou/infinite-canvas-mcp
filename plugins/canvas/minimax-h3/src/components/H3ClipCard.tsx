import { useEffect, useRef, useState } from "react";
import type { CanvasNodeContext } from "@infinite-canvas/plugin-sdk";
import type { H3Segment } from "../types";
import { compactSegmentStarts } from "../hooks/useH3Segments";
import { refsForSegment, withSegmentRefs } from "../services/h3-data";
import { normalizeDroppedH3Ref } from "../services/h3-refs";
import { H3Icon } from "./H3Icon";

export function H3ClipCard({ ctx, segment, index, segments, selectedId, fmt }: { ctx: CanvasNodeContext; segment: H3Segment; index: number; segments: H3Segment[]; selectedId?: string; fmt: (value: number) => string }) {
    const left = Number(segment.start || 0) * 100;
    const width = Math.max(100, Number(segment.duration || 1) * 100);
    const refs = refsForSegment(segment);
    const selected = segment.id === selectedId;
    // 之前 H3ClipCard 完全不读 segment.status，导致 H3Runner catch 块写了 status: "error"
    // 时时间轴 Clip 卡片没有任何视觉变化、Output 面板也没新视频（因为 result 也没写），
    // 用户感知为「Clip 卡片不更新」。这里把 status 读出来，加状态 className 让 CSS
    // 可以把失败/loading 视觉化。
    const segStatus = String(segment.status || "idle");
    const statusClass = segStatus === "error" ? "is-error" : segStatus === "loading" || segStatus === "queued" ? "is-loading" : segStatus === "success" ? "is-success" : segStatus === "cancelled" ? "is-cancelled" : "";
    const updateSegments = (next: H3Segment[]) => ctx.updateMetadata({ segments: next });
    // 瞬时反馈（自包含 toast，不依赖 antd App 上下文）
    const [flash, setFlash] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
    const flashTimer = useRef<number | null>(null);
    const showFlash = (kind: "ok" | "err", text: string) => {
        setFlash({ kind, text });
        if (flashTimer.current != null) window.clearTimeout(flashTimer.current);
        flashTimer.current = window.setTimeout(() => setFlash(null), 2400);
    };
    useEffect(() => () => { if (flashTimer.current != null) window.clearTimeout(flashTimer.current); }, []);
    // 尾帧接续开关：标在本段上表示「把我的尾帧传给下一段」。
    // 下一段运行时会自动抓取本段尾帧、拼到提示词、作为首帧参考——不立即改 prompt 编辑区。
    // 仅当本段后面还有下一段时才显示该开关。
    const canContinue = index + 1 < segments.length;
    const continuationOn = segment.tailFrameContinuation === true;
    const toggleContinuation = (event: React.MouseEvent) => {
        event.stopPropagation();
        const next = !continuationOn;
        updateSegments(segments.map((item) => item.id === segment.id ? { ...item, tailFrameContinuation: next } : item));
        showFlash("ok", next ? "已开启尾帧接续：下一段运行将自动用本段尾帧" : "已关闭尾帧接续");
    };
    return <div key={segment.id} draggable title={segStatus === "error" ? String(segment.errorDetails || "生成失败，点击右侧 Status 区域查看详情或重试") : undefined} onDragStart={(event) => { event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("application/x-infinite-canvas-clip", segment.id); }} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); event.stopPropagation(); const ref = normalizeDroppedH3Ref(event); if (ref) { if (refs.some((item) => item.url === ref.url)) return; const nextRefs = [...refs, ref]; updateSegments(segments.map((item) => item.id === segment.id ? withSegmentRefs(item, nextRefs) : item)); return; } const id = event.dataTransfer.getData("application/x-infinite-canvas-clip"); if (!id || id === segment.id) return; const from = segments.findIndex((item) => item.id === id); const to = segments.findIndex((item) => item.id === segment.id); if (from < 0 || to < 0) return; const next = [...segments]; const [moved] = next.splice(from, 1); next.splice(to, 0, moved); ctx.updateMetadata({ segments: compactSegmentStarts(next), selectedSegmentId: id }); }} onClick={() => ctx.updateMetadata({ selectedSegmentId: segment.id, playhead: Number(segment.start || 0), h3PlaybackAll: false })} className={`minimax-tl-clip ${selected ? "active" : ""} ${statusClass}`} style={{ left: `${left}px`, width: `${width}px` }}>
        <div className="minimax-clip-media">{segment.result ? <video src={segment.result} muted playsInline preload="metadata" /> : <div className="minimax-clip-empty">{segStatus === "error" ? <H3Icon name="close" /> : <H3Icon name="clapperboard" />}</div>}</div>
        <button type="button" className={`minimax-clip-motion ${segment.motionContextEnabled === false ? "off" : ""}`} title={segment.motionContextEnabled === false ? "Motion Context 已关闭（点击开启）" : "Motion Context 已开启（点击关闭）"} onClick={(event) => { event.stopPropagation(); updateSegments(segments.map((item) => item.id === segment.id ? { ...item, motionContextEnabled: item.motionContextEnabled === false } : item)); }}><H3Icon name="link2" /></button>
        <div className="minimax-clip-meta"><b>Clip {index + 1}</b><span>{fmt(Number(segment.start || 0))} - {fmt(Number(segment.start || 0) + Number(segment.duration || 0))}</span></div>
        {canContinue ? <button type="button" className={`minimax-clip-tailframe ${continuationOn ? "on" : ""}`} title={continuationOn ? "尾帧接续：已开启（下一段运行将自动抓取本段尾帧作为首帧参考）" : "尾帧接续：关闭（点击开启，下一段运行将自动抓取本段尾帧作为首帧参考）"} onClick={toggleContinuation}><H3Icon name="frame" /></button> : null}
        {flash ? <span className={`minimax-clip-flash ${flash.kind}`}>{flash.text}</span> : null}
        {segments.length > 1 ? <button type="button" className="minimax-clip-delete" title="删除 Clip" onClick={(event) => { event.stopPropagation(); const next = segments.filter((item) => item.id !== segment.id); ctx.updateMetadata({ segments: compactSegmentStarts(next), selectedSegmentId: next[Math.max(0, index - 1)]?.id || "" }); }}><H3Icon name="close" /></button> : null}
    </div>;
}
