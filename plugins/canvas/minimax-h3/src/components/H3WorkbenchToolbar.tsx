import type { CanvasNodeContext } from "@infinite-canvas/plugin-sdk";
import { useState } from "@infinite-canvas/plugin-sdk";
import { resolveH3Runtime } from "@basketikun/canvas-agent/plugins/minimax-h3/runtime-params";
import { Switch } from "antd";
import { saveAs } from "file-saver";
import type { H3Segment } from "../types";
import { defaultPrompt } from "../constants";
import { h3Label, useH3Locale } from "../h3-locale";
import { compactSegmentStarts } from "../hooks/useH3Segments";
import { useDefaultParams } from "../services/h3-defaults";
import { applyH3GlobalSettings } from "../services/h3-global-settings";
import { resultUrl } from "../services/h3-data";
import { H3Icon } from "./H3Icon";

type Props = {
    ctx: CanvasNodeContext;
    metadata: Record<string, unknown>;
    segments: H3Segment[];
    selected?: H3Segment;
    selectedIndex: number;
    playhead: number;
    total: number;
    fmt: (value: number) => string;
    onPlayAll: () => void;
    patchSelected: (patch: Partial<H3Segment>) => void;
};

export function H3WorkbenchToolbar({ ctx, metadata, segments, selected, selectedIndex, playhead, total, fmt, patchSelected }: Props) {
    const [timelineDownloading, setTimelineDownloading] = useState(false);
    const locale = useH3Locale();
    const defaults = useDefaultParams();
    const videoModels = ctx.ai.listModels("video");
    // 与 Clip 设置里的「自选视频模型」同一份 metadata：这里只读显示，切换只作用于当前 Clip。
    const liveSelected = (Array.isArray(metadata.segments) ? metadata.segments as H3Segment[] : []).find(segment => segment.id === selected?.id) || selected;
    const videoModelParams = liveSelected ? resolveH3Runtime(liveSelected as unknown as Record<string, unknown>, {}, metadata, defaults).params : {};
    const videoModelEnabled = videoModelParams.selectedVideoModelEnabled === true;
    const videoModelValue = String(videoModelParams.selectedVideoModel || "");
    const videoModelLabel = videoModels.find(option => option.value === videoModelValue)?.label || videoModelValue;
    const videoModelToggleDisabled = !selected || (!videoModels.length && !videoModelEnabled);
    const addSegment = () => {
        const next = compactSegmentStarts([...segments, applyH3GlobalSettings({ id: `segment-${Date.now()}`, prompt: String(metadata.prompt || defaultPrompt), duration: 5, status: "idle" }, ctx.getNode(ctx.node.id)?.metadata || ctx.node.metadata || metadata)]);
        ctx.updateMetadata({ segments: next, selectedSegmentId: next[next.length - 1].id });
    };
    const timelineVideos: Array<{ name: string; url: string; storageKey?: string }> = segments.flatMap((segment, index) => {
        const url = resultUrl(segment.result) || segment.results?.find((item) => item.type === "video")?.url || "";
        return url ? [{ name: `Clip-${index + 1}.mp4`, url, storageKey: segment.resultStorageKey }] : [];
    });
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
    // 依次下载全部输出 = 每个 Clip 的最终成稿（segment.result），不是历史输出全量。
    // 按 Clip1→N 顺序逐个触发下载；URL 优先走 ctx.mediaUrl(storageKey)（与素材卡单图下载一致，ref.url 可能过期或缺 token）。
    const [allOutputsDownloading, setAllOutputsDownloading] = useState(false);
    const downloadAllOutputs = () => {
        if (!timelineVideos.length || allOutputsDownloading) return;
        setAllOutputsDownloading(true);
        timelineVideos.forEach((item, index) => {
            setTimeout(() => {
                const media = item.storageKey ? ctx.mediaUrl(item.storageKey) : item.url;
                if (media) saveAs(media, item.name || `Clip-${index + 1}.mp4`);
                if (index === timelineVideos.length - 1) setAllOutputsDownloading(false);
            }, index * 400);
        });
    };
    return <>
        <div className="minimax-wb-toolbar" data-canvas-node-drag-handle>
            <div className="minimax-brand"><H3Icon name="clapperboard" /> <span>MiniMax H3</span><em title="已加载新版 H3 插件">v1.3</em><b>{fmt(playhead)} / {fmt(total)}</b></div>
            <div className="minimax-top-actions"><span className={`minimax-video-model-toggle${videoModelEnabled ? " is-on" : ""}`} title={`${h3Label(locale, "selectedVideoModelClipOnly")} ${h3Label(locale, "selectedVideoModelHint")}`} onMouseDown={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}><Switch size="small" checked={videoModelEnabled} disabled={videoModelToggleDisabled} aria-label={h3Label(locale, "selectedVideoModel")} onChange={(checked) => { if (selected) patchSelected({ selectedVideoModelEnabled: checked }); }} /><span className="minimax-video-model-label">{(videoModelEnabled ? videoModelLabel : "") || h3Label(locale, videoModelEnabled ? "selectedVideoModelUnset" : "nativeH3")}</span></span><button type="button" title="下载当前片段" disabled={!selected?.result} onClick={() => { if (selected?.result) saveAs(resultUrl(selected.result), `Clip-${selectedIndex + 1}.mp4`); }}><H3Icon name="download" /></button><button type="button" title={timelineVideos.length > 1 ? "拼接并下载完整时间轴" : "下载完整时间轴"} disabled={!timelineVideos.length || timelineDownloading} onClick={() => void downloadTimeline()}><H3Icon name="output" /></button><button type="button" title="依次下载全部输出（每个 Clip 的最终成稿）" disabled={!timelineVideos.length || allOutputsDownloading} onClick={downloadAllOutputs}><H3Icon name="folder" /></button><button type="button" title="打开参数" onClick={() => ctx.openPanel()}><H3Icon name="settings" /></button></div>
        </div>
    </>;
}
