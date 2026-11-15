import { episodeHasScript } from "@basketikun/canvas-agent/drama/production-contract";
import type { DramaEpisode } from "@/services/backend-api";

export { SCRIPT_SYNOPSIS_THRESHOLD, episodeHasScript } from "@basketikun/canvas-agent/drama/production-contract";

/**
 * 批量写剧本大纲的排队逻辑：只排还没写的集，按集号升序，一集写完再排下一集。
 * 「算不算写过」的判定与后端 agent 的 drama_get_planning 共用合同里那一条。
 */
export function pendingScriptEpisodes(episodes: readonly Pick<DramaEpisode, "id" | "episodeNumber" | "fullPlot" | "synopsis">[]): Array<Pick<DramaEpisode, "id" | "episodeNumber" | "fullPlot" | "synopsis">> {
    return [...episodes].filter((episode) => !episodeHasScript(episode)).sort((left, right) => left.episodeNumber - right.episodeNumber);
}

/** 已经写过剧本大纲的集数。 */
export function writtenScriptCount(episodes: readonly Pick<DramaEpisode, "fullPlot" | "synopsis">[]) {
    return episodes.filter((episode) => episodeHasScript(episode)).length;
}

/** 一集失败就停下来：前面写好的保留，告诉用户卡在哪一集。 */
export function batchFailure(episodeNumber: number, reason: string) {
    return `第 ${episodeNumber} 集没写成：${reason}`;
}
