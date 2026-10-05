import { buildProductionClip, clipInputHash, CLIP_PROJECTION_FIELDS } from "./clip-inputs.js";
import type { CanvasGenerationCommand } from "@basketikun/canvas-agent/generation-contract";
import type { BackendDatabase } from "../db.js";
import type { BackendEventBus } from "../events.js";
import type { Stores } from "../stores/types.js";
import type { EpisodeProductionService } from "./production.js";
import { productionCanvasContext } from "./production-canvas.js";
import { verifyImageInput } from "./image-inputs.js";
import { productionImageInput } from "@basketikun/canvas-agent/reference-contract";

export type NativeProductionTarget = {
    owner: { kind: "canvas" | "episode"; id: string }; version: number; sourceHash: string;
    projectId: string; nodeId: string; kind: "asset" | "keyframe" | "segment"; targetId: string;
    targets: Array<{ targetId: string; segmentId?: string }>;
};

/** Native controls keep the same execution service; only verified production bindings are attached. */
export class NativeProductionGeneration {
    private binding = new Set<string>();
    constructor(private db: BackendDatabase, private stores: Stores, private episodes: EpisodeProductionService,
        private canvases: EpisodeProductionService, private events: BackendEventBus) {}
    private service(owner: NativeProductionTarget["owner"]) { return owner.kind === "episode" ? this.episodes : this.canvases; }
    prepare(command: CanvasGenerationCommand): { command: CanvasGenerationCommand; context?: NativeProductionTarget } {
        if (!command.projectId || !command.nodeId || !["image", "video"].includes(command.mode)) return { command };
        const owner = productionCanvasContext(this.db, command.projectId).owner;
        if (!owner) return { command };
        const service = this.service(owner), current = service.get(owner.id), director = current.draft.director;
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
            if (!artifact || command.prompt !== artifact.prompt) throw new Error("节点提示词与正式图像产物不一致，请先编译并发布当前输入");
            const expected = artifact.references.map(ref => ref.storageKey);
            if (command.references && JSON.stringify(command.references.map(ref => ref.storageKey)) !== JSON.stringify(expected)) throw new Error("节点参考已变化，请重新编译正式图像输入");
            const input = verifyImageInput(this.db.getCanvasProject(command.projectId)!, current.published!.director!, artifact, targetNodeId);
            command = { ...command, nodeId: targetNodeId, sourceNodeId: input.sourceNodeId,
                references: input.references.map(ref => ({ storageKey: ref.storageKey, sourceNodeId: ref.nodeId, role: ref.role, type: "image" as const })), params: { ...command.params, productionImageInput: input, writeBackToTarget: true } };
        } else return { command };
        if (!current.published?.director || current.published.director.sourceHash !== director.sourceHash) throw new Error("请先发布当前制作输入");
        if (kind === "segment" && targets.some(target => !current.published!.clipGroups.some(group => group.id === target.targetId && group.nodeId === command.nodeId && group.segmentId === target.segmentId))) throw new Error("当前 Clip 映射尚未发布");
        const artifactIds = kind === "keyframe" ? [director.shotInputs[targetId].keyframeAssetId!] : targets.map(target => target.targetId);
        service.validateExecution(owner.id, current.publishedVersion, artifactIds);
        if (kind === "segment") {
            const project = this.db.getCanvasProject(command.projectId!)!;
            const node = (project.nodes as Record<string, any>[] || []).find(node => node.id === command.nodeId);
            for (const target of targets) {
                const group = current.published!.clipGroups.find(group => group.id === target.targetId)!;
                const clip = (node?.metadata?.segments || []).find((clip: any) => clip.id === target.segmentId);
                const expected = buildProductionClip(project, current.published!, group, target.segmentId!);
                if (!clip || clipInputHash(clip) !== clipInputHash(expected) || clip.productionClipProjection?.inputHash !== clipInputHash(clip)) throw new Error(`CLIP_INPUT_MISMATCH: ${target.targetId} 的引用或编译投影不一致 (${CLIP_PROJECTION_FIELDS.filter(key => JSON.stringify(clip?.[key] ?? null) !== JSON.stringify(expected[key] ?? null)).join(",") || "projectionHash"})，请准备当前正式目标后再生成`);
            }
        }
        return { command, context: { owner, version: current.publishedVersion, sourceHash: director.sourceHash, projectId: command.projectId!, nodeId: command.nodeId!, kind, targetId, targets } };
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
