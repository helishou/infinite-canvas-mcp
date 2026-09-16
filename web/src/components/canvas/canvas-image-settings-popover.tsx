import { useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Settings2 } from "lucide-react";
import { Button } from "antd";
import { useTranslation } from "react-i18next";

import { ImageSettingsPanel, imageQualityLabel, imageSizeLabel } from "@/components/image-settings-panel";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { resolveModelChannel, resolveModelWorkflow, resolveModelWorkflowParams, type AiConfig } from "@/stores/use-config-store";
import { fetchWorkflowDetail, isWorkflowImageField, workflowRequiresPrompt, type WorkflowDetail } from "@/services/api/workflows";
import { reconcileWorkflowParams } from "@/lib/canvas/canvas-workflow-params";

type CanvasImageSettingsPopoverProps = {
    config: AiConfig;
    onConfigChange: (key: keyof AiConfig, value: string) => void;
    onMissingConfig?: () => void;
    onOpenChange?: (open: boolean) => void;
    buttonClassName?: string;
    getPopupContainer?: (triggerNode: HTMLElement) => HTMLElement;
    placement?: "topLeft" | "top" | "topRight" | "bottomLeft" | "bottom" | "bottomRight";
    autoAdjustOverflow?: boolean;
    // 选中本地 ComfyUI 工作流时，把工作流的非 image / 非 prompt 自定义字段渲染到面板顶部；
    // comfyParams 存在 node.metadata，运行时由 runLocalComfyImage 合并进 workflow fields。
    comfyParams?: Record<string, unknown>;
    onComfyParamsChange?: (value: Record<string, unknown>) => void;
    onPromptRequiredChange?: (required: boolean) => void;
    // 本次将带上的参考图数量：决定输入场景（0 = 文生 / 1 = 单图 / ≥2 = 多图），从而决定读哪个工作流的参数。
    referenceCount?: number;
};

export function CanvasImageSettingsPopover({ config, onConfigChange, onOpenChange, buttonClassName, placement = "topLeft", comfyParams, onComfyParamsChange, onPromptRequiredChange, referenceCount = 0 }: CanvasImageSettingsPopoverProps) {
    const { t } = useTranslation();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const buttonRef = useRef<HTMLSpanElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    const [open, setOpen] = useState(false);
    const [buttonRect, setButtonRect] = useState<DOMRect | null>(null);
    const [workflowDetail, setWorkflowDetail] = useState<WorkflowDetail | null>(null);
    // 已按哪个「模型 + 场景工作流」把参数落进节点 metadata：切换后要改用渠道配置重新铺一遍，
    // 否则同一字段名（如 steps）会沿用上一个场景的值。
    const appliedWorkflowRef = useRef("");
    const quality = config.quality || "auto";
    const count = Math.max(1, Math.min(15, Math.floor(Math.abs(Number(config.count)) || 1)));
    const activeSize = config.size || "auto";
    const updateOpen = (nextOpen: boolean) => {
        setOpen(nextOpen);
        onOpenChange?.(nextOpen);
    };

    useEffect(() => {
        if (!open) return;
        const syncPosition = () => setButtonRect(buttonRef.current?.getBoundingClientRect() || null);
        const closeOnOutsidePointer = (event: PointerEvent) => {
            const target = event.target;
            if (!(target instanceof Node)) return;
            if (buttonRef.current?.contains(target) || panelRef.current?.contains(target)) return;
            if (target instanceof Element && target.closest(".ant-select-dropdown")) return;
            if (document.activeElement instanceof HTMLElement && panelRef.current?.contains(document.activeElement)) document.activeElement.blur();
            setOpen(false);
            onOpenChange?.(false);
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
    }, [onOpenChange, open]);

    // 按「本次带几张参考图」解析该场景实际会跑的工作流（渠道模型挂多个工作流时逐场景不同），
    // 再拉它的字段渲染到面板顶部；模型切回云端 / 无可用工作流时清空。
    const comfyChannel = resolveModelChannel(config, config.model);
    const isLocalCustomWorkflow = comfyChannel.kind === "comfyui";
    const workflowName = isLocalCustomWorkflow ? resolveModelWorkflow(config, config.model, referenceCount) : "";

    useEffect(() => {
        if (!workflowName) {
            setWorkflowDetail(null);
            return;
        }
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
    }, [workflowName]);

    useEffect(() => {
        onPromptRequiredChange?.(workflowDetail?.name === workflowName && workflowRequiresPrompt(workflowDetail));
    }, [onPromptRequiredChange, workflowDetail, workflowName]);

    const customFields = (workflowDetail?.config?.fields || []).filter((field) => !isWorkflowImageField(field, workflowDetail?.workflow) && !field.isPrompt);

    useEffect(() => {
        if (!workflowDetail || workflowDetail.name !== workflowName || !onComfyParamsChange) return;
        // 换了模型或换了当前场景的工作流 → 本次以渠道配置（+字段默认值）重新铺一遍，
        // 同名但属于上一个工作流/场景的参数不再沿用。
        const signature = `${config.model}::${workflowName}`;
        const workflowChanged = Boolean(appliedWorkflowRef.current && appliedWorkflowRef.current !== signature);
        appliedWorkflowRef.current = signature;
        // 渠道设置里为当前输入场景配的参数优先于工作流字段默认值。
        const routedParams = resolveModelWorkflowParams(config, config.model, referenceCount);
        const next = reconcileWorkflowParams(comfyParams, customFields, routedParams, workflowChanged);
        if (next && next !== comfyParams) onComfyParamsChange(next);
    }, [comfyParams, customFields, onComfyParamsChange, workflowDetail, workflowName, config, referenceCount]);

    const panel = open && buttonRect ? (
        <ImageSettingsPortal
            buttonRect={buttonRect}
            panelRef={panelRef}
            placement={placement}
            theme={theme}
            config={config}
            onConfigChange={onConfigChange}
            customFields={customFields}
            customFieldValues={comfyParams}
            onCustomFieldChange={onComfyParamsChange ? (id, value) => onComfyParamsChange({ ...(comfyParams || {}), [id]: value }) : undefined}
            hideStandardImageOptions={isLocalCustomWorkflow}
        />
    ) : null;

    return (
        <>
            <span ref={buttonRef} className="inline-flex min-w-0">
                <Button size="small" type="text" className={buttonClassName || "!h-8 !max-w-[180px] !justify-start !rounded-full !px-2.5"} style={{ background: theme.node.fill, color: theme.node.text }} icon={<Settings2 className="size-3.5" />} onClick={() => updateOpen(!open)}>
                    <span className="truncate">
                        {imageQualityLabel(quality)} · {imageSizeLabel(activeSize)} · {t("canvas.controls.images", { count })}
                    </span>
                </Button>
            </span>
            {panel}
        </>
    );
}

function ImageSettingsPortal({
    buttonRect,
    panelRef,
    placement,
    theme,
    config,
    onConfigChange,
    customFields,
    customFieldValues,
    onCustomFieldChange,
    hideStandardImageOptions,
}: {
    buttonRect: DOMRect;
    panelRef: RefObject<HTMLDivElement | null>;
    placement: CanvasImageSettingsPopoverProps["placement"];
    theme: (typeof canvasThemes)[keyof typeof canvasThemes];
    config: AiConfig;
    onConfigChange: (key: keyof AiConfig, value: string) => void;
    customFields?: Parameters<typeof ImageSettingsPanel>[0]["customFields"];
    customFieldValues?: Parameters<typeof ImageSettingsPanel>[0]["customFieldValues"];
    onCustomFieldChange?: Parameters<typeof ImageSettingsPanel>[0]["onCustomFieldChange"];
    hideStandardImageOptions: boolean;
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
            <ImageSettingsPanel
                config={config}
                onConfigChange={(key, value) => onConfigChange(key, value)}
                theme={theme}
                className="space-y-4"
                customFields={customFields}
                customFieldValues={customFieldValues}
                onCustomFieldChange={onCustomFieldChange}
                hideStandardImageOptions={hideStandardImageOptions}
            />
        </div>,
        document.body,
    );
}
