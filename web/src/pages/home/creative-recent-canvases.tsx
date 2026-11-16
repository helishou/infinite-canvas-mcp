import { ArrowUpRight, Clock3, Plus } from "lucide-react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";

import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import type { WorkbenchMedia } from "./workbench-data";
import { WorkbenchMediaPreview } from "./workbench-media";

const RECENT_LIMIT = 3;

/**
 * 影策 creation-recent-canvases 的本地形态：创作台下方一排紧凑画布卡。
 * 首卡新建空白画布，其余取最近更新的三张；与下方「继续编辑 / 项目列表」共用同一份画布数据与封面缓存。
 */
export function CreativeRecentCanvases({ projects, cover, onOpen, onCreate, loading = false }: {
    projects: CanvasProject[];
    cover: (project: CanvasProject) => WorkbenchMedia | null;
    onOpen: (id: string) => void;
    onCreate: () => void;
    loading?: boolean;
}) {
    const { t, i18n } = useTranslation();
    const recent = projects.slice(0, RECENT_LIMIT);
    const date = (value: string) => (Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleDateString(i18n.resolvedLanguage, { month: "short", day: "numeric" }) : "—");

    return (
        <section className="mb-6" aria-label={t("creativePad.recent.title")} data-testid="creative-recent-canvases">
            <header className="mb-3 flex items-center justify-between gap-2">
                <h2 className="ui-panel-title inline-flex items-center gap-2">
                    <Clock3 className="size-4 text-muted-foreground" aria-hidden="true" />
                    {t("creativePad.recent.title")}
                </h2>
                <Link to="/canvas" className="ui-caption inline-flex items-center gap-1 text-muted-foreground transition-colors hover:text-foreground">
                    {t("creativePad.recent.viewAll")}
                    <ArrowUpRight className="size-3.5" aria-hidden="true" />
                </Link>
            </header>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <button
                    type="button"
                    data-testid="creative-recent-create"
                    disabled={loading}
                    onClick={onCreate}
                    className="ch-recent-tile border-dashed disabled:opacity-50"
                >
                    <span className="ch-recent-thumb" aria-hidden="true">
                        <Plus className="size-4.5" />
                    </span>
                    <span className="min-w-0">
                        <strong className="block truncate text-[13px] font-semibold">{t("creativePad.recent.create")}</strong>
                        <small className="block truncate text-xs text-muted-foreground">{t("creativePad.recent.createHint")}</small>
                    </span>
                </button>
                {loading
                    ? Array.from({ length: RECENT_LIMIT }, (_, index) => (
                        <div key={index} className="ch-recent-tile animate-pulse" aria-hidden="true" />
                    ))
                    : recent.map(project => (
                        <button
                            key={project.id}
                            type="button"
                            data-testid="creative-recent-tile"
                            title={project.title}
                            onClick={() => onOpen(project.id)}
                            className="ch-recent-tile"
                        >
                            <span className="ch-recent-thumb">
                                <WorkbenchMediaPreview media={cover(project)} label={project.title} />
                            </span>
                            <span className="min-w-0 flex-1">
                                <strong className="block truncate text-[13px] font-semibold">{project.title}</strong>
                                <small className="block truncate text-xs text-muted-foreground">
                                    {t("creativePad.recent.nodeCount", { count: project.summary?.nodeCount ?? project.nodes.length })} · {date(project.updatedAt)}
                                </small>
                            </span>
                        </button>
                    ))}
            </div>
        </section>
    );
}
