import { useState } from "@infinite-canvas/plugin-sdk";
import type { CanvasNodeContentProps } from "@infinite-canvas/plugin-sdk";
import type { H3Ref, H3Segment } from "../types";
import { segmentsFor } from "../hooks/useH3Segments";
import { refsForSegment, resultUrl } from "../services/h3-data";
import { readH3Refs } from "../services/h3-refs";
import { patchSelectedSegment } from "../services/h3-segment-utils";
import { H3PaneHandles, H3PlayheadStyle, H3PreviewPlayer, H3RulerScrubber, H3StatusBadge, requestH3Run } from "./H3WorkbenchPrimitives";
import { SmartStoryboardModal } from "./SmartStoryboardModal";
import { H3CurrentClipPanel } from "./H3CurrentClipPanel";
import { H3Timeline } from "./H3Timeline";
import { H3MaterialLibrary } from "./H3MaterialLibrary";
import { H3Runner } from "./H3Runner";
import { H3WorkbenchToolbar } from "./H3WorkbenchToolbar";

export function H3ContentExact({ ctx }: CanvasNodeContentProps) {
    const metadata = ctx.node.metadata || {};
    const segments = segmentsFor(metadata);
    const selected = segments.find((item) => item.id === String(metadata.selectedSegmentId || "")) || segments[0];
    const selectedIndex = Math.max(0, segments.findIndex((item) => item.id === selected?.id));
    const upstream = readH3Refs(ctx);
    const selectedRefs = selected ? refsForSegment(selected) : [];
    const assets = [...upstream, ...segments.flatMap((item) => refsForSegment(item))].filter((item, index, all) => all.findIndex((other) => other.url === item.url) === index);
    const outputs = [...(Array.isArray(metadata.materials) ? metadata.materials : []), ...segments.flatMap((item, index) => [...(item.results || []), ...(resultUrl(item.result) ? [{ url: resultUrl(item.result), type: "video", name: `Clip ${index + 1}` }] : [])])].map((item, index) => { const value = item && typeof item === "object" ? item as Record<string, unknown> : { url: String(item) } as Record<string, unknown>; const url = String(value.url || value.video_url || value.content || ""); const type = String(value.type || value.kind || "video").startsWith("image") ? "image" : String(value.type || value.kind || "video").startsWith("audio") ? "audio" : "video"; return url ? { url, type, name: String(value.name || `Clip ${index + 1}`) } as H3Ref : null; }).filter((item): item is H3Ref => Boolean(item)).filter((item, index, all) => all.findIndex((other) => other.url === item.url) === index);
    const total = Math.max(1, segments.reduce((sum, item) => sum + Math.max(0.5, Number(item.duration || 1)), 0));
    const playhead = Math.max(0, Math.min(total, Number(metadata.playhead || 0)));
    const fmt = (value: number) => `${Number(value || 0).toFixed(Number(value || 0) % 1 ? 1 : 0)}s`;
    const selectedVideo = selectedRefs.find((item) => item.type === "video");
    const selectedImage = selectedRefs.find((item) => item.type === "image");
    const preview = resultUrl(selected?.result) || selectedVideo?.url || String(metadata.content || upstream.find((item) => item.type === "video")?.url || selectedImage?.url || "");
    const selectedResultRef = (selected?.results || []).find((item) => resultUrl(item.url) === preview || item.url === preview);
    const previewKind: H3Ref["type"] = selectedResultRef?.type || (resultUrl(selected?.result) ? "video" : selectedVideo ? "video" : selectedImage ? "image" : "video");
    const imageRefs = selectedRefs.filter((item) => item.type === "image");
    const videoRefs = selectedRefs.filter((item) => item.type === "video");
    const audioRefs = selectedRefs.filter((item) => item.type === "audio");
    const previewH = Math.max(130, Math.min(760, Number(metadata.minimaxPreviewH || 220)));
    const videoTrackH = Math.max(48, Math.min(180, Number(metadata.minimaxVideoTrackH || 74)));
    const libraryW = Math.max(170, Math.min(520, Number(metadata.minimaxLibraryW || 190)));
    const playRequest = Number(metadata.h3PlayRequest || 0);
    const [smartStoryboardOpen, setSmartStoryboardOpen] = useState(false);
    const [smartStoryboardUploads, setSmartStoryboardUploads] = useState<H3Ref[]>([]);
    const patchSelected = (patch: Partial<H3Segment>) => selected && patchSelectedSegment(ctx, { ...metadata, selectedSegmentId: selected.id }, patch);
    const removeRef = (ref: H3Ref) => patchSelected({ refItems: selectedRefs.filter((item) => item.url !== ref.url), refs: { image: imageRefs.filter((item) => item.url !== ref.url), video: videoRefs.filter((item) => item.url !== ref.url), audio: audioRefs.filter((item) => item.url !== ref.url) } });
    return <div className="minimax-canvas-workbench" data-canvas-no-zoom onMouseDown={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()} onWheel={(event) => event.stopPropagation()}>
        <H3Runner ctx={ctx} />
        <H3PaneHandles ctx={ctx} />
        <H3PlayheadStyle percent={total ? (playhead / total) * 100 : 0} />
        <H3StatusBadge status={String(metadata.status || selected?.status || "idle")} error={String(metadata.errorDetails || metadata.error || "")} onRetry={() => requestH3Run(ctx)} />
        <H3RulerScrubber ctx={ctx} total={total} previewH={previewH} libraryW={libraryW} />
        <H3WorkbenchToolbar ctx={ctx} metadata={metadata} segments={segments} selected={selected} selectedIndex={selectedIndex} outputs={outputs} playhead={playhead} total={total} fmt={fmt} onOpenStoryboard={() => setSmartStoryboardOpen(true)} />
        <SmartStoryboardModal ctx={ctx} metadata={metadata} upstream={upstream} open={smartStoryboardOpen} uploads={smartStoryboardUploads} setUploads={setSmartStoryboardUploads} onClose={() => setSmartStoryboardOpen(false)} />
        <style>{`.minimax-canvas-workbench{--minimax-preview-h:${previewH}px;--minimax-video-h:${videoTrackH}px}.minimax-canvas-workbench .minimax-wb-body{grid-template-columns:${libraryW}px minmax(0,1fr)}.minimax-canvas-workbench .minimax-wb-main{grid-template-rows:var(--minimax-preview-h) calc(28px + var(--minimax-video-h)) minmax(150px,1fr)}.minimax-canvas-workbench .minimax-edit-timeline{grid-template-rows:28px var(--minimax-video-h)}`}</style>
        <div className="minimax-wb-body"><H3MaterialLibrary ctx={ctx} assets={assets} outputs={outputs} segments={segments} selected={selected} selectedRefs={selectedRefs} imageRefs={imageRefs} videoRefs={videoRefs} audioRefs={audioRefs} patchSelected={patchSelected} />
            <main className="minimax-wb-main"><div className="minimax-player-stage"><H3PreviewPlayer ctx={ctx} url={preview} kind={previewKind} playhead={resultUrl(selected?.result) ? Math.max(0, playhead - Number(selected?.start || 0)) : playhead} timelineOffset={resultUrl(selected?.result) ? Number(selected?.start || 0) : 0} playRequest={playRequest} /></div>
                <H3Timeline ctx={ctx} segments={segments} selected={selected} total={total} fmt={fmt} />
                <H3CurrentClipPanel ctx={ctx} metadata={metadata} selected={selected} selectedIndex={selectedIndex} selectedRefs={selectedRefs} imageRefs={imageRefs} videoRefs={videoRefs} audioRefs={audioRefs} patchSelected={patchSelected} fmt={fmt} />
            </main>
        </div>
    </div>;
}
