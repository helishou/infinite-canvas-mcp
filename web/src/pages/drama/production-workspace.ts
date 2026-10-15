import { productionSceneEntries } from "@basketikun/canvas-agent/drama/production-contract";
import type { EpisodeProduction } from "@/services/backend-api";
import type { DirectorWorkspace } from "./director-panel";

export type SeriesWorkspaceView = "planning" | "episodes" | "shared";
export type ProductionWorkspaceScope = "episode" | "canvas" | "shared-assets";
export type ProductionNavigationItem = { id: string; workspace: DirectorWorkspace; labelKey: string; seriesView?: SeriesWorkspaceView };
export type ProductionNavigationGroup = { id: string; labelKey: string; items: ProductionNavigationItem[] };

export const productionWorkspaces: readonly DirectorWorkspace[] = ["series", "overview", "story", "assets", "shots", "continuity", "production", "advanced"];

export function seriesWorkspaceView(value: string | null): SeriesWorkspaceView | undefined {
    return value === "planning" || value === "episodes" || value === "shared" ? value : undefined;
}

export function productionNavigationGroups({ hasSeries, scope, setup = false, seriesSubviews = false }: { hasSeries: boolean; scope: ProductionWorkspaceScope; setup?: boolean; seriesSubviews?: boolean }): ProductionNavigationGroup[] {
    const groups: ProductionNavigationGroup[] = [];
    // 下拉只保留「规划与资产 / 分集管理」；seriesSubviews 在子 Tab 栏里展开共享资产画布，规划项回到「剧目规划」。
    if (hasSeries) groups.push({ id: "series", labelKey: "director.workspaceHierarchy.fullSeries", items: [
        { id: "series:planning", workspace: "series", seriesView: "planning", labelKey: seriesSubviews ? "director.workspaceHierarchy.planning" : "director.workspaceHierarchy.planningAssets" },
        ...(seriesSubviews ? [{ id: "series:shared", workspace: "series" as const, seriesView: "shared" as const, labelKey: "director.workspaceHierarchy.sharedCanvas" }] : []),
        { id: "series:episodes", workspace: "series", seriesView: "episodes", labelKey: "director.workspaceHierarchy.episodes" },
    ] });
    if (setup) return groups;
    groups.push({ id: "owner", labelKey: `director.workspaceHierarchy.${scope === "episode" ? "currentEpisode" : scope === "shared-assets" ? "sharedProduction" : "currentProject"}`, items:
        (["overview", "story", "assets", "shots", "continuity", "production"] as const).map(workspace => ({
            id: workspace, workspace,
            labelKey: workspace === "assets" ? `director.workspaceHierarchy.${scope === "episode" ? "episodeAssets" : scope === "shared-assets" ? "sharedAssets" : "projectAssets"}` : `director.workspace.tab.${workspace}`,
        })),
    });
    groups.push({ id: "settings", labelKey: "director.workspaceHierarchy.settings", items: [{ id: "advanced", workspace: "advanced", labelKey: "director.workspace.tab.advanced" }] });
    return groups;
}

/** Preserve owner and unrelated URL state; only the previous object's focus is cleared. */
export function productionWorkspaceQuery(search: URLSearchParams, workspace: DirectorWorkspace, options: { embedded?: boolean; target?: { kind: string; id: string }; seriesView?: SeriesWorkspaceView } = {}) {
    const next = new URLSearchParams(search);
    next.set("workspace", workspace);
    next.delete("target"); next.delete("nodeId"); next.delete("segmentId");
    if (!options.embedded) { next.delete("runId"); next.delete("workId"); }
    if (workspace === "series" && options.seriesView) next.set("seriesView", options.seriesView);
    else next.delete("seriesView");
    if (options.target?.id) next.set("target", `${options.target.kind === "keyframe" ? "frame" : options.target.kind}:${options.target.id}`);
    return next;
}

/** Breadcrumbs describe the focused record, never a fabricated project or shared owner. */
export function productionTargetTitle(production: EpisodeProduction, target: string): string | undefined {
    const separator = target.indexOf(":");
    if (separator < 1) return undefined;
    const kind = target.slice(0, separator), id = target.slice(separator + 1);
    if (!id) return undefined;
    const source = production.draft.director?.source;
    const rows = (key: string): Record<string, unknown>[] => Array.isArray(source?.[key]) ? source[key] as Record<string, unknown>[] : [];
    if (kind === "asset") {
        const asset = rows("asset_plan").find(item => String(item.asset_id || item.id) === id);
        return String(asset?.asset_name || asset?.name || id);
    }
    if (kind === "scene" && source) {
        const scene = productionSceneEntries(source).find(item => item.id === id);
        return scene?.title || id;
    }
    if (kind === "shot" || kind === "frame" || kind === "keyframe") {
        const shot = rows("shots").find(item => String(item.id) === id);
        return String(shot?.title || production.draft.shots.find(item => item.id === id)?.title || id);
    }
    if (kind === "segment") {
        const segment = rows("segments").find(item => String(item.id) === id);
        return String(segment?.title || segment?.name || id);
    }
    return id;
}
