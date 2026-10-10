import crypto from "node:crypto";
import { formalClipOrderOperations } from "./clip-order.js";
import { inputHash, type CanvasExecutionTarget } from "./canvas-inputs.js";
import { createH3NodeMetadata } from "@basketikun/canvas-agent/plugins/minimax-h3/node-factory";
import { H3_DEFAULTS_KEY } from "@basketikun/canvas-agent/plugins/minimax-h3/runtime-params";
import { isH3NodeType } from "@basketikun/canvas-agent/plugins/minimax-h3/node-factory";
import { canonicalProduction, isSubjectPromptAssembly, productionSceneEntries, productionImageModel, type ProductionLayoutPlan, type ProductionLayoutUnit, type ProductionLayoutReceipt } from "@basketikun/canvas-agent/drama/production-contract";

import type { CanvasGenerationService } from "../canvas/generation-service.js";
import { resolveCanvasImageReferenceNode } from "../canvas/image-references.js";
import type { CanvasOperation } from "../canvas/project-ops.js";
import type { RuntimeTask } from "../db.js";
import type { Stores } from "../stores/types.js";
import { directorArtifact, validateDirectorMedia } from "./director.js";
import { EpisodeProductionService, type ProductionRecord, type ProductionRun } from "./production.js";
import { verifyImageInput } from "./image-inputs.js";
import { productionClipProjection, clipInputHash, CLIP_PROJECTION_FIELDS, type ReferenceSync } from "./clip-inputs.js";
import { productionSceneIdsForShots, productionSceneLayout } from "./production-layout.js";

const stableId = (kind: string, ...parts: string[]) => `${kind}-${crypto.createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 24)}`;
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const nodesOf = (project: Record<string, unknown>) => Array.isArray(project.nodes) ? project.nodes as Array<Record<string, unknown>> : [];
/** Snapshot the bound node's image inputs before the task is created. */
export function productionImageParams(node: Record<string, unknown> | undefined): Record<string, unknown> {
    const metadata = object(node?.metadata);
    const params = { ...object(metadata.comfyParams) };
    for (const key of ["size", "quality", "count"]) {
        if (metadata[key] !== undefined) params[key] = metadata[key];
    }
    return structuredClone({ ...params, writeBackToTarget: true });
}
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

    /** Materialize formal targets from the frozen whole-production layout without publishing or generating. */
    prepareTargets(id: string, expectedRevision: number, targetIds: string[], operationId: string): ProductionRecord & { replayed?: boolean; layoutReceipt?: ProductionLayoutReceipt; referenceSync?: ReferenceSync[] } {
        let validated = false;
        const validate = () => {
            const fresh = this.service.get(id);
            if (fresh.revision !== expectedRevision) throw new Error("制作稿版本已变化，请回读后准备节点");
            const director = fresh.draft.director;
            if (!director) throw new Error("缺少正式制作稿");
            this.service.preparationCanvas(id);
            if (!targetIds.length) throw new Error("缺少准备目标");
            const sharedOwner = this.service.isSharedAssetCanvas(id);
            const plans = Array.isArray(director.source.asset_plan) ? director.source.asset_plan.map(object) : [];
            const skipStoryboardImages = fresh.draft.settings.storyboardImageMode === "skip";
            const keyframeAssetIds = new Set(Object.values(director.shotInputs).map(input => input.keyframeAssetId).filter(Boolean));
            for (const target of [...new Set(targetIds)]) {
                const [kind, ...parts] = target.split(":"), targetId = parts.join(":");
                if (!targetId || !["scene", "asset", "frame", "segment"].includes(kind)) throw new Error("准备目标必须为 scene、asset、frame 或 segment，并包含稳定目标 ID");
                const plannedAsset = plans.find(item => String(item.asset_id || item.id || "") === targetId);
                const planKind = String(plannedAsset?.kind || plannedAsset?.asset_type || "").toLowerCase();
                if (skipStoryboardImages && (kind === "frame" || kind === "asset" && (keyframeAssetIds.has(targetId) || ["keyframe", "storyboard", "frame"].includes(planKind)))) throw new Error("当前已选择跳过分镜图，不能准备关键帧图片目标");
                if (kind === "asset") {
                    const plan = plannedAsset;
                    if (!plan) throw new Error(`正式源稿中不存在资产 ${targetId}`);
                    const scope = String(plan.canvas_scope || (director.assets[targetId]?.sharedSource || sharedOwner ? "shared" : "episode"));
                    if (scope !== (sharedOwner ? "shared" : "episode")) throw new Error(sharedOwner ? `资产 ${targetId} 属于本集专用，不能在共享资产画布准备` : `资产 ${targetId} 属于剧目共享；请在共享资产画布准备源资产，再由本集采用批准版本`);
                } else if (kind === "segment") {
                    if (sharedOwner) throw new Error("剧目共享资产画布只准备可复用资产；关键帧和视频 Clip 应在分集画布准备");
                    const group = fresh.draft.clipGroups.find(item => item.id === targetId);
                    const planned = (Array.isArray(director.source.segments) ? director.source.segments : []).map(object).find(item => item.id === targetId);
                    if (!group || !planned) throw new Error("Segment 未登记到正式源稿");
                    const scenes = productionSceneEntries(director.source);
                    const sceneIds = productionSceneIdsForShots(scenes, group.shotIds);
                    if (!group.nodeId && sceneIds.length !== 1) throw new Error(sceneIds.length ? `Segment ${targetId} 跨越多个场次；请先按场次拆分` : `Segment ${targetId} 未映射到唯一正式场次，无法准备场次 H3 节点`);
                } else if (sharedOwner && kind === "frame") {
                    throw new Error("剧目共享资产画布只准备可复用资产；关键帧和视频 Clip 应在分集画布准备");
                } else if (kind === "frame") {
                    if (!director.shotInputs[targetId]?.keyframeAssetId) throw new Error("镜头未规划关键帧资产");
                } else if (kind === "scene") {
                    if (!productionSceneEntries(director.source).some(scene => scene.id === targetId)) throw new Error("正式剧本场次不存在");
                }
            }
            validated = true;
        };
        const prepared = this.service.beginPreparation(id, operationId, { expectedRevision, targets: targetIds }, validate);
        if (prepared.receipt) return { ...prepared.receipt, replayed: true };
        if (!validated) validate();
        const current = this.service.get(id);
        if (current.revision !== expectedRevision) throw new Error("制作稿版本已变化，请回读后准备节点");
        const director = current.draft.director;
        const canvasId = this.service.preparationCanvas(id, true);
        if (!director || !canvasId) throw new Error("缺少正式制作稿或固定画布");
        const project = this.stores.projects.get(canvasId) as (Record<string, unknown> & { nodes: Record<string, any>[] }) | null;
        if (!project) throw new Error("分集画布不存在");
        const bindings: Array<Record<string, unknown>> = [];
        const referenceSync: ReferenceSync[] = [];
        const frozen = this.service.preparationLayout(operationId);
        const compiled = frozen?.plan || this.service.ensureLayoutPlan(id, current);
        const locate = (target: string, role?: string) => compiled.units.find(unit => unit.targets.includes(target) && (!role || unit.members.some(member => member.role === role)));
        const requested = new Map<string, ProductionLayoutUnit>();
        const sceneIds = new Set<string>();
        const add = (unit?: ProductionLayoutUnit) => { if (unit) requested.set(unit.id, unit); };
        for (const target of [...new Set(targetIds)]) {
            const [kind, ...parts] = target.split(":"), targetId = parts.join(":");
            if (!targetId) throw new Error("缺少准备目标 ID");
            if (kind === "scene") {
                if (!productionSceneEntries(director.source).some(scene => scene.id === targetId)) throw new Error("正式剧本场次不存在");
                sceneIds.add(targetId);
            } else if (kind === "asset") {
                const planned = (Array.isArray(director.source.asset_plan) ? director.source.asset_plan : []).map(object).find(item => String(item.asset_id || item.id) === targetId);
                if (!planned) throw new Error("资产未登记到正式源稿");
                const unit = locate(target, "asset") || locate(target, "keyframe");
                if (!unit) throw new Error(`正式布局中缺少资产目标 ${target}`);
                add(unit);
            } else if (kind === "frame") {
                const assetId = director.shotInputs[targetId]?.keyframeAssetId;
                if (!assetId) throw new Error("镜头未规划关键帧资产");
                const unit = locate(target, "keyframe");
                const prompt = locate(`frame-prompt:${targetId}`, "prompt");
                if (!unit || !prompt) throw new Error(`正式布局中缺少关键帧目标 ${target}`);
                add(unit); add(prompt);
                if (unit.sceneId) { sceneIds.add(unit.sceneId); add(locate(`scene:${unit.sceneId}`, "scene")); }
                if (prompt.sceneId) { sceneIds.add(prompt.sceneId); add(locate(`scene:${prompt.sceneId}`, "scene")); }
            } else if (kind === "segment") {
                const group = current.draft.clipGroups.find(item => item.id === targetId);
                const planned = (Array.isArray(director.source.segments) ? director.source.segments : []).map(object).find(item => item.id === targetId);
                if (!group || !planned) throw new Error("Segment 未登记到正式源稿");
                const unit = locate(target, "video");
                if (!unit) throw new Error(`正式布局中缺少视频目标 ${target}`);
                add(unit);
                if (unit.sceneId) { sceneIds.add(unit.sceneId); add(locate(`scene:${unit.sceneId}`, "scene")); }
            } else throw new Error("准备目标必须为 scene、asset、frame 或 segment");
        }
        for (const sceneId of sceneIds) for (const unit of compiled.units) if (unit.area === "script" && unit.sceneId === sceneId) add(unit);
        const units = frozen?.plan.units || compiled.units;
        const plan = frozen?.plan || compiled;
        const canvasOps: CanvasOperation[] = [];
        const plannedNodeIds = new Set(nodesOf(project).map(node => node.id));
        const sceneById = new Map(productionSceneEntries(director.source).map(scene => [scene.id, scene]));
        const selectedUnits = [...requested.keys()].map(unitId => units.find(unit => unit.id === unitId)).filter((unit): unit is ProductionLayoutUnit => Boolean(unit));
        for (const unit of selectedUnits) {
            for (const member of unit.members) {
                if (member.role !== "scene") continue;
                const existing = nodesOf(project).find(node => node.id === member.nodeId);
                if (existing) {
                    const metadata = { productionLayoutUnitId: unit.id, productionLayoutBounds: unit.bounds.size };
                    if (existing.width !== member.size.width || existing.height !== member.size.height || object(existing.metadata).productionLayoutUnitId !== unit.id) {
                        canvasOps.push({ type: "update_node", id: member.nodeId, patch: { width: Math.max(Number(existing.width || 0), member.size.width), height: Math.max(Number(existing.height || 0), member.size.height) }, metadata });
                    }
                    plannedNodeIds.add(member.nodeId);
                    continue;
                }
                const scene = sceneById.get(unit.sceneId || "");
                canvasOps.push({ type: "add_node", id: member.nodeId, nodeType: "group", title: scene?.title || unit.sceneId || "制作场次", position: member.position, width: member.size.width, height: member.size.height, metadata: { productionSceneId: unit.sceneId, productionLayoutUnitId: unit.id, productionLayoutBounds: unit.bounds.size } });
                plannedNodeIds.add(member.nodeId);
            }
        }
        const assetTitleFor = (assetId: string) => assetTitle(director.source, assetId);
        for (const target of [...new Set(targetIds)]) {
            const [kind, ...parts] = target.split(":"), targetId = parts.join(":");
            if (kind === "scene") continue;
            if (kind === "asset" || kind === "frame") {
                const assetId = kind === "frame" ? director.shotInputs[targetId]?.keyframeAssetId : targetId;
                if (!assetId) throw new Error(`布局目标 ${target} 缺少正式资产映射`);
                const unit = selectedUnits.find(item => item.targets.includes(`asset:${assetId}`) || item.targets.includes(`frame:${targetId}`));
                const member = unit?.members.find(item => item.role === "asset" || item.role === "keyframe");
                if (!unit || !member) throw new Error(`布局目标 ${target} 没有对应图片节点`);
                const smartImage = isSubjectPromptAssembly(director.source);
                const existingImage = nodesOf(project).find(node => node.id === member.nodeId);
                if (smartImage && existingImage && (existingImage.type !== "config" || object(existingImage.metadata).smart !== true || (object(existingImage.metadata).generationMode || "image") !== "image")) {
                    const metadata = object(existingImage.metadata);
                    const hasMedia = metadata.storageKey || metadata.content || (Array.isArray(metadata.images) && metadata.images.length);
                    if (hasMedia || metadata.productionAssetId !== assetId || (metadata.generationMode && metadata.generationMode !== "image")) throw new Error(`SUBJECT_IMAGE_NODE_UPGRADE_REQUIRED: ${member.nodeId} 含已有内容，需显式选择智能图片来源`);
                    canvasOps.push({ type: "update_node", id: member.nodeId, patch: { type: "config" }, metadata: { smart: true, generationMode: "image", composerContent: metadata.composerContent ?? metadata.prompt ?? "" } });
                }
                if (!plannedNodeIds.has(member.nodeId)) {
                    const artifact = director.artifacts.find(item => item.kind === "image" && item.targetId === assetId);
                    const scene = kind === "frame" ? productionSceneEntries(director.source).find(item => item.id === unit.sceneId) : undefined;
                    canvasOps.push({ type: "add_node", id: member.nodeId, nodeType: smartImage ? "config" : member.nodeType, title: kind === "frame" ? current.draft.shots.find(shot => shot.id === targetId)?.title || assetTitleFor(assetId!) : assetTitleFor(assetId!), position: member.position, width: member.size.width, height: member.size.height,
                        metadata: { ...(smartImage ? { smart: true, generationMode: "image", composerContent: artifact?.prompt || "" } : {}), productionAssetId: assetId, ...(kind === "frame" && !unit.targets.includes(`asset:${assetId}`) ? { productionShotId: targetId } : {}), ...(scene ? { groupId: stableId("production-scene", id, scene.id) } : {}), prompt: artifact?.prompt || "", model: productionImageModel(current.draft.settings, director.source, assetId!, kind === "frame" ? "keyframe" : undefined), status: "idle", productionLayoutUnitId: unit.id, productionLayoutBounds: member.size } });
                    plannedNodeIds.add(member.nodeId);
                }
                if (director.assets[assetId]?.nodeId !== member.nodeId) bindings.push({ type: "bind_director_asset", assetId, nodeId: member.nodeId });
                if (kind === "frame") {
                    const promptUnit = selectedUnits.find(item => item.targets.includes(`frame-prompt:${targetId}`));
                    const promptMember = promptUnit?.members.find(item => item.role === "prompt");
                    if (!promptUnit || !promptMember) throw new Error(`布局目标 frame:${targetId} 缺少提示词节点`);
                    if (!plannedNodeIds.has(promptMember.nodeId)) {
                        const artifact = director.artifacts.find(item => item.kind === "image" && item.targetId === assetId);
                        const scene = productionSceneEntries(director.source).find(item => item.id === promptUnit.sceneId);
                        canvasOps.push({ type: "add_node", id: promptMember.nodeId, nodeType: promptMember.nodeType, title: current.draft.shots.find(shot => shot.id === targetId)?.title || "关键帧提示词", position: promptMember.position, width: promptMember.size.width, height: promptMember.size.height,
                            metadata: { prompt: artifact?.prompt || "", model: productionImageModel(current.draft.settings, director.source, assetId!, "keyframe"), generationMode: "image", productionShotId: targetId, ...(scene ? { groupId: stableId("production-scene", id, scene.id) } : {}), productionLayoutUnitId: promptUnit.id, productionLayoutBounds: promptUnit.bounds.size } });
                        plannedNodeIds.add(promptMember.nodeId);
                    }
                }
            } else if (kind === "segment") {
                const group = current.draft.clipGroups.find(item => item.id === targetId)!;
                const planned = (Array.isArray(director.source.segments) ? director.source.segments : []).map(object).find(item => item.id === targetId)!;
                const unit = selectedUnits.find(item => item.targets.includes(target));
                const member = unit?.members.find(item => item.role === "video");
                if (!unit || !member) throw new Error(`布局目标 ${target} 没有 H3 节点`);
                const segmentId = group.segmentId || stableId("clip", id, group.id);
                const existingNode = nodesOf(project).find(node => node.id === member.nodeId);
                const existingSegments = object(existingNode?.metadata).segments as Array<Record<string, unknown>> || [];
                const existing = existingSegments.find(item => item.id === segmentId);
                let projected = productionClipProjection(project, current.draft, group, segmentId, existing);
                if (projected.segment) {
                    try { this.service.validateClipMedia(id, current.draft.director!, group.id); }
                    catch (error) { projected = { result: { targetId: group.id, status: "blocked", referenceCount: 0, diagnostics: [{ code: "REFERENCE_NOT_APPROVED", message: String(error) }] } }; }
                }
                referenceSync.push(projected.result);
                const segment: Record<string, any> = projected.segment || { id: segmentId, title: group.id, duration: Number(planned.generation_clip_duration || 5), prompt: "", referenceBindings: [], status: "idle", taskMode: ({ T2VA: "t2v", I2VA: "i2v", FL2VA: "fl2v", L2VA: "l2v", Ref2VA: "ref2va" } as Record<string, string>)[String(planned.mode)] || "ref2va" };
                if (!projected.segment && !existing) {
                    // This empty input was created by preparation, not authored by a
                    // user. Preserve its baseline so later compilation can fill it.
                    segment.productionClipProjection = { targetId: group.id, sourceHash: director.sourceHash,
                        fieldHashes: Object.fromEntries(CLIP_PROJECTION_FIELDS.map(key => [key, inputHash(segment[key])])) };
                    segment.productionClipProjection.inputHash = clipInputHash(segment);
                }
                if (existing) {
                    if (projected.segment && (clipInputHash(existing) !== clipInputHash(segment) || !existing.productionClipProjection)) canvasOps.push({ type: "update_h3_segment", nodeId: member.nodeId, segmentId, patch: segment });
                } else if (existingNode || plannedNodeIds.has(member.nodeId)) canvasOps.push({ type: "add_h3_segment", nodeId: member.nodeId, segment });
                else {
                    const scene = unit.sceneId ? productionSceneEntries(director.source).find(item => item.id === unit.sceneId) : undefined;
                    canvasOps.push({ type: "add_node", id: member.nodeId, nodeType: member.nodeType, title: `${scene?.title || "场次"} · H3 Clips`, position: member.position, width: member.size.width, height: member.size.height, metadata: { ...createH3NodeMetadata(object(this.stores.settings.get(H3_DEFAULTS_KEY)), { segments: [segment] }), ...(scene ? { productionSceneId: scene.id, productionOwnerKind: "episode", productionOwnerId: id, groupId: stableId("production-scene", id, scene.id) } : {}), productionLayoutUnitId: unit.id, productionLayoutBounds: unit.bounds.size } });
                }
                plannedNodeIds.add(member.nodeId);
                if (group.nodeId !== member.nodeId || group.segmentId !== (group.segmentId || stableId("clip", id, group.id))) bindings.push({ type: "bind_director_segment", targetId: group.id, nodeId: member.nodeId, segmentId });
            }
        }
        // Preparing a complete scene also repairs its physical timeline order.
        // Published sync remains unchanged; draft repair needs no new publication.
        const selectedSegments = new Set(targetIds.filter(target => target.startsWith("segment:")).map(target => target.slice(8)));
        for (const nodeId of new Set(current.draft.clipGroups.filter(group => selectedSegments.has(group.id)).map(group => group.nodeId).filter(Boolean))) {
            const groups = current.draft.clipGroups.filter(group => group.nodeId === nodeId);
            if (!groups.every(group => selectedSegments.has(group.id))) continue;
            const existing = nodesOf(project).find(node => node.id === nodeId);
            const segments = object(existing?.metadata).segments as Array<Record<string, unknown>> | undefined;
            if (segments) canvasOps.push(...formalClipOrderOperations(nodeId!, segments.map(segment => String(segment.id)), groups.map(group => group.segmentId!).filter(Boolean)));
        }
        const requestedUnits = selectedUnits;
        const unitsForTarget = (target: string) => {
            if (target.startsWith("scene:")) {
                const sceneId = target.slice("scene:".length);
                return requestedUnits.filter(unit => unit.sceneId === sceneId && (unit.area === "script" || unit.members.some(member => member.role === "scene")));
            }
            if (target.startsWith("segment:")) {
                const sceneId = requestedUnits.find(unit => unit.targets.includes(target) && unit.members.some(member => member.role === "video"))?.sceneId;
                if (sceneId) return requestedUnits.filter(unit => unit.sceneId === sceneId && (unit.area === "script" || unit.members.some(member => member.role === "scene") || unit.targets.includes(target)));
            }
            return requestedUnits.filter(unit => unit.targets.includes(target) || (target.startsWith("frame:") && unit.targets.includes(`frame-prompt:${target.slice(6)}`)));
        };
        const receipt: ProductionLayoutReceipt = frozen?.receipt || {
            planHash: plan.planHash, algorithmVersion: plan.algorithmVersion, canvasRevision: Number(project.revision || 0),
            created: targetIds.map(target => ({ target, nodeIds: [...new Set(unitsForTarget(target).flatMap(unit => unit.members.filter(member => !nodesOf(project).some(node => node.id === member.nodeId)).map(member => member.nodeId)))] })),
            reused: targetIds.map(target => ({ target, nodeIds: [...new Set(unitsForTarget(target).flatMap(unit => unit.members.filter(member => nodesOf(project).some(node => node.id === member.nodeId)).map(member => member.nodeId)))] })),
            diagnostics: plan.diagnostics.filter(item => targetIds.some(target => target === item.target)),
        };
        const frozenLayout = frozen || this.service.freezePreparationLayout(id, operationId, Number(project.revision || 0), plan, receipt);
        const commit = this.service.commitPreparation(id, operationId, expectedRevision, bindings, frozenLayout.receipt, frozenLayout.plan, { projectId: canvasId, expectedCanvasRevision: frozenLayout.expectedCanvasRevision, operationId: `${operationId}:nodes`, operations: canvasOps }, referenceSync);
        return { ...commit, referenceSync };
    }

    arrangeScene(id: string, sceneId: string, expectedRevision: number, operationId: string) {
        const prepared = this.service.beginPreparation(id, operationId, { sceneId, expectedRevision });
        if (prepared.receipt) return { ...prepared.receipt, replayed: true };
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
        const layout = productionSceneLayout(members, scene.shotIds, position);
        const operations: CanvasOperation[] = layout.positions.map(node => ({ type: "update_node", id: node.id, patch: { position: node.position } }));
        operations.push({ type: "update_node", id: group.id, patch: { width: layout.width, height: layout.height } });
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

    syncClips(episodeId: string, version: number, groupIds?: string[], runSettings?: Record<string, unknown>): ProductionRecord & { syncReceipt: { updated: number; skipped: number; bound: number; reordered: number } } {
        let production = this.service.get(episodeId);
        if (production.publishedVersion !== version && runSettings?.parallelScenes && groupIds?.length) {
            this.service.validateExecution(episodeId, version, groupIds);
            return this.syncClips(episodeId, production.publishedVersion, groupIds, runSettings);
        }
        if (production.publishedVersion !== version || !production.published?.shots.length) throw new Error("只能同步当前已发布镜头表");
        let published = production.published;
        const syncReceipt = { updated: 0, skipped: 0, bound: 0, reordered: 0 };
        let groups = published.clipGroups.filter((group) => !groupIds || groupIds.includes(group.id));
        let readiness = this.service.workflowReadiness(episodeId, "published");
        const blocked = groups.map(group => readiness.targets.find(item => item.id === `segment:${group.id}`)).filter(item => !item || !["ready", "complete"].includes(item.status));
        if (blocked.length) throw new Error(blocked.flatMap(item => item?.blockers || ["Segment 缺少就绪视图"] ).join("；"));
        this.service.validateExecution(episodeId, version, groups.map(group => group.id));
        const episode = this.storesEpisode(episodeId);
        if (!episode.canvasId) throw new Error("分集尚未绑定画布");
        let project = this.stores.projects.get(episode.canvasId!);
        if (!project) throw new Error("分集画布不存在");
        let layoutPlan = this.service.ensureLayoutPlan(episodeId, production, project);
        const needsLayoutTargets = groups.filter(group => {
            const unit = layoutPlan.units.find(item => item.targets.includes(`segment:${group.id}`) && item.members.some(member => member.role === "video"));
            const video = unit?.members.find(member => member.role === "video");
            if (!unit || !video || !nodesOf(project!).some(node => node.id === (group.nodeId || video.nodeId))) return true;
            return Boolean(unit.sceneId && !nodesOf(project!).some(node => object(node.metadata).productionSceneId === unit.sceneId));
        }).map(group => `segment:${group.id}`);
        if (needsLayoutTargets.length) {
            const latest = this.service.get(episodeId), currentProject = this.stores.projects.get(episode.canvasId!);
            if (!currentProject) throw new Error("分集画布不存在");
            const layoutOperationId = stableId("production-scene-sync-layout", episodeId, String(version), String(latest.revision), String(currentProject.revision || 0), ...needsLayoutTargets);
            this.prepareTargets(episodeId, latest.revision, needsLayoutTargets, layoutOperationId);
            production = this.service.get(episodeId);
            if (production.publishedVersion !== version || !production.published) throw new Error("准备场次节点期间发布版本已变化");
            published = production.published;
            groups = published.clipGroups.filter(group => !groupIds || groupIds.includes(group.id));
            readiness = this.service.workflowReadiness(episodeId, "published");
            const nowBlocked = groups.map(group => readiness.targets.find(item => item.id === `segment:${group.id}`)).filter(item => !item || item.status !== "ready");
            if (nowBlocked.length) throw new Error(nowBlocked.flatMap(item => item?.blockers || ["Segment 缺少就绪视图"] ).join("；"));
            this.service.validateExecution(episodeId, version, groups.map(group => group.id));
            project = this.stores.projects.get(episode.canvasId!);
            if (!project) throw new Error("分集画布不存在");
            layoutPlan = this.service.ensureLayoutPlan(episodeId, production, project);
        }
        for (const group of groups) {
            project = this.stores.projects.get(episode.canvasId!);
            if (!project) throw new Error("分集画布不存在");
            const nodes = nodesOf(project);
            const segmentId = group.segmentId || stableId("clip", episodeId, group.id);
            const shots = group.shotIds.map((id) => published.shots.find((shot) => shot.id === id)).filter((shot): shot is NonNullable<typeof shot> => !!shot);
            const settings = runSettings || published.settings as unknown as Record<string, unknown>;
            // [临时] 注释掉 H3 模型设置强制读取（死代码，模型以节点 metadata 为准）
            // const h3Models = object(settings.h3Models);
            // const h3Model = String(h3Models[group.id] || settings.h3Model || "");
            const authored = directorArtifact(published, "h3", group.id);
            const d = published.director!;
            const planned = (d.source.segments as Array<Record<string, any>>).find(s => s.id === group.id)!;
            const sceneIds = productionSceneIdsForShots(productionSceneEntries(d.source), group.shotIds);
            if (!group.nodeId && sceneIds.length !== 1) throw new Error(sceneIds.length ? `Segment ${group.id} 跨越多个场次；请先按场次拆分` : `Segment ${group.id} 未映射到唯一正式场次，无法同步场次 H3 节点`);
            const layoutUnit = layoutPlan.units.find(unit => unit.targets.includes(`segment:${group.id}`) && unit.members.some(member => member.role === "video"));
            const layoutMember = layoutUnit?.members.find(member => member.role === "video");
            if (!layoutUnit || !layoutMember) throw new Error(`布局计划缺少 H3 节点：${group.id}`);
            const nodeId = group.nodeId || layoutMember.nodeId;
            const scene = layoutUnit.sceneId ? productionSceneEntries(d.source).find(item => item.id === layoutUnit.sceneId) : undefined;
            const existingClip = (object(nodes.find(item => item.id === nodeId)?.metadata).segments as Record<string, any>[] || []).find(item => item.id === segmentId);
            const projected = productionClipProjection(project, { ...published, settings: runSettings ? { ...published.settings, ...runSettings } : published.settings }, group, segmentId, existingClip);
            if (!projected.segment) throw new Error(projected.result.diagnostics.map(item => item.message).join("；"));
            const segment = projected.segment;
            const prompt = String(segment.prompt), bindings = segment.referenceBindings;
            const node = nodes.find((item) => item.id === nodeId);
            if (node && !isH3NodeType(node.type)) throw new Error(`映射节点 ${nodeId} 不是 H3`);
            const exists = node && Array.isArray(object(node.metadata).segments) && (object(node.metadata).segments as Array<Record<string, unknown>>).some((item) => item.id === segmentId);
            const operations = exists
                ? clipInputHash(existingClip!) === clipInputHash(segment) && canonicalProduction(existingClip!.productionClipProjection) === canonicalProduction(segment.productionClipProjection)
                    ? [] : [{ type: "update_h3_segment", nodeId, segmentId, patch: { ...segment } }]
                : node ? [{ type: "add_h3_segment", nodeId, segment }]
                : [{ type: "add_node", id: nodeId, nodeType: "minimax-h3:video", title: `${scene?.title || "场次"} · H3 Clips`, position: layoutMember.position, width: layoutMember.size.width, height: layoutMember.size.height, metadata: { ...createH3NodeMetadata(object(this.stores.settings.get(H3_DEFAULTS_KEY)), { segments: [segment] }), ...(scene ? { productionSceneId: scene.id, productionOwnerKind: "episode", productionOwnerId: episodeId, groupId: stableId("production-scene", episodeId, scene.id) } : {}), productionLayoutUnitId: layoutUnit.id, productionLayoutBounds: layoutUnit.bounds.size } }];
            if (operations.length) {
                this.stores.projects.applyOperations(episode.canvasId, Number(project.revision || 0), operations, { operationId: stableId("production-sync", episodeId, String(version), group.id, String(project.revision || 0), crypto.createHash("sha256").update(prompt + JSON.stringify(bindings)).digest("hex")), runtimeWrite: true, source: { clientId: "episode-production", kind: "system", label: "同步单集 Clip" } });
                syncReceipt.updated++;
            } else syncReceipt.skipped++;
            const draftGroup = production.draft.clipGroups.find(item => item.id === group.id);
            if (group.nodeId !== nodeId || group.segmentId !== segmentId || draftGroup?.nodeId !== nodeId || draftGroup?.segmentId !== segmentId) {
                this.service.bindRuntime(episodeId, version, { groupId: group.id, nodeId, segmentId });
                syncReceipt.bound++;
            }
        }
        const synced = this.service.get(episodeId);
        const orderedNodes = new Set<string>();
        let prior: { nodeId: string; segmentId: string } | undefined;
        for (const group of synced.published!.clipGroups) {
            if (!group.nodeId || !group.segmentId) continue;
            if (!orderedNodes.has(group.nodeId)) {
                const project = this.stores.projects.get(episode.canvasId!)!;
                const node = nodesOf(project).find(n => n.id === group.nodeId);
                const first = (object(node?.metadata).segments as Array<Record<string, unknown>> || [])[0];
                if (first?.id && first.id !== group.segmentId) {
                    this.stores.projects.applyOperations(episode.canvasId, Number(project.revision || 0), [{ type: "move_h3_segment", nodeId: group.nodeId, segmentId: group.segmentId, beforeSegmentId: String(first.id) }], { source: { clientId: "episode-production", kind: "system" } });
                    syncReceipt.reordered++;
                }
                orderedNodes.add(group.nodeId);
            }
            if (prior && prior.nodeId === group.nodeId) {
                const project = this.stores.projects.get(episode.canvasId!)!;
                const node = nodesOf(project).find(node => node.id === group.nodeId);
                const segments = object(node?.metadata).segments as Array<Record<string, unknown>> || [];
                if (segments.findIndex(segment => segment.id === group.segmentId) !== segments.findIndex(segment => segment.id === prior!.segmentId) + 1) {
                    this.stores.projects.applyOperations(episode.canvasId, Number(project.revision || 0), [{ type: "move_h3_segment", nodeId: group.nodeId, segmentId: group.segmentId, afterSegmentId: prior.segmentId }], { source: { clientId: "episode-production", kind: "system" } });
                    syncReceipt.reordered++;
                }
            }
            prior = { nodeId: group.nodeId, segmentId: group.segmentId };
        }
        return { ...this.service.get(episodeId), syncReceipt };
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
        if (run.executionSnapshot) return this.executeCanvasBatch(run);
        const production = this.service.get(episodeId);
        if (!production.published) throw new Error("缺少发布版本");
        const snapshot = production.publishedVersion === version ? production.published : this.service.version(episodeId, version).snapshot;
        if (production.publishedVersion !== version && !snapshot.settings.parallelScenes) throw new Error("已有更新的发布版本");
        if (!snapshot.director) throw new Error("缺少 Acheng 制作稿");
        if (!run.runId && !snapshot.director.executionAuthorized) throw new Error("缺少 Acheng 生产执行授权");
        if (!run.runId && snapshot.director.unresolved.length) throw new Error(snapshot.director.unresolved.join("；"));
        if (run.engine && JSON.stringify(run.engine) !== JSON.stringify(snapshot.director.engine)) throw new Error("运行批次的编译来源与原发布快照不一致");
        const runSettings = run.settings || snapshot.settings as unknown as Record<string, unknown>;
        if (runSettings.storyboardImageMode === "skip" && run.plan.imageShotIds.length) throw new Error("此运行范围包含关键帧图片，但已选择跳过分镜图；请重新确认生产范围后启动新运行");
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
        // [临时] 注释掉 H3 模型设置，改用节点 metadata 模型（本地 ComfyUI 模型）
        const h3ModelFor = (id: string) => {
            const proj = this.stores.projects.get(String(projectBefore!.id)) || projectBefore!;
            const grp = this.service.version(episodeId, version).snapshot.clipGroups.find(g => g.id === id);
            const n = grp?.nodeId ? nodesOf(proj).find(nn => nn.id === grp.nodeId) : undefined;
            return n ? String(object(n.metadata).modelName || "") : String(object(this.stores.settings.get(H3_DEFAULTS_KEY)).modelName || "");
        };
        const episode = this.storesEpisode(episodeId);
        if (!episode.canvasId) throw new Error("分集未绑定画布");
        const projectBefore = this.stores.projects.get(episode.canvasId!);
        if (!projectBefore) throw new Error("分集画布不存在");
        const layoutPlan = this.service.ensureLayoutPlan(episodeId, production, projectBefore);
        // Assets are authored by Acheng. Execute only ready dependency leaves;
        // review and recompilation of downstream prompts remain Agent work.
        const keyframeAssets = new Set([
            ...Object.values(snapshot.director.shotInputs).map(s => s.keyframeAssetId).filter(Boolean),
            ...(Array.isArray(snapshot.director.source.asset_plan) ? snapshot.director.source.asset_plan : []).filter(item => ["keyframe", "storyboard", "frame"].includes(String(object(item).kind || object(item).asset_type || "").toLowerCase())).map(item => String(object(item).asset_id || object(item).id || "")),
        ]);
        const assetTasks = snapshot.director.artifacts.filter(a => a.kind === "image" && a.status === "ready" && !keyframeAssets.has(a.targetId)
            && (!run!.runId || selectedAssetIds.has(a.targetId)) && [undefined, "planned", "rejected"].includes(snapshot.director!.assets[a.targetId]?.status));
        const assetCompletions: Array<Promise<Error | undefined>> = [];
        for (const artifact of assetTasks) {
            this.checkPause(run!);
            if (run.submitted.some(item => item.kind === "image" && item.id === artifact.targetId && item.status === "succeeded")) continue;
            const asset = snapshot.director.assets[artifact.targetId];
            const nodeId = asset?.nodeId || stableId("production-asset", episodeId, artifact.targetId);
            let assetProject = this.stores.projects.get(episode.canvasId!);
            if (!assetProject) throw new Error("分集画布不存在");
            let node = nodesOf(assetProject).find(n => n.id === nodeId);
            if (!node) {
                const unit = layoutPlan.units.find(item => item.targets.includes(`asset:${artifact.targetId}`) && item.members.some(member => member.role === "asset"));
                const member = unit?.members.find(item => item.role === "asset");
                if (!unit || !member || member.nodeId !== nodeId) throw new Error(`布局计划缺少正式资产节点：${artifact.targetId}`);
                this.stores.projects.applyOperations(episode.canvasId, Number(assetProject.revision || 0), [{ type: "add_node", id: nodeId, nodeType: member.nodeType, title: assetTitle(snapshot.director.source, artifact.targetId), position: member.position, width: member.size.width, height: member.size.height,
                    metadata: { prompt: artifact.prompt, status: "idle", productionAssetId: artifact.targetId, productionVersion: version, productionLayoutUnitId: unit.id, productionLayoutBounds: member.size } }], { operationId: stableId("production-asset-node", episodeId, String(version), artifact.targetId), runtimeWrite: true, source: { clientId: "episode-production", kind: "system", label: "准备 Acheng 资产" } });
                assetProject = this.stores.projects.get(episode.canvasId!);
                node = assetProject ? nodesOf(assetProject).find(n => n.id === nodeId) : undefined;
            }
            if (!node) throw new Error(`资产 ${artifact.targetId} 画布节点创建失败`);
            const model = imageModelFor(artifact.targetId) || String(object(node.metadata).model || "");
            if (!model) throw new Error(`资产 ${artifact.targetId} 缺少图片模型`);
            const taskId = stableId("production-asset-task", run.runId || `${episodeId}:${version}`, artifact.targetId);
            let task = this.stores.tasks.get(taskId);
            if (!task) {
                this.service.validateExecution(episodeId, version, [artifact.targetId]);
                const input = verifyImageInput(this.stores.projects.get(episode.canvasId!)!, snapshot.director, artifact, nodeId);
                const result = await this.generation.start({ mode: "image", projectId: episode.canvasId, nodeId, model, prompt: artifact.prompt,
                    references: input.references.map(r => ({ storageKey: r.storageKey, sourceNodeId: r.nodeId, role: r.role, type: "image" })),
                    params: { ...productionImageParams(node), productionImageInput: input }, idempotencyKey: taskId }, { productionManaged: true });
                task = this.stores.tasks.get(result.taskId);
                if (!task) throw new Error("资产任务未记录");
            }
            run = this.recordTask(run, "image", artifact.targetId, task.id, { projectId: episode.canvasId, nodeId });
            const finish = async () => {
            const completed = await this.waitTask(task!.id);
            run = this.markTaskStatus(run!, task!.id, "succeeded");
            this.checkPause(run);
            const actual = this.stores.projects.get(episode.canvasId!);
            const outputNode = actual && nodesOf(actual).find(n => n.id === nodeId);
            const taskMedia = Array.isArray(object(completed.result).media) ? object(completed.result).media as Record<string, unknown>[] : [];
            const verifiedKeys = [...completed.outputs, ...taskMedia].map(item => String(item.storageKey || "")).filter(Boolean);
            const key = runSettings.parallelScenes ? verifiedKeys[0] || "" : outputNode ? mediaKey(outputNode) : "";
            if (!key) throw new Error(`资产 ${artifact.targetId} 未回写媒体`);
            this.service.bindDirectorAsset(episodeId, version, artifact.targetId, key);
            };
            if (runSettings.parallelScenes) assetCompletions.push(finish().then(() => undefined, error => { run = this.markTaskStatus(run!, task!.id, "failed"); return error instanceof Error ? error : new Error(String(error)); }));
            else await finish();
        }
        await this.finishIndependent(assetCompletions);
        if (assetTasks.length || (!run.runId && Object.values(snapshot.director.assets).some(asset => asset.status === "generated"))) {
            this.service.updateRun({ ...run, status: "awaiting_review", error: "资产已生成；请查看真实媒体，更新批准版本及依赖提示词后发布新导演稿" });
            return;
        }
        if (run.plan.imageShotIds.some((id) => !imageModelFor(id))) throw new Error("缺少图片模型，请在画布节点或配置页选择模型后发布新版本");
        if (run.plan.clipGroupIds.some((id) => !h3ModelFor(id))) throw new Error("缺少 H3 模型，请配置 H3 默认模型后发布新版本");
        if (run.plan.missingAssetNodeIds.length) throw new Error(`缺少资产引用：${run.plan.missingAssetNodeIds.join(", ")}`);
        const availableNodes = new Map(nodesOf(projectBefore).map((node) => [String(node.id || ""), node]));
        const plannedGroups = new Set(run.plan.clipGroupIds);
        const requiredShotIds = new Set([...run.plan.affectedShotIds, ...snapshot.clipGroups.filter((group) => plannedGroups.has(group.id)).flatMap((group) => group.shotIds)]);
        for (const shot of snapshot.shots.filter((item) => requiredShotIds.has(item.id))) {
            if (runSettings.storyboardImageMode !== "skip" && shot.keyframePolicy === "reuse" && !snapshot.keyframes[shot.id]?.storageKey) throw new Error(`镜头 ${shot.id} 的复用关键帧缺少媒体`);
            const linkedFrame = snapshot.keyframes[shot.id];
            if (linkedFrame && !availableNodes.has(linkedFrame.nodeId)) throw new Error(`镜头 ${shot.id} 的关键帧不在当前绑定画布中`);
        }
        run = { ...run, status: "running", error: null }; this.service.updateRun(run);
        const frameCompletions: Array<Promise<Error | undefined>> = [];
        for (const shotId of run.plan.imageShotIds) {
            this.checkPause(run);
            if (run.submitted.some(item => item.kind === "image" && item.id === shotId && item.status === "succeeded")) continue;
            const imageModel = imageModelFor(shotId);
            const shot = snapshot.shots.find((item) => item.id === shotId);
            if (!shot) continue;
            const taskId = stableId("production-image-task", run.runId || `${episodeId}:${version}`, shotId);
            let task = this.stores.tasks.get(taskId);
            if (!task) {
                const project = this.stores.projects.get(episode.canvasId!);
                if (!project) throw new Error("画布不存在");
                const frameUnit = layoutPlan.units.find(unit => unit.targets.includes(`frame:${shotId}`) && unit.members.some(member => member.role === "keyframe"));
                const frameMember = frameUnit?.members.find(member => member.role === "keyframe");
                const promptUnit = layoutPlan.units.find(unit => unit.targets.includes(`frame-prompt:${shotId}`));
                const promptMember = promptUnit?.members.find(member => member.role === "prompt");
                if (!frameUnit || !frameMember || !promptUnit || !promptMember) throw new Error(`布局计划缺少关键帧节点：${shotId}`);
                const nodeId = frameMember.nodeId;
                const sourceNodeId = stableId("production-source", episodeId, shotId);
                const existingFrame = nodesOf(project).find(node => node.id === nodeId);
                const frameScene = frameUnit.sceneId;
                const sceneUnit = frameScene ? layoutPlan.units.find(unit => unit.id === `scene:${frameScene}`) : undefined;
                const sceneMember = sceneUnit?.members.find(member => member.role === "scene");
                const keyframeAsset = snapshot.director?.shotInputs[shotId]?.keyframeAssetId;
                if (!keyframeAsset) throw new Error(`镜头 ${shotId} 缺少关键帧资产映射`);
                const imageArtifact = directorArtifact(snapshot, "image", keyframeAsset);
                const prompt = imageArtifact.prompt;
                if (object(existingFrame?.metadata).productionImageInput) verifyImageInput(project, snapshot.director, imageArtifact, nodeId, sourceNodeId);
                const operations: CanvasOperation[] = [];
                if (sceneMember && !nodesOf(project).some(node => node.id === sceneMember.nodeId)) operations.push({ type: "add_node", id: sceneMember.nodeId, nodeType: sceneMember.nodeType,
                    title: productionSceneEntries(snapshot.director!.source).find(scene => scene.id === frameScene)?.title || frameScene || "制作场次", position: sceneMember.position,
                    width: sceneMember.size.width, height: sceneMember.size.height, metadata: { productionSceneId: frameScene, productionLayoutUnitId: sceneUnit!.id, productionLayoutBounds: sceneUnit!.bounds.size } });
                operations.push(...(nodesOf(project).some((node) => node.id === sourceNodeId)
                    ? [{ type: "update_node", id: sourceNodeId, metadata: { prompt, model: imageModel } }]
                    : [{ type: "add_node", id: sourceNodeId, nodeType: promptMember.nodeType, title: shot.title || "关键帧提示词", position: promptMember.position, width: promptMember.size.width, height: promptMember.size.height, metadata: { prompt, model: imageModel, generationMode: "image", productionShotId: shotId, ...(frameScene ? { groupId: stableId("production-scene", episodeId, frameScene) } : {}), productionLayoutUnitId: promptUnit.id, productionLayoutBounds: promptUnit.bounds.size } }]));
                if (!nodesOf(project).some((node) => node.id === nodeId)) operations.push({ type: "add_node", id: nodeId, nodeType: frameMember.nodeType, title: shot.title || shot.visual.slice(0, 24), position: frameMember.position, width: frameMember.size.width, height: frameMember.size.height, metadata: { prompt: shot.visual, status: "idle", productionShotId: shotId, ...(frameScene ? { groupId: stableId("production-scene", episodeId, frameScene) } : {}), productionLayoutUnitId: frameUnit.id, productionLayoutBounds: frameUnit.bounds.size } });
                this.stores.projects.applyOperations(episode.canvasId, Number(project.revision || 0), operations, { operationId: stableId("production-frame-prepare", episodeId, String(version), shotId), runtimeWrite: true, source: { clientId: "episode-production", kind: "system" } });
                this.service.validateExecution(episodeId, version, [keyframeAsset]);
                const input = verifyImageInput(this.stores.projects.get(episode.canvasId!)!, snapshot.director, imageArtifact, nodeId, sourceNodeId);
                const started = await this.generation.start({ mode: "image", projectId: episode.canvasId, nodeId, sourceNodeId, model: imageModel, prompt, references: input.references.map(r => ({ storageKey: r.storageKey, sourceNodeId: r.nodeId, role: r.role, type: "image" })), resultPolicy: "append", params: { ...productionImageParams(nodesOf(project).find(node => node.id === nodeId)), productionImageInput: input }, clientTaskId: taskId, idempotencyKey: taskId }, { productionManaged: true });
                task = this.stores.tasks.get(started.taskId);
                if (!task) throw new Error("图片任务未被 Backend 记录");
            }
            const nodeId = snapshot.keyframes[shotId]?.nodeId || snapshot.director.assets[snapshot.director.shotInputs[shotId]?.keyframeAssetId || ""]?.nodeId || layoutPlan.units.find(unit => unit.targets.includes(`frame:${shotId}`))?.members.find(member => member.role === "keyframe")?.nodeId || stableId("production-frame", episodeId, shotId);
            run = this.recordTask(run, "image", shotId, task.id, { projectId: episode.canvasId, nodeId });
            const finish = async () => {
            task = await this.waitTask(task!.id);
            run = this.markTaskStatus(run!, task!.id, "succeeded");
            this.checkPause(run);
            const project = this.stores.projects.get(episode.canvasId!);
            const node = project && nodesOf(project).find((item) => item.id === nodeId);
            const taskMedia = object(task.result).media;
            const resultKey = Array.isArray(taskMedia) ? String(object(taskMedia[0]).storageKey || "") : "";
            if (runSettings.parallelScenes && !resultKey && !task!.outputs.some(item => item.storageKey)) throw new Error(`镜头 ${shotId} 的本轮任务缺少归档媒体证据`);
            const key = resultKey || (runSettings.parallelScenes ? String(task!.outputs.find(item => item.storageKey)?.storageKey || "") : node ? mediaKey(node) : "");
            if (!key) throw new Error(`镜头 ${shotId} 的图片任务完成但节点缺少 storageKey`);
            if (node && !JSON.stringify(object(node.metadata)).includes(key)) throw new Error(`镜头 ${shotId} 的本轮媒体未回写目标节点`);
            this.service.bindRuntime(episodeId, version, { shotId, nodeId, storageKey: key });
            };
            if (runSettings.parallelScenes) frameCompletions.push(finish().then(() => undefined, error => { run = this.markTaskStatus(run!, task!.id, "failed"); return error instanceof Error ? error : new Error(String(error)); }));
            else await finish();
        }
        await this.finishIndependent(frameCompletions);
        const latest = this.service.version(episodeId, version).snapshot;
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
        const current = this.service.version(episodeId, version).snapshot;
        const groups = current.clipGroups;
        const required = new Set(pendingClipIds);
        const boundaries = current.director!.boundaries;
        const chains: typeof groups[] = [];
        for (let i = 0; i < groups.length; i++) {
            const chain = [groups[i]];
            while (i + 1 < groups.length && boundaries.some(b => b.from === groups[i].id && b.to === groups[i + 1].id && (b.motionContext))) chain.push(groups[++i]);
            if (chain.some(g => required.has(g.id))) chains.push(chain);
        }
        const videoCompletions: Array<Promise<Error | undefined>> = [];
        const videoByGroup = new Map<string, Promise<Error | undefined>>();
        for (const chain of chains) {
            let submittedTaskId: string | undefined;
            const executeChain = async () => {
            this.checkPause(run!);
            const head = chain[0], tail = chain[chain.length - 1];
            if (!head.nodeId || !head.segmentId || chain.some(g => g.nodeId !== head.nodeId || !g.segmentId)) throw new Error("连续组必须绑定同一个 H3 节点");
            for (const group of chain) {
                directorArtifact(current, "h3", group.id);
                for (const shotId of group.shotIds) {
                    const shot = current.shots.find(s => s.id === shotId);
                    if (runSettings.storyboardImageMode !== "skip" && shot?.keyframePolicy !== "none" && !current.keyframes[shotId]?.storageKey) throw new Error(`镜头 ${shotId} 缺少可用关键帧参考`);
                }
            }
            const taskId = stableId("production-h3-task", run!.runId || `${episodeId}:${version}`, ...chain.map(g => g.id));
            let task = this.stores.tasks.get(taskId);
            if (!task) {
                this.service.validateExecution(episodeId, version, chain.map(group => group.id));
                const started = await this.generation.start({ mode: "video", operation: "h3-run", projectId: episode.canvasId!,
                    nodeId: head.nodeId, segmentId: head.segmentId, endSegmentId: tail.segmentId!,
                    runFromCurrent: chain.length > 1, skipCompleted: false, forceRegenerate: true,
                    idempotencyKey: taskId }, { productionManaged: true });
                task = this.stores.tasks.get(started.taskId);
                if (!task) throw new Error("H3 父任务未被 Backend 记录");
            }
            submittedTaskId = task.id;
            for (const group of chain) run = this.recordTask(run!, "h3", group.id, task.id, { projectId: episode.canvasId!, nodeId: head.nodeId, segmentId: group.segmentId || undefined });
            const completed = await this.waitTask(task!.id);
            run = this.markTaskStatus(run!, task!.id, "succeeded");
            this.checkPause(run!);
            const finished = this.stores.projects.get(episode.canvasId!);
            const node = finished && nodesOf(finished).find(n => n.id === head.nodeId);
            for (const group of chain) {
                const segment = (object(node?.metadata).segments as Array<Record<string, unknown>> || []).find(s => s.id === group.segmentId);
                if (!segment?.resultStorageKey || !this.stores.media.meta(String(segment.resultStorageKey))) throw new Error(`Clip ${group.id} 缺少归档媒体回写`);
                if (runSettings.parallelScenes) {
                    const media = Array.isArray(object(completed.result).media) ? object(completed.result).media as Record<string, unknown>[] : [];
                    if (![...completed.outputs, ...media].some(item => item.storageKey === segment.resultStorageKey)) throw new Error(`Clip ${group.id} 的活动结果不属于本轮任务`);
                }
                this.service.bindRuntime(episodeId, version, { groupId: group.id, nodeId: head.nodeId!, segmentId: group.segmentId!, storageKey: String(segment.resultStorageKey), completed: true });
            }

            };
            if (runSettings.parallelScenes) {
                const predecessor = boundaries.find(item => item.to === chain[0].id && (item.tailFrame || item.motionContext));
                const dependency = predecessor ? videoByGroup.get(predecessor.from) : undefined;
                const completion = (async () => {
                    if (dependency) { const failure = await dependency; if (failure) throw new Error("H3 前段失败，本段保持未提交状态"); }
                    await executeChain();
                })().then(() => undefined, error => {
                    if (submittedTaskId) run = this.markTaskStatus(run!, submittedTaskId, "failed");
                    return error instanceof Error ? error : new Error(String(error));
                });
                videoCompletions.push(completion);
                for (const group of chain) videoByGroup.set(group.id, completion);
            } else await executeChain();
        }
        await this.finishIndependent(videoCompletions);
        this.service.updateRun({ ...run, status: "succeeded", error: null });
    }

    private async executeCanvasBatch(initial: ProductionRun) {
        let run = { ...initial, status: "running" };
        this.service.updateRun(run);
        const snapshot = run.executionSnapshot!;
        const byId = new Map(snapshot.targets.map(target => [target.id, target]));
        const failures = new Map<string, string>(), done = new Set<string>();
        const work = async (target: CanvasExecutionTarget): Promise<void> => {
            if (done.has(target.id)) return;
            this.checkPause(run);
            const chain = [target];
            if (target.segmentId) {
                const node = (snapshot.project.nodes as any[]).find(node => node.id === target.nodeId);
                const segments = node?.metadata?.segments || [];
                let start = segments.findIndex((segment: any) => segment.id === target.segmentId), end = start;
                const selected = (index: number) => snapshot.targets.find(item => item.nodeId === target.nodeId && item.segmentId === segments[index]?.id);
                while (start > 0 && segments[start - 1].motionContextEnabled === true && selected(start - 1)) start--;
                while (end + 1 < segments.length && segments[end].motionContextEnabled === true && selected(end + 1)) end++;
                const members = segments.slice(start, end + 1).map((segment: any) => snapshot.targets.find(item => item.nodeId === target.nodeId && item.segmentId === segment.id)!).filter(Boolean);
                if (members[0] !== target) { await work(members[0]); if (failures.has(members[0].id)) throw new Error("前置连续组失败"); return; }
                chain.splice(0, chain.length, ...members);
            }
            for (const member of chain) for (const dependency of member.dependencies) {
                const preceding = byId.get(dependency.targetId);
                if (!preceding) throw new Error(`本批次依赖不存在：${dependency.targetId}`);
                await work(preceding);
                if (failures.has(preceding.id)) throw new Error(`前置目标失败：${preceding.id}`);
                const submitted = run.submitted.find(item => item.id === preceding.id);
                const task = submitted && this.stores.tasks.get(submitted.taskId);
                if (!task || task.status !== "succeeded") throw new Error(`前置任务未成功：${preceding.id}`);
                const media = [...task.outputs, ...(Array.isArray(task.result?.media) ? task.result.media as Record<string, unknown>[] : [])];
                const output = media.find(output => output.storageKey);
                if (!output) throw new Error(`前置任务缺少归档结果：${task.id}`);
                if (run.settings?.reviewPolicy) {
                    const data = this.service.get(run.episodeId).draft;
                    const assetId = preceding.id.startsWith("frame:") ? data.director?.shotInputs[preceding.id.slice(6)]?.keyframeAssetId : preceding.id.slice(6);
                    const asset = assetId && data.director?.assets[assetId];
                    if (!asset || asset.status !== "approved" || asset.storageKey !== output.storageKey) throw Object.assign(new Error(`等待已启用的素材审核：${preceding.id}`), { code: "AWAITING_REVIEW" });
                }
                const latest = this.service.resolveCanvasDependency(run.episodeId, run.runId!, member.id, dependency.nodeId, task.id, String(output.storageKey));
                Object.assign(snapshot, latest);
                Object.assign(member, snapshot.targets.find(item => item.id === member.id));
            }
            const taskId = stableId("canvas-production-task", run.runId!, ...chain.map(member => member.id));
            const command = { ...target.command, ...(chain.length > 1 ? { endSegmentId: chain[chain.length - 1].segmentId, runFromCurrent: true } : {}), inputBasis: "canvas" as const, idempotencyKey: taskId,
                params: { ...(target.segmentId ? {} : target.command.params), canvasInputHash: target.inputHash, canvasInputDefaults: snapshot.defaults, canvasFrozenInput: !target.segmentId } };
            let task = this.stores.tasks.get(taskId);
            if (!task) {
                const started = await this.generation.start(command, { productionManaged: true, executionProject: snapshot.project, executionDefaults: snapshot.defaults });
                task = this.stores.tasks.get(started.taskId);
            }
            if (!task) throw new Error("生成任务未持久化");
            for (const member of chain) run = this.recordTask(run, member.segmentId ? "h3" : "image", member.id, task.id,
                { projectId: snapshot.canvasId, nodeId: member.nodeId, segmentId: member.segmentId });
            try {
                await this.waitTask(task.id);
                run = this.markTaskStatus(run, task.id, "succeeded");
                this.service.bindCanvasTaskResult(run.episodeId, task.id, { projectId: snapshot.canvasId, nodeId: target.nodeId,
                    kind: target.segmentId ? "segment" : target.id.startsWith("frame:") ? "keyframe" : "asset",
                    targets: chain.map(member => ({ targetId: member.id.slice(member.id.indexOf(":") + 1), segmentId: member.segmentId, inputHash: member.inputHash })) });
                for (const member of chain) done.add(member.id);
            } catch (error) { run = this.markTaskStatus(run, task.id, "failed"); throw error; }
        };
        let awaitingReview = false;
        for (const target of snapshot.targets) {
            try { await work(target); }
            catch (error) {
                if (this.service.batchPauseRequested(run.episodeId, run.runId!)) throw error;
                awaitingReview ||= (error as any).code === "AWAITING_REVIEW";
                failures.set(target.id, (error as Error).message);
                done.add(target.id);
            }
        }
        if (run.settings?.reviewPolicy) {
            const current = this.service.get(run.episodeId).draft;
            for (const target of snapshot.targets.filter(target => !target.segmentId)) {
                const submitted = run.submitted.find(item => item.id === target.id);
                if (submitted?.status !== "succeeded") continue;
                const assetId = target.id.startsWith("frame:") ? current.director?.shotInputs[target.id.slice(6)]?.keyframeAssetId : target.id.slice(6);
                if (assetId && current.director?.assets[assetId]?.status !== "approved") { awaitingReview = true; failures.set(target.id, "等待已启用的素材审核"); }
            }
        }
        this.service.updateRun({ ...run, status: awaitingReview ? "awaiting_review" : failures.size ? "failed" : "succeeded",
            error: failures.size ? [...failures].map(([id, message]) => `${id}: ${message}`).join("；") : null });
    }

    private async finishIndependent(completions: Array<Promise<Error | undefined>>) {
        const results = await Promise.all(completions);
        const error = results.find((value): value is Error => value instanceof Error);
        if (error) throw error;
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
