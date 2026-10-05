// 视频工作台按模型内部实现解析字段与共享参数值。
//
// 生图工作台已有「选中 ComfyUI 模型就渲染工作流自定义字段、隐藏通用项」的
// 机制；视频侧原先只有通用项。这里把同一套语义补上，参数值存在渠道模型的
// workflowParams[场景]，与「添加模型」弹窗里按场景配的参数共享同一份配置。
import { fetchWorkflowDetail, isWorkflowImageField, isWorkflowVideoField, isWorkflowAudioField, type WorkflowDetail, type WorkflowField } from "@/services/api/workflows";
import { fetchRunningHubWorkflows, type RunningHubWorkflowProfile } from "@/services/api/runninghub";
import { resolveModelWorkflow, resolveModelWorkflowParams, modelScenarioUnsupported, type AiConfig } from "@/stores/use-config-store";
import { resolveWorkflowBindingForModel } from "@basketikun/canvas-agent/model-workflow";
import { runningHubProfileToConfig } from "@/pages/workflows/runninghub-run-adapter";

export type VideoImplementation = {
    /** 本地工作流名或 RunningHub 档案 id，仅用于展示与缓存键。 */
    id: string;
    provider: "comfyui" | "runninghub";
    name: string;
    /** 非媒体、非提示词的可填写字段。 */
    fields: WorkflowField[];
};

/**
 * 面板展示的字段：排除媒体输入与提示词（两者由生成时按参考数量注入）。
 * 与生图工作台的 editableFields 同一口径。
 */
function editableFields(detail: WorkflowDetail | null): WorkflowField[] {
    return (detail?.config?.fields || []).filter(
        (field) => !isWorkflowImageField(field, detail?.workflow) && !field.isPrompt,
    );
}

/** RunningHub 档案的字段按同一口径过滤；媒体槽由平台映射决定，不在这里暴露。 */
function runningHubFields(profile: RunningHubWorkflowProfile): WorkflowField[] {
    const config = runningHubProfileToConfig(profile);
    return config.fields.filter((field) => field.type !== "image" && field.type !== "video" && field.type !== "audio");
}

/**
 * 解析当前模型在本次输入场景下命中的内部实现。
 * referenceCount 决定场景：0 = 文生 / 1 = 单图 / ≥2 = 多图。
 */
export async function resolveVideoImplementation(
    config: AiConfig,
    model: string,
    referenceCount: number,
): Promise<VideoImplementation | null> {
    // 必须先问绑定版解析：它知道 provider。旧的 resolveModelWorkflow 只读本地
    // 工作流名，对 RunningHub 绑定模型一律返回空，会让云端分支永远走不到。
    const binding = resolveWorkflowBindingForModel(config, model, referenceCount);
    if (!binding.ok) return null;
    if (binding.binding.provider === "runninghub") {
        const profileId = binding.binding.profileId;
        try {
            const { workflows } = await fetchRunningHubWorkflows();
            const profile = workflows.find((item) => item.id === profileId);
            if (!profile) return null;
            return { id: profile.id, provider: "runninghub", name: profile.name, fields: runningHubFields(profile) };
        } catch {
            return null;
        }
    }
    const localName = binding.binding.workflow || resolveModelWorkflow(config, model, referenceCount);
    if (!localName) return null;
    try {
        const detail = await fetchWorkflowDetail(localName);
        return { id: localName, provider: "comfyui", name: detail.config?.title || localName, fields: editableFields(detail) };
    } catch {
        return null;
    }
}

/** 该场景被显式标记为「不支持」时，面板要说明原因而不是显示通用项。 */
export function videoScenarioBlocked(config: AiConfig, model: string, referenceCount: number) {
    return modelScenarioUnsupported(config, model, referenceCount);
}

/**
 * 本次运行的初始参数值：字段默认值打底，渠道模型按场景配的参数覆盖。
 * 与生图工作台一致——渠道配置是默认值，手填的值优先级更高。
 */
export function initialVideoParamValues(config: AiConfig, model: string, referenceCount: number, fields: WorkflowField[]) {
    const routed = resolveModelWorkflowParams(config, model, referenceCount);
    const values: Record<string, unknown> = {};
    for (const field of fields) {
        if (routed[field.id] !== undefined) {
            values[field.id] = routed[field.id];
            continue;
        }
        if (field.default !== undefined) values[field.id] = field.default;
    }
    return values;
}

/** 参数键按「模型::实现」隔离，避免同名字段在不同工作流之间串值。 */
export function videoParamKey(model: string, implementationId: string) {
    return `${model}::${implementationId}`;
}
