import crypto from "node:crypto";
import type { Asset, BackendDatabase, CanvasProject } from "../db.js";
import type { CanvasCommandContext, CanvasCommit } from "./collaboration.js";
import { commandFingerprint, collaborationError } from "./collaboration.js";
import type { CanvasOperation } from "./project-ops.js";
import { ensureProductionCanvas } from "../drama/production-canvas.js";
import { productionNodePosition } from "../drama/production-layout-geometry.js";
import { selectSmartImageResult } from "@basketikun/canvas-agent/reference-contract";
import { libraryAssetNode, assetField, sameAssetValue, setAssetField, sharedAssetFields, resolveSharedAssetNode, stripSharedAssetContent, type AssetNode, type SharedAssetReference, type SharedAssetSource } from "@basketikun/canvas-agent/shared-asset-reference";

export type AssetWriteCommand = {
    operationId?: string;
    canvasSource?: { projectId: string; nodeId: string };
    discardLocal?: boolean;
    resolveConflicts?: "local";
    /** Exact external request for replay, before merging with current server state. */
    request?: unknown;
    assetBase?: { title: string; data: Record<string, unknown> };
    withinTransaction?: boolean;
    deferredCommits?: CanvasCommit[];
};
const kinds = new Set(["text", "image", "video", "audio", "character", "scene"]);
const nodes = (project: CanvasProject | null) => (project?.nodes || []) as AssetNode[];
export function rawProject(db: BackendDatabase, id: string): CanvasProject | null {
    const row = db.db.prepare("SELECT data_json FROM canvas_projects WHERE id=?").get(id) as { data_json: string } | undefined;
    return row ? JSON.parse(row.data_json) : null;
}
export function rawAsset(db: BackendDatabase, id: string): Asset | null {
    return db.getAssetRecord(id);
}
export function sourceOf(asset: Asset | null): SharedAssetSource | undefined { return asset?.metadata?.sharedAssetSource as SharedAssetSource | undefined; }
export const nodeForAsset = libraryAssetNode;
function effectiveSourceNode(node: AssetNode, kind: string): AssetNode {
    if (node.type !== "config" || node.metadata?.smart !== true || kind !== "image") return node;
    const selected = selectSmartImageResult(node.metadata, { mode: "node_selection" });
    if (selected.error) throw new Error(selected.error);
    const image = selected.image;
    return image ? { ...node, type: kind, metadata: { ...node.metadata, content: image.content || image.url || "", storageKey: image.storageKey, naturalWidth: image.naturalWidth || image.width, naturalHeight: image.naturalHeight || image.height, bytes: image.bytes, mimeType: image.mimeType } } : { ...node, type: kind };
}
export function projectAsset(db: BackendDatabase, asset: Asset): Asset {
    const source = sourceOf(asset);
    if (!source) return asset;
    const node = nodes(rawProject(db, source.sourceProjectId)).find(n => n.id === source.sourceNodeId);
    if (!node) throw collaborationError("ASSET_SOURCE_MISSING", `共享资产源不存在: ${asset.id}`);
    const m = effectiveSourceNode(node, asset.kind).metadata || {};
    let data: Record<string, any> = {};
    if (asset.kind === "character") data = { name: node.title, englishName: m.characterEnglishName || "", description: m.characterDescription || "", images: m.characterImages || [], primaryIndex: m.characterPrimaryIndex || 0, voice: m.characterVoiceUrl || "", voiceName: m.characterVoiceName || "", voiceDescription: m.characterVoiceDescription || "", voiceStorageKey: m.characterVoiceStorageKey, voiceAssetId: m.characterVoiceAssetId || "" };
    else if (asset.kind === "scene") data = { name: node.title, description: m.sceneDescription || "", image: m.sceneImage, colorCard: m.sceneColorCard, colorPalette: m.sceneColorPalette, colorCardPrompt: m.sceneColorCardPrompt || "" };
    else if (asset.kind === "text") data = { content: m.content || "" };
    else data = { ...(asset.kind === "image" ? { dataUrl: m.content || "" } : { url: m.content || "" }), storageKey: m.storageKey, width: m.naturalWidth, height: m.naturalHeight, bytes: m.bytes, mimeType: m.mimeType, durationMs: m.durationMs };
    return { ...asset, title: node.title || "", data, coverUrl: ["image", "character", "scene"].includes(asset.kind) ? String(m.content || "") : asset.coverUrl };
}
export function resolveProjectAssets(db: BackendDatabase, project: CanvasProject): CanvasProject {
    const cache = new Map<string, CanvasProject | null>();
    return { ...project, nodes: nodes(project).map(node => {
        const ref = node.metadata?.sharedAssetReference as SharedAssetReference | undefined;
        if (!ref) return node;
        if (!cache.has(ref.sourceProjectId)) cache.set(ref.sourceProjectId, rawProject(db, ref.sourceProjectId));
        const source = nodes(cache.get(ref.sourceProjectId)!).find(n => n.id === ref.sourceNodeId);
        return source ? resolveSharedAssetNode(node, effectiveSourceNode(source, node.type)) : { ...node, metadata: { ...node.metadata, sharedAssetMissing: true } };
    }) };
}
export function stripProjectAssets(project: CanvasProject): CanvasProject { return { ...project, nodes: nodes(project).map(stripSharedAssetContent) }; }
export function assetConsumers(db: BackendDatabase, source: SharedAssetSource) {
    return db.db.prepare(`SELECT p.id AS projectId, COALESCE(json_extract(p.data_json,'$.title'),p.id) AS title, json_extract(n.value,'$.id') AS nodeId
        FROM canvas_projects p, json_each(p.data_json,'$.nodes') n
        WHERE (json_extract(n.value,'$.metadata.sharedAssetReference.assetId')=? AND json_extract(n.value,'$.metadata.sharedAssetReference.dramaId')=?)
           OR (json_extract(n.value,'$.metadata.sharedAssetOrigin.sourceProjectId')=? AND json_extract(n.value,'$.metadata.sharedAssetOrigin.sourceNodeId')=?)`)
        .all(source.assetId, source.dramaId, source.sourceProjectId, source.sourceNodeId) as { projectId: string; title: string; nodeId: string }[];
}
function assertUnused(db: BackendDatabase, source: SharedAssetSource) {
    const consumers = assetConsumers(db, source);
    if (consumers.length) throw Object.assign(collaborationError("ASSET_IN_USE", `资产仍被画布引用：${[...new Set(consumers.map(c => c.title))].join("、")}`), { consumers });
}
export function validateAssetOperation(db: BackendDatabase, projectId: string, project: CanvasProject, operation: CanvasOperation, context?: CanvasCommandContext) {
    if (context?.runtimeWrite) return;
    const node = nodes(project).find(n => n.id === operation.id);
    if (operation.type === "delete_node") {
        for (const asset of db.listSharedAssetRecordsForProject(projectId)) { const source = sourceOf(asset); if (source?.sourceProjectId === projectId && source.sourceNodeId === operation.id) assertUnused(db, source); }
    }
    const metadata = operation.metadata as Record<string, any> | undefined;
    const changedRef = metadata?.sharedAssetReference;
    const ref = node?.metadata?.sharedAssetReference as SharedAssetReference | undefined;
    if ((operation.metadataDelete as string[] || []).some(key => key === "sharedAssetReference" || key === "sharedLibraryAssetId") || metadata?.sharedLibraryAssetId !== undefined && metadata.sharedLibraryAssetId !== node?.metadata?.sharedLibraryAssetId) throw new Error("共享资产身份由 Backend 维护");
    if (ref && (node?.type === "character" && metadata?.characterAssetId !== undefined && metadata.characterAssetId !== ref.assetId || node?.type === "scene" && metadata?.sceneAssetId !== undefined && metadata.sceneAssetId !== ref.assetId)) throw new Error("共享资产身份由 Backend 维护");
    if (changedRef !== undefined) {
        if (ref && !sameAssetValue(ref, changedRef)) throw new Error("共享引用身份和本地修改由 Backend 维护");
        if (!ref) {
            const source = sourceOf(rawAsset(db, String(changedRef.assetId)));
            const { edits, ...identity } = changedRef;
            if (!source || !sameAssetValue(source, identity) || source.sourceProjectId === projectId) throw new Error("共享资产引用来源不合法");
            if (edits && Object.keys(edits).length) {
                const original = db.listCanvasProjects().flatMap(p => nodes(p)).find(n => sameAssetValue(n.metadata?.sharedAssetReference, changedRef));
                if (!original) throw new Error("复制引用的编辑基线不存在，不能伪造本地修改");
            }
            const episode = db.getDramaEpisodeByCanvasId(projectId);
            if (!episode || episode.dramaId !== source.dramaId) throw new Error("只能引用同剧目的共享资产");
            if (operation.nodeType && operation.nodeType !== rawAsset(db, source.assetId)?.kind) throw new Error("引用类型与共享资产不一致");
        }
    }
    const patch = operation.patch as Record<string, unknown> | undefined;
    if (ref && patch?.type && patch.type !== node?.type) throw new Error("不能改变共享引用节点类型");
    if (node && patch?.type && patch.type !== node.type && (node.metadata?.sharedLibraryAssetId || db.listSharedAssetRecordsForProject(projectId).some(asset => sourceOf(asset)?.sourceNodeId === node.id))) throw new Error("共享资产类型不能改变，请在独立节点上创建新类型资产");
}
/** Delta receipts must contain the current projection, even when the picker snapshot was stale. */
export function normalizeAssetInsertion(db: BackendDatabase, operation: CanvasOperation) {
    if (operation.type !== "add_node") return;
    const metadata = operation.metadata as Record<string, any> | undefined;
    const ref = metadata?.sharedAssetReference as SharedAssetReference | undefined;
    if (!ref) return;
    const source = nodes(rawProject(db, ref.sourceProjectId)).find(n => n.id === ref.sourceNodeId);
    if (!source) throw new Error("共享资产源不存在");
    const type = rawAsset(db, ref.assetId)?.kind || source.type;
    const effective = resolveSharedAssetNode({ id: String(operation.id || ""), type, title: operation.title as string, metadata }, effectiveSourceNode(source, type));
    operation.title = effective.title;
    operation.metadata = { ...effective.metadata, ...(type === "character" ? { characterAssetId: ref.assetId } : {}), ...(type === "scene" ? { sceneAssetId: ref.assetId } : {}) };
}
/** Capture ordinary update_node edits after applying the op, without storing a content replica. */
export function captureAssetEdits(db: BackendDatabase, project: CanvasProject, operation: CanvasOperation, context?: CanvasCommandContext): CanvasOperation[] {
    const textTarget = operation.target as { nodeId?: string; field?: string; segmentId?: string; textItemId?: string } | undefined;
    const isText = ["text_update", "text_replace"].includes(operation.type) && textTarget?.field === "content" && !textTarget.segmentId && !textTarget.textItemId;
    if (context?.runtimeWrite && context.source?.kind !== "task" || operation.type !== "update_node" && !isText) return [];
    const node = nodes(project).find(n => n.id === (isText ? textTarget?.nodeId : operation.id));
    const ref = node?.metadata?.sharedAssetReference as SharedAssetReference | undefined;
    if (!node || !ref) return [];
    const rawSource = nodes(rawProject(db, ref.sourceProjectId)).find(n => n.id === ref.sourceNodeId);
    const source = rawSource ? effectiveSourceNode(rawSource, node.type) : undefined;
    if (!source) throw new Error("共享资产源不存在，保留本地编辑后重试");
    const edits = { ...ref.edits };
    const touched = new Set([...(isText ? ["metadata.content"] : []), ...(Object.keys(operation.patch || {}).includes("title") ? ["title"] : []), ...Object.keys(operation.metadata || {}).map(k => `metadata.${k}`), ...(operation.metadataDelete as string[] || []).map(k => `metadata.${k}`)]);
    for (const field of sharedAssetFields(node.type).filter(f => touched.has(f))) {
        const value = assetField(node, field), shared = assetField(source, field);
        if (sameAssetValue(value, shared)) delete edits[field];
        else edits[field] = { base: edits[field] ? edits[field].base : shared, ...(value === undefined ? { deleted: true } : { value }) };
    }
    const updated = { ...ref, ...(Object.keys(edits).length ? { edits } : {}) };
    if (!Object.keys(edits).length) delete updated.edits;
    node.metadata!.sharedAssetReference = updated;
    return [{ type: "update_node", id: node.id, metadata: { sharedAssetReference: updated } }];
}
function nodePatch(node: AssetNode): CanvasOperation {
    return { type: "update_node", id: node.id, patch: { title: node.title || "" }, metadata: Object.fromEntries(sharedAssetFields(node.type).filter(f => f !== "title").map(f => [f.slice(9), assetField(node, f)]).filter(([, v]) => v !== undefined)), metadataDelete: sharedAssetFields(node.type).filter(f => f !== "title" && assetField(node, f) === undefined).map(f => f.slice(9)) };
}
function changedNodePatch(previous: AssetNode, node: AssetNode): CanvasOperation | undefined {
    const changed = sharedAssetFields(node.type).filter(f => !sameAssetValue(assetField(previous, f), assetField(node, f)));
    if (!changed.length) return;
    return { type: "update_node", id: node.id, ...(changed.includes("title") ? { patch: { title: node.title || "" } } : {}),
        metadata: Object.fromEntries(changed.filter(f => f !== "title" && assetField(node, f) !== undefined).map(f => [f.slice(9), assetField(node, f)])),
        metadataDelete: changed.filter(f => f !== "title" && assetField(node, f) === undefined).map(f => f.slice(9)) };
}
export function propagateAssetChanges(db: BackendDatabase, projectId: string, before: CanvasProject, after: CanvasProject, deferredCommits: CanvasCommit[]) {
    for (const asset of db.listSharedAssetRecordsForProject(projectId)) {
        const source = sourceOf(asset);
        if (!source || source.sourceProjectId !== projectId) continue;
        const oldRaw = nodes(before).find(n => n.id === source.sourceNodeId), newRaw = nodes(after).find(n => n.id === source.sourceNodeId);
        const oldNode = oldRaw ? effectiveSourceNode(oldRaw, asset.kind) : undefined, newNode = newRaw ? effectiveSourceNode(newRaw, asset.kind) : undefined;
        if (!newNode) { assertUnused(db, source); db.deleteAssetRecord(asset.id); continue; }
        if (oldNode && sharedAssetFields(newNode.type).every(f => sameAssetValue(assetField(oldNode, f), assetField(newNode, f)))) continue;
        // Search/directory labels are derived indexes, never a second editable content source.
        db.db.prepare("UPDATE assets SET title=?, updated_at=? WHERE id=?").run(newNode.title || "", String(after.updatedAt || new Date().toISOString()), asset.id);
        for (const id of new Set(assetConsumers(db, source).map(consumer => consumer.projectId))) {
            const project = db.getCanvasProject(id)!;
            if (project.id === projectId) continue;
            const ops = nodes(project).filter(n => n.metadata?.sharedAssetReference?.assetId === asset.id && n.metadata.sharedAssetReference.dramaId === source.dramaId)
                .map(n => changedNodePatch(oldNode ? resolveSharedAssetNode(n, oldNode) : n, resolveSharedAssetNode(n, newNode))).filter((op): op is CanvasOperation => Boolean(op));
            if (ops.length) db.applyCanvasProjectOperations(project.id, undefined, ops, { runtimeWrite: true, withinTransaction: true, deferredCommits,
                ...(oldNode ? { referenceSourceBefore: { sourceProjectId: projectId, sourceNodeId: source.sourceNodeId, node: oldNode } } : {}),
                source: { kind: "system", clientId: "system:shared-library", label: "同步共享资产" } });
        }
    }
}
export function writeDramaAsset(db: BackendDatabase, asset: Asset, command: AssetWriteCommand = {}): Asset {
    const requestedAsset = asset;
    const existing = rawAsset(db, asset.id);
    let source = sourceOf(existing);
    // A canvas publishes content only; concurrent directory edits belong to the library UI.
    if (existing && command.canvasSource) asset = { ...asset, tags: existing.tags, folderId: existing.folderId, note: existing.note, source: existing.source,
        metadata: { ...asset.metadata, ...existing.metadata, lastUpdatedFrom: command.canvasSource } };
    if (source && asset.dramaId === undefined) asset = { ...asset, dramaId: existing!.dramaId };
    if (!source && asset.metadata?.sharedAssetSource) throw new Error("共享资产来源由 Backend 维护，不能伪造");
    if (!source && (!asset.dramaId || !db.isDramaProject(asset.dramaId) || !kinds.has(asset.kind))) return db.upsertAssetRecord(asset);
    if (source && asset.dramaId !== source.dramaId) {
        assertUnused(db, source);
        const commits: CanvasCommit[] = [];
        db.db.exec(command.withinTransaction ? "SAVEPOINT relocate_library_asset" : "BEGIN IMMEDIATE");
        try {
            db.applyCanvasProjectOperations(source.sourceProjectId, undefined, [{ type: "delete_node", id: source.sourceNodeId }], { runtimeWrite: true, withinTransaction: true, deferredCommits: commits });
            const metadata = { ...asset.metadata }; delete metadata.sharedAssetSource;
            const saved = writeDramaAsset(db, { ...asset, metadata }, { ...command, withinTransaction: true, deferredCommits: commits });
            db.db.exec(command.withinTransaction ? "RELEASE relocate_library_asset" : "COMMIT");
            if (command.withinTransaction) command.deferredCommits?.push(...commits); else for (const commit of commits) db.notifyCanvasCommit(commit);
            return saved;
        } catch (error) { db.db.exec(command.withinTransaction ? "ROLLBACK TO relocate_library_asset; RELEASE relocate_library_asset" : "ROLLBACK"); throw error; }
    }
    if (source && existing?.kind !== asset.kind) throw new Error("共享资产类型不能改变");
    const commits: CanvasCommit[] = [];
    const operationId = command.operationId || crypto.randomUUID();
    const fingerprint = commandFingerprint(command.request || { asset: requestedAsset, canvasSource: command.canvasSource, discardLocal: command.discardLocal, resolveConflicts: command.resolveConflicts, assetBase: command.assetBase });
    db.db.exec(command.withinTransaction ? "SAVEPOINT shared_library_write" : "BEGIN IMMEDIATE");
    try {
        const receipt = db.db.prepare("SELECT request_hash, receipt_json FROM shared_library_receipts WHERE operation_id=?").get(operationId) as { request_hash: string; receipt_json: string } | undefined;
        if (receipt) {
            if (receipt.request_hash !== fingerprint) throw collaborationError("OPERATION_ID_REUSED", "operationId 已用于不同资产请求");
            db.db.exec(command.withinTransaction ? "RELEASE shared_library_write" : "COMMIT");
            return db.getAsset(JSON.parse(receipt.receipt_json).assetId)!;
        }
        if (!source) {
            const shared = ensureProductionCanvas(db, "shared-assets", asset.dramaId!, undefined, true);
            source = { dramaId: asset.dramaId!, assetId: asset.id, sourceProjectId: shared.project.id, sourceNodeId: `library-${asset.id}` };
        }
        let local: AssetNode | undefined;
        if (command.canvasSource) {
            const p = db.getCanvasProject(command.canvasSource.projectId);
            local = nodes(p).find(n => n.id === command.canvasSource!.nodeId);
            if (!local) throw new Error("来源节点不存在");
            const episode = db.getDramaEpisodeByCanvasId(command.canvasSource.projectId);
            if (command.canvasSource.projectId !== source.sourceProjectId && episode?.dramaId !== source.dramaId) throw new Error("来源节点不属于目标剧目");
            if (local.metadata?.sharedAssetOrigin || local.metadata?.productionAssetId || local.metadata?.productionShotId || local.metadata?.productionScriptId) throw new Error("正式制作节点请沿共享接入和采用入口操作");
            if (local.metadata?.sharedAssetReference?.assetId && local.metadata.sharedAssetReference.assetId !== asset.id) throw new Error("引用不能更新其他共享资产");
        }
        const sharedProject = db.getCanvasProject(source.sourceProjectId)!;
        let canonical = nodes(sharedProject).find(n => n.id === source!.sourceNodeId);
        const canonicalContent = canonical ? effectiveSourceNode(canonical, asset.kind) : undefined;
        if (command.discardLocal && !local?.metadata?.sharedAssetReference) throw new Error("该节点没有共享引用");
        if (!command.discardLocal) {
            const next = nodeForAsset(asset);
            if (canonicalContent && command.assetBase && !local?.metadata?.sharedAssetReference) {
                const base = nodeForAsset({ ...asset, ...command.assetBase });
                const changed = sharedAssetFields(next.type).filter(f => !sameAssetValue(assetField(base, f), assetField(next, f)));
                const conflicts = changed.filter(f => !sameAssetValue(assetField(canonicalContent, f), assetField(base, f)) && !sameAssetValue(assetField(canonicalContent, f), assetField(next, f)));
                if (conflicts.length && command.resolveConflicts !== "local") throw Object.assign(collaborationError("FIELD_CONFLICT", `共享资产相同字段已变化：${conflicts.join("、")}`), { conflictTargets: conflicts });
                const edits = new Map(changed.map(f => [f, assetField(next, f)]));
                Object.assign(next, structuredClone(canonicalContent));
                for (const [f, v] of edits) setAssetField(next, f, v);
            }
            if (local?.metadata?.sharedAssetReference) {
                if (!canonical) throw new Error("共享资产源不存在");
                Object.assign(next, structuredClone(canonicalContent));
                const edits = { ...(local.metadata.sharedAssetReference as SharedAssetReference).edits };
                const requested = nodeForAsset(asset);
                const selectedKey = requested.metadata?.storageKey;
                const history = [...(local.metadata.generatedImageHistory || []), ...(local.metadata.images || []), ...(local.metadata.loopOutputHistory || [])];
                if (["image", "video", "audio"].includes(asset.kind) && selectedKey && selectedKey !== local.metadata.storageKey && history.some(result => result.storageKey === selectedKey)) {
                    for (const f of sharedAssetFields(asset.kind).filter(f => f.startsWith("metadata."))) {
                        const value = assetField(requested, f);
                        if (!sameAssetValue(value, assetField(canonicalContent!, f))) edits[f] = { base: edits[f]?.base ?? assetField(canonicalContent!, f), ...(value === undefined ? { deleted: true } : { value }) };
                    }
                }
                const mediaContentByKey = ["image", "video", "audio"].includes(asset.kind) && Boolean(selectedKey);
                if ((command.request as Record<string, unknown> | undefined)?.data && Object.keys(edits).some(f => !(f === "metadata.content" && mediaContentByKey) && !sameAssetValue(edits[f].deleted ? undefined : edits[f].value, assetField(requested, f)))) throw collaborationError("LOCAL_INPUT_CHANGED", "本地内容在保存过程中已变化，修改已保留，请再次更新资产库");
                const conflicts = Object.entries(edits).filter(([f, e]) => !sameAssetValue(assetField(canonicalContent!, f), e.base) && !sameAssetValue(assetField(canonicalContent!, f), e.deleted ? undefined : e.value)).map(([f]) => f);
                if (conflicts.length && command.resolveConflicts !== "local") throw Object.assign(collaborationError("FIELD_CONFLICT", `共享资产相同字段已变化：${conflicts.join("、")}`), { conflictTargets: conflicts });
                for (const [f, e] of Object.entries(edits)) setAssetField(next, f, e.deleted ? undefined : e.value);
            }
            if (canonical && canonicalContent) {
                if (canonical.type === "config" && sharedAssetFields(asset.kind).filter(f => f !== "title").some(f => !sameAssetValue(assetField(canonicalContent, f), assetField(next, f)))) throw new Error("正式共享生成资产请在源画布选择或生成媒体，再沿正式采用入口更新；本地修改已保留");
                const patch = changedNodePatch(canonicalContent, { ...next, id: canonical.id });
                if (patch) db.applyCanvasProjectOperations(source.sourceProjectId, undefined, [patch], { runtimeWrite: true, withinTransaction: true, deferredCommits: commits });
            } else {
                const position = productionNodePosition(nodes(sharedProject), { x: 0, y: 0 }, 340, 360);
                const reusable = local && local.type === asset.kind && command.canvasSource?.projectId === source.sourceProjectId;
                if (reusable && local) { source.sourceNodeId = local.id; db.applyCanvasProjectOperations(source.sourceProjectId, undefined, [{ type: "update_node", id: local.id, metadata: { sharedLibraryAssetId: asset.id } }], { runtimeWrite: true, withinTransaction: true, deferredCommits: commits }); }
                else db.applyCanvasProjectOperations(source.sourceProjectId, undefined, [{ type: "add_node", id: source.sourceNodeId, nodeType: next.type, title: next.title, position, width: 340, height: 360, metadata: { ...next.metadata, sharedLibraryAssetId: asset.id, status: "success" } }], { runtimeWrite: true, withinTransaction: true, deferredCommits: commits });
            }
            db.upsertAssetRecord({ ...asset, updatedAt: new Date().toISOString(), data: {}, coverUrl: "", metadata: { ...asset.metadata, sharedAssetSource: source } });
        }
        if (local && command.canvasSource && local.type === asset.kind && command.canvasSource.projectId !== source.sourceProjectId) {
            const sourceNode = effectiveSourceNode(nodes(rawProject(db, source.sourceProjectId)).find(n => n.id === source!.sourceNodeId)!, asset.kind);
            const reference: SharedAssetReference = { ...source };
            if (!local.metadata?.sharedAssetReference && !command.discardLocal) {
                const edits: NonNullable<SharedAssetReference["edits"]> = {};
                for (const f of sharedAssetFields(local.type)) {
                    const value = assetField(local, f), shared = assetField(sourceNode, f);
                    if (value !== undefined && !sameAssetValue(value, shared) && !(f === "metadata.content" && local.metadata?.storageKey && local.metadata.storageKey === sourceNode.metadata?.storageKey)) edits[f] = { base: shared, value };
                }
                if (Object.keys(edits).length) reference.edits = edits;
            }
            const resolved = resolveSharedAssetNode({ ...local, metadata: { ...local.metadata, sharedAssetReference: reference } }, sourceNode);
            const patch = nodePatch(resolved);
            patch.metadata = { ...patch.metadata as Record<string, unknown>, sharedAssetReference: reference, ...(asset.kind === "character" ? { characterAssetId: asset.id } : {}) };
            db.applyCanvasProjectOperations(command.canvasSource.projectId, undefined, [patch], { runtimeWrite: true, withinTransaction: true, deferredCommits: commits });
        }
        db.db.prepare("INSERT INTO shared_library_receipts(operation_id, request_hash, receipt_json) VALUES(?,?,?)").run(operationId, fingerprint, JSON.stringify({ assetId: asset.id, source }));
        db.db.exec(command.withinTransaction ? "RELEASE shared_library_write" : "COMMIT");
    } catch (error) { db.db.exec(command.withinTransaction ? "ROLLBACK TO shared_library_write; RELEASE shared_library_write" : "ROLLBACK"); throw error; }
    if (command.withinTransaction) command.deferredCommits?.push(...commits); else for (const commit of commits) db.notifyCanvasCommit(commit);
    return db.getAsset(asset.id)!;
}
export function deleteDramaAsset(db: BackendDatabase, id: string): number {
    const source = sourceOf(rawAsset(db, id));
    if (!source) return db.deleteAssetRecord(id);
    assertUnused(db, source);
    const commits: CanvasCommit[] = [];
    db.db.exec("BEGIN IMMEDIATE");
    try {
        db.applyCanvasProjectOperations(source.sourceProjectId, undefined, [{ type: "delete_node", id: source.sourceNodeId }], { runtimeWrite: true, withinTransaction: true, deferredCommits: commits });
        db.deleteAssetRecord(id);
        db.db.exec("COMMIT");
    } catch (error) { db.db.exec("ROLLBACK"); throw error; }
    for (const commit of commits) db.notifyCanvasCommit(commit);
    return 1;
}
export function migrateDramaAssets(db: BackendDatabase) {
    const commits: CanvasCommit[] = [];
    for (const asset of db.listAssetRecords()) {
        if (!asset.dramaId || !db.isDramaProject(asset.dramaId) || !kinds.has(asset.kind) || sourceOf(asset)) continue;
        if (asset.source === "production-shared" && asset.metadata?.approvedId) {
            const approved = db.db.prepare("SELECT source_project_id, source_node_id FROM drama_asset_versions WHERE id=? AND drama_id=?").get(String(asset.metadata.approvedId), asset.dramaId) as { source_project_id: string; source_node_id: string } | undefined;
            if (!approved || approved.source_project_id !== asset.metadata.sourceProjectId || approved.source_node_id !== asset.metadata.sourceNodeId) throw new Error("存量共享批准资产来源无法核验，迁移已回滚");
            const node = nodes(rawProject(db, approved.source_project_id)).find(n => n.id === approved.source_node_id);
            if (!node) throw new Error("存量共享批准资产节点不存在，迁移已回滚");
            db.upsertAssetRecord({ ...asset, kind: ["character", "scene"].includes(node.type) ? node.type : "image", data: {}, coverUrl: "", metadata: { ...asset.metadata, sharedAssetSource: { dramaId: asset.dramaId, assetId: asset.id, sourceProjectId: approved.source_project_id, sourceNodeId: approved.source_node_id } } });
            continue;
        }
        const projects = db.listCanvasProjects();
        const originMatches = projects.flatMap(p => nodes(p).filter(n => n.id === asset.metadata?.nodeId && (!asset.metadata?.projectId || asset.metadata.projectId === p.id)).map(n => ({ projectId: p.id, node: n })));
        const candidates = projects.flatMap(p => nodes(p).filter(n => {
            if (n.type !== asset.kind || n.metadata?.sharedAssetOrigin || n.metadata?.productionAssetId) return false;
            return n.metadata?.characterAssetId === asset.id || originMatches.length === 1 && originMatches[0].projectId === p.id && originMatches[0].node.id === n.id;
        }).map(n => ({ projectId: p.id, node: n })));
        const sharedId = db.listCanvasFolders().find(f => f.id === asset.dramaId)?.sharedAssetCanvasId;
        const canonical = candidates.find(c => c.projectId === sharedId);
        writeDramaAsset(db, asset, { withinTransaction: true, deferredCommits: commits, ...(canonical ? { canvasSource: { projectId: canonical.projectId, nodeId: canonical.node.id } } : {}) });
        const source = sourceOf(db.getAssetRecord(asset.id))!;
        const canonicalNode = nodes(rawProject(db, source.sourceProjectId)).find(n => n.id === source.sourceNodeId)!;
        for (const c of candidates) {
            if (db.getDramaEpisodeByCanvasId(c.projectId)?.dramaId !== asset.dramaId || c.projectId === source.sourceProjectId) continue;
            const edits: SharedAssetReference["edits"] = {};
            for (const f of sharedAssetFields(c.node.type)) if (!sameAssetValue(assetField(c.node, f), assetField(canonicalNode, f))) { const v = assetField(c.node, f); edits[f] = { base: assetField(canonicalNode, f), ...(v === undefined ? { deleted: true } : { value: v }) }; }
            db.applyCanvasProjectOperations(c.projectId, undefined, [{ type: "update_node", id: c.node.id, metadata: { sharedAssetReference: { ...source, ...(Object.keys(edits).length ? { edits } : {}) } } }], { runtimeWrite: true, withinTransaction: true, deferredCommits: commits });
        }
    }
}
