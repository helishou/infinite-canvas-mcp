import crypto from "node:crypto";
import { createH3NodeMetadata } from "@basketikun/canvas-agent/plugins/minimax-h3/node-factory";
import { H3_DEFAULTS_KEY } from "@basketikun/canvas-agent/plugins/minimax-h3/runtime-params";
import { isH3NodeType } from "@basketikun/canvas-agent/plugins/minimax-h3/node-factory";
import { buildCharacterGroupFromExistingNode } from "@basketikun/canvas-agent/plugins/minimax-h3/character-groups";
import { assertReferenceCompilation, compileReferenceSubmission } from "@basketikun/canvas-agent/reference-contract";
import { productionSceneEntries, productionImageModel } from "@basketikun/canvas-agent/drama/production-contract";

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
const assetTitle = (source: Record<string, unknown>, id: string) => {
    const items = Array.isArray(source.asset_plan) ? source.asset_plan.map(object) : [];
    const item = items.find(value => String(value.asset_id || value.id || "") === id);
    return String(item?.asset_name || item?.title || item?.name || item?.kind || id);
};
const mediaKey = (node: Record<string, unknown>) => {
    const meta = object(node.metadata);
    return String(resolveCanvasImageReferenceNode(node)[0]?.storageKey || meta.storageKey || "");
};

/** Version-scoped, recoverable task submissions; all media still flows through CanvasGenerationService. */
export class EpisodeProductionRunner {
    private readonly running = new Set<string>();
    constructor(private readonly service: EpisodeProductionService, private readonly stores: Stores, private readonly generation: CanvasGenerationService) {}

    /** Materialize formal targets without publishing or submitting a model request. */
    prepareTargets(id: string, expectedRevision: number, targetIds: string[], operationId: string) {
        const prepared = this.service.beginPreparation(id, operationId, { expectedRevision, targets: targetIds });
        if (prepared.receipt) return { ...prepared.receipt, replayed: true };
        if (prepared.bindings) return this.service.commitPreparation(id, operationId, expectedRevision, prepared.bindings);
        const current = this.service.get(id);
        if (current.revision !== expectedRevision) throw new Error("制作稿版本已变化，请回读后准备节点");
        const director = current.draft.director;
        const canvasId = this.service.episodeInfo(id).canvasId;
        if (!director || !canvasId) throw new Error("缺少正式制作稿或固定画布");
        const bindings: Array<Record<string, unknown>> = [];
        const scenes = productionSceneEntries(director.source);
        for (const target of targetIds) {
            let project = this.stores.projects.get(canvasId)!;
            const [kind, ...parts] = target.split(":");
            const targetId = parts.join(":");
            if (!targetId) throw new Error("缺少准备目标 ID");
            if (kind === "scene") {
                if (!scenes.some(scene => scene.id === targetId)) throw new Error("正式剧本场次不存在");
                continue; // commitPreparation materializes script nodes in the production transaction.
            }
            if (kind === "asset" || kind === "frame") {
                const assetId = kind === "frame" ? director.shotInputs[targetId]?.keyframeAssetId : targetId;
                if (!assetId) throw new Error("镜头未规划关键帧资产");
                const planned = (Array.isArray(director.source.asset_plan) ? director.source.asset_plan : []).map(object).find(item => String(item.asset_id || item.id) === assetId);
                if (!planned && kind === "asset") throw new Error("资产未登记到正式源稿");
                const nodeId = director.assets[assetId]?.nodeId || stableId("production-asset", id, assetId);
                if (!nodesOf(project).some(node => node.id === nodeId)) {
                    const artifact = director.artifacts.find(item => item.kind === "image" && item.targetId === assetId);
                    const scene = kind === "frame" ? scenes.find(item => item.shotIds.includes(targetId)) : undefined;
                    const groupId = scene ? stableId("production-scene", id, scene.id) : undefined;
                    const group = groupId ? nodesOf(project).find(item => item.id === groupId) : undefined;
                    const groupPosition = group?.position as { x: number; y: number } || { x: 0, y: 350 + scenes.indexOf(scene!) * 750 };
                    const operations: CanvasOperation[] = [];
                    if (groupId && !group) operations.push({ type: "add_node", id: groupId, nodeType: "group", title: scene!.title, position: groupPosition, width: 1100, height: 650, metadata: { productionSceneId: scene!.id } });
                    operations.push({ type: "add_node", id: nodeId, nodeType: "image", title: kind === "frame" ? current.draft.shots.find(shot => shot.id === targetId)?.title || assetTitle(director.source, assetId) : assetTitle(director.source, assetId),
                        position: scene ? { x: groupPosition.x + 20 + scene.shotIds.indexOf(targetId) % 3 * 360, y: groupPosition.y + 70 + Math.floor(scene.shotIds.indexOf(targetId) / 3) * 290 } : { x: nodesOf(project).length * 360, y: 0 }, width: 340, height: 260,
                        metadata: { productionAssetId: assetId, ...(kind === "frame" ? { productionShotId: targetId } : {}), ...(groupId ? { groupId } : {}), prompt: artifact?.prompt || "", model: productionImageModel(current.draft.settings, director.source, assetId, kind === "frame" ? "keyframe" : undefined), status: "idle" } });
                    this.stores.projects.applyOperations(canvasId, Number(project.revision || 0), operations,
                        { operationId: `${operationId}:node:${assetId}`, source: { kind: "system", clientId: "production:prepare", label: "准备制作节点" } });
                }
                if (director.assets[assetId]?.nodeId !== nodeId) bindings.push({ type: "bind_director_asset", assetId, nodeId });
            } else if (kind === "segment") {
                const group = current.draft.clipGroups.find(item => item.id === targetId);
                const planned = (Array.isArray(director.source.segments) ? director.source.segments : []).map(object).find(item => item.id === targetId);
                if (!group || !planned) throw new Error("Segment 未登记到正式源稿");
                const nodeId = group.nodeId || stableId("production-h3", id);
                const segmentId = group.segmentId || stableId("clip", id, group.id);
                const node = nodesOf(project).find(item => item.id === nodeId);
                const segments = object(node?.metadata).segments as Record<string, unknown>[] || [];
                if (!segments.some(item => item.id === segmentId)) {
                    const artifact = director.artifacts.find(item => item.kind === "h3" && item.targetId === group.id);
                    const segment = { id: segmentId, title: group.shotIds.map(shotId => current.draft.shots.find(shot => shot.id === shotId)?.title || shotId).join(" / "),
                        sourceShotId: group.shotIds.join("~"), duration: Number(planned.generation_clip_duration || 5), prompt: artifact?.prompt || "", referenceBindings: [], status: "idle",
                        taskMode: ({ T2VA: "t2v", I2VA: "i2v", FL2VA: "fl2v", L2VA: "l2v", Ref2VA: "ref2va" } as Record<string, string>)[String(planned.mode)] || "ref2va" };
                    const operations = node ? [{ type: "add_h3_segment", nodeId, segment }] : [{ type: "add_node", id: nodeId, nodeType: "minimax-h3:video", title: "H3 Clips", position: { x: 0, y: 500 + scenes.length * 750 }, width: 1960, height: 1080,
                        metadata: createH3NodeMetadata(object(this.stores.settings.get(H3_DEFAULTS_KEY)), { segments: [segment] }) }];
                    this.stores.projects.applyOperations(canvasId, Number(project.revision || 0), operations, { operationId: `${operationId}:clip:${group.id}`, source: { kind: "system", clientId: "production:prepare", label: "准备 H3 Clip" } });
                }
                if (group.nodeId !== nodeId || group.segmentId !== segmentId) bindings.push({ type: "bind_director_segment", targetId: group.id, nodeId, segmentId });
            } else throw new Error("准备目标必须为 scene、asset、frame 或 segment");
        }
        const result = this.service.commitPreparation(id, operationId, expectedRevision, bindings);
        const latest = this.service.get(id);
        const published = latest.published?.director;
        if (published && JSON.stringify(published.artifacts) === JSON.stringify(latest.draft.director?.artifacts) && JSON.stringify(published.assets) === JSON.stringify(latest.draft.director?.assets)) {
            const ready = new Set(this.service.workflowReadiness(id, "published").targets.filter(item => item.kind === "segment" && item.status === "ready").map(item => item.targetId));
            const ids = targetIds.filter(target => target.startsWith("segment:")).map(target => target.slice(8)).filter(target => ready.has(target));
            if (ids.length) this.syncClips(id, latest.publishedVersion, ids);
        }
        return result;
    }

    arrangeScene(id: string, sceneId: string, expectedRevision: number, operationId: string) {
        const prepared = this.service.beginPreparation(id, operationId, { sceneId, expectedRevision });
        if (prepared.receipt) return prepared.receipt;
        const current = this.service.get(id);
        if (current.revision !== expectedRevision) throw new Error("制作稿版本已变化，请回读后整理");
        const scene = current.draft.director && productionSceneEntries(current.draft.director.source).find(item => item.id === sceneId);
        const canvasId = this.service.episodeInfo(id).canvasId;
        if (!scene || !canvasId) throw new Error("正式场次不存在");
        const project = this.stores.projects.get(canvasId)!;
        const group = nodesOf(project).find(item => object(item.metadata).productionSceneId === sceneId);
        if (!group) return this.service.commitPreparation(id, operationId, expectedRevision, []);
        const members = nodesOf(project).filter(item => object(item.metadata).groupId === group.id).sort((a, b) => scene.shotIds.indexOf(String(object(a.metadata).productionShotId)) - scene.shotIds.indexOf(String(object(b.metadata).productionShotId)));
        const position = group.position as { x: number; y: number };
        const operations: CanvasOperation[] = members.map((node, index) => ({ type: "update_node", id: node.id, patch: { position: { x: position.x + 20 + index % 3 * 360, y: position.y + 70 + Math.floor(index / 3) * 290 } } }));
        operations.push({ type: "update_node", id: group.id, patch: { width: 1100, height: 70 + Math.max(1, Math.ceil(members.length / 3)) * 290 } });
        this.stores.projects.applyOperations(canvasId, Number(project.revision || 0), operations, { operationId, source: { kind: "system", clientId: "production:arrange", label: "整理当前场次" } });
        return this.service.commitPreparation(id, operationId, expectedRevision, []);
    }

    syncUnsubmittedInputs(id: string) {
        const current = this.service.get(id);
        if (!current.published?.director || current.publishedVersion < 2) return;
        const prior = this.service.version(id, current.publishedVersion - 1).snapshot.director;
        const canvasId = this.service.episodeInfo(id).canvasId;
        const project = canvasId && this.stores.projects.get(canvasId);
        if (!project || !prior) return;
        const ready = new Set(this.service.workflowReadiness(id, "published").targets.filter(target => target.kind === "segment" && target.status === "ready").map(target => target.targetId));
        const ids = current.published.clipGroups.filter(group => {
            if (!ready.has(group.id) || !group.nodeId || !group.segmentId) return false;
            const node = nodesOf(project).find(node => node.id === group.nodeId);
            const clip = (object(node?.metadata).segments as Record<string, any>[] || []).find(clip => clip.id === group.segmentId);
            if (!clip || clip.resultStorageKey || ["running", "loading", "generating"].includes(String(clip.status))) return false;
            const oldArtifact = prior.artifacts.find(artifact => artifact.kind === "h3" && artifact.targetId === group.id);
            const artifact = current.published!.director!.artifacts.find(artifact => artifact.kind === "h3" && artifact.targetId === group.id);
            if (!oldArtifact || !artifact || clip.prompt !== oldArtifact.prompt) return false;
            const refs = Array.isArray(clip.referenceBindings) ? clip.referenceBindings : [];
            return refs.length === oldArtifact.references.length && refs.every((ref: Record<string, any>, index: number) => ref.enabled !== false &&
                ref.sourceNodeId === oldArtifact.references[index].nodeId && [oldArtifact.references[index].storageKey, artifact.references[index]?.storageKey].includes(ref.storageKey));
        }).map(group => group.id);
        if (ids.length) this.syncClips(id, current.publishedVersion, ids);
    }

    async resumePending() {
        for (const batch of this.service.pendingBatches()) void this.runBatch(batch.episodeId, batch.runId);
        for (const run of this.service.pendingRuns()) void this.run(run.episodeId, run.version);
    }

    syncClips(episodeId: string, version: number, groupIds?: string[], runSettings?: Record<string, unknown>) {
        const production = this.service.get(episodeId);
        if (production.publishedVersion !== version || !production.published?.shots.length) throw new Error("只能同步当前已发布镜头表");
        const published = production.published;
        const groups = published.clipGroups.filter((group) => !groupIds || groupIds.includes(group.id));
        const readiness = this.service.workflowReadiness(episodeId, "published");
        const blocked = groups.map(group => readiness.targets.find(item => item.id === `segment:${group.id}`)).filter(item => !item || item.status !== "ready");
        if (blocked.length) throw new Error(blocked.flatMap(item => item?.blockers || ["Segment 缺少就绪视图"] ).join("；"));
        this.service.validateExecution(episodeId, version, groups.map(group => group.id));
        const episode = this.storesEpisode(episodeId);
        if (!episode.canvasId) throw new Error("分集尚未绑定画布");
        for (const group of groups) {
            const project = this.stores.projects.get(episode.canvasId);
            if (!project) throw new Error("分集画布不存在");
            const nodes = nodesOf(project);
            const nodeId = group.nodeId || stableId("production-h3", episodeId);
            const segmentId = group.segmentId || stableId("clip", episodeId, group.id);
            const shots = group.shotIds.map((id) => published.shots.find((shot) => shot.id === id)).filter((shot): shot is NonNullable<typeof shot> => !!shot);
            const settings = runSettings || published.settings as unknown as Record<string, unknown>;
            const h3Models = object(settings.h3Models);
            const h3Model = String(h3Models[group.id] || settings.h3Model || "");
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
            // A partial set of opening anchors is not a per-shot storyboard table.
            // The compiled prompt retains those scoped anchors and the complete motion timeline.
            const storyboardShots = shots.every(shot => d.shotInputs[shot.id]?.keyframeAssetId && d.shotInputs[shot.id]?.keyframePolicy !== "none") ? shots.map(shot => {
                const input = d.shotInputs[shot.id];
                const asset = input?.keyframeAssetId && d.assets[input.keyframeAssetId];
                const sourceNodeId = asset && asset.nodeId || input?.keyframeAssetId;
                const binding = bindings.find(ref => ref.sourceNodeId === sourceNodeId);
                if (!binding) throw new Error(`镜头 ${shot.id} 的正式关键帧未进入本段参考绑定`);
                binding.role = 'storyboard';
                return { id: shot.id, referenceBindingId: String(binding.id), duration: shot.duration };
            }) : undefined;
            const segment = { id: segmentId, sourceShotId: group.shotIds.join("~"), title: shots.map(shot => shot.title).join(" / "),
                duration: shots.reduce((sum, shot) => sum + shot.duration, 0), taskMode, prompt, referenceBindings: bindings,
                tailFrameContinuation: boundary?.tailFrame === true, motionContextEnabled: boundary?.motionContext === true,
                directorEngine: d.engine, directorSourceHash: d.sourceHash, styleTemplateId: null, h3CharacterGroups: characterGroups,
                ...(storyboardShots ? { storyboardShots } : {}),
                ...(settings.videoAspectRatio ? { aspectRatio: settings.videoAspectRatio } : {}),
                ...(h3Model ? { modelName: h3Model } : {}) };
            const preflight = compileReferenceSubmission(project, segment);
            assertReferenceCompilation(preflight);
            if (preflight.compiledPrompt !== prompt) throw new Error(`Segment ${group.id} 的参考顺序需要重新绑定并编译；不能自动改写正式正文`);
            const node = nodes.find((item) => item.id === nodeId);
            if (node && !isH3NodeType(node.type)) throw new Error(`映射节点 ${nodeId} 不是 H3`);
            const exists = node && Array.isArray(object(node.metadata).segments) && (object(node.metadata).segments as Array<Record<string, unknown>>).some((item) => item.id === segmentId);
            const operations = exists
                ? [{ type: "update_h3_segment", nodeId, segmentId, patch: { sourceShotId: segment.sourceShotId, title: segment.title, duration: segment.duration, taskMode: segment.taskMode, prompt, referenceBindings: bindings, tailFrameContinuation: segment.tailFrameContinuation, motionContextEnabled: segment.motionContextEnabled, directorEngine: segment.directorEngine, directorSourceHash: segment.directorSourceHash, styleTemplateId: null, h3CharacterGroups: characterGroups, ...(storyboardShots ? { storyboardShots } : {}), } }]
                : node ? [{ type: "add_h3_segment", nodeId, segment }]
                : [{ type: "add_node", id: nodeId, nodeType: "minimax-h3:video", title: `单集 H3 Clips`, position: { x: 0, y: 680 }, width: 1960, height: 1080, metadata: createH3NodeMetadata(object(this.stores.settings.get(H3_DEFAULTS_KEY)), { segments: [segment] }) }];
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

    async runBatch(episodeId: string, runId: string) {
        const key = `${episodeId}:run:${runId}`;
        if (this.running.has(key)) return;
        const run = this.service.batchForRun(episodeId, runId);
        if (!run || !["pending", "running"].includes(run.status)) return;
        this.running.add(key);
        try { await this.execute(episodeId, run.version, run); }
        catch (error) {
            const latest = this.service.batchForRun(episodeId, runId);
            if (latest) {
                const paused = this.service.batchPauseRequested(episodeId, runId);
                this.service.updateRun({ ...latest, status: paused ? "paused" : (error as { code?: string })?.code === "SHARED_ASSET_UPDATE" ? "awaiting_review" : "failed", error: error instanceof Error ? error.message : String(error) });
            }
        } finally { this.running.delete(key); }
    }

    private async execute(episodeId: string, version: number, batchRun?: ProductionRun) {
        let run = batchRun || this.service.run(episodeId, version);
        if (!run || !["pending", "running", "awaiting_review", "paused"].includes(run.status)) return;
        const production = this.service.get(episodeId);
        if (production.publishedVersion !== version || !production.published) throw new Error("已有更新的发布版本");
        const snapshot = production.published;
        if (!snapshot.director) throw new Error("缺少 Acheng 制作稿");
        if (!run.runId && !snapshot.director.executionAuthorized) throw new Error("缺少 Acheng 生产执行授权");
        if (!run.runId && snapshot.director.unresolved.length) throw new Error(snapshot.director.unresolved.join("；"));
        if (run.engine && JSON.stringify(run.engine) !== JSON.stringify(snapshot.director.engine)) throw new Error("运行批次固定引擎与已发布导演稿不一致");
        const runSettings = run.settings || snapshot.settings as unknown as Record<string, unknown>;
        const imageModels = object(runSettings.imageModels), h3Models = object(runSettings.h3Models);
        const selectedAssetIds = new Set((run.targets || []).filter(id => id.startsWith("asset:")).map(id => id.slice("asset:".length)));
        const artifactTargets = (run.targets || []).flatMap(id => {
            if (id.startsWith("asset:")) return [id.slice("asset:".length)];
            if (id.startsWith("frame:")) return snapshot.director!.shotInputs[id.slice("frame:".length)]?.keyframeAssetId ? [snapshot.director!.shotInputs[id.slice("frame:".length)].keyframeAssetId!] : [];
            if (id.startsWith("segment:")) return [id.slice("segment:".length)];
            return [];
        });
        this.service.validateExecution(episodeId, version, artifactTargets.length ? artifactTargets : undefined);
        this.checkPause(run);
        const imageModelFor = (id: string) => productionImageModel({ imageModels, imageModelsByKind: object(runSettings.imageModelsByKind), imageModel: String(runSettings.imageModel || "") }, snapshot.director!.source, id, Object.values(snapshot.director!.shotInputs).some(input => input.keyframeAssetId === id) ? "keyframe" : undefined);
        const h3ModelFor = (id: string) => String(h3Models[id] || runSettings.h3Model || "");
        const episode = this.storesEpisode(episodeId);
        if (!episode.canvasId) throw new Error("分集未绑定画布");
        const projectBefore = this.stores.projects.get(episode.canvasId);
        if (!projectBefore) throw new Error("分集画布不存在");
        // Assets are authored by Acheng. Execute only ready dependency leaves;
        // review and recompilation of downstream prompts remain Agent work.
        const keyframeAssets = new Set(Object.values(snapshot.director.shotInputs).map(s => s.keyframeAssetId).filter(Boolean));
        const assetTasks = snapshot.director.artifacts.filter(a => a.kind === "image" && a.status === "ready" && !keyframeAssets.has(a.targetId)
            && (!run!.runId || selectedAssetIds.has(a.targetId)) && [undefined, "planned", "rejected"].includes(snapshot.director!.assets[a.targetId]?.status));
        for (const artifact of assetTasks) {
            this.checkPause(run);
            if (run.submitted.some(item => item.kind === "image" && item.id === artifact.targetId && item.status === "succeeded")) continue;
            const asset = snapshot.director.assets[artifact.targetId];
            const nodeId = asset?.nodeId || stableId("production-asset", episodeId, artifact.targetId);
            let assetProject = this.stores.projects.get(episode.canvasId);
            if (!assetProject) throw new Error("分集画布不存在");
            let node = nodesOf(assetProject).find(n => n.id === nodeId);
            if (!node) {
                this.stores.projects.applyOperations(episode.canvasId, Number(assetProject.revision || 0), [{ type: "add_node", id: nodeId, nodeType: "image", title: assetTitle(snapshot.director.source, artifact.targetId), position: { x: nodesOf(assetProject).length * 360, y: 0 }, width: 340, height: 260,
                    metadata: { prompt: artifact.prompt, status: "idle", productionAssetId: artifact.targetId, productionVersion: version } }], { operationId: stableId("production-asset-node", episodeId, String(version), artifact.targetId), source: { clientId: "episode-production", kind: "system", label: "准备 Acheng 资产" } });
                assetProject = this.stores.projects.get(episode.canvasId);
                node = assetProject ? nodesOf(assetProject).find(n => n.id === nodeId) : undefined;
            }
            if (!node) throw new Error(`资产 ${artifact.targetId} 画布节点创建失败`);
            const model = imageModelFor(artifact.targetId) || String(object(node.metadata).model || "");
            if (!model) throw new Error(`资产 ${artifact.targetId} 缺少图片模型`);
            const taskId = stableId("production-asset-task", run.runId || `${episodeId}:${version}`, artifact.targetId);
            let task = this.stores.tasks.get(taskId);
            if (!task) {
                this.service.validateExecution(episodeId, version, [artifact.targetId]);
                const result = await this.generation.start({ mode: "image", projectId: episode.canvasId, nodeId, model, prompt: artifact.prompt,
                    references: artifact.references.map(r => ({ storageKey: r.storageKey, sourceNodeId: r.nodeId, role: r.role, type: "image" })),
                    params: { writeBackToTarget: true }, idempotencyKey: taskId }, { productionManaged: true });
                task = this.stores.tasks.get(result.taskId);
                if (!task) throw new Error("资产任务未记录");
            }
            run = this.recordTask(run, "image", artifact.targetId, task.id, { projectId: episode.canvasId, nodeId });
            await this.waitTask(task.id);
            run = this.markTaskStatus(run, task.id, "succeeded");
            this.checkPause(run);
            const actual = this.stores.projects.get(episode.canvasId);
            const outputNode = actual && nodesOf(actual).find(n => n.id === nodeId);
            const key = outputNode ? mediaKey(outputNode) : "";
            if (!key) throw new Error(`资产 ${artifact.targetId} 未回写媒体`);
            this.service.bindDirectorAsset(episodeId, version, artifact.targetId, key);
        }
        if (assetTasks.length || (!run.runId && Object.values(snapshot.director.assets).some(asset => asset.status === "generated"))) {
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
            this.checkPause(run);
            if (run.submitted.some(item => item.kind === "image" && item.id === shotId && item.status === "succeeded")) continue;
            const imageModel = imageModelFor(shotId);
            const shot = snapshot.shots.find((item) => item.id === shotId);
            if (!shot) continue;
            const taskId = stableId("production-image-task", run.runId || `${episodeId}:${version}`, shotId);
            let task = this.stores.tasks.get(taskId);
            if (!task) {
                const project = this.stores.projects.get(episode.canvasId);
                if (!project) throw new Error("画布不存在");
                const nodeId = snapshot.keyframes[shotId]?.nodeId || snapshot.director.assets[snapshot.director.shotInputs[shotId]?.keyframeAssetId || ""]?.nodeId || stableId("production-frame", episodeId, shotId);
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
                this.service.validateExecution(episodeId, version, [keyframeAsset]);
                const started = await this.generation.start({ mode: "image", projectId: episode.canvasId, nodeId, sourceNodeId, model: imageModel, prompt, references: imageArtifact.references.map(r => ({ storageKey: r.storageKey, sourceNodeId: r.nodeId, role: r.role, type: "image" })), resultPolicy: "append", params: { writeBackToTarget: true }, clientTaskId: taskId, idempotencyKey: taskId }, { productionManaged: true });
                task = this.stores.tasks.get(started.taskId);
                if (!task) throw new Error("图片任务未被 Backend 记录");
            }
            const nodeId = snapshot.keyframes[shotId]?.nodeId || snapshot.director.assets[snapshot.director.shotInputs[shotId]?.keyframeAssetId || ""]?.nodeId || stableId("production-frame", episodeId, shotId);
            run = this.recordTask(run, "image", shotId, task.id, { projectId: episode.canvasId, nodeId });
            task = await this.waitTask(task.id);
            run = this.markTaskStatus(run, task.id, "succeeded");
            this.checkPause(run);
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
        const rejected = run.plan.imageShotIds.find((shotId) => ["needs-redo", "rejected"].includes(latest.keyframeReviews[shotId]?.verdict || ""));
        if (rejected) throw new Error(`镜头 ${rejected} 的关键帧自检要求返修；未提交后续 H3`);
        const unreviewed = run.plan.imageShotIds.filter((shotId) => !["auto-accepted", "approved"].includes(latest.keyframeReviews[shotId]?.verdict || "") || latest.keyframeReviews[shotId]?.sourceVersion !== version);
        if (unreviewed.length) {
            this.service.updateRun({ ...run, status: "awaiting_review", error: `等待 Agent 查看关键帧并记录视觉自检：${unreviewed.join(", ")}` });
            return;
        }
        if (!run.runId && snapshot.clipGroups.some(g => !snapshot.director!.artifacts.some(a => a.kind === "h3" && a.targetId === g.id && a.status === "ready"))) {
            this.service.updateRun({ ...run, status: "awaiting_review", error: "等待 Acheng 完成当前素材版本的 H3 编译" });
            return;
        }
        const submitted = run.submitted;
        const pendingClipIds = run.plan.clipGroupIds.filter(id => !submitted.some(item => item.kind === "h3" && item.id === id && item.status === "succeeded"));
        if (pendingClipIds.length) await this.syncClips(episodeId, version, pendingClipIds, runSettings);
        const current = this.service.get(episodeId).published!;
        const groups = current.clipGroups;
        const required = new Set(pendingClipIds);
        const boundaries = current.director!.boundaries;
        const chains: typeof groups[] = [];
        for (let i = 0; i < groups.length; i++) {
            const chain = [groups[i]];
            while (i + 1 < groups.length && boundaries.some(b => b.from === groups[i].id && b.to === groups[i + 1].id && b.motionContext)) chain.push(groups[++i]);
            if (chain.some(g => required.has(g.id))) chains.push(chain);
        }
        for (const chain of chains) {
            this.checkPause(run);
            const head = chain[0], tail = chain[chain.length - 1];
            if (!head.nodeId || !head.segmentId || chain.some(g => g.nodeId !== head.nodeId || !g.segmentId)) throw new Error("连续组必须绑定同一个 H3 节点");
            for (const group of chain) {
                directorArtifact(current, "h3", group.id);
                for (const shotId of group.shotIds) {
                    const shot = current.shots.find(s => s.id === shotId);
                    if (shot?.keyframePolicy !== "none" && !current.keyframes[shotId]?.storageKey) throw new Error(`镜头 ${shotId} 缺少可用关键帧参考`);
                }
            }
            const taskId = stableId("production-h3-task", run.runId || `${episodeId}:${version}`, ...chain.map(g => g.id));
            let task = this.stores.tasks.get(taskId);
            if (!task) {
                this.service.validateExecution(episodeId, version, chain.map(group => group.id));
                const started = await this.generation.start({ mode: "video", operation: "h3-run", projectId: episode.canvasId,
                    nodeId: head.nodeId, segmentId: head.segmentId, endSegmentId: tail.segmentId!,
                    runFromCurrent: chain.length > 1, skipCompleted: false, forceRegenerate: true,
                    idempotencyKey: taskId }, { productionManaged: true });
                task = this.stores.tasks.get(started.taskId);
                if (!task) throw new Error("H3 父任务未被 Backend 记录");
            }
            for (const group of chain) run = this.recordTask(run, "h3", group.id, task.id, { projectId: episode.canvasId, nodeId: head.nodeId, segmentId: group.segmentId || undefined });
            await this.waitTask(task.id);
            run = this.markTaskStatus(run, task.id, "succeeded");
            this.checkPause(run);
            const finished = this.stores.projects.get(episode.canvasId);
            const node = finished && nodesOf(finished).find(n => n.id === head.nodeId);
            for (const group of chain) {
                const segment = (object(node?.metadata).segments as Array<Record<string, unknown>> || []).find(s => s.id === group.segmentId);
                if (!segment?.resultStorageKey || !this.stores.media.meta(String(segment.resultStorageKey))) throw new Error(`Clip ${group.id} 缺少归档媒体回写`);
                this.service.bindRuntime(episodeId, version, { groupId: group.id, nodeId: head.nodeId, segmentId: group.segmentId!, completed: true });
            }
        }
        this.service.updateRun({ ...run, status: "succeeded", error: null });
    }

    private recordTask(run: ProductionRun, kind: "image" | "h3", id: string, taskId: string, context: { projectId: string; nodeId: string; segmentId?: string }) {
        const existing = run.submitted.findIndex(item => item.kind === kind && item.id === id);
        const entry = { kind, id, taskId, ...context, status: "running" as const };
        if (existing >= 0 && run.submitted[existing].taskId === taskId && run.submitted[existing].nodeId === context.nodeId && run.submitted[existing].segmentId === context.segmentId && run.submitted[existing].status === "running") return run;
        const submitted = [...run.submitted];
        if (existing >= 0) submitted[existing] = { ...submitted[existing], ...entry };
        else submitted.push(entry);
        const next = { ...run, submitted };
        this.service.updateRun(next);
        if (run.runId) {
            const current = this.service.get(run.episodeId), work = current.draft.director?.workflow.currentWork;
            if (work?.runId === run.runId && work.action === "produce") {
                const targetKind = kind === "h3" ? "segment" : run.plan.imageShotIds.includes(id) ? "keyframe" : "asset";
                this.service.edit(run.episodeId, { operationId: `work-task:${run.runId}:${taskId}:${id}`, expectedRevision: current.revision,
                    ops: [{ type: "set_director_workflow", patch: { currentWork: { ...work, taskId: undefined, module: kind === "h3" ? "model" : "assets", targetKind, targetId: id, inputRevision: current.revision + 1, sourceHash: current.draft.director!.sourceHash } } }] });
            }
        }
        return next;
    }
    private markTaskStatus(run: ProductionRun, taskId: string, status: "succeeded" | "failed") {
        const submitted = run.submitted.map(item => item.taskId === taskId ? { ...item, status } : item);
        if (submitted.every((item, index) => item.status === run.submitted[index]?.status)) return run;
        const next = { ...run, submitted };
        this.service.updateRun(next);
        return next;
    }
    private checkPause(run: ProductionRun) {
        if (run.runId && this.service.batchPauseRequested(run.episodeId, run.runId)) throw new Error("生产运行已暂停；可从原 runId 恢复未提交工作");
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
