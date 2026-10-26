/** Show one logical task when its parent and child records are both in the recent window. */
export function groupRecentTasks<T extends { id: unknown; parentTaskId?: unknown; status: string }>(tasks: T[]) {
    const terminal = new Set(["succeeded", "failed", "cancelled"]);
    const ids = new Set(tasks.map(task => String(task.id)));
    const visible = tasks.filter(task => !task.parentTaskId || !ids.has(String(task.parentTaskId)));
    return [
        { key: "active", tasks: visible.filter(task => !terminal.has(task.status)) },
        { key: "history", tasks: visible.filter(task => terminal.has(task.status)) },
    ].filter(group => group.tasks.length > 0);
}
