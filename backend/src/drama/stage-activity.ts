import { stageForToolCall, type DramaStageName } from "@basketikun/canvas-agent/drama/stage-contract";

/**
 * 「导演现在在干什么」的内存态：工具调用一发生就记一笔，页面按 dramaId 读。
 *
 * 只记最近一次，不做历史——阶段推进以 stage-contract 派生为准，
 * 这里只解决"agent 正在跑哪一段"的实时提示，重启后自然清空。
 */

export type DramaStageActivity = {
    key: string;
    stage: DramaStageName;
    label: string;
    tool: string;
    at: number;
};

const STALE_MS = 5 * 60_000;
const store = new Map<string, DramaStageActivity>();

export function recordStageActivity(key: string, tool: string, args: Record<string, unknown>) {
    const id = String(key || "").trim();
    if (!id) return;
    const hit = stageForToolCall(tool, args);
    if (!hit) return;
    store.set(id, { key: id, stage: hit.stage, label: hit.label, tool, at: Date.now() });
}

/** 多键取最新（剧目 id、分集 id、画布 id 都可能被当成键）。 */
export function freshestStageActivity(keys: readonly string[], now = Date.now()): DramaStageActivity | null {
    let best: DramaStageActivity | null = null;
    for (const key of keys) {
        const hit = stageActivityOf(key, now);
        if (hit && (!best || hit.at > best.at)) best = hit;
    }
    return best;
}

/** 读最近一次动作；过期（默认 5 分钟）就当没在跑。 */
export function stageActivityOf(dramaId: string, now = Date.now()): DramaStageActivity | null {
    const hit = store.get(String(dramaId || "").trim());
    if (!hit) return null;
    return now - hit.at <= STALE_MS ? hit : null;
}

/** 只给测试用：清空。 */
export function resetStageActivity() {
    store.clear();
}
