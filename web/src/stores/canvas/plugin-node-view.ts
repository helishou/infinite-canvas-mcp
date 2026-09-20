import type { CanvasNodeContext } from "@/types/canvas-plugin";

// 每个浏览器窗口独立的视图状态；不写项目、同步队列或撤销栈。
// 但必须落一份浏览器本地副本：H3 这类节点的模块宽高、当前片段、播放指针都属于视图偏好，
// 只放内存的话刷新一次就回落成内置默认值，用户看到的现象是「刚调好的布局被还原」。
// localStorage 在这里只当可丢弃缓存用（单节点快照几百字节），写不进（隐私模式 / 配额超限）也不报错。
const views = new Map<string, CanvasNodeContext["view"]>();
const STORAGE_PREFIX = "canvas-plugin-view:";
// 瞬态视图键不持久化：播放请求计数 / 连续播放开关 / 拖动中标志都是「这一刻」的状态，
// 存下来只会在下次打开时误触发播放或让时间轴卡住。h3PromptJobs 同理——上游 LLM 请求超时
// 或失败后若把 running 落盘，刷新会让按钮永远卡在「增强中…」，再次点击又因为
// H3PromptSection 的 early-return 静默吞掉，新请求发不出去。
const EPHEMERAL_VIEW_KEYS = new Set(["h3PlayRequest", "h3PlaybackAll", "h3Scrubbing", "h3PromptJobs"]);
const pendingWrites = new Map<string, Record<string, unknown>>();
let flushTimer: number | undefined;

const storageKey = (projectId: string, nodeId: string) => `${STORAGE_PREFIX}${projectId}:${nodeId}`;

function readStoredSnapshot(key: string): Record<string, unknown> {
    try {
        const raw = localStorage.getItem(key);
        const parsed = raw ? JSON.parse(raw) : null;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
        // 读时也要过滤 ephemeral：早期版本把这些键也持久化了，刷新页面会读到
        // 残留的「running」状态，导致 H3 节点的「增强提示词」按钮永远卡死。
        // 写侧 flushPendingWrites 已经不再写它们了，但磁盘上的脏数据只能靠读侧剔除。
        return Object.fromEntries(Object.entries(parsed).filter(([name]) => !EPHEMERAL_VIEW_KEYS.has(name))) as Record<string, unknown>;
    } catch {
        return {};
    }
}

function flushPendingWrites() {
    if (flushTimer !== undefined) {
        if (typeof window !== "undefined") window.clearTimeout(flushTimer);
        else clearTimeout(flushTimer);
        flushTimer = undefined;
    }
    for (const [key, snapshot] of pendingWrites) {
        try {
            const persisted = Object.fromEntries(Object.entries(snapshot).filter(([name]) => !EPHEMERAL_VIEW_KEYS.has(name)));
            if (!Object.keys(persisted).length) continue;
            // 与磁盘上已有的合并再写：同一个节点可能同时开在多个标签页，整份覆盖会让
            // 「另一个窗口没改过这个键」也一起被抹掉（实测：新窗口拖好的 Setting 宽度
            // 被老窗口一次回写冲掉）。本窗口已有的键优先。
            localStorage.setItem(key, JSON.stringify({ ...readStoredSnapshot(key), ...persisted }));
        } catch { /* 视图状态本来就可丢弃 */ }
    }
    pendingWrites.clear();
}

if (typeof window !== "undefined") window.addEventListener("pagehide", flushPendingWrites);

export function getPluginNodeView(projectId: string, nodeId: string): CanvasNodeContext["view"] {
    const key = storageKey(projectId, nodeId);
    let view = views.get(key);
    if (!view) {
        // 首次进入该节点：先恢复上次的视图偏好，再对外提供快照，
        // 保证首帧渲染就是用户调好的布局（放到 effect 里恢复会出现默认布局闪一下）。
        let snapshot: Record<string, unknown> = readStoredSnapshot(key);
        const listeners = new Set<() => void>();
        view = {
            getSnapshot: () => snapshot,
            subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
            update: (patch) => {
                if (Object.keys(patch).every((name) => Object.is(snapshot[name], patch[name]))) return;
                snapshot = { ...snapshot, ...patch };
                // 拖手柄时每帧都会 update，落盘做 300ms 合并；页面隐藏 / 卸载时补写。
                pendingWrites.set(key, snapshot);
                if (flushTimer === undefined) {
                    flushTimer = (typeof window !== "undefined" ? window.setTimeout(flushPendingWrites, 300) : setTimeout(flushPendingWrites, 300)) as unknown as number;
                }
                listeners.forEach((listener) => listener());
            },
        };
        views.set(key, view);
    }
    return view;
}
