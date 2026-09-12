import type { BackendDatabase, CanvasProject } from "../db.js";
import type { CanvasProjectStore } from "./types.js";

/** 画布项目 store。 */
export function createProjectStore(db: BackendDatabase): CanvasProjectStore {
    return {
        list: () => db.listCanvasProjects(),
        get: (id) => db.getCanvasProject(id),
        upsert: (project) => db.upsertCanvasProject(project),
        replaceAll: (projects) => db.replaceCanvasProjects(projects),
        delete: (id) => db.deleteCanvasProject(id),
        applyOperations: (id, expectedRevision, operations) => db.applyCanvasProjectOperations(id, expectedRevision, operations),
        writeBackH3Task: (task, binding, output) => db.writeBackH3Task(task, binding, output),
        writeBackCanvasImageTask: (task, input, media) => db.writeBackCanvasImageTask(task, input, media),
        markCanvasImageTaskFailed: (task, input, error) => db.markCanvasImageTaskFailed(task, input, error),
    };
}
