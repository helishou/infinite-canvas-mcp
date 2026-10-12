type Task = { kind?: string; status: string; error?: string | null; locallyPaused?: boolean; result?: Record<string, any> | null };
export function browserTaskRecoveryAction(task: Task): 'check' | 'query' | 'archive' | 'blocked' | null {
    if (task.kind !== 'canvas-browser-script' || task.status === 'succeeded') return null;
    const recovery = task.result?.browserRecovery;
    if (task.status === 'cancelled') return recovery?.notSubmitted ? null : 'blocked';
    if (task.status === 'failed') return (recovery?.terminalConfirmed || recovery?.notSubmitted) ? null : 'blocked';
    if (!recovery) return task.locallyPaused ? "check" : null;
    if (!task.error && !task.locallyPaused) return null;
    if (recovery.phase === 'archived' || recovery.phase === 'result_available') return 'archive';
    if (recovery.phase === 'external_task') return 'query';
    return 'check';
}
