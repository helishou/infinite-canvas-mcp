import crypto from "node:crypto";
import fs from "node:fs";
import type { DirectorProduction } from "@basketikun/canvas-agent/drama/production-contract";
import type { BackendDatabase } from "../db.js";
import { productionCanvasContext } from "./production-canvas.js";
import { reconcileSharedAssetConsumers } from "../canvas/drama-asset-library.js";

export type ApprovedSharedAsset = { id: string; dramaId: string; assetId: string; sourceProjectId: string; sourceNodeId: string; sourceVersion: number;
    storageKey: string; sha256: string; evidence: string; reviewStatus: "unreviewed" | "approved"; snapshot: Record<string, any>; createdAt: string };
const stable = (...parts: string[]) => crypto.createHash("sha256").update(parts.join("\0")).digest("hex");
const record = (value: unknown): Record<string, any> => value && typeof value === "object" ? value as Record<string, any> : {};
function fromRow(row: Record<string, any>): ApprovedSharedAsset {
    return { id: row.id, dramaId: row.drama_id, assetId: row.asset_id, sourceProjectId: row.source_project_id, sourceNodeId: row.source_node_id,
        sourceVersion: row.source_version, storageKey: row.storage_key, sha256: row.sha256, evidence: row.evidence || "", reviewStatus: row.evidence ? "approved" : "unreviewed", snapshot: JSON.parse(row.snapshot_json), createdAt: row.created_at };
}
export function listApprovedSharedAssets(db: BackendDatabase, dramaId: string) {
    return (db.db.prepare(`SELECT a.* FROM drama_asset_versions a WHERE drama_id=? AND rowid=(
        SELECT MAX(b.rowid) FROM drama_asset_versions b WHERE b.drama_id=a.drama_id AND b.asset_id=a.asset_id) ORDER BY a.asset_id`).all(dramaId) as Record<string, any>[]).map(fromRow);
}
export function sharedAssetHistory(db: BackendDatabase, dramaId: string) {
    return (db.db.prepare("SELECT * FROM drama_asset_versions WHERE drama_id=? ORDER BY rowid DESC").all(dramaId) as Record<string, any>[]).map(fromRow);
}

/** Register a usable media version; review evidence is optional historical metadata. */
export function registerSharedAssetVersion(db: BackendDatabase, projectId: string, version: number, assetId: string, director: DirectorProduction) {
    const drama = db.db.prepare("SELECT folder_id FROM drama_projects WHERE shared_asset_canvas_id=?").get(projectId) as { folder_id: string } | undefined;
    const asset = director.assets[assetId];
    const reviewed = asset?.status === "approved" && Boolean(asset.evidence?.trim());
    if (!drama || !asset || !["approved", "generated", "planned"].includes(asset.status) || !asset.nodeId || !asset.storageKey || !asset.sha256) return;
    const node = (db.getCanvasProject(projectId)?.nodes as Record<string, any>[] || []).find(item => item.id === asset.nodeId);
    if (!node) throw new Error(`共享素材「${assetId}」的引用节点 ${asset.nodeId} 已不在画布上，请重新绑定素材`);
    const now = new Date().toISOString();
    const media = db.getMediaFile(asset.storageKey);
    if (!media || !fs.existsSync(media.filePath) || crypto.createHash("sha256").update(fs.readFileSync(media.filePath)).digest("hex") !== asset.sha256) throw new Error(`共享素材「${assetId}」的归档文件或摘要无效`);
    const id = `${reviewed ? "approved" : "version"}-${stable(projectId, String(version), assetId, asset.storageKey, asset.sha256)}`;
    const roleNode = ["character", "scene", "prop"].includes(node.type);
    const character = node.type === "character";
    const snapshot = { title: node.title || assetId, type: roleNode ? node.type : "image", width: node.width || 340, height: node.height || 260,
        version: asset.version, content: asset.storageKey, metadata: { storageKey: asset.storageKey, naturalWidth: media.width, naturalHeight: media.height, mimeType: media.mimeType,
            ...(node.metadata?.sharedPromotionOrigin ? { sharedPromotionOrigin: structuredClone(node.metadata.sharedPromotionOrigin) } : {}),
            ...(character ? { characterName: node.metadata?.characterName || node.title, characterDescription: node.metadata?.characterDescription || "", characterEnglishName: node.metadata?.characterEnglishName || "",
                characterImages: (Array.isArray(node.metadata?.characterImages) ? node.metadata.characterImages : []).filter((image: any) => image.storageKey === asset.storageKey), characterPrimaryIndex: 0 } : {}),
            ...(node.type === "scene" ? { sceneName: node.metadata?.sceneName || node.title, sceneDescription: node.metadata?.sceneDescription || "", sceneImage: structuredClone(node.metadata?.sceneImage || {}) } : {}),
            ...(node.type === "prop" ? { propName: node.metadata?.propName || node.title, propDescription: node.metadata?.propDescription || "", propImage: structuredClone(node.metadata?.propImage || {}) } : {}) } };
    db.db.prepare(`INSERT OR IGNORE INTO drama_asset_versions
        (id, drama_id, asset_id, source_project_id, source_node_id, source_version, storage_key, sha256, snapshot_json, evidence, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, drama.folder_id, assetId, projectId, asset.nodeId, version, asset.storageKey, asset.sha256, JSON.stringify(snapshot), reviewed ? asset.evidence || "" : "", now);
    // The reviewed node already is the canonical shared instance. This caller owns the
    // production transaction; bind the directory directly, without creating a second node.
    const existingLibrary = db.listSharedAssetRecordsForProject(projectId).find(item => (item.metadata.sharedAssetSource as { sourceNodeId: string }).sourceNodeId === asset.nodeId);
    const libraryId = existingLibrary?.id || `shared-${stable(drama.folder_id, assetId)}`;
    db.upsertAssetRecord({ id: libraryId, kind: roleNode ? node.type : "image", title: String(snapshot.title), coverUrl: "", tags: existingLibrary?.tags || ["shared"],
        folderId: existingLibrary?.folderId || null, dramaId: drama.folder_id, source: existingLibrary?.source || "production-shared", note: existingLibrary?.note || null,
        data: {},
        metadata: { ...existingLibrary?.metadata, versionId: id, reviewStatus: reviewed ? "approved" : "unreviewed", assetId, sourceProjectId: projectId, sourceNodeId: asset.nodeId,
            sharedAssetSource: { dramaId: drama.folder_id, assetId: libraryId, sourceProjectId: projectId, sourceNodeId: asset.nodeId } }, createdAt: existingLibrary?.createdAt || now, updatedAt: now });
}

/**
 * 兼容包装：共享素材登记不再等待显式审核结论。
 * 只要本轮发布稿里该资产已经有归档媒体，就登记为可用版本；审核记录退化为可选的历史信息。
 * 这样分集引用共享图不需要「先审批」这一步。
 */
export function registerApprovedSharedAsset(db: BackendDatabase, projectId: string, version: number, assetId: string, director: DirectorProduction) {
    const asset = director.assets[assetId];
    if (!asset?.storageKey) return;
    return registerSharedAssetVersion(db, projectId, version, assetId, director);
}

export type SharedAssetIdentity = { dramaId: string; assetId: string; sourceProjectId: string; sourceNodeId: string };

/** A local or canonical source node must carry an explicit link to the same shared source. */
export function sharedAssetNodeMatchesSource(node: Record<string, any> | null | undefined, source: SharedAssetIdentity) {
    if (!node) return false;
    const metadata = record(node.metadata);
    const references = [metadata.sharedAssetReference, metadata.sharedAssetOrigin]
        .filter((value): value is Record<string, any> => Boolean(value && typeof value === "object" && !Array.isArray(value)));
    return references.length > 0 && references.every(reference =>
        reference.dramaId === source.dramaId
        && reference.assetId === source.assetId
        && reference.sourceProjectId === source.sourceProjectId
        && reference.sourceNodeId === source.sourceNodeId);
}

/** Validate a particular node's identity without requiring its ID to equal another projection's ID. */
export function validateSharedAssetNodeSource(db: BackendDatabase, projectId: string, source: SharedAssetIdentity, nodeId: string) {
    const sourceNode = validateSharedAssetSourceIdentity(db, projectId, source);
    const node = (db.getCanvasProject(projectId)?.nodes as Record<string, any>[] || []).find(item => item.id === nodeId);
    if (!node) throw new Error(`共享素材「${source.assetId || nodeId}」在制作画布上的绑定节点 ${nodeId} 不存在`);
    if (!sharedAssetNodeMatchesSource(node, source)) throw new Error(`共享素材「${source.assetId || nodeId}」的分集节点没有绑定当前共享来源`);
    return { sourceNode, node };
}

/** Check the one authoritative source pointer without requiring a copied or adopted media node. */
export function validateSharedAssetSourceIdentity(db: BackendDatabase, projectId: string, source: SharedAssetIdentity) {
    const episode = db.getDramaEpisodeByCanvasId(projectId);
    const consumer = productionCanvasContext(db, projectId), canonical = productionCanvasContext(db, source.sourceProjectId);
    const name = source.assetId || source.sourceNodeId;
    const selfOwnedSharedCanvas = consumer.role === "shared-assets" && projectId === source.sourceProjectId && consumer.dramaId === source.dramaId;
    if ((!selfOwnedSharedCanvas && (!episode || episode.dramaId !== source.dramaId || consumer.dramaId !== source.dramaId))
        || canonical.dramaId !== source.dramaId || canonical.role !== "shared-assets") {
        throw new Error(`共享素材「${name}」的分集或来源画布不属于当前剧目`);
    }
    const sourceNode = (db.getCanvasProject(source.sourceProjectId)?.nodes as Record<string, any>[] || []).find(item => item.id === source.sourceNodeId);
    if (!sourceNode) throw new Error(`共享素材「${name}」的当前共享来源节点不存在`);
    if (!["character", "scene", "prop"].includes(String(sourceNode.type || ""))) throw new Error(`共享素材「${name}」当前来源节点类型不支持`);
    return sourceNode;
}

export class SharedAssetCoordinator {
    constructor(private db: BackendDatabase) {}
    start() {
        this.reconcileExistingSharedConsumers();
        return () => {};
    }
    private reconcileExistingSharedConsumers() {
        const forceMarker = "maintenance.shared-asset-consumers.v1";
        const repairMarker = "maintenance.shared-asset-consumers.v2";
        const h3OutfitRepairMarker = "maintenance.shared-asset-consumers.v3";
        const h3SiblingOutfitRepairMarker = "maintenance.shared-asset-consumers.v4";
        if (this.db.getSetting(forceMarker) && this.db.getSetting(repairMarker) && this.db.getSetting(h3OutfitRepairMarker)
            && this.db.getSetting(h3SiblingOutfitRepairMarker)) return;
        try {
            const projectIds = (this.db.db.prepare(`SELECT DISTINCT json_extract(metadata_json, '$.sharedAssetSource.sourceProjectId') AS projectId
                FROM assets WHERE json_extract(metadata_json, '$.sharedAssetSource.sourceProjectId') IS NOT NULL`).all() as Array<{ projectId: string | null }>)
                .map(row => String(row.projectId || "")).filter(Boolean);
            if (!this.db.getSetting(forceMarker)) {
                const backup = projectIds.length ? this.db.snapshotForMaintenance("pre-shared-asset-rebind") : undefined;
                const results = projectIds.map(projectId => reconcileSharedAssetConsumers(this.db, projectId, true));
                this.db.setSetting(forceMarker, { completedAt: new Date().toISOString(), sharedProjects: projectIds.length,
                    updatedEpisodes: results.reduce((count, result) => count + result.productionUpdates.length, 0), ...(backup ? { backup } : {}) });
            }
            if (!this.db.getSetting(repairMarker)) {
                // Repair blank legacy H3 media slots after the forced identity rebind.
                // This pass preserves current picture selections while mapping by exact source node.
                const backup = projectIds.length ? this.db.snapshotForMaintenance("pre-shared-asset-rebind-v2") : undefined;
                const results = projectIds.map(projectId => reconcileSharedAssetConsumers(this.db, projectId, false));
                this.db.setSetting(repairMarker, { completedAt: new Date().toISOString(), sharedProjects: projectIds.length,
                    updatedEpisodes: results.reduce((count, result) => count + result.productionUpdates.length, 0), ...(backup ? { backup } : {}) });
            }
            if (!this.db.getSetting(h3OutfitRepairMarker)) {
                // Correct character outfits by their exact shared source node and persisted H3 labels.
                const backup = projectIds.length ? this.db.snapshotForMaintenance("pre-shared-asset-h3-outfit-rebind") : undefined;
                const results = projectIds.map(projectId => reconcileSharedAssetConsumers(this.db, projectId, false));
                this.db.setSetting(h3OutfitRepairMarker, { completedAt: new Date().toISOString(), sharedProjects: projectIds.length,
                    updatedEpisodes: results.reduce((count, result) => count + result.productionUpdates.length, 0), ...(backup ? { backup } : {}) });
            }
            if (!this.db.getSetting(h3SiblingOutfitRepairMarker)) {
                // Repair Clips whose role group lacks local reference rows by borrowing only
                // exact sibling slots backed by the same shared source node and outfit ID.
                const backup = projectIds.length ? this.db.snapshotForMaintenance("pre-shared-asset-h3-sibling-outfit-rebind") : undefined;
                const results = projectIds.map(projectId => reconcileSharedAssetConsumers(this.db, projectId, false));
                this.db.setSetting(h3SiblingOutfitRepairMarker, { completedAt: new Date().toISOString(), sharedProjects: projectIds.length,
                    updatedEpisodes: results.reduce((count, result) => count + result.productionUpdates.length, 0), ...(backup ? { backup } : {}) });
            }
        } catch (error) {
            console.error("[shared-assets] initial consumer reconciliation failed; it will retry on the next Backend start", error);
        }
    }
}
