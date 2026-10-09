import { useEffect, useMemo, useState } from "react";
import { Button, Input, Tag } from "antd";
import { ArrowUpRight, Clapperboard, Plus, Search } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { fetchBackendDramaEpisodes, type DramaEpisode } from "@/services/backend-api";
import { resolveImageUrl } from "@/services/image-storage";
import { useCanvasStore, type CanvasFolder } from "@/stores/canvas/use-canvas-store";

const DRAMA_LIBRARY = "__drama-library__";

export default function DramaPage() {
    const { t } = useTranslation();
    const hydrated = useCanvasStore((state) => state.hydrated);
    const folders = useCanvasStore((state) => state.folders);
    const createFolder = useCanvasStore((state) => state.createFolder);
    const [libraryQuery, setLibraryQuery] = useState("");
    const [query, setQuery] = useSearchParams();
    const setActiveView = (id: string) => {
        const next = new URLSearchParams(query);
        if (id === DRAMA_LIBRARY) { next.delete("dramaId"); next.delete("manage"); next.delete("episodeId"); } else { next.set("dramaId", id); next.delete("manage"); next.delete("episodeId"); }
        setQuery(next);
    };
    const dramaFolders = useMemo(() => folders.filter((folder) => folder.isDrama), [folders]);
    const shownDramaFolders = dramaFolders.filter(folder => folder.name.toLocaleLowerCase().includes(libraryQuery.trim().toLocaleLowerCase()));
    const [episodesByDrama, setEpisodesByDrama] = useState<Record<string, DramaEpisode[]>>({});
    useEffect(() => {
        if (!hydrated || !dramaFolders.length) {
            setEpisodesByDrama({});
            return;
        }
        let disposed = false;
        void Promise.all(dramaFolders.map(async (folder) => {
            try {
                const result = await fetchBackendDramaEpisodes(folder.id);
                return [folder.id, result.episodes || []] as const;
            } catch {
                // 普通画布文件夹可能不是剧目；它没有分集时按空列表处理。
                return [folder.id, []] as const;
            }
        })).then((entries) => {
            if (!disposed) setEpisodesByDrama(Object.fromEntries(entries));
        });
        return () => { disposed = true; };
    }, [dramaFolders, hydrated]);

    const createDrama = () => {
        const name = window.prompt(t("drama.createProjectPrompt"), t("drama.defaultProjectName"));
        if (name?.trim()) setActiveView(createFolder(name.trim(), true));
    };

    return (
        <main>
            <div className="flex flex-wrap items-center justify-between gap-3">
                <Input className="!w-56" allowClear prefix={<Search className="size-4 text-muted-foreground" />} aria-label={t("landing.searchSeries")} placeholder={t("landing.searchSeries")} value={libraryQuery} onChange={event => setLibraryQuery(event.target.value)} />
                <Button type="primary" onClick={createDrama} icon={<Plus className="size-4" />}>{t("drama.createProject")}</Button>
            </div>
            <section className="mt-6">
                {!hydrated ? (
                    <div className="flex min-h-72 items-center justify-center border-y border-stone-200 text-sm text-stone-500 dark:border-stone-800">{t("canvas.loading")}</div>
                ) : dramaFolders.length ? (
                    <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
                        {shownDramaFolders.map((folder) => <DramaCard key={folder.id} folder={folder} episodes={episodesByDrama[folder.id] || []} onOpen={() => setActiveView(folder.id)} t={t} />)}
                        {!shownDramaFolders.length && <p className="py-12 text-center text-sm text-muted-foreground sm:col-span-2 xl:col-span-3">{t("landing.noSeriesMatches")}</p>}
                    </div>
                ) : (
                    <div className="flex min-h-72 flex-col items-center justify-center rounded-2xl border border-dashed border-stone-300 px-6 text-center dark:border-stone-700">
                        <div className="grid size-12 place-items-center rounded-full bg-orange-100 text-orange-600 dark:bg-orange-950/40 dark:text-orange-300"><Clapperboard className="size-5" /></div>
                        <h3 className="mt-5 text-lg font-medium">{t("drama.emptyProjectsTitle")}</h3>
                        <p className="mt-2 max-w-md text-sm leading-6 text-stone-500 dark:text-stone-400">{t("drama.emptyProjectsDescription")}</p>
                        <Button type="primary" className="mt-5" icon={<Plus className="size-4" />} onClick={createDrama}>{t("drama.createProject")}</Button>
                    </div>
                )}
            </section>
        </main>
    );
}

function DramaCard({ folder, episodes, onOpen, t }: { folder: CanvasFolder; episodes: DramaEpisode[]; onOpen: () => void; t: import("i18next").TFunction }) {
    const [coverUrl, setCoverUrl] = useState("");
    useEffect(() => {
        let disposed = false;
        setCoverUrl("");
        if (!folder.coverStorageKey) return;
        void resolveImageUrl(folder.coverStorageKey).then((url) => { if (!disposed) setCoverUrl(url); });
        return () => { disposed = true; };
    }, [folder.coverStorageKey]);
    const boundCanvases = episodes.filter((episode) => episode.canvasId).length;
    return <button type="button" className="group overflow-hidden rounded-xl border border-border bg-card text-left transition-colors hover:border-foreground/40" onClick={onOpen}>
        <div className="relative aspect-[16/9] overflow-hidden bg-muted/30">
            {coverUrl ? <img src={coverUrl} alt={folder.name} className="h-full w-full object-cover" /> : <div className="grid h-full place-items-center text-orange-500"><Clapperboard className="size-10 stroke-[1.2]" /></div>}

            <span className="absolute bottom-3 left-4 rounded bg-background/90 px-2 py-1 text-xs font-medium text-foreground">{t("drama.episodeCount", { count: episodes.length })}</span>
        </div>
        <div className="p-5">
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                    <h3 className="truncate text-xl font-semibold tracking-tight">{folder.name}</h3>
                    <p className="mt-2 line-clamp-2 min-h-10 text-sm leading-5 text-stone-500 dark:text-stone-400">{folder.description || folder.outline || t("drama.outlineEmpty")}</p>
                </div>
                <ArrowUpRight className="mt-1 size-4 shrink-0 text-stone-400 transition group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:text-orange-500" />
            </div>
            {(folder.tags || []).length ? <div className="mt-4 flex gap-1.5 overflow-hidden">{(folder.tags || []).slice(0, 3).map((tag) => <Tag key={tag} className="m-0 max-w-28 truncate border-stone-300 bg-transparent text-xs text-stone-500 dark:border-stone-700 dark:text-stone-400">{tag}</Tag>)}</div> : null}
            <div className="mt-5 flex items-center justify-between border-t border-stone-100 pt-4 text-xs text-stone-400 dark:border-stone-800">
                <span>{t("drama.boundCanvasCount", { count: boundCanvases })}</span>
                <span>{t("drama.enterProject")}</span>
            </div>
        </div>
    </button>;
}
