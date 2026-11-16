import type { SettingStore } from "../stores/types.js";

/**
 * 工作流「模型化」目录已退役。
 *
 * 以前画布把每个 ComfyUI 工作流收进 `local-comfyui` 渠道、当成一个可选模型，由画布进程
 * 自己执行工作流。现在执行统一交给 `comfyui2api` 引擎：引擎 `/v1/models` 就是模型清单，
 * 画布不再合成模型，也不再自动创建本地 ComfyUI 渠道（本地 ComfyUI 渠道已下线）。
 *
 * 保留同名方法只为不动路由的调用形状：它们不再读写 `ai.config` 里的模型列表。
 */

const AI_CONFIG_KEY = "ai.config";

type ChannelModel = {
  name: string;
  capability?: "image" | "video" | "text" | "audio";
  hidden?: boolean;
} & Record<string, unknown>;

type ModelChannel = {
  id: string;
  name: string;
  baseUrl: string;
  apiKey?: string;
  apiFormat: string;
  kind?: string;
  models: ChannelModel[];
} & Record<string, unknown>;

type AiConfig = Record<string, unknown> & { channels: ModelChannel[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** 只做结构归一，不增删渠道：渠道是用户的配置，画布不再往里塞东西。 */
function normalizeConfig(value: unknown): AiConfig {
  const source = isRecord(value) ? value : {};
  const channels = Array.isArray(source.channels)
    ? source.channels.filter(isRecord).map((channel) => ({
        ...channel,
        id: String(channel.id || ""),
        name: String(channel.name || ""),
        baseUrl: String(channel.baseUrl || ""),
        apiKey: typeof channel.apiKey === "string" ? channel.apiKey : "",
        apiFormat: String(channel.apiFormat || "openai"),
        kind: typeof channel.kind === "string" ? channel.kind : undefined,
        models: Array.isArray(channel.models)
          ? (channel.models.filter(isRecord).map((model) => ({ ...model })) as ChannelModel[])
          : [],
      }))
    : [];
  return { ...source, channels };
}

export class WorkflowModelCatalog {
  constructor(
    private readonly workflows: unknown,
    private readonly settings: Pick<SettingStore, "get" | "set">,
  ) {
    void this.workflows;
  }

  /** 启动/保存配置时的目录同步：没有工作流模型需要合成，直接回归一后的配置。 */
  async syncStoredConfig(): Promise<{ changed: boolean; added: string[] }> {
    return { changed: false, added: [] };
  }

  async syncConfig(value: unknown): Promise<{ config: AiConfig; changed: boolean; added: string[] }> {
    const stored = value === undefined ? this.settings.get(AI_CONFIG_KEY) : value;
    return { config: normalizeConfig(stored), changed: false, added: [] };
  }

  /** 导入工作流不再自动变成模型；模型清单由引擎 `/v1/models` 提供。 */
  async exposeImportedWorkflow(_name: string): Promise<{ changed: boolean; model?: string }> {
    return { changed: false };
  }

  /** 删除工作流不需要清理模型引用（画布侧已无工作流模型）。 */
  detachDeletedWorkflow(_name: string): boolean {
    return false;
  }
}
