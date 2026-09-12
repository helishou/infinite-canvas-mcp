export const WORKFLOW_ROUTE_UNSUPPORTED = "__unsupported__";

const CHANNEL_MODEL_SEPARATOR = "::";

export type ModelInputScenario = "text" | "single" | "multi";

type ChannelModel = {
    name?: unknown;
    workflows?: unknown;
    workflowRouting?: unknown;
    workflowParams?: unknown;
};

type ModelChannel = {
    id?: unknown;
    models?: unknown;
    kind?: unknown;
};

export type WorkflowResolution =
    | { ok: true; workflow: string; scenario: ModelInputScenario; params: Record<string, unknown>; channelId?: string }
    | { ok: false; reason: "unsupported" | "no-workflow"; scenario: ModelInputScenario; channelId?: string; modelName: string };

export function scenarioFromReferenceCount(count: number): ModelInputScenario {
    return count <= 0 ? "text" : count === 1 ? "single" : "multi";
}

export function decodeChannelModel(value: string): { channelId: string; model: string } | null {
    const index = String(value || "").indexOf(CHANNEL_MODEL_SEPARATOR);
    if (index < 0) return null;
    return { channelId: value.slice(0, index), model: value.slice(index + CHANNEL_MODEL_SEPARATOR.length) };
}

export function modelOptionName(value: string): string {
    return decodeChannelModel(String(value || ""))?.model || String(value || "");
}

export function findChannelModel(aiConfig: unknown, value: string): { channel: ModelChannel; model: ChannelModel } | null {
    const config = asRecord(aiConfig);
    const channels = Array.isArray(config.channels) ? config.channels.filter(isRecord) : [];
    const decoded = decodeChannelModel(value);
    const name = decoded?.model || value;
    const channel = decoded
        ? channels.find((item) => String(item.id || "") === decoded.channelId)
        : channels.find((item) => modelsOf(item).some((model) => String(model.name || "") === name));
    const model = modelsOf(channel).find((item) => String(item.name || "") === name);
    return channel && model ? { channel, model } : null;
}

export function builtinWorkflowName(value: string): string {
    const name = modelOptionName(value).trim();
    if (/^z-image$/i.test(name)) return "Z-Image.json";
    if (/^flux2-klein$/i.test(name)) return "Flux2-Klein.json";
    if (/^flashvsr-1\.1$/i.test(name)) return "custom/视频修复FlashVSR1.1.json";
    if (/\.json$/i.test(name) || /^custom\//i.test(name)) return name;
    return "";
}

export function resolveWorkflowForModel(aiConfig: unknown, model: string, referenceCount: number, explicitWorkflow?: string): WorkflowResolution {
    const scenario = scenarioFromReferenceCount(referenceCount);
    const explicit = String(explicitWorkflow || "").trim();
    if (explicit) return { ok: true, workflow: explicit, scenario, params: {} };

    const decoded = decodeChannelModel(String(model || ""));
    const found = findChannelModel(aiConfig, String(model || ""));
    const modelName = modelOptionName(String(model || ""));
    const channelId = decoded?.channelId || (found ? String(found.channel.id || "") : undefined);
    if (found) {
        const routed = String(asRecord(found.model.workflowRouting)[scenario] || "").trim();
        if (routed === WORKFLOW_ROUTE_UNSUPPORTED) return { ok: false, reason: "unsupported", scenario, channelId, modelName };
        const params = workflowParamsFor(found.model, scenario);
        if (routed) return { ok: true, workflow: routed, scenario, channelId, params };
        const workflows = asStringArray(found.model.workflows);
        if (workflows.length) return { ok: true, workflow: workflows[0], scenario, channelId, params };
        if (String(found.channel.kind || "") === "comfyui" && modelName) return { ok: true, workflow: modelName, scenario, channelId, params };
    }

    const builtin = builtinWorkflowName(model);
    if (builtin) return { ok: true, workflow: builtin, scenario, channelId, params: {} };
    return { ok: false, reason: "no-workflow", scenario, channelId, modelName };
}

export function usesWorkflowExecutor(aiConfig: unknown, value: string): boolean {
    const found = findChannelModel(aiConfig, value);
    if (!found) return false;
    return String(found.channel.kind || "") === "comfyui"
        || asStringArray(found.model.workflows).length > 0
        || Object.keys(asRecord(found.model.workflowRouting)).length > 0;
}

export function workflowParamsFor(model: ChannelModel, scenario: ModelInputScenario): Record<string, unknown> {
    return { ...asRecord(asRecord(model.workflowParams)[scenario]) };
}

export function workflowResolutionMessage(result: Extract<WorkflowResolution, { ok: false }>): string {
    const scenario = { text: "文生图", single: "单图", multi: "多图" }[result.scenario];
    return result.reason === "unsupported"
        ? `模型「${result.modelName}」不支持${scenario}输入（已在渠道设置里把该场景标记为「不支持」），请改用其它模型或调整它的工作流路由`
        : `模型「${result.modelName}」没有可用工作流，请到渠道设置里为它配置工作流`;
}

function modelsOf(channel: ModelChannel | undefined): ChannelModel[] {
    return Array.isArray(channel?.models) ? channel.models.filter(isRecord) : [];
}

function asStringArray(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function asRecord(value: unknown): Record<string, unknown> {
    return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
