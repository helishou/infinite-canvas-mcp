import { mergeDirectorInput } from "./input-merge.js";
import crypto from "node:crypto";
import { canonicalProduction, type DirectorProduction, type EpisodeProductionData } from "@basketikun/canvas-agent/drama/production-contract";
import { productionImageInput, type ProductionImageInput } from "@basketikun/canvas-agent/reference-contract";
import type { CanvasOperation } from "../canvas/project-ops.js";
import type { BackendDatabase } from "../db.js";
import type { ProductionLayoutPlan } from "@basketikun/canvas-agent/drama/production-contract";
import { applyDirectorSourcePatch } from "@basketikun/canvas-agent/drama/production-validation";
import { projectDirector } from "./director.js";

const hash = (value: unknown) => crypto.createHash("sha256").update(canonicalProduction(value ?? null)).digest("hex");
const stableId = (kind: string, ...parts: string[]) => `${kind}-${crypto.createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 24)}`;
const rows = (value: unknown): Record<string, any>[] => Array.isArray(value) ? value : [];
type ImageArtifact = DirectorProduction["artifacts"][number];

/** The artifact is a compiler receipt, never a second editable reference source. */
export function compiledImageInput(director: DirectorProduction, artifact: ImageArtifact, sourceNodeId: string): ProductionImageInput {
    const card = rows(director.source.asset_cards).find(card => card.id === artifact.targetId);
    const references = artifact.references.map((ref, index) => {
        const match = Object.entries(director.assets).find(([id, asset]) => (!ref.assetId || id === ref.assetId) && asset.nodeId === ref.nodeId && asset.storageKey === ref.storageKey && asset.sha256 === ref.sha256);
        if (!match) throw new Error(`参考 ${ref.label} 缺少正式资产版本`);
        if (ref.assetId && ref.assetId !== match[0] || ref.assetVersion && ref.assetVersion !== match[1].version) throw new Error(`参考 ${ref.label} 的批准版本已变化`);
        const authored = rows(card?.references)[index];
        return { ...ref, assetId: match[0], assetVersion: match[1].version,
            ...(ref.preserve !== undefined || authored?.preserve !== undefined ? { preserve: ref.preserve ?? authored?.preserve } : {}),
            ...(ref.exclude !== undefined || authored?.exclude !== undefined ? { exclude: ref.exclude ?? authored?.exclude } : {}) };
    });
    const input = { schemaVersion: 1 as const, targetId: artifact.targetId, sourceNodeId, sourceHash: artifact.sourceHash, promptHash: artifact.sha256, references };
    return { ...input, inputHash: hash(input), ...(artifact.status !== "ready" ? { stale: true } : {}) };
}

export function assertImageReferenceCoverage(director: DirectorProduction, artifact: ImageArtifact) {
    const plan = rows(director.source.asset_plan).find(item => String(item.asset_id || item.id) === artifact.targetId);
    const card = rows(director.source.asset_cards).find(item => item.id === artifact.targetId);
    const input = compiledImageInput(director, artifact, artifact.targetId);
    const ids = input.references.map(ref => ref.assetId);
    for (const id of plan?.depends_on || []) if (!ids.includes(id)) throw new Error(`图像 ${artifact.targetId} 遗漏正式依赖参考：${id}`);
    if (card && (rows(card.references).some((ref, index) => ref.asset_id !== ids[index] || Number(ref.image) !== index + 1)
        || rows(card.references).length !== ids.length)) throw new Error(`图像 ${artifact.targetId} 的编译参考与正式清单数量或顺序不一致`);
    for (const [shotId, shotInput] of Object.entries(director.shotInputs)) {
        if (shotInput.keyframeAssetId !== artifact.targetId) continue;
        const shot = rows(director.source.shots).find(item => item.id === shotId);
        for (const id of [...(shot?.required_assets || []), ...shotInput.assetIds]) {
            if (!shotInput.assetIds.includes(id) || !ids.includes(id)) throw new Error(`镜头 ${shotId} 的出场/场景资产未完整登记并传入：${id}`);
        }
    }
}

/** Project exact media onto both the generator and output; connections only visualize order. */
export function imageInputOperations(project: Record<string, any>, data: EpisodeProductionData, ownerId: string, previous: EpisodeProductionData | undefined, layout: ProductionLayoutPlan): CanvasOperation[] {
    const director = data.director;
    if (!director) return [];
    const nodes = rows(project.nodes), connections = rows(project.connections), operations: CanvasOperation[] = [];
    for (const artifact of director.artifacts.filter(item => item.kind === "image")) {
        const targetId = director.assets[artifact.targetId]?.nodeId;
        const target = nodes.find(node => node.id === targetId);
        if (!target) continue;
        const shotId = Object.entries(director.shotInputs).find(([, input]) => input.keyframeAssetId === artifact.targetId)?.[0];
        const sourceId = shotId ? stableId("production-source", ownerId, shotId) : target.id;
        const source = nodes.find(node => node.id === sourceId);
        const boundReferences = artifact.references.every(ref => Object.values(director.assets).some(asset => asset.nodeId === ref.nodeId && asset.storageKey === ref.storageKey && asset.sha256 === ref.sha256));
        if (artifact.status !== "ready" || !boundReferences) {
            for (const node of source && source.id !== target.id ? [target, source] : [target]) {
                const input = productionImageInput(node);
                if (input && !input.stale) operations.push({ type: "update_node", id: node.id, metadata: { productionImageInput: { ...input, stale: true } } });
            }
            continue;
        }
        const input = compiledImageInput(director, artifact, sourceId);
        const oldArtifact = previous?.director?.artifacts.find(item => item.kind === "image" && item.targetId === artifact.targetId);
        const projectedNodes = sourceId === target.id ? [target] : [target, source || { id: sourceId }];
        if (!source) {
            const unit = layout.units.find(item => item.id === `frame-prompt:${shotId}`), member = unit?.members.find(item => item.role === "prompt" && item.nodeId === sourceId);
            if (!unit || !member) throw new Error(`关键帧 ${shotId} 缺少正式提示词节点布局`);
            operations.push({ type: "add_node", id: sourceId, nodeType: member.nodeType, title: target.title || "关键帧提示词", position: member.position, width: member.size.width, height: member.size.height,
                metadata: { generationMode: "image", productionShotId: shotId, ...(target.metadata?.groupId ? { groupId: target.metadata.groupId } : {}), productionLayoutUnitId: unit.id, productionLayoutBounds: unit.bounds.size } });
        }
        const oldReferenceIds = [...new Set((productionImageInput(source || target)?.references || []).map(ref => ref.nodeId))];
        const currentIncoming = connections.filter(edge => edge.toNodeId === sourceId).sort((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER)).map(edge => edge.fromNodeId);
        const referenceBaseline = source?.metadata?.productionImageProjection?.fieldHashes?.referenceNodeIds || hash(oldReferenceIds);
        const keepReferences = referenceBaseline !== hash(currentIncoming);
        for (const node of projectedNodes) {
            const nextValues = { prompt: artifact.prompt, referenceNodeIds: [...new Set(input.references.map(ref => ref.nodeId))] };
            const projection = node.metadata?.productionImageProjection;
            const baseline = projection?.fieldHashes || (oldArtifact && node.metadata?.prompt !== undefined ? { prompt: hash(oldArtifact.prompt) } : undefined);
            const merged = mergeDirectorInput({ ...(node.metadata || {}), referenceNodeIds: currentIncoming }, nextValues, baseline, [["prompt"], ["referenceNodeIds"]]);
            operations.push({ type: "update_node", id: node.id, metadata: { productionImageInput: input, prompt: merged.merged.prompt, canvasReferenceNodeIds: keepReferences ? currentIncoming : nextValues.referenceNodeIds,
                productionImageProjection: { targetId: artifact.targetId, sourceNodeId: sourceId, fieldHashes: { prompt: hash(artifact.prompt), referenceNodeIds: hash(nextValues.referenceNodeIds) }, nextValues, fieldGroups: [["prompt"], ["referenceNodeIds"]], conflicts: merged.conflicts, manualFields: merged.manualFields, referenceChanged: keepReferences } } });
        }
        const expected = [...new Set(input.references.map(ref => ref.nodeId))];
        const incoming = connections.filter(edge => edge.toNodeId === sourceId).sort((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER));
        if (!keepReferences && hash(incoming.map(edge => edge.fromNodeId)) !== hash(expected)) {
            if (incoming.length) operations.push({ type: "delete_connections", ids: incoming.map(edge => edge.id) });
            expected.forEach((fromNodeId, order) => operations.push({ type: "connect_nodes", id: stableId("production-reference", sourceId, fromNodeId), fromNodeId, toNodeId: sourceId, order }));
        }
        if (sourceId !== target.id && !connections.some(edge => edge.fromNodeId === sourceId && edge.toNodeId === target.id)) operations.push({ type: "connect_nodes", id: stableId("production-output", sourceId, target.id), fromNodeId: sourceId, toNodeId: target.id });
    }
    return operations;
}

/** Reject drift before creating any task. Submission carries the immutable, complete manifest. */
export function verifyImageInput(project: Record<string, any>, director: DirectorProduction, artifact: ImageArtifact, nodeId: string, sourceNodeId?: string) {
    assertImageReferenceCoverage(director, artifact);
    const target = rows(project.nodes).find(node => node.id === nodeId), projected = productionImageInput(target);
    const expected = compiledImageInput(director, artifact, projected?.sourceNodeId || sourceNodeId || nodeId);
    if (!projected || projected.stale || hash(projected) !== hash(expected)) throw new Error(`图像 ${artifact.targetId} 的画布参考清单与正式编译不一致，请重新准备节点`);
    const source = rows(project.nodes).find(node => node.id === expected.sourceNodeId);
    if (!source || hash(productionImageInput(source)) !== hash(expected)) throw new Error(`图像 ${artifact.targetId} 的参考源节点未同步`);
    if (target?.metadata?.prompt !== artifact.prompt || source.metadata?.prompt !== artifact.prompt) throw new Error(`图像 ${artifact.targetId} 的画布提示词已有修改，请先合并正式源并重新编译`);
    const actual = rows(project.connections).filter(edge => edge.toNodeId === source.id).sort((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER)).map(edge => edge.fromNodeId);
    if (hash(actual) !== hash([...new Set(expected.references.map(ref => ref.nodeId))])) throw new Error(`图像 ${artifact.targetId} 的参考连线数量或顺序已变化，请重新编译`);
    return structuredClone(expected);
}

/** Reference edits update the canvas view, preserving immutable director baselines. */
export function syncImageReferenceEdits(_db: BackendDatabase, _projectId: string, _before: Record<string, any>, after: Record<string, any>) {
    const operations: CanvasOperation[] = [];
    for (const node of rows(after.nodes).filter(node => productionImageInput(node))) {
        const sourceId = productionImageInput(node)!.sourceNodeId;
        const ids = rows(after.connections).filter(edge => edge.toNodeId === sourceId).sort((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER)).map(edge => edge.fromNodeId);
        if (hash(ids) !== hash(node.metadata?.canvasReferenceNodeIds)) operations.push({ type: "update_node", id: node.id, metadata: { canvasReferenceNodeIds: ids } });
    }
    return { updates: [] as Array<{ entityId: string; revision: number }>, operations };
}
