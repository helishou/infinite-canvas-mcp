export type BackendConnectionMonitorState = { checking: boolean; connected: boolean };
export type BackendConnectionMonitorDependencies = {
    healthCheck: () => Promise<{ ok: boolean }>;
    fullCheck: () => Promise<unknown>;
};
export type BackendConnectionMonitorResult = "skipped" | "full" | "healthy";

/** Use the lightweight health endpoint while connected; re-run auth/business checks only for recovery. */
export async function runBackendConnectionMonitorCycle(
    state: BackendConnectionMonitorState,
    forceFullCheck: boolean,
    dependencies: BackendConnectionMonitorDependencies,
): Promise<BackendConnectionMonitorResult> {
    if (state.checking) return "skipped";
    if (forceFullCheck || !state.connected) {
        await dependencies.fullCheck();
        return "full";
    }
    const health = await dependencies.healthCheck();
    if (!health.ok) {
        // A single health timeout can be a brief event-loop stall while the write
        // API is still available. Confirm with the normal auth + business probe
        // before changing the global connection state to disconnected.
        await dependencies.fullCheck();
        return "full";
    }
    return "healthy";
}
