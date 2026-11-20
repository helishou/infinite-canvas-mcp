import type { WorkflowField } from "@/types/workflow";

/** 引擎 `/v1/models/{id}` 的 standard_params 中我们关心的部分。 */
export type ModelStandardRole = {
    role: string;
    field?: string | null;
    openai_param?: string | null;
    bound?: boolean;
};

export type ModelStandardParams = {
    supported?: string[];
    roles?: ModelStandardRole[];
};

/** 预设 UI 需要接管的字段 id：尺寸写 width/height，时长字段从高级区排除（由 seconds 注入）。 */
export type PresetFieldIds = {
    width?: string;
    height?: string;
    seconds?: string;
};

/**
 * 用引擎上报的标准角色把字段映射到预设控件。
 * 优先认 standard_params.roles 的 role（权威、跨工作流稳定），缺失时退回字段名启发式。
 * 返回空对象表示该模型没有可预设的尺寸/时长字段，面板应退回平铺字段模式。
 */
export function resolvePresetFieldIds(
    fields: WorkflowField[],
    standardParams: ModelStandardParams | null | undefined,
): PresetFieldIds {
    const roles = standardParams?.roles || [];
    const fieldOf = (role: string) => roles.find((item) => item.role === role && item.bound && item.field)?.field || undefined;
    const byInput = (name: string) => fields.find((field) => field.input === name)?.id;
    const width = fieldOf("width") || byInput("width");
    const height = fieldOf("height") || byInput("height");
    const seconds = fieldOf("frames")
        || fields.find((field) => field.id === "frames" || field.input === "frames" || field.input === "duration")?.id;
    return { width, height, seconds };
}
