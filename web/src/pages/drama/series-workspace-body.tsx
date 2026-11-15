import { DramaManagePanel } from "./manage-panel";
import { NovelAdaptPanel } from "./adapt-panel";
import type { SeriesWorkspaceView } from "./production-workspace";

/**
 * 剧目级工作区的正文分发：规划 / 共享资产 / 分集仍由 DramaManagePanel 负责，
 * 「小说改编」交给 NovelAdaptPanel。抽成一层是为了让制作台只认 workspace 与 view，
 * 不必在每个渲染点写条件分支。
 */
export function SeriesWorkspaceBody({ dramaId, view, initialPlanningTab, navigationTitleVisible = false, onEpisodesChanged }: {
    dramaId: string;
    view: SeriesWorkspaceView;
    initialPlanningTab?: "settings";
    navigationTitleVisible?: boolean;
    onEpisodesChanged?: () => void;
}) {
    if (view === "adapt") return <NovelAdaptPanel dramaId={dramaId} onEpisodesChanged={onEpisodesChanged} />;
    return <DramaManagePanel navigationTitleVisible={navigationTitleVisible} dramaId={dramaId} view={view} initialPlanningTab={initialPlanningTab} onEpisodesChanged={onEpisodesChanged} />;
}
