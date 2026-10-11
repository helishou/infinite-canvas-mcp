import { dramaWorkbenchPath } from "./workbench-entry";
import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { App, Button, Input, Modal, Select, Switch, Tag } from "antd";
import { ArrowUpRight, Clapperboard, Download, FileArchive, ImagePlus, Images, PencilLine, Plus, Trash2, Upload } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";

import { loadCanvasProjectPage } from "@/lib/canvas-project-loader";
import { cn } from "@/lib/utils";
import { backendMediaUrl, createBackendDramaEpisode, deleteBackendDramaAsset, deleteBackendDramaEpisode, fetchBackendDramaAssets, fetchBackendDramaEpisodes, updateBackendDramaEpisode, uploadBackendDramaAsset, ensureSharedAssetCanvas, ensureEpisodeCanvas, upsertBackendCanvasFolder, type DramaCustomAsset, type DramaEpisode } from "@/services/backend-api";
import { resolveImageUrl, uploadImage } from "@/services/image-storage";
import { useCanvasStore, type CanvasFolder, type CanvasProject } from "@/stores/canvas/use-canvas-store";
import { dramaProductionPlanSchema, type DramaProductionPlan } from "@basketikun/canvas-agent/drama/production-contract";
import { ModelPicker } from "@/components/model-picker";
import { useConfigStore } from "@/stores/use-config-store";

import { SceneProductionSettings } from "./scene-production-settings";

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
    withCanvas?: boolean;
};

/**
 * 剧目管理面板：剧目规划、共享资产画布、分集列表与自定义资产。
 * 既嵌在导演工作台的「剧目」页签里，也用于无分集剧目的工作台首屏。
 */
export function DramaManagePanel({ dramaId, onEpisodesChanged, onProduceEpisode }: {
    dramaId: string;
    onEpisodesChanged?: (episodes: DramaEpisode[]) => void;
    onProduceEpisode?: (episode: DramaEpisode) => void;
}) {
    const { message, modal } = App.useApp();
    const { t } = useTranslation();
    const navigate = useNavigate();
    const projects = useCanvasStore((state) => state.projects);
    const folders = useCanvasStore((state) => state.folders);
    const deleteDramaProject = useCanvasStore((state) => state.deleteDramaProject);
    const [episodes, setEpisodes] = useState<DramaEpisode[]>([]);
    const [openingSharedCanvas, setOpeningSharedCanvas] = useState(false);
    const [editorOpen, setEditorOpen] = useState(false);
    const [draft, setDraft] = useState<DramaDraft | null>(null);
    const [activeCoverUrl, setActiveCoverUrl] = useState("");
    const [uploadingCover, setUploadingCover] = useState(false);
    const [savingPlan, setSavingPlan] = useState(false);
    const modelConfig = useConfigStore(state => state.config);
    const [episodeEditorOpen, setEpisodeEditorOpen] = useState(false);
    const [episodeDraft, setEpisodeDraft] = useState<EpisodeDraft | null>(null);
    const [episodeSaving, setEpisodeSaving] = useState(false);
    const [assets, setAssets] = useState<DramaCustomAsset[]>([]);
    const [uploadingAssets, setUploadingAssets] = useState(false);
    const coverInputRef = useRef<HTMLInputElement>(null);
    const assetInputRef = useRef<HTMLInputElement>(null);

    const folder = folders.find((item) => item.id === dramaId);

    useEffect(() => {
        let disposed = false;
        setEpisodes([]);
        void fetchBackendDramaEpisodes(dramaId)
            .then((result) => { if (!disposed) setEpisodes(result.episodes || []); })
            .catch((error) => { if (!disposed) message.error(error instanceof Error ? error.message : t("drama.episodeSaveFailed")); });
        return () => { disposed = true; };
    }, [dramaId, message, t]);
    useEffect(() => {
        let disposed = false;
        setActiveCoverUrl("");
        if (!folder?.coverStorageKey) return;
        void resolveImageUrl(folder.coverStorageKey).then((url) => { if (!disposed) setActiveCoverUrl(url); });
        return () => { disposed = true; };
    }, [folder?.coverStorageKey]);
    useEffect(() => {
        if (!folder) return;
        let disposed = false;
        void fetchBackendDramaAssets(folder.id)
            .then((result) => { if (!disposed) setAssets(result.assets || []); })
            .catch((error) => { if (!disposed) message.error(error instanceof Error ? error.message : t("drama.customAssets.loadFailed")); });
        return () => { disposed = true; };
    }, [folder?.id, message]);

    if (!folder) return <div className="py-12 text-center text-sm text-muted-foreground">{t("canvas.loading")}</div>;

    const produceEpisode = onProduceEpisode || ((episode: DramaEpisode) => navigate(dramaWorkbenchPath(dramaId, episode.id)));
    const replaceEpisodes = (next: DramaEpisode[]) => {
        setEpisodes(next);
        onEpisodesChanged?.(next);
    };
    const openEpisodeEditor = (episode?: DramaEpisode) => {
        setEpisodeDraft(episode ? {
            id: episode.id,
            episodeNumber: episode.episodeNumber,
            title: episode.title,
            synopsis: episode.synopsis,
            fullPlot: episode.fullPlot || "",
            canvasId: episode.canvasId,
            withCanvas: !episode.canvasId,
        } : {
            episodeNumber: Math.max(0, ...episodes.map((item) => item.episodeNumber)) + 1,
            title: `第 ${Math.max(0, ...episodes.map((item) => item.episodeNumber)) + 1} 集`,
            synopsis: "",
            fullPlot: "",
            canvasId: null,
            withCanvas: true,
        });
        setEpisodeEditorOpen(true);
    };
    const saveEpisode = async () => {
        if (!episodeDraft) return;
        const episodeNumber = Math.max(1, Math.trunc(episodeDraft.episodeNumber));
        const title = episodeDraft.title.trim() || `第 ${episodeNumber} 集`;
        const creating = !episodeDraft.id;
        try {
            setEpisodeSaving(true);
            let canvasId = episodeDraft.canvasId;
            const result = episodeDraft.id
                ? await updateBackendDramaEpisode(episodeDraft.id, { episodeNumber, title, synopsis: episodeDraft.synopsis, fullPlot: episodeDraft.fullPlot, canvasId })
                : await createBackendDramaEpisode(dramaId, { episodeNumber, title, synopsis: episodeDraft.synopsis, fullPlot: episodeDraft.fullPlot, canvasId });
            if (!result.episode) throw new Error("后端没有返回分集");
            if (creating && !result.episode.canvasId && episodeDraft.withCanvas) {
                await ensureEpisodeCanvas(result.episode.id);
                const updated = await fetchBackendDramaEpisodes(dramaId);
                const fresh = (updated.episodes || []).find(item => item.id === result.episode!.id);
                if (fresh) result.episode = fresh;
            }
            replaceEpisodes([...episodes.filter((item) => item.id !== result.episode!.id), result.episode!].sort((a, b) => a.episodeNumber - b.episodeNumber));
            setEpisodeEditorOpen(false);
            setEpisodeDraft(null);
            message.success(creating ? t("drama.episodeCreated") : t("drama.episodeSaved"));
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
                    replaceEpisodes(episodes.filter((item) => item.id !== episode.id));
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
        setDraft({
            productionPlan: dramaProductionPlanSchema.parse(folder.productionPlan || {}),
            expectedPlanningUpdatedAt: folder.updatedAt || folder.createdAt,
            name: folder.name,
            outline: folder.outline || "",
            description: folder.description || "",
            tags: (folder.tags || []).join(", "),
            coverStorageKey: folder.coverStorageKey || null,
            coverUrl: activeCoverUrl,
        });
        setEditorOpen(true);
    };
    const saveFolder = async (confirm = true) => {
        if (!draft) return;
        if (confirm && !draft.productionPlan.storyboardImageMode) {
            message.warning(t("productionCanvas.storyboardImageRequired"));
            return;
        }
        if (confirm && draft.productionPlan.parallelScenes && !draft.productionPlan.reviewPolicy) { message.warning(t("sceneProduction.reviewRequired")); return; }
        const patch = {
            name: draft.name.trim() || folder.name,
            outline: draft.outline.trim(),
            description: draft.description.trim(),
            tags: draft.tags.split(",").map((tag) => tag.trim()).filter(Boolean),
            coverStorageKey: draft.coverStorageKey,
            productionPlan: { ...draft.productionPlan, confirmedOutline: confirm ? draft.outline.trim() : "", confirmedAt: confirm ? new Date().toISOString() : undefined },
        };
        setSavingPlan(true);
        try {
            const result = await upsertBackendCanvasFolder({ ...folder, ...patch, expectedPlanningUpdatedAt: draft.expectedPlanningUpdatedAt, updatedAt: new Date().toISOString() });
            useCanvasStore.setState(state => ({ folders: state.folders.map(item => item.id === folder.id ? result.folder as unknown as CanvasFolder : item) }));
            setEditorOpen(false);
            message.success(t(confirm ? "drama.saved" : "sceneProduction.draftSaved"));
        } catch (error) { message.error(String(error)); }
        finally { setSavingPlan(false); }
    };
    const deleteDrama = () => {
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
                navigate("/production");
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
        if (!files.length) return;
        try {
            setUploadingAssets(true);
            const uploaded: DramaCustomAsset[] = [];
            for (const file of files) uploaded.push(await uploadBackendDramaAsset(dramaId, file));
            setAssets((current) => [...uploaded, ...current]);
            message.success(t("drama.customAssets.uploaded", { count: uploaded.length }));
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("drama.customAssets.uploadFailed"));
        } finally {
            setUploadingAssets(false);
        }
    };
    const removeDramaAsset = (asset: DramaCustomAsset) => {
        modal.confirm({
            title: t("drama.customAssets.deleteTitle"),
            content: t("drama.customAssets.deleteDescription", { name: asset.data.fileName || asset.title }),
            okType: "danger",
            okText: "删除",
            cancelText: t("common.cancel"),
            onOk: async () => {
                await deleteBackendDramaAsset(dramaId, asset.id);
                setAssets((current) => current.filter((item) => item.id !== asset.id));
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
        <div>
            <div className="mb-10 grid overflow-hidden rounded-2xl border border-stone-200 bg-stone-100/70 dark:border-stone-800 dark:bg-stone-900/60 md:grid-cols-[200px_minmax(0,1fr)_auto]">
                <div className="relative min-h-44 overflow-hidden rounded-2xl bg-stone-200 dark:bg-stone-800">
                    {activeCoverUrl ? <img src={activeCoverUrl} alt={folder.name} className="h-full w-full object-cover" /> : <div className="grid h-full min-h-44 place-items-center text-orange-500"><Clapperboard className="size-10 stroke-[1.2]" /></div>}
                </div>
                <div className="min-w-0 p-6">
                    <p className="text-xs font-medium uppercase tracking-[0.16em] text-orange-600 dark:text-orange-400">{t("drama.projectProfile")}</p>
                    <h2 className="mt-2 text-lg font-semibold tracking-tight">{t("productionCanvas.dramaPlanning")}</h2>
                    <p className="mt-2 text-xs text-muted-foreground">{t("productionCanvas.dramaPlanningHint")}</p>
                    <p className="mt-2 text-xs text-muted-foreground">{t(folder.productionPlan?.confirmedAt && folder.productionPlan.confirmedOutline === folder.outline ? "productionCanvas.planConfirmed" : "productionCanvas.planUnconfirmed")}</p>
                    <p className="mt-3 line-clamp-4 whitespace-pre-line text-sm leading-6 text-stone-500 dark:text-stone-400">{folder.outline || t("drama.outlineEmpty")}</p>
                    <div className="mt-4 flex flex-wrap gap-1.5">{(folder.tags || []).map((tag) => <Tag key={tag} className="m-0 border-stone-300 bg-transparent text-xs text-stone-500 dark:border-stone-700 dark:text-stone-400">{tag}</Tag>)}</div>
                </div>
                <div className="flex items-start p-5 md:justify-end"><Button icon={<PencilLine className="size-4" />} onClick={openFolderEditor}>{t("productionCanvas.dramaPlanning")}</Button></div>
            </div>

            <section data-drama-shared-canvas className="mb-10 flex flex-wrap items-center justify-between gap-4 rounded-xl border border-border bg-card p-5">
                <div className="flex min-w-0 items-start gap-3"><Images className="mt-1 size-5 shrink-0 text-muted-foreground" /><div><h2 className="text-base font-semibold">{t("productionCanvas.sharedCanvas")}</h2><p className="mt-1 text-sm text-muted-foreground">{t("productionCanvas.sharedCanvasDescription")}</p><p className="mt-2 text-xs text-muted-foreground">{t(folder.sharedAssetCanvasId ? "productionCanvas.sharedCanvasReady" : "productionCanvas.sharedCanvasEmpty")}</p></div></div>
                <Button loading={openingSharedCanvas} onClick={async () => {
                    if (openingSharedCanvas) return;
                    if (!folder.sharedAssetCanvasId && !(folder.productionPlan?.confirmedAt && folder.productionPlan.confirmedOutline === folder.outline)) { openFolderEditor(); return; }
                    setOpeningSharedCanvas(true);
                    try { const { project } = await ensureSharedAssetCanvas(folder.id); navigate(`/canvas/${encodeURIComponent(String(project.id))}`); }
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
                        <span className="text-sm text-stone-400">{episodes.length} {t("drama.episodeUnit")}</span>
                        <Button type="primary" onClick={() => openEpisodeEditor()} icon={<Plus className="size-4" />}>{t("drama.newEpisode")}</Button>
                    </div>
                </div>
                {episodes.length ? (
                    <div className="grid gap-4 sm:grid-cols-2">
                        {episodes.map((episode, index) => <EpisodeCard key={episode.id} episode={episode} project={episode.canvasId ? projects.find((item) => item.id === episode.canvasId) : undefined} index={index} onOpen={openProject} onProduce={() => produceEpisode(episode)} onEdit={() => openEpisodeEditor(episode)} onDelete={() => removeEpisode(episode)} t={t} />)}
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
                {assets.length ? (
                    <div className="mt-4 grid gap-2 sm:grid-cols-2">
                        {assets.map((asset) => (
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

            <Modal width={720} title={episodeDraft?.id ? t("drama.editEpisode") : t("drama.newEpisode")} open={episodeEditorOpen} onCancel={() => { if (!episodeSaving) { setEpisodeEditorOpen(false); setEpisodeDraft(null); } }} onOk={() => void saveEpisode()} okText={t("drama.saveEpisode")} cancelText={t("common.cancel")} confirmLoading={episodeSaving}>
                {episodeDraft ? <div className="max-h-[70vh] space-y-5 overflow-y-auto pr-1">
                    <div className="grid gap-5 sm:grid-cols-[140px_minmax(0,1fr)]">
                        <label className="block"><span className="mb-1.5 block text-sm font-medium">{t("drama.episodeNumber")}</span><Input type="number" min={1} value={episodeDraft.episodeNumber} onChange={(event) => setEpisodeDraft({ ...episodeDraft, episodeNumber: Number(event.target.value) || 1 })} /></label>
                        <label className="block"><span className="mb-1.5 block text-sm font-medium">{t("drama.episodeTitle")}</span><Input value={episodeDraft.title} onChange={(event) => setEpisodeDraft({ ...episodeDraft, title: event.target.value })} placeholder={t("drama.episodeTitlePlaceholder")} /></label>
                    </div>
                    <label className="block"><span className="mb-1.5 block text-sm font-medium">{t("drama.episodeSynopsis")}</span><Input.TextArea rows={4} value={episodeDraft.synopsis} onChange={(event) => setEpisodeDraft({ ...episodeDraft, synopsis: event.target.value })} placeholder={t("drama.episodeSynopsisPlaceholder")} /></label>
                    <label className="block"><span className="mb-1.5 block text-sm font-medium">{t("drama.episodeFullPlot")}</span><Input.TextArea autoSize={{ minRows: 8, maxRows: 18 }} value={episodeDraft.fullPlot} onChange={(event) => setEpisodeDraft({ ...episodeDraft, fullPlot: event.target.value })} placeholder={t("drama.episodeFullPlotPlaceholder")} /></label>
                    {!episodeDraft.id && <div className="flex items-center justify-between rounded-lg border border-stone-200 px-3 py-3 dark:border-stone-800"><span className="text-sm text-stone-500 dark:text-stone-400">{t("drama.withCanvas")}</span><Switch checked={Boolean(episodeDraft.withCanvas)} onChange={(value) => setEpisodeDraft({ ...episodeDraft, withCanvas: value })} /></div>}
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
        </div>
    );
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

function formatBytes(bytes: number) {
    if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
    const units = ["B", "KB", "MB", "GB"];
    const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    return `${(bytes / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
}
