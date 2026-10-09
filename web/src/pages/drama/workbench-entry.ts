import type { DramaEpisode } from "@/services/backend-api";

export function dramaWorkbenchEpisode(episodes: DramaEpisode[], requestedId?: string | null) {
    if (requestedId) {
        const selected = episodes.find(episode => episode.id === requestedId);
        if (!selected) throw new Error("EPISODE_OUTSIDE_DRAMA");
        return selected;
    }
    return [...episodes].sort((a, b) => a.episodeNumber - b.episodeNumber || a.id.localeCompare(b.id))[0];
}

export function dramaWorkbenchPath(dramaId: string, episodeId?: string, workspace?: string) {
    const query = new URLSearchParams({ dramaId });
    if (episodeId) query.set("episodeId", episodeId);
    if (workspace) query.set("workspace", workspace);
    return `/production?${query}`;
}
