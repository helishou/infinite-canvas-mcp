import crypto from "node:crypto";
import sharp from "sharp";
import type { CanvasGenerationCommand } from "@basketikun/canvas-agent/generation-contract";
import { imageSlotStatus, imageSourceStatus } from "./image-result-slots.js";

import type { ResolvedConfig } from "../config.js";
import type { RuntimeTask, WorkflowConfig, WorkflowField } from "../db.js";
import type { ComfyUiBackend } from "../comfyui/bridge.js";
import type { RunningHubBackend } from "../runtime/runninghub.js";
import {
  DirectImageBackend,
  type ChatGptImageReference,
} from "../runtime/chatgpt-image.js";
import {
  builtinWorkflowName,
  decodeChannelModel,
  modelOptionName,
  resolveWorkflowBindingForModel,
  usesWorkflowExecutor,
  workflowResolutionMessage,
} from "./model-workflow.js";
import type { GenerationLogStore, Stores, TaskStore } from "../stores/types.js";
import type { WorkflowExecutor } from "../workflows/executor.js";
import type { WorkflowStore } from "../workflows/store.js";
import type { BackendEventBus } from "../events.js";
import {
  resolveCanvasExecutor,
  type CanvasExecutorId,
} from "./executor-registry.js";
import { prepareCanvasGenerationTarget } from "./generation-target.js";
import { commandFingerprint } from "./collaboration.js";
import { generationSettingsSnapshot, workflowGenerationSettingsSnapshot } from "./generation-settings.js";
import type { ProductionImageInput } from "@basketikun/canvas-agent/reference-contract";

export type CanvasImageReference = {
  id?: string;
  name?: string;
  dataUrl?: string;
  url?: string;
  storageKey?: string;
  mimeType?: string;
  sha256?: string;
};

export type CanvasImageGenerationInput = {
  projectId?: string;
  nodeId?: string;
  sourceNodeId?: string;
  segmentId?: string;
  maskEdit?: boolean;
  referenceNodeIds?: string[];
  model: string;
  prompt: string;
  references?: CanvasImageReference[];
  loopInputImages?: CanvasImageReference[];
  size?: string;
  width?: number;
  height?: number;
  quality?: string;
  count?: number;
  imageIds?: string[];
  loopOutput?: CanvasGenerationCommand["loopOutput"];
  params?: Record<string, unknown>;
  clientTaskId?: string;
  resultPolicy?: "replace-active" | "append";
};

type CanvasImageExecutionPlan = {
  executor: CanvasExecutorId;
  input: CanvasImageGenerationInput;
  workflow?: string;
  preset?: string;
  /** RunningHub 工作流档案 id；与 workflow 二选一，决定走云端还是本地执行器。 */
  runninghubProfileId?: string;
};

export type CanvasImageGenerationResult = {
  taskId: string;
  media: Array<{
    url: string;
    imageId?: string;
    storageKey?: string;
    mimeType: string;
    filename?: string;
    bytes?: number;
    width?: number | null;
    height?: number | null;
  }>;
  failure?: Error;
};

type DispatcherHooks = {
  onCompleted?: (
    result: CanvasImageGenerationResult,
    task: RuntimeTask,
  ) => Promise<void> | void;
  onFailed?: (error: Error, task: RuntimeTask) => Promise<void> | void;
};

/**
 * 画布唯一的图片生成入口。
 * 前端按钮和 MCP 都只负责提交这个标准请求，模型差异留在这里处理。
 */
export class CanvasImageDispatcher {
  private readonly childTasks = new Map<string, Set<string>>();
  constructor(
    private readonly config: ResolvedConfig,
    private readonly stores: Stores,
    private readonly comfy: ComfyUiBackend,
    private readonly directImage: DirectImageBackend,
    private readonly workflows: WorkflowStore,
    private readonly workflowExecutor: WorkflowExecutor,
    private readonly events?: BackendEventBus,
    /** 可选注入：未配置 RunningHub 时该能力整体不可用，不影响本地执行器。 */
    private readonly runningHub?: RunningHubBackend,
  ) {}

  private get logs(): GenerationLogStore {
    return this.stores.logs;
  }

  start(input: CanvasImageGenerationInput, hooks?: DispatcherHooks) {
    let plan = this.plan(this.prepareFrozenReferences(this.prepareReferences(input)));
    const taskId = plan.input.clientTaskId || `canvas-${crypto.randomUUID()}`;
    const existing = this.stores.tasks.get(taskId);
    if (existing)
      return { taskId: existing.id, logId: undefined, executor: plan.executor };
    const active = this.findActiveTask(plan.input);
    if (active)
      return {
        taskId: active.id,
        logId: undefined,
        executor: active.executor || plan.executor,
      };
    const prepared = prepareCanvasGenerationTarget(this.stores, { ...plan.input, mode: "image" }, taskId);
    plan = { ...plan, input: prepared.command as CanvasImageGenerationInput };
    const normalized = plan.input;
    const project = prepared.project;
    const persistedReferences =
      normalized.references?.map((reference) => ({
        id: reference.id,
        name: reference.name,
        dataUrl: reference.dataUrl,
        storageKey: reference.storageKey,
        url: reference.url,
        mimeType: reference.mimeType,
        sha256: reference.sha256,
      })) || [];
    const task = this.stores.tasks.create(
      taskId,
      "canvas-image",
      {
        ...normalized,
        clientTaskId: undefined,
        references: persistedReferences,
      },
      {
        projectId: normalized.projectId,
        nodeId: normalized.nodeId,
        executor: plan.executor,
        model: normalized.model,
        size:
          normalized.size ||
          `${normalized.width || 1024}x${normalized.height || 1024}`,
        quality: normalized.quality || "auto",
        count: Math.max(1, Math.min(4, Math.floor(normalized.count || 1))),
        resultPolicy: normalized.resultPolicy || "replace-active",
        imageTargetSize: normalized.imageIds && prepared.targetSize ? prepared.targetSize : undefined,
      },
    );
    try {
      if (project) this.stores.projects.applyOperations(normalized.projectId!, Number(project.revision || 0), [...prepared.createOperations, {
        type: "update_node", id: normalized.nodeId!,
        metadata: { runtimeTaskId: task.id, status: "loading", runProgress: 0,
          ...(prepared.createOperations.length ? {} : imageSlotStatus(project, normalized.nodeId!, normalized.imageIds, "loading")) },
        metadataDelete: ["errorDetails"],
      }, ...(normalized.loopOutput ? [] : imageSourceStatus(project, normalized.nodeId!, normalized.sourceNodeId, task.id, "loading", true))], { operationId: `image-task-bind:${task.id}`, runtimeWrite: true, source: { clientId: `task:${task.id}`, kind: "task", label: "图片生成任务" } });
    } catch (error) {
      this.stores.tasks.update(task.id, { status: "failed", error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
    // 画布生成日志：开始（running）+ 成功/失败。仅当调用方传入 projectId 时才记录。
    const currentWorkflowFields = plan.workflow ? this.workflows.getConfig?.(plan.workflow)?.fields || [] : [];
    const currentWorkflowFieldIds = new Set(currentWorkflowFields.map((field) => field.id));
    const staleWorkflowFieldIds = plan.executor === "comfy-workflow"
      ? Object.keys(normalized.params || {}).filter((key) => key.startsWith("f_") && !currentWorkflowFieldIds.has(key))
      : [];
    const historicalWorkflowFields = staleWorkflowFieldIds.length
      ? this.workflows.getFieldDefinitionsByIds?.(staleWorkflowFieldIds) || []
      : [];
    const workflowFields = [...currentWorkflowFields, ...historicalWorkflowFields];
    const logId = normalized.projectId
      ? this.logs.create({
          projectId: normalized.projectId,
          nodeId: normalized.nodeId,
          status: "running",
          platform: "canvas-image",
          workflow: plan.workflow || "",
          model: normalized.model,
          taskMode: executionImageInputs(normalized).length ? "i2i" : "t2i",
          prompt: normalized.prompt,
          references:
            normalized.references?.map((reference) => ({
              name: reference.name,
              mimeType: reference.mimeType,
              storageKey: reference.storageKey,
            })) || [],
          inputCounts: {
            references: normalized.references?.length || 0,
            loopInputs: normalized.loopInputImages?.length || 0,
            count: Math.max(1, Math.min(4, Math.floor(normalized.count || 1))),
          },
          runtimeTaskId: task.id,
          startedAt: new Date().toISOString(),
          durationMs: 0,
          outputs: [],
          params: {
            size:
              normalized.size ||
              `${normalized.width || 1024}x${normalized.height || 1024}`,
            quality: normalized.quality || "auto",
            generationSettings: plan.executor === "comfy-workflow"
              ? workflowGenerationSettingsSnapshot(normalized.params, workflowFields)
              : generationSettingsSnapshot(normalized.params, {
                  size: normalized.size || `${normalized.width || 1024}x${normalized.height || 1024}`,
                  ...(normalized.width ? { width: normalized.width } : {}),
                  ...(normalized.height ? { height: normalized.height } : {}),
                  quality: normalized.quality || "auto",
                  count: Math.max(1, Math.min(4, Math.floor(normalized.count || 1))),
                  executor: plan.executor,
                }, workflowFields),
            ...(normalized.loopInputImages?.length ? { loopInputImages: normalized.loopInputImages.map((image) => ({ name: image.name, mimeType: image.mimeType, storageKey: image.storageKey, url: image.url })) } : {}),
          },
        }).id
      : null;
    const startedAt = Date.now();
    const effectiveHooks =
      hooks ||
      (normalized.projectId && normalized.nodeId
        ? this.canvasHooks(normalized)
        : undefined);
    void this.execute(
      { ...plan, input: { ...normalized, clientTaskId: taskId } },
      task,
      effectiveHooks,
      logId,
      startedAt,
    ).catch(async (error) => {
      const failure = error instanceof Error ? error : new Error(String(error));
      const current = this.stores.tasks.get(task.id);
      if (current?.status === "cancelled") return;
      if (current && current.status !== "failed") {
        this.stores.tasks.update(task.id, {
          status: "failed",
          error: failure.message,
        });
      }
      if (logId) {
        this.logs.update(logId, {
          status: "failed",
          error: failure.message,
          finishedAt: new Date().toISOString(),
          durationMs: Date.now() - startedAt,
        });
      }
      await effectiveHooks?.onFailed?.(
        failure,
        this.stores.tasks.get(task.id) || task,
      );
    });
    return { taskId: task.id, logId, executor: plan.executor };
  }

  /**
   * 任务只持有媒体句柄，不持有整张 base64 图片。
   * 外部调用方若只给 dataUrl，在进入任务队列前一次性落到 Backend 媒体库。
   */
  private prepareReferences(
    input: CanvasImageGenerationInput,
  ): CanvasImageGenerationInput {
    if (!input.references?.length && !input.loopInputImages?.length) return input;
    const prepare = (reference: CanvasImageReference) => {
      if (
        reference.storageKey &&
        this.stores.media.meta(reference.storageKey)
      ) {
        return stripReferencePayload(reference);
      }
      // URL 是 Backend 可解析的媒体句柄，也不应再复制成 dataUrl。
      if (!reference.dataUrl && reference.url)
        return stripReferencePayload(reference);
      const match = /^data:([^;,]+);base64,(.+)$/s.exec(
        String(reference.dataUrl || ""),
      );
      if (!match)
        throw new Error(
          `参考图缺少 Backend 媒体句柄：${reference.name || reference.id || "未命名图片"}`,
        );
      const stored = this.stores.media.store(Buffer.from(match[2], "base64"), {
        name: reference.name || "reference.png",
        mimeType: reference.mimeType || match[1] || "image/png",
        category: "input",
      });
      return stripReferencePayload({
        ...reference,
        storageKey: stored.storageKey,
        url: this.stores.media.url(stored),
        mimeType: reference.mimeType || stored.mimeType,
      });
    };
    return {
      ...input,
      ...(input.references ? { references: input.references.map(prepare) } : {}),
      ...(input.loopInputImages ? { loopInputImages: input.loopInputImages.map(prepare) } : {}),
    };
  }

  private findActiveTask(input: CanvasImageGenerationInput) {
    if (!input.projectId || (!input.sourceNodeId && !input.nodeId)) return null;
    const sourceNodeId = input.sourceNodeId || input.nodeId;
    const fingerprint = commandFingerprint({
      sourceNodeId,
      model: input.model,
      prompt: input.prompt,
      size: input.size,
      width: input.width,
      height: input.height,
      quality: input.quality,
      count: input.count,
      imageIds: input.imageIds,
      loopOutput: input.loopOutput,
      references: input.references,
      loopInputImages: input.loopInputImages,
      params: input.params,
      referenceNodeIds: input.referenceNodeIds,
      maskEdit: input.maskEdit,
    });
    for (const status of ["running", "queued"] as const) {
      const active = this.stores.tasks.list({ kind: "canvas-image", status, projectId: input.projectId, limit: 500 }).find((task) => {
        const current = task.input as CanvasImageGenerationInput;
        const currentSource = current.sourceNodeId || current.nodeId;
        if (currentSource !== sourceNodeId) return false;
        return commandFingerprint({
          sourceNodeId: currentSource,
          model: current.model,
          prompt: current.prompt,
          size: current.size,
          width: current.width,
          height: current.height,
          quality: current.quality,
          count: current.count,
          imageIds: current.imageIds,
          loopOutput: current.loopOutput,
          references: current.references,
          loopInputImages: current.loopInputImages,
          params: current.params,
          referenceNodeIds: current.referenceNodeIds,
          maskEdit: current.maskEdit,
        }) === fingerprint;
      });
      if (active) return active;
    }
    return null;
  }

  async retry(task: RuntimeTask) {
    if (task.kind !== "canvas-image")
      throw new Error(`任务类型 ${task.kind} 不是画布图片任务`);
    const previous = task.input as CanvasImageGenerationInput;
    const input = {
      ...previous,
      ...(previous.loopOutput ? { nodeId: previous.sourceNodeId, imageIds: undefined } : {}),
      clientTaskId: `canvas-retry-${crypto.randomUUID()}`,
    };
    const result = this.start(input);
    const retried = this.stores.tasks.get(result.taskId);
    if (!retried) throw new Error("重试任务创建失败");
    this.stores.tasks.addEvent(retried.id, "retry", { parentTaskId: task.id });
    return retried;
  }

  /** Backend 重启后恢复外层画布图片任务；子执行器按固定 childTaskId 复用已有任务。 */
  resume(task: RuntimeTask) {
    if (
      task.kind !== "canvas-image" ||
      !["queued", "running"].includes(task.status)
    )
      return;
    const input = task.input as CanvasImageGenerationInput;
    let plan: CanvasImageExecutionPlan;
    try {
      const project = this.canvasTarget(input);
      const node = project && (project.nodes as Array<Record<string, unknown>>).find((node) => node.id === input.nodeId);
      if (project && (node?.metadata as Record<string, unknown> | undefined)?.runtimeTaskId !== task.id) throw new Error("图片任务已失去节点绑定，不恢复旧任务");
      plan = this.plan(input);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.stores.tasks.update(task.id, {
        status: "failed",
        error: message,
      });
      if (input.projectId && input.nodeId) this.stores.projects.markCanvasImageTaskFailed(task, { projectId: input.projectId, nodeId: input.nodeId }, message);
      return;
    }
    const log = this.logs.list({ runtimeTaskId: task.id, limit: 1 })[0];
    const hooks =
      plan.input.projectId && plan.input.nodeId
        ? this.canvasHooks(plan.input)
        : undefined;
    void this.execute(
      plan,
      task,
      hooks,
      log?.id || null,
      Date.parse(task.createdAt) || Date.now(),
    ).catch(async (error) => {
      const failure = error instanceof Error ? error : new Error(String(error));
      if (this.stores.tasks.get(task.id)?.status === "cancelled") return;
      const current = this.stores.tasks.get(task.id);
      if (
        current &&
        current.status !== "failed" &&
        current.status !== "cancelled"
      )
        this.stores.tasks.update(task.id, {
          status: "failed",
          error: failure.message,
        });
      await hooks?.onFailed?.(failure, this.stores.tasks.get(task.id) || task);
    });
  }

  private async execute(
    plan: CanvasImageExecutionPlan,
    task: RuntimeTask,
    hooks?: DispatcherHooks,
    logId: string | null = null,
    startedAt = Date.now(),
  ) {
    this.stores.tasks.update(task.id, { status: "running", progress: 0.02 });
    const result = await this.dispatch(plan, task.id);
    if (this.stores.tasks.get(task.id)?.status === "cancelled") return;
    let aspectFailure: Error | undefined;
    if (plan.executor === "comfy-workflow") {
      const expectedRatio = requestedImageRatio(plan.input);
      for (const media of result.media) {
        try {
          if (!media.storageKey) throw new Error("结果缺少归档 storageKey");
          const actual = await sharp(await this.stores.media.read(media.storageKey)).metadata();
          media.width = actual.width ?? null;
          media.height = actual.height ?? null;
          if (expectedRatio !== null && (!actual.width || !actual.height || Math.abs(actual.width / actual.height - expectedRatio) >= 0.01)) {
            throw new Error(`目标 ${plan.input.width && plan.input.height ? `${plan.input.width}×${plan.input.height}` : plan.input.size}，实际 ${actual.width || "?"}×${actual.height || "?"}`);
          }
        } catch (error) {
          aspectFailure = new Error(`工作流输出画幅未通过验收：${error instanceof Error ? error.message : String(error)}；已归档媒体未绑定为正式结果`);
          break;
        }
      }
    }
    if (aspectFailure) {
      this.stores.tasks.update(task.id, { status: "failed", error: aspectFailure.message, result: { media: result.media } });
      this.stores.tasks.addEvent(task.id, "result", { media: result.media, partial: true, error: aspectFailure.message });
      if (logId) this.logs.update(logId, { status: "failed", error: aspectFailure.message,
        outputs: result.media.map((media) => ({ url: media.url, storageKey: media.storageKey, mimeType: media.mimeType, width: media.width, height: media.height })),
        finishedAt: new Date().toISOString(), durationMs: Date.now() - startedAt });
      await hooks?.onFailed?.(aspectFailure, this.stores.tasks.get(task.id) || task);
      return;
    }
    await hooks?.onCompleted?.(result, { ...task, status: "succeeded", progress: 1, result: { media: result.media } });
    if (this.stores.tasks.get(task.id)?.status === "cancelled") return;
    if (result.failure) {
      this.stores.tasks.update(task.id, { status: "failed", error: result.failure.message });
      this.stores.tasks.addEvent(task.id, "result", { media: result.media, partial: true, error: result.failure.message });
      if (logId) this.logs.update(logId, {
        status: "failed", error: result.failure.message,
        outputs: result.media.map((media) => ({ url: media.url, storageKey: media.storageKey, mimeType: media.mimeType })),
        finishedAt: new Date().toISOString(), durationMs: Date.now() - startedAt,
      });
      return;
    }
    this.stores.tasks.update(task.id, {
      status: "succeeded",
      progress: 1,
      result: { media: result.media },
    });
    this.stores.tasks.addEvent(task.id, "result", { media: result.media });
    if (logId) {
      this.logs.update(logId, {
        status: "success",
        outputs: result.media.map((media) => ({
          url: media.url,
          storageKey: media.storageKey,
          mimeType: media.mimeType,
          width: media.width,
          height: media.height,
        })),
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
      });
    }
  }

  private canvasTarget(input: CanvasImageGenerationInput) {
    if (!input.nodeId) return null; // 仅带 projectId 的请求仍可用于日志归属，不绑定节点。
    if (!input.projectId) throw new Error("画布图片任务指定 nodeId 时必须提供 projectId");
    const project = this.stores.projects.get(input.projectId);
    if (!project || !Array.isArray(project.nodes) || !project.nodes.some((node) => (node as Record<string, unknown>).id === input.nodeId)) throw new Error("画布图片生成目标不存在，未启动模型");
    if (input.imageIds) {
      const node = project.nodes.find((node) => (node as Record<string, unknown>).id === input.nodeId) as Record<string, any>;
      const isSmartGenerationNode = node.type === "config" && node.metadata?.smart === true;
      if ((!isSmartGenerationNode && node.type !== "image") || input.imageIds.length !== Math.max(1, Math.min(4, Math.floor(input.count || 1)))
        || new Set(input.imageIds).size !== input.imageIds.length
        || input.imageIds.some((id) => !node.metadata?.images?.some((image: { id: string }) => image.id === id))) {
        throw new Error("图片结果槽与生成数量或目标节点不匹配，未启动模型");
      }
    }
    return project;
  }

  /** Saved node workflow fields are authoritative defaults when a caller omits them. */
  private canvasComfyParams(input: CanvasImageGenerationInput): Record<string, unknown> {
    if (!input.projectId) return {};
    const project = this.stores.projects.get(input.projectId);
    if (!project) return {};
    const nodes = Array.isArray(project.nodes) ? project.nodes as Array<Record<string, unknown>> : [];
    const nodeIds = [input.sourceNodeId, input.nodeId].filter((id): id is string => Boolean(id));
    for (const nodeId of nodeIds) {
      const node = nodes.find((candidate) => String(candidate.id || "") === nodeId);
      const metadata = node?.metadata;
      if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) continue;
      const params = (metadata as Record<string, unknown>).comfyParams;
      if (params && typeof params === "object" && !Array.isArray(params) && Object.keys(params).length) {
        return params as Record<string, unknown>;
      }
    }
    return {};
  }

  private plan(input: CanvasImageGenerationInput): CanvasImageExecutionPlan {
    const selectedModel = String(input.model || "").trim();
    const model = modelOptionName(selectedModel).trim();
    if (!model) throw new Error("画布图片生成缺少模型");
    const aiConfig = this.stores.settings.get("ai.config");
    const channelId = decodeChannelModel(selectedModel)?.channelId;
    const params = {
      ...(channelId ? { channelId } : {}),
      ...(input.params || {}),
    };
    const normalized = {
      ...input,
      model,
      ...(Object.keys(params).length ? { params } : {}),
    };
    if (usesWorkflowExecutor(aiConfig, selectedModel)) {
      const resolved = resolveWorkflowBindingForModel(
        aiConfig,
        selectedModel,
        executionImageInputs(input).length,
      );
      if (!resolved.ok)
        throw new Error(
          `${workflowResolutionMessage(resolved)}（模型=${input.model}）`,
        );
      if (resolved.binding.provider === "runninghub") {
        if (!this.runningHub)
          throw new Error(
            `模型「${input.model}」绑定了 RunningHub 工作流，但当前 Backend 未初始化 RunningHub 执行器`,
          );
        return {
          executor: "runninghub-workflow",
          input: { ...normalized, params: { ...resolved.params, ...params } },
          runninghubProfileId: resolved.binding.profileId,
        };
      }
      const planInput = {
        ...normalized,
        params: { ...resolved.params, ...this.canvasComfyParams(input), ...params },
      };
      return {
        executor: "comfy-workflow",
        input: planInput,
        workflow: resolved.binding.workflow,
      };
    }

    const executor = resolveCanvasExecutor(
      { mode: "image", model },
      this.directImage.supports(model),
    );
    if (executor === "direct-image") return { executor, input: normalized };

    const preset = builtinPreset(model);
    if (executor === "builtin-comfy" && preset) {
      if (preset === "flux2-klein" && !executionImageInputs(input).length)
        throw new Error("Flux2-Klein 至少需要一张参考图");
      return { executor, input: normalized, preset };
    }

    const workflow = builtinWorkflowName(model);
    if (executor === "comfy-workflow" && workflow) {
      const savedParams = this.canvasComfyParams(input);
      const workflowInput = Object.keys(savedParams).length
        ? { ...normalized, params: { ...savedParams, ...params } }
        : normalized;
      return { executor, input: workflowInput, workflow };
    }
    throw new Error(`画布图片执行计划不完整：${model}`);
  }

  private async dispatch(
    plan: CanvasImageExecutionPlan,
    taskId: string,
  ): Promise<CanvasImageGenerationResult> {
    plan = { ...plan, input: this.prepareFrozenReferences(plan.input) };
    if (plan.executor === "direct-image")
      return this.dispatchDirect(plan.input, taskId);
    const count = Math.max(1, Math.min(4, Math.floor(plan.input.count || 1)));
    // 保持网页原有批量并发语义，但所有子任务归属同一父任务，取消覆盖整批。
    const results = await Promise.allSettled(Array.from({ length: count }, async (_, index) => {
      const suffix = count > 1 ? `-${index}` : "";
      const result = plan.executor === "builtin-comfy" && plan.preset
        ? await this.dispatchBuiltin(plan.input, taskId, plan.preset, suffix)
        : plan.executor === "runninghub-workflow" && plan.runninghubProfileId
          ? await this.dispatchRunningHub(plan.input, taskId, plan.runninghubProfileId, suffix)
          : plan.executor === "comfy-workflow" && plan.workflow
            ? await this.dispatchWorkflow(plan.input, taskId, plan.workflow, suffix)
            : (() => { throw new Error(`画布图片执行计划不完整：${plan.input.model}`); })();
      return result.media.map((media) => ({ ...media, ...(plan.input.imageIds ? { imageId: plan.input.imageIds[index] } : {}) }));
    }));
    const rejected = results.filter((result) => result.status === "rejected");
    if (rejected.length === count) throw rejected[0].status === "rejected" ? rejected[0].reason : new Error("图片批量生成全部失败");
    const media = results.flatMap((result) => result.status === "fulfilled" ? result.value : []);
    const failure = rejected.length
      ? new Error(rejected.map((result) => result.status === "rejected" ? String(result.reason) : "").filter(Boolean).join("；"))
      : media.length === count ? undefined : new Error(`图片批量生成只返回了 ${media.length}/${count} 张结果`);
    return { taskId, media, ...(failure ? { failure } : {}) };
  }

  private async dispatchDirect(
    input: CanvasImageGenerationInput,
    taskId: string,
  ) {
    const references = await Promise.all(
      executionImageInputs(input).map(async (reference) =>
        this.readReference(await this.modelReference(reference, taskId)),
      ),
    );
    const childTaskId = `image-child-${taskId}`;
    this.assertNotCancelled(taskId);
    this.trackChild(taskId, childTaskId);
    const provider = configuredProvider(
      this.stores.settings.get("ai.config"),
      input.params?.channelId,
    );
    try {
    const task = this.directImage.run(
      {
        model: input.model,
        prompt: input.prompt,
        size: input.size || sizeFromDimensions(input.width, input.height),
        quality: input.quality,
        count: input.count,
        references,
        apiUrl: provider?.baseUrl,
        authKey: provider?.apiKey,
      },
      undefined,
      childTaskId,
      {
        parentTaskId: taskId,
        projectId: input.projectId,
        nodeId: input.nodeId,
      },
    );
      const completed = await waitForTask(this.stores.tasks, task.id);
      return { taskId, media: mediaFromTask(completed) };
    } finally {
      this.untrackChild(taskId, childTaskId);
    }
  }

  cancel(id: string) {
    const childIds = [...(this.childTasks.get(id) || [])];
    for (const childId of childIds) {
      try {
        this.directImage.cancel(childId);
      } catch {
        /* 外层任务仍以取消为准 */
      }
      try {
        this.workflowExecutor.cancel(childId);
      } catch {
        /* 子任务可能尚未创建 */
      }
      try {
        this.comfy.cancel(childId);
      } catch {
        /* 子任务可能已经结束 */
      }
      try {
        // RunningHub 子任务是远端任务，必须显式取消，否则云端仍会跑完并计费。
        this.runningHub?.cancel(childId);
      } catch {
        /* 子任务可能已经结束 */
      }
    }
    const task = this.stores.tasks.get(id);
    if (!task || !["queued", "running"].includes(task.status))
      throw new Error(`任务状态 ${task?.status || "unknown"} 不可取消`);
    const updated = this.stores.tasks.cancel(id);
    this.stores.tasks.addEvent(id, "cancelled", {
      taskId: id,
      childTaskIds: childIds,
    });
    const input = task.input as CanvasImageGenerationInput;
    if (input.projectId && input.nodeId) this.stores.projects.markCanvasImageTaskFailed(updated, { projectId: input.projectId, nodeId: input.nodeId }, "");
    const log = this.logs.list({ runtimeTaskId: id, limit: 1 })[0];
    if (log) this.logs.update(log.id, { status: "cancelled", finishedAt: new Date().toISOString(), durationMs: Date.now() - Date.parse(task.createdAt) });
    return updated;
  }

  private async dispatchBuiltin(
    input: CanvasImageGenerationInput,
    taskId: string,
    preset: string,
    suffix = "",
  ) {
    const references = await Promise.all(
      executionImageInputs(input).map(async (reference) =>
        this.materializeReference(await this.modelReference(reference, taskId)),
      ),
    );
    const childTaskId = `comfy-child-${taskId}${suffix}`;
    this.assertNotCancelled(taskId);
    this.trackChild(taskId, childTaskId);
    try {
    const task = await this.comfy.run(
      preset,
      {
        prompt: input.prompt,
        references: references.map((reference) => reference.filePath),
      },
      {
        width: input.width,
        height: input.height,
        size: input.size,
        ...(input.params || {}),
        parentTaskId: taskId,
        projectId: input.projectId,
        nodeId: input.nodeId,
        model: input.model,
      },
      undefined,
      childTaskId,
    );
      const completed = await waitForTask(this.stores.tasks, task.id);
      return { taskId, media: mediaFromTask(completed) };
    } finally {
      this.untrackChild(taskId, childTaskId);
    }
  }

  private async dispatchWorkflow(
    input: CanvasImageGenerationInput,
    taskId: string,
    workflowName: string,
    suffix = "",
  ) {
    const detail = await this.workflows.get(workflowName);
    const fields = detail.config?.fields || [];
    const fieldValues: Record<string, unknown> = { ...(input.params || {}) };
    if (input.prompt?.trim() && !fields.some(field => field.type === "text" && (field.isPrompt || field.id.toLowerCase() === "prompt"))) {
      throw new Error(`工作流 ${workflowName} 未配置提示词入口；请将实际正向提示词字段标记为 isPrompt，不能使用模板残留正文执行本次请求`);
    }
    const dimensions = requestedImageDimensions(input);
    const expectedRatio = requestedImageRatio(input);
    for (const field of fields) {
      if (
        field.type === "text" &&
        (field.isPrompt || field.id.toLowerCase() === "prompt")
      )
        fieldValues[field.id] = input.prompt;
      if (field.input === "width" || field.input === "height") {
        const value = field.input === "width" ? dimensions?.width : dimensions?.height;
        if (value && fieldValues[field.id] !== undefined && Number(fieldValues[field.id]) !== value) throw new Error(`工作流字段「${field.name || field.input}」与目标尺寸冲突：已保存 ${fieldValues[field.id]}，目标 ${value}；请先修改工作流参数`);
        if (value && fieldValues[field.id] === undefined) fieldValues[field.id] = value;
      }
      if (field.input === "aspect_ratio" && field.type === "dropdown" && expectedRatio !== null) {
        const explicit = fieldValues[field.id];
        if (explicit !== undefined) {
          const selected = imageRatioFromText(String(explicit));
          if (selected === null || Math.abs(selected - expectedRatio) >= 0.01) throw new Error(`工作流画幅与目标冲突：已保存「${explicit}」，目标「${input.size || `${input.width}x${input.height}`}」；请先修改工作流参数`);
          if (!field.options?.includes(String(explicit))) {
            const mapped = field.options?.find((option) => {
              const ratio = imageRatioFromText(option);
              return ratio !== null && Math.abs(ratio - expectedRatio) < 0.01;
            });
            if (!mapped) throw new Error(`工作流画幅字段「${field.name || field.input}」没有合法的目标选项；不能回退到默认比例`);
            fieldValues[field.id] = mapped;
          }
        } else {
          const option = field.options?.find((value) => {
            const match = /^(\d+)\s*:\s*(\d+)/.exec(value);
            return match && Math.abs(Number(match[1]) / Number(match[2]) - expectedRatio) < 0.01;
          });
          if (!option) throw new Error(`工作流画幅选项不支持目标「${input.size || `${input.width}x${input.height}`}」；请配置对应 aspect_ratio 选项`);
          fieldValues[field.id] = option;
        }
      }
    }
    for (const field of fields.filter((field) => ["aspect_ratio", "width", "height"].includes(field.input))) {
      if (fieldValues[field.id] === undefined) continue;
      for (const nodeId of field.node.split(",")) {
        const node = detail.workflow[nodeId.trim()] as { inputs?: Record<string, unknown> } | undefined;
        if (!node?.inputs || !(field.input in node.inputs)) throw new Error(`工作流尺寸字段「${field.name || field.input}」未连接到真实节点输入 ${nodeId}.${field.input}`);
      }
    }

    const imageFields = fields.filter((field) =>
      isImageField(field, detail.workflow),
    );
    const references = executionImageInputs(input);
    if (references.length > imageFields.length) {
      throw new Error(`工作流「${workflowName}」只有 ${imageFields.length} 个图片输入槽，本轮需要 ${references.length} 张（${input.loopInputImages?.length || 0} 张循环图 + ${input.references?.length || 0} 张固定参考图）；请配置支持三图的工作流或调整参考输入`);
    }
    for (let index = 0; index < imageFields.length; index++) {
      const field = imageFields[index];
      const reference = references[index];
      fieldValues[field.id] = reference
        ? await this.referenceDataUrl(await this.modelReference(reference, taskId))
        : null;
    }

    const workflow =
      input.maskEdit && references.length >= 2
        ? maskReferenceWorkflow(detail.workflow, imageFields[1]?.node) || detail.workflow
        : detail.workflow;
    const executableWorkflow = adaptFlux2KleinWorkflow(workflow, input.model);

    const childTaskId = `workflow-child-${taskId}${suffix}`;
    this.assertNotCancelled(taskId);
    this.trackChild(taskId, childTaskId);
    try {
      const result = await this.workflowExecutor.run(
        executableWorkflow,
        detail.config || emptyWorkflowConfig(workflowName),
        fieldValues,
        crypto.randomUUID(),
        undefined,
        workflowName,
        childTaskId,
        input.projectId,
        input.nodeId,
        taskId,
      );
      return { taskId, media: result.media };
    } finally {
      this.untrackChild(taskId, childTaskId);
    }
  }

  /**
   * RunningHub 图片：档案自带字段映射，这里只把画布输入翻译成平台输入。
   * 平台调用、任务状态、媒体归档都由 RunningHubBackend 负责，本方法不碰 HTTP。
   */
  private async dispatchRunningHub(
    input: CanvasImageGenerationInput,
    taskId: string,
    profileId: string,
    suffix = "",
  ) {
    const runningHub = this.runningHub;
    if (!runningHub) throw new Error("Backend 未初始化 RunningHub 执行器，无法运行绑定的 RunningHub 工作流");
    const references = executionImageInputs(input);
    const values: Record<string, unknown> = { ...(input.params || {}) };
    const childTaskId = `runninghub-child-${taskId}${suffix}`;
    this.assertNotCancelled(taskId);
    this.trackChild(taskId, childTaskId);
    try {
      const task = await runningHub.runWorkflow(
        profileId,
        { prompt: input.prompt, references, loopInputImages: input.loopInputImages },
        values,
        {
          parentTaskId: taskId,
          projectId: input.projectId,
          nodeId: input.nodeId,
          model: input.model,
          ...(input.width && input.height ? { width: input.width, height: input.height } : {}),
          ...(input.size ? { size: input.size } : {}),
          ...(input.count ? { count: input.count } : {}),
        },
        childTaskId,
      );
      const completed = await waitForTask(this.stores.tasks, task.id);
      return { taskId, media: mediaFromTask(completed) };
    } finally {
      this.untrackChild(taskId, childTaskId);
    }
  }

  private async referenceDataUrl(reference: CanvasImageReference) {
    if (reference.dataUrl) return reference.dataUrl;
    const { data, mimeType } = await this.readReference(reference);
    return `data:${mimeType};base64,${data.toString("base64")}`;
  }

  private async modelReference(reference: CanvasImageReference, taskId: string): Promise<CanvasImageReference> {
    const mimeType = this.stores.media.meta(reference.storageKey || "")?.mimeType || reference.mimeType || mimeFromName(reference.name);
    if (mimeType !== "image/svg+xml") return reference;
    const source = await this.readReferenceBuffer(reference);
    const storageKey = `image:svg-png-${crypto.createHash("sha256").update(source).digest("hex")}`;
    let media = this.stores.media.meta(storageKey);
    if (!media) {
      const data = await sharp(source).png().toBuffer();
      media = this.stores.media.store(data, { name: `${reference.name || "reference"}.png`, mimeType: "image/png", category: "input", storageKey });
    }
    this.stores.tasks.addEvent(taskId, "reference_rasterized", { sourceStorageKey: reference.storageKey, sourceName: reference.name, submittedStorageKey: storageKey, mimeType: "image/png" });
    return { ...reference, name: `${reference.name || "reference"}.png`, storageKey, url: this.stores.media.url(media), mimeType: "image/png", dataUrl: undefined, sha256: undefined };
  }

  private assertNotCancelled(taskId: string) {
    if (this.stores.tasks.get(taskId)?.status === "cancelled") throw new Error("图片任务已取消，未启动子执行器");
  }

  private trackChild(taskId: string, childId: string) {
    const children = this.childTasks.get(taskId) || new Set<string>();
    children.add(childId);
    this.childTasks.set(taskId, children);
  }

  private untrackChild(taskId: string, childId: string) {
    const children = this.childTasks.get(taskId);
    children?.delete(childId);
    if (!children?.size) this.childTasks.delete(taskId);
  }

  private async readReference(
    reference: CanvasImageReference,
  ): Promise<ChatGptImageReference> {
    const data = await this.readReferenceBuffer(reference);
    return {
      data,
      mimeType:
        reference.mimeType || mimeFromName(reference.name) || "image/png",
      name: reference.name || "reference.png",
    };
  }

  private async materializeReference(reference: CanvasImageReference) {
    if (reference.storageKey) {
      const media = this.stores.media.meta(reference.storageKey);
      if (media) {
        if (reference.sha256) await this.readReferenceBuffer(reference);
        return media;
      }
    }
    const data = await this.readReferenceBuffer(reference);
    return this.stores.media.store(data, {
      name: reference.name || "reference.png",
      mimeType:
        reference.mimeType || mimeFromName(reference.name) || "image/png",
      category: "input",
    });
  }

  private async readReferenceBuffer(reference: CanvasImageReference) {
    if (reference.storageKey && this.stores.media.meta(reference.storageKey)) {
      const bytes = await this.stores.media.read(reference.storageKey);
      if (reference.sha256 && crypto.createHash("sha256").update(bytes).digest("hex") !== reference.sha256) throw new Error(`参考媒体字节在提交前变化：${reference.name || reference.storageKey}`);
      return bytes;
    }
    if (reference.sha256) throw new Error("正式批准参考必须从 Backend 归档媒体读取");
    const dataUrl = /^data:([^;,]+);base64,(.+)$/s.exec(
      String(reference.dataUrl || ""),
    );
    if (dataUrl) return Buffer.from(dataUrl[2], "base64");
    const rawUrl = String(reference.url || "");
    if (!rawUrl)
      throw new Error(
        `参考图缺少可读取地址：${reference.name || reference.id || "unknown"}`,
      );
    const url = rawUrl.startsWith("/")
      ? `${this.config.url.replace(/\/$/, "")}${rawUrl}`
      : rawUrl;
    const response = await fetch(url);
    if (!response.ok)
      throw new Error(
        `读取参考图失败（HTTP ${response.status}）：${reference.name || reference.id || "unknown"}`,
      );
    return Buffer.from(await response.arrayBuffer());
  }

  private prepareFrozenReferences(input: CanvasImageGenerationInput): CanvasImageGenerationInput {
    const frozen = input.params?.productionImageInput as ProductionImageInput | undefined;
    if (!frozen) return input;
    if (input.loopInputImages?.length || !Array.isArray(frozen.references) || frozen.references.length !== (input.references?.length || 0)) throw new Error("实际图片输入数量与正式参考快照不一致");
    const references = frozen.references.map((ref, index) => {
      const actual = input.references![index];
      if (actual.storageKey !== ref.storageKey || actual.dataUrl || actual.sha256 && actual.sha256 !== ref.sha256) throw new Error(`实际参考图 ${index + 1} 与正式顺序/摘要不一致`);
      return { ...actual, name: actual.name || `${ref.label} · ${ref.assetId}`, sha256: ref.sha256 };
    });
    return { ...input, references };
  }

  private canvasHooks(input: CanvasImageGenerationInput): DispatcherHooks {
    return {
      onCompleted: async (result, task) => {
        this.stores.projects.writeBackCanvasImageTask(
          task,
          {
            projectId: input.projectId!,
            nodeId: input.nodeId!,
            prompt: input.prompt,
            model: input.model,
            references: input.references?.map((reference) => ({
              storageKey: reference.storageKey,
              url: reference.url,
              name: reference.name,
            })),
            resultPolicy: input.resultPolicy,
            imageIds: input.imageIds,
          },
          result.media.map((media) => ({ ...media })),
        );
      },
      onFailed: async (error, task) => {
        this.stores.projects.markCanvasImageTaskFailed(
          task,
          { projectId: input.projectId!, nodeId: input.nodeId! },
          error.message,
        );
      },
    };
  }
}

function configuredProvider(
  value: unknown,
  channelId: unknown,
): { baseUrl?: string; apiKey?: string } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const config = value as Record<string, unknown>;
  const channels = Array.isArray(config.channels)
    ? config.channels.filter(
        (item): item is Record<string, unknown> =>
          Boolean(item) && typeof item === "object" && !Array.isArray(item),
      )
    : [];
  const wanted = String(channelId || "").trim();
  const channel =
    channels.find((item) => String(item.id || "") === wanted) ||
    (channels.length === 1 ? channels[0] : undefined);
  const baseUrl = String(channel?.baseUrl || config.baseUrl || "").trim();
  const apiKey = String(channel?.apiKey || config.apiKey || "").trim();
  return baseUrl || apiKey ? { baseUrl, apiKey } : undefined;
}

function builtinPreset(model: string) {
  const value = modelOptionName(model)
    .trim()
    .toLowerCase()
    .replace(/\.json$/, "");
  if (value === "z-image") return "z-image";
  if (value === "flux2-klein") return "flux2-klein";
  return "";
}

/**
 * 蒙版局部修改的工作流改写：只在能确认「蒙版图片接入了活动图像分支」时改写图，
 * 否则返回 undefined，调用方退回原工作流按参考图顺序填第 1 张输入。
 * 工作流本身没有蒙版输入时静默降级，不把本可硬跑的请求变成硬失败。
 */
function maskReferenceWorkflow(
  workflow: Record<string, unknown>,
  fieldNode?: string,
) {
  const referenceNodeIds = (fieldNode || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  if (!referenceNodeIds.length) return undefined;

  const graph = JSON.parse(JSON.stringify(workflow)) as Record<string, unknown>;
  if (activeGraphUsesImage(graph, referenceNodeIds)) return graph;

  for (const node of Object.values(graph)) {
    if (!node || typeof node !== "object") continue;
    const item = node as { class_type?: string; inputs?: Record<string, unknown> };
    if (item.class_type !== "PrimitiveBoolean" || !item.inputs || item.inputs.value !== false) continue;
    item.inputs.value = true;
    if (activeGraphUsesImage(graph, referenceNodeIds)) return graph;
    item.inputs.value = false;
  }

  return undefined;
}

function activeGraphUsesImage(
  workflow: Record<string, unknown>,
  imageNodeIds: string[],
) {
  const outputs = Object.entries(workflow)
    .filter(([, value]) => {
      const node = value as { class_type?: string } | null;
      return node?.class_type === "SaveImage" || node?.class_type === "PreviewImage";
    })
    .map(([id]) => id);
  if (!outputs.length) return false;

  const targets = new Set(imageNodeIds);
  const visited = new Set<string>();
  function visit(id: string): boolean {
    if (targets.has(id)) return true;
    if (visited.has(id)) return false;
    visited.add(id);
    const node = workflow[id] as {
      class_type?: string;
      inputs?: Record<string, unknown>;
    } | null;
    if (!node?.inputs) return false;
    if (node.class_type === "ComfySwitchNode") {
      const switchId = linkedNodeId(node.inputs.switch);
      const selector = switchId
        ? (workflow[switchId] as { inputs?: Record<string, unknown> } | null)
        : null;
      const selected = selector?.inputs?.value;
      if (typeof selected !== "boolean") return false;
      return visitLinkedInput(node.inputs[selected ? "on_true" : "on_false"]);
    }
    return Object.values(node.inputs).some((input) => visitLinkedInput(input));
  }
  function visitLinkedInput(input: unknown) {
    const id = linkedNodeId(input);
    return id ? visit(id) : false;
  }

  return outputs.some((id) => visit(id));
}

function linkedNodeId(value: unknown) {
  if (!Array.isArray(value) || typeof value[0] !== "string") return undefined;
  return value[0];
}

function isImageField(field: WorkflowField, workflow: Record<string, unknown>) {
  if (field.type === "image") return true;
  return field.node
    .split(",")
    .some(
      (id) =>
        (workflow[id] as { class_type?: string } | undefined)?.class_type ===
        "LoadImage",
    );
}

function sizeFromDimensions(width?: number, height?: number) {
  return width && height ? `${width}x${height}` : "1024x1024";
}

function requestedImageDimensions(input: Pick<CanvasImageGenerationInput, "width" | "height" | "size">) {
  if (Number.isFinite(input.width) && Number.isFinite(input.height) && input.width! > 0 && input.height! > 0) return { width: input.width!, height: input.height! };
  const match = /^(\d+)\s*[x×]\s*(\d+)$/i.exec(String(input.size || "").trim());
  if (!match) return null;
  const width = Number(match[1]), height = Number(match[2]);
  return width > 0 && height > 0 ? { width, height } : null;
}

function imageRatioFromText(value: string) {
  const match = /^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)(?:\b|\s|$)/.exec(value.trim());
  return match && Number(match[2]) > 0 ? Number(match[1]) / Number(match[2]) : null;
}

function requestedImageRatio(input: Pick<CanvasImageGenerationInput, "width" | "height" | "size">) {
  const dimensions = requestedImageDimensions(input);
  const sizeDimensions = requestedImageDimensions({ size: input.size });
  const sizeRatio = sizeDimensions ? sizeDimensions.width / sizeDimensions.height : imageRatioFromText(String(input.size || ""));
  if (input.width && input.height && sizeRatio !== null && Math.abs(input.width / input.height - sizeRatio) >= 0.01) {
    throw new Error(`本轮图片尺寸参数冲突：width/height=${input.width}×${input.height}，size=${input.size}`);
  }
  return dimensions ? dimensions.width / dimensions.height : sizeRatio;
}

function mimeFromName(name?: string) {
  const value = String(name || "").toLowerCase();
  if (value.endsWith(".svg")) return "image/svg+xml";
  if (value.endsWith(".jpg") || value.endsWith(".jpeg")) return "image/jpeg";
  if (value.endsWith(".webp")) return "image/webp";
  return "image/png";
}

function emptyWorkflowConfig(name: string): WorkflowConfig {
  return {
    title: name,
    backend: "",
    operation: "",
    description: "",
    fields: [],
  };
}

function stripReferencePayload(
  reference: CanvasImageReference,
): CanvasImageReference {
  const { dataUrl: _dataUrl, ...handle } = reference;
  return handle;
}

/** The provider sees one current loop input followed by the generator's fixed references. */
export function executionImageInputs(input: Pick<CanvasImageGenerationInput, "loopInputImages" | "references">): CanvasImageReference[] {
  return [...(input.loopInputImages || []), ...(input.references || [])];
}

/** This bundled Flux2 workflow used Inspire's shared loaders solely as ordinary single-model loaders. */
export function adaptFlux2KleinWorkflow(workflow: Record<string, unknown>, model: string): Record<string, unknown> {
  if (modelOptionName(model) !== "Flux2-Klein") return workflow;
  const result = { ...workflow };
  for (const [id, value] of Object.entries(workflow)) {
    if (!value || typeof value !== "object") continue;
    const node = value as { class_type?: string; inputs?: Record<string, unknown> };
    const inputs = node.inputs || {};
    if (node.class_type === "LoadTextEncoderShared //Inspire") {
      const name = String(inputs.model_name1 || "");
      if (!name || [inputs.model_name2, inputs.model_name3].some((item) => item && item !== "None")) throw new Error("Flux2-Klein 的文本编码器不是单模型配置，无法替换缺失的 Inspire 加载节点");
      result[id] = { ...node, class_type: "CLIPLoader", inputs: { clip_name: name, type: "flux2" } };
    } else if (node.class_type === "LoadDiffusionModelShared //Inspire") {
      const name = String(inputs.model_name || "");
      if (!name) throw new Error("Flux2-Klein 的扩散模型配置缺少模型文件名");
      result[id] = { ...node, class_type: "UNETLoader", inputs: { unet_name: name, weight_dtype: String(inputs.weight_dtype || "default") } };
    }
  }
  return result;
}

async function waitForTask(
  tasks: TaskStore,
  taskId: string,
): Promise<RuntimeTask> {
  for (;;) {
    const task = tasks.get(taskId);
    if (!task) throw new Error(`生成任务不存在：${taskId}`);
    if (task.status === "succeeded") return task;
    if (task.status === "failed" || task.status === "cancelled")
      throw new Error(task.error || `生成任务${task.status}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

function mediaFromTask(task: RuntimeTask) {
  const result = task.result || {};
  const values = Array.isArray(result.media)
    ? result.media
    : Array.isArray(result.images)
      ? result.images
      : [];
  return values.filter(
    (item): item is CanvasImageGenerationResult["media"][number] =>
      !!item &&
      typeof item === "object" &&
      typeof (item as { url?: unknown }).url === "string",
  );
}
