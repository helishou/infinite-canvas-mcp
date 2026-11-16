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
    // 「最近生成」只展示图片/视频/音频：单独取更长的一段日志。首页的 30 条窗口会被
    // 纯文本对话（导演、分镜描述）刷满，导致媒体结果被挤出列表、区块显示空态。
    const [mediaLogCount, setMediaLogCount] = useState(60);
    const [mediaLogs, setMediaLogs] = useState<BackendGenerationLog[]>([]);
    const [mediaLoading, setMediaLoading] = useState(false);
    const [mediaHasMore, setMediaHasMore] = useState(false);
    const [refreshKey, setRefreshKey] = useState(0);
    const queryClient = useQueryClient();
    const dramas = folders.filter((folder) => folder.isDrama);
    const ownershipQueries = useQueries({
        queries: dramas.flatMap((folder) => [
            {
                queryKey: ["canvas-library-episodes", backendUrl, folder.id],
                enabled: connected,
                queryFn: async () => ((await fetchBackendDramaEpisodes(folder.id)).episodes || [])
                    .filter((episode) => episode.canvasId)
                    .map((episode) => ({ id: episode.id, canvasId: episode.canvasId! })),
            },
        ]),
    });
    const episodesByDrama: Record<string, { id: string; canvasId: string }[] | undefined> = {};
    ownershipQueries.forEach((result, index) => { episodesByDrama[dramas[index].id] = result.data; });
    const canvasOwners = dramaCanvasOwners(folders, episodesByDrama);
    const canvasEpisodes = new Map<string, { dramaId: string; episodeId: string }>();
    for (const drama of dramas) {
        for (const episode of episodesByDrama[drama.id] || []) canvasEpisodes.set(episode.canvasId, { dramaId: drama.id, episodeId: episode.id });
    }
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
        let pollTimer: ReturnType<typeof setTimeout> | undefined;
        const ACTIVE_STATUSES = new Set(["queued", "running", "awaiting_confirmation"]);
        // SSE 事件是主刷新通道；休眠唤醒 / HMR / 后端重载都可能丢事件导致状态卡在「运行中」，
        // 因此用轮询兜底：有进行中的任务时 4s 一轮，空闲时 30s 一轮做对账。
        const schedulePoll = (tasks: BackendRuntimeTask[]) => {
            window.clearTimeout(pollTimer);
            if (disposed) return;
            const hasActive = tasks.some((task) => ACTIVE_STATUSES.has(task.status));
            pollTimer = setTimeout(() => { void load(); }, hasActive ? 4000 : 30000);
        };
        const load = async () => {
            if (running) {
                pending = true;
                return;
            }
            running = true;
            do {
                pending = false;
                setLoading(true);
                setMediaLoading(true);
                const readSettings = needsSettings;
                needsSettings = false;
                const [logResult, taskResult, settingsResult, mediaResult] = await Promise.allSettled([
                    fetchBackendGenerationLogs({ limit: logCount, summary: true }),
                    fetchBackendTasks({ limit: 30, summary: true }),
                    readSettings ? request<{ settings: FrontendSettings }>("GET", "/settings") : Promise.resolve(null),
                    fetchBackendGenerationLogs({ limit: mediaLogCount, summary: true }),
                ]);
                if (disposed) return;
                const failed: string[] = [];
                if (logResult.status === "fulfilled") {
                    setLogs(logResult.value.logs || []);
                    setHasMore((logResult.value.logs || []).length === logCount);
                } else if (!isBackendAvailabilityError(logResult.reason)) failed.push("logs");
                if (taskResult.status === "fulfilled") {
                    setTasks(taskResult.value.tasks || []);
                    schedulePoll(taskResult.value.tasks || []);
                } else {
                    if (!isBackendAvailabilityError(taskResult.reason)) failed.push("tasks");
                    schedulePoll([]);
                }
                if (settingsResult.status === "fulfilled" && settingsResult.value) {
                    setSettings(settingsResult.value.settings || {});
                    setSettingsReady(true);
                }
                if (settingsResult.status === "rejected") {
                    setSettingsReady(false);
                    needsSettings = true;
                    if (!isBackendAvailabilityError(settingsResult.reason)) failed.push("settings");
                }
                if (mediaResult.status === "fulfilled") {
                    const nextMediaLogs = mediaResult.value.logs || [];
                    setMediaLogs(nextMediaLogs);
                    setMediaHasMore(nextMediaLogs.length === mediaLogCount);
                    // 整段仍是纯文本时自动向后扩展（上限 180），避免「最近生成」被文本刷屏挤空。
                    // mediaLogCount 进入下方 effect 依赖，扩展会触发一次新的 load，最多两轮。
                    if (!collectOutputs(nextMediaLogs).length && nextMediaLogs.length === mediaLogCount && mediaLogCount < 180) {
                        setMediaLogCount(count => Math.min(count + 60, 180));
                    }
                } else if (!isBackendAvailabilityError(mediaResult.reason)) failed.push("media-logs");
                setMediaLoading(false);
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
            window.clearTimeout(pollTimer);
            window.removeEventListener("backend-event", onEvent);
            window.removeEventListener("backend-connected", onReconnect);
            window.removeEventListener("backend-retry", onReconnect);
        };
    }, [connected, backendUrl, logCount, mediaLogCount, refreshKey]);
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
    return { connected, backendUrl, logs, tasks, settings, settingsReady, loading, errors, hasMore, refresh, mediaLogs, mediaLoading, mediaHasMore, loadMoreMedia: () => setMediaLogCount((count) => count + 60), canvasOwners, canvasEpisodes, dramaReady, dramaError, pinning, togglePin, loadMore: () => setLogCount((count) => count + 30) };
}
