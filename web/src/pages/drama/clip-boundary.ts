/** Clip 分割块的纯计算：边界候选、分区与执行配置物化。DOM 测量留在组件内。 */

export type ClipRow = Record<string, any>;

export const clipShotIds = (clip: ClipRow | undefined): string[] => (Array.isArray(clip?.shot_ids) ? clip!.shot_ids : []).map(String);

/** 分割块只能落在「每个 Clip 至少 1 个 Shot」的位置：合计 N 个镜头时有 N-1 个候选。 */
export function boundaryCounts(leftCount: number, rightCount: number): number[] {
    return Array.from({ length: Math.max(0, leftCount + rightCount - 1) }, (_, index) => index + 1);
}

/** 按边界位置切分相邻两个 Clip 的镜头；越界一律夹到两端，保证两侧非空且不越过其他分割块。 */
export function partitionAt(leftIds: string[], rightIds: string[], count: number) {
    const all = [...leftIds, ...rightIds];
    if (all.length < 2) return { left: all, right: [] as string[], count: 0 };
    const safe = Math.min(Math.max(Math.round(Number.isFinite(count) ? count : 1), 1), all.length - 1);
    return { left: all.slice(0, safe), right: all.slice(safe), count: safe };
}

/** 指针位置吸附到最近的边界候选；候选来自各 Shot 芯片的右边缘与当前分割块中心。 */
export function nearestBoundaryCount(x: number, edges: Array<{ count: number; edge: number }>): number | undefined {
    let best: { count: number; distance: number } | undefined;
    for (const candidate of edges) {
        const distance = Math.abs(x - candidate.edge);
        if (!best || distance < best.distance) best = { count: candidate.count, distance };
    }
    return best?.count;
}

export const clipProfileKey = (clip: ClipRow) => JSON.stringify({ mode: clip.mode, mode_lock: clip.mode_lock, styleTemplateId: clip.styleTemplateId });

/** 镜头帧窗时长（秒）；帧窗缺失时退回 duration_frames 累加。 */
export function clipDurationSeconds(ids: string[], shots: ClipRow[], fps: number) {
    const list = ids.map(id => shots.find(shot => String(shot.id) === id));
    const start = Number(list[0]?.start_frame), end = Number(list[list.length - 1]?.end_frame);
    if (list.every(Boolean) && Number.isFinite(start) && Number.isFinite(end) && end > start) return (end - start) / (fps || 24);
    return ids.reduce((sum, id) => sum + Number(shots.find(shot => String(shot.id) === id)?.duration_frames || 0), 0) / (fps || 24);
}

/** 4–15 秒生成窗之外的片段，供提交前后提示（不阻断，与片段视图的划分编辑器一致）。 */
export function outsideClipWindow(seconds: number) {
    return !Number.isFinite(seconds) || seconds < 4 || seconds > 15;
}

export type ClipPartitionEntry = { ids: string[]; profileSourceId?: string };

/** 新分组是否混合了执行配置不同的旧 Clip：mixed 为真时提交必须带 profileSourceId，否则 Backend 会拒绝（CLIP_EXECUTION_PROFILE_CONFLICT）。 */
export function clipPartitionProfileMix(clips: ClipRow[], entries: ClipPartitionEntry[]) {
    return entries.map(entry => {
        const sources = clips.filter(clip => clipShotIds(clip).some(id => entry.ids.includes(id)));
        return { ids: entry.ids, sources, mixed: new Set(sources.map(clipProfileKey)).size > 1 };
    });
}

/**
 * 与片段视图的划分编辑器相同的物化规则：整套 Shot 未变则沿用旧 Clip 身份（保留 id）；
 * 覆盖范围变化时不复用旧 id，改由 Backend 生成；合并/跨片段移动了执行配置不同的旧 Clip 时必须指明沿用哪一段。
 */
export function materializeClipPartition(clips: ClipRow[], entries: ClipPartitionEntry[]) {
    return entries.map(entry => {
        const exact = clips.find(clip => JSON.stringify(clipShotIds(clip)) === JSON.stringify(entry.ids));
        const sources = clips.filter(clip => clipShotIds(clip).some(id => entry.ids.includes(id)));
        const profiles = new Set(sources.map(clipProfileKey));
        const inherited = sources.length === 1 || profiles.size === 1 ? sources[0] : undefined;
        const chosen = exact || inherited || sources.find(clip => String(clip.id) === String(entry.profileSourceId || ""));
        return {
            ...(exact ? { id: String(exact.id) } : {}), shot_ids: entry.ids,
            ...(!exact && profiles.size > 1 && chosen ? { executionProfileSourceId: String(chosen.id) } : {}),
            ...(chosen ? { mode: chosen.mode, mode_lock: chosen.mode_lock, mode_selection_reason: chosen.mode_selection_reason,
                ...(Object.hasOwn(chosen, "styleTemplateId") ? { styleTemplateId: chosen.styleTemplateId } : {}) } : {}),
        };
    });
}
