import { type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { ImageSettingsTheme, SettingTitle } from "@/components/image-settings-panel";
import { audioFormatOptions, audioSpeedLabel, audioVoiceOptions, normalizeAudioFormatValue, normalizeAudioSpeedValue, normalizeAudioVoiceValue } from "@/lib/audio-generation";
import { WorkflowCustomFields } from "@/components/workflow-custom-fields";
import { type CanvasTheme } from "@/lib/canvas-theme";
import type { AiConfig } from "@/stores/use-config-store";
import type { WorkflowField } from "@/services/api/workflows";

const speedOptions = ["0.75", "1", "1.25", "1.5"];

type AudioSettingKey = "audioVoice" | "audioFormat" | "audioSpeed" | "audioInstructions";

type AudioSettingsPanelProps = {
    config: AiConfig;
    onConfigChange: (key: AudioSettingKey, value: string) => void;
    theme: CanvasTheme;
    showTitle?: boolean;
    className?: string;
    // 选中本地 ComfyUI 工作流时，把工作流的非 audio / 非 prompt 自定义字段渲染到面板顶部；
    // comfyParams 存在 node.metadata，运行时由 buildCanvasAudioRequest 合并进 params。
    customFields?: WorkflowField[];
    customFieldValues?: Record<string, unknown>;
    onCustomFieldChange?: (id: string, value: unknown) => void;
    hideStandardAudioOptions?: boolean;
};

export function AudioSettingsPanel({
    config,
    onConfigChange,
    theme,
    showTitle = true,
    className = "w-[320px] space-y-4 rounded-2xl px-1 py-0.5",
    customFields,
    customFieldValues,
    onCustomFieldChange,
    hideStandardAudioOptions = false,
}: AudioSettingsPanelProps) {
    const { t } = useTranslation();
    const voice = normalizeAudioVoiceValue(config.audioVoice);
    const format = normalizeAudioFormatValue(config.audioFormat);
    const speed = normalizeAudioSpeedValue(config.audioSpeed);

    return (
        <ImageSettingsTheme theme={theme}>
            <div className={className} style={{ color: theme.node.text }} onMouseDown={(event) => event.stopPropagation()}>
                {showTitle ? <div className="text-lg font-semibold">{t("settingsPanels.audio.title")}</div> : null}
                {customFields && customFields.length > 0 && onCustomFieldChange ? (
                    <div className="space-y-2.5">
                        <SettingTitle color={theme.node.muted}>{t("settingsPanels.audio.workflowFields")}</SettingTitle>
                        <WorkflowCustomFields fields={customFields} values={customFieldValues || {}} onChange={onCustomFieldChange} />
                    </div>
                ) : null}
                {!hideStandardAudioOptions && (
                    <>
                        <SettingGroup title={t("settingsPanels.audio.voice")} color={theme.node.muted}>
                            <div className="grid grid-cols-3 gap-2.5">
                                {audioVoiceOptions.map((item) => (
                                    <OptionPill key={item.value} selected={voice === item.value} theme={theme} onClick={() => onConfigChange("audioVoice", item.value)}>
                                        {item.label}
                                    </OptionPill>
                                ))}
                            </div>
                        </SettingGroup>
                        <SettingGroup title={t("settingsPanels.audio.format")} color={theme.node.muted}>
                            <div className="grid grid-cols-3 gap-2.5">
                                {audioFormatOptions.map((item) => (
                                    <OptionPill key={item.value} selected={format === item.value} theme={theme} onClick={() => onConfigChange("audioFormat", item.value)}>
                                        {item.label}
                                    </OptionPill>
                                ))}
                            </div>
                        </SettingGroup>
                        <SettingGroup title={t("settingsPanels.audio.speed")} color={theme.node.muted}>
                            <div className="grid grid-cols-4 gap-2.5">
                                {speedOptions.map((value) => (
                                    <OptionPill key={value} selected={speed === value} theme={theme} onClick={() => onConfigChange("audioSpeed", value)}>
                                        {audioSpeedLabel(value)}
                                    </OptionPill>
                                ))}
                            </div>
                            <input
                                type="number"
                                min={0.25}
                                max={4}
                                step={0.05}
                                className="h-9 w-full rounded-full border bg-transparent px-3 text-center text-sm outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                                style={{ borderColor: theme.node.stroke, color: theme.node.text, WebkitTextFillColor: theme.node.text }}
                                value={config.audioSpeed || "1"}
                                onChange={(event) => onConfigChange("audioSpeed", event.target.value)}
                                onBlur={(event) => onConfigChange("audioSpeed", normalizeAudioSpeedValue(event.target.value))}
                                onMouseDown={(event) => event.stopPropagation()}
                            />
                        </SettingGroup>
                        <SettingGroup title={t("settingsPanels.audio.instructions")} color={theme.node.muted}>
                            <textarea
                                value={config.audioInstructions || ""}
                                placeholder={t("settingsPanels.audio.instructionsPlaceholder")}
                                className="thin-scrollbar h-20 w-full resize-none rounded-xl border bg-transparent px-3 py-2 text-sm leading-5 outline-none"
                                style={{ borderColor: theme.node.stroke, color: theme.node.text }}
                                onChange={(event) => onConfigChange("audioInstructions", event.target.value)}
                                onMouseDown={(event) => event.stopPropagation()}
                            />
                        </SettingGroup>
                    </>
                )}
            </div>
        </ImageSettingsTheme>
    );
}

function OptionPill({ selected, theme, onClick, children }: { selected: boolean; theme: CanvasTheme; onClick: () => void; children: ReactNode }) {
    return (
        <button type="button" className="h-9 cursor-pointer rounded-full border px-2 text-sm transition hover:opacity-80" style={{ background: "transparent", borderColor: selected ? theme.node.text : theme.node.stroke, color: theme.node.text }} onMouseDown={(event) => event.stopPropagation()} onClick={onClick}>
            {children}
        </button>
    );
}

function SettingGroup({ title, color, children }: { title: string; color: string; children: ReactNode }) {
    return (
        <div className="space-y-2.5">
            <div className="text-xs font-medium" style={{ color }}>
                {title}
            </div>
            {children}
        </div>
    );
}
