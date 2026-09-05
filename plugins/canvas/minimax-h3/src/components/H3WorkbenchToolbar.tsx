import type { CanvasNodeContext } from "@infinite-canvas/plugin-sdk";
import { useState } from "@infinite-canvas/plugin-sdk";
import { saveAs } from "file-saver";
import type { H3Segment } from "../types";
import { defaultPrompt } from "../constants";
import { compactSegmentStarts } from "../hooks/useH3Segments";
import { resultUrl } from "../services/h3-data";
import { H3Icon } from "./H3Icon";

type Props = {
    ctx: CanvasNodeContext;
    metadata: Record<string, unknown>;
    segments: H3Segment[];
    selected?: H3Segment;
    selectedIndex: number;
    outputs: Array<{ url: string; name?: string }>;
    playhead: number;
    total: number;
    fmt: (value: number) => string;
    onPlayAll: () => void;
};

export function H3WorkbenchToolbar({ ctx, metadata, segments, selected, selectedIndex, outputs, playhead, total, fmt, onPlayAll, status, error, onRetry }: Props) {
    const [timelineDownloading, setTimelineDownloading] = useState(false);
    const addSegment = () => {
        const next = compactSegmentStarts([...segments, { id: `segment-${Date.now()}`, prompt: String(metadata.prompt || defaultPrompt), duration: 5, status: "idle" }]);
        ctx.updateMetadata({ segments: next, selectedSegmentId: next[next.length - 1].id });
    };
    const timelineVideos = segments.map((segment, index) => {
        const url = resultUrl(segment.result) || segment.results?.find((item) => item.type === "video")?.url || "";
        return url ? { name: `Clip-${index + 1}.mp4`, url, storageKey: segment.resultStorageKey } : null;
    }).filter((item): item is { name: string; url: string; storageKey?: string } => Boolean(item));
    const downloadTimeline = async () => {
        if (!timelineVideos.length || timelineDownloading) return;
        setTimelineDownloading(true);
        try {
            const result = timelineVideos.length === 1 ? timelineVideos[0] : await ctx.ai.runVideoConcat(timelineVideos);
            saveAs(result.url, "H3-timeline.mp4");
        } finally {
            setTimelineDownloading(false);
        }
    };
    return <>
        <div className="minimax-wb-toolbar" data-canvas-node-drag-handle>
            <div className="minimax-brand"><H3Icon name="clapperboard" /> <span>MiniMax H3</span><em title="已加载新版 H3 插件">v1.2</em><b>{fmt(playhead)} / {fmt(total)}</b></div>
            <div className="minimax-top-actions"><button type="button" title="下载当前片段" disabled={!selected?.result} onClick={() => { if (selected?.result) saveAs(resultUrl(selected.result), `Clip-${selectedIndex + 1}.mp4`); }}><H3Icon name="download" /></button><button type="button" title={timelineVideos.length > 1 ? "拼接并下载完整时间轴" : "下载完整时间轴"} disabled={!timelineVideos.length || timelineDownloading} onClick={() => void downloadTimeline()}><H3Icon name="output" /></button><button type="button" title="依次下载全部输出" disabled={!outputs.length} onClick={() => outputs.forEach((item, index) => setTimeout(() => saveAs(item.url, item.name || `Clip-${index + 1}.mp4`), index * 120))}><H3Icon name="folder" /></button><button type="button" title="打开参数" onClick={() => ctx.openPanel()}><H3Icon name="settings" /></button></div>
        </div>
    </>;
}
