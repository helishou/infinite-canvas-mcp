/** Only an authenticated, fingerprint-checked POST rejection proves this envelope committed. */
export async function recoverCompactedCanvasReceipt<T extends { id: string; revision?: number }>(
    error: unknown,
    projectId: string,
    fetchLatest: () => Promise<T>,
): Promise<T | null> {
    const value = error as { status?: number; details?: Record<string, unknown> } | null;
    const details = value?.details;
    if (value?.status !== 409 || details?.code !== "RECEIPT_UNAVAILABLE" || details.committed !== true || details.snapshotAvailable !== false) return null;
    const revision = details.revision;
    if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0) throw new Error("无效的已提交版本，原命令仍保留");
    try {
        const project = await fetchLatest();
        if (project.id !== projectId || !Number.isSafeInteger(project.revision) || Number(project.revision) < revision) throw new Error("最新画布尚未包含已提交版本");
        return project;
    } catch (cause) {
        // A failed refresh is not a rejection of the immutable editing command.
        throw new Error("未能恢复已提交操作的最新画布，原命令仍保留", { cause });
    }
}
