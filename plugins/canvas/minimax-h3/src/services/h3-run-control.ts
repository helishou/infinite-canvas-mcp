type TaskState = { status: string };

const terminal = new Set(["succeeded", "failed", "cancelled"]);

/** 先读取轻量状态，避免正常取消路径传输完整冻结任务；容忍读取与取消之间的状态竞态。 */
export async function cancelActiveH3Task(
    taskId: string,
    read: (taskId: string) => Promise<TaskState>,
    cancel: (taskId: string) => Promise<unknown>,
) {
    const current = await read(taskId);
    if (terminal.has(current.status)) return false;
    if (current.status === "awaiting_confirmation") throw new Error("当前任务待确认，请先确认、保留一采或放弃任务");
    if (!["queued", "running"].includes(current.status)) throw new Error(`H3 任务状态 ${current.status} 无法取消`);
    try {
        await cancel(taskId);
        return true;
    } catch (error) {
        let latest: TaskState;
        try { latest = await read(taskId); }
        catch { throw error; }
        if (terminal.has(latest.status)) return false;
        if (latest.status === "awaiting_confirmation") throw new Error("当前任务待确认，请先确认、保留一采或放弃任务");
        if (!["queued", "running"].includes(latest.status)) throw new Error(`H3 任务状态 ${latest.status} 无法取消`);
        throw error;
    }
}

export async function resetAndRunH3Task(
    taskId: string,
    read: (taskId: string) => Promise<TaskState>,
    cancel: (taskId: string) => Promise<unknown>,
    restart: () => void | Promise<void>,
) {
    await cancelActiveH3Task(taskId, read, cancel);
    await restart();
}
