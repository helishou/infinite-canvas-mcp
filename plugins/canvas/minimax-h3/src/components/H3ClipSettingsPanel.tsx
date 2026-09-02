import type { CanvasNodeContext } from "@infinite-canvas/plugin-sdk";
import type { H3Segment } from "../types";
import { ClipSettings } from "./ClipSettings";
import { H3Icon } from "./H3Icon";

type Props = { ctx: CanvasNodeContext; metadata: Record<string, unknown>; selected?: H3Segment; patchSelected: (patch: Partial<H3Segment>) => void };

export function H3ClipSettingsPanel({ ctx, metadata, selected, patchSelected }: Props) {
    return <div className="minimax-clip-parameters">
        <div className="minimax-section-label"><H3Icon name="sliders" /> <span>Clip settings</span></div>
        <div className="minimax-settings">
            <label className="minimax-wide-setting"><span>Engine</span><select value={String(metadata.minimaxEngine || "comfyui")} onChange={(event) => ctx.updateMetadata({ minimaxEngine: event.target.value })}><option value="comfyui">ComfyUI</option><option value="runninghub">RunningHub</option></select></label>
            <label><span>Duration</span><input type="number" value={Number(selected?.duration || 5)} onChange={(event) => patchSelected({ duration: Number(event.target.value) })} /><b>s</b></label>
            <label><span>Megapixels</span><input type="number" step="0.1" value={Number(selected?.megapixels || metadata.megapixels || 0.4)} onChange={(event) => patchSelected({ megapixels: Number(event.target.value) })} /><b>MP</b></label>
            <label className="minimax-wide-setting"><span>Aspect ratio</span><select value={String(selected?.aspectRatio || "16:9")} onChange={(event) => patchSelected({ aspectRatio: event.target.value })}><option>16:9</option><option>9:16</option><option>1:1</option><option>4:3</option></select></label>
            <ClipSettings ctx={ctx} metadata={metadata} segment={selected} patch={patchSelected} />
            <button type="button" className="minimax-run" onClick={() => { ctx.openPanel(); ctx.emit("minimax-h3:run", { nodeId: ctx.node.id }); }}><H3Icon name="sparkles" /> Generate clip</button>
        </div>
    </div>;
}
