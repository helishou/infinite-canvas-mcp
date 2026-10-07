import { captureCanvasInputs, effectiveTargetInput, inputHash } from "./canvas-inputs.js";
import fs from 'node:fs';
import crypto from 'node:crypto';
import { buildProductionClip, clipInputHash, CLIP_PROJECTION_FIELDS } from "./clip-inputs.js";
import type { CanvasGenerationCommand } from "@basketikun/canvas-agent/generation-contract";
import type { BackendDatabase } from "../db.js";
import type { BackendEventBus } from "../events.js";
import type { Stores } from "../stores/types.js";
import type { EpisodeProductionService } from "./production.js";
import { productionCanvasContext } from "./production-canvas.js";
import { compiledImageInput, verifyImageInput } from "./image-inputs.js";
import { productionImageInput } from "@basketikun/canvas-agent/reference-contract";
import { continuityTargetBlockers } from "./continuity-reports.js";

export type NativeProductionTarget = {
    owner: { kind: "canvas" | "episode"; id: string }; version: number; sourceHash: string;
    projectId: string; nodeId: string; kind: "asset" | "keyframe" | "segment"; targetId: string;
    targets: Array<{ targetId: string; segmentId?: string; inputHash?: string; controlHash?: string }>;
    inputBasis?: "canvas" | "published";
};

/** Native controls keep the same execution service; only verified production bindings are attached. */
export class NativeProductionGeneration {
    private binding = new Set<string>();
    constructor(private db: BackendDatabase, private stores: Stores, private episodes: EpisodeProductionService,
        private canvases: EpisodeProductionService, private events: BackendEventBus) {}
    private service(owner: NativeProductionTarget["owner"]) { return owner.kind === "episode" ? this.episodes : this.canvases; }
    prepare(command: CanvasGenerationCommand): { command: CanvasGenerationCommand; context?: NativeProductionTarget; executionProject?: import("../db.js").CanvasProject; executionDefaults?: Record<string, unknown> } {
        if (!command.projectId || !command.nodeId || !["image", "video"].includes(command.mode)) return { command };
        if (command.inputBasis !== "published") return this.prepareCanvas(command);
        const owner = productionCanvasContext(this.db, command.projectId).owner;
        if (!owner) return { command };
        const service = this.service({ kind: owner.kind, id: owner.id }), current = service.get(owner.id), director = current.draft.director;
        if (!director) return { command };
        let kind: NativeProductionTarget["kind"], targetId: string;
        let targets: NativeProductionTarget["targets"] = [];
        if (command.operation === "h3-run") {
            const groups = current.draft.clipGroups.filter(group => group.nodeId === command.nodeId);
            const selected = groups.find(group => group.segmentId === command.segmentId) || (!command.segmentId ? groups[0] : undefined);
            if (!selected) return { command };
            const start = groups.indexOf(selected), end = command.endSegmentId ? groups.findIndex(group => group.segmentId === command.endSegmentId) : command.runFromCurrent ? groups.length - 1 : start;
            targets = groups.slice(start, Math.max(start, end) + 1).map(group => ({ targetId: group.id, segmentId: group.segmentId! }));
            kind = "segment"; targetId = selected.id;
        } else if (command.mode === "image") {
            const node = (this.db.getCanvasProject(command.projectId)?.nodes as Record<string, any>[] || []).find(node => node.id === command.nodeId);
            const projected = productionImageInput(node);
            const match = Object.entries(director.assets).find(([id, asset]) => (asset.nodeId === command.nodeId || projected?.targetId === id && projected.sourceNodeId === command.nodeId) && (!node?.metadata?.productionAssetId || node.metadata.productionAssetId === id));
            if (!match) return { command };
            if (match[1].sharedSource) throw new Error("共享引用只能在源资产画布编辑");
            const shotId = Object.entries(director.shotInputs).find(([, input]) => input.keyframeAssetId === match[0])?.[0];
            kind = shotId ? "keyframe" : "asset"; targetId = shotId || match[0]; targets = [{ targetId }];
            const artifact = current.published?.director?.artifacts.find(artifact => artifact.kind === "image" && artifact.targetId === match[0]);
            const targetNodeId = match[1].nodeId!;
            if (current.published?.director?.assets[match[0]]?.nodeId !== targetNodeId) throw new Error("当前图像节点映射尚未发布");
            if (!artifact) throw new Error("缺少已发布图片产物");
            const input = compiledImageInput(current.published!.director!, artifact, productionImageInput((this.db.getCanvasProject(command.projectId!)?.nodes as any[] || []).find(node => node.id === targetNodeId))?.sourceNodeId || targetNodeId);
            command = { ...command, nodeId: targetNodeId, sourceNodeId: input.sourceNodeId,
                prompt: artifact.prompt, references: input.references.map(ref => ({ storageKey: ref.storageKey, sourceNodeId: ref.nodeId, role: ref.role, type: "image" as const })), params: { ...command.params, canvasFrozenInput: true, productionImageInput: input, writeBackToTarget: true } };
        } else return { command };
        if (!current.published?.director) throw new Error("缺少已发布导演版本");
        if (kind === "segment" && targets.some(target => !current.published!.clipGroups.some(group => group.id === target.targetId && group.nodeId === command.nodeId && group.segmentId === target.segmentId))) throw new Error("当前 Clip 映射尚未发布");
        if (kind === "segment" && (current.published!.director!.source.ledger as any)?.contract_version === 2) {
            const continuity = service.getContinuity(owner.id, { snapshot: "published", view: "summary" });
            const blockers = continuityTargetBlockers(continuity, targets.map(target => target.targetId));
            if (blockers.length) throw new Error(`${blockers[0].code}: ${blockers.map(item => item.message).join("；")}`);
        }
        const artifactIds = kind === "keyframe" ? [director.shotInputs[targetId].keyframeAssetId!] : targets.map(target => target.targetId);
        service.validateExecution(owner.id, current.publishedVersion, artifactIds);
        const executionProject = structuredClone(this.db.getCanvasProject(command.projectId!)!);
        if (kind === "segment") {
            const node = (executionProject.nodes as any[]).find(node => node.id === command.nodeId);
            for (const target of targets) {
                const group = current.published!.clipGroups.find(group => group.id === target.targetId)!;
                const expected = buildProductionClip(executionProject, current.published!, group, target.segmentId!);
                const index = node?.metadata?.segments?.findIndex((clip: any) => clip.id === target.segmentId);
                if (index < 0) throw new Error("已发布 Clip 节点不存在");
                node.metadata.segments[index] = expected;
            }
        }
        return { command, executionProject: kind === "segment" ? executionProject : undefined, executionDefaults: this.stores.settings.get("plugin:minimax-h3:defaults:v1") as Record<string, unknown> || {}, context: { owner: { kind: owner.kind, id: owner.id }, version: current.publishedVersion, sourceHash: director.sourceHash, projectId: command.projectId!, nodeId: command.nodeId!, kind, targetId, targets } };
    }
    private prepareCanvas(command: CanvasGenerationCommand): { command: CanvasGenerationCommand; context?: NativeProductionTarget } {
        const project = this.db.getCanvasProject(command.projectId!);
        if (!project) throw new Error("画布不存在");
        if (command.expectedCanvasRevision !== undefined && command.expectedCanvasRevision !== Number(project.revision)) throw new Error("画布版本已变化，请刷新生成预检");
        const owner = productionCanvasContext(this.db, project.id).owner;
        if (!owner) return { command };
        const service = this.service(owner), current = service.get(owner.id), data = current.draft;
        if (!data.director) return { command };
        let ids: string[], kind: NativeProductionTarget["kind"];
        if (command.operation === "h3-run") {
            const node = (project.nodes as any[]).find(node => node.id === command.nodeId);
            const segments = node?.metadata?.segments || [];
            const start = command.segmentId ? segments.findIndex((clip: any) => clip.id === command.segmentId) : Number(command.segmentIndex || 0);
            const end = command.endSegmentId ? segments.findIndex((clip: any) => clip.id === command.endSegmentId) : command.runFromCurrent ? segments.length - 1 : start;
            const wanted = new Set(segments.slice(start, end + 1).map((clip: any) => clip.id));
            ids = data.clipGroups.filter(group => group.nodeId === command.nodeId && wanted.has(group.segmentId)).map(group => `segment:${group.id}`);
            kind = "segment";
        } else {
            const sourceNode = (project.nodes as any[]).find(node => node.id === command.nodeId);
            const projected = productionImageInput(sourceNode);
            const match = Object.entries(data.director.assets).find(([id, asset]) => asset.nodeId === command.nodeId || projected?.targetId === id && projected.sourceNodeId === command.nodeId);
            if (!match || !match[1].nodeId) return { command };
            command = { ...command, nodeId: match[1].nodeId };
            const shot = Object.entries(data.director.shotInputs).find(([, input]) => input.keyframeAssetId === match[0]);
            kind = shot ? "keyframe" : "asset"; ids = [shot ? `frame:${shot[0]}` : `asset:${match[0]}`];
        }
        if (!ids.length) return { command };
        if (command.maskEdit === true && kind !== "segment") {
            const defaults = this.db.canvasEditorDefaults(project.id);
            const controlHash = inputHash(effectiveTargetInput(project, command.nodeId!, undefined, defaults));
            const frozen = structuredClone(command);
            for (const reference of frozen.references || []) if (reference.storageKey) {
                const file = this.stores.media.meta(String(reference.storageKey));
                if (!file) throw new Error("蒙版参考文件不存在");
                reference.sha256 = crypto.createHash('sha256').update(fs.readFileSync(file.filePath)).digest('hex');
            }
            const context: NativeProductionTarget = { owner, inputBasis: "canvas", version: current.publishedVersion, sourceHash: data.director.sourceHash, projectId: project.id, nodeId: command.nodeId!, kind,
                targetId: ids[0].slice(ids[0].indexOf(":") + 1), targets: [{ targetId: ids[0].slice(ids[0].indexOf(":") + 1), inputHash: inputHash(frozen), controlHash }] };
            return { command: { ...frozen, params: { ...frozen.params, canvasInputHash: inputHash(frozen), canvasControlHash: controlHash, canvasInputDefaults: defaults, canvasFrozenInput: true } }, context };
        }
        const snapshot = captureCanvasInputs(project, data, ids, this.stores.settings.get("plugin:minimax-h3:defaults:v1") as Record<string, unknown> || {}, key => this.stores.media.meta(key));
        if (!snapshot.targets.length || snapshot.targets.some(target => target.dependencies.length)) throw new Error(snapshot.blockedTargets.map(item => item.message).join("；") || "参考素材尚未生成");
        const target = snapshot.targets[0];
        const saved = command.operation === "h3-run" ? command : { ...command, ...target.command };
        return { command: { ...saved, inputBasis: "canvas", params: { ...saved.params, canvasInputHash: target.inputHash, canvasInputDefaults: snapshot.defaults, canvasFrozenInput: command.mode === "image" } },
            context: { owner, inputBasis: "canvas", version: current.publishedVersion, sourceHash: data.director.sourceHash, projectId: project.id, nodeId: command.nodeId!, kind,
                targetId: ids[0].slice(ids[0].indexOf(":") + 1), targets: snapshot.targets.map(target => ({ targetId: target.id.slice(target.id.indexOf(":") + 1), segmentId: target.segmentId, inputHash: target.inputHash })) } };
    }

    submitted(taskId: string, raw: unknown) {
        const context = raw as NativeProductionTarget;
        if (!this.db.db.prepare("SELECT 1 FROM production_task_bindings WHERE task_id=?").get(taskId)) {
            try { this.service(context.owner).registerNativeTask(context.owner.id, taskId, context); }
            catch (error) {
                this.db.db.prepare(`INSERT OR IGNORE INTO production_task_bindings
                    (task_id, owner_kind, owner_id, version, source_hash, target_kind, target_id, project_id, node_id, targets_json, status, error)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'failed', ?)`).run(taskId, context.owner.kind, context.owner.id, context.version, context.sourceHash, context.kind, context.targetId, context.projectId, context.nodeId, JSON.stringify(context.targets), error instanceof Error ? error.message : String(error));
                this.events.publish({ type: "drama-production.updated", entityId: context.owner.id, payload: { taskId, bindingFailed: true } });
                return;
            }
        }
        this.finish(taskId);
    }
    start() {
        const unsubscribe = this.events.subscribe(event => {
            if (event.type.startsWith("task.") && event.entityId) this.finish(event.entityId);
            if (event.type === "canvas.updated" && event.entityId) {
                const ids = this.db.db.prepare(`SELECT b.task_id FROM production_task_bindings b JOIN tasks t ON t.id=b.task_id
                    WHERE b.project_id=? AND b.status='submitted' AND t.status='succeeded'`).all(event.entityId);
                for (const row of ids) this.finish(String(row.task_id));
            }
        });
        for (const row of this.db.db.prepare("SELECT task_id FROM production_task_bindings WHERE status='submitted'").all()) this.finish(String(row.task_id));
        return unsubscribe;
    }
    private finish(taskId: string) {
        if (this.binding.has(taskId)) return;
        const row = this.db.db.prepare("SELECT * FROM production_task_bindings WHERE task_id=? AND status='submitted'").get(taskId) as Record<string, any> | undefined;
        const task = row && this.stores.tasks.get(taskId);
        if (!row || !task || task.status !== "succeeded") return;
        this.binding.add(taskId);
        try {
            const latest = this.db.db.prepare("SELECT task_id FROM production_task_bindings WHERE owner_kind=? AND owner_id=? AND target_kind=? AND target_id=? ORDER BY rowid DESC LIMIT 1").get(row.owner_kind, row.owner_id, row.target_kind, row.target_id);
            if (latest?.task_id !== taskId) { this.db.db.prepare("UPDATE production_task_bindings SET status='superseded' WHERE task_id=?").run(taskId); return; }
            const service = this.service({ kind: row.owner_kind, id: row.owner_id });
            const node = (this.db.getCanvasProject(row.project_id)?.nodes as Record<string, any>[] || []).find(node => node.id === row.node_id);
            if (!node) throw new Error("任务原目标节点已不存在，媒体及任务仍保留");
            const targets = JSON.parse(row.targets_json) as NativeProductionTarget["targets"];
            if ((task.input.params as any)?.canvasInputHash || (task.input as any).runPlan && targets.some(target => target.inputHash)) {
                service.bindCanvasTaskResult(row.owner_id, taskId, { projectId: row.project_id, nodeId: row.node_id, kind: row.target_kind, targets });
                this.db.db.prepare("UPDATE production_task_bindings SET status='bound', error=NULL WHERE task_id=?").run(taskId);
                return;
            }
            if (row.target_kind === "segment") {
                let bound = 0;
                for (const target of targets) {
                    const clip = (node.metadata?.segments as Record<string, any>[] || []).find(clip => clip.id === target.segmentId);
                    if (!clip?.resultStorageKey || !this.stores.media.meta(clip.resultStorageKey)) continue;
                    if (clip.parentTaskId !== taskId && clip.runtimeTaskId !== taskId && clip.runtimeRunId !== taskId) continue;
                    service.bindRuntime(row.owner_id, row.version, { groupId: target.targetId, nodeId: row.node_id, segmentId: target.segmentId, completed: true });
                    bound++;
                }
                if (!bound) {
                    if (targets.every(target => (node.metadata?.segments as Record<string, any>[] || []).some(clip => clip.id === target.segmentId && clip.resultStorageKey && this.stores.media.meta(clip.resultStorageKey))) && !task.outputs.length) {
                        this.db.db.prepare("UPDATE production_task_bindings SET status='superseded', error='本次没有新的活动输出，原成片及任务保留' WHERE task_id=?").run(taskId);
                        return;
                    }
                    throw new Error("本轮 H3 输出与原 Clip 归属不一致");
                }
            } else {
                const media = Array.isArray(task.result?.media) ? task.result!.media as Record<string, any>[] : task.outputs;
                const key = String(media.find(output => output.storageKey)?.storageKey || task.result?.storageKey || "");
                if (!key || !this.stores.media.meta(key) || !JSON.stringify(node).includes(key)) throw new Error("本轮归档媒体未绑定原节点，请检查原任务回执");
                if (row.target_kind === "keyframe") service.bindRuntime(row.owner_id, row.version, { shotId: row.target_id, nodeId: row.node_id, storageKey: key });
                else service.bindDirectorAsset(row.owner_id, row.version, row.target_id, key);
            }
            this.db.db.prepare("UPDATE production_task_bindings SET status='bound', error=NULL WHERE task_id=?").run(taskId);
        } catch (error) {
            this.db.db.prepare("UPDATE production_task_bindings SET status='failed', error=? WHERE task_id=?").run(error instanceof Error ? error.message : String(error), taskId);
        } finally {
            this.binding.delete(taskId);
            this.events.publish({ type: "drama-production.updated", entityId: row.owner_id, payload: { taskId } });
        }
    }
}
