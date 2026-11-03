import { useEffect, useId, useMemo, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { useQuery, useQueries } from "@tanstack/react-query";
import { resolveWorkflowBindingForModel } from "@basketikun/canvas-agent/model-workflow";
import { imageModelCompatibility } from "@/lib/image-model-compatibility";
import { fetchWorkflowDetail } from "@/services/api/workflows";
import { Cpu } from "lucide-react";
import { useTranslation } from "react-i18next";

import i18n from "@/i18n";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { fetchCanvasModelUsage } from "@/services/backend-api";
import { decodeChannelModel, modelOptionLabel, modelOptionName, selectableModelsByCapability, VIDEO_CONCAT_MODEL, type AiConfig, type ModelCapability } from "@/stores/use-config-store";

type ModelPickerProps = {
    config: AiConfig;
    value?: string;
    onChange: (model: string) => void;
    capability?: ModelCapability;
    className?: string;
    fullWidth?: boolean;
    sortByCanvasUsage?: boolean;
    placeholder?: string;
    onImageCompatibilityChange?: (compatible: boolean) => void;
    imageReferenceCount?: number;
    onMissingConfig?: () => void;
};

export function ModelPicker({ config, value, onChange, capability, className, fullWidth = false, sortByCanvasUsage = false, placeholder, imageReferenceCount, onImageCompatibilityChange, onMissingConfig }: ModelPickerProps) {
    const { t } = useTranslation();
    const pickerId = useId();
    const [open, setOpen] = useState(false);
    const modelUsage = useQuery({ queryKey: ["canvas-model-usage"], queryFn: fetchCanvasModelUsage, staleTime: 60_000, enabled: sortByCanvasUsage }).data;
    const candidates = capability === 'image' && imageReferenceCount !== undefined ? selectableModelsByCapability(config, capability) : [];
    const routes = candidates.map(model => resolveWorkflowBindingForModel(config, model, imageReferenceCount || 0));
    const workflowNames = [...new Set(routes.flatMap(route => route.ok && route.binding.provider === 'comfyui' ? [route.binding.workflow] : []))];
    const details = useQueries({ queries: workflowNames.map(name => ({ queryKey: ['workflow-image-inputs', name], queryFn: () => fetchWorkflowDetail(name), staleTime: 0 })) });
    const compatibility = new Map(candidates.map((model,index) => {
        const route = routes[index];
        const counts = route.ok && route.binding.provider === 'comfyui'
            ? details[workflowNames.indexOf(route.binding.workflow)]?.data?.imageInputCounts : undefined;
        return [model, imageModelCompatibility(config, model, imageReferenceCount!, counts)] as const;
    }));
    const incompatible = new Set(candidates.filter(model => compatibility.get(model) === 'unsupported'));
    const options = useMemo(() => {
        const unique = Array.from(new Set([...(config.channelMode === "local" && !capability ? [value] : []), ...selectableModelsByCapability(config, capability)].filter((model): model is string => Boolean(model))));
        const originalOrder = new Map(unique.map((model, index) => [model, index]));
        const usageByName = new Map<string, number>();
        const usageByChannelModel = new Map<string, number>();
        for (const { model, channelId, count } of modelUsage || []) {
            usageByName.set(model, (usageByName.get(model) || 0) + count);
            if (channelId) usageByChannelModel.set(`${channelId}::${model}`, count);
        }
        if (!sortByCanvasUsage) return unique;
        return unique.sort((left, right) => {
            const usage = (model: string) => {
                const decoded = decodeChannelModel(model);
                const name = decoded?.model || modelOptionName(model);
                return (decoded && usageByChannelModel.get(`${decoded.channelId}::${name}`)) || usageByName.get(name) || 0;
            };
            const usageDifference = usage(right) - usage(left);
            return usageDifference || originalOrder.get(left)! - originalOrder.get(right)!;
        });
    }, [capability, config, modelUsage, sortByCanvasUsage, value]);
    const availableOptions = options.filter(model => !incompatible.has(model));
    const selectedRoute = resolveWorkflowBindingForModel(config, value || '', imageReferenceCount || 0);
    const selectedCounts = selectedRoute.ok && selectedRoute.binding.provider === 'comfyui'
        ? details[workflowNames.indexOf(selectedRoute.binding.workflow)]?.data?.imageInputCounts : undefined;
    const selectedIncompatible = capability === 'image' && imageReferenceCount !== undefined && imageModelCompatibility(config, value || '', imageReferenceCount, selectedCounts) === 'unsupported';
    useEffect(() => {
        onImageCompatibilityChange?.(!selectedIncompatible);
    }, [selectedIncompatible, onImageCompatibilityChange]);
    const current = value || "";
    const pickerPlaceholder = placeholder || t("settingsPanels.model.select");

    useEffect(() => {
        const closeOtherPicker = (event: Event) => {
            if ((event as CustomEvent<string>).detail !== pickerId) setOpen(false);
        };
        window.addEventListener("model-picker-open", closeOtherPicker);
        return () => window.removeEventListener("model-picker-open", closeOtherPicker);
    }, [pickerId]);

    return (
        <Select
            open={open}
            value={current}
            onOpenChange={(nextOpen: boolean) => {
                if (nextOpen && !options.length && config.channelMode === "local") onMissingConfig?.();
                if (nextOpen) window.dispatchEvent(new CustomEvent("model-picker-open", { detail: pickerId }));
                setOpen(nextOpen);
            }}
            onValueChange={onChange}
        >
            <SelectTrigger
                className={cn(
                    "canvas-composer-model-picker h-8 w-fit max-w-full gap-2 rounded-full border border-input bg-transparent px-3 text-sm font-normal shadow-sm transition-colors",
                    fullWidth ? "w-full min-w-0 justify-start" : "min-w-[9rem] justify-start",
                    "data-[state=open]:border-ring data-[state=open]:ring-2 data-[state=open]:ring-ring/20",
                    className,
                )}
                onMouseDown={(event: ReactMouseEvent) => event.stopPropagation()}
                onPointerDown={(event: ReactPointerEvent) => event.stopPropagation()}
                title={current ? current === VIDEO_CONCAT_MODEL ? "视频拼接" : modelOptionLabel(config, current) : pickerPlaceholder}
            >
                <ModelIcon model={current} />
                <span className="canvas-model-picker-text min-w-0 flex-1 truncate text-left">{selectedIncompatible ? `当前模型不支持 ${imageReferenceCount} 张参考图，请更换模型` : current ? modelOptionLabel(config, current) : pickerPlaceholder}</span>
            </SelectTrigger>
            <SelectContent
                data-canvas-no-zoom
                className="z-[1200] w-80 max-w-[calc(100vw-24px)] rounded-xl border border-border/70 bg-popover p-1 shadow-xl"
                position="popper"
                align="start"
                side="bottom"
                sideOffset={6}
                onPointerDown={(event: ReactPointerEvent) => event.stopPropagation()}
                onMouseDown={(event: ReactMouseEvent) => event.stopPropagation()}
            >
                {availableOptions.length ? (
                    availableOptions.map((model) => (
                        <SelectItem key={model} value={model} textValue={modelOptionLabel(config, model)}>
                            <ModelLabel config={config} model={model} />
                            {compatibility.get(model) === 'unknown' && <span className="ml-2 text-xs text-muted-foreground" title="未声明参考图容量，保留可选并按执行器契约校验；不会按模型名称猜测">容量待确认</span>}
                        </SelectItem>
                    ))
                ) : (
                    <SelectItem value="__empty__" disabled>
                        {imageReferenceCount !== undefined ? `没有支持 ${imageReferenceCount} 张参考图的模型，请调整输入或模型工作流` : emptyModelLabel(config, capability)}
                    </SelectItem>
                )}
            </SelectContent>
        </Select>
    );
}

function emptyModelLabel(config: AiConfig, capability?: ModelCapability) {
    const label = capability ? i18n.t(`settingsPanels.model.capabilities.${capability}`) : "";
    if (capability && config.models.length) return i18n.t("settingsPanels.model.assign", { capability: label });
    return config.models.length ? i18n.t("settingsPanels.model.noMatch", { capability: label }) : i18n.t("settingsPanels.model.addFirst");
}

function ModelLabel({ config, model }: { config: AiConfig; model: string }) {
    return (
        <span className="flex min-w-0 items-center gap-2">
            <ModelIcon model={model} />
            <span className="truncate">{model === VIDEO_CONCAT_MODEL ? "视频拼接" : modelOptionLabel(config, model)}</span>
        </span>
    );
}

function ModelIcon({ model }: { model: string }) {
    const icon = resolveModelIcon(modelOptionName(model));
    return icon ? <img src={icon} alt="" className="size-4 shrink-0 dark:invert" /> : <Cpu className="size-4 shrink-0 opacity-70" />;
}

function resolveModelIcon(model: string) {
    const name = model.toLowerCase();
    if (name.includes("claude") || name.includes("anthropic")) return "/icons/claude.svg";
    if (name.includes("gemini") || name.includes("google")) return "/icons/gemini.svg";
    if (name.includes("gpt") || name.includes("openai")) return "/icons/openai.svg";
    if (name.includes("grok") || name.includes("grok")) return "/icons/grok.svg";
    if (name.includes("deepseek") || name.includes("deepseek")) return "/icons/deepseek.svg";
    if (name.includes("glm") || name.includes("glm")) return "/icons/glm.svg";
    return "";
}
