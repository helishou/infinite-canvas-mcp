import { useRef, useState } from "@infinite-canvas/plugin-sdk";
import type { CanvasNodeContext } from "@infinite-canvas/plugin-sdk";
import type { H3Segment } from "../types";
import { exportH3Settings, importH3Settings } from "../services/h3-segment-utils";
import { writeDefaultParams } from "../services/h3-defaults";
import { ClipSettings } from "./ClipSettings";
import { H3Icon } from "./H3Icon";
import { requestH3Run } from "./H3WorkbenchPrimitives";

type Props = { ctx: CanvasNodeContext; metadata: Record<string, unknown>; selected?: H3Segment; patchSelected: (patch: Partial<H3Segment>) => void };

export function H3ClipSettingsPanel({ ctx, metadata, selected, patchSelected }: Props) {
    // 按钮 busy 只反映 H3 生成（ComfyUI 任务）状态：必须同时满足
    // 「runtimeTaskId 存在」且「status 处于运行态(queued/loading)」。
    // 仅看 runtimeTaskId 不够：任务成功后 runtimeTaskId 若未及时清空（历史节点、
    // 刷新恢复等路径），残留的 taskId 会让按钮卡在"取消生成"，用户点一下反而去
    // cancel 一个已终态(success)的任务而报错。加 status 守卫后，只要任务已结束
    // （success/error/cancelled/idle），按钮一律回归初始态"生成当前 Clip"。
    const status = String(metadata.status || "idle");
    const busy = !!String(metadata.runtimeTaskId || "").trim() && ["queued", "loading"].includes(status);
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
    const saveAsDefault = () => {
        const settings = exportH3Settings(selected).settings;
        if (!settings || !Object.keys(settings).length) {
            setTransferMessage("无可保存的参数");
            return;
        }
        writeDefaultParams(settings);
        setTransferMessage("已设为默认参数");
    };
    return <div className="minimax-clip-parameters">
        <div key="settings-header" className="minimax-section-label"><H3Icon name="sliders" /> <span>Setting</span><span className="nfh3-settings-transfer"><button type="button" title="导入参数设置" onClick={() => fileRef.current?.click()}><H3Icon name="restore" /></button><button type="button" title="导出参数设置" onClick={downloadSettings}><H3Icon name="download" /></button><button type="button" title="设为默认参数（新建 H3 节点将自动携带当前参数）" onClick={saveAsDefault}><H3Icon name="database" /></button><input ref={fileRef} type="file" accept="application/json,.json" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void readSettings(file); event.currentTarget.value = ""; }} /></span><small className="nfh3-transfer-message">{transferMessage}</small><small className="nfh3-panel-status">{busy ? "运行中" : "就绪"}</small></div>
        <ClipSettings key="clip-settings" ctx={ctx} metadata={metadata} segment={selected} patch={patchSelected} />
        <div key="panel-actions" className="nfh3-panel-actions"><button type="button" className={busy ? "minimax-reset" : "minimax-run"} onClick={() => { const runtimeTaskId = String(metadata.runtimeTaskId || ""); const stuck = busy && !runtimeTaskId; if (busy && !stuck) { ctx.emit("minimax-h3:cancel", { nodeId: ctx.node.id }); return; } ctx.openPanel(); if (stuck) ctx.updateMetadata({ status: "idle", errorDetails: "", runtimeTaskId: "", runProgress: 0, cancelRequested: false, runRequestId: "", runRequestConsumedId: "" }); requestH3Run(ctx); }}><H3Icon name={busy ? "close" : "sparkles"} /> {busy ? "取消生成" : "生成当前 Clip"}</button><button type="button" className={busy ? "minimax-reset" : "minimax-run-all"} onClick={() => { if (busy) { ctx.emit("minimax-h3:cancel", { nodeId: ctx.node.id }); return; } ctx.openPanel(); requestH3Run(ctx, true); }}><H3Icon name={busy ? "close" : "forward"} /> {busy ? "取消运行" : "运行当前及后续"}</button></div>
    </div>;
}
