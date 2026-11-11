export type ClipReadinessState = "ready" | "blocked" | "needs_review" | "complete";
export type NodeReadinessRollup = "ready" | "attention" | undefined;

const listeners = new Set<() => void>();
let snapshot: Readonly<Record<string, ClipReadinessState>> = {};
let nodeRollups: Readonly<Record<string, NodeReadinessRollup>> = {};

const notify = () => listeners.forEach((l) => l());

export const productionReadinessStore = {
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getTargetMap: () => snapshot,
    getNodeRollupMap: () => nodeRollups,
    set: (targets: Record<string, ClipReadinessState>, rollups: Record<string, NodeReadinessRollup>) => {
        snapshot = targets;
        nodeRollups = rollups;
        notify();
    },
    clear: () => {
        if (!Object.keys(snapshot).length && !Object.keys(nodeRollups).length) return;
        snapshot = {};
        nodeRollups = {};
        notify();
    },
};

export function computeNodeReadinessRollup(
    segments: Array<{ productionClipProjection?: { targetId?: string } }> | undefined,
    targetMap: Readonly<Record<string, ClipReadinessState>>,
): NodeReadinessRollup {
    if (!segments?.length) return undefined;
    const ids = segments.map((s) => s.productionClipProjection?.targetId).filter(Boolean) as string[];
    if (!ids.length) return undefined;
    let allReady = true;
    let hasAttention = false;
    for (const id of ids) {
        const state = targetMap[id];
        if (state === "ready" || state === "complete") continue;
        allReady = false;
        if (state === "blocked" || state === "needs_review") hasAttention = true;
    }
    if (allReady) return "ready";
    if (hasAttention) return "attention";
    return undefined;
}