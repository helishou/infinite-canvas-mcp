import type { BackendDatabase, CanvasProject } from "../db.js";
import { createHash } from 'node:crypto';
import { h3PromptContent, h3ExpectedDialogues } from '@basketikun/canvas-agent/plugins/minimax-h3/runtime-params';
import type { CanvasProjectFilter, CanvasProjectStore, H3NodeMaterial } from "./types.js";

/** 画布项目 store。 */
export function createProjectStore(db: BackendDatabase): CanvasProjectStore {
    return {
        // v7: 画布表无 folder_id 列；list 直接返全集；过滤由 caller 走 episodes 查询（listCanvasProjectsByDrama）。
        list: () => db.listCanvasProjects(),
        listSummaries: (filter?: CanvasProjectFilter) => db.listCanvasProjectSummaries(filter),
        get: (id) => db.getCanvasProject(id),
        getH3ProductionRequirements: (projectId) => {
            const row = db.db.prepare(`SELECT p.episode_id AS ownerId, p.revision, p.published_version AS version, p.published_json AS snapshot
                FROM episode_productions p JOIN drama_episodes e ON e.id=p.episode_id WHERE e.canvas_id=?
                UNION ALL SELECT project_id AS ownerId, revision, published_version AS version, published_json AS snapshot
                FROM canvas_productions WHERE project_id=?`).get(projectId, projectId) as { ownerId: string; revision: number; version: number; snapshot: string | null } | undefined;
            if (!row?.snapshot) return null;
            const snapshot = JSON.parse(row.snapshot);
            return { ownerId: row.ownerId, revision: row.revision, version: row.version, videoAspectRatio: snapshot.settings?.videoAspectRatio,
                clips: (snapshot.clipGroups || []).filter((group: any) => group.nodeId && group.segmentId).map((group: any) => ({ nodeId: group.nodeId, segmentId: group.segmentId,
                    sharedAssetsCurrent: group.shotIds.every((shotId: string) => (snapshot.director?.shotInputs?.[shotId]?.assetIds || []).every((assetId: string) => {
                        const source = snapshot.director?.assets?.[assetId]?.sharedSource;
                        if (!source) return true;
                        const latest = db.db.prepare("SELECT id FROM drama_asset_versions WHERE drama_id=? AND asset_id=? ORDER BY rowid DESC LIMIT 1").get(source.dramaId, source.assetId);
                        return latest?.id === source.approvedId;
                    })),
                    storyboardRequired: group.shotIds.length > 0 && group.shotIds.every((id: string) => {
                        const input = snapshot.director?.shotInputs?.[id];
                        return input?.keyframeAssetId && input.keyframePolicy !== "none";
                    }),
                    sourceHash: snapshot.director?.sourceHash,
                    literalDialogues: h3ExpectedDialogues(snapshot.director?.source || {}, group.shotIds),
                    promptContentHash: (() => { const artifact = snapshot.director?.artifacts?.find((item: any) => item.kind === 'h3' && item.targetId === group.id); return artifact ? createHash('sha256').update(h3PromptContent(artifact.prompt)).digest('hex') : undefined; })(),
                    shots: group.shotIds.map((id: string) => snapshot.shots.find((shot: any) => shot.id === id)).filter(Boolean).map((shot: any) => ({ id: shot.id, duration: shot.duration })) })) };
        },
        create: (project) => db.createCanvasProject(project),
        delete: (id) => db.deleteCanvasProject(id),
        applyOperations: (id, expectedRevision, operations, context) => db.applyCanvasProjectOperations(id, expectedRevision, operations, context),
        writeBackH3Task: (task, binding, output) => db.writeBackH3Task(task, binding, output),
        writeBackCanvasImageTask: (task, input, media) => db.writeBackCanvasImageTask(task, input, media),
        markCanvasImageTaskFailed: (task, input, error) => db.markCanvasImageTaskFailed(task, input, error),
        writeBackCanvasVideoTask: (task, input, media) => db.writeBackCanvasVideoTask(task, input, media),
        markCanvasVideoTaskFailed: (task, input, error) => db.markCanvasVideoTaskFailed(task, input, error),
        writeBackCanvasAudioTask: (task, input, media) => db.writeBackCanvasAudioTask(task, input, media),
        markCanvasAudioTaskFailed: (task, input, error) => db.markCanvasAudioTaskFailed(task, input, error),
        getH3NodeMaterials: (projectId, nodeId, limit, segmentId): H3NodeMaterial[] => db.getH3NodeMaterials(projectId, nodeId, limit, segmentId),
    };
}
