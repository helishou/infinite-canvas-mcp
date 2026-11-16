import { DramaManagePanel } from "./manage-panel";
import type { SeriesWorkspaceView } from "./production-workspace";

/**
 * 剧目级工作区的正文分发：规划 / 共享资产 / 分集都由 DramaManagePanel 负责。
 * 抽成一层是为了让制作台只认 workspace 与 view，不必在每个渲染点写条件分支。
 * 「小说改编」已并入剧目规划的「原剧本」页签，不再是独立视图。
 */
export function SeriesWorkspaceBody({ dramaId, view, initialPlanningTab, navigationTitleVisible = false, onEpisodesChanged }: {
    dramaId: string;
    view: SeriesWorkspaceView;
    initialPlanningTab?: "settings" | "source";
    navigationTitleVisible?: boolean;
    onEpisodesChanged?: () => void;
}) {
    return <DramaManagePanel navigationTitleVisible={navigationTitleVisible} dramaId={dramaId} view={view} initialPlanningTab={initialPlanningTab} onEpisodesChanged={onEpisodesChanged} />;
}
