import crypto from "node:crypto";
import { createH3NodeMetadata } from "@basketikun/canvas-agent/plugins/minimax-h3/node-factory";
import { isH3NodeType } from "@basketikun/canvas-agent/plugins/minimax-h3/node-factory";
import { assembleH3Prompt } from "@basketikun/canvas-agent/plugins/minimax-h3/prompt-sections";

import type { CanvasGenerationService } from "../canvas/generation-service.js";
import { resolveCanvasImageReferenceNode, type ResolvedCanvasImageReference } from "../canvas/image-references.js";
import type { CanvasOperation } from "../canvas/project-ops.js";
import type { RuntimeTask } from "../db.js";
import type { Stores } from "../stores/types.js";
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
            const bindings: Array<Record<string, unknown>> = [];
            for (const shot of shots) {
                const keyframe = published.keyframes[shot.id];
                if (keyframe) {
                    const node = nodes.find((item) => item.id === keyframe.nodeId);
                    const storageKey = keyframe.storageKey || (node ? mediaKey(node) : "");
                    if (storageKey) bindings.push({ id: stableId("binding", group.id, shot.id), assetId: stableId("asset", keyframe.nodeId, storageKey), label: shot.title || "镜头关键帧", role: "storyboard", tags: [], enabled: true, usage: "reference", mediaType: "image", storageKey, sourceNodeId: keyframe.nodeId });
                }
                for (const assetId of shot.assetNodeIds) {
                    const node = nodes.find((item) => item.id === assetId);
                    const storageKey = node ? mediaKey(node) : "";
                    if (storageKey) bindings.push({ id: stableId("binding", group.id, assetId), assetId: stableId("asset", assetId, storageKey), label: String(node?.title || assetId), role: node?.type === "character" ? "character_identity" : node?.type === "scene" ? "scene" : "prop", tags: [], enabled: true, usage: "reference", mediaType: "image", storageKey, sourceNodeId: assetId });
                }
            }
            bindings.sort((left, right) => Number(right.role === "storyboard") - Number(left.role === "storyboard"));
            const taskMode = bindings.length ? "ref2va" : "t2v";
            const visual = shots.map((shot, shotIndex) => `[Shot ${shotIndex + 1}] ${shot.duration} 秒。${shot.visual} 机位：${shot.camera || "保持已确认轴线"}。起始状态：${shot.openingState || "承接上一镜"}；动作变化至：${shot.endingState || "本镜结束状态"}。`).join("\n");
            const referenceManifest = bindings.map((binding, referenceIndex) => `<Picture ${referenceIndex + 1}>：${String(binding.label || binding.sourceNodeId || "参考")}`).join("\n");
            const sound = shots.map((shot) => shot.sound).filter(Boolean).join("；") || "N/A";
            const prompt = taskMode === "ref2va" ? assembleH3Prompt(taskMode, {
                subject_definitions: "画面主体以实际绑定参考为准，保持身份、服装与道具连续。",
                summary: shots.map((shot) => shot.title || shot.visual).join("；"),
                retention_analysis: `${referenceManifest}\n按每张参考的已登记职责保留其外观与空间信息，不复制参考图的无关排版。`,
                detailed_description: visual,
                overall_soundscape: sound,
                non_diegetic_music: "N/A",
            }) : assembleH3Prompt(taskMode, { integrated_multimodal_description: visual, overall_soundscape: sound, non_diegetic_music: "N/A" });
            const segment = { id: segmentId, sourceShotId: group.shotIds.join("~"), title: shots.map((shot) => shot.title).filter(Boolean).join(" / "), duration: Math.max(1, shots.reduce((sum, shot) => sum + shot.duration, 0)), taskMode, prompt, referenceBindings: bindings, status: "idle", ...(h3Model ? { modelName: h3Model } : {}) };
            const node = nodes.find((item) => item.id === nodeId);
            if (node && !isH3NodeType(node.type)) throw new Error(`映射节点 ${nodeId} 不是 H3`);
            const exists = node && Array.isArray(object(node.metadata).segments) && (object(node.metadata).segments as Array<Record<string, unknown>>).some((item) => item.id === segmentId);
            const operations = exists
                ? [{ type: "update_h3_segment", nodeId, segmentId, patch: { sourceShotId: segment.sourceShotId, title: segment.title, duration: segment.duration, taskMode: segment.taskMode, prompt, referenceBindings: bindings, ...(h3Model ? { modelName: h3Model } : {}) } }]
                : node ? [{ type: "add_h3_segment", nodeId, segment }]
                : [{ type: "add_node", id: nodeId, nodeType: "minimax-h3:video", title: `单集 H3 Clips`, position: { x: 0, y: 680 }, width: 1960, height: 1080, metadata: createH3NodeMetadata({}, { segments: [segment] }) }];
            this.stores.projects.applyOperations(episode.canvasId, Number(project.revision || 0), operations, { operationId: stableId("production-sync", episodeId, String(version), group.id, String(project.revision || 0), crypto.createHash("sha256").update(prompt + JSON.stringify(bindings)).digest("hex")), source: { clientId: "episode-production", kind: "system", label: "同步单集 Clip" } });
            this.service.bindRuntime(episodeId, version, { groupId: group.id, nodeId, segmentId });
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
        const imageModelFor = (id: string) => snapshot.settings.imageModels[id] || snapshot.settings.imageModel;
        const h3ModelFor = (id: string) => snapshot.settings.h3Models[id] || snapshot.settings.h3Model;
        if (run.plan.imageShotIds.some((id) => !imageModelFor(id))) throw new Error("缺少图片模型，请在画布节点或配置页选择模型后发布新版本");
        if (run.plan.clipGroupIds.some((id) => !h3ModelFor(id))) throw new Error("缺少 H3 模型，请配置 H3 默认模型后发布新版本");
        if (run.plan.missingAssetNodeIds.length) throw new Error(`缺少资产引用：${run.plan.missingAssetNodeIds.join(", ")}`);
        const episode = this.storesEpisode(episodeId);
        if (!episode.canvasId) throw new Error("分集未绑定画布");
        const projectBefore = this.stores.projects.get(episode.canvasId);
        if (!projectBefore) throw new Error("分集画布不存在");
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
                const prompt = `${shot.visual}\n机位：${shot.camera}\n起始状态：${shot.openingState}\n结束状态：${shot.endingState}`;
                const operations: CanvasOperation[] = nodesOf(project).some((node) => node.id === sourceNodeId)
                    ? [{ type: "update_node", id: sourceNodeId, metadata: { prompt, model: imageModel } }]
                    : [{ type: "add_node", id: sourceNodeId, nodeType: "config", title: shot.title || "关键帧提示词", position: { x, y: -160 }, width: 340, height: 160, metadata: { prompt, model: imageModel, generationMode: "image", productionShotId: shotId } }];
                if (!nodesOf(project).some((node) => node.id === nodeId)) operations.push({ type: "add_node", id: nodeId, nodeType: "image", title: shot.title || shot.visual.slice(0, 24), position: { x, y: 80 }, width: 340, height: 240, metadata: { prompt: shot.visual, status: "idle", productionShotId: shotId } });
                this.stores.projects.applyOperations(episode.canvasId, Number(project.revision || 0), operations, { operationId: stableId("production-frame-prepare", episodeId, String(version), shotId), source: { clientId: "episode-production", kind: "system" } });
                const started = await this.generation.start({ mode: "image", projectId: episode.canvasId, nodeId, sourceNodeId, model: imageModel, prompt, references: referenceSnapshots.get(shotId) || [], resultPolicy: "append", params: { writeBackToTarget: true }, clientTaskId: taskId, idempotencyKey: taskId });
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
        await this.syncClips(episodeId, version, run.plan.clipGroupIds);
        for (const groupId of run.plan.clipGroupIds) {
            const current = this.service.get(episodeId).published!;
            const group = current.clipGroups.find((item) => item.id === groupId);
            if (!group?.nodeId || !group.segmentId) throw new Error(`Clip ${groupId} 未绑定 H3 节点`);
            for (const shotId of group.shotIds) {
                const shot = current.shots.find((item) => item.id === shotId);
                if (shot?.keyframePolicy !== "none" && !current.keyframes[shotId]?.storageKey) throw new Error(`镜头 ${shotId} 缺少可用关键帧参考`);
            }
            const project = this.stores.projects.get(episode.canvasId);
            const node = project && nodesOf(project).find((item) => item.id === group.nodeId);
            const segment = node && (Array.isArray(object(node.metadata).segments) ? object(node.metadata).segments as Array<Record<string, unknown>> : []).find((item) => item.id === group.segmentId);
            if (!segment) throw new Error(`Clip ${groupId} 不存在`);
            if (segment.taskMode !== "t2v" && !(Array.isArray(segment.referenceBindings) && segment.referenceBindings.length)) throw new Error(`Clip ${groupId} 缺少可用参考`);
            const taskId = stableId("production-h3-task", episodeId, String(version), groupId);
            let task = this.stores.tasks.get(taskId);
            if (!task) {
                const started = await this.generation.start({ mode: "video", operation: "h3-run", projectId: episode.canvasId, nodeId: group.nodeId, segmentId: group.segmentId, forceRegenerate: true, idempotencyKey: taskId, params: { modelName: h3ModelFor(groupId) } });
                task = this.stores.tasks.get(started.taskId);
                if (!task) throw new Error("H3 父任务未被 Backend 记录");
            }
            run = this.recordTask(run, "h3", groupId, task.id);
            await this.waitTask(task.id);
            const finished = this.stores.projects.get(episode.canvasId);
            const finishedNode = finished && nodesOf(finished).find((item) => item.id === group.nodeId);
            const finishedSegment = finishedNode && (Array.isArray(object(finishedNode.metadata).segments) ? object(finishedNode.metadata).segments as Array<Record<string, unknown>> : []).find((item) => item.id === group.segmentId);
            if (!finishedSegment?.resultStorageKey) throw new Error(`Clip ${groupId} 任务完成但缺少归档媒体回写`);
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
