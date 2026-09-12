import crypto from "node:crypto";
import type { Request, Response, Router } from "express";
import { CanvasImageDispatcher, type CanvasImageGenerationInput, type CanvasImageGenerationResult } from "../canvas/image-dispatcher.js";
import type { BackendEventBus } from "../events.js";
import type { Stores } from "../stores/types.js";
import type { ComfyUiBackend } from "../comfyui/bridge.js";
import type { RunningHubBackend } from "../runtime/runninghub.js";
import { resolveCanvasExecutor } from "../canvas/executor-registry.js";

export function registerCanvasGenerationRoutes(router: Router, dispatcher: CanvasImageDispatcher, stores: Stores, events: BackendEventBus, comfy?: ComfyUiBackend, runningHub?: RunningHubBackend) {
    router.post("/canvas/generation", async (req: Request, res: Response) => {
        try {
            const body = (req.body || {}) as CanvasImageGenerationInput & { mode?: "image" | "video"; preset?: string; input?: Record<string, unknown>; idempotencyKey?: string; comfyUrl?: string };
            const mode = body.mode || "image";
            if (mode === "image") {
                const hooks = body.writeBackCanvas ? {
                    onCompleted: (result: CanvasImageGenerationResult, task: { id: string }) => writeBackSuccess(stores, events, body, result, task.id),
                    onFailed: (error: Error, task: { id: string }) => writeBackFailure(stores, events, body, task.id, error.message),
                } : undefined;
                const result = dispatcher.start(body, hooks);
                return void res.json({ ok: true, ...result, executor: resolveCanvasExecutor({ mode, model: body.model, workflow: body.workflow }, /^gpt-image(?:-|$)/i.test(String(body.model || ""))) });
            }
            if (mode !== "video") throw new Error(`画布生成模式暂不支持：${mode}`);
            const executor = resolveCanvasExecutor({ mode, model: body.model, preset: body.preset });
            const params: Record<string, unknown> = { ...(body.params || {}), executor, model: body.model, projectId: body.projectId, nodeId: body.nodeId, segmentId: body.segmentId };
            const binding = params.canvasBinding && typeof params.canvasBinding === "object" && !Array.isArray(params.canvasBinding)
                ? params.canvasBinding as Record<string, unknown> : null;
            const clientTaskId = body.idempotencyKey || body.clientTaskId || (binding ? `canvas-${crypto.randomUUID()}` : undefined);
            const engine = String(params.minimaxEngine || params.engine || "").trim().toLowerCase();
            const task = engine === "runninghub"
                ? await runningHub?.run(body.input || {}, params, clientTaskId, binding && binding.bindOnStart !== false ? (created) => bindCanvasTask(stores, events, binding, created.id) : undefined)
                : await comfy?.run(body.preset || "minimax-h3", body.input || {}, params, body.comfyUrl, clientTaskId, binding && binding.bindOnStart !== false ? (created) => bindCanvasTask(stores, events, binding, created.id) : undefined);
            if (!task) throw new Error(engine === "runninghub" ? "RunningHub 执行器未初始化" : "ComfyUI 执行器未初始化");
            return void res.json({ ok: true, task, taskId: task.id, executor });
        } catch (error) {
            return void res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
        }
    });
    router.post("/canvas/image-generation", (req: Request, res: Response) => {
        try {
            const body = (req.body || {}) as CanvasImageGenerationInput;
            const hooks = body.writeBackCanvas ? {
                onCompleted: (result: CanvasImageGenerationResult, task: { id: string }) => writeBackSuccess(stores, events, body, result, task.id),
                onFailed: (error: Error, task: { id: string }) => writeBackFailure(stores, events, body, task.id, error.message),
            } : undefined;
            const result = dispatcher.start(body, hooks);
            res.json({ ok: true, ...result });
        } catch (error) {
            res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
        }
    });
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
    const result = stores.projects.applyOperations(projectId, Number(project.revision || 0), [{
        type: "update_node",
        id: nodeId,
        metadata: {
            runtimeTaskId: taskId,
            status: "loading",
            runProgress: 0,
            segments: segments.map((segment) => String(segment.id || "") === segmentId ? { ...segment, runtimeTaskId: taskId, status: "loading", progress: 0, errorDetails: undefined } : segment),
        },
    }]);
    events.publish({ type: "canvas.updated", entityId: projectId, revision: result.revision, payload: result.project });
}

async function writeBackSuccess(stores: Stores, events: BackendEventBus, input: CanvasImageGenerationInput, result: CanvasImageGenerationResult, taskId: string) {
    if (!input.projectId || !input.nodeId) return;
    const task = stores.tasks.get(taskId);
    if (!task) return;
    const saved = stores.projects.writeBackCanvasImageTask(task, {
        projectId: input.projectId,
        nodeId: input.nodeId,
        prompt: input.prompt,
        model: input.model,
        references: input.references?.map((reference) => ({ storageKey: reference.storageKey, url: reference.url, name: reference.name })),
        resultPolicy: input.resultPolicy,
    }, result.media.map((media) => ({ ...media })));
    if (saved) events.publish({ type: "canvas.updated", entityId: saved.id, revision: Number(saved.revision || 0), payload: saved });
}

async function writeBackFailure(stores: Stores, events: BackendEventBus, input: CanvasImageGenerationInput, taskId: string, error: string) {
    if (!input.projectId || !input.nodeId) return;
    const task = stores.tasks.get(taskId);
    if (!task) return;
    const saved = stores.projects.markCanvasImageTaskFailed(task, { projectId: input.projectId, nodeId: input.nodeId }, error);
    if (saved) events.publish({ type: "canvas.updated", entityId: saved.id, revision: Number(saved.revision || 0), payload: saved });
}

function recordOf(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
