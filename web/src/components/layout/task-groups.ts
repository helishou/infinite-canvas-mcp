/** Read-only presentation; unknown states stay visible alongside active work. */
export function groupRecentTasks<T extends { status: string }>(tasks: T[]) {
    const terminal = new Set(["succeeded", "failed", "cancelled"]);
    return [
        { key: "active", tasks: tasks.filter(task => !terminal.has(task.status)) },
        { key: "history", tasks: tasks.filter(task => terminal.has(task.status)) },
    ].filter(group => group.tasks.length > 0);
}
