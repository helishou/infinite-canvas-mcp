import crypto from "node:crypto";

import type { CanvasGenerationCommand } from "@basketikun/canvas-agent/generation-contract";
import type { RuntimeTask } from "../db.js";
import type { BackendEventBus } from "../events.js";
import type { ComfyUiBackend } from "../comfyui/bridge.js";
import type { RunningHubBackend } from "../runtime/runninghub.js";
import { CanvasH3Runner } from "./h3-runner.js";
import { CanvasImageDispatcher, type CanvasImageGenerationInput } from "./image-dispatcher.js";
import { resolveCanvasExecutor } from "./executor-registry.js";
import { resolveCanvasImageReferences } from "./image-references.js";
import type { Stores } from "../stores/types.js";

/**
 * 画布生成唯一编排入口。
 *
 * 路由层只负责 HTTP，MCP/插件只负责构造 command，具体执行器和任务生命周期
 * 在这里收口。新增能力应注册到 executor-registry 并在本服务增加一次执行器
 * 适配，不再给每个入口各写一套分支。
 */
export class CanvasGenerationService {
    constructor(
        private readonly image: CanvasImageDispatcher,
        private readonly h3: CanvasH3Runner,
        private readonly stores: Stores,
        private readonly events: BackendEventBus,
        private readonly comfy: ComfyUiBackend,
        private readonly runningHub: RunningHubBackend,
    ) {}

    async start(command: CanvasGenerationCommand) {
        const operation = command.operation || "generate";
        if (operation === "h3-run") return this.startH3(command);
        if (command.mode === "image") return this.startImage(command);
        if (command.mode === "video") return this.startVideo(command);
        throw new Error(`画布生成模式暂不支持：${command.mode}`);
    }

    private startH3(command: CanvasGenerationCommand) {
        if (!command.projectId || (!command.nodeId && !command.nodeIds?.length)) throw new Error("H3 生成缺少 projectId 或节点 ID");
        const task = this.h3.start({
            projectId: command.projectId,
            ...(command.nodeId ? { nodeId: command.nodeId } : {}),
            ...(command.nodeIds?.length ? { nodeIds: command.nodeIds } : {}),
            ...(command.segmentId ? { segmentId: command.segmentId } : {}),
            ...(command.segmentIndex !== undefined ? { segmentIndex: command.segmentIndex } : {}),
            ...(command.runFromCurrent !== undefined ? { runFromCurrent: command.runFromCurrent } : {}),
            ...(command.skipCompleted !== undefined ? { skipCompleted: command.skipCompleted } : {}),
            ...(command.params ? { params: command.params } : {}),
        }, command.idempotencyKey || command.clientTaskId);
        return { task, taskId: task.id, executor: "h3" };
    }

    private startImage(command: CanvasGenerationCommand) {
        if (!command.model || !command.prompt) throw new Error("画布图片生成缺少 model 或 prompt");
        const resolved = this.resolveImageReferences(command);
        // 图片与 H3/视频统一：调用方重试同一个幂等键时复用原任务，
        // 不允许因为图片执行器内部字段名不同而再次触发模型。
        const input = {
            ...resolved,
            ...(resolved.idempotencyKey && !resolved.clientTaskId ? { clientTaskId: resolved.idempotencyKey } : {}),
        };
        const result = this.image.start(input as CanvasImageGenerationInput);
        const task = this.stores.tasks.get(result.taskId);
        return { ...result, task: task || undefined };
    }

    private resolveImageReferences(command: CanvasGenerationCommand): CanvasGenerationCommand {
        if (!command.projectId) return command;
        const sourceNodeId = command.sourceNodeId || command.nodeId;
        if (!sourceNodeId) return command;
        const project = this.stores.projects.get(command.projectId);
        if (!project) throw new Error(`画布不存在: ${command.projectId}`);
        const references = resolveCanvasImageReferences(project, sourceNodeId);
        // 无法从画布图谱解析时保留调用方显式参考图；节点落库时序由前端
        // 生成前的强制同步保证，不在这里把运行请求变成卡控错误。
        return references ? { ...command, references } : command;
    }

    private async startVideo(command: CanvasGenerationCommand) {
        const executor = resolveCanvasExecutor({ mode: "video", model: command.model, preset: command.preset });
        const params: Record<string, unknown> = {
            ...(command.params || {}),
            executor,
            model: command.model,
            projectId: command.projectId,
            nodeId: command.nodeId,
            segmentId: command.segmentId,
        };
        const binding = params.canvasBinding && typeof params.canvasBinding === "object" && !Array.isArray(params.canvasBinding)
            ? params.canvasBinding as Record<string, unknown> : null;
        const clientTaskId = command.idempotencyKey || command.clientTaskId || (binding ? `canvas-${crypto.randomUUID()}` : undefined);
        const engine = String(params.minimaxEngine || params.engine || "").trim().toLowerCase();
        const onCreated = binding && binding.bindOnStart !== false
            ? (created: RuntimeTask) => bindCanvasTask(this.stores, this.events, binding, created.id)
            : undefined;
        const task = engine === "runninghub"
            ? await this.runningHub.run(command.input || {}, params, clientTaskId, onCreated)
            : await this.comfy.run(command.preset || "minimax-h3", command.input || {}, params, command.comfyUrl, clientTaskId, onCreated);
        return { ok: true, task, taskId: task.id, executor };
    }
}

function bindCanvasTask(stores: Stores, events: BackendEventBus, binding: Record<string, unknown>, taskId: string) {
    const projectId = String(binding.projectId || "");
    const nodeId = String(binding.nodeId || "");
    const segmentId = String(binding.segmentId || "");
    if (!projectId || !nodeId || !segmentId) throw new Error("H3 任务缺少 canvasBinding(projectId/nodeId/segmentId)");
    const project = stores.projects.get(projectId);
    if (!project) throw new Error(`画布不存在: ${projectId}`);
    const node = (Array.isArray(project.nodes) ? project.nodes : []).find((item) => String((item as Record<string, unknown>).id || "") === nodeId) as Record<string, unknown> | undefined;
    if (!node) throw new Error(`找不到画布节点: ${nodeId}`);
    const metadata = recordOf(node.metadata);
    const segments = Array.isArray(metadata.segments) ? metadata.segments as Array<Record<string, unknown>> : [];
    if (!segments.some((segment) => String(segment.id || "") === segmentId)) throw new Error(`找不到 H3 片段: ${segmentId}`);
    const result = stores.projects.applyOperations(projectId, Number(project.revision || 0), [
        {
            type: "update_node",
            id: nodeId,
            metadata: { runtimeTaskId: taskId, status: "loading", runProgress: 0 },
            metadataDelete: ["errorDetails"],
        },
        {
            type: "update_h3_segment",
            nodeId,
            segmentId,
            patch: { runtimeTaskId: taskId, status: "loading", progress: 0 },
            patchDelete: ["errorDetails"],
        },
    ]);
    events.publishCanvasDelta({ entityId: projectId, revision: result.revision, operations: result.operations, updatedAt: String(result.project.updatedAt || "") });
}

function recordOf(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
