import { resolveH3Runtime } from "@basketikun/canvas-agent/plugins/minimax-h3/runtime-params";
import { H3_VIDEO_MEGAPIXELS, H3_VIDEO_RATIOS, h3VideoDimensions } from "@basketikun/canvas-agent/plugins/minimax-h3/node-factory";
import { useDefaultParams } from "../services/h3-defaults";
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import type { CanvasNodeContext, CanvasVideoModelField, CanvasVideoModelSchema } from "@infinite-canvas/plugin-sdk";
import { Input, InputNumber, Select, Switch, Tooltip } from "antd";
import { useH3DropdownOpen } from "../hooks/useH3DropdownOpen";
import { H3_STYLE_TEMPLATES, styleTemplateFromPrompt } from "@basketikun/canvas-agent/plugins/minimax-h3/style-templates";
import { resolveAvailableH3StyleTemplates } from "../services/h3-style-templates";
import type { H3Segment } from "../types";
import { H3VideoOutputParams } from "./H3VideoOutputParams";
import { h3Label, useH3Locale } from "../h3-locale";

// 画布 H3 只保留「自选视频模型」一条链路：参数全部来自所选模型的工作流字段，
// 原生参数墙（模型/编码器/采样/SLA/二采/修脸/RTX/LoRA/显存/音频驱动）已随链路一起下线。
type Props = { ctx: CanvasNodeContext; metadata: Record<string, unknown>; segment?: H3Segment; patch: (value: Partial<H3Segment>) => void; onManageStyleTemplates?: () => void };
type SectionKey = "continuation";
const modeLabels = { t2v: "文生视频", i2v: "图生视频", fl2v: "首尾帧", ref2va: "多参考" } as const;
const NO_STYLE_TEMPLATE_OPTION = "__h3_no_style_template__";
const h3SelectValueStyle: CSSProperties = { display: "block", minWidth: 0, overflow: "hidden", color: "var(--h3-control-text, var(--h3-text))", fontSize: 14, fontWeight: 400, lineHeight: "30px", textOverflow: "ellipsis", whiteSpace: "nowrap" };
const h3SelectStyles = {
    item: h3SelectValueStyle,
    itemContent: h3SelectValueStyle,
    input: { fontSize: 14, lineHeight: "30px" },
    placeholder: { color: "var(--h3-muted)", fontSize: 14, lineHeight: "30px" },
};
const renderH3SelectLabel = ({ label, value }: { label?: ReactNode; value?: string | number }) => <span style={h3SelectValueStyle} title={typeof label === "string" ? label : String(value ?? "")}>{label ?? value}</span>;

function H3Dropdown({ values, value, onChange, placeholder, allowClear = false, format, searchable = false, disabled = false }: { values: Array<string | number>; value?: string | number; onChange: (value: string | number) => void; placeholder?: string; allowClear?: boolean; format?: (value: string | number) => string; searchable?: boolean; disabled?: boolean }) {
    const selected = value === undefined || value === null ? undefined : String(value);
    const options = values.map((item) => ({ value: String(item), label: format ? format(item) : String(item) }));
    const dropdown = useH3DropdownOpen();
    return <span ref={dropdown.rootRef} style={{ display: "block", minWidth: 0 }}><Select className="nfh3-select" size="middle" showSearch={searchable} allowClear={allowClear} disabled={disabled} value={selected} placeholder={placeholder} optionFilterProp="label" options={options} labelRender={renderH3SelectLabel} styles={h3SelectStyles} open={dropdown.open} onOpenChange={dropdown.onOpenChange} onChange={(v) => { onChange(v as string); }} onMouseDown={(event) => event.stopPropagation()} style={{ width: "100%" }} popupMatchSelectWidth={false} /></span>;
}

export function ClipSettings({ ctx, metadata, segment: inputSegment, patch: savePatch, onManageStyleTemplates }: Props) {
    const raw = (Array.isArray(metadata.segments) ? metadata.segments as Array<Record<string, unknown>> : []).find(item => item.id === inputSegment?.id) || inputSegment || {};
    const defaults = useDefaultParams();
    const styleTemplates = resolveAvailableH3StyleTemplates(defaults);
    const resolved = resolveH3Runtime(raw as Record<string, unknown>, {}, metadata, defaults);
    const segment = inputSegment ? { ...inputSegment, ...resolved.params, videoSteps: resolved.params.steps } as H3Segment : undefined;
    // 制作台绑定的正式 Clip：时长由制作稿 Shot 时长求和派生，不是可编辑配置（canvas-contracts.md:96）。
    // 画布侧禁止手改 duration，避免与源稿分叉；普通手工 Clip 不受限制。
    const projection = (segment?.productionClipProjection || raw.productionClipProjection) as Record<string, unknown> | undefined;
    const durationLocked = typeof projection?.targetId === "string" && Boolean(projection.targetId);
    const selectedVideoReferenceCount = selectedVideoWorkflowReferenceCount(segment);
    const patch = savePatch;
    const [selectedVideoModelSchema, setSelectedVideoModelSchema] = useState<CanvasVideoModelSchema | null>(null);
    const [selectedVideoModelLoading, setSelectedVideoModelLoading] = useState(false);
    const [selectedVideoModelError, setSelectedVideoModelError] = useState("");
    const locale = useH3Locale();
    useEffect(() => {
        const model = String(segment?.selectedVideoModel || "").trim();
        if (segment?.selectedVideoModelEnabled !== true || !model) {
            setSelectedVideoModelSchema(null);
            setSelectedVideoModelError("");
            setSelectedVideoModelLoading(false);
            return;
        }
        let active = true;
        setSelectedVideoModelSchema(null);
        setSelectedVideoModelError("");
        setSelectedVideoModelLoading(true);
        void ctx.ai.describeVideoModel(model, selectedVideoReferenceCount)
            .then((schema) => { if (active) setSelectedVideoModelSchema(schema); })
            .catch((error) => { if (active) setSelectedVideoModelError(error instanceof Error ? error.message : String(error)); })
            .finally(() => { if (active) setSelectedVideoModelLoading(false); });
        return () => { active = false; };
    }, [ctx.ai, segment?.id, segment?.selectedVideoModelEnabled, segment?.selectedVideoModel, selectedVideoReferenceCount]);
    if (!segment) return null;
    const mode = (segment.taskMode || segment.mode || "ref2va") as keyof typeof modeLabels;
    const styleTemplateId = segment.styleTemplateId === undefined
        ? styleTemplateFromPrompt(String(segment.prompt || ""), mode, defaults.styleTemplates)
        : segment.styleTemplateId;
    const styleTemplateOptions = [
        NO_STYLE_TEMPLATE_OPTION,
        ...styleTemplates.map((template) => template.id),
        ...(styleTemplateId && !styleTemplates.some((template) => template.id === styleTemplateId) ? [String(styleTemplateId)] : []),
    ];
    const styleTemplateValue = styleTemplateId == null ? NO_STYLE_TEMPLATE_OPTION : String(styleTemplateId);
    const styleTemplateLabel = (value: string | number) => value === NO_STYLE_TEMPLATE_OPTION
        ? "不加模板"
        : styleTemplates.find((template) => template.id === value)?.label || H3_STYLE_TEMPLATES.find((template) => template.id === value)?.label || String(value);
    const selectStyleTemplate = (value: string | number) => patch({ styleTemplateId: value === NO_STYLE_TEMPLATE_OPTION ? null : String(value) });
    const expanded = (metadata.nanFengExpandedSections as Record<string, boolean> | undefined) || {};
    const setOpen = (key: SectionKey) => ctx.updateMetadata({ nanFengExpandedSections: { ...expanded, [key]: expanded[key] !== true } });
    const field = { width: "100%" } as const;
    const hintMark = (hint: string) => <Tooltip title={hint}><span className="nfh3-hint-mark" aria-label={hint} role="img">?</span></Tooltip>;
    const control = (label: string, value: ReactNode, wide = false, hint?: string) => <label key={`nfh3-ctl-${label}`} className={`nfh3-control${wide ? " wide" : ""}`} data-control={label}><span>{label}{hint ? hintMark(hint) : null}</span>{value}</label>;
    const selectedModelSchemaKey = selectedVideoModelSchema?.kind === "direct"
        ? `direct:${String(segment.selectedVideoModel || "")}`
        : selectedVideoModelSchema?.workflow ? `${String(segment.selectedVideoModel || "")}::${selectedVideoModelSchema.workflow}` : "";
    const allSelectedModelValues = segment.selectedVideoModelFieldValues || {};
    const selectedModelValues = selectedModelSchemaKey ? allSelectedModelValues[selectedModelSchemaKey] || {} : {};
    const selectedModelFields = (selectedVideoModelSchema?.fields || []).filter((item) =>
        !item.isPrompt && item.id.toLowerCase() !== "prompt" && !["image", "video", "audio"].includes(item.type));
    const defaultSelectedModelFieldValue = (item: CanvasVideoModelField) => {
        if (Object.prototype.hasOwnProperty.call(selectedModelValues, item.id)) return selectedModelValues[item.id];
        if (["duration", "seconds"].includes(item.id)) return segment.duration ?? selectedVideoModelSchema?.defaultValues?.[item.id] ?? item.default;
        if (["mode", "taskMode"].includes(item.id)) return segment.taskMode || segment.mode || item.default;
        return selectedVideoModelSchema?.defaultValues?.[item.id] ?? item.default;
    };
    const patchSelectedModelField = (item: CanvasVideoModelField, value: unknown) => {
        const next = { ...selectedModelValues, [item.id]: value };
        patch({
            selectedVideoModelFieldValues: { ...allSelectedModelValues, [selectedModelSchemaKey]: next },
            ...(!durationLocked && ["duration", "seconds"].includes(item.id) && Number.isFinite(Number(value)) ? { duration: Number(value) } : {}),
        });
    };
    const renderSelectedModelField = (item: CanvasVideoModelField) => {
        const value = defaultSelectedModelFieldValue(item);
        const label = `${item.name || item.id}${item.required ? " *" : ""}`;
        const durationFieldLocked = durationLocked && ["duration", "seconds"].includes(item.id);
        if (item.type === "boolean") return control(label, <Switch disabled={durationFieldLocked} checked={value === true || String(value).toLowerCase() === "true"} onChange={(next) => patchSelectedModelField(item, next)} />);
        if (item.type === "number" || item.type === "slider") return control(label, <InputNumber disabled={durationFieldLocked} style={field} min={item.min} max={item.max} step={item.step || (item.type === "slider" ? 0.01 : 1)} value={value !== undefined && value !== null && value !== "" && Number.isFinite(Number(value)) ? Number(value) : undefined} onChange={(next) => patchSelectedModelField(item, next ?? "")} />);
        if (item.type === "dropdown" && item.options?.length) return control(label, <H3Dropdown values={item.options} value={value === undefined || value === null ? undefined : String(value)} onChange={(next) => patchSelectedModelField(item, String(next))} allowClear placeholder={label} searchable disabled={durationFieldLocked} />);
        return control(label, <Input disabled={durationFieldLocked} value={value === undefined || value === null ? "" : String(value)} placeholder={item.default === undefined ? label : String(item.default)} onChange={(event) => patchSelectedModelField(item, event.target.value)} />);
    };
    // 标准视频参数（清晰度/尺寸/秒数）固定呈现：有宽/高/秒工作流字段就写字段，
    // 没有就退回节点级 aspectRatio/megapixels/duration（H3 真正的出片参数），不让控件变成摆设。
    const presetIds = selectedVideoModelSchema?.presetFieldIds;
    const widthField = presetIds?.width ? selectedModelFields.find((item) => item.id === presetIds.width) : undefined;
    const heightField = presetIds?.height ? selectedModelFields.find((item) => item.id === presetIds.height) : undefined;
    const secondsField = presetIds?.seconds ? selectedModelFields.find((item) => item.id === presetIds.seconds) : undefined;
    // 已被标准控件接管的字段不再平铺，避免两个入口改同一个值。
    const advancedModelFields = selectedModelFields.filter((item) => item.id !== widthField?.id && item.id !== heightField?.id && item.id !== secondsField?.id);
    // 一次写入多个字段，避免连续 patchSelectedModelField 时后者读到旧闭包覆盖前者。
    const patchPresetFields = (updates: Record<string, unknown>) => {
        const next = { ...selectedModelValues, ...updates };
        patch({ selectedVideoModelFieldValues: { ...allSelectedModelValues, [selectedModelSchemaKey]: next } });
    };
    const numFieldValue = (item?: CanvasVideoModelField) => {
        if (!item) return undefined;
        const value = defaultSelectedModelFieldValue(item);
        return value !== undefined && value !== null && value !== "" && Number.isFinite(Number(value)) ? Number(value) : undefined;
    };
    // 无预设字段时，从节点级 aspectRatio + megapixels 还原像素尺寸，给标准尺寸控件一个真实当前值。
    const nodeAspect = String(segment.aspectRatio || "16:9 (Widescreen)");
    const nodeMegapixels = Number(segment.megapixels) > 0 ? Number(segment.megapixels) : 0.8;
    const nodeSize = h3VideoDimensions(nodeAspect, nodeMegapixels);
    const presetWidth = numFieldValue(widthField) ?? nodeSize.width;
    const presetHeight = numFieldValue(heightField) ?? nodeSize.height;
    const writePresetSize = (width: number, height: number) => {
        const w = Math.max(1, Math.round(width));
        const h = Math.max(1, Math.round(height));
        const fieldUpdates: Record<string, unknown> = {};
        if (widthField) fieldUpdates[widthField.id] = w;
        if (heightField) fieldUpdates[heightField.id] = h;
        if (Object.keys(fieldUpdates).length) {
            patchPresetFields(fieldUpdates);
            return;
        }
        // 没有宽/高工作流字段（如武戏只声明画面比例）：写节点级出片参数。
        // 宽高先折成最接近的 H3 画幅档与百万像素档，和原生 H3 的取值空间一致。
        const ratio = w / h;
        const hit = Object.keys(H3_VIDEO_RATIOS).reduce((best, name) => {
            const error = (key: string) => Math.abs(Math.log(ratio / (H3_VIDEO_RATIOS[key][0] / H3_VIDEO_RATIOS[key][1])));
            return error(name) < error(best) ? name : best;
        }, "16:9 (Widescreen)");
        const targetMp = w * h / 1_000_000;
        const megapixels = H3_VIDEO_MEGAPIXELS.reduce((best, value) => Math.abs(value - targetMp) < Math.abs(best - targetMp) ? value : best, 0.8);
        patch({ aspectRatio: hit, megapixels });
    };
    // 秒数：标准 seconds 经引擎 durationTarget 注入帧；H3 段的权威时长是 segment.duration。
    // 帧数字段是派生落点（引擎会从 seconds 重算并摘掉它），不写入，避免把秒数误当帧数存进去。
    const presetSeconds = segment.duration != null && Number(segment.duration) > 0 ? Number(segment.duration) : (numFieldValue(secondsField) ?? 6);
    const writePresetSeconds = (seconds: number) => { if (!durationLocked) patch({ duration: seconds }); };
    // 标准控件无条件渲染。模型没声明标准角色时，宽度/秒数落在节点级出片参数上，不是摆设。
    // 制作台绑定的正式 Clip 时长由源稿派生，隐藏秒数入口，避免与源稿分叉。
    const standardPresetsPanel = <H3VideoOutputParams
        width={presetWidth}
        height={presetHeight}
        seconds={presetSeconds}
        secondsMax={15}
        showSize
        showSeconds={!durationLocked}
        onSize={(width, height) => writePresetSize(width, height)}
        onSeconds={(seconds) => writePresetSeconds(seconds)}
    />;
    const selectedVideoModelPanel = <section className="nfh3-section nfh3-selected-model-parameters" data-section="selected-model-parameters">
        <div className="nfh3-section-head"><b>{h3Label(locale, "selectedVideoModelParameters")}</b><small>{String(segment.selectedVideoModel || "")}</small></div>
        <div className="nfh3-section-body">
            {selectedVideoModelLoading ? <div className="nfh3-hint">{h3Label(locale, "selectedVideoModelLoading")}</div> : null}
            {selectedVideoModelError ? <div className="nfh3-hint" role="alert">{selectedVideoModelError}</div> : null}
            {selectedVideoModelSchema?.error ? <div className="nfh3-hint" role="alert">{h3Label(locale, "selectedVideoModelModeWarning")} {selectedVideoModelSchema.error}</div> : null}
            <div className="nfh3-control-grid">
                {control("视觉风格模板", <H3Dropdown values={styleTemplateOptions} value={styleTemplateValue} onChange={selectStyleTemplate} format={styleTemplateLabel} placeholder="选择模板" searchable />, true)}
            </div>
            {!selectedVideoModelLoading && !selectedVideoModelError && selectedVideoModelSchema && !selectedModelFields.length ? <div className="nfh3-hint">{h3Label(locale, "selectedVideoModelNoFields")}</div> : null}
            {standardPresetsPanel}
            {advancedModelFields.length ? <div className="nfh3-control-grid">{advancedModelFields.map((item) => <div key={item.id} className="nfh3-dynamic-model-field">{renderSelectedModelField(item)}</div>)}</div> : null}
        </div>
    </section>;
    const section = (key: SectionKey, title: string, summary: ReactNode, content: ReactNode) => <section key={`nfh3-sec-${key}`} className="nfh3-section" data-section={key}><button type="button" className="nfh3-section-head" onClick={() => setOpen(key)}><span className={`nfh3-chevron${expanded[key] === true ? " is-open" : ""}`} aria-hidden="true" /><b>{title}</b><small>{summary}</small></button>{expanded[key] === true ? <div className="nfh3-section-body">{content}</div> : null}</section>;
    const enabledSummary = (text: string) => <span className="nfh3-enabled-summary">{text}</span>;
    // 续段衔接与视频参数分开：衔接开关不是画幅参数，混排会让人误以为它们是画质选项。
    const continuationSection = section("continuation", "续段衔接", segment.tailFrameContinuation ? enabledSummary("尾帧参考") : segment.videoContinuation ? enabledSummary("视频续写") : "均关闭", <div className="nfh3-control-grid">
        {control("尾帧参考（传给下一段）", <Switch checked={segment.tailFrameContinuation === true} onChange={(checked) => patch({ tailFrameContinuation: checked, ...(checked ? { motionContextEnabled: false, videoContinuation: false } : {}) })} />, false, "新建边界默认开启。目标 Clip 有明确首帧分镜图时关闭；否则下一段运行时截取本段尾帧并追加到图片参考末尾，作为下一段状态基准。")}
        {control("视频续写到下一段（像素/音频引导）", <Switch checked={segment.videoContinuation === true} onChange={(checked) => patch({ videoContinuation: checked, ...(checked ? { tailFrameContinuation: false, motionContextEnabled: false } : {}) })} />, false, "使用上一段成片的像素帧与音频做引导（原无限流原生续段分支），与原流程完全一致的接缝。与尾帧参考、Motion Context 互斥；下一段运行时必须有上一段成片。")}
    </div>);
    return <div className="nfh3-settings">
        {resolved.parameterIssues.length ? <div className="nfh3-hint" role="alert">{resolved.parameterIssues.join("；")}</div> : null}
        <div className="nfh3-mode-grid">{(Object.keys(modeLabels) as Array<keyof typeof modeLabels>).map((key) => <button key={key} type="button" data-mode={key} className={mode === key ? "active" : ""} onClick={() => patch({ mode: key, taskMode: key })}><b>{modeLabels[key]}</b></button>)}</div>
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: -6 }}><button type="button" className="nfh3-inline-button" onClick={onManageStyleTemplates}>管理视觉风格模板</button></div>
        {selectedVideoModelPanel}
        {continuationSection}
    </div>;
}

function selectedVideoWorkflowReferenceCount(segment?: H3Segment) {
    const mode = String(segment?.taskMode || segment?.mode || "ref2va").toLowerCase();
    if (mode === "t2v" || mode === "t2va") return 0;
    if (mode === "i2v" || mode === "i2va") return 1;
    if (mode === "fl2v" || mode === "fl2va") return 2;
    const bindings = Array.isArray(segment?.referenceBindings) ? segment.referenceBindings.filter((item) => item.enabled !== false).length : 0;
    const items = Array.isArray(segment?.refItems) ? segment.refItems.filter((item) => item.enabled !== false).length : 0;
    return Math.max(1, bindings, items);
}
