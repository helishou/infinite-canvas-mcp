import { useQueries } from "@tanstack/react-query";
import { fetchBackendDramaEpisodes, type DramaEpisode } from "@/services/backend-api";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useBackendStore } from "@/stores/use-backend-store";

/** One query cache supplies directory cards and the canvas ownership boundary. */
export function useDramaDirectory() {
    const hydrated = useCanvasStore(state => state.hydrated);
    const folders = useCanvasStore(state => state.folders);
    const connected = useBackendStore(state => state.connected);
    const backendUrl = useBackendStore(state => state.url);
    const dramaFolders = folders.filter(folder => folder.isDrama);
    const queries = useQueries({
        queries: dramaFolders.map(folder => ({
            queryKey: ["project-directory-episodes", backendUrl, folder.id],
            enabled: hydrated && connected,
            queryFn: async () => (await fetchBackendDramaEpisodes(folder.id)).episodes || [],
        })),
    });
    const episodesByDrama: Record<string, DramaEpisode[] | undefined> = {};
    queries.forEach((query, index) => { episodesByDrama[dramaFolders[index].id] = query.data; });
    return {
        dramaFolders,
        episodesByDrama,
        ownershipReady: queries.every(query => query.data !== undefined),
        ownershipLoading: connected && queries.some(query => query.isPending),
        ownershipError: queries.some(query => query.isError),
        refresh: () => { void Promise.all(queries.map(query => query.refetch())); },
    };
}
