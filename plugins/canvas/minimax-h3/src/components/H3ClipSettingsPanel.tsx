import { useRef, useState } from "@infinite-canvas/plugin-sdk";
import type { CanvasNodeContext } from "@infinite-canvas/plugin-sdk";
import type { H3Segment } from "../types";
import { exportH3Settings, importH3Settings } from "../services/h3-segment-utils";
import { ClipSettings } from "./ClipSettings";
import { H3Icon } from "./H3Icon";

type Props = { ctx: CanvasNodeContext; metadata: Record<string, unknown>; selected?: H3Segment; patchSelected: (patch: Partial<H3Segment>) => void };

export function H3ClipSettingsPanel({ ctx, metadata, selected, patchSelected }: Props) {
    const busy = ["queued", "loading"].includes(String(metadata.status || ""));
    const fileRef = useRef<HTMLInputElement | null>(null);
    const [transferMessage, setTransferMessage] = useState("");
    const downloadSettings = () => {
        const blob = new Blob([JSON.stringify(exportH3Settings(selected), null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = "minimax-h3-settings.json";
        anchor.click();
        URL.revokeObjectURL(url);
        setTransferMessage("已导出");
    };
    const readSettings = async (file: File) => {
        try {
            const patch = importH3Settings(JSON.parse(await file.text()));
            if (!patch || !Object.keys(patch).length) throw new Error("参数文件格式不正确");
            patchSelected(patch);
            setTransferMessage("已导入");
        } catch (error) {
            setTransferMessage(error instanceof Error ? error.message : "导入失败");
        }
    };
    return <div className="minimax-clip-parameters">
        <div className="minimax-section-label"><H3Icon name="sliders" /> <span>Setting</span><span className="nfh3-settings-transfer"><button type="button" title="导入参数设置" onClick={() => fileRef.current?.click()}><H3Icon name="restore" /></button><button type="button" title="导出参数设置" onClick={downloadSettings}><H3Icon name="download" /></button><input ref={fileRef} type="file" accept="application/json,.json" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void readSettings(file); event.currentTarget.value = ""; }} /></span><small className="nfh3-transfer-message">{transferMessage}</small><small className="nfh3-panel-status">{busy ? "运行中" : "就绪"}</small></div>
        <ClipSettings ctx={ctx} metadata={metadata} segment={selected} patch={patchSelected} />
        <div className="nfh3-panel-actions"><button type="button" className={busy ? "minimax-reset" : "minimax-run"} onClick={() => busy ? ctx.emit("minimax-h3:cancel", { nodeId: ctx.node.id }) : (ctx.openPanel(), ctx.emit("minimax-h3:run", { nodeId: ctx.node.id }))}><H3Icon name={busy ? "close" : "sparkles"} /> {busy ? "取消生成" : "生成当前 Clip"}</button><button type="button" className="minimax-run-all" onClick={() => { ctx.openPanel(); ctx.emit("minimax-h3:run-all", { nodeId: ctx.node.id }); }}>运行当前及后续</button></div>
    </div>;
}
