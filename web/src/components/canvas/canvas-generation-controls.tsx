import { CanvasAudioSettingsPopover, type CanvasAudioSettingKey } from "./canvas-audio-settings-popover";
import { CanvasImageSettingsPopover } from "./canvas-image-settings-popover";
import { CanvasTextSettingsPopover } from "./canvas-text-settings-popover";
import { CanvasVideoSettingsPopover } from "./canvas-video-settings-popover";
import { useTranslation } from "react-i18next";
import { ModelPicker } from "@/components/model-picker";
import { useConfigStore, type AiConfig } from "@/stores/use-config-store";
import type { CanvasGenerationMode, CanvasNodeData } from "@/types/canvas";

/**
 * 智能生成节点 / 配置节点共用的「模型 + 设置」控件条。
 *
 * 抽出这个组件的原因：设置面板的 popover 有 4 个（image / video / audio / text），
 * 此前散落在两个父组件里各写一遍 mode 分支。音频那次漏传 comfyParams 导致
 * 「工作流参数」整块不渲染，就是这种重复的必然产物。
 *
 * 现在 comfyParams / onComfyParamsChange / referenceCount 由本组件统一接线，
 * 调用方只负责给出「本次带几张参考」，无法再漏。
 */
export type CanvasGenerationControlsProps = {
    node: CanvasNodeData;
    mode: CanvasGenerationMode;
    config: AiConfig;
    onConfigChange: (nodeId: string, patch: Partial<NonNullable<CanvasNodeData["metadata"]>>) => void;
    /** 本次生成会带上的各类参考数量，决定读哪个场景工作流的参数。 */
    referenceCounts: { image: number; audio: number };
    /** 每种输入场景各自的参考数量，供图像面板按场景路由工作流。 */
    imageReferenceCount?: number;
    textCount?: number;
    onTextCountChange?: (count: number) => void;
    onImageSettingsOpenChange?: (open: boolean) => void;
    onImagePromptRequiredChange?: (required: boolean) => void;
    /** grid 用于配置节点，compact 用于节点浮动面板。 */
    layout?: "grid" | "inline" | "compact";
    placement?: "topLeft" | "top" | "topRight";
    className?: string;
};

const GRID_BUTTON = "canvas-compact-control !h-10 !w-full !justify-start !rounded-lg !px-2";
const INLINE_BUTTON = "!h-10 !max-w-full !justify-start !rounded-lg !px-3";
const COMPACT_BUTTON = "!h-7 !max-w-full !min-w-0 !justify-start !rounded-md !px-2 !text-xs";

export function CanvasGenerationControls({
    node,
    mode,
    config,
    onConfigChange,
    referenceCounts,
    imageReferenceCount,
    textCount,
    onTextCountChange,
    onImageSettingsOpenChange,
    onImagePromptRequiredChange,
    layout = "inline",
    placement = "topLeft",
    className,
}: CanvasGenerationControlsProps) {
    const { t } = useTranslation();
    const targetLabel = node.title || t("canvas.node.untitled");
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const grid = layout === "grid";
    const compact = layout === "compact";
    const buttonClassName = grid ? GRID_BUTTON : compact ? COMPACT_BUTTON : INLINE_BUTTON;

    const comfyParams = node.metadata?.comfyParams;
    const onComfyParamsChange = (value: Record<string, unknown>, size?: string) => onConfigChange(node.id, { comfyParams: value, ...(size ? { size } : {}) });
    const changeModel = (model: string) => {
        onConfigChange(node.id, { model });
        if (mode === "image") updateConfig("imageModel", model);
    };

    const settings = (() => {
        if (mode === "image") {
            return (
                <CanvasImageSettingsPopover
                    config={config}
                    targetLabel={targetLabel}
                    placement={placement}
                    autoAdjustOverflow={false}
                    buttonClassName={buttonClassName}
                    onConfigChange={(key, value) => onConfigChange(node.id, key === "count" ? { count: Number(value) || 1 } : { [key]: value })}
                    onMissingConfig={() => openConfigDialog(true)}
                    onOpenChange={onImageSettingsOpenChange}
                    comfyParams={comfyParams}
                    onComfyParamsChange={onComfyParamsChange}
                    onPromptRequiredChange={onImagePromptRequiredChange}
                    referenceCount={imageReferenceCount ?? referenceCounts.image}
                />
            );
        }
        if (mode === "video") {
            return (
                <CanvasVideoSettingsPopover
                    config={config}
                    targetLabel={targetLabel}
                    placement={placement}
                    buttonClassName={buttonClassName}
                    onConfigChange={(key, value) => onConfigChange(node.id, videoConfigPatch(key, value))}
                />
            );
        }
        if (mode === "audio") {
            return (
                <CanvasAudioSettingsPopover
                    config={config}
                    targetLabel={targetLabel}
                    placement={placement}
                    buttonClassName={buttonClassName}
                    onConfigChange={(key, value) => onConfigChange(node.id, audioConfigPatch(key, value))}
                    comfyParams={comfyParams}
                    onComfyParamsChange={onComfyParamsChange}
                    referenceCount={referenceCounts.audio}
                />
            );
        }
        return (
            <CanvasTextSettingsPopover
                targetLabel={targetLabel}
                config={config}
                count={textCount}
                placement={placement}
                buttonClassName={buttonClassName}
                onConfigChange={(_, value) => onConfigChange(node.id, { reasoningEffort: value })}
                onCountChange={onTextCountChange ? (next) => onTextCountChange(next) : undefined}
            />
        );
    })();

    const picker = (
        <ModelPicker
            className={grid ? "canvas-compact-control h-10" : compact ? "canvas-compact-control !h-7 !min-h-7 !max-w-full !px-2 !text-xs" : "max-w-full"}
            config={config}
            value={config.model}
            onChange={changeModel}
            capability={mode}
            onMissingConfig={() => openConfigDialog(true)}
            fullWidth
        />
    );

    if (grid) {
        return (
            <div className={className ?? "mb-2 grid min-w-0 cursor-default grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-center gap-2"} onMouseDown={(event) => event.stopPropagation()}>
                {picker}
                {settings}
            </div>
        );
    }

    return (
        <div className={className ?? `grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-center ${compact ? "gap-1.5" : "gap-2"}`} onMouseDown={(event) => event.stopPropagation()}>
            {picker}
            {settings}
        </div>
    );
}

function videoConfigPatch(key: keyof AiConfig, value: string) {
    if (key === "videoSeconds") return { seconds: value };
    if (key === "videoGenerateAudio") return { generateAudio: value };
    if (key === "videoWatermark") return { watermark: value };
    return { [key]: value };
}

function audioConfigPatch(key: CanvasAudioSettingKey, value: string) {
    if (key === "audioVoice") return { audioVoice: value };
    if (key === "audioFormat") return { audioFormat: value };
    if (key === "audioSpeed") return { audioSpeed: value };
    return { audioInstructions: value };
}
