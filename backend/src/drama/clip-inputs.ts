import { mergeDirectorInput } from "./input-merge.js";
import { outgoingDirectorBoundary } from "@basketikun/canvas-agent/drama/production-validation";
import { isH3StyleTemplateId } from "@basketikun/canvas-agent/plugins/minimax-h3/style-templates";
import { BASE_H3_NODE_METADATA } from "@basketikun/canvas-agent/plugins/minimax-h3/node-factory";
import crypto from "node:crypto";
import { currentCompilationArtifact } from "@basketikun/canvas-agent/drama/compilation-scope";
import { buildCharacterGroupFromExistingNode } from "@basketikun/canvas-agent/plugins/minimax-h3/character-groups";
import { assertReferenceCompilation, compileReferenceSubmission } from "@basketikun/canvas-agent/reference-contract";
import { canonicalProduction, type EpisodeProductionData, type ProductionLayoutPlan } from "@basketikun/canvas-agent/drama/production-contract";
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
    if (!currentCompilationArtifact(d, authored) || authored.receipt.promptHash !== authored.sha256 || authored.receipt.engineRuntimeId !== d.engine.runtimeId) throw new Error("编译回执已过期，请修改源稿后重新编译");
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
    // A partial set of opening anchors is not a per-shot storyboard table.
    // The compiled prompt retains those scoped anchors and the complete motion timeline.
    const storyboardShots = taskMode !== "t2v" && settings.storyboardImageMode !== "skip" && shots.every(shot => d.shotInputs[shot.id]?.keyframeAssetId && d.shotInputs[shot.id]?.keyframePolicy !== "none") ? shots.map(shot => {
        const input = d.shotInputs[shot.id];
        const asset = input?.keyframeAssetId && d.assets[input.keyframeAssetId];
        const sourceNodeId = asset && asset.nodeId || input?.keyframeAssetId;
        const binding = bindings.find(ref => ref.sourceNodeId === sourceNodeId);
        if (!binding) throw new Error(`镜头 ${shot.id} 的正式关键帧未进入本段参考绑定`);
        binding.role = 'storyboard';
        return { id: shot.id, referenceBindingId: String(binding.id), duration: shot.duration };
    }) : undefined;
    const segment: Record<string, any> = { id: segmentId, sourceShotId: group.shotIds.join("~"), title: shots.map(shot => shot.title).join(" / "),
        duration: shots.reduce((sum, shot) => sum + shot.duration, 0), taskMode, prompt, referenceBindings: bindings,
        tailFrameContinuation: boundary?.tailFrame === true, motionContextEnabled: boundary?.motionContext === true,
        directorEngine: d.engine, directorSourceHash: authored.sourceHash, styleTemplateId, h3CharacterGroups: characterGroups,
        ...(storyboardShots ? { storyboardShots } : {}),
        aspectRatio: settings.videoAspectRatio || object(nodes.find((node: any) => node.id === group.nodeId)?.metadata).aspectRatio || BASE_H3_NODE_METADATA.aspectRatio,
        modelName: /* h3Model || */ object(nodes.find((node: any) => node.id === group.nodeId)?.metadata).modelName || BASE_H3_NODE_METADATA.modelName };
    const preflight = compileReferenceSubmission(project, segment);
    assertReferenceCompilation(preflight);
    if (preflight.compiledPrompt !== prompt) throw new Error(`Segment ${group.id} 的参考顺序需要重新绑定并编译；不能自动改写正式正文`);
    segment.productionClipProjection = { targetId: group.id, sourceHash: authored.sourceHash, styleTemplateDeclared: Object.hasOwn(planned, "styleTemplateId"), fieldHashes: Object.fromEntries(CLIP_PROJECTION_FIELDS.map(key => [key, clipFieldHash(segment[key])])) };
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
/** Project existing formal Clips during the same transaction as source/compilation changes. */
export function clipInputOperations(project: Record<string, any>, data: EpisodeProductionData, layout: ProductionLayoutPlan) {
    const operations: CanvasOperation[] = [], referenceSync: ReferenceSync[] = [];
    for (const group of data.clipGroups) {
        const nodeId = group.nodeId || layout.units.find(unit => unit.targets.includes(`segment:${group.id}`))?.members.find(member => member.role === "video")?.nodeId;
        const node = (project.nodes || []).find((node: any) => node.id === nodeId);
        const existing = (node?.metadata?.segments || []).find((segment: any) => segment.id === group.segmentId || segment.productionClipProjection?.targetId === group.id);
        if (!existing) continue;
        const projected = productionClipProjection(project, data, group, existing.id, existing);
        referenceSync.push(projected.result);
        if (projected.segment && (clipInputHash(existing) !== clipInputHash(projected.segment) || canonicalProduction(existing.productionClipProjection) !== canonicalProduction(projected.segment.productionClipProjection))) operations.push({ type: "update_h3_segment", nodeId, segmentId: existing.id, patch: projected.segment });
    }
    return { operations, referenceSync };
}
