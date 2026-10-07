import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { flushSync } from "react-dom";
import { App, Button, Input, Modal, Select, Tag } from "antd";
import { ArrowLeft, ArrowUpRight, Clapperboard, Download, FileArchive, ImagePlus, Images, PencilLine, Plus, Trash2, Upload, Search } from "lucide-react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";

import { loadCanvasProjectPage } from "@/lib/canvas-project-loader";
import { cn } from "@/lib/utils";
import { backendMediaUrl, createBackendDramaEpisode, deleteBackendDramaAsset, deleteBackendDramaEpisode, fetchBackendDramaAssets, fetchBackendDramaEpisodes, updateBackendDramaEpisode, uploadBackendDramaAsset, ensureSharedAssetCanvas, type DramaCustomAsset, type DramaEpisode } from "@/services/backend-api";
import { resolveImageUrl, uploadImage } from "@/services/image-storage";
import { useCanvasStore, type CanvasFolder, type CanvasProject } from "@/stores/canvas/use-canvas-store";
import { dramaProductionPlanSchema, type DramaProductionPlan } from "@basketikun/canvas-agent/drama/production-contract";
import { ModelPicker } from "@/components/model-picker";
import { useConfigStore } from "@/stores/use-config-store";
import { upsertBackendCanvasFolder } from "@/services/backend-api";

import { SceneProductionSettings } from "./scene-production-settings";

const DRAMA_LIBRARY = "__drama-library__";

type DramaDraft = {
    productionPlan: DramaProductionPlan;
    expectedPlanningUpdatedAt: string;
    name: string;
    outline: string;
    description: string;
    tags: string;
    coverStorageKey: string | null;
    coverUrl: string;
};

type EpisodeDraft = {
    id?: string;
    episodeNumber: number;
    title: string;
    synopsis: string;
    fullPlot: string;
    canvasId: string | null;
};

type DramaViewTransitionDocument = Document & {
    startViewTransition?: (update: () => void) => { finished: Promise<unknown> };
};

export default function DramaPage({ embedded = false }: { embedded?: boolean }) {
    const { message, modal } = App.useApp();
    const { t } = useTranslation();
    const navigate = useNavigate();
    const hydrated = useCanvasStore((state) => state.hydrated);
    const projects = useCanvasStore((state) => state.projects);
    const folders = useCanvasStore((state) => state.folders);
    const createFolder = useCanvasStore((state) => state.createFolder);
    const updateFolder = useCanvasStore((state) => state.updateFolder);
    const deleteDramaProject = useCanvasStore((state) => state.deleteDramaProject);
    const [libraryQuery, setLibraryQuery] = useState("");
    const TitleHeading = embedded ? "h2" : "h1";
    const [query, setQuery] = useSearchParams();
    const activeView = query.get("dramaId") || DRAMA_LIBRARY;
    const setActiveView = (id: string) => {
        const next = new URLSearchParams(query);
        next.set("view", "dramas");
        if (id === DRAMA_LIBRARY) next.delete("dramaId"); else next.set("dramaId", id);
        setQuery(next);
    };
    const [openingSharedCanvas, setOpeningSharedCanvas] = useState(false);
    const [transitionDramaId, setTransitionDramaId] = useState<string | null>(null);
    const [editorOpen, setEditorOpen] = useState(false);
    const [draft, setDraft] = useState<DramaDraft | null>(null);
    const [activeCoverUrl, setActiveCoverUrl] = useState("");
    const [uploadingCover, setUploadingCover] = useState(false);
    const [savingPlan, setSavingPlan] = useState(false);
    const modelConfig = useConfigStore(state => state.config);
    const [episodesByDrama, setEpisodesByDrama] = useState<Record<string, DramaEpisode[]>>({});
    const [episodeEditorOpen, setEpisodeEditorOpen] = useState(false);
    const [episodeDraft, setEpisodeDraft] = useState<EpisodeDraft | null>(null);
    const [episodeSaving, setEpisodeSaving] = useState(false);
    const [assetsByDrama, setAssetsByDrama] = useState<Record<string, DramaCustomAsset[]>>({});
    const [uploadingAssets, setUploadingAssets] = useState(false);
    const coverInputRef = useRef<HTMLInputElement>(null);
    const assetInputRef = useRef<HTMLInputElement>(null);

    const dramaFolders = useMemo(() => folders.filter((folder) => folder.isDrama), [folders]);
    const shownDramaFolders = dramaFolders.filter(folder => folder.name.toLocaleLowerCase().includes(libraryQuery.trim().toLocaleLowerCase()));
    const activeFolder = dramaFolders.find((folder) => folder.id === activeView);
    useEffect(() => {
        let disposed = false;
        setActiveCoverUrl("");
        if (!activeFolder?.coverStorageKey) return;
        void resolveImageUrl(activeFolder.coverStorageKey).then((url) => { if (!disposed) setActiveCoverUrl(url); });
        return () => { disposed = true; };
    }, [activeFolder?.coverStorageKey]);
    useEffect(() => {
        if (!hydrated || !dramaFolders.length) {
            setEpisodesByDrama({});
            return;
        }
        // The project page is by far the heaviest route chunk. Warm it while
        // users browse episode cards, making the first click navigation cheap.
        void loadCanvasProjectPage();
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
    useEffect(() => {
        if (!activeFolder) return;
        let disposed = false;
        void fetchBackendDramaAssets(activeFolder.id)
            .then((result) => { if (!disposed) setAssetsByDrama((current) => ({ ...current, [activeFolder.id]: result.assets || [] })); })
            .catch((error) => { if (!disposed) message.error(error instanceof Error ? error.message : t("drama.customAssets.loadFailed")); });
        return () => { disposed = true; };
    }, [activeFolder?.id, message]);
    const visibleEpisodes = activeFolder ? (episodesByDrama[activeFolder.id] || []) : [];

    const createDrama = () => {
        const name = window.prompt(t("drama.createProjectPrompt"), t("drama.defaultProjectName"));
        if (name?.trim()) setActiveView(createFolder(name.trim(), true));
    };
    const changeDramaView = (nextView: string, dramaId: string) => {
        const viewDocument = document as DramaViewTransitionDocument;
        const startViewTransition = viewDocument.startViewTransition?.bind(viewDocument);
        if (!startViewTransition || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
            setActiveView(nextView);
            return;
        }
        flushSync(() => setTransitionDramaId(dramaId));
        try {
            const transition = startViewTransition(() => flushSync(() => setActiveView(nextView)));
            void transition.finished.finally(() => setTransitionDramaId(null));
        } catch {
            setTransitionDramaId(null);
            setActiveView(nextView);
        }
    };
    const openEpisodeEditor = (episode?: DramaEpisode) => {
        if (!activeFolder) return;
        const current = episodesByDrama[activeFolder.id] || [];
        setEpisodeDraft(episode ? {
            id: episode.id,
            episodeNumber: episode.episodeNumber,
            title: episode.title,
            synopsis: episode.synopsis,
            fullPlot: episode.fullPlot || "",
            canvasId: episode.canvasId,
        } : {
            episodeNumber: Math.max(0, ...current.map((item) => item.episodeNumber)) + 1,
            title: `第 ${Math.max(0, ...current.map((item) => item.episodeNumber)) + 1} 集`,
            synopsis: "",
            fullPlot: "",
            canvasId: null,
        });
        setEpisodeEditorOpen(true);
    };
    const saveEpisode = async () => {
        if (!activeFolder || !episodeDraft) return;
        const episodeNumber = Math.max(1, Math.trunc(episodeDraft.episodeNumber));
        const title = episodeDraft.title.trim() || `第 ${episodeNumber} 集`;
        try {
            setEpisodeSaving(true);
            const canvasId = episodeDraft.canvasId;
            const result = episodeDraft.id
                ? await updateBackendDramaEpisode(episodeDraft.id, { episodeNumber, title, synopsis: episodeDraft.synopsis, fullPlot: episodeDraft.fullPlot, canvasId })
                : await createBackendDramaEpisode(activeFolder.id, { episodeNumber, title, synopsis: episodeDraft.synopsis, fullPlot: episodeDraft.fullPlot, canvasId });
            if (!result.episode) throw new Error("后端没有返回分集");
            setEpisodesByDrama((current) => ({
                ...current,
                [activeFolder.id]: [...(current[activeFolder.id] || []).filter((item) => item.id !== result.episode!.id), result.episode!].sort((a, b) => a.episodeNumber - b.episodeNumber),
            }));
            setEpisodeEditorOpen(false);
            setEpisodeDraft(null);
            message.success(episodeDraft.id ? t("drama.episodeSaved") : t("drama.episodeCreated"));
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("drama.episodeSaveFailed"));
        } finally {
            setEpisodeSaving(false);
        }
    };
    const removeEpisode = (episode: DramaEpisode) => {
        modal.confirm({
            title: t("drama.deleteEpisodeTitle"),
            content: t("drama.deleteEpisodeDescription", { name: episode.title || `第 ${episode.episodeNumber} 集` }),
            okType: "danger",
            okText: t("drama.deleteProjectConfirm"),
            cancelText: t("common.cancel"),
            onOk: async () => {
                try {
                    await deleteBackendDramaEpisode(episode.id);
                    if (activeFolder) setEpisodesByDrama((current) => ({ ...current, [activeFolder.id]: (current[activeFolder.id] || []).filter((item) => item.id !== episode.id) }));
                    if (episodeDraft?.id === episode.id) {
                        setEpisodeEditorOpen(false);
                        setEpisodeDraft(null);
                    }
                    message.success(t("drama.episodeDeleted"));
                } catch (error) {
                    message.error(error instanceof Error ? error.message : t("drama.episodeDeleteFailed"));
                    throw error;
                }
            },
        });
    };
    const openFolderEditor = () => {
        if (!activeFolder) return;
        setDraft({
            productionPlan: dramaProductionPlanSchema.parse(activeFolder.productionPlan || {}),
            expectedPlanningUpdatedAt: activeFolder.updatedAt || activeFolder.createdAt,
            name: activeFolder.name,
            outline: activeFolder.outline || "",
            description: activeFolder.description || "",
            tags: (activeFolder.tags || []).join(", "),
            coverStorageKey: activeFolder.coverStorageKey || null,
            coverUrl: activeCoverUrl,
        });
        setEditorOpen(true);
    };
    const saveFolder = async (confirm = true) => {
        if (!activeFolder || !draft) return;
        if (confirm && !draft.productionPlan.storyboardImageMode) {
            message.warning(t("productionCanvas.storyboardImageRequired"));
            return;
        }
        if (confirm && draft.productionPlan.parallelScenes && !draft.productionPlan.reviewPolicy) { message.warning(t("sceneProduction.reviewRequired")); return; }
        const patch = {
            name: draft.name.trim() || activeFolder.name,
            outline: draft.outline.trim(),
            description: draft.description.trim(),
            tags: draft.tags.split(",").map((tag) => tag.trim()).filter(Boolean),
            coverStorageKey: draft.coverStorageKey,
            productionPlan: { ...draft.productionPlan, confirmedOutline: confirm ? draft.outline.trim() : "", confirmedAt: confirm ? new Date().toISOString() : undefined },
        };
        setSavingPlan(true);
        try {
            const result = await upsertBackendCanvasFolder({ ...activeFolder, ...patch, expectedPlanningUpdatedAt: draft.expectedPlanningUpdatedAt, updatedAt: new Date().toISOString() });
            useCanvasStore.setState(state => ({ folders: state.folders.map(folder => folder.id === activeFolder.id ? result.folder as unknown as CanvasFolder : folder) }));
            setEditorOpen(false);
            message.success(t(confirm ? "drama.saved" : "sceneProduction.draftSaved"));
        } catch (error) { message.error(String(error)); }
        finally { setSavingPlan(false); }
    };
    const deleteDrama = () => {
        if (!activeFolder) return;
        const folder = activeFolder;
        modal.confirm({
            title: t("drama.deleteProject"),
            content: t("drama.deleteProjectDescription", { name: folder.name }),
            okText: t("drama.deleteProjectConfirm"),
            okType: "danger",
            cancelText: t("common.cancel"),
            onOk: () => {
                deleteDramaProject(folder.id);
                setEditorOpen(false);
                setDraft(null);
                setActiveView(DRAMA_LIBRARY);
                message.success(t("drama.deleted"));
            },
        });
    };
    const handleCoverChange = async (event: ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        event.target.value = "";
        if (!file || !draft) return;
        try {
            setUploadingCover(true);
            const uploaded = await uploadImage(file, { category: "library" });
            setDraft((current) => current ? { ...current, coverStorageKey: uploaded.storageKey || null, coverUrl: uploaded.url } : current);
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("drama.coverUploadFailed"));
        } finally {
            setUploadingCover(false);
        }
    };
    const handleAssetUpload = async (event: ChangeEvent<HTMLInputElement>) => {
        const files = Array.from(event.target.files || []);
        event.target.value = "";
        if (!activeFolder || !files.length) return;
        try {
            setUploadingAssets(true);
            const uploaded: DramaCustomAsset[] = [];
            for (const file of files) uploaded.push(await uploadBackendDramaAsset(activeFolder.id, file));
            setAssetsByDrama((current) => ({ ...current, [activeFolder.id]: [...uploaded, ...(current[activeFolder.id] || [])] }));
            message.success(t("drama.customAssets.uploaded", { count: uploaded.length }));
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("drama.customAssets.uploadFailed"));
        } finally {
            setUploadingAssets(false);
        }
    };
    const removeDramaAsset = (asset: DramaCustomAsset) => {
        if (!activeFolder) return;
        const dramaId = activeFolder.id;
        modal.confirm({
            title: t("drama.customAssets.deleteTitle"),
            content: t("drama.customAssets.deleteDescription", { name: asset.data.fileName || asset.title }),
            okType: "danger",
            okText: "删除",
            cancelText: t("common.cancel"),
            onOk: async () => {
                await deleteBackendDramaAsset(dramaId, asset.id);
                setAssetsByDrama((current) => ({ ...current, [dramaId]: (current[dramaId] || []).filter((item) => item.id !== asset.id) }));
                message.success(t("drama.customAssets.deleted"));
            },
        });
    };
    const openProject = (project: CanvasProject) => {
        // The canvas route owns a very large lazy chunk. Start loading it before
        // navigation so React Router can render the target page immediately.
        void loadCanvasProjectPage();
        navigate(`/canvas/${project.id}?from=dramas`);
    };

    return (
        <main className={cn("bg-background text-foreground", !embedded && "h-full overflow-y-auto")}>
            <div className={cn(!embedded && "mx-auto max-w-7xl px-6 py-8 lg:px-10")}>
                <header className="flex flex-wrap items-start justify-between gap-5 border-b border-border pb-4">
                        <div className="min-w-0 max-w-2xl">
                            <div className={cn("flex items-center gap-2 text-sm font-semibold text-muted-foreground", embedded && "hidden")}>
                                <Clapperboard className="size-5" />
                                {t("drama.eyebrow")}
                            </div>
                            <TitleHeading className={cn("truncate font-semibold tracking-tight", embedded ? "text-lg" : "mt-2 text-2xl sm:text-3xl")} style={activeFolder && transitionDramaId === activeFolder.id ? { viewTransitionName: "drama-title" } : undefined}>{activeFolder?.name || t("drama.libraryTitle")}</TitleHeading>
                            <p className="mt-1.5 max-w-xl truncate text-sm text-stone-500 dark:text-stone-400" style={activeFolder && transitionDramaId === activeFolder.id ? { viewTransitionName: "drama-summary" } : undefined}>{activeFolder ? activeFolder.description || t("drama.detailDescription") : t(embedded ? "landing.seriesHint" : "drama.libraryDescription")}</p>
                        </div>
                        <div className="flex flex-wrap gap-2">
                            {!activeFolder && <Input className="!w-48 sm:!w-56" allowClear prefix={<Search className="size-4 text-muted-foreground" />} aria-label={t("landing.searchSeries")} placeholder={t("landing.searchSeries")} value={libraryQuery} onChange={event => setLibraryQuery(event.target.value)} />}
                            {activeFolder
                                ? <Button type="primary" onClick={() => openEpisodeEditor()} icon={<Plus className="size-4" />}>{t("drama.newEpisode")}</Button>
                                : <Button type="primary" onClick={createDrama} icon={<Plus className="size-4" />}>{t("drama.createProject")}</Button>}
                        </div>
                </header>

                {!activeFolder ? (
                        <section className="mt-6">
                            {!hydrated ? (
                                <div className="flex min-h-72 items-center justify-center border-y border-stone-200 text-sm text-stone-500 dark:border-stone-800">{t("canvas.loading")}</div>
                            ) : dramaFolders.length ? (
                                <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
                                    {shownDramaFolders.map((folder) => <DramaCard key={folder.id} folder={folder} episodes={episodesByDrama[folder.id] || []} transitioning={transitionDramaId === folder.id} onOpen={() => changeDramaView(folder.id, folder.id)} t={t} />)}
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
                ) : (
                    <div className="mt-4">
                        <button type="button" className="group mb-4 inline-flex items-center gap-1.5 px-0.5 py-1 text-xs font-medium tracking-wide text-stone-500 transition-colors hover:text-orange-600 dark:text-stone-400 dark:hover:text-orange-400" onClick={() => changeDramaView(DRAMA_LIBRARY, activeFolder.id)}>
                            <ArrowLeft className="size-3.5 transition-transform duration-200 group-hover:-translate-x-0.5" />
                            <span>{t("drama.backToProjects")}</span>
                        </button>
                        <div className="mb-10 grid overflow-hidden rounded-2xl border border-stone-200 bg-stone-100/70 dark:border-stone-800 dark:bg-stone-900/60 md:grid-cols-[200px_minmax(0,1fr)_auto]">
                            <div className="relative min-h-44 overflow-hidden rounded-2xl bg-stone-200 dark:bg-stone-800" style={transitionDramaId === activeFolder.id ? { viewTransitionName: "drama-cover" } : undefined}>
                                {activeCoverUrl ? <img src={activeCoverUrl} alt={activeFolder.name} className="h-full w-full object-cover" /> : <div className="grid h-full min-h-44 place-items-center text-orange-500"><Clapperboard className="size-10 stroke-[1.2]" /></div>}
                            </div>
                            <div className="min-w-0 p-6">
                                <p className="text-xs font-medium uppercase tracking-[0.16em] text-orange-600 dark:text-orange-400">{t("drama.projectProfile")}</p>
                                <h2 className="mt-2 text-lg font-semibold tracking-tight">{t("productionCanvas.dramaPlanning")}</h2>
                                <p className="mt-2 text-xs text-muted-foreground">{t("productionCanvas.dramaPlanningHint")}</p>
                                <p className="mt-2 text-xs text-muted-foreground">{t(activeFolder.productionPlan?.confirmedAt && activeFolder.productionPlan.confirmedOutline === activeFolder.outline ? "productionCanvas.planConfirmed" : "productionCanvas.planUnconfirmed")}</p>
                                <p className="mt-3 line-clamp-4 whitespace-pre-line text-sm leading-6 text-stone-500 dark:text-stone-400">{activeFolder.outline || t("drama.outlineEmpty")}</p>
                                <div className="mt-4 flex flex-wrap gap-1.5">{(activeFolder.tags || []).map((tag) => <Tag key={tag} className="m-0 border-stone-300 bg-transparent text-xs text-stone-500 dark:border-stone-700 dark:text-stone-400">{tag}</Tag>)}</div>
                            </div>
                            <div className="flex items-start p-5 md:justify-end"><Button icon={<PencilLine className="size-4" />} onClick={openFolderEditor}>{t("productionCanvas.dramaPlanning")}</Button></div>
                        </div>

                        <section data-drama-shared-canvas className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-border bg-card p-5">
                            <div className="flex min-w-0 items-start gap-3"><Images className="mt-1 size-5 shrink-0 text-muted-foreground" /><div><h2 className="text-base font-semibold">{t("productionCanvas.sharedCanvas")}</h2><p className="mt-1 text-sm text-muted-foreground">{t("productionCanvas.sharedCanvasDescription")}</p><p className="mt-2 text-xs text-muted-foreground">{t(activeFolder.sharedAssetCanvasId ? "productionCanvas.sharedCanvasReady" : "productionCanvas.sharedCanvasEmpty")}</p></div></div>
                            <Button loading={openingSharedCanvas} onClick={async () => {
                                if (openingSharedCanvas) return;
                                if (!activeFolder.sharedAssetCanvasId && !(activeFolder.productionPlan?.confirmedAt && activeFolder.productionPlan.confirmedOutline === activeFolder.outline)) { openFolderEditor(); return; }
                                setOpeningSharedCanvas(true);
                                try { const { project } = await ensureSharedAssetCanvas(activeFolder.id); navigate(`/canvas/${encodeURIComponent(String(project.id))}`); }
                                catch (error) { message.error(String(error)); }
                                finally { setOpeningSharedCanvas(false); }
                            }}>{t("productionCanvas.openSharedCanvas")}<ArrowUpRight className="ml-1 size-4" /></Button>
                        </section>
                        <section>
                            <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
                                <div>
                                    <p className="text-xs font-medium uppercase tracking-[0.16em] text-orange-600 dark:text-orange-400">{t("drama.episodes")}</p>
                                    <h2 className="mt-2 text-2xl font-semibold tracking-tight">{t("drama.episodeListTitle")}</h2>
                                </div>
                                <div className="flex items-center gap-3">
                                    <span className="text-sm text-stone-400">{visibleEpisodes.length} {t("drama.episodeUnit")}</span>
                                </div>
                            </div>
                            {visibleEpisodes.length ? (
                                <div className="grid gap-4 sm:grid-cols-2">
                                    {visibleEpisodes.map((episode, index) => <EpisodeCard key={episode.id} episode={episode} project={episode.canvasId ? projects.find((item) => item.id === episode.canvasId) : undefined} index={index} onOpen={openProject} onProduce={() => navigate(`/drama/episodes/${encodeURIComponent(episode.id)}/production?from=dramas`)} onEdit={() => openEpisodeEditor(episode)} onDelete={() => removeEpisode(episode)} t={t} />)}
                                </div>
                            ) : (
                                <div className="flex min-h-60 flex-col items-center justify-center rounded-2xl border border-dashed border-stone-300 px-6 text-center dark:border-stone-700">
                                    <div className="grid size-12 place-items-center rounded-full bg-orange-100 text-orange-600 dark:bg-orange-950/40 dark:text-orange-300"><Clapperboard className="size-5" /></div>
                                    <h3 className="mt-5 text-lg font-medium">{t("drama.emptyFolderTitle")}</h3>
                                    <p className="mt-2 max-w-md text-sm leading-6 text-stone-500 dark:text-stone-400">{t("drama.emptyFolderDescription")}</p>
                                    <Button type="primary" className="mt-5" icon={<Plus className="size-4" />} onClick={() => openEpisodeEditor()}>{t("drama.newEpisode")}</Button>
                                </div>
                            )}
                        </section>

                        <section className="mt-10 rounded-2xl border border-stone-200 bg-background p-5 dark:border-stone-800">
                            <div className="flex flex-wrap items-center justify-between gap-3">
                                <div>
                                    <p className="text-xs font-medium uppercase tracking-[0.16em] text-orange-600 dark:text-orange-400">{t("drama.customAssets.eyebrow")}</p>
                                    <h3 className="mt-1 text-lg font-semibold">{t("drama.customAssets.title")}</h3>
                                    <p className="mt-1 text-xs text-stone-500">{t("drama.customAssets.description")}</p>
                                </div>
                                <Button icon={<Upload className="size-4" />} loading={uploadingAssets} onClick={() => assetInputRef.current?.click()}>{t("drama.customAssets.upload")}</Button>
                                <input ref={assetInputRef} type="file" multiple className="hidden" onChange={(event) => void handleAssetUpload(event)} />
                            </div>
                            {(assetsByDrama[activeFolder.id] || []).length ? (
                                <div className="mt-4 grid gap-2 sm:grid-cols-2">
                                    {(assetsByDrama[activeFolder.id] || []).map((asset) => (
                                        <div key={asset.id} className="flex min-w-0 items-center gap-3 rounded-xl border border-stone-200 px-3 py-3 dark:border-stone-800">
                                            <div className="grid size-10 shrink-0 place-items-center rounded-lg bg-stone-100 text-stone-500 dark:bg-stone-900"><FileArchive className="size-5" /></div>
                                            <div className="min-w-0 flex-1"><div className="truncate text-sm font-medium" title={asset.data.fileName}>{asset.data.fileName || asset.title}</div><div className="mt-1 text-xs text-stone-400">{formatBytes(asset.data.bytes)} · {(asset.metadata?.extension || "file").replace(/^\./, "").toUpperCase()}</div></div>
                                            <a href={backendMediaUrl(asset.data.storageKey)} download={asset.data.fileName} className="grid size-8 shrink-0 place-items-center rounded-md text-stone-400 transition hover:bg-stone-100 hover:text-stone-900 dark:hover:bg-stone-900 dark:hover:text-stone-100" aria-label={t("drama.customAssets.download")}><Download className="size-4" /></a>
                                            <Button type="text" size="small" danger className="!px-1.5" onClick={() => removeDramaAsset(asset)} aria-label={t("drama.customAssets.delete")}><Trash2 className="size-4" /></Button>
                                        </div>
                                    ))}
                                </div>
                            ) : <div className="mt-4 rounded-xl border border-dashed border-stone-300 px-4 py-6 text-center text-sm text-stone-400 dark:border-stone-700">{t("drama.customAssets.empty")}</div>}
                        </section>
                    </div>
                )}
            </div>
            <Modal width={720} title={episodeDraft?.id ? t("drama.editEpisode") : t("drama.newEpisode")} open={episodeEditorOpen} onCancel={() => { if (!episodeSaving) { setEpisodeEditorOpen(false); setEpisodeDraft(null); } }} onOk={() => void saveEpisode()} okText={t("drama.saveEpisode")} cancelText={t("common.cancel")} confirmLoading={episodeSaving}>
                {episodeDraft ? <div className="max-h-[70vh] space-y-5 overflow-y-auto pr-1">
                    <div className="grid gap-5 sm:grid-cols-[140px_minmax(0,1fr)]">
                        <label className="block"><span className="mb-1.5 block text-sm font-medium">{t("drama.episodeNumber")}</span><Input type="number" min={1} value={episodeDraft.episodeNumber} onChange={(event) => setEpisodeDraft({ ...episodeDraft, episodeNumber: Number(event.target.value) || 1 })} /></label>
                        <label className="block"><span className="mb-1.5 block text-sm font-medium">{t("drama.episodeTitle")}</span><Input value={episodeDraft.title} onChange={(event) => setEpisodeDraft({ ...episodeDraft, title: event.target.value })} placeholder={t("drama.episodeTitlePlaceholder")} /></label>
                    </div>
                    <label className="block"><span className="mb-1.5 block text-sm font-medium">{t("drama.episodeSynopsis")}</span><Input.TextArea rows={4} value={episodeDraft.synopsis} onChange={(event) => setEpisodeDraft({ ...episodeDraft, synopsis: event.target.value })} placeholder={t("drama.episodeSynopsisPlaceholder")} /></label>
                    <label className="block"><span className="mb-1.5 block text-sm font-medium">{t("drama.episodeFullPlot")}</span><Input.TextArea autoSize={{ minRows: 8, maxRows: 18 }} value={episodeDraft.fullPlot} onChange={(event) => setEpisodeDraft({ ...episodeDraft, fullPlot: event.target.value })} placeholder={t("drama.episodeFullPlotPlaceholder")} /></label>
                    <div className="rounded-lg border border-stone-200 px-3 py-3 text-sm text-stone-500 dark:border-stone-800 dark:text-stone-400">{episodeDraft.canvasId ? t("drama.legacyEpisodeCanvasBound", { name: projects.find(project => project.id === episodeDraft.canvasId)?.title || episodeDraft.canvasId }) : t("drama.sceneCanvasWorkflowHint")}</div>
                </div> : null}
            </Modal>
            <Modal title={t("productionCanvas.dramaPlanning")} open={editorOpen} onCancel={() => { if (!savingPlan) setEditorOpen(false); }} onOk={() => void saveFolder()} okText={t("productionCanvas.confirmPlan")} cancelText={t("common.cancel")} confirmLoading={uploadingCover || savingPlan} width={760} styles={{ body: { maxHeight: "70dvh", overflow: "auto" } }} footer={(originNode) => <div className="flex w-full flex-wrap items-center justify-between gap-2"><Button danger type="text" disabled={savingPlan} icon={<Trash2 className="size-4" />} onClick={deleteDrama}>{t("drama.deleteProject")}</Button><div className="flex flex-wrap gap-2"><Button disabled={uploadingCover || savingPlan} onClick={() => void saveFolder(false)}>{t("sceneProduction.saveDraft")}</Button>{originNode}</div></div>}>
                {draft ? (
                    <div className="space-y-5">
                        <div className="grid gap-5 sm:grid-cols-[180px_minmax(0,1fr)]">
                            <button type="button" className="group relative min-h-40 overflow-hidden rounded-xl border border-dashed border-stone-300 bg-stone-100 text-left dark:border-stone-700 dark:bg-stone-900" onClick={() => coverInputRef.current?.click()}>
                                {draft.coverUrl ? <img src={draft.coverUrl} alt={draft.name} className="h-full min-h-40 w-full object-cover" /> : <div className="grid min-h-40 place-items-center text-center text-xs text-stone-400"><span><ImagePlus className="mx-auto mb-2 size-6" />{t("drama.uploadCover")}</span></div>}
                                <span className="absolute inset-x-0 bottom-0 bg-black/55 px-3 py-2 text-center text-xs text-white opacity-0 transition group-hover:opacity-100">{t("drama.changeCover")}</span>
                            </button>
                            <div className="space-y-4">
                                <label className="block"><span className="mb-1.5 block text-sm font-medium">{t("drama.projectName")}</span><Input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
                                <label className="block"><span className="mb-1.5 block text-sm font-medium">{t("drama.tags")}</span><Input placeholder={t("drama.tagsPlaceholder")} value={draft.tags} onChange={(event) => setDraft({ ...draft, tags: event.target.value })} /></label>
                            </div>
                        </div>
                        <label className="block"><span className="mb-1.5 block text-sm font-medium">{t("drama.outline")}</span><Input.TextArea rows={7} placeholder={t("drama.outlinePlaceholder")} value={draft.outline} onChange={(event) => setDraft({ ...draft, outline: event.target.value })} /></label>
                        <label className="block"><span className="mb-1.5 block text-sm font-medium">{t("productionCanvas.planRequirements")}</span><Input.TextArea rows={3} value={draft.productionPlan.requirements} onChange={event => setDraft({ ...draft, productionPlan: { ...draft.productionPlan, requirements: event.target.value } })} /></label>
                        <p className="text-xs text-muted-foreground">{t("productionCanvas.newEpisodeDefaults")}</p>
                        <div className="grid gap-4 sm:grid-cols-2">
                            <label><p className="mb-2 text-sm">{t("productionCanvas.storyboardImageMode")}</p><Select className="w-full" placeholder={t("productionCanvas.storyboardImageRequired")} value={draft.productionPlan.storyboardImageMode} onChange={storyboardImageMode => setDraft({ ...draft, productionPlan: { ...draft.productionPlan, storyboardImageMode } })} options={[{ value: "generate", label: t("productionCanvas.storyboardImagesGenerate") }, { value: "skip", label: t("productionCanvas.storyboardImagesSkip") }]} /><p className="mt-2 text-xs text-muted-foreground">{t("productionCanvas.storyboardImageModeHint")}</p></label>
                            <SceneProductionSettings value={draft.productionPlan} onChange={patch => setDraft({ ...draft, productionPlan: { ...draft.productionPlan, ...patch } })} />
                            <p className="text-xs text-muted-foreground">{t("sceneProduction.draftHint")}</p>
                            <div><p className="mb-2 text-sm">{t("productionCanvas.generalImageModel")}</p><ModelPicker config={modelConfig} capability="image" fullWidth value={draft.productionPlan.imageModel} onChange={imageModel => setDraft({ ...draft, productionPlan: { ...draft.productionPlan, imageModel } })} /></div>
                            {(["character", "scene", "prop", "style", "keyframe"] as const).map(kind => <div key={kind}><p className="mb-2 text-sm">{t(`productionCanvas.assetModel.${kind}`)}</p><ModelPicker config={modelConfig} capability="image" fullWidth placeholder={t("productionCanvas.inheritImageModel")} value={draft.productionPlan.imageModelsByKind[kind]} onChange={model => setDraft({ ...draft, productionPlan: { ...draft.productionPlan, imageModelsByKind: { ...draft.productionPlan.imageModelsByKind, [kind]: model } } })} /><Button type="text" size="small" disabled={!draft.productionPlan.imageModelsByKind[kind]} onClick={() => setDraft({ ...draft, productionPlan: { ...draft.productionPlan, imageModelsByKind: { ...draft.productionPlan.imageModelsByKind, [kind]: undefined } } })}>{t("productionCanvas.inheritImageModel")}</Button></div>)}
                            <div><p className="mb-2 text-sm">{t("productionCanvas.videoModel")}</p><ModelPicker config={modelConfig} capability="video" fullWidth value={draft.productionPlan.h3Model} onChange={h3Model => setDraft({ ...draft, productionPlan: { ...draft.productionPlan, h3Model } })} /></div>
                            <label><p className="mb-2 text-sm">{t("director.workspace.videoAspectRatio")}</p><Select className="w-full" allowClear value={draft.productionPlan.videoAspectRatio || undefined} onChange={videoAspectRatio => setDraft({ ...draft, productionPlan: { ...draft.productionPlan, videoAspectRatio: videoAspectRatio || null } })} options={["9:16", "16:9", "1:1", "4:3", "3:4", "2:3", "3:2", "21:9"].map(value => ({ value, label: value }))} /></label>
                        </div>
                        <label className="block"><span className="mb-1.5 block text-sm font-medium">{t("drama.description")}</span><Input.TextArea rows={3} placeholder={t("drama.descriptionPlaceholder")} value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} /></label>
                        <input ref={coverInputRef} type="file" accept="image/*" className="hidden" onChange={(event) => void handleCoverChange(event)} />
                    </div>
                ) : null}
            </Modal>
        </main>
    );
}

function formatBytes(bytes: number) {
    if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
    const units = ["B", "KB", "MB", "GB"];
    const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    return `${(bytes / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
}

function DramaCard({ folder, episodes, transitioning, onOpen, t }: { folder: CanvasFolder; episodes: DramaEpisode[]; transitioning: boolean; onOpen: () => void; t: TFunction }) {
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
        <div className="relative aspect-[16/9] overflow-hidden bg-muted/30" style={transitioning ? { viewTransitionName: "drama-cover" } : undefined}>
            {coverUrl ? <img src={coverUrl} alt={folder.name} className="h-full w-full object-cover" /> : <div className="grid h-full place-items-center text-orange-500"><Clapperboard className="size-10 stroke-[1.2]" /></div>}

            <span className="absolute bottom-3 left-4 rounded bg-background/90 px-2 py-1 text-xs font-medium text-foreground">{t("drama.episodeCount", { count: episodes.length })}</span>
        </div>
        <div className="p-5">
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                    <h3 className="truncate text-xl font-semibold tracking-tight" style={transitioning ? { viewTransitionName: "drama-title" } : undefined}>{folder.name}</h3>
                    <p className="mt-2 line-clamp-2 min-h-10 text-sm leading-5 text-stone-500 dark:text-stone-400" style={transitioning ? { viewTransitionName: "drama-summary" } : undefined}>{folder.description || folder.outline || t("drama.outlineEmpty")}</p>
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

function EpisodeCard({ episode, project, index, onOpen, onProduce, onEdit, onDelete, t }: { episode: DramaEpisode; project?: CanvasProject; index: number; onOpen: (project: CanvasProject) => void; onProduce: () => void; onEdit: () => void; onDelete: () => void; t: TFunction }) {
    const canOpen = Boolean(project);
    return <article className={cn("group relative flex min-h-48 flex-col justify-between overflow-hidden rounded-2xl border border-stone-200 bg-background p-5 text-left transition dark:border-stone-800", canOpen ? "hover:-translate-y-0.5 hover:border-orange-300 hover:shadow-lg hover:shadow-orange-950/5 dark:hover:border-orange-900" : "opacity-70")}>
        <div className="absolute right-0 top-0 h-24 w-24 translate-x-8 -translate-y-8 rounded-full border border-orange-200/70 transition group-hover:scale-125 dark:border-orange-950/60" />
        <div className="relative flex items-start justify-between gap-3">
            <button type="button" className="text-left text-xs font-medium text-orange-600 dark:text-orange-400" onClick={onProduce}>{t("drama.episodeLabel", { number: episode.episodeNumber })}</button>
            <div className="flex flex-wrap items-center gap-1">
                <Button size="small" onClick={onProduce}>{t("drama.editEpisodeDirector")}</Button>
                <Button type="text" size="small" className="!px-1.5 !text-stone-400 hover:!text-stone-900 dark:hover:!text-stone-100" onClick={onEdit} aria-label={t("drama.editEpisode")}><PencilLine className="size-4" /></Button>
                <Button type="text" size="small" danger className="!px-1.5" onClick={onDelete} aria-label={t("drama.deleteEpisodeTitle")}><Trash2 className="size-4" /></Button>
            </div>
        </div>
        <button type="button" className="relative mt-6 min-w-0 text-left" onClick={onProduce}>
            <h3 className="truncate text-lg font-semibold">{episode.title || t("drama.episodeLabel", { number: episode.episodeNumber })}</h3>
            <p className="mt-2 line-clamp-3 whitespace-pre-line text-sm leading-6 text-stone-500 dark:text-stone-400">{episode.synopsis || t("drama.noEpisodeSynopsis")}</p>
        </button>
        <div className="relative mt-5 flex items-center justify-between gap-3 text-xs text-stone-400">
            <span className="truncate">{project?.title || t("drama.sceneCanvasPerEpisode")}</span>
            <span className="shrink-0">{project ? `${project.summary?.nodeCount ?? project.nodes.length} ${t("drama.nodes")}` : ""}</span>
        </div>
    </article>;
}
