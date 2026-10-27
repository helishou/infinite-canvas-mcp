import { useEffect, useRef, useState, type RefObject } from "react";
import { CanvasPortal, useCanvasTransientEscape } from "@/lib/canvas/canvas-host";
import { CanvasSettingsContext } from "./canvas-settings-context";
import { canvasSettingsPosition } from "./canvas-settings-position";
import { Settings2 } from "lucide-react";
import { Button } from "antd";
import { fetchWorkflowDetail, isWorkflowAudioField, isWorkflowImageField, isWorkflowVideoField, type WorkflowDetail } from "@/services/api/workflows";

import { VideoSettingsPanel, videoResolutionLabel, videoSecondsLabel, videoSizeLabel } from "@/components/video-settings-panel";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { reconcileWorkflowParams } from "@/lib/canvas/canvas-workflow-params";
import { resolveModelChannel, resolveModelWorkflow, resolveModelWorkflowParams, type AiConfig } from "@/stores/use-config-store";

type CanvasVideoSettingsPopoverProps = {
    config: AiConfig;
    targetLabel?: string;
    onConfigChange: (key: keyof AiConfig, value: string) => void;
    runTargetOverride?: "local" | "cloud" | "hybrid";
    onRunTargetChange?: (value: "local" | "cloud" | "hybrid") => void;
    buttonClassName?: string;
    placement?: "topLeft" | "top" | "topRight" | "bottomLeft" | "bottom" | "bottomRight";
    comfyParams?: Record<string, unknown>;
    onComfyParamsChange?: (value: Record<string, unknown>) => void;
    referenceCount?: number;
};

export function CanvasVideoSettingsPopover({ config, targetLabel, onConfigChange, runTargetOverride, onRunTargetChange, buttonClassName, placement = "topLeft", comfyParams, onComfyParamsChange, referenceCount = 0 }: CanvasVideoSettingsPopoverProps) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const buttonRef = useRef<HTMLSpanElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    const [open, setOpen] = useState(false);
    useCanvasTransientEscape(open, () => setOpen(false));
    const [buttonRect, setButtonRect] = useState<DOMRect | null>(null);
    const [workflowDetail, setWorkflowDetail] = useState<WorkflowDetail | null>(null);
    const comfyParamsRef = useRef(comfyParams);
    const onComfyParamsChangeRef = useRef(onComfyParamsChange);
    const appliedWorkflowRef = useRef("");
    comfyParamsRef.current = comfyParams;
    onComfyParamsChangeRef.current = onComfyParamsChange;
    const channel = resolveModelChannel(config, config.model);
    const workflowName = channel.kind === "comfyui" ? resolveModelWorkflow(config, config.model, referenceCount) : "";

    useEffect(() => {
        if (!open) return;
        const syncPosition = () => setButtonRect(buttonRef.current?.getBoundingClientRect() || null);
        const closeOnOutsidePointer = (event: PointerEvent) => {
            const target = event.target;
            if (!(target instanceof Node)) return;
            if (buttonRef.current?.contains(target) || panelRef.current?.contains(target)) return;
            if (target instanceof Element && target.closest(".ant-select-dropdown")) return;
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

    useEffect(() => {
        if (!workflowName) {
            setWorkflowDetail(null);
            return;
        }
        let cancelled = false;
        fetchWorkflowDetail(workflowName).then((detail) => {
            if (!cancelled) setWorkflowDetail(detail);
        }).catch(() => {
            if (!cancelled) setWorkflowDetail(null);
        });
        return () => { cancelled = true; };
    }, [workflowName]);

    const activeWorkflowDetail = workflowDetail?.name === workflowName ? workflowDetail : null;
    const customFields = (activeWorkflowDetail?.config?.fields || []).filter((field) =>
        !isWorkflowImageField(field, activeWorkflowDetail?.workflow)
        && !isWorkflowVideoField(field, activeWorkflowDetail?.workflow)
        && !isWorkflowAudioField(field, activeWorkflowDetail?.workflow)
        && !field.isPrompt,
    );
    const hasRunningHubBinding = Boolean(activeWorkflowDetail?.config?.runningHubProfileId);
    const runTarget = runTargetOverride || activeWorkflowDetail?.config?.runTarget || "local";

    useEffect(() => {
        if (!workflowDetail || workflowDetail.name !== workflowName || !onComfyParamsChange) return;
        const signature = `${config.model}::${workflowName}`;
        const workflowChanged = Boolean(appliedWorkflowRef.current && appliedWorkflowRef.current !== signature);
        appliedWorkflowRef.current = signature;
        const routedParams = resolveModelWorkflowParams(config, config.model, referenceCount);
        const currentParams = comfyParamsRef.current;
        const next = reconcileWorkflowParams(currentParams, customFields, routedParams, workflowChanged);
        if (next && next !== currentParams) {
            comfyParamsRef.current = next;
            onComfyParamsChange(next);
        }
    }, [comfyParams, config, customFields, onComfyParamsChange, referenceCount, workflowDetail, workflowName]);

    const panel = open && buttonRect ? <VideoSettingsPortal
        buttonRect={buttonRect} panelRef={panelRef} placement={placement} theme={theme} targetLabel={targetLabel}
        config={config} onConfigChange={onConfigChange} customFields={customFields} customFieldValues={comfyParams}
        showRunTarget={hasRunningHubBinding} runTarget={runTarget} onRunTargetChange={onRunTargetChange}
        onCustomFieldChange={onComfyParamsChange ? (id, value) => {
            const next = { ...(comfyParamsRef.current || {}), [id]: value };
            comfyParamsRef.current = next;
            onComfyParamsChange(next);
        } : undefined}
    /> : null;

    return (
        <>
            <span ref={buttonRef} className="inline-flex min-w-0">
                <Button size="small" type="text" className={buttonClassName || "!h-8 !max-w-[170px] !justify-start !rounded-full !px-2.5"} style={{ background: theme.node.fill, color: theme.node.text }} icon={<Settings2 className="size-3.5" />} aria-expanded={open} onClick={() => setOpen((current) => !current)}>
                    <span className="truncate">
                        {videoResolutionLabel(config.vquality)} · {videoSizeLabel(config.size)} · {videoSecondsLabel(config.videoSeconds)}
                    </span>
                </Button>
            </span>
            {panel}
        </>
    );
}

function VideoSettingsPortal({
    buttonRect,
    panelRef,
    placement,
    theme,
    targetLabel,
    config,
    onConfigChange,
    customFields,
    customFieldValues,
    onCustomFieldChange,
    showRunTarget,
    runTarget,
    onRunTargetChange,
}: {
    buttonRect: DOMRect;
    panelRef: RefObject<HTMLDivElement | null>;
    placement: CanvasVideoSettingsPopoverProps["placement"];
    theme: (typeof canvasThemes)[keyof typeof canvasThemes];
    config: AiConfig;
    targetLabel?: string;
    onConfigChange: (key: keyof AiConfig, value: string) => void;
    customFields: NonNullable<Parameters<typeof VideoSettingsPanel>[0]["customFields"]>;
    customFieldValues?: Record<string, unknown>;
    onCustomFieldChange?: (id: string, value: unknown) => void;
    showRunTarget: boolean;
    runTarget: "local" | "cloud" | "hybrid";
    onRunTargetChange?: (value: "local" | "cloud" | "hybrid") => void;
}) {
    const style = {
        position: "fixed",
        zIndex: 1200,
        ...canvasSettingsPosition(buttonRect, { width: window.innerWidth, height: window.innerHeight }, placement),
        boxSizing: "border-box",
        background: theme.toolbar.panel,
        borderRadius: 18,
        boxShadow: "0 18px 54px rgba(28, 25, 23, 0.16)",
        padding: 18,
        overflowY: "auto",
        color: theme.node.text,
    } as const;

    return <CanvasPortal>
        <div
            ref={panelRef}
            data-canvas-shortcuts-ignore
            data-canvas-no-zoom
            className="canvas-image-settings-popover"
            style={style}
            onPointerDown={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
        >
            <CanvasSettingsContext targetLabel={targetLabel} />
            <VideoSettingsPanel config={config} onConfigChange={(key, value) => onConfigChange(key, value)} theme={theme} className="space-y-4" customFields={customFields} customFieldValues={customFieldValues} onCustomFieldChange={onCustomFieldChange} showRunTarget={showRunTarget} runTarget={runTarget} onRunTargetChange={onRunTargetChange} />
        </div></CanvasPortal>;
}
