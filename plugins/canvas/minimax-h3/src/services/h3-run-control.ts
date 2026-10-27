type TaskState = { status: string };

const terminal = new Set(["succeeded", "failed", "cancelled"]);

/** 直接提交取消，避免状态读取增加一轮串行往返；仅在竞态失败时回读状态。 */
export async function cancelActiveH3Task(
    taskId: string,
    read: (taskId: string) => Promise<TaskState>,
    cancel: (taskId: string) => Promise<unknown>,
) {
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
