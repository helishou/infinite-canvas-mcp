import type { CanvasNodeContext } from "@infinite-canvas/plugin-sdk";
import { Select } from "antd";
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
    onOpenStoryboard: () => void;
};

export function H3WorkbenchToolbar({ ctx, metadata, segments, selected, selectedIndex, outputs, playhead, total, fmt, onOpenStoryboard }: Props) {
    const models = ctx.ai.listModels("text");
    const promptModel = String(metadata.minimaxLlmModel || metadata.llmModel || ctx.ai.defaultModel("text") || models[0]?.value || "");
    const addSegment = () => {
        const next = compactSegmentStarts([...segments, { id: `segment-${Date.now()}`, prompt: String(metadata.prompt || defaultPrompt), duration: 5, status: "idle" }]);
        ctx.updateMetadata({ segments: next, selectedSegmentId: next[next.length - 1].id });
    };
    return <>
        <div className="minimax-aux-toolbar">
            <Select className="minimax-prompt-model" size="small" value={promptModel || undefined} placeholder="提示词增强模型" options={models.map((model) => ({ value: model.value, label: model.label }))} onChange={(value) => ctx.updateMetadata({ minimaxLlmModel: value })} style={{ width: 180 }} />
            <button type="button" className="minimax-aux-storyboard" onClick={onOpenStoryboard}>智能分镜</button>
        </div>
        <div className="minimax-wb-toolbar">
            <div className="minimax-brand"><H3Icon name="clapperboard" /> <span>MiniMax H3</span><em title="已加载新版 H3 插件">v1.2</em><b>{fmt(playhead)} / {fmt(total)}</b></div>
            <div className="minimax-transport"><button type="button" title="播放" onClick={() => ctx.updateMetadata({ playhead: playhead >= total ? 0 : total })}><H3Icon name="play" /></button><button type="button" title="新增片段" onClick={addSegment}><H3Icon name="plus" /></button></div>
            <div className="minimax-top-actions"><button type="button" title="下载当前片段" disabled={!selected?.result} onClick={() => { if (selected?.result) saveAs(resultUrl(selected.result), `Clip-${selectedIndex + 1}.mp4`); }}><H3Icon name="download" /></button><button type="button" title="下载完整时间轴" disabled={!metadata.content} onClick={() => { if (metadata.content) saveAs(String(metadata.content), "H3-timeline.mp4"); }}><H3Icon name="output" /></button><button type="button" title="依次下载全部输出" disabled={!outputs.length} onClick={() => outputs.forEach((item, index) => setTimeout(() => saveAs(item.url, item.name || `Clip-${index + 1}.mp4`), index * 120))}><H3Icon name="folder" /></button><button type="button" title="打开参数" onClick={() => ctx.openPanel()}><H3Icon name="settings" /></button></div>
        </div>
    </>;
}
