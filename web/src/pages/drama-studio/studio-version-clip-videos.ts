import type { ClipVideoTruth, CompareClipVideoDiff } from "@/services/backend-api";

/** 真值缺失时如实显示「时长未归档」，不按帧数或其它版本推断。 */
export function formatClipDuration(ms: number | null): string {
    return typeof ms === "number" && Number.isFinite(ms) ? `${(ms / 1000).toFixed(2)}s` : "时长未归档";
}

export type ClipVideoRow = {
    clipId: string;
    title: string;
    status: string;
    color: string;
    from?: ClipVideoTruth;
    to?: ClipVideoTruth;
    current?: ClipVideoTruth;
};

/**
 * 把两版本逐clip成片真值列表与 diff 合成逐clip行：
 * - storageKey 变化标「成片更换」，时长/重生成凭证变化单列；
 * - 只在一侧有记录时如实写「仅新版/仅旧版有成片记录」，不用当前画布回填历史版本。
 */
export function buildClipVideoRows(
    fromList: ClipVideoTruth[],
    toList: ClipVideoTruth[],
    diff: CompareClipVideoDiff,
    currentList: ClipVideoTruth[],
): ClipVideoRow[] {
    const fromMap = new Map(fromList.map((item) => [item.clipId, item]));
    const toMap = new Map(toList.map((item) => [item.clipId, item]));
    const currentMap = new Map(currentList.map((item) => [item.clipId, item]));
    const changeMap = new Map(diff.changed.map((item) => [item.clipId, item]));
    const ids = [...new Set([...fromMap.keys(), ...toMap.keys()])].sort();
    return ids.map((clipId) => {
        const from = fromMap.get(clipId);
        const to = toMap.get(clipId);
        const current = currentMap.get(clipId);
        const change = changeMap.get(clipId);
        let status = "未更换";
        let color = "default";
        if (change) {
            if (change.state === "storageKeyChanged") { status = "成片更换"; color = "orange"; }
            else if (change.state === "durationChanged") { status = "时长变化"; color = "blue"; }
            else { status = "重生成凭证变化"; color = "blue"; }
        } else if (!from) { status = "仅新版有成片记录"; color = "green"; }
        else if (!to) { status = "仅旧版有成片记录"; color = "red"; }
        return { clipId, title: to?.title || from?.title || clipId, status, color, from, to, current };
    });
}
