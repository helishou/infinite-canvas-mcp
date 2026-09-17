import type { BackendDatabase, CanvasProject } from "../db.js";
import type { CanvasProjectFilter, CanvasProjectStore, H3NodeMaterial } from "./types.js";

/** 画布项目 store。 */
export function createProjectStore(db: BackendDatabase): CanvasProjectStore {
    return {
        // v7: 画布表无 folder_id 列；list 直接返全集；过滤由 caller 走 episodes 查询（listCanvasProjectsByDrama）。
        list: () => db.listCanvasProjects(),
        listSummaries: (filter?: CanvasProjectFilter) => db.listCanvasProjectSummaries(filter),
        get: (id) => db.getCanvasProject(id),
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
