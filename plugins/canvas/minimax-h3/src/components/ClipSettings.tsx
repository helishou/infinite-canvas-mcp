import { useEffect, useState, type ReactNode } from "react";
import type { CanvasNodeContext } from "@infinite-canvas/plugin-sdk";
import { InputNumber, Switch } from "antd";
import { h3LoraOptions, h3ModelOptions } from "../constants";
import { discoverH3Models, mergeH3Options } from "../services/model-discovery";
import type { H3Segment } from "../types";

type Props = { ctx: CanvasNodeContext; metadata: Record<string, unknown>; segment?: H3Segment; patch: (value: Partial<H3Segment>) => void };
type SectionKey = "mode" | "model" | "sampling" | "lora" | "sla" | "runtime" | "latentUpscale" | "preview" | "rtx" | "audio";
const sectionKeys: SectionKey[] = ["mode", "model", "sampling", "lora", "sla", "runtime", "latentUpscale", "preview", "rtx", "audio"];
const modeLabels = { t2v: "文生视频", i2v: "图生视频", fl2v: "首尾帧", ref2va: "多参考 Ref2VA" } as const;
const modeHints = { t2v: "不使用图片", i2v: "1 张首帧", fl2v: "首帧＋尾帧", ref2va: "图片 / 视频 / 音频" } as const;
const encoderTypes = ["minimax"];
const encoderDevices = ["default", "cpu"];
const precisions = ["default", "fp8_e4m3fn", "fp8_e5m2"];
const attentionModes = ["disabled", "auto", "sageattn_qk_int8_pv_fp16_cuda", "sageattn_qk_int8_pv_fp16_triton", "sageattn_qk_int8_pv_fp8_cuda", "sageattn_qk_int8_pv_fp8_cuda++", "sageattn3", "sageattn3_per_block_mean"];
const h3AttentionModes = [
    "关闭",
    "自动",
    "sageattn_qk_int8_pv_fp16_cuda",
    "sageattn_qk_int8_pv_fp16_triton",
    "sageattn_qk_int8_pv_fp8_cuda",
    "sageattn_qk_int8_pv_fp8_cuda++",
    "H3专用Sage加速",
];
const ratios = ["16:9 (Widescreen)", "9:16 (Portrait)", "1:1 (Square)", "4:3", "3:4", "21:9"];
const megapixels = [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.98, 1, 1.2, 1.5, 1.8, 2];
const samplers = ["res_multistep", "euler", "euler_cfg1_perpneg", "ddim", "uni_pc"];
const schedulers = ["simple", "normal", "karras", "exponential", "sgm_uniform", "ddim_uniform"];
const resizeModes = ["倍数缩放", "目标尺寸"];
const rtxQualities = ["ULTRA", "HIGH", "MEDIUM"];

function H3Dropdown({ values, value, onChange, placeholder, allowClear = false, format }: { values: Array<string | number>; value?: string | number; onChange: (value: string | number) => void; placeholder?: string; allowClear?: boolean; format?: (value: string | number) => string }) {
    const selected = value === undefined || value === null ? "" : String(value);
    return <select className="nfh3-native-select" value={selected} onMouseDown={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()} onChange={(event) => {
        const option = values.find((item) => String(item) === event.target.value);
        onChange(option ?? event.target.value);
    }}>
        {allowClear ? <option value="">{placeholder || "不使用"}</option> : null}
        {placeholder && !allowClear && !values.some((item) => String(item) === selected) ? <option value="" disabled>{placeholder}</option> : null}
        {values.map((item) => <option key={String(item)} value={String(item)}>{format ? format(item) : String(item)}</option>)}
    </select>;
}

export function ClipSettings({ ctx, metadata, segment, patch }: Props) {
    const [catalog, setCatalog] = useState<{ models: string[]; loras: string[]; textEncoders: string[]; videoVaes: string[]; audioVaes: string[]; latentUpscaleModels: string[]; nanfeng: Record<string, unknown[]> }>({ models: [], loras: [], textEncoders: [], videoVaes: [], audioVaes: [], latentUpscaleModels: [], nanfeng: {} });
    useEffect(() => {
        let active = true;
        void discoverH3Models(ctx).then((value) => {
            if (!active) return;
            setCatalog(value);
            if (segment?.latentUpscaleEnabled === true && !String(segment.latentUpscaleModel || "").trim() && value.latentUpscaleModels[0]) patch({ latentUpscaleModel: value.latentUpscaleModels[0] });
        });
        return () => { active = false; };
    }, [ctx.ai, segment?.id, segment?.latentUpscaleEnabled, segment?.latentUpscaleModel]);
    if (!segment) return null;
    const mode = (segment.mode || segment.taskMode || "ref2va") as keyof typeof modeLabels;
    const expanded = (metadata.nanFengExpandedSections as Record<string, boolean> | undefined) || {};
    const setOpen = (key: SectionKey) => {
        const opening = expanded[key] !== true;
        ctx.updateMetadata({ nanFengExpandedSections: Object.fromEntries(sectionKeys.map((section) => [section, opening && section === key])) });
    };
    const isH3Model = (value: string) => /(?:^|[\\/])h3(?:[\\/]|$)/i.test(value);
    const modelOptions = mergeH3Options(h3ModelOptions.filter((option) => isH3Model(option.value)), catalog.models.filter(isH3Model), (value) => value.replace(/^.*[\\/]/, ""));
    const isMinimaxLora = (value: string) => /(?:^|[\\/])minimax(?:[\\/]|$)/i.test(value);
    const loraOptions = mergeH3Options(h3LoraOptions.filter((option) => isMinimaxLora(option.value)), catalog.loras.filter(isMinimaxLora), (value) => value.replace(/^.*[\\/]/, ""));
    const nfChoices = (key: string, fallback: Array<string | number>) => {
        const values = catalog.nanfeng[key];
        return Array.isArray(values) && values.length ? values.filter((value): value is string | number => typeof value === "string" || typeof value === "number") : fallback;
    };
    const encoderTypeChoices = nfChoices("文本编码器类型", encoderTypes);
    const encoderDeviceChoices = nfChoices("文本编码器设备", encoderDevices);
    const precisionChoices = nfChoices("模型权重精度", precisions);
    const ratioChoices = nfChoices("画面比例", ratios);
    const rawRatio = String(segment.aspectRatio || "16:9 (Widescreen)");
    const selectedRatio = ratioChoices.find((value) => String(value) === rawRatio)
        || ratioChoices.find((value) => String(value).startsWith(`${rawRatio} `))
        || ratioChoices.find((value) => String(value).startsWith("16:9"))
        || ratioChoices[0];
    const megapixelChoices = nfChoices("百万像素", megapixels);
    const samplerChoices = nfChoices("采样器", samplers);
    const schedulerChoices = nfChoices("调度器", schedulers);
    const seedMode = segment.noiseSeedMode === "fixed" ? "fixed" : "random";
    const sageChoices = nfChoices("SageAttention", attentionModes);
    const attentionChoices = nfChoices("H3专用注意力", h3AttentionModes);
    const slaBackendChoices = nfChoices("SLA稠密后端", ["comfy_kitchen", "pytorch", "auto"]);
    const rtxQualityChoices = nfChoices("RTX质量", rtxQualities);
    const refImageSizeChoices = nfChoices("参考图尺寸", ["match", "max"]);
    const refLongEdgeChoices = nfChoices("参考图最长边", [1280, 1536, 1920]);
    const latentUpscaleModelChoices = catalog.latentUpscaleModels.length ? catalog.latentUpscaleModels : nfChoices("H3潜空间放大模型", []);
    // 画布节点会在父层监听 pointer/mousedown 做拖拽；Select 的文字区域通常能
    // 先触发打开，但右侧箭头区域会被父层抢走。阻止事件继续冒泡，保证整个
    // selector（包括箭头）都是同一个下拉触发热区。
    const field = { width: "100%" } as const;
    const section = (key: SectionKey, title: string, summary: string, content: ReactNode, className = "") => <section className={`nfh3-section ${className}`}><button type="button" className="nfh3-section-head" onClick={() => setOpen(key)}><span className={`nfh3-chevron${expanded[key] === true ? " is-open" : ""}`} aria-hidden="true" /><b>{title}</b><small>{summary}</small></button>{expanded[key] === true ? <div className="nfh3-section-body">{content}</div> : null}</section>;
    const control = (label: string, value: ReactNode, wide = false) => <label className={`nfh3-control${wide ? " wide" : ""}`}><span>{label}</span>{value}</label>;
    const choice = (label: string, values: Array<string | number>, value: unknown, onChange: (value: string | number) => void, format?: (value: string | number) => string, wide = false) => control(label, <H3Dropdown values={values} value={value as string | number} onChange={onChange} format={format} />, wide);
    const loraSlots = (segment.loraSlots?.length ? segment.loraSlots : [{ name: segment.loraName || "", strength: Number(segment.loraStrength ?? 1), enabled: !!segment.loraName }]).slice(0, 8);
    while (loraSlots.length < 3) loraSlots.push({ name: "", strength: 1, enabled: false });
    const patchLoraSlot = (index: number, value: Partial<{ name: string; strength: number; enabled: boolean }>) => {
        const next = loraSlots.map((slot, slotIndex) => slotIndex === index ? { ...slot, ...value } : slot);
        patch({ loraSlots: next, loraName: next[0]?.name || "", loraStrength: next[0]?.strength ?? 0.75 });
    };
    const addLoraSlot = () => { if (loraSlots.length < 8) patch({ loraSlots: [...loraSlots, { name: "", strength: 1, enabled: false }] }); };
    const loraSummary = loraSlots.filter((slot) => slot.enabled && slot.name).length;
    const sigmaPresets = (metadata.h3SigmaPresets && typeof metadata.h3SigmaPresets === "object" ? metadata.h3SigmaPresets : {}) as Record<string, string>;
    const sigmaPresetNames = Object.keys(sigmaPresets);
    const selectedSigmaPreset = String(metadata.h3SigmaPresetName || sigmaPresetNames[0] || "");
    const saveSigmaPreset = (name: string) => { const trimmed = name.trim(); if (!trimmed) return; ctx.updateMetadata({ h3SigmaPresets: { ...sigmaPresets, [trimmed]: String(segment.h3FullSigma || "") }, h3SigmaPresetName: trimmed }); };
    const createSigmaPreset = () => { const name = window.prompt("Sigma 预设名称", `南风${sigmaPresetNames.length + 1}步`); if (name) saveSigmaPreset(name); };
    const deleteSigmaPreset = () => { if (!selectedSigmaPreset) return; const next = { ...sigmaPresets }; delete next[selectedSigmaPreset]; ctx.updateMetadata({ h3SigmaPresets: next, h3SigmaPresetName: Object.keys(next)[0] || "" }); };
    return <div className="nfh3-settings">
        {section("mode", "生成模式", modeLabels[mode] || modeLabels.ref2va, <div className="nfh3-mode-grid">{(Object.keys(modeLabels) as Array<keyof typeof modeLabels>).map((key) => <button key={key} type="button" className={mode === key ? "active" : ""} onClick={() => patch({ mode: key, taskMode: key })}><b>{modeLabels[key]}</b><small>{modeHints[key]}</small><i>{mode === key ? "✓" : ""}</i></button>)}</div>)}
        {section("model", "模型与基础参数", String(segment.modelName || "未选择模型").replace(/^.*[\\/]/, ""), <div className="nfh3-control-grid">
            {control("模型", <H3Dropdown values={modelOptions.map((item) => item.value)} value={segment.modelName || modelOptions[0]?.value} onChange={(value) => patch({ modelName: String(value) })} placeholder="选择模型" />, true)}
            {control("文本编码器", <H3Dropdown values={catalog.textEncoders.filter((value) => /minimax/i.test(value))} value={segment.textEncoder || catalog.textEncoders.find((value) => /minimax/i.test(value))} onChange={(value) => patch({ textEncoder: String(value) })} placeholder="选择文本编码器" />, true)}
            {control("视频 VAE", <H3Dropdown values={catalog.videoVaes} value={segment.videoVae || catalog.videoVaes[0]} onChange={(value) => patch({ videoVae: String(value) })} placeholder="选择视频 VAE" />, true)}
            {control("音频 VAE", <H3Dropdown values={catalog.audioVaes} value={segment.audioVae || catalog.audioVaes[0]} onChange={(value) => patch({ audioVae: String(value) })} placeholder="选择音频 VAE" />, true)}
            {choice("编码器类型", encoderTypeChoices, segment.textEncoderType || "minimax", (value) => patch({ textEncoderType: String(value) }))}
            {choice("编码器设备", encoderDeviceChoices, segment.textEncoderDevice || "default", (value) => patch({ textEncoderDevice: String(value) }))}
            {choice("模型权重精度", precisionChoices, segment.precision || "default", (value) => patch({ precision: String(value) }))}
            {choice("画面比例", ratioChoices, selectedRatio, (value) => patch({ aspectRatio: String(value) }))}
            {choice("百万像素", megapixelChoices, segment.megapixels || 0.4, (value) => patch({ megapixels: Number(value) }), (value) => `${value} MP`)}
            {choice("尺寸倍数", [32], segment.sizeMultiple || 32, (value) => patch({ sizeMultiple: Number(value) }))}
            {mode === "ref2va" ? choice("参考图尺寸", refImageSizeChoices, segment.refImageSize || "match", (value) => patch({ refImageSize: String(value) })) : null}
            {mode !== "t2v" ? choice("参考图最长边", refLongEdgeChoices, segment.referenceLongEdge || 1920, (value) => patch({ referenceLongEdge: Number(value) })) : null}
            {control("时长秒", <InputNumber style={field} min={1} max={15} step={1} value={Number(segment.duration || 5)} onChange={(value) => patch({ duration: Number(value || 5) })} />)}
        </div>)}
        {section("sampling", "采样设置", `${segment.steps || 20} 步 · ${segment.sampler || "res_multistep"}`, <div className="nfh3-control-grid">
            {choice("采样器", samplerChoices, segment.sampler || "res_multistep", (value) => patch({ sampler: String(value) }), undefined, true)}
            {choice("调度器", schedulerChoices, segment.scheduler || "simple", (value) => patch({ scheduler: String(value) }), undefined, true)}
            {control("采样步数", <InputNumber style={field} min={1} max={100} value={Number(segment.steps || 20)} onChange={(value) => patch({ steps: Number(value || 20) })} />)}
            {control("降噪强度", <InputNumber style={field} min={0} max={1} step={0.01} value={Number(segment.denoise ?? 1)} onChange={(value) => patch({ denoise: Number(value ?? 1) })} />)}
            {choice("SageAttention", sageChoices, segment.sageAttention || "auto", (value) => patch({ sageAttention: String(value) }), (value) => String(value).replace(/^sageattn_/, "sage "))}
            {control("允许编译", <Switch checked={segment.allowCompile === true} onChange={(checked) => patch({ allowCompile: checked })} />)}
            {choice("随机种子", ["random", "fixed"], seedMode, (value) => patch({ noiseSeedMode: String(value) as "random" | "fixed" }), (value) => value === "fixed" ? "固定" : "随机")}
            {control("随机种子值", <InputNumber style={field} min={0} precision={0} disabled={seedMode !== "fixed"} value={String(segment.seed ?? segment.noiseSeed ?? "").trim() !== "" ? Number(segment.seed ?? segment.noiseSeed) : undefined} placeholder={seedMode === "fixed" ? "输入固定种子" : "运行后显示本次种子"} onChange={(value) => patch({ seed: value ?? undefined, noiseSeed: value ?? undefined })} />)}
        </div>)}
        {section("sla", "H3 SLA 稀疏注意力", segment.slaEnabled ? `${segment.slaSparsity ?? 0.9} 稀疏率` : "关闭", <div className="nfh3-control-grid">
            {control("启用 SLA", <Switch checked={segment.slaEnabled === true} onChange={(checked) => patch({ slaEnabled: checked })} />)}
            {control("稀疏率", <InputNumber style={field} min={0} max={0.95} step={0.05} value={Number(segment.slaSparsity ?? 0.9)} onChange={(value) => patch({ slaSparsity: Number(value ?? 0.9) })} />)}
            {choice("块大小", ["64", "128"], segment.slaBlockSize || "64", (value) => patch({ slaBlockSize: String(value) }))}
            {control("最短序列", <InputNumber style={field} min={0} step={1024} value={Number(segment.slaMinSequence ?? 4096)} onChange={(value) => patch({ slaMinSequence: Number(value ?? 4096) })} />)}
            {control("末尾稠密步数", <InputNumber style={field} min={0} max={8} value={Number(segment.slaDenseLastSteps ?? 1)} onChange={(value) => patch({ slaDenseLastSteps: Number(value ?? 1) })} />)}
            {control("保护音频", <Switch checked={segment.slaProtectAudio !== false} onChange={(checked) => patch({ slaProtectAudio: checked })} />)}
            {control("关闭 FP16 累加", <Switch checked={segment.slaDisableFp16Accum !== false} onChange={(checked) => patch({ slaDisableFp16Accum: checked })} />)}
            {control("稳定运动", <Switch checked={segment.slaStabilizeMotion !== false} onChange={(checked) => patch({ slaStabilizeMotion: checked })} />)}
            {control("指定稠密步", <input value={String(segment.slaDenseSteps || "0")} onChange={(event) => patch({ slaDenseSteps: event.target.value })} placeholder="0" />)}
            {choice("稠密后端", slaBackendChoices, segment.slaBackend || "comfy_kitchen", (value) => patch({ slaBackend: String(value) }), undefined, true)}
        </div>)}
        {section("latentUpscale", "H3 潜空间放大二采", segment.latentUpscaleEnabled ? "已启用" : "关闭", <div className="nfh3-control-grid">{choice("一采/二采采样器", samplerChoices, segment.sampler || "res_multistep", (value) => patch({ sampler: String(value) }), undefined, true)}{choice("一采/二采调度器", schedulerChoices, segment.scheduler || "simple", (value) => patch({ scheduler: String(value) }), undefined, true)}{control("启用潜空间二采", <Switch checked={segment.latentUpscaleEnabled === true} disabled={!latentUpscaleModelChoices.length} onChange={(checked) => patch({ latentUpscaleEnabled: checked })} />)}{control("一采步数", <InputNumber style={field} min={1} max={20} value={Number(segment.h3FirstSteps ?? 6)} onChange={(value) => patch({ h3FirstSteps: Number(value ?? 6) })} />)}{control("二采步数", <InputNumber style={field} min={1} max={12} value={Number(segment.h3SecondSteps ?? 4)} onChange={(value) => patch({ h3SecondSteps: Number(value ?? 4) })} />)}{control("一采使用手动 Sigma", <Switch checked={segment.v81ManualSigma === true} onChange={(checked) => patch({ v81ManualSigma: checked })} />)}{control("完整 Sigma 序列", <textarea value={String(segment.h3FullSigma || "")} onChange={(event) => patch({ h3FullSigma: event.target.value })} placeholder="留空自动；需总步数+1个值并以0结尾" />, true)}{choice("Sigma 预设", sigmaPresetNames, selectedSigmaPreset, (value) => { const name = String(value); patch({ h3FullSigma: sigmaPresets[name], v81ManualSigma: true }); ctx.updateMetadata({ h3SigmaPresetName: name }); }, undefined, true)}<div className="nfh3-preset-actions"><button type="button" onClick={() => saveSigmaPreset(selectedSigmaPreset)}>保存</button><button type="button" onClick={createSigmaPreset}>新建</button><button type="button" onClick={deleteSigmaPreset} disabled={!selectedSigmaPreset}>删除</button></div>{choice("放大模型", latentUpscaleModelChoices, segment.latentUpscaleModel || latentUpscaleModelChoices[0], (value) => patch({ latentUpscaleModel: String(value) }), undefined, true)}{choice("目标百万像素", megapixelChoices, segment.latentUpscaleMegapixels || 1, (value) => patch({ latentUpscaleMegapixels: Number(value) }), (value) => `${value} MP`)}{choice("潜空间对齐", [2, 4, 8, 16, 32], segment.latentUpscaleAlign || 2, (value) => patch({ latentUpscaleAlign: Number(value) }))}{choice("潜空间精度", ["fp16", "bf16"], segment.latentUpscalePrecision || "bf16", (value) => patch({ latentUpscalePrecision: String(value) }))}</div>)}
        {section("runtime", "显存与卸载", segment.uniBlockSwapEnabled ? "UniBlockSwap" : "默认", <div className="nfh3-control-grid">
            {control("运行时预留显存", <Switch checked={segment.runtimeReserveEnabled === true} onChange={(checked) => patch({ runtimeReserveEnabled: checked })} />)}
            {control("预留显存 GB", <InputNumber style={field} min={0} max={24} step={0.1} value={Number(segment.reservedVramGb ?? 0.6)} onChange={(value) => patch({ reservedVramGb: Number(value ?? 0.6) })} />)}
            {control("启用 UniBlockSwap", <Switch checked={segment.uniBlockSwapEnabled === true} onChange={(checked) => patch({ uniBlockSwapEnabled: checked })} />)}
            {control("常驻块数", <InputNumber style={field} min={1} max={49} value={Number(segment.uniBlockSwapBlocks ?? 1)} onChange={(value) => patch({ uniBlockSwapBlocks: Number(value ?? 1) })} />)}
        </div>)}
        {section("preview", "实时预览", segment.realtimePreviewEnabled === false ? "关闭" : "已启用", <div className="nfh3-control-grid">{control("启用实时预览", <Switch checked={segment.realtimePreviewEnabled !== false} onChange={(checked) => patch({ realtimePreviewEnabled: checked })} />)}{control("最长边", <InputNumber style={field} min={128} max={2048} value={Number(segment.realtimePreviewLongEdge ?? 512)} onChange={(value) => patch({ realtimePreviewLongEdge: Number(value ?? 512) })} />)}{control("预览帧数", <InputNumber style={field} min={1} max={48} value={Number(segment.realtimePreviewFrames ?? 12)} onChange={(value) => patch({ realtimePreviewFrames: Number(value ?? 12) })} />)}{control("预览帧率", <InputNumber style={field} min={1} max={24} value={Number(segment.realtimePreviewFps ?? 8)} onChange={(value) => patch({ realtimePreviewFps: Number(value ?? 8) })} />)}{control("JPEG 质量", <InputNumber style={field} min={30} max={100} value={Number(segment.realtimePreviewJpegQuality ?? 75)} onChange={(value) => patch({ realtimePreviewJpegQuality: Number(value ?? 75) })} />)}</div>)}
        {section("rtx", "RTX 视频超分", segment.rtxEnabled ? "已启用" : "关闭", <div className="nfh3-control-grid">{control("启用 RTX", <Switch checked={segment.rtxEnabled === true} onChange={(checked) => patch({ rtxEnabled: checked })} />)}{choice("缩放方式", resizeModes, segment.rtxResizeMode || "倍数缩放", (value) => patch({ rtxResizeMode: String(value) }))}{control("缩放倍数", <InputNumber style={field} min={1} max={4} step={0.01} value={Number(segment.rtxScale ?? 2)} onChange={(value) => patch({ rtxScale: Number(value ?? 2) })} />)}{control("目标宽度", <InputNumber style={field} min={32} value={Number(segment.rtxWidth ?? 1920)} onChange={(value) => patch({ rtxWidth: Number(value ?? 1920) })} />)}{control("目标高度", <InputNumber style={field} min={32} value={Number(segment.rtxHeight ?? 1080)} onChange={(value) => patch({ rtxHeight: Number(value ?? 1080) })} />)}{choice("质量", rtxQualityChoices, segment.rtxQuality || "ULTRA", (value) => patch({ rtxQuality: String(value) }))}</div>)}
        {section("lora", "LoRA", loraSummary ? `${loraSummary} 个已启用 · 南风顺序堆叠` : "未启用", <div className="nfh3-lora-stack">{loraSlots.map((slot, index) => <div className="nfh3-lora-row" key={index}><b>LoRA {index + 1}</b><Switch checked={slot.enabled} onChange={(checked) => patchLoraSlot(index, { enabled: checked })} /><H3Dropdown values={loraOptions.map((item) => item.value)} value={slot.name || undefined} onChange={(value) => patchLoraSlot(index, { name: String(value), enabled: !!value })} placeholder="选择 LoRA" allowClear /><InputNumber min={-2} max={2} step={0.05} value={slot.strength} onChange={(value) => patchLoraSlot(index, { strength: Number(value ?? 0.75) })} /></div>)}{loraSlots.length < 8 ? <button type="button" className="nfh3-lora-add" onClick={addLoraSlot}>＋ 添加 LoRA 槽位</button> : null}</div>)}
        {mode === "ref2va" ? section("audio", "数字人 · MV · 锁音频", segment.audioDrive ? "智能音频驱动" : segment.lockAudio ? "锁定音频" : "未启用", <div className="nfh3-audio-workspace">{control("开启锁音频", <Switch checked={segment.lockAudio === true} onChange={(checked) => patch({ lockAudio: checked })} />)}{control("开启音频驱动模式", <Switch checked={segment.audioDrive === true} onChange={(checked) => patch({ audioDrive: checked, lockAudio: checked ? true : segment.lockAudio })} />)}{segment.audioDrive ? <>{control("驱动文件", <input value={String(segment.audioDriveFile || "")} onChange={(event) => patch({ audioDriveFile: event.target.value })} placeholder="音频文件名或拖入" />, true)}{control("当前起点", <InputNumber style={field} min={0} step={0.001} value={segment.audioDriveStart ?? 0} onChange={(value) => patch({ audioDriveStart: Number(value ?? 0) })} />)}{control("当前终点", <InputNumber style={field} min={0} step={0.001} value={segment.audioDriveEnd ?? 0} onChange={(value) => patch({ audioDriveEnd: Number(value ?? 0) })} />)}{control("打点数据", <textarea value={String(segment.audioDriveMarkers || "")} onChange={(event) => patch({ audioDriveMarkers: event.target.value })} placeholder="JSON" />, true)}{control("分段图片", <textarea value={String(segment.audioDriveSegmentImages || "")} onChange={(event) => patch({ audioDriveSegmentImages: event.target.value })} placeholder="JSON" />, true)}{control("分段分镜", <textarea value={String(segment.audioDriveSegmentStoryboards || "")} onChange={(event) => patch({ audioDriveSegmentStoryboards: event.target.value })} placeholder="JSON" />, true)}{control("创意描述", <textarea value={String(segment.audioDriveCreative || "")} onChange={(event) => patch({ audioDriveCreative: event.target.value })} />, true)}{control("排除范围", <textarea value={String(segment.audioDriveExclude || "")} onChange={(event) => patch({ audioDriveExclude: event.target.value })} />, true)}</> : null}</div>) : null}
    </div>;
}
