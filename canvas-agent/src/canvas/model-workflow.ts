export const WORKFLOW_ROUTE_UNSUPPORTED = "__unsupported__";

const CHANNEL_MODEL_SEPARATOR = "::";

export type ModelInputScenario = "text" | "single" | "multi";

/**
 * 一个输入场景实际使用的内部实现。
 *
 * `comfyui` 用本地工作流文件名，`runninghub` 用 RunningHub 工作流档案的稳定 id；
 * 两者不能用同一个字符串表达，否则无法区分执行器、字段 schema 和失效原因。
 * 旧的 `workflows` / `workflowRouting` 只存文件名，继续按 comfyui 解析。
 */
export type WorkflowBinding =
  | { provider: "comfyui"; workflow: string }
  | { provider: "runninghub"; profileId: string };

type ChannelModel = {
  name?: unknown;
  script?: unknown;
  workflows?: unknown;
  workflowRouting?: unknown;
  workflowParams?: unknown;
  workflowBindings?: unknown;
};

type ModelChannel = {
  id?: unknown;
  models?: unknown;
  kind?: unknown;
};

export type WorkflowResolution =
  | {
      ok: true;
      workflow: string;
      scenario: ModelInputScenario;
      params: Record<string, unknown>;
      channelId?: string;
    }
  | {
      ok: false;
      reason: "unsupported" | "no-workflow";
      scenario: ModelInputScenario;
      channelId?: string;
      modelName: string;
    };

export function scenarioFromReferenceCount(count: number): ModelInputScenario {
  return count <= 0 ? "text" : count === 1 ? "single" : "multi";
}

export function decodeChannelModel(
  value: string,
): { channelId: string; model: string } | null {
  const index = String(value || "").indexOf(CHANNEL_MODEL_SEPARATOR);
  if (index < 0) return null;
  return {
    channelId: value.slice(0, index),
    model: value.slice(index + CHANNEL_MODEL_SEPARATOR.length),
  };
}

export function modelOptionName(value: string): string {
  return decodeChannelModel(String(value || ""))?.model || String(value || "");
}

export function findChannelModel(
  aiConfig: unknown,
  value: string,
): { channel: ModelChannel; model: ChannelModel } | null {
  const config = asRecord(aiConfig);
  const channels = Array.isArray(config.channels)
    ? config.channels.filter(isRecord)
    : [];
  const decoded = decodeChannelModel(value);
  const name = decoded?.model || value;
  const channel = decoded
    ? channels.find((item) => String(item.id || "") === decoded.channelId)
    : channels.find((item) =>
        modelsOf(item).some((model) => String(model.name || "") === name),
      );
  const model = modelsOf(channel).find(
    (item) => String(item.name || "") === name,
  );
  return channel && model ? { channel, model } : null;
}

/** Returns the immutable browser-side executor body attached to a model. */
export function resolveModelScript(aiConfig: unknown, value: string): string {
  return String(findChannelModel(aiConfig, value)?.model.script || "").trim();
}

export function builtinWorkflowName(value: string): string {
  const name = modelOptionName(value).trim();
  if (/^z-image$/i.test(name)) return "Z-Image.json";
  if (/^flux2-klein$/i.test(name)) return "Flux2-Klein.json";
  if (/^flashvsr-1\.1$/i.test(name)) return "custom/视频修复FlashVSR1.1.json";
  return "";
}

export function resolveWorkflowForModel(
  aiConfig: unknown,
  model: string,
  referenceCount: number,
): WorkflowResolution {
  const scenario = scenarioFromReferenceCount(referenceCount);
  const decoded = decodeChannelModel(String(model || ""));
  const found = findChannelModel(aiConfig, String(model || ""));
  const modelName = modelOptionName(String(model || ""));
  const channelId =
    decoded?.channelId || (found ? String(found.channel.id || "") : undefined);
  if (found) {
    const routed = String(
      asRecord(found.model.workflowRouting)[scenario] || "",
    ).trim();
    if (routed === WORKFLOW_ROUTE_UNSUPPORTED)
      return {
        ok: false,
        reason: "unsupported",
        scenario,
        channelId,
        modelName,
      };
    const params = workflowParamsFor(found.model, scenario);
    if (routed)
      return { ok: true, workflow: routed, scenario, channelId, params };
    const workflows = asStringArray(found.model.workflows);
    if (workflows.length)
      return { ok: true, workflow: workflows[0], scenario, channelId, params };
  }

  const builtin = builtinWorkflowName(model);
  if (builtin)
    return { ok: true, workflow: builtin, scenario, channelId, params: {} };
  return { ok: false, reason: "no-workflow", scenario, channelId, modelName };
}

export function usesWorkflowExecutor(
  aiConfig: unknown,
  value: string,
): boolean {
  const found = findChannelModel(aiConfig, value);
  if (!found) return false;
  return (
    String(found.channel.kind || "") === "comfyui" ||
    asStringArray(found.model.workflows).length > 0 ||
    Object.keys(asRecord(found.model.workflowRouting)).length > 0 ||
    // 只挂 RunningHub 绑定的模型没有本地工作流，但仍要走模型路由到云端执行器。
    Object.keys(asRecord(found.model.workflowBindings)).length > 0
  );
}

/** 读取单个场景的显式绑定；旧 routing 里的文件名不算 RunningHub 绑定。 */
function workflowBindingFor(
  model: ChannelModel,
  scenario: ModelInputScenario,
): WorkflowBinding | null {
  const bindings = asRecord(model.workflowBindings);
  const raw = bindings[scenario];
  if (!isRecord(raw)) return null;
  const provider = String(raw.provider || "");
  if (provider === "runninghub") {
    const profileId = String(raw.profileId || "").trim();
    return profileId ? { provider: "runninghub", profileId } : null;
  }
  if (provider === "comfyui") {
    const workflow = String(raw.workflow || "").trim();
    return workflow ? { provider: "comfyui", workflow } : null;
  }
  return null;
}

function asBinding(value: unknown): WorkflowBinding | null {
  if (!isRecord(value)) return null;
  const provider = String(value.provider || "");
  if (provider === "runninghub") {
    const profileId = String(value.profileId || "").trim();
    return profileId ? { provider: "runninghub", profileId } : null;
  }
  if (provider === "comfyui") {
    const workflow = String(value.workflow || "").trim();
    return workflow ? { provider: "comfyui", workflow } : null;
  }
  return null;
}

export { asBinding };

/**
 * 场景 → 内部实现的统一解析：显式绑定优先，未绑定时回落到旧的本地工作流路由。
 * RunningHub 档案不在这里校验存在性，由 Backend 执行器确认并给出可诊断错误。
 */
export function resolveWorkflowBindingForModel(
  aiConfig: unknown,
  model: string,
  referenceCount: number,
):
  | {
      ok: true;
      binding: WorkflowBinding;
      scenario: ModelInputScenario;
      params: Record<string, unknown>;
      channelId?: string;
    }
  | {
      ok: false;
      reason: "unsupported" | "no-workflow";
      scenario: ModelInputScenario;
      channelId?: string;
      modelName: string;
    } {
  const scenario = scenarioFromReferenceCount(referenceCount);
  const decoded = decodeChannelModel(String(model || ""));
  const found = findChannelModel(aiConfig, String(model || ""));
  const modelName = modelOptionName(String(model || ""));
  const channelId =
    decoded?.channelId || (found ? String(found.channel.id || "") : undefined);
  const params = found ? workflowParamsFor(found.model, scenario) : {};
  if (found) {
    const explicit = workflowBindingFor(found.model, scenario);
    if (explicit) return { ok: true, binding: explicit, scenario, channelId, params };
    const routed = String(
      asRecord(found.model.workflowRouting)[scenario] || "",
    ).trim();
    if (routed === WORKFLOW_ROUTE_UNSUPPORTED)
      return { ok: false, reason: "unsupported", scenario, channelId, modelName };
    if (routed)
      return {
        ok: true,
        binding: { provider: "comfyui", workflow: routed },
        scenario,
        channelId,
        params,
      };
    const workflows = asStringArray(found.model.workflows);
    if (workflows.length)
      return {
        ok: true,
        binding: { provider: "comfyui", workflow: workflows[0] },
        scenario,
        channelId,
        params,
      };
  }
  const builtin = builtinWorkflowName(model);
  if (builtin)
    return {
      ok: true,
      binding: { provider: "comfyui", workflow: builtin },
      scenario,
      channelId,
      params: {},
    };
  return { ok: false, reason: "no-workflow", scenario, channelId, modelName };
}

/** 模型是否把某个输入场景指向 RunningHub 工作流档案。 */
export function usesRunningHubBinding(
  aiConfig: unknown,
  model: string,
  referenceCount: number,
): boolean {
  const resolved = resolveWorkflowBindingForModel(
    aiConfig,
    model,
    referenceCount,
  );
  return resolved.ok && resolved.binding.provider === "runninghub";
}

export function workflowParamsFor(
  model: ChannelModel,
  scenario: ModelInputScenario,
): Record<string, unknown> {
  return { ...asRecord(asRecord(model.workflowParams)[scenario]) };
}

export function workflowResolutionMessage(
  result: Extract<WorkflowResolution, { ok: false }>,
): string {
  const scenario = { text: "文生图", single: "单图", multi: "多图" }[
    result.scenario
  ];
  return result.reason === "unsupported"
    ? `模型「${result.modelName}」不支持${scenario}输入，请改用其它模型或调整模型配置`
    : `模型「${result.modelName}」没有可用的本地实现，请到模型设置里完成配置`;
}

function modelsOf(channel: ModelChannel | undefined): ChannelModel[] {
  return Array.isArray(channel?.models) ? channel.models.filter(isRecord) : [];
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
