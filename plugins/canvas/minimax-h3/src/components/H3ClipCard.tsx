import { useEffect, useRef, useState } from "react";
import type { CanvasNodeContext } from "@infinite-canvas/plugin-sdk";
import type { H3Ref, H3Segment } from "../types";
import { compactSegmentStarts } from "../hooks/useH3Segments";
import { refsForSegment, withSegmentRefs, nextPictureNumber, appendSubjectDefinition, appendRetentionAnalysis } from "../services/h3-data";
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
    // 截取尾帧 → 下一段参考区的瞬时反馈（自包含 toast，不依赖 antd App 上下文）
    const [flash, setFlash] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
    const flashTimer = useRef<number | null>(null);
    const showFlash = (kind: "ok" | "err", text: string) => {
        setFlash({ kind, text });
        if (flashTimer.current != null) window.clearTimeout(flashTimer.current);
        flashTimer.current = window.setTimeout(() => setFlash(null), 2400);
    };
    useEffect(() => () => { if (flashTimer.current != null) window.clearTimeout(flashTimer.current); }, []);
    const canCaptureTail = Boolean(segment.result) && index + 1 < segments.length;
    const captureTailFrame = (event: React.MouseEvent) => {
        event.stopPropagation();
        const next = segments[index + 1];
        if (!next) { showFlash("err", "已是最后一段，无下一段可插入"); return; }
        const src = segment.result;
        if (!src) { showFlash("err", "当前 Clip 还没有生成视频"); return; }
        const nextMode = String(next.mode || next.taskMode || "ref2va");
        if (nextMode === "t2v") { showFlash("err", "下一段为文生视频(t2v)，无参考区"); return; }
        const maxImages = nextMode === "i2v" ? 1 : nextMode === "fl2v" ? 2 : 9;
        const video = document.createElement("video");
        video.src = src;
        video.muted = true;
        video.preload = "auto";
        let settled = false;
        const cleanup = () => { try { video.removeAttribute("src"); video.load(); } catch { /* ignore */ } };
        video.addEventListener("error", () => { if (!settled) { settled = true; showFlash("err", "视频加载失败，无法截取尾帧"); cleanup(); } });
        video.addEventListener("loadedmetadata", () => {
            // 尾帧：略回退一帧（~1/30s）避免踩在 duration 边界外导致取不到画面
            const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
            video.currentTime = Math.max(0, duration - 1 / 30);
        });
        video.addEventListener("seeked", () => {
            if (settled) return;
            try {
                const vw = video.videoWidth || 1280;
                const vh = video.videoHeight || 720;
                const maxLong = 768;
                const scale = Math.min(1, maxLong / Math.max(vw, vh));
                const cw = Math.max(1, Math.round(vw * scale));
                const ch = Math.max(1, Math.round(vh * scale));
                const canvas = document.createElement("canvas");
                canvas.width = cw;
                canvas.height = ch;
                const cx = canvas.getContext("2d");
                if (!cx) { settled = true; showFlash("err", "无法创建画布上下文"); cleanup(); return; }
                cx.drawImage(video, 0, 0, cw, ch);
                const dataUrl = canvas.toDataURL("image/png");
                const nextRefs = refsForSegment(next);
                if (nextRefs.some((item) => item.url === dataUrl)) { settled = true; showFlash("ok", "尾帧已在该段参考中"); cleanup(); return; }
                const imageCount = nextRefs.filter((item) => item.type === "image").length;
                if (imageCount >= maxImages) { settled = true; showFlash("err", `下一段参考图已满（${maxImages}）`); cleanup(); return; }
                const pictureNumber = nextPictureNumber(next.prompt, imageCount);
                const fromClipLabel = `Clip ${index + 1}`;
                const frameRef: H3Ref = { url: dataUrl, type: "image", name: `尾帧·Clip${index + 1} (P${pictureNumber})` };
                const updatedRefs = [...nextRefs, frameRef];
                let nextPrompt = next.prompt || "";
                // subject_definitions 里先定义 <Picture N>（仅当该 section 已存在，避免凭空造大段结构）；
                // retention_analysis 里加引用行（H3 规范要求标签先定义再引用）。
                if (/^subject_definitions\s*[:：]/m.test(nextPrompt)) nextPrompt = appendSubjectDefinition(nextPrompt, pictureNumber, fromClipLabel);
                nextPrompt = appendRetentionAnalysis(nextPrompt, pictureNumber, fromClipLabel);
                const updated = segments.map((item) => item.id === next.id ? { ...withSegmentRefs(next, updatedRefs), prompt: nextPrompt } : item);
                ctx.updateMetadata({ segments: updated, selectedSegmentId: next.id });
                settled = true;
                showFlash("ok", `已截取尾帧插入下一段参考区，retention_analysis 标记 <Picture ${pictureNumber}>`);
                cleanup();
            } catch (error) {
                settled = true;
                showFlash("err", "截取尾帧失败：" + (error instanceof Error ? error.message : String(error)));
                cleanup();
            }
        });
        video.load();
    };
    return <div key={segment.id} draggable title={segStatus === "error" ? String(segment.errorDetails || "生成失败，点击右侧 Status 区域查看详情或重试") : undefined} onDragStart={(event) => { event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("application/x-infinite-canvas-clip", segment.id); }} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); event.stopPropagation(); const ref = normalizeDroppedH3Ref(event); if (ref) { if (refs.some((item) => item.url === ref.url)) return; const nextRefs = [...refs, ref]; updateSegments(segments.map((item) => item.id === segment.id ? withSegmentRefs(item, nextRefs) : item)); return; } const id = event.dataTransfer.getData("application/x-infinite-canvas-clip"); if (!id || id === segment.id) return; const from = segments.findIndex((item) => item.id === id); const to = segments.findIndex((item) => item.id === segment.id); if (from < 0 || to < 0) return; const next = [...segments]; const [moved] = next.splice(from, 1); next.splice(to, 0, moved); ctx.updateMetadata({ segments: compactSegmentStarts(next), selectedSegmentId: id }); }} onClick={() => ctx.updateMetadata({ selectedSegmentId: segment.id, playhead: Number(segment.start || 0), h3PlaybackAll: false })} className={`minimax-tl-clip ${selected ? "active" : ""} ${statusClass}`} style={{ left: `${left}px`, width: `${width}px` }}>
        <div className="minimax-clip-media">{segment.result ? <video src={segment.result} muted playsInline preload="metadata" /> : <div className="minimax-clip-empty">{segStatus === "error" ? <H3Icon name="close" /> : <H3Icon name="clapperboard" />}</div>}</div>
        <button type="button" className={`minimax-clip-motion ${segment.motionContextEnabled === false ? "off" : ""}`} title={segment.motionContextEnabled === false ? "Motion Context 已关闭（点击开启）" : "Motion Context 已开启（点击关闭）"} onClick={(event) => { event.stopPropagation(); updateSegments(segments.map((item) => item.id === segment.id ? { ...item, motionContextEnabled: item.motionContextEnabled === false } : item)); }}><H3Icon name="link2" /></button>
        <div className="minimax-clip-meta"><b>Clip {index + 1}</b><span>{fmt(Number(segment.start || 0))} - {fmt(Number(segment.start || 0) + Number(segment.duration || 0))}</span></div>
        {canCaptureTail ? <button type="button" className="minimax-clip-tailframe" title="截取尾帧 → 插入下一段参考区" onClick={captureTailFrame}><H3Icon name="frame" /></button> : null}
        {flash ? <span className={`minimax-clip-flash ${flash.kind}`}>{flash.text}</span> : null}
        {segments.length > 1 ? <button type="button" className="minimax-clip-delete" title="删除 Clip" onClick={(event) => { event.stopPropagation(); const next = segments.filter((item) => item.id !== segment.id); ctx.updateMetadata({ segments: compactSegmentStarts(next), selectedSegmentId: next[Math.max(0, index - 1)]?.id || "" }); }}><H3Icon name="close" /></button> : null}
    </div>;
}
