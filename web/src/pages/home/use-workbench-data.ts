import { useCallback, useEffect, useState } from "react";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { fetchBackendDramaEpisodes, fetchBackendGenerationLogs, fetchBackendTasks, isBackendAvailabilityError, request, type BackendGenerationLog, type BackendRuntimeTask } from "@/services/backend-api";
import { saveSettings, type FrontendSettings } from "@/services/settings-api";
import { useBackendStore } from "@/stores/use-backend-store";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { dramaCanvasOwners } from "@/pages/projects/directory-data";
import { collectOutputs, retainProjectCovers, type WorkbenchMedia } from "./workbench-data";

/** Keep the first available cover for a project version while other snapshots arrive. */
export function useStableProjectCovers(candidates: Array<{ key: string; media: WorkbenchMedia | null }>) {
    const [covers, setCovers] = useState<Record<string, WorkbenchMedia>>({});
    useEffect(() => {
        setCovers((current) => retainProjectCovers(current, candidates));
    }, [candidates]);
    return covers;
}

/** Query only displayed summary cards; never load all nodes just to find a thumbnail. */
export function useProjectCoverResults(projectVersions: Array<[string, string]>) {
    const connected = useBackendStore((state) => state.connected);
    const backendUrl = useBackendStore((state) => state.url);
    const results = useQueries({
        queries: projectVersions.map(([id, version]) => ({
            queryKey: ["project-cover", backendUrl, id, version],
            enabled: connected,
            queryFn: async () => {
                const logs = (await fetchBackendGenerationLogs({ projectId: id, status: "success", limit: 1 })).logs || [];
                return collectOutputs(logs).find((output) => output.kind !== "audio") || null;
            },
        })),
    });
    const covers = new Map(projectVersions.map(([id, version], index) => [JSON.stringify([id, version]), results[index].data]));
    return (id: string, version: string) => covers.get(JSON.stringify([id, version])) || null;
}

export function useWorkbenchData() {
    const connected = useBackendStore((state) => state.connected);
    const backendUrl = useBackendStore((state) => state.url);
    const folders = useCanvasStore((state) => state.folders);
    const [logs, setLogs] = useState<BackendGenerationLog[]>([]);
    const [tasks, setTasks] = useState<BackendRuntimeTask[]>([]);
    const [settings, setSettings] = useState<FrontendSettings>({});
    const [settingsReady, setSettingsReady] = useState(false);
    const [loading, setLoading] = useState(false);
    const [errors, setErrors] = useState<string[]>([]);
    const [logCount, setLogCount] = useState(30);
    const [hasMore, setHasMore] = useState(false);
    const [refreshKey, setRefreshKey] = useState(0);
    const queryClient = useQueryClient();
    const dramas = folders.filter((folder) => folder.isDrama);
    const ownershipQueries = useQueries({
        queries: dramas.flatMap((folder) => [
            {
                queryKey: ["canvas-library-episodes", backendUrl, folder.id],
                enabled: connected,
                queryFn: async () => ((await fetchBackendDramaEpisodes(folder.id)).episodes || []).map((episode) => episode.canvasId || ""),
            },
        ]),
    });
    const episodesByDrama: Record<string, { canvasId: string }[] | undefined> = {};
    ownershipQueries.forEach((result, index) => { episodesByDrama[dramas[index].id] = result.data?.map(canvasId => ({ canvasId })); });
    const canvasOwners = dramaCanvasOwners(folders, episodesByDrama);
    const dramaReady = ownershipQueries.every((result) => result.data !== undefined);
    const dramaError = ownershipQueries.some((result) => result.isError && !isBackendAvailabilityError(result.error));
    const [pinning, setPinning] = useState(false);
    const refresh = useCallback(() => {
        setRefreshKey((value) => value + 1);
        void queryClient.invalidateQueries({ predicate: (query) => query.queryKey[1] === backendUrl && query.queryKey[0] === "canvas-library-episodes" });
    }, [backendUrl, queryClient]);
    useEffect(() => {
        setLogs([]);
        setTasks([]);
        setSettings({});
        setSettingsReady(false);
    }, [backendUrl]);
    useEffect(() => {
        if (!connected) {
            setLoading(false);
            setSettingsReady(false);
            return;
        }
        let disposed = false,
            running = false,
            pending = false,
            needsSettings = true;
        const load = async () => {
            if (running) {
                pending = true;
                return;
            }
            running = true;
            do {
                pending = false;
                setLoading(true);
                const readSettings = needsSettings;
                needsSettings = false;
                const [logResult, taskResult, settingsResult] = await Promise.allSettled([
                    fetchBackendGenerationLogs({ limit: logCount, summary: true }),
                    fetchBackendTasks({ limit: 30, summary: true }),
                    readSettings ? request<{ settings: FrontendSettings }>("GET", "/settings") : Promise.resolve(null),
                ]);
                if (disposed) return;
                const failed: string[] = [];
                if (logResult.status === "fulfilled") {
                    setLogs(logResult.value.logs || []);
                    setHasMore((logResult.value.logs || []).length === logCount);
                } else if (!isBackendAvailabilityError(logResult.reason)) failed.push("logs");
                if (taskResult.status === "fulfilled") setTasks(taskResult.value.tasks || []);
                else if (!isBackendAvailabilityError(taskResult.reason)) failed.push("tasks");
                if (settingsResult.status === "fulfilled" && settingsResult.value) {
                    setSettings(settingsResult.value.settings || {});
                    setSettingsReady(true);
                }
                if (settingsResult.status === "rejected") {
                    setSettingsReady(false);
                    needsSettings = true;
                    if (!isBackendAvailabilityError(settingsResult.reason)) failed.push("settings");
                }
                setErrors(failed);
                setLoading(false);
            } while (pending && !disposed);
            running = false;
        };
        const onEvent = (event: Event) => {
            const type = (event as CustomEvent<{ type?: string }>).detail?.type || "";
            if (type === "settings.updated") needsSettings = true;
            if (type.startsWith("task.") || type === "generation-log.updated" || type === "settings.updated") void load();
        };
        const onReconnect = () => {
            needsSettings = true;
            void load();
        };
        void load();
        window.addEventListener("backend-event", onEvent);
        window.addEventListener("backend-connected", onReconnect);
        window.addEventListener("backend-retry", onReconnect);
        return () => {
            disposed = true;
            window.removeEventListener("backend-event", onEvent);
            window.removeEventListener("backend-connected", onReconnect);
            window.removeEventListener("backend-retry", onReconnect);
        };
    }, [connected, backendUrl, logCount, refreshKey]);
    const togglePin = async (projectId: string) => {
        if (pinning || !settingsReady || !connected) return;
        const key = `homePinnedProject:${projectId}` as const,
            value = !settings[key];
        setPinning(true);
        try {
            await saveSettings({ [key]: value });
            setSettings((current) => ({ ...current, [key]: value }));
        } finally {
            setPinning(false);
        }
    };
    return { connected, backendUrl, logs, tasks, settings, settingsReady, loading, errors, hasMore, refresh, canvasOwners, dramaReady, dramaError, pinning, togglePin, loadMore: () => setLogCount((count) => count + 30) };
}
