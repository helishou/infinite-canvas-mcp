import { useEffect, useState } from "@infinite-canvas/plugin-sdk";
import type { CanvasNodeContext } from "@infinite-canvas/plugin-sdk";
import { Button, InputNumber, Select, Switch } from "antd";

import { h3LoraOptions, h3ModelOptions } from "../constants";
import { discoverH3Models, mergeH3Options } from "../services/model-discovery";
import { normalizeH3Model } from "../services/h3-compatibility";
import type { H3Segment } from "../types";

type Props = { ctx: CanvasNodeContext; metadata: Record<string, unknown>; segment?: H3Segment; patch: (value: Partial<H3Segment>) => void };

export function ClipSettings({ ctx, metadata, segment, patch }: Props) {
    const [comfyModels, setComfyModels] = useState<{ models: string[]; loras: string[] }>({ models: [], loras: [] });
    useEffect(() => {
        let active = true;
        void discoverH3Models(ctx).then((value) => { if (active) setComfyModels(value); });
        return () => { active = false; };
    // CanvasNodeContext is recreated on every canvas render. Depending on
    // ctx.ai here would therefore re-run the effect after setState forever.
    // The ComfyUI catalog is loaded once when the settings component mounts.
    }, []);
    if (!segment) return null;
    const field = { width: "100%" } as const;
    const labelFor = (value: string) => value.replace(/^.*[\\/]/, "");
    const modelOptions = mergeH3Options(h3ModelOptions, comfyModels.models, labelFor);
    const loraOptions = mergeH3Options(h3LoraOptions, comfyModels.loras, labelFor);
    const options = (items: { value: string; label: string }[]) => items.map((option) => ({ value: option.value, label: option.label }));
    return <div className="minimax-settings-extra" style={{ display: "contents" }}>
        <label className="minimax-wide-setting"><span>Task mode</span><Select style={field} value={String(segment.taskMode || "r2v")} options={options([{ value: "t2v", label: "文生视频" }, { value: "i2v", label: "图生视频" }, { value: "fl2v", label: "首尾帧生视频" }, { value: "r2v", label: "参考主体" }, { value: "v2v", label: "视频编辑" }, { value: "rv2v", label: "参考素材改视频" }])} onChange={(value) => patch({ taskMode: value })} /></label>
        <label className="minimax-wide-setting"><span>加速LoRA</span><Select style={field} value={String(segment.loraName ?? metadata.loraName ?? "")} options={options(loraOptions)} onChange={(value) => patch({ loraName: value })} /></label>
        <label className="minimax-wide-setting"><span>Base model</span><Select style={field} value={normalizeH3Model(segment.modelName || metadata.minimaxBaseModel || metadata.modelName)} options={options(modelOptions)} onChange={(value) => patch({ modelName: value })} /></label>
        <label><span>Video steps</span><InputNumber style={field} min={1} max={60} value={Number(segment.videoSteps || (segment.loraName ? 8 : 20))} onChange={(value) => patch({ videoSteps: Number(value || 0) })} /></label>
        <label><span>Denoise</span><InputNumber style={field} min={0} max={1} step={0.05} value={Number(segment.denoise ?? metadata.denoise ?? 0.65)} onChange={(value) => patch({ denoise: Number(value ?? 0.65) })} /></label>
        <label><span>Seed mode</span><Select style={field} value={segment.noiseSeedMode === "fixed" ? "fixed" : "random"} options={[{ value: "random", label: "随机" }, { value: "fixed", label: "固定" }]} onChange={(value) => patch({ noiseSeedMode: value as "random" | "fixed", noiseSeed: value === "fixed" ? (segment.noiseSeed ?? segment.seed ?? Math.floor(Math.random() * 4294967296)) : undefined })} /></label>
        {segment.noiseSeedMode === "fixed" ? <label><span>Seed</span><InputNumber style={field} min={0} max={4294967295} value={Number(segment.noiseSeed ?? segment.seed ?? 0)} onChange={(value) => patch({ noiseSeed: value ?? undefined, seed: value ?? undefined })} /></label> : null}
        <label><span>TE speed</span><Select style={field} value={segment.teAccel === true ? "fast" : "std"} options={[{ value: "std", label: "standard" }, { value: "fast", label: "fast" }]} onChange={(value) => patch({ teAccel: value === "fast" })} /></label>
        <label><span>Combat LoRA</span><InputNumber style={field} min={0} max={2} step={0.01} value={Number(segment.combatLoraWeight || 0)} onChange={(value) => patch({ combatLoraWeight: Number(value || 0) })} /></label>
        <label><span>Cinematic LoRA</span><InputNumber style={field} min={0} max={2} step={0.01} value={Number(segment.cinematicLoraWeight || 0)} onChange={(value) => patch({ cinematicLoraWeight: Number(value || 0) })} /></label>
        <SettingToggle ctx={ctx} label="Motion Context" value={segment.motionContextEnabled !== false} onChange={(value) => patch({ motionContextEnabled: value, tailFrameEnabled: value })} />
        <SettingToggle ctx={ctx} label="防朗读" value={segment.noDub !== false} onChange={(value) => patch({ noDub: value })} />
        <SettingToggle ctx={ctx} label="无字幕水印" value={segment.noCaption !== false} onChange={(value) => patch({ noCaption: value })} />
        
        <hr className="minimax-settings-divider" style={{ border: "none", borderTop: "1px solid rgba(128, 128, 128, 0.35)", margin: "8px 0" }} />
        <label><span>Global MP</span><InputNumber style={field} min={0.1} max={2} step={0.1} value={Number(metadata.minimaxGlobalMegapixels || metadata.megapixels || 1)} onChange={(value) => ctx.updateMetadata({ minimaxGlobalMegapixels: Number(value || 0) })} /></label>
        <label><span>Global steps</span><InputNumber style={field} min={1} max={60} value={Number(metadata.minimaxGlobalVideoSteps || metadata.videoSteps || 6)} onChange={(value) => ctx.updateMetadata({ minimaxGlobalVideoSteps: Number(value || 0) })} /></label>
        <SettingToggle ctx={ctx} label="Global LoRA" value={metadata.minimaxGlobalLoraEnabled !== false} onChange={(value) => ctx.updateMetadata({ minimaxGlobalLoraEnabled: value })} />
        <SettingToggle ctx={ctx} label="Global TE" value={metadata.minimaxGlobalTeAccel === true} onChange={(value) => ctx.updateMetadata({ minimaxGlobalTeAccel: value })} />
        <Button type="primary" className="minimax-run-all" onClick={() => { ctx.openPanel(); ctx.emit("minimax-h3:run-all", { nodeId: ctx.node.id }); }}>一键运行全部 Clip</Button>
        
    </div>
}

function SettingToggle({ ctx, label, value, onChange }: { ctx: CanvasNodeContext; label: string; value: boolean; onChange: (value: boolean) => void }) {
    return <Switch checked={value} onChange={onChange} checkedChildren={label} unCheckedChildren={label} size="small" />;
}
