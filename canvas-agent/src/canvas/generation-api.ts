export const CANVAS_GENERATION_PATH = "/canvas/generation" as const;
export const CANVAS_TASKS_PATH = "/tasks" as const;
export const CANVAS_TASK_ROUTE = `${CANVAS_TASKS_PATH}/:id` as const;
export const CANVAS_TASK_ACTIONS = ["cancel", "retry"] as const;

export type CanvasTaskAction = (typeof CANVAS_TASK_ACTIONS)[number];

export function canvasTaskPath(id: string) {
    return `${CANVAS_TASKS_PATH}/${encodeURIComponent(id)}`;
}

export function canvasTaskActionPath(id: string, action: CanvasTaskAction) {
    return `${canvasTaskPath(id)}/${action}`;
}

export function canvasTaskActionRoute(action: CanvasTaskAction) {
    return `${CANVAS_TASK_ROUTE}/${action}`;
}
