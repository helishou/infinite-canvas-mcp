/**
 * 重新改编按集独立（影策每集一个 rescript.isPending）：
 * 改编 A 集不能把 B 集的改编按钮占住，也不能用全局 busy 影响其它页签。
 */
export function updateRescriptingIds(
    ids: ReadonlySet<string>,
    episodeId: string,
    active: boolean,
): ReadonlySet<string> {
    const next = new Set(ids);
    if (active) next.add(episodeId); else next.delete(episodeId);
    return next;
}
