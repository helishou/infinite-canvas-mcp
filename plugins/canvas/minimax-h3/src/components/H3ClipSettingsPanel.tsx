import { useRef, useState } from "@infinite-canvas/plugin-sdk";
import type { CanvasNodeContext } from "@infinite-canvas/plugin-sdk";
import type { H3Segment } from "../types";
import { exportH3Settings, importH3Settings } from "../services/h3-segment-utils";
import { writeDefaultParams } from "../services/h3-defaults";
import type { H3DefaultLayout } from "../services/h3-defaults";
import { ClipSettings } from "./ClipSettings";
import { H3Icon } from "./H3Icon";
import { requestH3Run, resolveH3PaneSizes } from "./H3WorkbenchPrimitives";

type Props = { ctx: CanvasNodeContext; metadata: Record<string, unknown>; selected?: H3Segment; patchSelected: (patch: Partial<H3Segment>) => void };

export function H3ClipSettingsPanel({ ctx, metadata, selected, patchSelected }: Props) {
    // 按钮 busy 只反映 H3 生成（ComfyUI 任务）状态：必须同时满足
    // 「runtimeTaskId 存在」且「status 处于运行态(queued/loading)」。
    // 仅看 runtimeTaskId 不够：任务成功后 runtimeTaskId 若未及时清空（历史节点、
    // 刷新恢复等路径），残留的 taskId 会让按钮卡在"取消生成"，用户点一下反而去
    // cancel 一个已终态(success)的任务而报错。加 status 守卫后，只要任务已结束
    // （success/error/cancelled/idle），按钮一律回归初始态"生成当前 Clip"。
    const status = String(metadata.status || "idle");
    const runtimeTaskId = String(metadata.runtimeTaskId || "");
    // busy 只认生成状态位：status 处于 queued/loading 即视为忙碌。
    // 绝不能把 runtimeTaskId 作为 busy 的先决条件——否则「status 卡在 loading 但
    // runtimeTaskId 为空」(父任务创建前请求中断或历史状态残留) 时 busy 反为假，
    // 按钮显示“生成当前 Clip”，但 requestH3Run 的 status
    // 守卫会静默吞掉点击，表现成“点不了生成按钮”。原注释担心的“任务成功后残留 taskId
    // 让按钮卡在取消”不会发生：成功时 status 已是 success，busy 本就为假。
    const busy = ["queued", "loading"].includes(status);
    // stuck = 处于运行态却拿不到真实后端任务 id（任务失联 / 日志丢失 / 刷新后轮询无法恢复）。
    // 此时 cancel 后端无意义，应直接清状态回 idle 让用户重新点生成（见下方 onClick 的 stuck 分支）。
    const stuck = busy && !runtimeTaskId;
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
    const saveAsDefault = async () => {
        const settings = exportH3Settings(selected).settings;
        if (!settings || !Object.keys(settings).length) {
            setTransferMessage("无可保存的参数");
            return;
        }
        // 布局快照：节点宽高 + 各模块区域宽高（手柄拖拽写入的 minimax* 键）。
        const node = ctx.node;
        const layout: H3DefaultLayout = {
            width: node.width,
            height: node.height,
            panes: resolveH3PaneSizes(node.metadata),
        };
        try {
            await ctx.h3Defaults.set(settings);
            // 新建节点工厂是同步入口，更新当前页面内存缓存；权威数据仍在 Backend。
            // 布局只保留在当前页面缓存：后端默认参数是生成参数，不参与布局恢复。
            writeDefaultParams({ ...settings, layout });
            setTransferMessage("已设为默认参数");
        } catch (error) {
            setTransferMessage(error instanceof Error ? error.message : "保存默认参数失败");
        }
    };
    return <div className="minimax-clip-parameters">
        <div key="settings-header" className="minimax-section-label"><H3Icon name="sliders" /> <span>Setting</span><span className="nfh3-settings-transfer"><button type="button" title="导入参数设置" onClick={() => fileRef.current?.click()}><H3Icon name="restore" /></button><button type="button" title="导出参数设置" onClick={downloadSettings}><H3Icon name="download" /></button><button type="button" title="设为默认参数（新建 H3 节点将自动携带当前参数）" onClick={saveAsDefault}><H3Icon name="database" /></button><input ref={fileRef} type="file" accept="application/json,.json" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void readSettings(file); event.currentTarget.value = ""; }} /></span><small className="nfh3-transfer-message">{transferMessage}</small><small className="nfh3-panel-status">{busy ? "运行中" : "就绪"}</small></div>
        <ClipSettings key="clip-settings" ctx={ctx} metadata={metadata} segment={selected} patch={patchSelected} />
        <div key="panel-actions" className="nfh3-panel-actions"><button type="button" className={(busy || stuck) ? "minimax-reset" : "minimax-run"} onClick={() => { if (busy && !stuck) { ctx.emit("minimax-h3:cancel", { nodeId: ctx.node.id }); return; } ctx.openPanel(); if (stuck) ctx.updateMetadata({ status: "idle", errorDetails: "", runtimeTaskId: "", runProgress: 0, cancelRequested: false, runRequestId: "", runRequestConsumedId: "" }); requestH3Run(ctx); }}><H3Icon name={(busy && !stuck) ? "close" : "sparkles"} /> {stuck ? "重置并重新生成" : busy ? "取消生成" : "生成当前 Clip"}</button><button type="button" className={(busy && !stuck) ? "minimax-reset" : "minimax-run-all"} onClick={() => { if (busy && !stuck) { ctx.emit("minimax-h3:cancel", { nodeId: ctx.node.id }); return; } ctx.openPanel(); if (stuck) ctx.updateMetadata({ status: "idle", errorDetails: "", runtimeTaskId: "", runProgress: 0, cancelRequested: false, runRequestId: "", runRequestConsumedId: "" }); requestH3Run(ctx, true); }}><H3Icon name={(busy && !stuck) ? "close" : "forward"} /> {stuck ? "重置并重新运行" : busy ? "取消运行" : "运行当前及后续"}</button></div>
    </div>;
}
