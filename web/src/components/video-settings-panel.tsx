import { type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Radio } from "antd";

import i18n from "@/i18n";
import { ImageSettingsTheme, SettingsSection, SettingsDisclosure } from "@/components/image-settings-panel";
import { type CanvasTheme } from "@/lib/canvas-theme";
import { type AiConfig } from "@/stores/use-config-store";
import { WorkflowCustomFields } from "@/components/workflow-custom-fields";
import { type WorkflowField } from "@/services/api/workflows";
import { h3VideoSettingChanges, isLocalH3VideoModel, resolveH3VideoSettings } from "@/lib/h3-video-settings";
import { normalizeVideoSizeValue } from "@/lib/video-size";
import type { PresetFieldIds } from "@/lib/model-standard-params";
export { normalizeVideoSizeValue } from "@/lib/video-size";

const resolutionOptions = [
    { value: "1080", label: "1080p" },
    { value: "720", label: "720p" },
    { value: "480", label: "480p" },
];

const sizeOptions = [
    { value: "1280x720", labelKey: "landscape", width: 1280, height: 720 },
    { value: "720x1280", labelKey: "portrait", width: 720, height: 1280 },
    { value: "1024x1024", labelKey: "square", width: 1024, height: 1024 },
    { value: "1792x1024", labelKey: "widescreen", width: 1792, height: 1024 },
    { value: "1024x1792", labelKey: "tall", width: 1024, height: 1792 },
    { value: "auto", labelKey: "auto", width: 0, height: 0 },
];

const secondOptions = [6, 10, 12, 16, 20];

export const videoResolutionOptions = resolutionOptions.map((item) => ({ value: item.value, label: item.label }));
export const videoSizeOptions = sizeOptions.map((item) => ({
    value: item.value,
    get label() {
        return i18n.t(`settingsPanels.video.sizes.${item.labelKey}`);
    },
}));
export const videoSecondOptions = secondOptions.map((value) => String(value));

type VideoSettingsPanelProps = {
    config: AiConfig;
    onConfigChange: (key: "vquality" | "size" | "videoSeconds" | "videoGenerateAudio" | "videoWatermark", value: string) => void;
    theme: CanvasTheme;
    showTitle?: boolean;
    className?: string;
    /**
     * 选中内部实现模型时传入：本次可填写的工作流自定义字段与它们的值。
     * 有字段就渲染这些字段并隐藏通用项，语义与生图工作台一致。
     */
    customFields?: WorkflowField[];
    customFieldValues?: Record<string, unknown>;
    onCustomFieldChange?: (id: string, value: unknown) => void;
    /** 选中了内部实现但没解析出字段时的说明；null 表示无需提示。 */
    implementationMissing?: string | null;
    /**
     * 引擎模型上报的标准角色对应的字段 id（width/height/seconds）。
     * 有值时把这几个字段渲染成预设（尺寸卡片/秒数档 + 精确尺寸折叠），
     * 其余字段仍走 WorkflowCustomFields 平铺，做到「预设 + 高级参数」分层。
     */
    presetFieldIds?: PresetFieldIds;
    showRunTarget?: boolean;
    runTarget?: "local" | "cloud" | "hybrid";
    onRunTargetChange?: (value: "local" | "cloud" | "hybrid") => void;
};

export function VideoSettingsPanel({
    config,
    onConfigChange,
    theme,
    showTitle = true,
    className = "w-[320px] max-w-full space-y-4 rounded-2xl px-1 py-0.5",
    customFields,
    customFieldValues,
    onCustomFieldChange,
    implementationMissing,
    presetFieldIds,
    showRunTarget = false,
    runTarget = "local",
    onRunTargetChange,
}: VideoSettingsPanelProps) {
    const { t } = useTranslation();
    // 隐藏通用项的唯一依据是「本次真的要渲染内部实现字段」；取不到字段时仍显示通用项，
    // 否则面板会只剩一个空壳。与生图工作台的判定口径一致。
    const showsImplementationFields = Boolean(customFields && customFields.length);
    const seconds = config.videoSeconds ?? "6";
    const size = normalizeVideoSizeValue(config.size);
    const dimensions = readSizeDimensions(size);
    const h3 = isLocalH3VideoModel(config);
    const resolution = config.vquality === "" ? "" : h3 && size !== "auto" ? String(Math.min(dimensions.width, dimensions.height)) : normalizeVideoResolutionValue(config.vquality);
    const change = (key: Parameters<typeof onConfigChange>[0], value: string) => {
        if (!h3 || !["size", "vquality", "videoSeconds"].includes(key)) {
            onConfigChange(key, value);
            return;
        }
        for (const [field, next] of Object.entries(h3VideoSettingChanges(config, key, value))) onConfigChange(field as "size" | "vquality" | "videoSeconds", next);
    };
    let h3Preview: ReturnType<typeof resolveH3VideoSettings> | undefined;
    if (h3 && size !== "auto") {
        try {
            h3Preview = resolveH3VideoSettings(config);
        } catch {
            /* Invalid duration remains editable. */
        }
    }
    const updateDimension = (key: "width" | "height", value: number | null) => {
        const next = Math.max(1, Math.floor(value || dimensions[key] || 720));
        change("size", `${key === "width" ? next : dimensions.width}x${key === "height" ? next : dimensions.height}`);
    };

    // ---- 引擎模型：标准角色 → 预设区 + 高级参数折叠 ----
    const presetWidthId = presetFieldIds?.width;
    const presetHeightId = presetFieldIds?.height;
    const hasSizePreset = Boolean(presetWidthId && presetHeightId);
    const hasSecondPreset = Boolean(presetFieldIds?.seconds);
    const usePresetLayout = showsImplementationFields && (hasSizePreset || hasSecondPreset);
    const fieldSize = hasSizePreset
        ? (() => {
            const width = Number(customFieldValues?.[presetWidthId!]);
            const height = Number(customFieldValues?.[presetHeightId!]);
            return width > 0 && height > 0 ? `${Math.round(width)}x${Math.round(height)}` : normalizeVideoSizeValue(config.size);
        })()
        : size;
    const fieldDimensions = readSizeDimensions(fieldSize);
    const advancedFields = usePresetLayout
        ? (customFields || []).filter((field) => field.id !== presetWidthId && field.id !== presetHeightId && field.id !== presetFieldIds?.seconds)
        : (customFields || []);
    // 尺寸预设写字段 id（fields 会覆盖标准 size），秒数走标准 seconds 参数。
    const writePresetSize = (width: number, height: number) => {
        const w = Math.max(1, Math.floor(width));
        const h = Math.max(1, Math.floor(height));
        if (presetWidthId) onCustomFieldChange?.(presetWidthId, w);
        if (presetHeightId) onCustomFieldChange?.(presetHeightId, h);
        onConfigChange("size", `${w}x${h}`);
    };
    const writePresetQuality = (value: string) => {
        const quality = Number(value.replace(/p$/i, ""));
        if (!Number.isFinite(quality) || quality < 1) return;
        const base = fieldDimensions.width && fieldDimensions.height
            ? fieldDimensions
            : { width: 1280, height: 720 };
        const scale = quality / Math.min(base.width, base.height);
        writePresetSize(base.width * scale, base.height * scale);
    };
    const writePresetSeconds = (value: string) => change("videoSeconds", value);
    const writePresetOptionSize = (value: string) => {
        if (value === "auto") return;
        const next = readSizeDimensions(value);
        if (next.width && next.height) writePresetSize(next.width, next.height);
    };
    // 预设区统一取值/写入：通用模型走 config，引擎模型走字段 + 标准 seconds。
    const viewResolution = usePresetLayout
        ? (fieldDimensions.width || fieldDimensions.height ? String(Math.min(fieldDimensions.width, fieldDimensions.height)) : normalizeVideoResolutionValue(config.vquality))
        : resolution;
    const viewSize = usePresetLayout ? fieldSize : size;
    const viewSeconds = seconds;
    const viewDimensions = usePresetLayout ? fieldDimensions : dimensions;
    const onQuality = usePresetLayout ? writePresetQuality : (value: string) => change("vquality", value);
    const onSize = usePresetLayout ? writePresetOptionSize : (value: string) => change("size", value);
    const onSeconds = usePresetLayout ? writePresetSeconds : (value: string) => change("videoSeconds", value);
    const onDimension = usePresetLayout
        ? (key: "width" | "height", value: number | null) => {
            const next = Math.max(1, Math.floor(value || viewDimensions[key] || 720));
            writePresetSize(key === "width" ? next : viewDimensions.width, key === "height" ? next : viewDimensions.height);
        }
        : updateDimension;
    const visibleSizeOptions = usePresetLayout ? sizeOptions.filter((item) => item.value !== "auto") : sizeOptions;

    return (
        <ImageSettingsTheme theme={theme}>
            <div className={className} style={{ color: theme.node.text }} onMouseDown={(event) => event.stopPropagation()}>
                {showTitle ? <div className="text-lg font-semibold">{t("settingsPanels.video.title")}</div> : null}
                {showsImplementationFields && !usePresetLayout ? (
                    <SettingsSection title={t("settingsPanels.video.workflowFields")} theme={theme}>
                        <WorkflowCustomFields fields={customFields || []} values={customFieldValues || {}} onChange={(id, value) => onCustomFieldChange?.(id, value)} />
                    </SettingsSection>
                ) : null}
                {showRunTarget ? (
                    <SettingsSection title={t("settingsPanels.video.runTarget")} theme={theme}>
                        <Radio.Group
                            size="small"
                            optionType="button"
                            value={runTarget}
                            onChange={(event) => onRunTargetChange?.(event.target.value)}
                            options={[
                                { label: t("settingsPanels.video.runTargetLocal"), value: "local" },
                                { label: t("settingsPanels.video.runTargetCloud"), value: "cloud" },
                                { label: t("settingsPanels.video.runTargetHybrid"), value: "hybrid" },
                            ]}
                        />
                        <div className="mt-2 text-xs leading-relaxed" style={{ color: theme.node.muted }}>
                            {t(runTarget === "hybrid" ? "microTools.workflow.runTargetHintHybrid" : runTarget === "cloud" ? "microTools.workflow.runTargetHintCloud" : "microTools.workflow.runTargetHintLocal")}
                        </div>
                    </SettingsSection>
                ) : null}
                {implementationMissing ? (
                    <div className="text-xs leading-relaxed" style={{ color: theme.node.muted }}>
                        {implementationMissing}
                    </div>
                ) : null}
                {!showsImplementationFields || usePresetLayout ? (
                    <SettingsSection title={t("settingsPanels.groups.videoOutput")} theme={theme}>
                        <SettingGroup title={t("settingsPanels.video.quality")} color={theme.node.muted}>
                            <div className="grid grid-cols-3 gap-2.5">
                                {resolutionOptions.map((item) => (
                                    <OptionPill key={item.value} selected={viewResolution === item.value} theme={theme} onClick={() => onQuality(item.value)}>
                                        {item.label}
                                    </OptionPill>
                                ))}
                                <ResolutionInput value={viewResolution} theme={theme} onChange={onQuality} />
                            </div>
                        </SettingGroup>
                        <SettingGroup title={t("settingsPanels.video.size")} color={theme.node.muted}>
                            <div className="grid grid-cols-3 gap-2.5">
                                {visibleSizeOptions.map((item) => (
                                    <button
                                        key={item.value}
                                        type="button"
                                        aria-pressed={viewSize === item.value}
                                        className="flex h-[78px] min-w-0 cursor-pointer flex-col items-center justify-center gap-1 rounded-xl border bg-transparent text-sm transition hover:opacity-80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                                        style={{ borderColor: viewSize === item.value ? theme.node.text : theme.node.stroke, color: theme.node.text }}
                                        onMouseDown={(event) => event.stopPropagation()}
                                        onClick={() => onSize(item.value)}
                                    >
                                        <SizePreview width={item.width} height={item.height} color={theme.node.text} />
                                        <span>{t(`settingsPanels.video.sizes.${item.labelKey}`)}</span>
                                    </button>
                                ))}
                            </div>
                        </SettingGroup>
                        <SettingGroup title={t("settingsPanels.video.seconds")} color={theme.node.muted}>
                            <div className="grid grid-cols-3 gap-2.5">
                                {(h3 ? [6, 10, 12, 15] : secondOptions).map((value) => (
                                    <OptionPill key={value} selected={viewSeconds === String(value)} theme={theme} onClick={() => onSeconds(String(value))}>
                                        {value}s
                                    </OptionPill>
                                ))}
                                <NumberInput value={viewSeconds} min={1} max={h3 ? 15 : 20} theme={theme} onChange={onSeconds} />
                            </div>
                        </SettingGroup>
                        {h3 ? (
                            <div className="text-xs leading-relaxed" style={{ color: theme.node.muted }}>
                                {h3Preview ? t("h3Video.preview", { size: h3Preview.parameters.size, seconds: h3Preview.parameters.seconds, megapixels: h3Preview.fields.megapixels }) : t(size === "auto" ? "h3Video.autoPreview" : "h3Video.durationError")}
                            </div>
                        ) : null}
                        <SettingsDisclosure title={t("settingsPanels.groups.preciseSize")} summary={viewSize} theme={theme}>
                            <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2.5">
                                <DimensionInput prefix="W" value={viewDimensions.width} disabled={viewSize === "auto"} theme={theme} onChange={(value) => onDimension("width", value)} />
                                <span className="text-lg opacity-45">↔</span>
                                <DimensionInput prefix="H" value={viewDimensions.height} disabled={viewSize === "auto"} theme={theme} onChange={(value) => onDimension("height", value)} />
                            </div>
                        </SettingsDisclosure>
                    </SettingsSection>
                ) : null}
                {usePresetLayout && advancedFields.length ? (
                    <SettingsSection title={t("settingsPanels.video.workflowFields")} theme={theme}>
                        <WorkflowCustomFields fields={advancedFields} values={customFieldValues || {}} onChange={(id, value) => onCustomFieldChange?.(id, value)} />
                    </SettingsSection>
                ) : null}
            </div>
        </ImageSettingsTheme>
    );
}

export function videoResolutionLabel(value: string) {
    return `${normalizeVideoResolutionValue(value)}p`;
}

export function videoSizeLabel(value: string) {
    if (value === "adaptive" || value === "auto") return i18n.t("settingsPanels.video.adaptive");
    const size = normalizeVideoSizeValue(value);
    const option = sizeOptions.find((item) => item.value === size);
    return option ? i18n.t(`settingsPanels.video.sizes.${option.labelKey}`) : size;
}

export function videoSecondsLabel(value: string) {
    if (String(value).trim() === "-1") return i18n.t("settingsPanels.video.smart");
    return `${value || "6"}s`;
}

export function normalizeVideoResolutionValue(value: string) {
    if (value === "480p" || value === "low") return "480";
    if (value === "720p" || value === "auto" || value === "high" || value === "medium") return "720";
    return value.replace(/p$/i, "") || "720";
}

function OptionPill({ selected, disabled = false, theme, onClick, children }: { selected: boolean; disabled?: boolean; theme: CanvasTheme; onClick: () => void; children: ReactNode }) {
    return (
        <button
            type="button"
            aria-pressed={selected}
            disabled={disabled}
            className="min-h-9 min-w-0 cursor-pointer rounded-full border px-2 text-sm transition hover:opacity-80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-35"
            style={{ background: "transparent", borderColor: selected ? theme.node.text : theme.node.stroke, color: theme.node.text }}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={onClick}
        >
            {children}
        </button>
    );
}

function SettingGroup({ title, color, children }: { title: string; color: string; children: ReactNode }) {
    return (
        <fieldset className="min-w-0 space-y-2.5 border-0 p-0">
            <legend className="mb-2 text-xs font-medium" style={{ color }}>
                {title}
            </legend>
            {children}
        </fieldset>
    );
}

function ResolutionInput({ value, theme, onChange }: { value: string; theme: CanvasTheme; onChange: (value: string) => void }) {
    const { t } = useTranslation();
    return (
        <label className="flex h-9 overflow-hidden rounded-full border text-sm focus-within:ring-2 focus-within:ring-ring" style={{ borderColor: theme.node.stroke, color: theme.node.text }}>
            <input
                aria-label={t("settingsPanels.video.quality")}
                type="number"
                min={1}
                className="min-w-0 flex-1 bg-transparent px-3 text-center outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                value={value}
                onChange={(event) => onChange(event.target.value)}
                onMouseDown={(event) => event.stopPropagation()}
            />
            <span className="grid w-7 place-items-center pr-1" style={{ color: theme.node.muted }}>
                p
            </span>
        </label>
    );
}

function DimensionInput({ prefix, value, disabled, theme, onChange }: { prefix: string; value: number; disabled: boolean; theme: CanvasTheme; onChange: (value: number | null) => void }) {
    return (
        <label className="flex h-9 overflow-hidden rounded-xl text-sm focus-within:ring-2 focus-within:ring-ring" style={{ background: theme.node.fill, color: theme.node.text, opacity: disabled ? 0.55 : 1 }}>
            <span className="grid w-9 place-items-center" style={{ color: theme.node.muted }}>
                {prefix}
            </span>
            <input
                type="number"
                min={1}
                disabled={disabled}
                className="min-w-0 flex-1 bg-transparent px-2 outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                value={value || ""}
                onChange={(event) => onChange(Number(event.target.value) || null)}
                onMouseDown={(event) => event.stopPropagation()}
            />
        </label>
    );
}

function NumberInput({ value, min, max, theme, onChange }: { value: string; min: number; max: number; theme: CanvasTheme; onChange: (value: string) => void }) {
    const { t } = useTranslation();
    return (
        <input
            aria-label={t("settingsPanels.video.seconds")}
            type="number"
            min={min}
            max={max}
            className="h-9 min-w-0 w-full rounded-full border bg-transparent px-3 text-center text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
            style={{ borderColor: theme.node.stroke, color: theme.node.text, WebkitTextFillColor: theme.node.text }}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            onMouseDown={(event) => event.stopPropagation()}
        />
    );
}

function SizePreview({ width, height, color }: { width: number; height: number; color: string }) {
    if (!width || !height) return null;
    const longSide = Math.max(width, height);
    const previewWidth = Math.max(10, Math.round((width / longSide) * 26));
    const previewHeight = Math.max(10, Math.round((height / longSide) * 26));
    return <span className="rounded-[3px] border-2" style={{ width: previewWidth, height: previewHeight, borderColor: color }} />;
}

function readSizeDimensions(size: string) {
    if (size === "auto") return { width: 0, height: 0 };
    const match = size.match(/^(\d+)x(\d+)$/);
    return { width: Number(match?.[1]) || 1280, height: Number(match?.[2]) || 720 };
}
