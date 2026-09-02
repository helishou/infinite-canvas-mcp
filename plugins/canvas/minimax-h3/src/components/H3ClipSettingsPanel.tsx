import type { CanvasNodeContext } from "@infinite-canvas/plugin-sdk";
import type { H3Segment } from "../types";
import { ClipSettings } from "./ClipSettings";
import { H3Icon } from "./H3Icon";

type Props = { ctx: CanvasNodeContext; metadata: Record<string, unknown>; selected?: H3Segment; patchSelected: (patch: Partial<H3Segment>) => void };

export function H3ClipSettingsPanel({ ctx, metadata, selected, patchSelected }: Props) {
    const busy = ["queued", "loading"].includes(String(metadata.status || ""));
    return <div className="minimax-clip-parameters">
        <div className="minimax-section-label"><H3Icon name="sliders" /> <span>Clip settings</span></div>
        <div className="minimax-settings">
            <label className="minimax-wide-setting"><span>Engine</span><select value={String(metadata.minimaxEngine || "comfyui")} onChange={(event) => ctx.updateMetadata({ minimaxEngine: event.target.value })}><option value="comfyui">ComfyUI</option><option value="runninghub">RunningHub</option></select></label>
            {String(metadata.minimaxEngine || "comfyui") === "runninghub" ? <>
                <label className="minimax-wide-setting"><span>RunningHub Workflow ID</span><input value={String(metadata.minimaxRunningHubWorkflowId || "")} onChange={(event) => ctx.updateMetadata({ minimaxRunningHubWorkflowId: event.target.value })} placeholder="Workflow ID" /></label>
                <label className="minimax-wide-setting"><span>RunningHub App ID</span><input value={String(metadata.minimaxRunningHubAppId || "")} onChange={(event) => ctx.updateMetadata({ minimaxRunningHubAppId: event.target.value })} placeholder="可选" /></label>
                <label className="minimax-wide-setting"><span>RunningHub 模式</span><select value={String(metadata.minimaxRunningHubMode || "workflow")} onChange={(event) => ctx.updateMetadata({ minimaxRunningHubMode: event.target.value })}><option value="workflow">Workflow</option><option value="app">App</option></select></label>
                <label className="minimax-wide-setting"><span>使用钱包余额</span><select value={metadata.minimaxRunningHubUseWallet === true ? "yes" : "no"} onChange={(event) => ctx.updateMetadata({ minimaxRunningHubUseWallet: event.target.value === "yes" })}><option value="no">否</option><option value="yes">是</option></select></label>
                <label className="minimax-wide-setting"><span>RunningHub 字段 JSON</span><textarea rows={3} value={typeof metadata.minimaxRunningHubFieldsText === "string" ? metadata.minimaxRunningHubFieldsText : JSON.stringify(metadata.minimaxRunningHubFields || [], null, 2)} onChange={(event) => { const value = event.target.value; try { ctx.updateMetadata({ minimaxRunningHubFieldsText: value, minimaxRunningHubFields: JSON.parse(value) }); } catch { ctx.updateMetadata({ minimaxRunningHubFieldsText: value }); } }} placeholder='[{"nodeId":"138","fieldName":"text","fieldType":"prompt","enabled":true}]' /></label>
                <label className="minimax-wide-setting"><span>RunningHub 参数 JSON</span><textarea rows={2} value={typeof metadata.minimaxRunningHubParamsText === "string" ? metadata.minimaxRunningHubParamsText : JSON.stringify(metadata.minimaxRunningHubParams || {}, null, 2)} onChange={(event) => { const value = event.target.value; try { ctx.updateMetadata({ minimaxRunningHubParamsText: value, minimaxRunningHubParams: JSON.parse(value) }); } catch { ctx.updateMetadata({ minimaxRunningHubParamsText: value }); } }} placeholder='{"nodeId::fieldName":"value"}' /></label>
                <label className="minimax-wide-setting"><span>RunningHub Workflow JSON</span><textarea rows={2} value={typeof metadata.minimaxRunningHubWorkflowJsonText === "string" ? metadata.minimaxRunningHubWorkflowJsonText : JSON.stringify(metadata.minimaxRunningHubWorkflowJson || {}, null, 2)} onChange={(event) => { const value = event.target.value; try { ctx.updateMetadata({ minimaxRunningHubWorkflowJsonText: value, minimaxRunningHubWorkflowJson: JSON.parse(value) }); } catch { ctx.updateMetadata({ minimaxRunningHubWorkflowJsonText: value }); } }} placeholder="可选：完整 workflow JSON" /></label>
            </> : null}
            <label><span>Duration</span><input type="number" value={Number(selected?.duration || 5)} onChange={(event) => patchSelected({ duration: Number(event.target.value) })} /><b>s</b></label>
            <label><span>Megapixels</span><input type="number" step="0.1" value={Number(selected?.megapixels || metadata.megapixels || 0.4)} onChange={(event) => patchSelected({ megapixels: Number(event.target.value) })} /><b>MP</b></label>
            <label className="minimax-wide-setting"><span>Aspect ratio</span><select value={String(selected?.aspectRatio || "16:9")} onChange={(event) => patchSelected({ aspectRatio: event.target.value })}><option>16:9</option><option>9:16</option><option>1:1</option><option>4:3</option><option>3:4</option><option>21:9</option></select></label>
            <ClipSettings ctx={ctx} metadata={metadata} segment={selected} patch={patchSelected} />
            <button type="button" className={busy ? "minimax-reset" : "minimax-run"} onClick={() => busy ? ctx.emit("minimax-h3:cancel", { nodeId: ctx.node.id }) : (ctx.openPanel(), ctx.emit("minimax-h3:run", { nodeId: ctx.node.id }))}><H3Icon name={busy ? "close" : "sparkles"} /> {busy ? "Reset" : "Generate clip"}</button>
        </div>
    </div>;
}
