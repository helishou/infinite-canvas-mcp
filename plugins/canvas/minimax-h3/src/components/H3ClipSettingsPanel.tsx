import { useRef, useState } from "@infinite-canvas/plugin-sdk";
import type { CanvasNodeContext } from "@infinite-canvas/plugin-sdk";
import type { H3Segment } from "../types";
import { exportH3Settings, importH3Settings } from "../services/h3-segment-utils";
import { writeDefaultParams } from "../services/h3-defaults";
import type { H3DefaultLayout } from "../services/h3-defaults";
import { ClipSettings } from "./ClipSettings";
import { H3Icon } from "./H3Icon";
import { requestH3Run, resetAndRequestH3Run, resolveH3PaneSizes } from "./H3WorkbenchPrimitives";

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
    const awaitingConfirmation = status === "awaiting_confirmation" && selected?.firstPassReady === true && String(selected.status || "") === "awaiting_confirmation";
    // stuck = 处于运行态却拿不到真实后端任务 id（任务失联 / 日志丢失 / 刷新后轮询无法恢复）。
    // 此时 cancel 后端无意义，应直接清状态回 idle 让用户重新点生成（见下方 onClick 的 stuck 分支）。
    const stuck = busy && !runtimeTaskId;
    const fileRef = useRef<HTMLInputElement | null>(null);
    const [transferMessage, setTransferMessage] = useState("");
    const resolveConfirmation = async (action: "confirm" | "keep_first_pass" | "discard") => {
        if (!runtimeTaskId || !selected?.id || !selected.firstPassFingerprint) { setTransferMessage("缺少待确认任务或一采快照，请刷新后重试"); return; }
        try {
            await ctx.ai.resolveH3Confirmation({ taskId: runtimeTaskId, action, segmentIds: [selected.id], firstPassFingerprint: selected.firstPassFingerprint, ...(action === "confirm" && metadata.errorDetails ? { retry: true } : {}) });
            setTransferMessage(action === "confirm" ? "已恢复二采" : action === "keep_first_pass" ? "已保留一采" : "已放弃本次任务");
        } catch (error) { setTransferMessage(error instanceof Error ? error.message : String(error)); }
    };
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
        // 布局快照：节点宽高 + 各模块区域宽高（手柄拖拽写入的 minimax* 键）。
        const node = ctx.node;
        const layout: H3DefaultLayout = {
            width: node.width,
            height: node.height,
            panes: resolveH3PaneSizes(node.metadata),
        };
        const payload = { ...(settings || {}), layout };
        // 布局先落本地缓存，再写 Backend：后端不可用时本浏览器的新建节点仍能恢复默认布局。
        writeDefaultParams(payload);
        if (!settings || !Object.keys(settings).length) {
            setTransferMessage("已设为默认布局");
            return;
        }
        try {
            await ctx.h3Defaults.set(payload);
            setTransferMessage("已设为默认参数");
        } catch (error) {
            setTransferMessage(error instanceof Error ? error.message : "保存默认参数失败");
        }
    };
    return <div className="minimax-clip-parameters">
        <div key="settings-header" className="minimax-section-label"><H3Icon name="sliders" /> <span>Setting</span><span className="nfh3-settings-transfer"><button type="button" title="导入参数设置" onClick={() => fileRef.current?.click()}><H3Icon name="restore" /></button><button type="button" title="导出参数设置" onClick={downloadSettings}><H3Icon name="download" /></button><button type="button" title="设为默认参数（新建 H3 节点将自动携带当前参数）" onClick={saveAsDefault}><H3Icon name="database" /></button><input ref={fileRef} type="file" accept="application/json,.json" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void readSettings(file); event.currentTarget.value = ""; }} /></span><small className="nfh3-transfer-message">{transferMessage}</small><small className="nfh3-panel-status">{busy ? "运行中" : "就绪"}</small></div>
        <ClipSettings key="clip-settings" ctx={ctx} metadata={metadata} segment={selected} patch={patchSelected} />
        <div key="panel-actions" className="nfh3-panel-actions">{awaitingConfirmation ? <><button type="button" className="minimax-run" onClick={() => void resolveConfirmation("confirm")}><H3Icon name="sparkles" /> 确认并精修</button><button type="button" onClick={() => void resolveConfirmation("keep_first_pass")}>保留一采</button><button type="button" onClick={() => void resolveConfirmation("discard")}>放弃任务</button></> : status === "awaiting_confirmation" ? <span>请选中待确认的 Clip</span> : <><button type="button" className={busy || stuck ? "minimax-reset" : "minimax-run"} onClick={() => { ctx.openPanel(); if (busy) { ctx.emit("minimax-h3:reset-and-run", { nodeId: ctx.node.id, all: false }); return; } requestH3Run(ctx); }}><H3Icon name={busy || stuck ? "restore" : "sparkles"} /> {busy || stuck ? "重置并重新生成" : "生成当前 Clip"}</button><button type="button" className={busy ? "minimax-reset" : "minimax-run-all"} onClick={() => { ctx.openPanel(); if (busy) { ctx.emit("minimax-h3:reset-and-run", { nodeId: ctx.node.id, all: true }); return; } requestH3Run(ctx, true); }}><H3Icon name={busy ? "restore" : "forward"} /> {busy ? "重置并重新运行" : "运行当前及后续"}</button></>}</div>
    </div>;
}
