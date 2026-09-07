import { useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Settings2 } from "lucide-react";
import { Button } from "antd";
import { useTranslation } from "react-i18next";

import { ImageSettingsPanel, imageQualityLabel, imageSizeLabel } from "@/components/image-settings-panel";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { modelOptionName, resolveModelChannel, type AiConfig } from "@/stores/use-config-store";
import { fetchWorkflowDetail, isWorkflowImageField, type WorkflowDetail } from "@/services/api/workflows";

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
};

export function CanvasImageSettingsPopover({ config, onConfigChange, onOpenChange, buttonClassName, placement = "topLeft", comfyParams, onComfyParamsChange }: CanvasImageSettingsPopoverProps) {
    const { t } = useTranslation();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const buttonRef = useRef<HTMLSpanElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    const [open, setOpen] = useState(false);
    const [buttonRect, setButtonRect] = useState<DOMRect | null>(null);
    const [workflowDetail, setWorkflowDetail] = useState<WorkflowDetail | null>(null);
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

    // 选中本地 ComfyUI 工作流（且不是内置 z-image / flux2-klein）时拉详情，把非 image / 非 prompt
    // 的字段渲染到面板顶部；model 切回云端 / 内置 preset 时清空。
    const comfyChannel = resolveModelChannel(config, config.model);
    const selectedModelName = modelOptionName(config.model).trim();
    const isLocalCustomWorkflow = comfyChannel.kind === "comfyui";

    useEffect(() => {
        if (!isLocalCustomWorkflow) {
            setWorkflowDetail(null);
            return;
        }
        let cancelled = false;
        fetchWorkflowDetail(selectedModelName)
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
    }, [isLocalCustomWorkflow, selectedModelName]);

    const customFields = (workflowDetail?.config?.fields || []).filter((field) => !isWorkflowImageField(field, workflowDetail?.workflow) && !field.isPrompt);

    useEffect(() => {
        if (!workflowDetail || !onComfyParamsChange) return;
        const next = { ...(comfyParams || {}) };
        let changed = false;
        for (const field of customFields) {
            if (next[field.id] !== undefined && next[field.id] !== null) continue;
            const options = field.options || [];
            const value = field.type === "dropdown"
                ? (options.includes(String(field.default ?? "")) ? field.default : options[0] ?? "")
                : field.default ?? (field.type === "boolean" ? false : field.type === "number" || field.type === "slider" ? 0 : "");
            next[field.id] = value;
            changed = true;
        }
        if (changed) onComfyParamsChange(next);
    }, [comfyParams, customFields, onComfyParamsChange, workflowDetail]);

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
