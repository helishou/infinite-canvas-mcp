import { mergeDirectorInput } from "./input-merge.js";
import { outgoingDirectorBoundary } from "@basketikun/canvas-agent/drama/production-validation";
import { isH3StyleTemplateId } from "@basketikun/canvas-agent/plugins/minimax-h3/style-templates";
import { BASE_H3_NODE_METADATA, createH3NodeMetadata } from "@basketikun/canvas-agent/plugins/minimax-h3/node-factory";
import { resolveH3Runtime, H3_PARAM_KEYS } from "@basketikun/canvas-agent/plugins/minimax-h3/runtime-params";
import crypto from "node:crypto";
import { currentCompilationArtifact } from "@basketikun/canvas-agent/drama/compilation-scope";
import { buildCharacterGroupFromExistingNode } from "@basketikun/canvas-agent/plugins/minimax-h3/character-groups";
import { assertReferenceCompilation, compileReferenceSubmission } from "@basketikun/canvas-agent/reference-contract";
import { canonicalProduction, isSubjectPromptAssembly, productionSceneEntries, promptSourceMapSchema, type EpisodeProductionData, type ProductionLayoutPlan } from "@basketikun/canvas-agent/drama/production-contract";
import { directorArtifact } from "./director.js";
import type { CanvasOperation } from "../canvas/project-ops.js";
const stableId = (kind: string, ...parts: string[]) => `${kind}-${crypto.createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 24)}`;
const object = (value: any): Record<string, any> => value && typeof value === "object" && !Array.isArray(value) ? value : {};
export type ReferenceSync = { targetId: string; status: "ready" | "blocked"; referenceCount: number; inputHash?: string; diagnostics: Array<{ code: string; message: string }> };
export const CLIP_PROJECTION_FIELDS = ["sourceShotId", "title", "duration", "taskMode", "prompt", "referenceBindings", "tailFrameContinuation", "motionContextEnabled", "directorEngine", "directorSourceHash", "styleTemplateId", "h3CharacterGroups", "storyboardShots", "aspectRatio", "modelName"];
function clipFieldHash(value: unknown) { return crypto.createHash("sha256").update(canonicalProduction(value ?? null)).digest("hex"); }
export function clipInputHash(segment: Record<string, any>) {
    const fields: Array<[string, unknown]> = CLIP_PROJECTION_FIELDS.map(key => [key, segment[key] ?? null]);
    if (segment.productionClipProjection?.styleTemplateDeclared === true) fields.push(["styleTemplateDeclared", true]);
    return clipFieldHash(fields);
}
export function buildProductionClip(project: Record<string, any>, published: EpisodeProductionData, group: EpisodeProductionData["clipGroups"][number], segmentId: string, runSettings?: Record<string, unknown>) {
    const nodes: Record<string, any>[] = Array.isArray(project.nodes) ? project.nodes : [];
    const shots = group.shotIds.map(id => published.shots.find(shot => shot.id === id)).filter((shot): shot is NonNullable<typeof shot> => !!shot);
    const settings = runSettings || published.settings as unknown as Record<string, unknown>;
    // [临时] 注释掉 H3 模型设置强制覆盖，模型回落到节点 metadata（本地 ComfyUI 模型）
    // const h3Model = String(object(settings.h3Models)[group.id] || settings.h3Model || "");
    const authored = directorArtifact(published, "h3", group.id);
    const d = published.director!;
    if (!currentCompilationArtifact(d, authored) || authored.receipt.promptHash !== authored.sha256) throw new Error("编译回执已过期，请修改源稿后重新编译");
    const planned = (d.source.segments as Array<Record<string, any>>).find(s => s.id === group.id)!;
    const styleTemplateId = planned.styleTemplateId ?? null;
    if (styleTemplateId !== null && !isH3StyleTemplateId(styleTemplateId)) throw new Error(`未知 H3 风格模板：${styleTemplateId}`);
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
    const boundary = outgoingDirectorBoundary(d, group.id);
    // Production Shot identity must survive independently of generated/approved keyframe media.
    // H3 renders unbound cells as placeholders; storyboardImageMode controls image references,
    // never the Shot-to-cell mapping itself.
    const fps = Number(d.source.fps_num || 24) / Number(d.source.fps_den || 1);
    const storyboardShots = shots.map(shot => {
        const input = d.shotInputs[shot.id];
        const frames = Number(shot.duration_frames);
        const start = Number(shot.start_frame), end = Number(shot.end_frame);
        const duration = Number.isFinite(frames) && frames > 0 ? frames / fps
            : Number.isFinite(start) && Number.isFinite(end) && end > start && fps > 0 ? (end - start) / fps
                : Number(shot.duration || 0);
        if (settings.storyboardImageMode === "skip" || input?.keyframePolicy === "none" || !input?.keyframeAssetId) return { id: shot.id, duration };
        const asset = d.assets[input.keyframeAssetId];
        const sourceNodeId = asset?.nodeId || input.keyframeAssetId;
        const binding = bindings.find(ref => ref.sourceNodeId === sourceNodeId);
        if (!binding) throw new Error(`镜头 ${shot.id} 的正式关键帧未进入本段参考绑定`);
        binding.role = "storyboard";
        return { id: shot.id, referenceBindingId: String(binding.id), duration };
    });
    const segment: Record<string, any> = { id: segmentId, sourceShotId: group.shotIds.join("~"), title: shots.map(shot => shot.title).join(" / "),
        duration: storyboardShots.reduce((sum, shot) => sum + Number(shot.duration || 0), 0), taskMode, prompt, referenceBindings: bindings,
        tailFrameContinuation: boundary?.tailFrame === true, motionContextEnabled: boundary?.motionContext === true,
        directorEngine: authored.receipt.engine || (authored.receipt.compilationScope as any)?.engine || d.engine, directorSourceHash: authored.sourceHash, styleTemplateId, h3CharacterGroups: characterGroups,
        ...(storyboardShots ? { storyboardShots } : {}),
        aspectRatio: settings.videoAspectRatio || object(nodes.find((node: any) => node.id === group.nodeId)?.metadata).aspectRatio || BASE_H3_NODE_METADATA.aspectRatio,
        modelName: /* h3Model || */ object(nodes.find((node: any) => node.id === group.nodeId)?.metadata).modelName || BASE_H3_NODE_METADATA.modelName };
    const preflight = compileReferenceSubmission(project, segment);
    assertReferenceCompilation(preflight);
    if (preflight.compiledPrompt !== prompt) throw new Error(`Segment ${group.id} 的参考顺序需要重新绑定并编译；不能自动改写正式正文`);
    const promptSourceMap = promptSourceMapSchema.safeParse((authored.receipt as Record<string, any>).sourceMap);
    segment.productionClipProjection = { targetId: group.id, sourceHash: authored.sourceHash, artifactId: authored.id, promptHash: authored.sha256,
        promptAssemblyVersion: isSubjectPromptAssembly(d.source) ? 2 : 1, promptSourceMapAvailable: authored.status === "ready" && isSubjectPromptAssembly(d.source) && promptSourceMap.success && promptSourceMap.data.entries.length > 0,
        styleTemplateDeclared: Object.hasOwn(planned, "styleTemplateId"),
        fieldHashes: Object.fromEntries(CLIP_PROJECTION_FIELDS.map(key => [key, clipFieldHash(segment[key])])) };
    segment.productionClipProjection.inputHash = clipInputHash(segment);
    return segment;
}
/** Published content does not replace the model and generation settings saved in the Clip UI. */
export function buildPublishedProductionClip(project: Record<string, any>, published: EpisodeProductionData, group: EpisodeProductionData["clipGroups"][number], segmentId: string, defaults: Record<string, unknown>, runSettings?: Record<string, unknown>) {
    const node = (project.nodes || []).find((node: any) => node.id === group.nodeId);
    const metadata = object(node?.metadata);
    const saved = (metadata.segments || []).find((clip: any) => clip.id === segmentId);
    if (!saved) throw new Error("已发布 Clip 节点不存在");
    const authored = buildProductionClip(project, published, group, segmentId, runSettings);
    const runtime = resolveH3Runtime(saved, {}, metadata, defaults).params;
    const contentKeys = new Set(CLIP_PROJECTION_FIELDS.filter(key => key !== "modelName"));
    const settings = Object.fromEntries(H3_PARAM_KEYS.filter(key => !contentKeys.has(key) && runtime[key] !== undefined).map(key => [key, runtime[key]]));
    if (runtime.steps !== undefined) settings.videoSteps = runtime.steps;
    delete settings.steps;
    const segment: Record<string, any> = { ...authored, ...settings, h3ParameterPolicy: "overrides" };
    segment.productionClipProjection.fieldHashes.modelName = clipFieldHash(segment.modelName);
    segment.productionClipProjection.inputHash = clipInputHash(segment);
    return segment;
}

export function productionClipProjection(project: Record<string, any>, data: EpisodeProductionData, group: EpisodeProductionData["clipGroups"][number], segmentId: string, existing?: Record<string, any>) {
    const result: ReferenceSync = { targetId: group.id, status: "blocked", referenceCount: 0, diagnostics: [] };
    try {
        let segment = buildProductionClip(project, data, group, segmentId);
        if (existing) {
            const groups = [["referenceBindings", "h3CharacterGroups", "storyboardShots", "duration"], ...CLIP_PROJECTION_FIELDS.filter(key => !["referenceBindings", "h3CharacterGroups", "storyboardShots", "duration"].includes(key)).map(key => [key])];
            const nextValues = Object.fromEntries(CLIP_PROJECTION_FIELDS.filter(key => Object.hasOwn(segment, key)).map(key => [key, segment[key]]));
            const merged = mergeDirectorInput(existing, segment, existing.productionClipProjection?.fieldHashes, groups);
            segment = { ...merged.merged, productionClipProjection: { ...segment.productionClipProjection, nextValues, fieldGroups: groups, conflicts: merged.conflicts, manualFields: merged.manualFields } };
            if (merged.conflicts.length) result.diagnostics.push({ code: "MANUAL_INPUT_PRESERVED", message: `已保留人工修改：${merged.conflicts.join(",")}` });
        }
        result.status = "ready"; result.referenceCount = segment.referenceBindings.length; result.inputHash = segment.productionClipProjection.inputHash;
        return { segment, result };
    } catch (error) { result.diagnostics.push({ code: "CLIP_INPUT_BLOCKED", message: error instanceof Error ? error.message : String(error) }); return { result }; }
}
function emptyProductionClip(project: Record<string, any>, data: EpisodeProductionData, group: EpisodeProductionData["clipGroups"][number], segmentId: string, defaults: Record<string, unknown>) {
    const director = data.director!;
    const sourceSegment = (Array.isArray(director.source.segments) ? director.source.segments : []).map(object).find(item => item.id === group.id) || {};
    const sourceShots = (Array.isArray(director.source.shots) ? director.source.shots : []).map(object);
    const shots = group.shotIds.map(id => sourceShots.find(shot => String(shot.id) === id)).filter(Boolean) as Array<Record<string, any>>;
    const fps = Number(director.source.fps_num || 24) / Number(director.source.fps_den || 1);
    const durationOf = (shot: Record<string, any>) => {
        const frames = Number(shot.duration_frames), start = Number(shot.start_frame), end = Number(shot.end_frame);
        if (Number.isFinite(frames) && frames > 0 && fps > 0) return frames / fps;
        if (Number.isFinite(start) && Number.isFinite(end) && end > start && fps > 0) return (end - start) / fps;
        return Number(data.shots.find(item => item.id === shot.id)?.duration || 0);
    };
    const storyboardShots = shots.map(shot => ({ id: String(shot.id), duration: durationOf(shot) }));
    const taskMode = ({ T2VA: "t2v", I2VA: "i2v", FL2VA: "fl2v", L2VA: "l2v", Ref2VA: "ref2va" } as Record<string, string>)[String(sourceSegment.mode)] || "ref2va";
    const node = (project.nodes || []).find((item: Record<string, any>) => item.id === group.nodeId);
    const segment: Record<string, any> = {
        id: segmentId, sourceShotId: group.shotIds.join("~"), title: shots.map(shot => String(shot.title || shot.id)).join(" / "),
        duration: storyboardShots.reduce((sum, shot) => sum + shot.duration, 0), taskMode, prompt: "", referenceBindings: [],
        storyboardModeEnabled: true, storyboardShots, tailFrameContinuation: false, motionContextEnabled: false,
        directorSourceHash: director.sourceHash, styleTemplateId: sourceSegment.styleTemplateId ?? null,
        h3CharacterGroups: {}, aspectRatio: object(node?.metadata).aspectRatio || BASE_H3_NODE_METADATA.aspectRatio,
        modelName: object(node?.metadata).modelName || defaults.modelName || BASE_H3_NODE_METADATA.modelName,
    };
    segment.productionClipProjection = { targetId: group.id, sourceHash: director.sourceHash,
        fieldHashes: Object.fromEntries(CLIP_PROJECTION_FIELDS.map(key => [key, clipFieldHash(segment[key])])) };
    segment.productionClipProjection.inputHash = clipInputHash(segment);
    return segment;
}

function layoutSceneForClip(data: EpisodeProductionData, group: EpisodeProductionData["clipGroups"][number]) {
    const ids = new Set(group.shotIds);
    const scenes = data.director ? productionSceneEntries(data.director.source) : [];
    return scenes.find(scene => scene.shotIds.some(id => ids.has(id)))?.id;
}

/** Project formal Clips; new groups are materialized only when their source operation explicitly creates them. */
export function clipInputOperations(project: Record<string, any>, data: EpisodeProductionData, layout: ProductionLayoutPlan,
    defaults: Record<string, unknown> = {}, materializeTargets: ReadonlySet<string> = new Set()) {
    const operations: CanvasOperation[] = [], referenceSync: ReferenceSync[] = [];
    const nodes = Array.isArray(project.nodes) ? project.nodes as Array<Record<string, any>> : [];
    const pendingNodes = new Map<string, CanvasOperation>();
    for (const group of data.clipGroups) {
        const unit = layout.units.find(unit => unit.targets.includes(`segment:${group.id}`) && unit.members.some(member => member.role === "video"));
        const member = unit?.members.find(member => member.role === "video");
        const nodeId = group.nodeId || member?.nodeId;
        if (!nodeId) continue;
        const segmentId = group.segmentId || stableId("clip", layout.owner.id, group.id);
        const node = nodes.find(item => item.id === nodeId);
        const pendingNode = pendingNodes.get(nodeId);
        const nodeMetadata = pendingNode ? object(pendingNode.metadata) : object(node?.metadata);
        const existingSegments = Array.isArray(nodeMetadata.segments) ? nodeMetadata.segments as Array<Record<string, any>> : [];
        const existing = existingSegments.find(segment => segment.id === segmentId || segment.productionClipProjection?.targetId === group.id);
        const projected = productionClipProjection(project, data, group, segmentId, existing);
        referenceSync.push(projected.result);
        if (existing) {
            if (projected.segment && (clipInputHash(existing) !== clipInputHash(projected.segment) || canonicalProduction(existing.productionClipProjection) !== canonicalProduction(projected.segment.productionClipProjection))) {
                if (pendingNode) nodeMetadata.segments = existingSegments.map(segment => segment.id === existing.id ? projected.segment! : segment);
                else operations.push({ type: "update_h3_segment", nodeId, segmentId: existing.id, patch: projected.segment });
            }
            continue;
        }
        if (!materializeTargets.has(group.id)) continue;
        const segment = projected.segment || emptyProductionClip(project, data, group, segmentId, defaults);
        if (pendingNode) {
            nodeMetadata.segments = [...existingSegments, segment];
            pendingNode.metadata = nodeMetadata;
        } else if (node) {
            operations.push({ type: "add_h3_segment", nodeId, segment });
        } else {
            if (!member || !unit) continue;
            const sceneId = unit.sceneId || layoutSceneForClip(data, group);
            const scene = sceneId && data.director ? productionSceneEntries(data.director.source).find(item => item.id === sceneId) : undefined;
            const groupId = sceneId ? stableId("production-scene", layout.owner.id, sceneId) : undefined;
            const metadata = { ...createH3NodeMetadata(defaults, { segments: [segment] }), ...(sceneId ? { productionSceneId: sceneId, productionOwnerKind: layout.owner.kind, productionOwnerId: layout.owner.id, groupId } : {}), productionLayoutUnitId: unit.id, productionLayoutBounds: unit.bounds.size };
            const operation = { type: "add_node", id: nodeId, nodeType: member.nodeType, title: `${scene?.title || sceneId || "场次"} · H3`, position: member.position, width: member.size.width, height: member.size.height, metadata } as Extract<CanvasOperation, { type: "add_node" }>;
            pendingNodes.set(nodeId, operation);
            operations.push(operation);
        }
    }
    return { operations, referenceSync };
}
