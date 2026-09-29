import { useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Settings2 } from "lucide-react";
import { Button } from "antd";

import { AudioSettingsPanel } from "@/components/audio-settings-panel";
import { audioFormatLabel, audioSpeedLabel, audioVoiceLabel } from "@/lib/audio-generation";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { resolveModelChannel, resolveModelWorkflow, resolveModelWorkflowParams, type AiConfig } from "@/stores/use-config-store";
import { fetchWorkflowDetail, isWorkflowAudioField, type WorkflowDetail } from "@/services/api/workflows";
import { reconcileWorkflowParams } from "@/lib/canvas/canvas-workflow-params";

export type CanvasAudioSettingKey = "audioVoice" | "audioFormat" | "audioSpeed" | "audioInstructions";

type CanvasAudioSettingsPopoverProps = {
    config: AiConfig;
    onConfigChange: (key: CanvasAudioSettingKey, value: string) => void;
    buttonClassName?: string;
    placement?: "topLeft" | "top" | "topRight" | "bottomLeft" | "bottom" | "bottomRight";
    // 与图像设置面板一致：选中本地 ComfyUI 音频工作流时，把工作流的非 audio / 非 prompt
    // 自定义字段渲染到面板顶部。comfyParams 存在 node.metadata，
    // 运行时由后端 buildCanvasAudioRequest 合并进 params。
    comfyParams?: Record<string, unknown>;
    onComfyParamsChange?: (value: Record<string, unknown>) => void;
    // 本次会带上的参考音频数量：决定输入场景（0 = 纯文本 / ≥1 = 参考音色克隆），从而读哪个工作流的参数。
    referenceCount?: number;
};

export function CanvasAudioSettingsPopover({
    config,
    onConfigChange,
    buttonClassName,
    placement = "topLeft",
    comfyParams,
    onComfyParamsChange,
    referenceCount = 0,
}: CanvasAudioSettingsPopoverProps) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const buttonRef = useRef<HTMLSpanElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    const [open, setOpen] = useState(false);
    const [buttonRect, setButtonRect] = useState<DOMRect | null>(null);
    const [workflowDetail, setWorkflowDetail] = useState<WorkflowDetail | null>(null);
    const comfyParamsRef = useRef(comfyParams);
    const onComfyParamsChangeRef = useRef(onComfyParamsChange);
    comfyParamsRef.current = comfyParams;
    onComfyParamsChangeRef.current = onComfyParamsChange;
    // 已按哪个「模型 + 场景工作流」把参数落进节点 metadata：切换后要改用渠道配置重新铺一遍，
    // 否则同一字段名会沿用上一个场景的值。
    const appliedWorkflowRef = useRef("");

    useEffect(() => {
        if (!open) return;
        const syncPosition = () => setButtonRect(buttonRef.current?.getBoundingClientRect() || null);
        const closeOnOutsidePointer = (event: PointerEvent) => {
            const target = event.target;
            if (!(target instanceof Node)) return;
            if (buttonRef.current?.contains(target) || panelRef.current?.contains(target)) return;
            // antd 下拉挂在 body 上，点它的选项不应被当成「点外面」而关掉面板。
            if (target instanceof Element && target.closest(".ant-select-dropdown")) return;
            if (document.activeElement instanceof HTMLElement && panelRef.current?.contains(document.activeElement)) document.activeElement.blur();
            setOpen(false);
        };

        syncPosition();
        window.addEventListener("resize", syncPosition);
        window.addEventListener("scroll", syncPosition, true);
        window.addEventListener("pointerdown", closeOnOutsidePointer, true);
        return () => {
            window.removeEventListener("resize", syncPosition);
            window.removeEventListener("scroll", syncPosition, true);
            window.removeEventListener("pointerdown", closeOnOutsidePointer, true);
        };
    }, [open]);

    // 按「本次带几段参考音频」解析该场景实际会跑的工作流（渠道模型挂多个工作流时逐场景不同），
    // 再拉它的字段渲染到面板顶部；模型切回云端 / 无可用工作流时清空。
    const comfyChannel = resolveModelChannel(config, config.model);
    const isLocalCustomWorkflow = comfyChannel.kind === "comfyui";
    const workflowName = isLocalCustomWorkflow ? resolveModelWorkflow(config, config.model, referenceCount) : "";

    useEffect(() => {
        if (!workflowName) {
            setWorkflowDetail(null);
            return;
        }
        // 面板每次打开时重新取字段，避免使用已过期的字段 ID。
        if (!open && workflowDetail?.name === workflowName) return;
        let cancelled = false;
        fetchWorkflowDetail(workflowName)
            .then((detail) => {
                if (cancelled) return;
                setWorkflowDetail(detail);
            })
            .catch(() => {
                if (cancelled) return;
                setWorkflowDetail(null);
            });
        return () => {
            cancelled = true;
        };
    }, [open, workflowName]);

    const customFields = (workflowDetail?.config?.fields || []).filter((field) => !isWorkflowAudioField(field, workflowDetail?.workflow) && !field.isPrompt);

    useEffect(() => {
        if (!workflowDetail || workflowDetail.name !== workflowName || !onComfyParamsChange) return;
        // 换了模型或换了当前场景的工作流 → 本次以渠道配置（+字段默认值）重新铺一遍，
        // 同名但属于上一个工作流/场景的参数不再沿用。
        const signature = `${config.model}::${workflowName}`;
        const workflowChanged = Boolean(appliedWorkflowRef.current && appliedWorkflowRef.current !== signature);
        appliedWorkflowRef.current = signature;
        // 模型设置里为当前输入场景配的参数优先于内部实现字段默认值。
        const routedParams = resolveModelWorkflowParams(config, config.model, referenceCount);
        const currentParams = comfyParamsRef.current;
        const next = reconcileWorkflowParams(currentParams, customFields, routedParams, workflowChanged);
        if (next && next !== currentParams) {
            comfyParamsRef.current = next;
            onComfyParamsChange(next);
        }
    }, [comfyParams, customFields, onComfyParamsChange, workflowDetail, workflowName, config, referenceCount]);

    const panel =
        open && buttonRect ? (
            <AudioSettingsPortal
                buttonRect={buttonRect}
                panelRef={panelRef}
                placement={placement}
                theme={theme}
                config={config}
                onConfigChange={onConfigChange}
                customFields={customFields}
                customFieldValues={comfyParams}
                onCustomFieldChange={
                    onComfyParamsChange
                        ? (id, value) => {
                              const next = { ...(comfyParamsRef.current || {}), [id]: value };
                              comfyParamsRef.current = next;
                              onComfyParamsChange(next);
                          }
                        : undefined
                }
                hideStandardAudioOptions={isLocalCustomWorkflow}
            />
        ) : null;

    return (
        <>
            <span ref={buttonRef} className="inline-flex min-w-0">
                <Button size="small" type="text" className={buttonClassName || "!h-8 !max-w-[170px] !justify-start !rounded-full !px-2.5"} style={{ background: theme.node.fill, color: theme.node.text }} icon={<Settings2 className="size-3.5" />} onClick={() => setOpen((current) => !current)}>
                    <span className="truncate">
                        {audioVoiceLabel(config.audioVoice)} · {audioFormatLabel(config.audioFormat)} · {audioSpeedLabel(config.audioSpeed)}
                    </span>
                </Button>
            </span>
            {panel}
        </>
    );
}

function AudioSettingsPortal({
    buttonRect,
    panelRef,
    placement,
    theme,
    config,
    onConfigChange,
    customFields,
    customFieldValues,
    onCustomFieldChange,
    hideStandardAudioOptions,
}: {
    buttonRect: DOMRect;
    panelRef: RefObject<HTMLDivElement | null>;
    placement: CanvasAudioSettingsPopoverProps["placement"];
    theme: (typeof canvasThemes)[keyof typeof canvasThemes];
    config: AiConfig;
    onConfigChange: (key: CanvasAudioSettingKey, value: string) => void;
    customFields: Parameters<typeof AudioSettingsPanel>[0]["customFields"];
    customFieldValues: Parameters<typeof AudioSettingsPanel>[0]["customFieldValues"];
    onCustomFieldChange: Parameters<typeof AudioSettingsPanel>[0]["onCustomFieldChange"];
    hideStandardAudioOptions: boolean;
}) {
    const width = 356;
    const gap = 8;
    const margin = 12;
    const alignRight = placement?.endsWith("Right");
    const alignCenter = placement === "top" || placement === "bottom";
    const left = alignCenter ? buttonRect.left + buttonRect.width / 2 - width / 2 : alignRight ? buttonRect.right - width : buttonRect.left;
    const topPlacement = placement?.startsWith("top");
    const style = {
        position: "fixed",
        zIndex: 1200,
        width,
        left: Math.max(margin, Math.min(window.innerWidth - width - margin, left)),
        ...(topPlacement ? { bottom: window.innerHeight - buttonRect.top + gap, maxHeight: Math.max(260, buttonRect.top - margin * 2) } : { top: buttonRect.bottom + gap, maxHeight: Math.max(260, window.innerHeight - buttonRect.bottom - margin * 2) }),
        background: theme.toolbar.panel,
        borderRadius: 18,
        boxShadow: "0 18px 54px rgba(28, 25, 23, 0.16)",
        padding: 18,
        overflowY: "auto",
        color: theme.node.text,
    } as const;

    return createPortal(
        <div
            ref={panelRef}
            className="canvas-image-settings-popover"
            style={style}
            onPointerDown={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
        >
            <AudioSettingsPanel
                config={config}
                onConfigChange={(key, value) => onConfigChange(key, value)}
                theme={theme}
                className="space-y-4"
                customFields={customFields}
                customFieldValues={customFieldValues}
                onCustomFieldChange={onCustomFieldChange}
                hideStandardAudioOptions={hideStandardAudioOptions}
            />
        </div>,
        document.body,
    );
}
