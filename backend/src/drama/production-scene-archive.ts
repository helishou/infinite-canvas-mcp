import crypto from "node:crypto";
import { removeShotContent, reconcileShotClipBoundaries } from "./shot-edit.js";
import type { BackendDatabase } from "../db.js";
import type { CanvasCommit } from "../canvas/collaboration.js";
import type { CanvasOperation } from "../canvas/project-ops.js";
import { directorHash, projectDirector } from "./director.js";
import { productionLayoutStableId } from "./production-layout-geometry.js";
import { isH3NodeType } from "@basketikun/canvas-agent/plugins/minimax-h3/node-factory";
import { productionSceneEntries, productionScriptGroups, canonicalProduction, isSubjectPromptAssembly, type EpisodeProductionData, type DirectorProduction } from "@basketikun/canvas-agent/drama/production-contract";

const DAY_MS = 24 * 60 * 60 * 1000;
type Owner = { kind: "episode" | "canvas"; id: string };
type Indexed<T> = { index: number; value: T };
type Snapshot = {
    version: 1; sceneId: string;
    scriptRows: Indexed<Record<string, any>>[]; registryRows: Indexed<Record<string, any>>[];
    shots: Indexed<Record<string, any>>[]; segments: Indexed<Record<string, any>>[];
    shotInputs: Array<[string, DirectorProduction["shotInputs"][string]]>; boundaries: Indexed<DirectorProduction["boundaries"][number]>[];
    artifacts: Indexed<DirectorProduction["artifacts"][number]>[]; sceneWork?: NonNullable<DirectorProduction["workflow"]["sceneWorks"]>[string];
    ledgerRows: Record<string, Indexed<Record<string, any>>[]>;
    utterances: Indexed<Record<string, any>>[]; externalShotUtteranceRefs: Array<{ shotId: string; before: any[]; after: any[] }>;
    keyframes: Array<[string, EpisodeProductionData["keyframes"][string]]>; keyframeReviews: Array<[string, EpisodeProductionData["keyframeReviews"][string]]>;
    nodes: Array<Record<string, any>>; connections: Array<Record<string, any>>;
};
const rows = (value: unknown): Record<string, any>[] => Array.isArray(value) ? value.filter(item => item && typeof item === "object" && !Array.isArray(item)) : [];
const record = (value: unknown): Record<string, any> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
const hasShot = (value: Record<string, any>, ids: Set<string>) => {
    const direct = value.shot_id ?? value.shotId;
    if (direct !== undefined && ids.has(String(direct))) return true;
    const list = Array.isArray(value.shot_ids) ? value.shot_ids : Array.isArray(value.shotIds) ? value.shotIds : [];
    if (list.some((id: unknown) => ids.has(String(id)))) return true;
    return [value.start?.shotId, value.end?.shotId].some((id: unknown) => id !== undefined && ids.has(String(id)));
};
function indexed<T extends Record<string, any>>(items: T[], predicate: (item: T) => boolean): Indexed<T>[] {
    return items.flatMap((value, index) => predicate(value) ? [{ index, value: structuredClone(value) }] : []);
}
function restoreIndexed<T extends Record<string, any>>(current: T[], saved: Indexed<T>[], key: string, label: string) {
    const next = [...current];
    for (const entry of [...saved].sort((a, b) => a.index - b.index)) {
        const id = String(entry.value[key] || "");
        if (id && next.some(item => String(item[key] || "") === id)) throw new Error(`SCENE_RESTORE_ID_CONFLICT: ${label} ${id} 已存在`);
        next.splice(Math.min(entry.index, next.length), 0, structuredClone(entry.value));
    }
    return next;
}
function restoreArrayRow(target: Record<string, any>[], entry: Indexed<Record<string, any>>, label: string) {
    const id = String(entry.value.id || "");
    if (id && target.some(item => String(item.id || "") === id)) throw new Error(`SCENE_RESTORE_ID_CONFLICT: ${label} ${id} 已存在`);
    target.splice(Math.min(entry.index, target.length), 0, structuredClone(entry.value));
}
function ledgerArray(source: Record<string, any>, field: string) {
    const ledger = record(source.ledger);
    ledger[field] = rows(ledger[field]);
    source.ledger = ledger;
    return ledger[field] as Record<string, any>[];
}
function addNodeOperations(project: Record<string, any>, snapshot: Snapshot): CanvasOperation[] {
    const nodes = Array.isArray(project.nodes) ? project.nodes as Array<Record<string, any>> : [];
    const existing = new Set(nodes.map(node => String(node.id)));
    for (const node of snapshot.nodes) if (existing.has(String(node.id))) throw new Error(`SCENE_RESTORE_NODE_CONFLICT: 节点 ${node.id} 已存在`);
    const operations: CanvasOperation[] = snapshot.nodes.map(node => ({
        type: "add_node", id: String(node.id), nodeType: String(node.type), title: String(node.title || ""),
        position: structuredClone(node.position || { x: 0, y: 0 }), width: Number(node.width || 360), height: Number(node.height || 240),
        ...(node.content !== undefined ? { content: node.content } : {}), metadata: structuredClone(node.metadata || {}),
    }));
    const nodeIds = new Set([...existing, ...snapshot.nodes.map(node => String(node.id))]);
    const connections = Array.isArray(project.connections) ? project.connections as Array<Record<string, any>> : [];
    for (const edge of snapshot.connections) {
        if (!nodeIds.has(String(edge.fromNodeId)) || !nodeIds.has(String(edge.toNodeId))) throw new Error(`SCENE_RESTORE_CONNECTION_CONFLICT: 连线 ${edge.id} 的端点不存在`);
        const duplicate = connections.find(item => String(item.fromNodeId) === String(edge.fromNodeId) && String(item.toNodeId) === String(edge.toNodeId) && String(item.role || "") === String(edge.role || ""));
        if (duplicate) continue;
        operations.push({ type: "connect_nodes", id: String(edge.id), fromNodeId: String(edge.fromNodeId), toNodeId: String(edge.toNodeId), ...(edge.role ? { role: edge.role } : {}), ...(edge.order !== undefined ? { order: edge.order } : {}) });
    }
    return operations;
}

export function listArchivedDirectorScenes(db: BackendDatabase, owner: Owner) {
    const now = new Date().toISOString();
    return (db.db.prepare(`SELECT archive_id AS archiveId, scene_id AS sceneId, scene_title AS sceneTitle, deleted_at AS deletedAt, expires_at AS expiresAt, snapshot_json AS snapshotJson
        FROM production_scene_archives WHERE owner_kind=? AND owner_id=? AND restored_at IS NULL AND expires_at>? ORDER BY deleted_at DESC`).all(owner.kind, owner.id, now) as Array<Record<string, any>>)
        .map(row => {
            const snapshot = JSON.parse(String(row.snapshotJson)) as Snapshot;
            return { archiveId: String(row.archiveId), sceneId: String(row.sceneId), sceneTitle: String(row.sceneTitle), deletedAt: String(row.deletedAt), expiresAt: String(row.expiresAt), shotCount: snapshot.shots.length, clipCount: snapshot.segments.length };
        });
}

export function archiveDirectorScene(input: {
    db: BackendDatabase; owner: Owner; draft: EpisodeProductionData; sceneId: string; expectedCanvasRevision: number;
    canvasCommits: CanvasCommit[]; assertTargetsIdle: (targetIds: string[]) => void;
}) {
    const { db, owner, draft, sceneId, expectedCanvasRevision, canvasCommits } = input;
    if (!draft.director) throw new Error("缺少 Acheng 制作稿");
    const director = draft.director, scene = productionSceneEntries(director.source).find(item => item.id === sceneId);
    if (!scene) throw new Error(`SCENE_NOT_FOUND: 场次 ${sceneId} 不存在`);
    const source = director.source as Record<string, any>;
    const scripts = rows(source.script_scenes), groups = productionScriptGroups(scripts);
    const scriptGroup = groups.find(item => item.key === sceneId);
    if (scripts.length && !scriptGroup) throw new Error("SCENE_ARCHIVE_OCCURRENCE_AMBIGUOUS: 无法唯一映射正式场次脚本块");
    const blockIds = new Set((scriptGroup?.blocks || []).map(block => String(block.id || "")));
    const scriptRows = indexed(scripts, item => blockIds.has(String(item.id || "")));
    const registryRows = scripts.length ? [] : indexed(rows(source.scene_registry), item => String(item.id || "") === sceneId);
    if (!scripts.length && !registryRows.length) throw new Error("SCENE_ARCHIVE_OCCURRENCE_AMBIGUOUS: 场次环境不存在");

    const shotIds = new Set(scene.shotIds.map(String));
    const sourceShots = rows(source.shots);
    const shots = indexed(sourceShots, item => shotIds.has(String(item.id || "")));
    if (shots.length !== shotIds.size) throw new Error("SCENE_ARCHIVE_SHOT_MAPPING_INVALID: 场次引用了不存在的 Shot");
    const sourceSegments = rows(source.segments);
    const segments = indexed(sourceSegments, item => Array.isArray(item.shot_ids) && item.shot_ids.some((id: unknown) => shotIds.has(String(id))));
    if (segments.some(entry => !entry.value.shot_ids.every((id: unknown) => shotIds.has(String(id))))) throw new Error("SCENE_ARCHIVE_CROSS_SCENE_CLIP: Clip 跨场次，拒绝级联删除");
    const segmentIds = new Set(segments.map(entry => String(entry.value.id || "")));
    input.assertTargetsIdle([...segmentIds].map(id => `segment:${id}`));

    const episode = owner.kind === "episode" ? db.getDramaEpisode(owner.id) : null;
    const projectId = episode?.canvasId || (owner.kind === "canvas" ? owner.id : null);
    if (!projectId) throw new Error("SCENE_ARCHIVE_CANVAS_MISSING: 场次没有绑定画布");
    const project = db.getCanvasProject(projectId);
    if (!project) throw new Error("SCENE_ARCHIVE_CANVAS_MISSING: 绑定画布不存在");
    if (Number(project.revision || 0) !== expectedCanvasRevision) throw new Error("SCENE_ARCHIVE_CANVAS_STALE: 画布版本已变化，请刷新后重新确认删除");
    const groupId = productionLayoutStableId("production-scene", owner.id, sceneId);
    const clipNodeIds = new Set(draft.clipGroups.filter(group => segmentIds.has(group.id) && group.nodeId).map(group => String(group.nodeId)));
    for (const nodeId of clipNodeIds) {
        const other = draft.clipGroups.find(group => group.nodeId === nodeId && !segmentIds.has(group.id));
        if (other) throw new Error("SCENE_ARCHIVE_SHARED_H3_NODE: H3 节点仍绑定其他场次 Clip");
    }
    const allNodes = Array.isArray(project.nodes) ? project.nodes as Array<Record<string, any>> : [];
    const nodes = allNodes.filter(node => {
        const metadata = record(node.metadata);
        return String(node.id) === groupId || metadata.productionSceneId === sceneId || metadata.groupId === groupId
            || clipNodeIds.has(String(node.id)) && isH3NodeType(node.type);
    }).map(node => structuredClone(node));
    const nodeIds = new Set(nodes.map(node => String(node.id)));
    const connections = (Array.isArray(project.connections) ? project.connections as Array<Record<string, any>> : [])
        .filter(edge => nodeIds.has(String(edge.fromNodeId)) || nodeIds.has(String(edge.toNodeId))).map(edge => structuredClone(edge));
    const shotInputs = Object.entries(director.shotInputs).filter(([id]) => shotIds.has(id)).map(([id, value]) => [id, structuredClone(value)] as [string, typeof value]);
    const boundaries = indexed(director.boundaries, edge => segmentIds.has(String(edge.from)) || segmentIds.has(String(edge.to)));
    const artifacts = indexed(director.artifacts, artifact => artifact.kind === "h3" && segmentIds.has(String(artifact.targetId)));
    const sceneWork = director.workflow.sceneWorks?.[sceneId] ? structuredClone(director.workflow.sceneWorks[sceneId]) : undefined;
    const keyframes = Object.entries(draft.keyframes).filter(([id]) => shotIds.has(id)).map(([id, value]) => [id, structuredClone(value)] as [string, typeof value]);
    const keyframeReviews = Object.entries(draft.keyframeReviews).filter(([id]) => shotIds.has(id)).map(([id, value]) => [id, structuredClone(value)] as [string, typeof value]);
    const ledger = record(source.ledger), ledgerRows: Snapshot["ledgerRows"] = {};
    for (const field of ["events", "requirements", "coverage"]) {
        const list = rows(ledger[field]);
        ledgerRows[field] = indexed(list, item => hasShot(item, shotIds));
        ledger[field] = list.filter(item => !hasShot(item, shotIds));
    }
    const utterances = indexed(rows(source.utterances), item => hasShot(item, shotIds));
    const utteranceIds = new Set(utterances.map(entry => String(entry.value.id || "")));
    const externalShotUtteranceRefs: Snapshot["externalShotUtteranceRefs"] = [];
    for (const shot of sourceShots) {
        if (shotIds.has(String(shot.id || ""))) continue;
        const refs = Array.isArray(shot.utterance_refs) ? shot.utterance_refs : [];
        if (!refs.some((ref: Record<string, any>) => utteranceIds.has(String(ref.utteranceId)))) continue;
        externalShotUtteranceRefs.push({ shotId: String(shot.id), before: structuredClone(refs), after: refs.filter((ref: Record<string, any>) => !utteranceIds.has(String(ref.utteranceId))) });
        shot.utterance_refs = refs.filter((ref: Record<string, any>) => !utteranceIds.has(String(ref.utteranceId)));
    }
    const snapshot: Snapshot = { version: 1, sceneId, scriptRows, registryRows, shots, segments, shotInputs, boundaries, artifacts, ...(sceneWork ? { sceneWork } : {}),
        ledgerRows, utterances, externalShotUtteranceRefs, keyframes, keyframeReviews, nodes, connections };

    const scriptRowIndices = new Set(scriptRows.map(entry => entry.index)), registryRowIndices = new Set(registryRows.map(entry => entry.index));
    source.script_scenes = scripts.filter((_item, index) => !scriptRowIndices.has(index));
    if (!scripts.length) source.scene_registry = rows(source.scene_registry).filter((_item, index) => !registryRowIndices.has(index));
    source.shots = sourceShots.filter(shot => !shotIds.has(String(shot.id || "")));
    source.segments = sourceSegments.filter(segment => !segmentIds.has(String(segment.id || "")));
    source.utterances = rows(source.utterances).filter(item => !utteranceIds.has(String(item.id || "")));
    director.shotInputs = Object.fromEntries(Object.entries(director.shotInputs).filter(([id]) => !shotIds.has(id))) as DirectorProduction["shotInputs"];
    director.boundaries = director.boundaries.filter(edge => !segmentIds.has(String(edge.from)) && !segmentIds.has(String(edge.to)));
    director.artifacts = director.artifacts.filter(artifact => artifact.kind !== "h3" || !segmentIds.has(artifact.targetId)).map(artifact => artifact.status === "ready" ? { ...artifact, status: "stale" as const } : artifact);
    if (director.workflow.sceneWorks?.[sceneId]) delete director.workflow.sceneWorks[sceneId];
    if (director.workflow.currentWork?.targetKind === "scene" && director.workflow.currentWork.targetId === sceneId) delete director.workflow.currentWork;
    for (const id of shotIds) { delete draft.keyframes[id]; delete draft.keyframeReviews[id]; }
    director.sourceHash = directorHash(source);
    director.executionAuthorized = false;
    projectDirector(draft);

    const archiveId = crypto.randomUUID(), deletedAt = new Date(), expiresAt = new Date(deletedAt.getTime() + 30 * DAY_MS);
    db.db.prepare(`INSERT INTO production_scene_archives(archive_id,owner_kind,owner_id,scene_id,scene_title,delete_operation_id,deleted_at,expires_at,snapshot_json)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(archiveId, owner.kind, owner.id, sceneId, scene.title || sceneId, archiveId, deletedAt.toISOString(), expiresAt.toISOString(), JSON.stringify(snapshot));
    if (nodeIds.size) db.applyCanvasProjectOperations(projectId, expectedCanvasRevision, [{ type: "delete_node", ids: [...nodeIds] }], {
        operationId: `${archiveId}:canvas-delete`, runtimeWrite: true, withinTransaction: true, deferredCommits: canvasCommits,
        source: { kind: "system", clientId: "production:scene-archive", label: "归档制作场次" },
    });
    return { archiveId, sceneId, expiresAt: expiresAt.toISOString() };
}

export function restoreDirectorScene(input: { db: BackendDatabase; owner: Owner; draft: EpisodeProductionData; archiveId: string; expectedCanvasRevision: number; canvasCommits: CanvasCommit[] }) {
    const { db, owner, draft, archiveId, expectedCanvasRevision, canvasCommits } = input;
    if (!draft.director) throw new Error("缺少 Acheng 制作稿");
    const row = db.db.prepare(`SELECT scene_id AS sceneId, expires_at AS expiresAt, snapshot_json AS snapshotJson FROM production_scene_archives
        WHERE archive_id=? AND owner_kind=? AND owner_id=? AND restored_at IS NULL`).get(archiveId, owner.kind, owner.id) as Record<string, any> | undefined;
    if (!row) throw new Error("SCENE_ARCHIVE_NOT_FOUND: 已删除场次不存在或已还原");
    if (Date.parse(String(row.expiresAt)) <= Date.now()) throw new Error("SCENE_ARCHIVE_EXPIRED: 场次超过 30 天还原期限");
    const snapshot = JSON.parse(String(row.snapshotJson)) as Snapshot;
    const director = draft.director, source = director.source as Record<string, any>;
    if (productionSceneEntries(source).some(scene => scene.id === snapshot.sceneId)) throw new Error("SCENE_RESTORE_ID_CONFLICT: 场次 ID 已被占用");
    source.script_scenes = restoreIndexed(rows(source.script_scenes), snapshot.scriptRows, "id", "脚本块");
    source.scene_registry = restoreIndexed(rows(source.scene_registry), snapshot.registryRows, "id", "环境");
    source.shots = restoreIndexed(rows(source.shots), snapshot.shots, "id", "Shot");
    source.segments = restoreIndexed(rows(source.segments), snapshot.segments, "id", "Clip");
    const shotInputs = { ...director.shotInputs };
    for (const [id, value] of snapshot.shotInputs) {
        if (Object.hasOwn(shotInputs, id)) throw new Error(`SCENE_RESTORE_ID_CONFLICT: Shot 输入 ${id} 已存在`);
        shotInputs[id] = structuredClone(value);
    }
    director.shotInputs = shotInputs as DirectorProduction["shotInputs"];
    const existingBoundaries = new Set(director.boundaries.map(edge => `${edge.from}\0${edge.to}`));
    for (const entry of snapshot.boundaries) {
        const edge = entry.value;
        const key = `${edge.from}\0${edge.to}`;
        if (existingBoundaries.has(key)) throw new Error(`SCENE_RESTORE_ID_CONFLICT: 连续性边界 ${edge.from} → ${edge.to} 已存在`);
        director.boundaries.push(structuredClone(edge));
        existingBoundaries.add(key);
    }
    const artifactIds = new Set(director.artifacts.map(item => item.id));
    for (const entry of snapshot.artifacts) {
        if (artifactIds.has(entry.value.id)) throw new Error(`SCENE_RESTORE_ID_CONFLICT: 编译产物 ${entry.value.id} 已存在`);
        director.artifacts.push({ ...structuredClone(entry.value), status: "stale" });
    }
    for (const field of ["events", "requirements", "coverage"]) for (const entry of snapshot.ledgerRows[field] || []) restoreArrayRow(ledgerArray(source, field), entry, `连续性 ${field}`);
    for (const entry of snapshot.utterances) restoreArrayRow(rows(source.utterances), entry, "对白事件");
    for (const item of snapshot.externalShotUtteranceRefs) {
        const shot = rows(source.shots).find(value => String(value.id) === item.shotId);
        if (!shot) throw new Error(`SCENE_RESTORE_SOURCE_CONFLICT: 外部镜头 ${item.shotId} 已删除`);
        if (canonicalProduction(shot.utterance_refs || []) !== canonicalProduction(item.after)) throw new Error(`SCENE_RESTORE_SOURCE_CONFLICT: 外部镜头 ${item.shotId} 的对白引用已变化`);
        shot.utterance_refs = structuredClone(item.before);
    }
    if (snapshot.sceneWork) {
        director.workflow.sceneWorks ||= {};
        if (director.workflow.sceneWorks[snapshot.sceneId]) throw new Error("SCENE_RESTORE_SOURCE_CONFLICT: 场次制作任务已有新版本");
        director.workflow.sceneWorks[snapshot.sceneId] = structuredClone(snapshot.sceneWork);
    }
    for (const [id, value] of snapshot.keyframes) {
        if (draft.keyframes[id]) throw new Error(`SCENE_RESTORE_ID_CONFLICT: 关键帧 ${id} 已存在`);
        draft.keyframes[id] = structuredClone(value);
    }
    for (const [id, value] of snapshot.keyframeReviews) {
        if (draft.keyframeReviews[id]) throw new Error(`SCENE_RESTORE_ID_CONFLICT: 关键帧审核 ${id} 已存在`);
        draft.keyframeReviews[id] = structuredClone(value);
    }
    director.sourceHash = directorHash(source);
    director.executionAuthorized = false;
    projectDirector(draft);

    const episode = owner.kind === "episode" ? db.getDramaEpisode(owner.id) : null;
    const projectId = episode?.canvasId || (owner.kind === "canvas" ? owner.id : null);
    const project = projectId ? db.getCanvasProject(projectId) : null;
    if (!projectId || !project) throw new Error("SCENE_RESTORE_CANVAS_MISSING: 绑定画布不存在");
    if (Number(project.revision || 0) !== expectedCanvasRevision) throw new Error("SCENE_RESTORE_CANVAS_STALE: 画布版本已变化，请刷新后重试");
    const operations = addNodeOperations(project, snapshot);
    if (operations.length) db.applyCanvasProjectOperations(projectId, expectedCanvasRevision, operations, {
        operationId: `${archiveId}:canvas-restore`, runtimeWrite: true, withinTransaction: true, deferredCommits: canvasCommits,
        source: { kind: "system", clientId: "production:scene-restore", label: "还原制作场次" },
    });
    db.db.prepare("UPDATE production_scene_archives SET restored_at=?, restore_operation_id=? WHERE archive_id=? AND restored_at IS NULL")
        .run(new Date().toISOString(), crypto.randomUUID(), archiveId);
    return { archiveId, sceneId: snapshot.sceneId };
}

export function deleteDirectorClip(input: { db: BackendDatabase; owner: Owner; draft: EpisodeProductionData; segmentId: string; expectedCanvasRevision: number; canvasCommits: CanvasCommit[]; assertTargetsIdle: (targetIds: string[]) => void }) {
    const { db, owner, draft, segmentId, expectedCanvasRevision, canvasCommits } = input;
    const director = draft.director;
    if (!director) throw new Error("缺少 Acheng 制作稿");
    const source = director.source as Record<string, any>;
    const previousClips = rows(source.segments).map(row => String(row.id));
    const segment = rows(source.segments).find(item => String(item.id) === segmentId);
    const group = draft.clipGroups.find(item => item.id === segmentId);
    if (!segment || !group) throw new Error(`CLIP_NOT_FOUND: Clip ${segmentId} 不存在`);
    if (!Array.isArray(segment.shot_ids) || !segment.shot_ids.length || segment.shot_ids.some((id: string) => !group.shotIds.includes(id))) throw new Error("CLIP_SHOT_MAPPING_INVALID: Clip 与 Shot 映射不一致");
    const shotIds = new Set(segment.shot_ids.map(String));
    if (rows(source.segments).some(item => item.id !== segmentId && (item.shot_ids || []).some((id: string) => shotIds.has(String(id))))) throw new Error("CLIP_SHOT_SHARED: Clip 镜头同时被其他 Clip 使用");
    input.assertTargetsIdle([`segment:${segmentId}`]);
    const episode = owner.kind === "episode" ? db.getDramaEpisode(owner.id) : null;
    const projectId = episode?.canvasId || (owner.kind === "canvas" ? owner.id : null);
    const project = projectId ? db.getCanvasProject(projectId) : null;
    if (project && Number(project.revision || 0) !== expectedCanvasRevision) throw new Error("CLIP_DELETE_CANVAS_STALE: 画布版本已变化，请刷新后重试");
    if (group.nodeId && group.segmentId) {
        if (!projectId || !project) throw new Error("CLIP_DELETE_CANVAS_MISSING: 已绑定的原画布不存在");
        db.applyCanvasProjectOperations(projectId, expectedCanvasRevision, [{ type: "delete_h3_segment", nodeId: group.nodeId, segmentId: group.segmentId }], {
            operationId: `${crypto.randomUUID()}:clip-delete`, runtimeWrite: true, withinTransaction: true, deferredCommits: canvasCommits,
            source: { kind: "system", clientId: "production:clip-delete", label: "删除制作 Clip" },
        });
    }
    if (isSubjectPromptAssembly(source)) removeShotContent(source, shotIds);
    source.shots = rows(source.shots).filter(shot => !shotIds.has(String(shot.id || "")));
    source.segments = rows(source.segments).filter(item => String(item.id) !== segmentId);
    director.shotInputs = Object.fromEntries(Object.entries(director.shotInputs).filter(([id]) => !shotIds.has(id))) as DirectorProduction["shotInputs"];
    director.boundaries = director.boundaries.filter(edge => edge.from !== segmentId && edge.to !== segmentId);
    director.artifacts = director.artifacts.filter(artifact => !(artifact.kind === "h3" && artifact.targetId === segmentId)).map(artifact => artifact.status === "ready" ? { ...artifact, status: "stale" as const } : artifact);
    for (const id of shotIds) { delete draft.keyframes[id]; delete draft.keyframeReviews[id]; }
    if (isSubjectPromptAssembly(source)) {
        const counters = new Map<string, number>();
        source.shots = rows(source.shots).map(shot => { const order = counters.get(shot.timeline_id) || 0; counters.set(shot.timeline_id, order + 1); return { ...shot, story_order: order }; });
        reconcileShotClipBoundaries(director, previousClips);
    } else {
        const ledger = record(source.ledger);
        for (const field of ["events", "requirements", "coverage"]) ledger[field] = rows(ledger[field]).filter(item => !hasShot(item, shotIds));
        source.ledger = ledger;
        const utterances = rows(source.utterances);
        const deletedUtteranceIds = new Set(utterances.filter(item => hasShot(item, shotIds)).map(item => String(item.id || "")));
        source.utterances = utterances.filter(item => !deletedUtteranceIds.has(String(item.id || "")));
        source.shots = rows(source.shots).map(shot => ({ ...shot, ...(Array.isArray(shot.utterance_refs) ? { utterance_refs: shot.utterance_refs.filter((ref: Record<string, any>) => !deletedUtteranceIds.has(String(ref.utteranceId))) } : {}) }));
    }
    director.sourceHash = directorHash(source);
    director.executionAuthorized = false;
    projectDirector(draft);
    return { segmentId, shotIds: [...shotIds] };
}
