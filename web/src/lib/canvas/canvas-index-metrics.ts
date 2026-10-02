/** Opt-in counters for the isolated browser benchmark. No global state is created by the app. */
export function recordCanvasIndexBuild(kind: "topology" | "groups" | "nodes" | "connections") {
    if (typeof window === "undefined") return;
    const counters = (window as unknown as { __canvasIndexMetrics?: Record<string, number> }).__canvasIndexMetrics;
    if (counters) counters[kind] = (counters[kind] || 0) + 1;
}
