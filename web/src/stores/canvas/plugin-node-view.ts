import type { CanvasNodeContext } from "@/types/canvas-plugin";

// 每个浏览器窗口独立的视图状态；不写项目、同步队列或撤销栈。
// 但必须落一份浏览器本地副本：H3 这类节点的模块宽高、当前片段、播放指针都属于视图偏好，
// 只放内存的话刷新一次就回落成内置默认值，用户看到的现象是「刚调好的布局被还原」。
// localStorage 在这里只当可丢弃缓存用（单节点快照几百字节），写不进（隐私模式 / 配额超限）也不报错。
const views = new Map<string, CanvasNodeContext["view"]>();
const STORAGE_PREFIX = "canvas-plugin-view:";
// 瞬态视图键不持久化：播放请求计数 / 连续播放开关 / 拖动中标志都是「这一刻」的状态，
// 存下来只会在下次打开时误触发播放或让时间轴卡住。
const EPHEMERAL_VIEW_KEYS = new Set(["h3PlayRequest", "h3PlaybackAll", "h3Scrubbing"]);
const pendingWrites = new Map<string, Record<string, unknown>>();
let flushTimer: number | undefined;

const storageKey = (projectId: string, nodeId: string) => `${STORAGE_PREFIX}${projectId}:${nodeId}`;

function readStoredSnapshot(key: string): Record<string, unknown> {
    try {
        const raw = localStorage.getItem(key);
        const parsed = raw ? JSON.parse(raw) : null;
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch {
        return {};
    }
}

function flushPendingWrites() {
    if (flushTimer !== undefined) { window.clearTimeout(flushTimer); flushTimer = undefined; }
    for (const [key, snapshot] of pendingWrites) {
        try {
            const persisted = Object.fromEntries(Object.entries(snapshot).filter(([name]) => !EPHEMERAL_VIEW_KEYS.has(name)));
            if (Object.keys(persisted).length) localStorage.setItem(key, JSON.stringify(persisted));
            else localStorage.removeItem(key);
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
                if (flushTimer === undefined) flushTimer = window.setTimeout(flushPendingWrites, 300);
                listeners.forEach((listener) => listener());
            },
        };
        views.set(key, view);
    }
    return view;
}
