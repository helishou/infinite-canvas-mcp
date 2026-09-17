import type { CanvasNodeContext } from "@/types/canvas-plugin";

// 每个浏览器窗口独立的可丢弃视图状态；不写项目、同步队列或撤销栈。
const views = new Map<string, CanvasNodeContext["view"]>();

export function getPluginNodeView(projectId: string, nodeId: string): CanvasNodeContext["view"] {
    const key = JSON.stringify([projectId, nodeId]);
    let view = views.get(key);
    if (!view) {
        let snapshot: Record<string, unknown> = {};
        const listeners = new Set<() => void>();
        view = {
            getSnapshot: () => snapshot,
            subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
            update: (patch) => {
                if (Object.keys(patch).every((name) => Object.is(snapshot[name], patch[name]))) return;
                snapshot = { ...snapshot, ...patch };
                listeners.forEach((listener) => listener());
            },
        };
        views.set(key, view);
    }
    return view;
}
