import type { CanvasNodeContext } from "@infinite-canvas/plugin-sdk";
import { saveAs } from "file-saver";
import type { H3Ref } from "../types";
import { H3Icon } from "./H3Icon";

export function H3MaterialCard({ ctx, ref, compact = false, removable = false, onRestore, onRemove }: { ctx: CanvasNodeContext; ref: H3Ref; compact?: boolean; removable?: boolean; onRestore?: () => void; onRemove?: () => void }) {
    // Output 区域通过 removable 明确传入；不能依赖名称是否以 “Clip” 开头，
    // 旧输出可能叫“H3 输出”，但同样应该显示下载/还原按钮。
    const isOutput = compact && removable;
    const cardClass = isOutput ? "minimax-material-card minimax-output-item" : compact ? "minimax-material-card minimax-asset-item" : "minimax-material-card";
    const dragStart = (event: React.DragEvent<HTMLDivElement>) => {
        event.dataTransfer.effectAllowed = "copy";
        event.dataTransfer.setData("application/x-infinite-canvas-ref", JSON.stringify(ref));
        event.dataTransfer.setData("text/plain", JSON.stringify(ref));
    };
    return <div key={ref.url} className={cardClass} draggable onDragStart={dragStart} style={{ position: "relative", flex: `0 0 ${compact ? 82 : 118}px`, height: compact ? (isOutput ? 78 : 58) : 64, overflow: "hidden", border: `1px solid ${ctx.theme.node.stroke}`, borderRadius: 5, background: ctx.theme.node.fill, cursor: "grab" }}>
        {ref.type === "video" ? <video src={ref.url} muted playsInline preload="metadata" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : ref.type === "image" ? <img src={ref.url} alt={ref.name} style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : <span style={{ padding: 8, fontSize: 10 }}>♫ {ref.name}</span>}
        <span>{ref.type === "image" ? "Image" : ref.type === "video" ? "Video" : "Audio"}</span>
        {isOutput ? <span style={{ position: "absolute", right: 4, top: 4, display: "flex", gap: 3 }}><button type="button" title="下载输出视频" aria-label="下载输出视频" onClick={(event) => { event.stopPropagation(); saveAs(ref.url, ref.name || "h3-output"); }}><H3Icon name="download" /></button>{onRestore ? <button type="button" title="设为当前 Clip（还原提示词与参数）" aria-label="设为当前 Clip（还原提示词与参数）" onClick={(event) => { event.stopPropagation(); onRestore(); }}><H3Icon name="restore" /></button> : null}</span> : null}
        {removable && onRemove ? <button type="button" onClick={(event) => { event.stopPropagation(); onRemove(); }} style={{ position: "absolute", top: 2, right: 2, zIndex: 4 }}>×</button> : null}
    </div>;
}
