import { createHash } from "node:crypto";
import type { Router } from "express";
import { DIRECTOR_SUBAGENT_KIND, directorSubagentSchema, type DirectorSubagentInput, type DirectorSubagentSummary } from "@basketikun/canvas-agent/agent/delegation";
import type { ProductionAgentPool, ProductionAgentRequest } from "@basketikun/canvas-agent/agent/production";
import type { RuntimeTask } from "../db.js";
import type { Stores } from "../stores/types.js";
import type { BackendEventBus } from "../events.js";
import { directorArtifact, directorWorkInput, directorWorkPolicy, type DirectorWorkPackage, type DirectorWorkPolicy } from "@basketikun/canvas-agent/agent/work-package";
import { EpisodeProductionService } from "./production.js";
import { productionWorkPackage, professionalContract, verifyWorkRuntime, loadWorkContract } from "./director-work-package.js";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const outputSchema = { type: "object", additionalProperties: false, properties: { status: { type: "string", enum: ["complete", "partial", "needs_human"] }, summary: { type: "string" }, content: { type: "string" }, unresolved: { type: "array", items: { type: "string" } }, cursor: { type: "string" } }, required: ["status", "summary", "content", "unresolved", "cursor"] };
export class DirectorSubagents {
    private active = new Set<string>();
    constructor(private stores: Stores, private agents: Pick<ProductionAgentPool, "run">, private events: BackendEventBus, private cwd = process.cwd(), private resolveModel?: (parentThreadId: string, requested?: string) => string | undefined,
        private production?: (kind: "episode" | "canvas") => EpisodeProductionService) {}
    private validity(task: RuntimeTask): "current" | "stale" {
        const packet = task.input.workPackage as DirectorWorkPackage | undefined;
        if (!packet) return "current";
        try {
            const service = this.production?.(packet.owner.kind);
            const fresh = service?.get(packet.owner.id).draft.director;
            return fresh && service?.episodeInfo(packet.owner.id).canvasId === packet.projectId && directorWorkInput(fresh, packet.scope).inputHash === packet.inputHash ? "current" : "stale";
        } catch { return "stale"; }
    }
    private summary(task: RuntimeTask): DirectorSubagentSummary {
        return { taskId: task.id, projectId: task.projectId!, parentThreadId: String(task.input.parentThreadId), parentTurnId: task.input.parentTurnId as string | undefined, title: String(task.input.title), role: String(task.input.role), status: task.status, model: task.model,
            sourceRevision: Number(task.input.sourceRevision), createdAt: task.createdAt, updatedAt: task.updatedAt, error: task.error, outcome: task.result?.status as string | undefined, resultAvailable: Boolean(task.result?.content !== undefined),
            binding: task.input.workPackage ? "bound" : "unbound", validity: this.validity(task), artifactHash: task.result?.artifactHash as string | undefined,
            adoption: task.result?.adoption as DirectorSubagentSummary["adoption"], contentDeliveryMode: (task.input.policy as DirectorWorkPolicy | undefined)?.contentDeliveryMode,
            recoverable: task.status === "failed" && Boolean(task.result?.workerThreadId && task.result?.workerTurnId) };
    }
    private publish(task: RuntimeTask, type = "task.updated") { this.events.publish({ type, entityId: task.id, payload: { ...this.summary(task), kind: DIRECTOR_SUBAGENT_KIND } }); }
    private update(id: string, patch: Parameters<Stores["tasks"]["update"]>[1]) { const task = this.stores.tasks.update(id, patch); this.publish(task); return task; }
    private scoped(input: DirectorSubagentInput) {
        if (!input.taskId) throw new Error("get 必须提供 taskId");
        const task = this.stores.tasks.get(input.taskId);
        if (!task || task.kind !== DIRECTOR_SUBAGENT_KIND || task.projectId !== input.projectId || task.input.parentThreadId !== input.parentThreadId) throw new Error("子代理任务不存在或不属于当前导演/画布");
        return task;
    }
    execute(raw: unknown) {
        const input = directorSubagentSchema.parse(raw);
        if (input.action === "list") {
            const limit = Math.min(500, input.limit || 500), offset = input.offset || 0;
            const tasks = this.stores.tasks.list({ kind: DIRECTOR_SUBAGENT_KIND, projectId: input.projectId, parentThreadId: input.parentThreadId, limit, offset });
            return { ok: true, tasks: tasks.map(task => this.summary(task)), nextOffset: tasks.length === limit ? offset + tasks.length : null };
        }
        if (input.action === "get") {
            const task = this.scoped(input), summary = this.summary(task);
            if (input.view !== "result" || !summary.resultAvailable) return { ok: true, task: summary };
            const artifacts = (task.result?.artifacts || []) as Array<Record<string, any>>;
            const requestedHash = input.artifactHash || (input.cursor ? JSON.parse(Buffer.from(input.cursor, "base64url").toString()).resultHash : summary.artifactHash);
            const artifact = artifacts.find(item => item.artifactHash === requestedHash);
            if ((input.artifactHash || artifacts.length) && requestedHash && !artifact) throw new Error(input.cursor ? "INVALID_CURSOR: 产物身份不符" : "ARTIFACT_NOT_FOUND: 产物身份不存在");
            const result = artifact?.output || task.result;
            if (!input.chunkBytes) {
                if (input.cursor) throw new Error("游标读取必须携带 chunkBytes");
                return { ok: true, task: summary, result };
            }
            const bytes = Buffer.from(JSON.stringify(result)), resultHash = artifact?.artifactHash || hash(result);
            const cursor = input.cursor ? JSON.parse(Buffer.from(input.cursor, "base64url").toString()) : { taskId: task.id, resultHash, offset: 0 };
            if (cursor.taskId !== task.id || cursor.resultHash !== resultHash || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0 || cursor.offset > bytes.length || cursor.offset < bytes.length && (bytes[cursor.offset] & 0xc0) === 0x80) throw new Error("INVALID_CURSOR: 子代理结果或游标身份不匹配");
            let end = Math.min(bytes.length, cursor.offset + input.chunkBytes);
            while (end > cursor.offset && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
            if (end === cursor.offset && end < bytes.length) throw new Error("CHUNK_TOO_SMALL: 无法容纳下一个字符");
            return { ok: true, task: summary, chunk: { text: bytes.subarray(cursor.offset, end).toString(), resultHash, totalBytes: bytes.length, offset: cursor.offset, nextCursor: end < bytes.length ? Buffer.from(JSON.stringify({ taskId: task.id, resultHash, offset: end })).toString("base64url") : null } };
        }
        if (input.action === "continue" || input.action === "recover") {
            const task = this.scoped(input);
            if (!input.operationId) throw new Error("continue/recover 必须提供 operationId");
            const commands = (task.result?.commands || {}) as Record<string, string>;
            const intent = input.continuationIntent || "automatic";
            const commandIdentity = input.action === "continue" ? `continue:${intent}` : "recover";
            if (commands[input.operationId]) {
                if (commands[input.operationId] !== commandIdentity && commands[input.operationId] !== input.action) throw new Error("OPERATION_REUSE_MISMATCH");
                return { ok: true, task: this.summary(task), replayed: true };
            }
            if (this.active.has(task.id) || ["queued", "running"].includes(task.status)) throw new Error("WORK_BUSY: 原任务仍在执行");
            if (input.action === "continue" && (task.result?.status !== "partial" || !task.result?.cursor)) throw new Error("WORK_NOT_PARTIAL: 只能续写有游标的 partial 产物");
            if (!task.result?.workerThreadId || input.action === "recover" && !task.result?.workerTurnId) throw new Error("AGENT_RECOVERY_REQUIRED: 缺少原线程/回合身份，未重跑");
            if (input.action === "recover" && task.status !== "failed") throw new Error("WORK_NOT_INTERRUPTED");
            if (input.action === "continue" && this.validity(task) === "stale") throw new Error("WORK_INPUT_CHANGED: 原输入已变化");
            const policy = task.input.policy as DirectorWorkPolicy | undefined;
            if (input.action === "continue") {
                if ((!policy || policy.contentDeliveryMode === "interactive_segment") && intent !== "explicit") throw new Error("WORK_CONTINUATION_CONFIRMATION_REQUIRED: 交互或旧任务需要本轮用户明确继续");
                const packet = task.input.workPackage as DirectorWorkPackage | undefined;
                if (packet) {
                    const currentMode = this.production?.(packet.owner.kind).get(packet.owner.id).draft.director?.workflow.contentDeliveryMode || "auto_file_batch";
                    if (policy && (currentMode !== policy.contentDeliveryMode || policy.authorization.inputHash !== packet.inputHash)) throw new Error("WORK_POLICY_CHANGED: 原交付模式或授权输入已变化，请核对后新建工作");
                }
            }
            const professional = (task.input.professional || task.input.workPackage) as ReturnType<typeof professionalContract> | undefined;
            if (professional) verifyWorkRuntime(professional);
            const next = this.update(task.id, { status: "queued", progress: 0, error: null, result: { ...task.result, ...(input.action === "continue" ? { workerTurnId: undefined } : {}), commands: { ...commands, [input.operationId]: commandIdentity } } });
            void this.run(next, input.action === "recover", input.operationId);
            return { ok: true, task: this.summary(next), replayed: false };
        }
        if (!input.operationId || !input.title || !input.role || !input.prompt) throw new Error("spawn 必须提供 operationId、title、role 和 prompt");
        const request = { projectId: input.projectId, parentThreadId: input.parentThreadId, parentTurnId: input.parentTurnId, operationId: input.operationId, title: input.title, role: input.role, prompt: input.prompt, context: input.context || "", model: input.model, effort: input.effort, ...(input.production ? { production: input.production } : {}), ...(input.contentDeliveryMode ? { contentDeliveryMode: input.contentDeliveryMode } : {}) };
        // A lost receipt can be recovered in a later parent turn; preserve the
        // original turn association instead of treating new tracing metadata as intent.
        const requestHash = hash({ ...request, parentTurnId: undefined });
        const id = `director:${hash([input.projectId, input.parentThreadId, input.operationId]).slice(0, 32)}`;
        const prior = this.stores.tasks.get(id);
        if (prior) {
            if (prior.kind !== DIRECTOR_SUBAGENT_KIND || prior.input.requestHash !== requestHash) throw new Error("OPERATION_REUSE_MISMATCH: 原 operationId 的任务内容不同");
            return { ok: true, task: this.summary(prior), replayed: true };
        }
        if (this.stores.tasks.getTombstone(id)) throw new Error("TASK_PRUNED: 原任务已清理，不自动重跑");
        const project = this.stores.projects.get(input.projectId);
        if (!project) throw new Error("制作画布不存在");
        const model = this.resolveModel?.(input.parentThreadId, input.model) || input.model;
        let workPackage: DirectorWorkPackage | undefined;
        let mode = input.contentDeliveryMode;
        if (input.production) {
            if (mode) throw new Error("WORK_POLICY_OWNED: 正式稿交付模式不能由 spawn 覆盖");
            const service = this.production?.(input.production.kind);
            if (!service) throw new Error("PRODUCTION_UNAVAILABLE");
            const record = service.get(input.production.id);
            if (record.revision !== input.production.expectedRevision) throw new Error("WORK_REVISION_CHANGED: 制作版本已变化");
            if (service.episodeInfo(input.production.id).canvasId !== input.projectId) throw new Error("WORK_PROJECT_MISMATCH: 制作对象与画布绑定不符");
            if (!record.draft.director) throw new Error("WORK_SOURCE_MISSING: 缺少正式导演稿");
            workPackage = productionWorkPackage(service.ownerIdentity(input.production.id), input.projectId, record.revision, record.draft.director, input.role, input.production.scope);
            mode = record.draft.director.workflow.contentDeliveryMode;
        }
        const policy = directorWorkPolicy(mode, input.operationId, workPackage?.inputHash || requestHash);
        if (workPackage) workPackage.policy = policy;
        const professional = workPackage || (this.production ? professionalContract(input.role) : undefined);
        const task = this.stores.tasks.create(id, DIRECTOR_SUBAGENT_KIND, { ...request, model, requestHash, policy, sourceRevision: workPackage?.revision ?? project.revision, ...(workPackage ? { workPackage } : {}), ...(professional ? { professional: { runtimeId: professional.runtimeId, contractHash: professional.contractHash, skillPaths: professional.skillPaths } } : {}) }, { model });
        this.publish(task, "task.created");
        void this.run(task);
        return { ok: true, task: this.summary(task), replayed: false, nextAction: { tool: "canvas_wait_tasks", input: { taskIds: [id] } }, readResult: { tool: "director_subagent", input: { action: "get", projectId: input.projectId, parentThreadId: input.parentThreadId, taskId: id, view: "result" } } };
    }
    reconcileStartup() {
        // Scan a stable paginated set: updates do not remove rows from this kind filter.
        for (let offset = 0; ; offset += 500) {
            const tasks = this.stores.tasks.list({ kind: DIRECTOR_SUBAGENT_KIND, limit: 500, offset });
            for (const task of tasks) if (["queued", "running"].includes(task.status) && !this.active.has(task.id)) this.update(task.id, { status: "failed", error: "AGENT_INTERRUPTED: Backend 重启，原执行者不可核验；可读取原已完成回合，不自动重跑" });
            if (tasks.length < 500) break;
        }
    }
    private async run(task: RuntimeTask, recoverOutput = false, command = "spawn") {
        this.active.add(task.id);
        try {
            const input = task.input;
            const packet = input.workPackage as DirectorWorkPackage | undefined;
            const professional = (input.professional || packet) as ReturnType<typeof professionalContract> | undefined;
            const loaded = professional ? loadWorkContract(professional) : undefined;
            const runtime = loaded?.runtime;
            this.update(task.id, { status: "running" });
            const response = await this.agents.run({ workId: `${task.id}:${command}`, cwd: this.cwd, model: input.model as string | undefined, effort: input.effort as ProductionAgentRequest["effort"], review: input.role === "review", schema: outputSchema,
                threadId: task.result?.workerThreadId as string | undefined, turnId: task.result?.workerTurnId as string | undefined, recoverOutput,
                readRoots: runtime ? [runtime.path] : undefined,
                prompt: `你是主导演的${input.role}子代理。返回严格 JSON（status、summary、content、unresolved、cursor）。只读专业文件，不写文件、业务数据，不生成、不再委派。必载专业文件已在下文预载，不重复读取；按固定合同执行，其他引用仅按需读取。正式工作包事实与冻结交付模式优先于补充说明和旧入口选择题。complete 返回完整建议，partial 必须给非空 cursor；证据不足返回 needs_human。不猜测审核通过。\n任务：${input.title}\n要求：${input.prompt}\n专业合同：${JSON.stringify(professional || {})}\n正式冻结工作包：${packet ? JSON.stringify(packet) : "unbound；只提供自由建议"}\n补充说明：${input.context}\n续写游标：${task.result?.cursor || "首次"}\n${loaded?.text || ""}`,
                onThread: threadId => { const current = this.stores.tasks.get(task.id)!; this.update(task.id, { status: "running", result: { ...current.result, workerThreadId: threadId } }); },
                onTurn: turnId => { const current = this.stores.tasks.get(task.id)!; this.update(task.id, { result: { ...current.result, workerTurnId: turnId } }); },
            });
            const output = response.output as Record<string, unknown>;
            if (!output || !["complete", "partial", "needs_human"].includes(String(output.status)) || typeof output.summary !== "string" || typeof output.content !== "string" || !Array.isArray(output.unresolved) || output.unresolved.some(item => typeof item !== "string") || output.status === "partial" && (typeof output.cursor !== "string" || !output.cursor.trim())) throw new Error("子代理返回不符合交付合同");
            const current = this.stores.tasks.get(task.id)!;
            if (!["queued", "running"].includes(current.status)) return;
            const artifact = directorArtifact(packet?.inputHash, professional?.runtimeId, output, professional?.contractHash);
            this.update(task.id, { status: "succeeded", progress: 1, result: { ...current.result, ...output, artifactHash: artifact.artifactHash,
                artifacts: [...((current.result?.artifacts || []) as unknown[]), artifact], workerThreadId: response.threadId }, error: null });
        } catch (error) {
            const current = this.stores.tasks.get(task.id);
            if (current && ["queued", "running"].includes(current.status)) this.update(task.id, { status: "failed", error: error instanceof Error ? error.message : String(error) });
        } finally { this.active.delete(task.id); }
    }
}
export function registerDirectorSubagentRoutes(router: Router, service: DirectorSubagents) {
    router.post("/director/subagents", (req, res) => { try { res.json(service.execute(req.body)); } catch (error) { res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) }); } });
}
