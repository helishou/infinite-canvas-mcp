import { useEffect, useRef, useState } from "react";

import { fetchChannelModelDetail } from "@/services/api/image";
import { resolveModelChannel, type AiConfig } from "@/stores/use-config-store";
import type { WorkflowField } from "@/types/workflow";

/**
 * OpenAI 兼容渠道（本地 media-engine 这类）上报的模型字段。
 *
 * 画布自己的 ComfyUI 工作流字段来自 `/api/workflows/{name}`；引擎模型不是画布工作流，
 * 字段在 `/v1/models/{id}` 里。这里把它拉出来，并按字段默认值铺进 comfyParams，
 * 让面板一打开就有值，而不是一排空输入框。
 */
export function openaiChannelOf(config: AiConfig, model: string) {
    const channel = resolveModelChannel(config, model);
    if (!channel?.baseUrl) return null;
    if (channel.kind === "comfyui" || channel.kind === "codex-cli" || channel.kind === "hermes") return null;
    return (channel.apiFormat ?? "openai") === "openai" ? channel : null;
}

export function useChannelModelFields(options: {
    config: AiConfig;
    open: boolean;
    comfyParams?: Record<string, unknown>;
    /** 需要排除的字段类型（视频面板排除素材槽等）。 */
    excludeTypes?: string[];
    onParamsChange?: (next: Record<string, unknown>) => void;
}) {
    const { config, open, comfyParams, excludeTypes = [], onParamsChange } = options;
    const [fields, setFields] = useState<WorkflowField[]>([]);
    const paramsRef = useRef(comfyParams);
    paramsRef.current = comfyParams;
    const changeRef = useRef(onParamsChange);
    changeRef.current = onParamsChange;
    const seededRef = useRef("");
    const channel = openaiChannelOf(config, config.model);
    const model = config.model;

    useEffect(() => {
        if (!open || !channel) {
            setFields([]);
            return;
        }
        let cancelled = false;
        fetchChannelModelDetail(model)
            .then((detail) => {
                if (cancelled) return;
                const kept = (detail.fields || []).filter(
                    (field) => !field.isPrompt && !excludeTypes.includes(field.type),
                );
                setFields(kept);
                if (!kept.length || !changeRef.current) return;
                if (seededRef.current === model) return;
                seededRef.current = model;
                const defaults: Record<string, unknown> = {};
                for (const field of kept) {
                    if (field.default === undefined || field.default === "") continue;
                    defaults[field.id] = field.default;
                }
                // 换过模型后残留的旧字段要丢掉，否则面板会显示别的模型的参数。
                const known = new Set(kept.map((field) => field.id));
                const carried = Object.fromEntries(Object.entries(paramsRef.current || {}).filter(([key]) => known.has(key)));
                const next = { ...defaults, ...carried };
                if (Object.keys(next).length || Object.keys(paramsRef.current || {}).length) {
                    paramsRef.current = next;
                    changeRef.current(next);
                }
            })
            .catch(() => {
                if (!cancelled) setFields([]);
            });
        return () => {
            cancelled = true;
        };
    }, [open, model, channel?.id, excludeTypes.join(",")]);

    return { channel, fields };
}
