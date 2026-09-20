import crypto from "node:crypto";
import { imageSlotStatus, imageSourceStatus } from "./image-result-slots.js";

import type { ResolvedConfig } from "../config.js";
import type { RuntimeTask, WorkflowConfig, WorkflowField } from "../db.js";
import type { ComfyUiBackend } from "../comfyui/bridge.js";
import {
  DirectImageBackend,
  type ChatGptImageReference,
} from "../runtime/chatgpt-image.js";
import {
  builtinWorkflowName,
  decodeChannelModel,
  modelOptionName,
  resolveWorkflowForModel,
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

export type CanvasImageReference = {
  id?: string;
  name?: string;
  dataUrl?: string;
  url?: string;
  storageKey?: string;
  mimeType?: string;
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
  size?: string;
  width?: number;
  height?: number;
  quality?: string;
  count?: number;
  imageIds?: string[];
  params?: Record<string, unknown>;
  clientTaskId?: string;
  resultPolicy?: "replace-active" | "append";
};

type CanvasImageExecutionPlan = {
  executor: CanvasExecutorId;
  input: CanvasImageGenerationInput;
  workflow?: string;
  preset?: string;
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
  ) {}

  private get logs(): GenerationLogStore {
    return this.stores.logs;
  }

  start(input: CanvasImageGenerationInput, hooks?: DispatcherHooks) {
    let plan = this.plan(this.prepareReferences(input));
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
      }, ...imageSourceStatus(project, normalized.nodeId!, normalized.sourceNodeId, task.id, "loading", true)], { operationId: `image-task-bind:${task.id}`, runtimeWrite: true, source: { clientId: `task:${task.id}`, kind: "task", label: "图片生成任务" } });
    } catch (error) {
      this.stores.tasks.update(task.id, { status: "failed", error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
    // 画布生成日志：开始（running）+ 成功/失败。仅当调用方传入 projectId 时才记录。
    const logId = normalized.projectId
      ? this.logs.create({
          projectId: normalized.projectId,
          nodeId: normalized.nodeId,
          status: "running",
          platform: "canvas-image",
          workflow: plan.workflow || "",
          model: normalized.model,
          taskMode: normalized.references?.length ? "i2i" : "t2i",
          prompt: normalized.prompt,
          references:
            normalized.references?.map((reference) => ({
              name: reference.name,
              mimeType: reference.mimeType,
              storageKey: reference.storageKey,
            })) || [],
          inputCounts: {
            references: normalized.references?.length || 0,
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
    if (!input.references?.length) return input;
    const references = input.references.map((reference) => {
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
    });
    return { ...input, references };
  }

  private findActiveTask(input: CanvasImageGenerationInput) {
    if (!input.projectId) return null;
    const sourceNodeId = input.sourceNodeId || input.nodeId;
    if (!sourceNodeId) return null;
    for (const status of ["running", "queued"] as const) {
      // nodeId 可能是每次点击新建的结果节点，sourceNodeId 才是同一次生成的稳定身份。
      // 因此这里不能按结果节点过滤，否则双击会各自创建任务。
      const active = this.stores.tasks
        .list({
          kind: "canvas-image",
          status,
          projectId: input.projectId,
          limit: 500,
        })
        .find(
          (task) =>
            String(
              (task.input as CanvasImageGenerationInput).sourceNodeId ||
                (task.input as CanvasImageGenerationInput).nodeId ||
                "",
            ) === sourceNodeId,
        );
      if (active) return active;
    }
    return null;
  }

  async retry(task: RuntimeTask) {
    if (task.kind !== "canvas-image")
      throw new Error(`任务类型 ${task.kind} 不是画布图片任务`);
    const input = {
      ...(task.input as CanvasImageGenerationInput),
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
    await hooks?.onCompleted?.(result, { ...task, status: "succeeded", progress: 1, result: { media: result.media } });
    if (this.stores.tasks.get(task.id)?.status === "cancelled") return;
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
      const resolved = resolveWorkflowForModel(
        aiConfig,
        selectedModel,
        (input.references || []).length,
      );
      if (!resolved.ok)
        throw new Error(
          `${workflowResolutionMessage(resolved)}（模型=${input.model}）`,
        );
      return {
        executor: "comfy-workflow",
        input: { ...normalized, params: { ...resolved.params, ...params } },
        workflow: resolved.workflow,
      };
    }

    const executor = resolveCanvasExecutor(
      { mode: "image", model },
      this.directImage.supports(model),
    );
    if (executor === "direct-image") return { executor, input: normalized };

    const preset = builtinPreset(model);
    if (executor === "builtin-comfy" && preset) {
      if (preset === "flux2-klein" && !input.references?.length)
        throw new Error("Flux2-Klein 至少需要一张参考图");
      return { executor, input: normalized, preset };
    }

    const workflow = builtinWorkflowName(model);
    if (executor === "comfy-workflow" && workflow)
      return { executor, input: normalized, workflow };
    throw new Error(`画布图片执行计划不完整：${model}`);
  }

  private async dispatch(
    plan: CanvasImageExecutionPlan,
    taskId: string,
  ): Promise<CanvasImageGenerationResult> {
    if (plan.executor === "direct-image")
      return this.dispatchDirect(plan.input, taskId);
    const count = Math.max(1, Math.min(4, Math.floor(plan.input.count || 1)));
    // 保持网页原有批量并发语义，但所有子任务归属同一父任务，取消覆盖整批。
    const results = await Promise.allSettled(Array.from({ length: count }, async (_, index) => {
      const suffix = count > 1 ? `-${index}` : "";
      const result = plan.executor === "builtin-comfy" && plan.preset
        ? await this.dispatchBuiltin(plan.input, taskId, plan.preset, suffix)
        : plan.executor === "comfy-workflow" && plan.workflow
          ? await this.dispatchWorkflow(plan.input, taskId, plan.workflow, suffix)
          : (() => { throw new Error(`画布图片执行计划不完整：${plan.input.model}`); })();
      return result.media.map((media) => ({ ...media, ...(plan.input.imageIds ? { imageId: plan.input.imageIds[index] } : {}) }));
    }));
    const media = results.flatMap((result) => result.status === "fulfilled" ? result.value : []);
    if (!media.length) {
      const failed = results.find((result) => result.status === "rejected");
      throw failed?.status === "rejected" ? failed.reason : new Error("生成完成但没有返回图片");
    }
    return { taskId, media };
  }

  private async dispatchDirect(
    input: CanvasImageGenerationInput,
    taskId: string,
  ) {
    const references = await Promise.all(
      (input.references || []).map((reference) =>
        this.readReference(reference),
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
      (input.references || []).map((reference) =>
        this.materializeReference(reference),
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
    for (const field of fields) {
      if (
        field.type === "text" &&
        (field.isPrompt || field.id.toLowerCase() === "prompt")
      )
        fieldValues[field.id] = input.prompt;
      if (
        (field.id === "width" || field.id === "height") &&
        fieldValues[field.id] === undefined
      ) {
        const value = field.id === "width" ? input.width : input.height;
        if (value) fieldValues[field.id] = value;
      }
    }

    const imageFields = fields.filter((field) =>
      isImageField(field, detail.workflow),
    );
    const references = input.references || [];
    for (let index = 0; index < imageFields.length; index++) {
      const field = imageFields[index];
      const reference = references[index];
      fieldValues[field.id] = reference
        ? await this.referenceDataUrl(reference)
        : null;
    }

    const workflow =
      input.maskEdit && references.length >= 2
        ? maskReferenceWorkflow(detail.workflow, imageFields[1]?.node) || detail.workflow
        : detail.workflow;

    const childTaskId = `workflow-child-${taskId}${suffix}`;
    this.assertNotCancelled(taskId);
    this.trackChild(taskId, childTaskId);
    try {
      const result = await this.workflowExecutor.run(
        workflow,
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

  private async referenceDataUrl(reference: CanvasImageReference) {
    if (reference.dataUrl) return reference.dataUrl;
    const { data, mimeType } = await this.readReference(reference);
    return `data:${mimeType};base64,${data.toString("base64")}`;
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
      if (media) return media;
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
    if (reference.storageKey && this.stores.media.meta(reference.storageKey))
      return this.stores.media.read(reference.storageKey);
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

function mimeFromName(name?: string) {
  const value = String(name || "").toLowerCase();
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
