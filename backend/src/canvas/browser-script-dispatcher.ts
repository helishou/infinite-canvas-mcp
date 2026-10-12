import crypto from "node:crypto";

import type { CanvasGenerationCommand } from "@basketikun/canvas-agent/generation-contract";
import { modelOptionName } from "./model-workflow.js";
import type { RuntimeTask } from "../db.js";
import type { BackendEventBus } from "../events.js";
import type { CanvasOperation } from "./project-ops.js";
import type { Stores } from "../stores/types.js";
import type { CanvasTextGenerationInput } from "./text-dispatcher.js";
import { CanvasTextDispatcher } from "./text-dispatcher.js";
import { prepareCanvasGenerationTarget } from "./generation-target.js";

export const CANVAS_BROWSER_TASK_KIND = "canvas-browser-script";

export type BrowserScriptTaskInput = CanvasGenerationCommand & { script: string };
export type BrowserTaskExecutor = "browser-script" | "browser-provider";

/**
 * User-authored model scripts keep their browser sandbox, while Backend owns the
 * task, claim arbitration and canvas writeback. No script is evaluated here.
 */
export class CanvasBrowserScriptDispatcher {
    private readonly claims = new Map<string, { workerId: string; token: string; submissionGranted: boolean }>();

    constructor(
        private readonly stores: Stores,
        private readonly events: BackendEventBus,
        private readonly text: CanvasTextDispatcher,
    ) {}

    start(command: CanvasGenerationCommand, script = "", executor: BrowserTaskExecutor = script.trim() ? "browser-script" : "browser-provider") {
        let input = this.prepare(command, script, executor);
        const taskId = input.idempotencyKey || input.clientTaskId || `canvas-browser-${crypto.randomUUID()}`;
        const existing = this.stores.tasks.get(taskId);
        if (existing) return { taskId: existing.id, executor };
        if (this.stores.tasks.getTombstone?.(taskId)) throw Object.assign(new Error(`TASK_HISTORY_PRUNED: ${taskId}`), { code: "TASK_HISTORY_PRUNED", retryable: false });
        const active = this.findActive(input);
        if (active) return { taskId: active.id, executor };
        const prepared = prepareCanvasGenerationTarget(this.stores, input, taskId);
        input = prepared.command as BrowserScriptTaskInput;
        const project = prepared.project || (input.mode === "text" ? this.canvasTarget(input) : null);
        const target = project && input.nodeId ? arrayRecords(project.nodes).find((node) => String(node.id || "") === input.nodeId) : undefined;
        const targetSize = prepared.targetSize || (target ? { width: Number(target.width || 0), height: Number(target.height || 0) } : undefined);
        const task = this.stores.tasks.create(taskId, CANVAS_BROWSER_TASK_KIND, input as unknown as Record<string, unknown>, {
            projectId: input.projectId,
            nodeId: input.nodeId,
            executor,
            model: input.model,
            mode: input.mode,
            ...(targetSize && input.mode === "image" ? { imageTargetSize: targetSize } : {}),
            ...(targetSize && input.mode === "video" ? { videoTargetSize: targetSize } : {}),
        });
        try {
            if (project && input.nodeId) this.bind(project, input, task.id, prepared.createOperations);
        } catch (error) {
            this.update(task.id, { status: "failed", error: messageOf(error) });
            throw error;
        }
        this.publish(task, "task.created");
        return { taskId: task.id, executor };
    }

    claim(id: string, workerId: string) {
        let task = this.requireTask(id);
        if (!workerId.trim()) throw new Error("浏览器执行器缺少 workerId");
        if (!["queued", "running"].includes(task.status)) throw new Error(`任务状态 ${task.status} 不可认领`);
        const owner = this.claims.get(id);
        if (owner && owner.workerId !== workerId) throw new Error("任务已由另一个浏览器认领");
        if (!owner && task.status === "running" && !recoveryOf(task).phase) {
            this.resume(task);
            task = this.requireTask(id);
        }
        const claim = owner || { workerId, token: crypto.randomUUID(), submissionGranted: false };
        const claimed = task.status === "queued" ? this.update(id, { status: "running", progress: 0.02 }) : task;
        this.claims.set(id, claim);
        this.stores.tasks.addEvent(id, "browser_claimed", { workerId });
        return { task: claimed, claimToken: claim.token };
    }

    checkpoint(id: string, workerId: string, claimToken: string, value: Record<string, unknown>) {
        const task = this.requireClaim(id, workerId, claimToken);
        const previous = recoveryOf(task);
        const next = normalizeRecovery(this.stores, value, String(task.input.mode || ""));
        const oldPhase = String(previous.phase || "");
        if (previous.cacheOwner && previous.cacheOwner !== next.cacheOwner) throw new Error("浏览器回执属于另一连接身份，不能替换恢复所有者");
        if (!oldPhase && !next.providerFingerprint) throw new Error("首次提交回执缺少渠道身份指纹");
        if (previous.providerFingerprint && previous.providerFingerprint !== next.providerFingerprint) throw new Error("渠道身份已改变，不能替换原任务的渠道指纹");
        if (!oldPhase && next.phase !== "submitting") throw new Error("缺少提交前回执，不能跳过提交检查点");
        if (oldPhase && phaseRank(next.phase) < phaseRank(oldPhase)) throw new Error("浏览器回执不能退回先前阶段");
        const oldExternal = recordOf(previous.externalTask);
        const newExternal = recordOf(next.externalTask);
        if (oldExternal.id && newExternal.id && ["id", "provider", "model"].some(key => oldExternal[key] !== newExternal[key])) throw new Error("浏览器外部任务身份不能替换");
        if (next.phase === "submitting" && oldPhase && !this.claims.get(id)!.submissionGranted) throw new Error("已有提交回执，只能恢复查询或归档；请核对服务商，不能重新提交");
        if (oldPhase === "archived" && JSON.stringify(previous.output) !== JSON.stringify(next.output)) throw new Error("已归档回执不能替换");
        const recovery = { ...previous, ...next, ...(oldExternal.id && !newExternal.id ? { externalTask: oldExternal } : {}) };
        const updated = this.update(id, { result: { ...recordOf(task.result), browserRecovery: recovery }, error: null });
        if (next.phase === "submitting") this.claims.get(id)!.submissionGranted = true;
        this.stores.tasks.addEvent(id, "browser_checkpoint", { phase: next.phase });
        return updated;
    }

    complete(id: string, workerId: string, result: Record<string, unknown>, claimToken: string) {
        const task = this.requireClaim(id, workerId, claimToken);
        const input = task.input as BrowserScriptTaskInput;
        const recovery = recoveryOf(task);
        if (recovery.phase === "archived") result = recordOf(recovery.output);
        const alreadyWritten = recovery.phase === "archived" && this.hasWritebackReceipt(task, input);
        let normalized: Record<string, unknown>;
        if (input.mode === "text") {
            const texts = normalizeTexts(result.texts);
            if (!texts.length) throw new Error("浏览器文本执行器没有返回内容");
            const written = alreadyWritten || this.text.writeBackExternal(task.id, input as CanvasTextGenerationInput, texts);
            if (!written) throw new Error("文本任务已失去节点绑定，放弃迟到结果");
            normalized = { texts: texts.map((content, index) => ({ index, content })) };
        } else {
            const media = normalizeMedia(this.stores, result.media);
            if (!media.length) throw new Error("浏览器媒体执行器没有返回已入库媒体");
            if (!alreadyWritten) this.writeBackMedia(task, input, media);
            normalized = { media };
        }
        const completed = this.update(id, { status: "succeeded", progress: 1, result: { ...recordOf(task.result), ...normalized }, error: null });
        this.claims.delete(id);
        this.stores.tasks.addEvent(id, "result", normalized);
        return completed;
    }

    fail(id: string, workerId: string, error: string, claimToken: string, terminalConfirmed = false, notSubmitted = false) {
        const task = this.requireClaim(id, workerId, claimToken);
        const previous = recoveryOf(task);
        if (terminalConfirmed && notSubmitted) throw new Error("失败证据不能同时声明已提交与未提交");
        if (notSubmitted) {
            if (previous.phase) throw new Error("已有提交回执，不能声明未提交");
            const failed = this.update(id, { status: "failed", error: "生成前检查未通过，尚未提交服务商；请检查模型配置和参考素材后重试", result: { ...recordOf(task.result), browserRecovery: { version: 1, notSubmitted: true } } });
            this.claims.delete(id);
            this.markCanvasFailed(failed, failed.error || "", false);
            this.stores.tasks.addEvent(id, "error", { notSubmitted: true });
            return failed;
        }
        if (!terminalConfirmed || phaseRank(previous.phase) >= phaseRank("result_available")) return this.release(id, workerId, claimToken, error);
        const failed = this.update(id, { status: "failed", error: "服务商已确认浏览器模型任务失败", result: { ...recordOf(task.result), browserRecovery: { ...previous, terminalConfirmed: true } } });
        this.claims.delete(id);
        this.markCanvasFailed(failed, failed.error || "", false);
        this.stores.tasks.addEvent(id, "error", { terminalConfirmed: true });
        return failed;
    }

    release(id: string, workerId: string, claimToken: string, _error = "") {
        const task = this.requireClaim(id, workerId, claimToken);
        const recovery = recoveryOf(task);
        const submitted = Boolean(recovery.phase);
        // A submitted provider request is not cancelled by closing a browser tab.
        const released = this.update(id, submitted
            ? { status: "running", error: recoveryMessage(recovery) }
            : { status: "queued", progress: 0 });
        this.claims.delete(id);
        this.stores.tasks.addEvent(id, "browser_released", { workerId, recoveryRequired: submitted });
        return released;
    }

    cancel(id: string) {
        const task = this.requireTask(id);
        if (!["queued", "running"].includes(task.status)) throw new Error(`任务状态 ${task.status} 不可取消`);
        const recovery = recoveryOf(task);
        const wasClaimed = this.claims.has(id) || this.stores.tasks.events(id).some(event => event.type === "browser_claimed");
        if (recovery.phase || task.status === "running" || wasClaimed) {
            const retained = Object.keys(recovery).length ? recovery : { version: 1, phase: "submitting", cacheOwner: "", legacyUnknown: true };
            const stopped = this.update(id, { status: "running", error: "已停止浏览器处理；服务商任务可能仍在运行，请核对回执后恢复，不能重新提交", result: { ...recordOf(task.result), browserRecovery: retained } });
            this.claims.delete(id);
            return stopped;
        }
        this.claims.delete(id);
        const cancelled = this.update(id, { status: "cancelled", result: { ...recordOf(task.result), browserRecovery: { version: 1, notSubmitted: true } } });
        this.stores.tasks.addEvent(id, "cancelled", { taskId: id, notSubmitted: true });
        this.markCanvasFailed(cancelled, "", true);
        return cancelled;
    }

    retry(task: RuntimeTask) {
        task = this.requireTask(task.id);
        const recovery = recoveryOf(task);
        if (task.status === "succeeded") throw new Error("任务已完成，无需重新生成");
        if (!recovery.terminalConfirmed && !recovery.notSubmitted) {
            if (recordOf(recovery.externalTask).id || ["result_available", "archived"].includes(String(recovery.phase))) {
                return this.update(task.id, { status: "running", error: null });
            }
            throw new Error("服务商提交结果尚未确认，请核对服务商或原浏览器缓存；不能重新提交以免重复费用");
        }
        const input = task.input as BrowserScriptTaskInput;
        const executor = task.executor === "browser-provider" ? "browser-provider" : "browser-script";
        const result = this.start({ ...input, ...(input.loopOutput ? { nodeId: input.sourceNodeId, imageIds: undefined } : {}), idempotencyKey: undefined, clientTaskId: `canvas-browser-retry-${crypto.randomUUID()}` }, input.script, executor);
        const retried = this.stores.tasks.get(result.taskId);
        if (!retried) throw new Error("浏览器模型重试任务创建失败");
        this.stores.tasks.addEvent(retried.id, "retry", { parentTaskId: task.id });
        return retried;
    }

    /** Restart invalidates ownership, never the durable provider receipt. */
    resume(task: RuntimeTask) {
        if (task.kind !== CANVAS_BROWSER_TASK_KIND || task.status !== "running") return;
        this.claims.delete(task.id);
        const recovery = recoveryOf(task);
        const retained = Object.keys(recovery).length ? recovery : { version: 1, phase: "submitting", cacheOwner: "", legacyUnknown: true };
        this.update(task.id, { status: "running", error: recoveryMessage(retained), result: { ...recordOf(task.result), browserRecovery: retained } });
    }

    private prepare(command: CanvasGenerationCommand, script: string, executor: BrowserTaskExecutor): BrowserScriptTaskInput {
        const model = String(command.model || "").trim();
        const prompt = String(command.prompt || "").trim();
        if (!model) throw new Error("浏览器模型任务缺少模型");
        if (!prompt) throw new Error("浏览器模型任务提示词为空");
        if (executor === "browser-script" && !script.trim()) throw new Error(`模型「${modelOptionName(model)}」没有浏览器脚本`);
        return { ...command, model, prompt, script: script.trim() };
    }

    private canvasTarget(input: BrowserScriptTaskInput) {
        if (!input.nodeId) return null;
        if (!input.projectId) throw new Error("画布脚本任务指定 nodeId 时必须提供 projectId");
        const project = this.stores.projects.get(input.projectId);
        const node = project && arrayRecords(project.nodes).find((item) => String(item.id || "") === input.nodeId);
        if (!project || !node) throw new Error("画布脚本生成目标不存在，未启动模型");
        return project;
    }

    private bind(project: NonNullable<ReturnType<Stores["projects"]["get"]>>, input: BrowserScriptTaskInput, taskId: string, createOperations: CanvasOperation[] = []) {
        const operations: CanvasOperation[] = [...createOperations, {
            type: "update_node", id: input.nodeId!,
            metadata: { runtimeTaskId: taskId, status: "loading", runProgress: 0 },
            metadataDelete: ["errorDetails"],
        }];
        if (!input.loopOutput && input.sourceNodeId && input.sourceNodeId !== input.nodeId) {
            const source = arrayRecords(project.nodes).find((node) => String(node.id || "") === input.sourceNodeId);
            if (source?.type === "config") operations.push({
                type: "update_node", id: input.sourceNodeId,
                metadata: { runtimeTaskId: taskId, status: "loading" }, metadataDelete: ["errorDetails"],
            });
        }
        this.stores.projects.applyOperations(input.projectId!, Number(project.revision || 0), operations, {
            operationId: `browser-task-bind:${taskId}`, runtimeWrite: true,
            source: { clientId: `task:${taskId}`, kind: "task", label: input.script ? "浏览器脚本任务" : "浏览器模型任务" },
        });
    }

    /** Canvas writeback and task status have separate acknowledgements; replay neither output nor fees. */
    private hasWritebackReceipt(task: RuntimeTask, input: BrowserScriptTaskInput) {
        if (!input.projectId || !input.nodeId) return false;
        const project = this.stores.projects.get(input.projectId);
        return Boolean(project && arrayRecords(project.nodes).filter(item => [input.nodeId, input.sourceNodeId].includes(String(item.id || ""))).some(node => {
            const metadata = recordOf(node.metadata);
            return metadata.generationTaskId === task.id || arrayRecords(metadata.generatedImageHistory).some(item => item.taskId === task.id);
        }));
    }

    private writeBackMedia(task: RuntimeTask, input: BrowserScriptTaskInput, media: Array<Record<string, unknown>>) {
        if (!input.projectId || !input.nodeId) return;
        const binding = { projectId: input.projectId, nodeId: input.nodeId };
        const model = String(input.model || "");
        const prompt = String(input.prompt || "");
        const written = input.mode === "image"
            ? this.stores.projects.writeBackCanvasImageTask({ ...task, status: "succeeded", result: { media } }, {
                ...binding, prompt, model, references: input.references, resultPolicy: input.resultPolicy, imageIds: input.imageIds,
            }, media)
            : input.mode === "video"
                ? this.stores.projects.writeBackCanvasVideoTask({ ...task, status: "succeeded", result: { media } }, { ...binding, prompt, model }, media[0])
                : this.stores.projects.writeBackCanvasAudioTask({ ...task, status: "succeeded", result: { media } }, { ...binding, prompt, model }, media[0]);
        if (!written) throw new Error(`${input.mode} 任务已失去节点绑定，放弃迟到结果`);
    }

    private markCanvasFailed(task: RuntimeTask, error: string, cancelled: boolean) {
        const input = task.input as BrowserScriptTaskInput;
        if (!input.projectId || !input.nodeId) return;
        const binding = { projectId: input.projectId, nodeId: input.nodeId };
        if (input.mode === "image") this.stores.projects.markCanvasImageTaskFailed(task, binding, error);
        else if (input.mode === "video") this.stores.projects.markCanvasVideoTaskFailed(task, binding, error);
        else if (input.mode === "audio") this.stores.projects.markCanvasAudioTaskFailed(task, binding, error);
        else this.text.markExternalFailed(task.id, input as CanvasTextGenerationInput, error, cancelled);
    }

    private findActive(input: BrowserScriptTaskInput) {
        if (!input.projectId || !input.nodeId) return null;
        for (const status of ["running", "queued"] as const) {
            const active = this.stores.tasks.list({ kind: CANVAS_BROWSER_TASK_KIND, status, projectId: input.projectId, limit: 500 })
                .find((task) => {
                    const previous = task.input as BrowserScriptTaskInput;
                    if (input.loopOutput) return previous.loopOutput?.loopNodeId === input.loopOutput.loopNodeId
                        && previous.loopOutput?.roundIndex === input.loopOutput.roundIndex
                        && previous.loopOutput?.slotIndex === input.loopOutput.slotIndex
                        && (previous.sourceNodeId || previous.nodeId) === input.nodeId;
                    return String(previous.nodeId || "") === input.nodeId;
                });
            if (active) return active;
        }
        return null;
    }

    private requireTask(id: string) {
        const task = this.stores.tasks.get(id);
        if (!task || task.kind !== CANVAS_BROWSER_TASK_KIND) throw new Error("浏览器模型任务不存在");
        return task;
    }

    private requireClaim(id: string, workerId: string, claimToken: string) {
        const task = this.requireTask(id);
        if (task.status !== "running") throw new Error(`任务状态 ${task.status} 不接受浏览器结果`);
        if (!claimToken || this.claims.get(id)?.workerId !== workerId || this.claims.get(id)?.token !== claimToken) throw new Error("浏览器模型任务认领已失效");
        return task;
    }

    private update(id: string, patch: Parameters<Stores["tasks"]["update"]>[1]) {
        const task = this.stores.tasks.update(id, patch);
        this.publish(task, task.status === "succeeded" ? "task.completed" : task.status === "failed" ? "task.failed" : "task.updated");
        return task;
    }

    private publish(task: RuntimeTask, type: string) {
        this.events.publish({ type, entityId: task.id, payload: task });
    }
}

function normalizeTexts(value: unknown) {
    return (Array.isArray(value) ? value : [value]).map((item) => typeof item === "string" ? item : String(recordOf(item).content || "")).map((item) => item.trim()).filter(Boolean);
}

function normalizeMedia(stores: Stores, value: unknown) {
    const keys = (Array.isArray(value) ? value : []).map((item) => String(recordOf(item).storageKey || item || "")).filter(Boolean);
    return keys.map((storageKey) => {
        const media = stores.media.meta(storageKey);
        if (!media) throw new Error(`浏览器返回的媒体不存在：${storageKey}`);
        return { storageKey, url: stores.media.url(media), mimeType: media.mimeType, bytes: media.bytes, width: media.width, height: media.height, durationMs: media.durationMs };
    });
}

function arrayRecords(value: unknown): Array<Record<string, unknown>> {
    return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : [];
}
function recordOf(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function messageOf(error: unknown) { return error instanceof Error ? error.message : String(error); }

function recoveryOf(task: RuntimeTask) { return recordOf(recordOf(task.result).browserRecovery); }
function phaseRank(phase: unknown) { return ["submitting", "external_task", "result_available", "archived"].indexOf(String(phase)); }
function recoveryMessage(recovery: Record<string, unknown>) {
    return recordOf(recovery.externalTask).id || ["result_available", "archived"].includes(String(recovery.phase))
        ? "浏览器处理已暂停，原任务回执已保留；恢复时只查询或归档，不重新生成"
        : "服务商提交结果尚未确认，请核对服务商或原浏览器缓存；不能重新提交以免重复费用";
}
function normalizeRecovery(stores: Stores, value: Record<string, unknown>, mode: string): Record<string, unknown> & { phase: string } {
    const phase = String(value.phase || "");
    if (value.version !== 1 || phaseRank(phase) < 0 || typeof value.cacheOwner !== "string" || !value.cacheOwner.trim() || value.cacheOwner.length > 256) throw new Error("浏览器回执格式无效");
    const result: Record<string, unknown> & { phase: string } = { version: 1, phase, cacheOwner: value.cacheOwner };
    if (value.providerFingerprint !== undefined) {
        if (typeof value.providerFingerprint !== "string" || !/^[a-f0-9]{64}$/i.test(value.providerFingerprint)) throw new Error("渠道身份指纹格式无效");
        result.providerFingerprint = value.providerFingerprint;
    }
    if (value.externalTask !== undefined) {
        const external = recordOf(value.externalTask);
        if (typeof external.id !== "string" || !external.id.trim() || external.id.length > 1024 || !["openai", "plugin", "comfyui"].includes(String(external.provider)) || typeof external.model !== "string" || !external.model.trim() || external.model.length > 256) throw new Error("外部任务回执格式无效");
        const parameters = recordOf(external.parameters);
        const safeParameters: Record<string, string | number> = {};
        for (const key of ["size", "resolution", "seconds"]) if (parameters[key] !== undefined) {
            const entry = parameters[key];
            if (!((typeof entry === "string" && entry.length <= 100) || (typeof entry === "number" && Number.isFinite(entry)))) throw new Error("外部任务参数格式无效");
            safeParameters[key] = entry;
        }
        result.externalTask = { id: external.id, provider: external.provider, model: external.model, ...(Object.keys(safeParameters).length ? { parameters: safeParameters } : {}) };
    }
    if (phase === "external_task" && !result.externalTask) throw new Error("外部任务回执缺少任务编号");
    if (phase === "archived") {
        if (mode === "text") {
            const texts = recordOf(value.output).texts;
            if (!Array.isArray(texts) || !texts.length || !texts.every(item => typeof item === "string" && item.trim())) throw new Error("归档回执缺少文本结果");
            result.output = { texts: texts.map(item => item.trim()) };
        } else {
            const media = normalizeMedia(stores, recordOf(value.output).media);
            if (!media.length) throw new Error("归档回执缺少已入库媒体");
            result.output = { media: media.map(item => ({ storageKey: item.storageKey })) };
        }
    }
    return result;
}
