import type { CanvasNodeContext } from "@infinite-canvas/plugin-sdk";
import type { H3Segment } from "../types";
import { ClipSettings } from "./ClipSettings";
import { H3Icon } from "./H3Icon";

type Props = { ctx: CanvasNodeContext; metadata: Record<string, unknown>; selected?: H3Segment; patchSelected: (patch: Partial<H3Segment>) => void };

export function H3ClipSettingsPanel({ ctx, metadata, selected, patchSelected }: Props) {
    const busy = ["queued", "loading"].includes(String(metadata.status || ""));
    return <div className="minimax-clip-parameters">
        <div className="minimax-section-label"><H3Icon name="sliders" /> <span>NanFeng H3 V10</span><small className="nfh3-panel-status">{busy ? "运行中" : "就绪"}</small></div>
        <ClipSettings ctx={ctx} metadata={metadata} segment={selected} patch={patchSelected} />
        <div className="nfh3-panel-actions"><button type="button" className={busy ? "minimax-reset" : "minimax-run"} onClick={() => busy ? ctx.emit("minimax-h3:cancel", { nodeId: ctx.node.id }) : (ctx.openPanel(), ctx.emit("minimax-h3:run", { nodeId: ctx.node.id }))}><H3Icon name={busy ? "close" : "sparkles"} /> {busy ? "取消生成" : "生成当前 Clip"}</button><button type="button" className="minimax-run-all" onClick={() => { ctx.openPanel(); ctx.emit("minimax-h3:run-all", { nodeId: ctx.node.id }); }}>运行当前及后续</button></div>
    </div>;
}
