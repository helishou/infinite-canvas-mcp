import { useEffect, useState } from "react";
import { App, Button, Input, Tag } from "antd";
import { ArrowUpRight, Clapperboard, Plus, Search, Trash2 } from "lucide-react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";

import type { DramaEpisode } from "@/services/backend-api";
import { resolveImageUrl } from "@/services/image-storage";
import { useCanvasStore, type CanvasFolder } from "@/stores/canvas/use-canvas-store";
import { PageSectionHeader } from "@/components/layout/page-header";
import { cn } from "@/lib/utils";

import { confirmDeleteDrama } from "./confirm-delete-drama";
import { matchesProjectQuery } from "@/pages/projects/directory-data";
import { useDramaDirectory } from "@/pages/projects/use-drama-directory";

/**
 * 剧目目录页。新建剧目已改成整页表单（`/drama-studio/new`，new-drama-page.tsx），
 * 旧的三步弹窗（NewDramaWizard）不再从这里打开：入口只负责导航。
 */
export default function DramaPage({ searchQuery, compactEmpty = false, headingHidden = false }: { searchQuery?: string; compactEmpty?: boolean; headingHidden?: boolean } = {}) {
    const { t } = useTranslation();
    const hydrated = useCanvasStore((state) => state.hydrated);
    const [localQuery, setLibraryQuery] = useState("");
    const libraryQuery = searchQuery ?? localQuery;
    const [query] = useSearchParams();
    const navigate = useNavigate();
    const { message } = App.useApp();
    const { dramaFolders, episodesByDrama } = useDramaDirectory();
    const setActiveView = (id: string) => {
        if (episodesByDrama[id] === undefined) {
            message.info(t("projects.episodesUnavailable"));
            return;
        }
        // 作品卡片是旧版制作台的入口，统一改为落新版制作台；规划页跳转只属于新建向导，不在这里处理。
        const next = new URLSearchParams(query.toString());
        next.set("dramaId", id);
        next.delete("manage");
        navigate(`/drama-studio?${next.toString()}`);
    };
    const shownDramaFolders = [...dramaFolders]
        .sort((a, b) => (Date.parse(b.updatedAt || b.createdAt) || 0) - (Date.parse(a.updatedAt || a.createdAt) || 0))
        .filter(folder => matchesProjectQuery(folder.name, libraryQuery));
    /** 新建改成整页（/drama-studio/new）；旧弹窗已删除，草稿与创建都在那一页里。 */
    const openCreateDrama = () => navigate("/drama-studio/new");

    return (
        <section className="text-foreground" aria-label={t("projects.drama")}>
            {searchQuery === undefined ? (
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-5">
                    <Input className="!w-full sm:!w-80" size="large" allowClear prefix={<Search className="mr-1 size-4 text-muted-foreground" />} aria-label={t("landing.searchSeries")} placeholder={t("landing.searchSeries")} value={libraryQuery} onChange={event => setLibraryQuery(event.target.value)} />
                    <Button type="primary" disabled={!hydrated} onClick={openCreateDrama} icon={<Plus className="size-4" />}>{t("drama.createProject")}</Button>
                </div>
            ) : (
                <PageSectionHeader
                    title={headingHidden ? undefined : t("projects.directoryTitles.drama")}
                    description={headingHidden ? undefined : t("projects.dramaDescription")}
                    actions={<Button type="primary" disabled={!hydrated} onClick={openCreateDrama} icon={<Plus className="size-4" />}>{t("drama.createProject")}</Button>}
                />
            )}
            <section className="mt-6">
                {!hydrated ? (
                    <div role="status" className="flex min-h-72 items-center justify-center rounded-xl border border-border bg-card/50 text-sm text-muted-foreground">{t("canvas.loading")}</div>
                ) : dramaFolders.length ? (
                    <div data-card-grid className="grid gap-5 [grid-template-columns:repeat(auto-fill,minmax(300px,1fr))]">
                        {shownDramaFolders.map((folder) => <DramaCard key={folder.id} folder={folder} episodes={episodesByDrama[folder.id]} onOpen={() => setActiveView(folder.id)} t={t} />)}
                        {!shownDramaFolders.length && <p className="rounded-xl border border-border bg-card/50 px-6 py-20 text-center text-sm text-muted-foreground sm:col-span-2 xl:col-span-3">{t("landing.noSeriesMatches")}</p>}
                    </div>
                ) : (
                    <div className={cn("flex items-center rounded-xl border border-border bg-card/50", compactEmpty ? "grid grid-cols-[36px_minmax(0,1fr)] gap-4 px-5 py-5 text-left sm:flex" : "min-h-80 flex-col justify-center px-6 py-10 text-center")}>
                        <Clapperboard className="size-9 shrink-0 stroke-[1.2] text-primary" aria-hidden="true" />
                        <div className={cn("min-w-0", compactEmpty && "flex-1")}>
                            <h3 className={cn("text-lg font-medium", !compactEmpty && "mt-5")}>{t("drama.emptyProjectsTitle")}</h3>
                            <p className={cn("mt-2 text-sm leading-6 text-muted-foreground", !compactEmpty && "max-w-md")}>{t("drama.emptyProjectsDescription")}</p>
                        </div>
                        <Button type="primary" className={cn("shrink-0", compactEmpty ? "col-start-2 justify-self-start" : "mt-5")} icon={<Plus className="size-4" />} onClick={openCreateDrama}>{t("drama.createProject")}</Button>
                    </div>
                )}
            </section>
        </section>
    );
}

function DramaCard({ folder, episodes, onOpen, t }: { folder: CanvasFolder; episodes: DramaEpisode[] | undefined; onOpen: () => void; t: import("i18next").TFunction }) {
    const deleteDramaProject = useCanvasStore((state) => state.deleteDramaProject);
    const { modal, message } = App.useApp();
    const [coverUrl, setCoverUrl] = useState("");
    useEffect(() => {
        let disposed = false;
        setCoverUrl("");
        if (!folder.coverStorageKey) return;
        void resolveImageUrl(folder.coverStorageKey).then((url) => { if (!disposed) setCoverUrl(url); });
        return () => { disposed = true; };
    }, [folder.coverStorageKey]);
    const boundCanvases = episodes?.filter((episode) => episode.canvasId).length;
    return <div role="button" tabIndex={0} className="group flex h-full flex-col overflow-hidden rounded-xl border border-border bg-card text-left transition-colors hover:border-primary/40 focus-visible:outline-primary" onClick={onOpen}>
        {coverUrl ? (
            <div className="relative aspect-[16/9] w-full overflow-hidden border-b border-border bg-muted/50">
                <img src={coverUrl} alt={folder.name} className="h-full w-full object-cover" loading="lazy" />
                <span className="absolute bottom-3 left-4 rounded-md border border-border/50 bg-card/95 px-2 py-1 text-[11px] font-medium text-foreground">{episodes ? t("drama.episodeCount", { count: episodes.length }) : t("projects.episodesUnavailable")}</span>
            </div>
        ) : (
            // 没有封面就不占 16:9：集数 badge 与图标合成一行紧凑卡头。
            <div className="flex items-center gap-2 border-b border-border px-5 py-3">
                <Clapperboard className="size-6 shrink-0 stroke-[1.2] text-primary/60" aria-hidden="true" />
                <span className="rounded-md border border-border/60 px-2 py-0.5 text-[11px] font-medium text-muted-foreground">{episodes ? t("drama.episodeCount", { count: episodes.length }) : t("projects.episodesUnavailable")}</span>
            </div>
        )}
        <div className="flex w-full flex-1 flex-col p-5">
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                    <h3 className="truncate text-lg font-medium tracking-tight">{folder.name}</h3>
                    <p className="mt-2 line-clamp-2 min-h-10 text-sm leading-5 text-muted-foreground">{folder.description || folder.outline || t("drama.outlineEmpty")}</p>
                </div>
                <ArrowUpRight className="mt-1 size-4 shrink-0 text-muted-foreground transition-colors group-hover:text-primary" />
            </div>
            {(folder.tags || []).length ? <div className="mt-4 flex gap-1.5 overflow-hidden">{(folder.tags || []).slice(0, 3).map((tag) => <Tag key={tag} className="m-0 max-w-28 truncate border-border bg-transparent text-xs text-muted-foreground">{tag}</Tag>)}</div> : null}
            <div className="mt-auto flex flex-wrap items-center justify-between gap-2 border-t border-border pt-4 text-[11px] text-muted-foreground">
                <span>{episodes ? t("drama.boundCanvasCount", { count: boundCanvases }) : t("projects.episodesUnavailable")}</span>
                <span className="flex items-center gap-3">
                    <button type="button" className="text-red-500 hover:text-red-600" onClick={(event) => { event.stopPropagation(); void confirmDeleteDrama({ modal, message, t, drama: folder, onDelete: (options) => deleteDramaProject(folder.id, options) }); }}> <Trash2 className="inline size-3.5" /> {t("drama.deleteProject")}</button>
                    <span>{t("drama.enterProject")}</span>
                </span>
            </div>
        </div>
    </div>;
}
