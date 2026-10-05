export type BackendConnectionMonitorState = { checking: boolean; connected: boolean };
export type BackendConnectionMonitorDependencies = {
    healthCheck: () => Promise<{ ok: boolean }>;
    fullCheck: () => Promise<unknown>;
    markDisconnected: () => void;
};
export type BackendConnectionMonitorResult = "skipped" | "full" | "healthy" | "disconnected";

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
        dependencies.markDisconnected();
        return "disconnected";
    }
    return "healthy";
}
