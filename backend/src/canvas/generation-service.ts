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
import { CanvasTextDispatcher, type CanvasTextGenerationInput } from "./text-dispatcher.js";
import { CanvasVideoDispatcher } from "./video-dispatcher.js";
import { CanvasAudioDispatcher } from "./audio-dispatcher.js";
import { CanvasBrowserScriptDispatcher } from "./browser-script-dispatcher.js";
import { decodeChannelModel, modelOptionName, resolveModelScript } from "./model-workflow.js";
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
        private readonly text?: CanvasTextDispatcher,
        private readonly video?: CanvasVideoDispatcher,
        private readonly audio?: CanvasAudioDispatcher,
        private readonly browserScript?: CanvasBrowserScriptDispatcher,
    ) {}

    async start(command: CanvasGenerationCommand) {
        const operation = command.operation || "generate";
        if (operation === "h3-run") return this.startH3(command);
        const script = command.model ? resolveModelScript(this.stores.settings?.get?.("ai.config"), command.model) : "";
        if (script) {
            if (!this.browserScript) throw new Error("浏览器脚本执行器未初始化");
            const resolved = this.resolveImageReferences(command);
            const result = this.browserScript.start(resolved, script);
            return { ...result, task: this.stores.tasks.get(result.taskId) || undefined };
        }
        if (command.model && requiresBrowserProvider(this.stores.settings?.get?.("ai.config"), command)) {
            if (!this.browserScript) throw new Error("浏览器模型执行器未初始化");
            const resolved = this.resolveImageReferences(command);
            const result = this.browserScript.start(resolved, "", "browser-provider");
            return { ...result, task: this.stores.tasks.get(result.taskId) || undefined };
        }
        if (command.mode === "text") return this.startText(command);
        if (command.mode === "image") return this.startImage(command);
        if (command.mode === "video") return this.startVideo(command);
        if (command.mode === "audio") return this.startAudio(command);
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
        if (!command.model) throw new Error("画布图片生成缺少 model");
        const resolved = this.resolveImageReferences(command);
        // 图片与 H3/视频统一：调用方重试同一个幂等键时复用原任务，
        // 不允许因为图片执行器内部字段名不同而再次触发模型。
        const input = {
            ...resolved,
            prompt: String(resolved.prompt || ""),
            ...(resolved.idempotencyKey && !resolved.clientTaskId ? { clientTaskId: resolved.idempotencyKey } : {}),
        };
        const result = this.image.start(input as CanvasImageGenerationInput);
        const task = this.stores.tasks.get(result.taskId);
        return { ...result, task: task || undefined };
    }

    private startText(command: CanvasGenerationCommand) {
        if (!this.text) throw new Error("画布文本执行器未初始化");
        if (!command.model) throw new Error("画布文本生成缺少 model");
        const resolved = this.resolveImageReferences(command);
        const input = {
            ...resolved,
            prompt: String(resolved.prompt || ""),
            ...(resolved.idempotencyKey && !resolved.clientTaskId ? { clientTaskId: resolved.idempotencyKey } : {}),
        } as CanvasTextGenerationInput;
        const result = this.text.start(input);
        const task = this.stores.tasks.get(result.taskId);
        return { ...result, task: task || undefined };
    }

    private resolveImageReferences(command: CanvasGenerationCommand): CanvasGenerationCommand {
        if (!command.projectId) return command;
        const project = this.stores.projects.get(command.projectId);
        if (!project) throw new Error(`画布不存在: ${command.projectId}`);
        const nodes = Array.isArray(project.nodes) ? project.nodes as Array<Record<string, unknown>> : [];
        const sourceNodeId = command.sourceNodeId || command.nodeId;
        if (!sourceNodeId) return command;
        const sourceNode = nodes.find((node) => String(node.id || "") === sourceNodeId);
        const sourceMetadata = recordOf(sourceNode?.metadata);
        if (
            command.mode === "image"
            && String(sourceNode?.type || "") === "image"
            && sourceMetadata.generationType === "edit"
        ) {
            const references = resolveCanvasImageReferences(project, sourceNodeId);
            return references ? { ...command, references } : command;
        }
        const references = resolveCanvasImageReferences(project, sourceNodeId);
        // 无法从画布图谱解析时保留调用方显式参考图；节点落库时序由前端
        // 生成前的强制同步保证，不在这里把运行请求变成卡控错误。
        // 图谱解析到参考图时，以 Backend 的权威结果为准；解析为空时保留调用方
        // 已经整理好的参考图（例如智能节点刚建立的连接尚未出现在本次快照中）。
        // 否则显式参考图会被空数组覆盖，H3 工作流随后只能报“缺少必选图片”。
        if (references?.length) return { ...command, references };
        if (references && Array.isArray(command.references) && command.references.length) return command;
        return references ? { ...command, references } : command;
    }

    private async startVideo(command: CanvasGenerationCommand) {
        if (this.video) {
            if (!command.model) throw new Error("画布视频生成缺少 model");
            const resolved = this.resolveImageReferences(command);
            const result = this.video.start({ ...resolved, model: command.model, prompt: String(resolved.prompt || ""),
                ...(resolved.idempotencyKey && !resolved.clientTaskId ? { clientTaskId: resolved.idempotencyKey } : {}) });
            return { ...result, task: this.stores.tasks.get(result.taskId) || undefined };
        }
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
            ? (created: RuntimeTask) => bindCanvasTask(this.stores, binding, created.id)
            : undefined;
        const task = engine === "runninghub"
            ? await this.runningHub.run(command.input || {}, params, clientTaskId, onCreated)
            : await this.comfy.run(command.preset || "minimax-h3", command.input || {}, params, command.comfyUrl, clientTaskId, onCreated);
        return { ok: true, task, taskId: task.id, executor };
    }

    private startAudio(command: CanvasGenerationCommand) {
        if (!this.audio) throw new Error("画布音频执行器未初始化");
        if (!command.model) throw new Error("画布音频生成缺少 model");
        const result = this.audio.start({
            projectId: command.projectId,
            nodeId: command.nodeId,
            sourceNodeId: command.sourceNodeId,
            model: command.model,
            prompt: String(command.prompt || ""),
            voice: String(command.params?.voice || ""),
            format: String(command.params?.format || ""),
            speed: String(command.params?.speed || ""),
            instructions: String(command.params?.instructions || ""),
            ...(command.clientTaskId ? { clientTaskId: command.clientTaskId } : {}),
        });
        return { ...result, task: this.stores.tasks.get(result.taskId) || undefined };
    }
}

function bindCanvasTask(stores: Stores, binding: Record<string, unknown>, taskId: string) {
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
    stores.projects.applyOperations(projectId, Number(project.revision || 0), [
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
    ], { runtimeWrite: true, source: { clientId: `task:${taskId}`, kind: "task", label: "生成任务" } });
}

function recordOf(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function requiresBrowserProvider(value: unknown, command: CanvasGenerationCommand) {
    const config = recordOf(value);
    const channels = Array.isArray(config.channels) ? config.channels.map(recordOf) : [];
    const selected = String(command.model || "").trim();
    const decoded = decodeChannelModel(selected);
    const model = modelOptionName(selected).trim();
    const channel = decoded
        ? channels.find((item) => String(item.id || "") === decoded.channelId)
        : channels.find((item) => (Array.isArray(item.models) ? item.models.map(recordOf) : []).some((entry) => String(entry.name || "") === model));
    if (!channel) return false;
    const kind = String(channel.kind || "api");
    const apiFormat = String(channel.apiFormat || config.apiFormat || "openai");
    if (command.mode === "image") return kind !== "comfyui" && (apiFormat === "gemini" || !/^gpt-image(?:-|$)/i.test(model));
    if (command.mode === "text") return kind === "comfyui" || !["openai", "openai-chat"].includes(apiFormat);
    if (command.mode === "audio") return kind === "comfyui" || apiFormat !== "openai";
    if (command.mode === "video") return kind !== "comfyui" && apiFormat !== "openai";
    return false;
}
