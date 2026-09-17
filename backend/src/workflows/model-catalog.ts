import type { SettingStore } from "../stores/types.js";
import type { WorkflowDetail, WorkflowStore } from "./store.js";

const AI_CONFIG_KEY = "ai.config";
const PROCESSED_WORKFLOWS_KEY = "workflow.model-catalog.v1";

type ModelCapability = "image" | "video" | "text" | "audio";
type ChannelModel = {
  name: string;
  capability: ModelCapability;
  workflows?: string[];
  workflowRouting?: Partial<Record<"text" | "single" | "multi", string>>;
};
type ModelChannel = {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  apiFormat: string;
  kind?: string;
  models: ChannelModel[];
};
type AiConfig = Record<string, unknown> & { channels: ModelChannel[] };
type WorkflowReader = Pick<WorkflowStore, "list" | "get">;

/** 把工作流收进模型目录；工作流文件仍是内部执行资源，不再作为生成入口。 */
export class WorkflowModelCatalog {
  constructor(
    private readonly workflows: WorkflowReader,
    private readonly settings: Pick<SettingStore, "get" | "set">,
  ) {}

  async syncStoredConfig(): Promise<{ changed: boolean; added: string[] }> {
    const current = this.settings.get(AI_CONFIG_KEY);
    if (!isRecord(current)) return { changed: false, added: [] };
    const result = await this.syncConfig(current);
    if (result.changed) this.settings.set(AI_CONFIG_KEY, result.config);
    return { changed: result.changed, added: result.added };
  }

  async syncConfig(
    value: unknown,
  ): Promise<{ config: AiConfig; changed: boolean; added: string[] }> {
    const config = normalizeConfig(value);
    const items = await this.workflows.list();
    const processed = new Set(
      readStrings(this.settings.get(PROCESSED_WORKFLOWS_KEY)),
    );
    const channel = ensureLocalChannel(config);
    const added: string[] = [];
    let changed = false;
    for (const item of items) {
      const detail = await this.workflows.get(item.name);
      const rawModels = channel.models.filter(
        (model) => model.name === item.name,
      );
      let model = channel.models.find(
        (candidate) =>
          candidate.name !== item.name &&
          modelUsesWorkflow(candidate, item.name),
      );

      if (!model && rawModels.length) {
        model = rawModels[0];
        const oldName = model.name;
        const name = uniqueModelName(
          config.channels,
          preferredModelName(detail, item.title),
          model,
        );
        Object.assign(model, workflowModel(name, detail));
        replaceModelReferences(config, channel.id, oldName, name);
        changed = true;
      } else if (!model && !processed.has(item.name)) {
        const name = uniqueModelName(
          config.channels,
          preferredModelName(detail, item.title),
        );
        model = workflowModel(name, detail);
        channel.models.push(model);
        added.push(name);
        changed = true;
      }

      if (model && hasBrokenName(model.name)) {
        const oldName = model.name;
        const name = uniqueModelName(
          config.channels,
          workflowBaseName(item.name),
          model,
        );
        model.name = name;
        replaceModelReferences(config, channel.id, oldName, name);
        changed = true;
      }

      if (model) {
        for (const raw of rawModels) {
          if (raw === model) continue;
          replaceModelReferences(config, channel.id, raw.name, model.name);
          channel.models.splice(channel.models.indexOf(raw), 1);
          changed = true;
        }
      }
      processed.add(item.name);
    }
    this.settings.set(PROCESSED_WORKFLOWS_KEY, [...processed]);
    return { config, changed, added };
  }

  async exposeImportedWorkflow(
    name: string,
  ): Promise<{ changed: boolean; model?: string }> {
    const current = this.settings.get(AI_CONFIG_KEY);
    if (!isRecord(current)) return { changed: false };
    const config = normalizeConfig(current);
    const processed = new Set(
      readStrings(this.settings.get(PROCESSED_WORKFLOWS_KEY)),
    );
    const existing = findWorkflowModel(config.channels, name);
    if (existing) {
      processed.add(name);
      this.settings.set(PROCESSED_WORKFLOWS_KEY, [...processed]);
      return { changed: false, model: existing.name };
    }
    const detail = await this.workflows.get(name);
    const channel = ensureLocalChannel(config);
    const modelName = uniqueModelName(
      config.channels,
      detail.config.title || workflowBaseName(name),
    );
    channel.models.push(workflowModel(modelName, detail));
    processed.add(name);
    this.settings.set(PROCESSED_WORKFLOWS_KEY, [...processed]);
    this.settings.set(AI_CONFIG_KEY, config);
    return { changed: true, model: modelName };
  }
}

function workflowModel(name: string, detail: WorkflowDetail): ChannelModel {
  return {
    name,
    capability: capabilityOf(detail),
    workflows: [detail.name],
    workflowRouting: {
      text: detail.name,
      single: detail.name,
      multi: detail.name,
    },
  };
}

function capabilityOf(detail: WorkflowDetail): ModelCapability {
  const operation = String(detail.config.operation || "").toLowerCase();
  const fieldTypes = new Set(
    (detail.config.fields || []).map((field) => field.type),
  );
  if (operation.includes("video") || fieldTypes.has("video")) return "video";
  if (
    /(audio|tts|speech|voice|music)/.test(operation) ||
    fieldTypes.has("audio")
  )
    return "audio";
  if (/(text|chat|llm)/.test(operation)) return "text";
  return "image";
}

function ensureLocalChannel(config: AiConfig): ModelChannel {
  const existing = config.channels.find(
    (channel) => channel.kind === "comfyui",
  );
  if (existing) return existing;
  const channel: ModelChannel = {
    id: "local-comfyui",
    name: "本地 ComfyUI",
    baseUrl: "http://127.0.0.1:8188",
    apiKey: "",
    apiFormat: "openai",
    kind: "comfyui",
    models: [],
  };
  config.channels.push(channel);
  return channel;
}

function findWorkflowModel(channels: ModelChannel[], workflow: string) {
  return channels
    .flatMap((channel) => channel.models)
    .find((model) => modelUsesWorkflow(model, workflow));
}

function modelUsesWorkflow(model: ChannelModel, workflow: string) {
  return (
    model.workflows?.includes(workflow) ||
    Object.values(model.workflowRouting || {}).includes(workflow)
  );
}

function uniqueModelName(
  channels: ModelChannel[],
  preferred: string,
  ignored?: ChannelModel,
) {
  const names = new Set(
    channels.flatMap((channel) =>
      channel.models
        .filter((model) => model !== ignored)
        .map((model) => model.name),
    ),
  );
  const base = preferred.trim() || "本地模型";
  if (!names.has(base)) return base;
  let index = 2;
  while (names.has(`${base} ${index}`)) index++;
  return `${base} ${index}`;
}

function preferredModelName(detail: WorkflowDetail, itemTitle: string) {
  for (const value of [detail.config.title, itemTitle]) {
    const name = String(value || "").trim();
    if (name && !hasBrokenName(name)) return name;
  }
  return workflowBaseName(detail.name);
}

function hasBrokenName(name: string) {
  return name.includes("\uFFFD");
}

function replaceModelReferences(
  config: AiConfig,
  channelId: string,
  oldName: string,
  newName: string,
) {
  if (!oldName || oldName === newName) return;
  const replace = (value: unknown) => {
    if (value === oldName) return newName;
    if (value === `${channelId}::${oldName}`)
      return `${channelId}::${newName}`;
    return value;
  };
  for (const key of [
    "model",
    "imageModel",
    "videoModel",
    "textModel",
    "audioModel",
  ]) {
    config[key] = replace(config[key]);
  }
  if (Array.isArray(config.models)) {
    config.models = [...new Set(config.models.map(replace))];
  }
}

function normalizeConfig(value: unknown): AiConfig {
  const source = isRecord(value) ? value : {};
  const channels = Array.isArray(source.channels)
    ? source.channels.filter(isRecord).map((channel) => ({
        ...channel,
        id: String(channel.id || ""),
        name: String(channel.name || ""),
        baseUrl: String(channel.baseUrl || ""),
        apiKey: String(channel.apiKey || ""),
        apiFormat: String(channel.apiFormat || "openai"),
        kind: typeof channel.kind === "string" ? channel.kind : undefined,
        models: Array.isArray(channel.models)
          ? (channel.models
              .filter(isRecord)
              .map((model) => ({ ...model })) as ChannelModel[])
          : [],
      }))
    : [];
  return { ...source, channels };
}

function workflowBaseName(name: string) {
  return (
    name
      .split("/")
      .pop()
      ?.replace(/\.json$/i, "") || name
  );
}

function readStrings(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
