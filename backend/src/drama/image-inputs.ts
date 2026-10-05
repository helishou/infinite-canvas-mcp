import crypto from "node:crypto";
import { canonicalProduction, type DirectorProduction, type EpisodeProductionData } from "@basketikun/canvas-agent/drama/production-contract";
import { productionImageInput, type ProductionImageInput } from "@basketikun/canvas-agent/reference-contract";
import type { CanvasOperation } from "../canvas/project-ops.js";
import type { BackendDatabase } from "../db.js";
import type { ProductionLayoutPlan } from "@basketikun/canvas-agent/drama/production-contract";
import { applyDirectorSourcePatch } from "@basketikun/canvas-agent/drama/production-validation";
import { projectDirector } from "./director.js";

const hash = (value: unknown) => crypto.createHash("sha256").update(canonicalProduction(value)).digest("hex");
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
        // A legacy/local prompt difference must not reject unrelated workflow edits or reviews.
        // Keep this target untouched; verifyImageInput still blocks its next submission.
        if (projectedNodes.some(node => node.metadata?.prompt && node.metadata.prompt !== artifact.prompt
            && oldArtifact && node.metadata.prompt !== oldArtifact.prompt)) continue;
        if (!source) {
            const unit = layout.units.find(item => item.id === `frame-prompt:${shotId}`), member = unit?.members.find(item => item.role === "prompt" && item.nodeId === sourceId);
            if (!unit || !member) throw new Error(`关键帧 ${shotId} 缺少正式提示词节点布局`);
            operations.push({ type: "add_node", id: sourceId, nodeType: member.nodeType, title: target.title || "关键帧提示词", position: member.position, width: member.size.width, height: member.size.height,
                metadata: { generationMode: "image", productionShotId: shotId, ...(target.metadata?.groupId ? { groupId: target.metadata.groupId } : {}), productionLayoutUnitId: unit.id, productionLayoutBounds: unit.bounds.size } });
        }
        for (const node of projectedNodes) {
            if (hash(node.metadata?.productionImageInput || null) !== hash(input) || node.metadata?.prompt !== artifact.prompt) operations.push({ type: "update_node", id: node.id, metadata: { productionImageInput: input, prompt: artifact.prompt } });
        }
        const expected = [...new Set(input.references.map(ref => ref.nodeId))];
        const incoming = connections.filter(edge => edge.toNodeId === sourceId).sort((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER));
        if (hash(incoming.map(edge => edge.fromNodeId)) !== hash(expected)) {
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

/** Called inside the existing canvas ops transaction. Never edits published or in-flight inputs. */
export function syncImageReferenceEdits(db: BackendDatabase, projectId: string, before: Record<string, any>, after: Record<string, any>) {
    const sources = rows(before.nodes).filter(node => productionImageInput(node)?.sourceNodeId === node.id);
    const operations: CanvasOperation[] = [];
    if (!sources.length) return { updates: [], operations };
    const episode = db.getDramaEpisodeByCanvasId(projectId);
    const ownerId = episode?.id || projectId, table = episode ? "episode_productions" : "canvas_productions", column = episode ? "episode_id" : "project_id";
    const row = db.db.prepare(`SELECT revision, draft_json FROM ${table} WHERE ${column}=?`).get(ownerId) as { revision: number; draft_json: string } | undefined;
    if (!row) return { updates: [], operations };
    const draft = JSON.parse(row.draft_json) as EpisodeProductionData, director = draft.director;
    if (!director) return { updates: [], operations };
    const baselineSourceHash = director.sourceHash;
    const changed: Array<{ input: ProductionImageInput; references: ProductionImageInput["references"] }> = [];
    const incoming = (project: Record<string, any>, id: string) => rows(project.connections).filter(edge => edge.toNodeId === id)
        .sort((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER)).map(edge => edge.fromNodeId);
    for (const source of sources) {
        const input = productionImageInput(source)!;
        if (!rows(after.nodes).some(node => node.id === source.id)) continue;
        const ids = incoming(after, source.id);
        if (hash(ids) === hash(incoming(before, source.id))) continue;
        if (input.sourceHash !== baselineSourceHash) throw new Error("正式参考源稿已变化，请回读后再编辑连线");
        if (new Set(ids).size !== ids.length) throw new Error("正式图片参考不能用重复连线扩张输入");
        const card = rows(director.source.asset_cards).find(card => card.id === input.targetId);
        const plan = rows(director.source.asset_plan).find(plan => String(plan.asset_id || plan.id) === input.targetId);
        if (!card || !plan) throw new Error("目标缺少正式参考卡，请先由导演登记 asset_cards，再编辑参考");
        const refs = ids.flatMap((nodeId: string) => {
            const existing = input.references.filter(ref => ref.nodeId === nodeId);
            if (existing.length) return existing;
            const match = Object.entries(director.assets).find(([, asset]) => asset.nodeId === nodeId && asset.storageKey && asset.sha256 && asset.status === "approved" && asset.evidence?.trim());
            if (!match) throw new Error(`新参考 ${nodeId} 必须先登记并批准到正式资产表`);
            const [assetId, asset] = match, assetPlan = rows(director.source.asset_plan).find(plan => String(plan.asset_id || plan.id) === assetId);
            const prior = director.artifacts.find(artifact => artifact.kind === "image" && artifact.targetId === input.targetId)?.references.find(ref => ref.nodeId === nodeId && ref.storageKey === asset.storageKey);
            const inferredRole = assetPlan?.kind === "style" ? "style" : ["character", "costume", "injury"].includes(assetPlan?.kind) ? "identity" : "composition";
            return [{ ...prior, label: "", nodeId, assetId, assetVersion: asset.version, storageKey: asset.storageKey!, sha256: asset.sha256!, role: String(prior?.role || assetPlan?.reference_role || inferredRole) }];
        }).map((ref, index) => ({ ...ref, label: `<Picture ${index + 1}>` }));
        card.references = refs.map((ref, index) => {
            const prior = (card.references || []).find((item: Record<string, any>) => item.asset_id === ref.assetId);
            return { ...prior, image: index + 1, asset_id: ref.assetId, asset_version: ref.assetVersion, role: ref.role,
                subject: prior?.subject || ref.assetId, preserve: prior?.preserve || ref.preserve || "仅保留该正式资产登记的特征", exclude: prior?.exclude || ref.exclude || "不继承未登记的对象、背景和姿势" };
        });
        const assetIds = [...new Set(refs.map(ref => ref.assetId))];
        for (const shot of Object.values(director.shotInputs)) if (shot.keyframeAssetId === input.targetId) shot.assetIds = assetIds;
        applyDirectorSourcePatch(director, "asset", input.targetId, { depends_on: assetIds });
        changed.push({ input, references: refs });
    }
    if (!changed.length) return { updates: [], operations };
    projectDirector(draft);
    // All receipts are stale after a source edit; keep exact current choices visible until recompilation.
    for (const node of rows(after.nodes)) {
        const old = productionImageInput(node);
        if (!old) continue;
        const edited = changed.find(item => item.input.targetId === old.targetId);
        const base = { ...old, sourceHash: director.sourceHash, ...(edited ? { references: edited.references } : {}), stale: true };
        operations.push({ type: "update_node", id: node.id, metadata: { productionImageInput: { ...base, inputHash: hash({ ...base, inputHash: undefined, stale: undefined }) } } });
    }
    const revision = row.revision + 1;
    db.db.prepare(`UPDATE ${table} SET revision=?, draft_json=?, updated_at=? WHERE ${column}=?`).run(revision, JSON.stringify(draft), new Date().toISOString(), ownerId);
    return { updates: [{ entityId: ownerId, revision }], operations };
}
