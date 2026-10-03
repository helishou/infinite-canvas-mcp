import crypto from "node:crypto";
import { createH3NodeMetadata } from "@basketikun/canvas-agent/plugins/minimax-h3/node-factory";
import { isH3NodeType } from "@basketikun/canvas-agent/plugins/minimax-h3/node-factory";
import { buildCharacterGroupFromExistingNode } from "@basketikun/canvas-agent/plugins/minimax-h3/character-groups";
import { assertReferenceCompilation, compileReferenceSubmission } from "@basketikun/canvas-agent/reference-contract";

import type { CanvasGenerationService } from "../canvas/generation-service.js";
import { resolveCanvasImageReferenceNode, type ResolvedCanvasImageReference } from "../canvas/image-references.js";
import type { CanvasOperation } from "../canvas/project-ops.js";
import type { RuntimeTask } from "../db.js";
import type { Stores } from "../stores/types.js";
import { directorArtifact, validateDirectorMedia } from "./director.js";
import { EpisodeProductionService, type ProductionRun } from "./production.js";

const stableId = (kind: string, ...parts: string[]) => `${kind}-${crypto.createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 24)}`;
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const nodesOf = (project: Record<string, unknown>) => Array.isArray(project.nodes) ? project.nodes as Array<Record<string, unknown>> : [];
const mediaKey = (node: Record<string, unknown>) => {
    const meta = object(node.metadata);
    return String(resolveCanvasImageReferenceNode(node)[0]?.storageKey || meta.storageKey || "");
};

/** Version-scoped, recoverable task submissions; all media still flows through CanvasGenerationService. */
export class EpisodeProductionRunner {
    private readonly running = new Set<string>();
    constructor(private readonly service: EpisodeProductionService, private readonly stores: Stores, private readonly generation: CanvasGenerationService) {}

    async resumePending() {
        for (const run of this.service.pendingRuns()) void this.run(run.episodeId, run.version);
    }

    async syncClips(episodeId: string, version: number, groupIds?: string[]) {
        const production = this.service.get(episodeId);
        if (production.publishedVersion !== version || !production.published?.shots.length) throw new Error("只能同步当前已发布镜头表");
        this.service.validateExecution(episodeId, version);
        const episode = this.storesEpisode(episodeId);
        if (!episode.canvasId) throw new Error("分集尚未绑定画布");
        const published = production.published;
        const groups = published.clipGroups.filter((group) => !groupIds || groupIds.includes(group.id));
        for (const group of groups) {
            const project = this.stores.projects.get(episode.canvasId);
            if (!project) throw new Error("分集画布不存在");
            const nodes = nodesOf(project);
            const nodeId = group.nodeId || stableId("production-h3", episodeId);
            const segmentId = group.segmentId || stableId("clip", episodeId, group.id);
            const shots = group.shotIds.map((id) => published.shots.find((shot) => shot.id === id)).filter((shot): shot is NonNullable<typeof shot> => !!shot);
            const h3Model = published.settings.h3Models[group.id] || published.settings.h3Model;
            const authored = directorArtifact(published, "h3", group.id);
            const d = published.director!;
            const planned = (d.source.segments as Array<Record<string, any>>).find(s => s.id === group.id)!;
            const bindings: Array<Record<string, unknown>> = authored.references.map((ref, index) => ({
                id: stableId("binding", group.id, ref.label), assetId: stableId("asset", ref.nodeId, ref.storageKey),
                label: ref.label, role: ref.role, tags: [], enabled: true, usage: "reference",
                mediaType: ref.label.startsWith("<Video") ? "video" : ref.label.startsWith("<Audio") ? "audio" : "image",
                storageKey: ref.storageKey, sourceNodeId: ref.nodeId, order: index, ...(ref.subjectId ? { subjectId: ref.subjectId } : {}),
            }));
            const characterGroups: Record<string, unknown> = {};
            for (const characterNodeId of new Set(authored.references.filter(ref => nodes.some(n => n.id === ref.nodeId && n.type === "character")).map(ref => ref.nodeId))) {
                const refs = authored.references.filter(ref => ref.nodeId === characterNodeId);
                const built = buildCharacterGroupFromExistingNode(nodes.find(n => n.id === characterNodeId)!, {
                    selectedOutfitStorageKeys: refs.filter(r => r.label.startsWith("<Picture")).map(r => r.storageKey),
                    voiceEnabled: refs.some(r => r.label.startsWith("<Audio")), subjectId: String(refs.find(r => r.subjectId)?.subjectId || characterNodeId),
                });
                characterGroups[built.group.id] = built.group;
                bindings.forEach((binding, index) => {
                    const groupRef = built.refs.find(ref => ref.storageKey === binding.storageKey && ref.sourceNodeId === binding.sourceNodeId);
                    if (groupRef) bindings[index] = { ...groupRef, order: index };
                });
            }
            const taskMode = ({ T2VA: "t2v", I2VA: "i2v", FL2VA: "fl2v", L2VA: "l2v", Ref2VA: "ref2va" } as Record<string, string>)[String(planned.mode)];
            if (!taskMode) throw new Error(`未知 Acheng 模式 ${planned.mode}`);
            const prompt = authored.prompt;
            const boundary = d.boundaries.find(b => b.from === group.id);
            const segment = { id: segmentId, sourceShotId: group.shotIds.join("~"), title: shots.map(shot => shot.title).join(" / "),
                duration: shots.reduce((sum, shot) => sum + shot.duration, 0), taskMode, prompt, referenceBindings: bindings,
                tailFrameContinuation: boundary?.tailFrame === true, motionContextEnabled: boundary?.motionContext === true,
                directorEngine: d.engine, directorSourceHash: d.sourceHash, styleTemplateId: null, h3CharacterGroups: characterGroups,
                ...(h3Model ? { modelName: h3Model } : {}) };
            const preflight = compileReferenceSubmission(project, segment);
            assertReferenceCompilation(preflight);
            if (preflight.compiledPrompt !== prompt) throw new Error(`Segment ${group.id} 的参考顺序需要重新绑定并编译；不能自动改写正式正文`);
            const node = nodes.find((item) => item.id === nodeId);
            if (node && !isH3NodeType(node.type)) throw new Error(`映射节点 ${nodeId} 不是 H3`);
            const exists = node && Array.isArray(object(node.metadata).segments) && (object(node.metadata).segments as Array<Record<string, unknown>>).some((item) => item.id === segmentId);
            const operations = exists
                ? [{ type: "update_h3_segment", nodeId, segmentId, patch: { sourceShotId: segment.sourceShotId, title: segment.title, duration: segment.duration, taskMode: segment.taskMode, prompt, referenceBindings: bindings, tailFrameContinuation: segment.tailFrameContinuation, motionContextEnabled: segment.motionContextEnabled, directorEngine: segment.directorEngine, directorSourceHash: segment.directorSourceHash, styleTemplateId: null, h3CharacterGroups: characterGroups, ...(h3Model ? { modelName: h3Model } : {}) } }]
                : node ? [{ type: "add_h3_segment", nodeId, segment }]
                : [{ type: "add_node", id: nodeId, nodeType: "minimax-h3:video", title: `单集 H3 Clips`, position: { x: 0, y: 680 }, width: 1960, height: 1080, metadata: createH3NodeMetadata({}, { segments: [segment] }) }];
            this.stores.projects.applyOperations(episode.canvasId, Number(project.revision || 0), operations, { operationId: stableId("production-sync", episodeId, String(version), group.id, String(project.revision || 0), crypto.createHash("sha256").update(prompt + JSON.stringify(bindings)).digest("hex")), source: { clientId: "episode-production", kind: "system", label: "同步单集 Clip" } });
            this.service.bindRuntime(episodeId, version, { groupId: group.id, nodeId, segmentId });
        }
        const synced = this.service.get(episodeId);
        const orderedNodes = new Set<string>();
        let prior: { nodeId: string; segmentId: string } | undefined;
        for (const group of synced.published!.clipGroups) {
            if (!group.nodeId || !group.segmentId) continue;
            if (!orderedNodes.has(group.nodeId)) {
                const project = this.stores.projects.get(episode.canvasId)!;
                const node = nodesOf(project).find(n => n.id === group.nodeId);
                const first = (object(node?.metadata).segments as Array<Record<string, unknown>> || [])[0];
                if (first?.id && first.id !== group.segmentId) this.stores.projects.applyOperations(episode.canvasId, Number(project.revision || 0), [{ type: "move_h3_segment", nodeId: group.nodeId, segmentId: group.segmentId, beforeSegmentId: String(first.id) }], { source: { clientId: "episode-production", kind: "system" } });
                orderedNodes.add(group.nodeId);
            }
            if (prior && prior.nodeId === group.nodeId) {
                const project = this.stores.projects.get(episode.canvasId)!;
                this.stores.projects.applyOperations(episode.canvasId, Number(project.revision || 0), [{ type: "move_h3_segment", nodeId: group.nodeId, segmentId: group.segmentId, afterSegmentId: prior.segmentId }], { source: { clientId: "episode-production", kind: "system" } });
            }
            prior = { nodeId: group.nodeId, segmentId: group.segmentId };
        }
        return this.service.get(episodeId);
    }

    async run(episodeId: string, version: number) {
        const key = `${episodeId}:${version}`;
        if (this.running.has(key)) return;
        this.running.add(key);
        try { await this.execute(episodeId, version); }
        catch (error) {
            const run = this.service.run(episodeId, version);
            if (run) this.service.updateRun({ ...run, status: "paused", error: error instanceof Error ? error.message : String(error) });
        } finally { this.running.delete(key); }
    }

    private async execute(episodeId: string, version: number) {
        let run = this.service.run(episodeId, version);
        if (!run || !["pending", "running", "awaiting_review"].includes(run.status)) return;
        const production = this.service.get(episodeId);
        if (production.publishedVersion !== version || !production.published) throw new Error("已有更新的发布版本");
        const snapshot = production.published;
        if (!snapshot.director?.executionAuthorized) throw new Error("缺少 Acheng 生产执行授权");
        if (snapshot.director.unresolved.length) throw new Error(snapshot.director.unresolved.join("；"));
        this.service.validateExecution(episodeId, version);
        const imageModelFor = (id: string) => snapshot.settings.imageModels[id] || snapshot.settings.imageModel;
        const h3ModelFor = (id: string) => snapshot.settings.h3Models[id] || snapshot.settings.h3Model;
        const episode = this.storesEpisode(episodeId);
        if (!episode.canvasId) throw new Error("分集未绑定画布");
        const projectBefore = this.stores.projects.get(episode.canvasId);
        if (!projectBefore) throw new Error("分集画布不存在");
        // Assets are authored by Acheng. Execute only ready dependency leaves;
        // review and recompilation of downstream prompts remain Agent work.
        const keyframeAssets = new Set(Object.values(snapshot.director.shotInputs).map(s => s.keyframeAssetId).filter(Boolean));
        const assetTasks = snapshot.director.artifacts.filter(a => a.kind === "image" && a.status === "ready" && !keyframeAssets.has(a.targetId) && snapshot.director!.assets[a.targetId]?.status === "planned");
        for (const artifact of assetTasks) {
            const asset = snapshot.director.assets[artifact.targetId];
            const node = nodesOf(projectBefore).find(n => n.id === asset.nodeId);
            if (!node) throw new Error(`资产 ${artifact.targetId} 缺少已创建画布节点`);
            const model = String(snapshot.settings.imageModel || object(node.metadata).model || "");
            if (!model) throw new Error(`资产 ${artifact.targetId} 缺少图片模型`);
            const taskId = stableId("production-asset-task", episodeId, String(version), artifact.targetId);
            let task = this.stores.tasks.get(taskId);
            if (!task) {
                const result = await this.generation.start({ mode: "image", projectId: episode.canvasId, nodeId: asset.nodeId, model, prompt: artifact.prompt,
                    references: artifact.references.map(r => ({ storageKey: r.storageKey, sourceNodeId: r.nodeId, role: r.role, type: "image" })),
                    params: { writeBackToTarget: true }, idempotencyKey: taskId });
                task = this.stores.tasks.get(result.taskId);
                if (!task) throw new Error("资产任务未记录");
            }
            run = this.recordTask(run, "image", artifact.targetId, task.id);
            await this.waitTask(task.id);
            const actual = this.stores.projects.get(episode.canvasId);
            const outputNode = actual && nodesOf(actual).find(n => n.id === asset.nodeId);
            const key = outputNode ? mediaKey(outputNode) : "";
            if (!key) throw new Error(`资产 ${artifact.targetId} 未回写媒体`);
            this.service.bindDirectorAsset(episodeId, version, artifact.targetId, key);
        }
        if (assetTasks.length || Object.values(snapshot.director.assets).some(asset => asset.status === "generated")) {
            this.service.updateRun({ ...run, status: "awaiting_review", error: "资产已生成；请查看真实媒体，更新批准版本及依赖提示词后发布新导演稿" });
            return;
        }
        if (run.plan.imageShotIds.some((id) => !imageModelFor(id))) throw new Error("缺少图片模型，请在画布节点或配置页选择模型后发布新版本");
        if (run.plan.clipGroupIds.some((id) => !h3ModelFor(id))) throw new Error("缺少 H3 模型，请配置 H3 默认模型后发布新版本");
        if (run.plan.missingAssetNodeIds.length) throw new Error(`缺少资产引用：${run.plan.missingAssetNodeIds.join(", ")}`);
        const availableNodes = new Map(nodesOf(projectBefore).map((node) => [String(node.id || ""), node]));
        const referenceSnapshots = new Map<string, ResolvedCanvasImageReference[]>();
        const plannedGroups = new Set(run.plan.clipGroupIds);
        const requiredShotIds = new Set([...run.plan.affectedShotIds, ...snapshot.clipGroups.filter((group) => plannedGroups.has(group.id)).flatMap((group) => group.shotIds)]);
        for (const shot of snapshot.shots.filter((item) => requiredShotIds.has(item.id))) {
            if (shot.keyframePolicy === "reuse" && !snapshot.keyframes[shot.id]?.storageKey) throw new Error(`镜头 ${shot.id} 的复用关键帧缺少媒体`);
            const linkedFrame = snapshot.keyframes[shot.id];
            if (linkedFrame && !availableNodes.has(linkedFrame.nodeId)) throw new Error(`镜头 ${shot.id} 的关键帧不在当前绑定画布中`);
            const references: ResolvedCanvasImageReference[] = [];
            const added = new Set<string>();
            for (const nodeId of shot.assetNodeIds) {
                const resolved = resolveCanvasImageReferenceNode(availableNodes.get(nodeId) || {}, { id: stableId("production-source", episodeId, shot.id), type: "config", metadata: {} }, added);
                if (!resolved.length) throw new Error(`镜头 ${shot.id} 的参考节点 ${nodeId} 缺少可用媒体`);
                references.push(...resolved);
            }
            referenceSnapshots.set(shot.id, references);
        }
        run = { ...run, status: "running", error: null }; this.service.updateRun(run);
        for (const shotId of run.plan.imageShotIds) {
            const imageModel = imageModelFor(shotId);
            const shot = snapshot.shots.find((item) => item.id === shotId);
            if (!shot) continue;
            const taskId = stableId("production-image-task", episodeId, String(version), shotId);
            let task = this.stores.tasks.get(taskId);
            if (!task) {
                const project = this.stores.projects.get(episode.canvasId);
                if (!project) throw new Error("画布不存在");
                const nodeId = snapshot.keyframes[shotId]?.nodeId || stableId("production-frame", episodeId, shotId);
                const sourceNodeId = stableId("production-source", episodeId, shotId);
                const x = snapshot.shots.findIndex((item) => item.id === shotId) * 380;
                const keyframeAsset = snapshot.director?.shotInputs[shotId]?.keyframeAssetId;
                if (!keyframeAsset) throw new Error(`镜头 ${shotId} 缺少关键帧资产映射`);
                const imageArtifact = directorArtifact(snapshot, "image", keyframeAsset);
                const prompt = imageArtifact.prompt;
                const operations: CanvasOperation[] = nodesOf(project).some((node) => node.id === sourceNodeId)
                    ? [{ type: "update_node", id: sourceNodeId, metadata: { prompt, model: imageModel } }]
                    : [{ type: "add_node", id: sourceNodeId, nodeType: "config", title: shot.title || "关键帧提示词", position: { x, y: -160 }, width: 340, height: 160, metadata: { prompt, model: imageModel, generationMode: "image", productionShotId: shotId } }];
                if (!nodesOf(project).some((node) => node.id === nodeId)) operations.push({ type: "add_node", id: nodeId, nodeType: "image", title: shot.title || shot.visual.slice(0, 24), position: { x, y: 80 }, width: 340, height: 240, metadata: { prompt: shot.visual, status: "idle", productionShotId: shotId } });
                this.stores.projects.applyOperations(episode.canvasId, Number(project.revision || 0), operations, { operationId: stableId("production-frame-prepare", episodeId, String(version), shotId), source: { clientId: "episode-production", kind: "system" } });
                const started = await this.generation.start({ mode: "image", projectId: episode.canvasId, nodeId, sourceNodeId, model: imageModel, prompt, references: imageArtifact.references.map(r => ({ storageKey: r.storageKey, sourceNodeId: r.nodeId, role: r.role, type: "image" })), resultPolicy: "append", params: { writeBackToTarget: true }, clientTaskId: taskId, idempotencyKey: taskId });
                task = this.stores.tasks.get(started.taskId);
                if (!task) throw new Error("图片任务未被 Backend 记录");
            }
            run = this.recordTask(run, "image", shotId, task.id);
            task = await this.waitTask(task.id);
            const nodeId = snapshot.keyframes[shotId]?.nodeId || stableId("production-frame", episodeId, shotId);
            const project = this.stores.projects.get(episode.canvasId);
            const node = project && nodesOf(project).find((item) => item.id === nodeId);
            const taskMedia = object(task.result).media;
            const resultKey = Array.isArray(taskMedia) ? String(object(taskMedia[0]).storageKey || "") : "";
            const key = resultKey || (node ? mediaKey(node) : "");
            if (!key) throw new Error(`镜头 ${shotId} 的图片任务完成但节点缺少 storageKey`);
            if (node && !JSON.stringify(object(node.metadata)).includes(key)) throw new Error(`镜头 ${shotId} 的本轮媒体未回写目标节点`);
            this.service.bindRuntime(episodeId, version, { shotId, nodeId, storageKey: key });
        }
        const latest = this.service.get(episodeId).published!;
        const rejected = run.plan.imageShotIds.find((shotId) => latest.keyframeReviews[shotId]?.verdict === "needs-redo");
        if (rejected) throw new Error(`镜头 ${rejected} 的关键帧自检要求返修；未提交后续 H3`);
        const unreviewed = run.plan.imageShotIds.filter((shotId) => latest.keyframeReviews[shotId]?.verdict !== "auto-accepted" || latest.keyframeReviews[shotId]?.sourceVersion !== version);
        if (unreviewed.length) {
            this.service.updateRun({ ...run, status: "awaiting_review", error: `等待 Agent 查看关键帧并记录视觉自检：${unreviewed.join(", ")}` });
            return;
        }
        if (snapshot.clipGroups.some(g => !snapshot.director!.artifacts.some(a => a.kind === "h3" && a.targetId === g.id && a.status === "ready"))) {
            this.service.updateRun({ ...run, status: "awaiting_review", error: "等待 Acheng 完成当前素材版本的 H3 编译" });
            return;
        }
        if (snapshot.clipGroups.length) await this.syncClips(episodeId, version, run.plan.clipGroupIds);
        const current = this.service.get(episodeId).published!;
        const groups = current.clipGroups;
        const required = new Set(run.plan.clipGroupIds);
        const boundaries = current.director!.boundaries;
        const chains: typeof groups[] = [];
        for (let i = 0; i < groups.length; i++) {
            const chain = [groups[i]];
            while (i + 1 < groups.length && boundaries.some(b => b.from === groups[i].id && b.to === groups[i + 1].id && b.motionContext)) chain.push(groups[++i]);
            if (chain.some(g => required.has(g.id))) chains.push(chain);
        }
        for (const chain of chains) {
            const head = chain[0], tail = chain[chain.length - 1];
            if (!head.nodeId || !head.segmentId || chain.some(g => g.nodeId !== head.nodeId || !g.segmentId)) throw new Error("连续组必须绑定同一个 H3 节点");
            for (const group of chain) {
                directorArtifact(current, "h3", group.id);
                for (const shotId of group.shotIds) {
                    const shot = current.shots.find(s => s.id === shotId);
                    if (shot?.keyframePolicy !== "none" && !current.keyframes[shotId]?.storageKey) throw new Error(`镜头 ${shotId} 缺少可用关键帧参考`);
                }
            }
            const taskId = stableId("production-h3-task", episodeId, String(version), ...chain.map(g => g.id));
            let task = this.stores.tasks.get(taskId);
            if (!task) {
                const started = await this.generation.start({ mode: "video", operation: "h3-run", projectId: episode.canvasId,
                    nodeId: head.nodeId, segmentId: head.segmentId, endSegmentId: tail.segmentId!,
                    runFromCurrent: chain.length > 1, skipCompleted: false, forceRegenerate: true,
                    idempotencyKey: taskId });
                task = this.stores.tasks.get(started.taskId);
                if (!task) throw new Error("H3 父任务未被 Backend 记录");
            }
            for (const group of chain) run = this.recordTask(run, "h3", group.id, task.id);
            await this.waitTask(task.id);
            const finished = this.stores.projects.get(episode.canvasId);
            const node = finished && nodesOf(finished).find(n => n.id === head.nodeId);
            for (const group of chain) {
                const segment = (object(node?.metadata).segments as Array<Record<string, unknown>> || []).find(s => s.id === group.segmentId);
                if (!segment?.resultStorageKey || !this.stores.media.meta(String(segment.resultStorageKey))) throw new Error(`Clip ${group.id} 缺少归档媒体回写`);
            }
        }
        this.service.updateRun({ ...run, status: "succeeded", error: null });
    }

    private recordTask(run: ProductionRun, kind: "image" | "h3", id: string, taskId: string) {
        if (run.submitted.some((item) => item.kind === kind && item.id === id)) return run;
        const next = { ...run, submitted: [...run.submitted, { kind, id, taskId }] };
        this.service.updateRun(next);
        return next;
    }
    private async waitTask(taskId: string): Promise<RuntimeTask> {
        for (;;) {
            const task = this.stores.tasks.get(taskId);
            if (!task) throw new Error(`任务 ${taskId} 丢失`);
            if (task.status === "succeeded") return task;
            if (["failed", "cancelled", "awaiting_confirmation"].includes(task.status)) throw new Error(task.error || `任务 ${taskId} 状态为 ${task.status}`);
            await new Promise((resolve) => setTimeout(resolve, 500));
        }
    }
    private storesEpisode(episodeId: string) {
        const episode = this.service.episodeInfo(episodeId);
        if (!episode) throw new Error("分集不存在");
        return episode;
    }
}
