import { useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from "react";
import { App, Button, Input, Modal, Select, Tag } from "antd";
import { ArrowUpRight, Clapperboard, Folder, ImagePlus, Inbox, LayoutDashboard, PencilLine, Plus, Trash2 } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";

import { cn } from "@/lib/utils";
import { fetchBackendDramaEpisodes, createBackendDramaEpisode, deleteBackendDramaEpisode, updateBackendDramaEpisode, type DramaEpisode } from "@/services/backend-api";
import { resolveImageUrl, uploadImage } from "@/services/image-storage";
import { useCanvasStore, type CanvasProject } from "@/stores/canvas/use-canvas-store";

const ALL_SCENES = "__all-scenes__";
const UNFILED_SCENES = "__unfiled-scenes__";

type DramaDraft = {
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
    canvasId: string | null;
};

export default function DramaPage() {
    const { message, modal } = App.useApp();
    const { t } = useTranslation();
    const navigate = useNavigate();
    const hydrated = useCanvasStore((state) => state.hydrated);
    const projects = useCanvasStore((state) => state.projects);
    const folders = useCanvasStore((state) => state.folders);
    const createFolder = useCanvasStore((state) => state.createFolder);
    const updateFolder = useCanvasStore((state) => state.updateFolder);
    const deleteFolder = useCanvasStore((state) => state.deleteFolder);
    const [activeView, setActiveView] = useState(ALL_SCENES);
    const [editorOpen, setEditorOpen] = useState(false);
    const [draft, setDraft] = useState<DramaDraft | null>(null);
    const [activeCoverUrl, setActiveCoverUrl] = useState("");
    const [uploadingCover, setUploadingCover] = useState(false);
    const [episodesByDrama, setEpisodesByDrama] = useState<Record<string, DramaEpisode[]>>({});
    const [episodeEditorOpen, setEpisodeEditorOpen] = useState(false);
    const [episodeDraft, setEpisodeDraft] = useState<EpisodeDraft | null>(null);
    const [episodeSaving, setEpisodeSaving] = useState(false);
    const coverInputRef = useRef<HTMLInputElement>(null);

    const activeFolder = folders.find((folder) => folder.id === activeView);
    useEffect(() => {
        if (activeView !== ALL_SCENES && activeView !== UNFILED_SCENES && !activeFolder) setActiveView(ALL_SCENES);
    }, [activeFolder, activeView]);
    useEffect(() => {
        let disposed = false;
        setActiveCoverUrl("");
        if (!activeFolder?.coverStorageKey) return;
        void resolveImageUrl(activeFolder.coverStorageKey).then((url) => { if (!disposed) setActiveCoverUrl(url); });
        return () => { disposed = true; };
    }, [activeFolder?.coverStorageKey]);
    useEffect(() => {
        if (!hydrated || !folders.length) {
            setEpisodesByDrama({});
            return;
        }
        let disposed = false;
        void Promise.all(folders.map(async (folder) => {
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
    }, [folders, hydrated]);
    const allEpisodes = useMemo(() => Object.values(episodesByDrama).flat().sort((a, b) => a.episodeNumber - b.episodeNumber), [episodesByDrama]);
    const boundCanvasIds = useMemo(() => new Set(allEpisodes.flatMap((episode) => episode.canvasId ? [episode.canvasId] : [])), [allEpisodes]);
    const visibleProjects = useMemo(() => {
        const sorted = [...projects].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
        return activeView === UNFILED_SCENES ? sorted.filter((project) => !boundCanvasIds.has(project.id)) : sorted;
    }, [activeView, boundCanvasIds, projects]);
    const visibleEpisodes = activeFolder ? (episodesByDrama[activeFolder.id] || []) : [];
    const contentProjects = allEpisodes.filter((episode) => episode.canvasId).length;
    const unfiledCount = projects.filter((project) => !boundCanvasIds.has(project.id)).length;

    const createDrama = () => {
        const name = window.prompt(t("drama.createProjectPrompt"), t("drama.defaultProjectName"));
        if (name?.trim()) setActiveView(createFolder(name.trim()));
    };
    const openEpisodeEditor = (episode?: DramaEpisode) => {
        if (!activeFolder) return;
        const current = episodesByDrama[activeFolder.id] || [];
        setEpisodeDraft(episode ? {
            id: episode.id,
            episodeNumber: episode.episodeNumber,
            title: episode.title,
            synopsis: episode.synopsis,
            canvasId: episode.canvasId,
        } : {
            episodeNumber: Math.max(0, ...current.map((item) => item.episodeNumber)) + 1,
            title: `第 ${Math.max(0, ...current.map((item) => item.episodeNumber)) + 1} 集`,
            synopsis: "",
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
            const result = episodeDraft.id
                ? await updateBackendDramaEpisode(episodeDraft.id, { episodeNumber, title, synopsis: episodeDraft.synopsis, canvasId: episodeDraft.canvasId })
                : await createBackendDramaEpisode(activeFolder.id, { episodeNumber, title, synopsis: episodeDraft.synopsis, canvasId: episodeDraft.canvasId });
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
            name: activeFolder.name,
            outline: activeFolder.outline || "",
            description: activeFolder.description || "",
            tags: (activeFolder.tags || []).join(", "),
            coverStorageKey: activeFolder.coverStorageKey || null,
            coverUrl: activeCoverUrl,
        });
        setEditorOpen(true);
    };
    const saveFolder = () => {
        if (!activeFolder || !draft) return;
        updateFolder(activeFolder.id, {
            name: draft.name.trim() || activeFolder.name,
            outline: draft.outline.trim(),
            description: draft.description.trim(),
            tags: draft.tags.split(",").map((tag) => tag.trim()).filter(Boolean),
            coverStorageKey: draft.coverStorageKey,
        });
        setEditorOpen(false);
        message.success(t("drama.saved"));
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
                deleteFolder(folder.id);
                setEditorOpen(false);
                setDraft(null);
                setActiveView(ALL_SCENES);
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
    const openProject = (project: CanvasProject) => navigate(`/canvas/${project.id}`);
    const viewTitle = activeFolder?.name || (activeView === UNFILED_SCENES ? t("drama.unfiled") : t("drama.allScenes"));

    return (
        <main className="h-full overflow-y-auto bg-background text-stone-950 dark:text-stone-100">
            <div className="mx-auto max-w-7xl px-6 py-10 lg:px-10">
                <header className="relative overflow-hidden border-b border-stone-200 pb-10 dark:border-stone-800">
                    <div className="pointer-events-none absolute -right-16 -top-24 size-72 rounded-full border border-orange-200/70 dark:border-orange-950/60" />
                    <div className="pointer-events-none absolute right-12 top-8 size-3 rounded-full bg-orange-400" />
                    <div className="relative flex flex-wrap items-end justify-between gap-6">
                        <div className="max-w-2xl">
                            <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.22em] text-orange-600 dark:text-orange-400">
                                <Clapperboard className="size-4" />
                                {t("drama.eyebrow")}
                            </div>
                            <h1 className="mt-4 text-4xl font-semibold tracking-tight sm:text-5xl">{t("drama.title")}</h1>
                            <p className="mt-4 max-w-xl text-base leading-7 text-stone-500 dark:text-stone-400">{t("drama.intro")}</p>
                        </div>
                        <div className="flex flex-wrap gap-2">
                            <Button onClick={() => navigate("/canvas")} icon={<LayoutDashboard className="size-4" />}>{t("drama.openCanvasLibrary")}</Button>
                            <Button type="primary" onClick={createDrama} icon={<Plus className="size-4" />}>{t("drama.createProject")}</Button>
                        </div>
                    </div>
                </header>

                <section className="grid gap-px overflow-hidden border-x border-b border-stone-200 bg-stone-200 sm:grid-cols-3 dark:border-stone-800 dark:bg-stone-800">
                    <Stat label={t("drama.stats.dramas")} value={folders.length} detail={t("drama.folderHint")} />
                    <Stat label={t("drama.stats.scenes")} value={allEpisodes.length} detail={t("drama.scenes")} />
                    <Stat label={t("drama.stats.drafted")} value={contentProjects} detail={t("drama.scenes")} />
                </section>

                <div className="mt-10 grid gap-10 lg:grid-cols-[240px_minmax(0,1fr)]">
                    <aside>
                        <div className="mb-3 px-2 text-xs font-medium uppercase tracking-[0.16em] text-stone-400">{t("drama.overview")}</div>
                        <nav className="space-y-1">
                            <NavItem active={activeView === ALL_SCENES} icon={<LayoutDashboard className="size-4" />} label={t("drama.allScenes")} count={projects.length} onClick={() => setActiveView(ALL_SCENES)} />
                            <NavItem active={activeView === UNFILED_SCENES} icon={<Inbox className="size-4" />} label={t("drama.unfiled")} count={unfiledCount} onClick={() => setActiveView(UNFILED_SCENES)} />
                        </nav>
                        <div className="mb-3 mt-8 flex items-center justify-between px-2 text-xs font-medium uppercase tracking-[0.16em] text-stone-400">
                            <span>{t("drama.projects")}</span>
                            <button type="button" className="rounded p-1 text-stone-400 transition hover:bg-stone-100 hover:text-stone-900 dark:hover:bg-stone-900 dark:hover:text-stone-100" onClick={createDrama} aria-label={t("drama.createProject")}><Plus className="size-4" /></button>
                        </div>
                        <nav className="space-y-1">
                            {folders.map((folder) => (
                                <NavItem key={folder.id} active={activeView === folder.id} icon={<Folder className="size-4" />} label={folder.name} count={(episodesByDrama[folder.id] || []).length} onClick={() => setActiveView(folder.id)} />
                            ))}
                        </nav>
                        {!folders.length ? <p className="mt-4 px-2 text-xs leading-5 text-stone-400">{t("drama.folderHint")}</p> : null}
                    </aside>

                    <section className="min-w-0">
                        {activeFolder ? (
                            <div className="mb-8 grid overflow-hidden rounded-2xl border border-stone-200 bg-stone-100/70 dark:border-stone-800 dark:bg-stone-900/60 md:grid-cols-[180px_minmax(0,1fr)_auto]">
                                <div className="relative min-h-40 overflow-hidden bg-stone-200 dark:bg-stone-800">
                                    {activeCoverUrl ? <img src={activeCoverUrl} alt={activeFolder.name} className="h-full w-full object-cover" /> : <div className="grid h-full min-h-40 place-items-center text-orange-500"><Clapperboard className="size-10 stroke-[1.2]" /></div>}
                                </div>
                                <div className="min-w-0 p-6">
                                    <p className="text-xs font-medium uppercase tracking-[0.16em] text-orange-600 dark:text-orange-400">{t("drama.projectProfile")}</p>
                                    <h2 className="mt-2 truncate text-2xl font-semibold tracking-tight">{activeFolder.name}</h2>
                                    {activeFolder.description ? <p className="mt-2 truncate text-sm font-medium text-stone-600 dark:text-stone-300">{activeFolder.description}</p> : null}
                                    <p className="mt-3 line-clamp-3 whitespace-pre-line text-sm leading-6 text-stone-500 dark:text-stone-400">{activeFolder.outline || t("drama.outlineEmpty")}</p>
                                    <div className="mt-4 flex flex-wrap gap-1.5">{(activeFolder.tags || []).map((tag) => <Tag key={tag} className="m-0 border-stone-300 bg-transparent text-xs text-stone-500 dark:border-stone-700 dark:text-stone-400">{tag}</Tag>)}</div>
                                </div>
                                <div className="flex items-start p-5 md:justify-end"><Button icon={<PencilLine className="size-4" />} onClick={openFolderEditor}>{t("drama.editProject")}</Button></div>
                            </div>
                        ) : null}
                        <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
                            <div>
                                <p className="text-xs font-medium uppercase tracking-[0.16em] text-orange-600 dark:text-orange-400">{t("drama.scenes")}</p>
                                <h2 className="mt-2 text-2xl font-semibold tracking-tight">{viewTitle}</h2>
                            </div>
                            <div className="flex items-center gap-3">
                                <span className="text-sm text-stone-400">{activeFolder ? visibleEpisodes.length : visibleProjects.length} / {activeFolder ? allEpisodes.length : projects.length}</span>
                                {activeFolder ? <Button type="primary" size="small" icon={<Plus className="size-4" />} onClick={() => openEpisodeEditor()}>{t("drama.newEpisode")}</Button> : null}
                            </div>
                        </div>

                        {!hydrated ? (
                            <div className="flex min-h-72 items-center justify-center border-y border-stone-200 text-sm text-stone-500 dark:border-stone-800">{t("canvas.loading")}</div>
                        ) : (activeFolder ? visibleEpisodes.length > 0 : visibleProjects.length > 0) ? (
                            <div className="grid gap-4 sm:grid-cols-2">
                                {activeFolder
                                    ? visibleEpisodes.map((episode, index) => <EpisodeCard key={episode.id} episode={episode} project={episode.canvasId ? projects.find((item) => item.id === episode.canvasId) : undefined} index={index} onOpen={openProject} onEdit={() => openEpisodeEditor(episode)} onDelete={() => removeEpisode(episode)} t={t} />)
                                    : visibleProjects.map((project, index) => <SceneCard key={project.id} project={project} index={index} folderName={t("drama.unfiled")} onOpen={() => openProject(project)} t={t} />)}
                            </div>
                        ) : (
                            <div className="flex min-h-72 flex-col items-center justify-center border-y border-stone-200 px-6 text-center dark:border-stone-800">
                                <div className="grid size-12 place-items-center rounded-full bg-orange-100 text-orange-600 dark:bg-orange-950/40 dark:text-orange-300"><Clapperboard className="size-5" /></div>
                                <h3 className="mt-5 text-lg font-medium">{activeFolder ? t("drama.emptyFolderTitle") : t("drama.emptyTitle")}</h3>
                                <p className="mt-2 max-w-md text-sm leading-6 text-stone-500 dark:text-stone-400">{activeFolder ? t("drama.emptyFolderDescription") : t("drama.emptyDescription")}</p>
                                <Button className="mt-5" onClick={() => navigate("/canvas")} icon={<ArrowUpRight className="size-4" />}>{t("drama.openCanvasLibrary")}</Button>
                            </div>
                        )}
                    </section>
                </div>
            </div>
            <Modal title={episodeDraft?.id ? t("drama.editEpisode") : t("drama.newEpisode")} open={episodeEditorOpen} onCancel={() => { if (!episodeSaving) { setEpisodeEditorOpen(false); setEpisodeDraft(null); } }} onOk={() => void saveEpisode()} okText={t("drama.saveEpisode")} cancelText={t("common.cancel")} confirmLoading={episodeSaving}>
                {episodeDraft ? <div className="space-y-5">
                    <div className="grid gap-5 sm:grid-cols-[140px_minmax(0,1fr)]">
                        <label className="block"><span className="mb-1.5 block text-sm font-medium">{t("drama.episodeNumber")}</span><Input type="number" min={1} value={episodeDraft.episodeNumber} onChange={(event) => setEpisodeDraft({ ...episodeDraft, episodeNumber: Number(event.target.value) || 1 })} /></label>
                        <label className="block"><span className="mb-1.5 block text-sm font-medium">{t("drama.episodeTitle")}</span><Input value={episodeDraft.title} onChange={(event) => setEpisodeDraft({ ...episodeDraft, title: event.target.value })} placeholder={t("drama.episodeTitlePlaceholder")} /></label>
                    </div>
                    <label className="block"><span className="mb-1.5 block text-sm font-medium">{t("drama.episodeSynopsis")}</span><Input.TextArea rows={8} value={episodeDraft.synopsis} onChange={(event) => setEpisodeDraft({ ...episodeDraft, synopsis: event.target.value })} placeholder={t("drama.episodeSynopsisPlaceholder")} /></label>
                    <label className="block"><span className="mb-1.5 block text-sm font-medium">{t("drama.bindCanvas")}</span><Select allowClear className="w-full" placeholder={t("drama.unboundCanvas")} value={episodeDraft.canvasId || undefined} onChange={(value) => setEpisodeDraft({ ...episodeDraft, canvasId: value || null })} options={projects.map((project) => ({ label: project.title, value: project.id }))} showSearch optionFilterProp="label" /></label>
                </div> : null}
            </Modal>
            <Modal title={t("drama.editProject")} open={editorOpen} onCancel={() => setEditorOpen(false)} onOk={saveFolder} okText={t("drama.saveProject")} cancelText={t("common.cancel")} confirmLoading={uploadingCover} width={680} footer={(originNode) => <div className="flex w-full items-center justify-between"><Button danger type="text" icon={<Trash2 className="size-4" />} onClick={deleteDrama}>{t("drama.deleteProject")}</Button><div className="flex gap-2">{originNode}</div></div>}>
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
                        <label className="block"><span className="mb-1.5 block text-sm font-medium">{t("drama.description")}</span><Input.TextArea rows={3} placeholder={t("drama.descriptionPlaceholder")} value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} /></label>
                        <input ref={coverInputRef} type="file" accept="image/*" className="hidden" onChange={(event) => void handleCoverChange(event)} />
                    </div>
                ) : null}
            </Modal>
        </main>
    );
}

function Stat({ label, value, detail }: { label: string; value: number; detail: string }) {
    return <div className="bg-background px-5 py-5"><div className="text-xs uppercase tracking-[0.14em] text-stone-400">{label}</div><div className="mt-2 text-3xl font-semibold tracking-tight">{value}</div><div className="mt-2 truncate text-xs text-stone-500">{detail}</div></div>;
}

function NavItem({ active, icon, label, count, onClick }: { active: boolean; icon: ReactNode; label: string; count: number; onClick: () => void }) {
    return <button type="button" className={cn("flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-left text-sm transition", active ? "bg-stone-950 font-medium text-white dark:bg-stone-100 dark:text-stone-950" : "text-stone-600 hover:bg-stone-100 hover:text-stone-950 dark:text-stone-400 dark:hover:bg-stone-900 dark:hover:text-stone-100")} onClick={onClick}>{icon}<span className="min-w-0 flex-1 truncate">{label}</span><span className={cn("text-xs", active ? "text-white/60 dark:text-stone-500" : "text-stone-400")}>{count}</span></button>;
}

function SceneCard({ project, index, folderName, onOpen, t }: { project: CanvasProject; index: number; folderName?: string; onOpen: () => void; t: TFunction }) {
    return <button type="button" className="group relative flex min-h-44 flex-col justify-between overflow-hidden rounded-2xl border border-stone-200 bg-background p-5 text-left transition hover:-translate-y-0.5 hover:border-orange-300 hover:shadow-lg hover:shadow-orange-950/5 dark:border-stone-800 dark:hover:border-orange-900" onClick={onOpen}>
        <div className="absolute right-0 top-0 h-24 w-24 translate-x-8 -translate-y-8 rounded-full border border-orange-200/70 transition group-hover:scale-125 dark:border-orange-950/60" />
        <div className="relative flex items-start justify-between gap-3">
            <span className="text-xs font-medium uppercase tracking-[0.14em] text-orange-600 dark:text-orange-400">{t("drama.scene")} {String(index + 1).padStart(2, "0")}</span>
            <ArrowUpRight className="size-4 text-stone-400 transition group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:text-orange-500" />
        </div>
        <div className="relative mt-8">
            <h3 className="truncate text-lg font-semibold">{project.title}</h3>
            <p className="mt-2 text-xs text-stone-500">{(project.summary?.nodeCount ?? project.nodes.length)} {t("drama.nodes")} · {(project.summary?.connectionCount ?? project.connections.length)} {t("drama.connections")}</p>
        </div>
        <div className="relative mt-5 flex items-center justify-between gap-3 text-xs text-stone-400">
            <span className="truncate">{folderName || t("drama.unfiled")}</span>
            <span className="shrink-0">{t("drama.updated", { date: new Date(project.updatedAt).toLocaleDateString() })}</span>
        </div>
    </button>;
}

function EpisodeCard({ episode, project, index, onOpen, onEdit, onDelete, t }: { episode: DramaEpisode; project?: CanvasProject; index: number; onOpen: (project: CanvasProject) => void; onEdit: () => void; onDelete: () => void; t: TFunction }) {
    const canOpen = Boolean(project);
    return <article className={cn("group relative flex min-h-48 flex-col justify-between overflow-hidden rounded-2xl border border-stone-200 bg-background p-5 text-left transition dark:border-stone-800", canOpen ? "hover:-translate-y-0.5 hover:border-orange-300 hover:shadow-lg hover:shadow-orange-950/5 dark:hover:border-orange-900" : "opacity-70")}>
        <div className="absolute right-0 top-0 h-24 w-24 translate-x-8 -translate-y-8 rounded-full border border-orange-200/70 transition group-hover:scale-125 dark:border-orange-950/60" />
        <div className="relative flex items-start justify-between gap-3">
            <button type="button" className="text-left text-xs font-medium uppercase tracking-[0.14em] text-orange-600 dark:text-orange-400" onClick={() => { if (project) onOpen(project); }} disabled={!canOpen}>{t("drama.scene")} {String(index + 1).padStart(2, "0")} · {t("drama.episodeLabel", { number: episode.episodeNumber })}</button>
            <div className="flex items-center gap-1">
                <Button type="text" size="small" className="!px-1.5 !text-stone-400 hover:!text-stone-900 dark:hover:!text-stone-100" onClick={onEdit} aria-label={t("drama.editEpisode")}><PencilLine className="size-4" /></Button>
                <Button type="text" size="small" danger className="!px-1.5" onClick={onDelete} aria-label={t("drama.deleteEpisodeTitle")}><Trash2 className="size-4" /></Button>
            </div>
        </div>
        <button type="button" className="relative mt-6 min-w-0 text-left" onClick={() => { if (project) onOpen(project); }} disabled={!canOpen}>
            <h3 className="truncate text-lg font-semibold">{episode.title || t("drama.episodeLabel", { number: episode.episodeNumber })}</h3>
            <p className="mt-2 line-clamp-3 whitespace-pre-line text-sm leading-6 text-stone-500 dark:text-stone-400">{episode.synopsis || t("drama.noEpisodeSynopsis")}</p>
        </button>
        <div className="relative mt-5 flex items-center justify-between gap-3 text-xs text-stone-400">
            <span className="truncate">{project?.title || t("drama.unboundCanvas")}</span>
            <span className="shrink-0">{project ? `${project.summary?.nodeCount ?? project.nodes.length} ${t("drama.nodes")}` : ""}</span>
        </div>
    </article>;
}
