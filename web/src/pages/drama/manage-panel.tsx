import { ProductionPageHeading } from "./production-page-heading";
import { dramaWorkbenchPath } from "./workbench-entry";
import { useWorkbenchCanvas } from "@/lib/canvas/canvas-host";
import { useProductionFollowStore } from "@/stores/use-production-follow-store";
import { productionWorkspaceQuery, type SeriesWorkspaceView } from "./production-workspace";
import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { App, Button, Input, Modal, Select, Switch, Tabs, Tag } from "antd";
import { ArrowUpRight, Clapperboard, Download, FileArchive, ImagePlus, Images, PencilLine, Plus, Trash2, Upload } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";

import { backendMediaUrl, createBackendDramaEpisode, deleteBackendDramaAsset, deleteBackendDramaEpisode, editEpisodeProduction, fetchBackendAssets, fetchBackendCanvasFolders, fetchBackendDramaAssets, fetchBackendDramaEpisodes, fetchBackendProject, fetchEpisodeProduction, updateBackendDramaEpisode, uploadBackendDramaAsset, ensureSharedAssetCanvas, ensureEpisodeCanvas, upsertBackendCanvasFolder, type DramaCustomAsset, type DramaEpisode, type EpisodeProduction } from "@/services/backend-api";
import { resolveImageUrl, uploadImage } from "@/services/image-storage";
import { MediaImage } from "@/components/media/media-image";
import { nanoid } from "nanoid";
import { productionCanvasNodes, type ProductionCanvasSnapshot } from "./production-canvas-nodes";
import { useCanvasStore, type CanvasFolder, type CanvasProject } from "@/stores/canvas/use-canvas-store";
import type { Asset } from "@/stores/use-asset-store";
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

function sharedAssetImageSource(asset: Asset) {
    const image = asset.kind === "character"
        ? asset.data.images[asset.data.primaryIndex || 0]
        : asset.kind === "scene" || asset.kind === "prop" ? asset.data.image : undefined;
    return image?.storageKey ? backendMediaUrl(image.storageKey) : image?.url || asset.coverUrl || "";
}

/**
 * 剧目管理面板：剧目规划、共享资产画布、分集列表与自定义资产。
 * 按全剧规划、分集与共享素材分区，也兼容旧入口的完整管理视图。
 */
export function DramaManagePanel({ dramaId, onEpisodesChanged, onProduceEpisode, view, initialPlanningTab, navigationTitleVisible = false }: {
    dramaId: string;
    view?: SeriesWorkspaceView;
    initialPlanningTab?: "info" | "settings";
    navigationTitleVisible?: boolean;
    onEpisodesChanged?: (episodes: DramaEpisode[]) => void;
    onProduceEpisode?: (episode: DramaEpisode) => void;
}) {
    const { message, modal } = App.useApp();
    const { t } = useTranslation();
    const navigate = useNavigate();
    const location = useLocation();
    const canvasHost = useWorkbenchCanvas();
    const projects = useCanvasStore((state) => state.projects);
    const folders = useCanvasStore((state) => state.folders);
    const deleteDramaProject = useCanvasStore((state) => state.deleteDramaProject);
    const [episodes, setEpisodes] = useState<DramaEpisode[]>([]);
    const [openingSharedCanvas, setOpeningSharedCanvas] = useState(false);
    const [draft, setDraft] = useState<DramaDraft | null>(null);
    const [planningTab, setPlanningTab] = useState<"info" | "settings">(initialPlanningTab || "info");
    const initializedDraftFor = useRef<string | null>(null);
    const [activeCoverUrl, setActiveCoverUrl] = useState("");
    const [uploadingCover, setUploadingCover] = useState(false);
    const [savingPlan, setSavingPlan] = useState(false);
    const modelConfig = useConfigStore(state => state.config);
    const [episodeEditorOpen, setEpisodeEditorOpen] = useState(false);
    const [episodeDraft, setEpisodeDraft] = useState<EpisodeDraft | null>(null);
    const [episodeSaving, setEpisodeSaving] = useState(false);
    const [assets, setAssets] = useState<DramaCustomAsset[]>([]);
    const [uploadingAssets, setUploadingAssets] = useState(false);
    const [sharedAssets, setSharedAssets] = useState<Asset[]>([]);
    const [sharedAssetsError, setSharedAssetsError] = useState(false);
    const [sharedAssetsReload, setSharedAssetsReload] = useState(0);
    const [sharedProduction, setSharedProduction] = useState<EpisodeProduction | null>(null);
    const [sharedCanvasSnapshot, setSharedCanvasSnapshot] = useState<ProductionCanvasSnapshot>();
    const [styleSaving, setStyleSaving] = useState(false);
    const [styleWaiverDraft, setStyleWaiverDraft] = useState("");
    const pendingStyleTransfer = useRef("");
    const coverInputRef = useRef<HTMLInputElement>(null);
    const assetInputRef = useRef<HTMLInputElement>(null);

    useEffect(() => { setPlanningTab(initialPlanningTab || "info"); }, [dramaId, initialPlanningTab]);

    const folder = folders.find((item) => item.id === dramaId);
    const sharedCanvasRevision = projects.find(project => project.id === folder?.sharedAssetCanvasId)?.revision;

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
    // 内联编辑取代弹窗：进入面板即建立草稿，切换剧目时重建，保存后不覆盖未提交修改。
    useEffect(() => {
        if (!folder || initializedDraftFor.current === dramaId) return;
        initializedDraftFor.current = dramaId;
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
    }, [folder, dramaId, activeCoverUrl]);
    useEffect(() => {
        if (!folder) return;
        let disposed = false;
        void fetchBackendDramaAssets(folder.id)
            .then((result) => { if (!disposed) setAssets(result.assets || []); })
            .catch((error) => { if (!disposed) message.error(error instanceof Error ? error.message : t("drama.customAssets.loadFailed")); });
        return () => { disposed = true; };
    }, [folder?.id, message]);
    useEffect(() => {
        const sharedCanvasId = folder?.sharedAssetCanvasId;
        let disposed = false;
        setSharedAssetsError(false);
        if (!sharedCanvasId) { setSharedAssets([]); return; }
        void fetchBackendAssets({ dramaId })
            .then((result) => {
                if (disposed) return;
                const assets = (result.assets || []) as Asset[];
                setSharedAssets(assets.filter(asset => {
                    const source = asset.metadata?.sharedAssetSource as { sourceProjectId?: string } | undefined;
                    return source?.sourceProjectId === sharedCanvasId && ["character", "scene", "prop"].includes(asset.kind);
                }));
            })
            .catch(() => { if (!disposed) setSharedAssetsError(true); });
        return () => { disposed = true; };
    }, [dramaId, folder?.sharedAssetCanvasId, sharedCanvasRevision, sharedAssetsReload]);
    useEffect(() => {
        const sharedCanvasId = folder?.sharedAssetCanvasId;
        if (!sharedCanvasId) { setSharedProduction(null); setSharedCanvasSnapshot(undefined); return; }
        let disposed = false;
        void Promise.all([
            fetchEpisodeProduction({ projectId: sharedCanvasId }).catch(() => null),
            fetchBackendProject(sharedCanvasId).catch(() => null),
        ]).then(([production, canvas]) => {
            if (disposed) return;
            setSharedProduction(production?.production || null);
            const source = production?.production?.draft.director?.source as Record<string, unknown> | undefined;
            setStyleWaiverDraft(String(source?.style_policy_reason || ""));
            const projectRecord = canvas?.project as { nodes?: unknown; revision?: unknown } | undefined;
            setSharedCanvasSnapshot({
                id: sharedCanvasId,
                revision: Number(projectRecord?.revision || 0),
                nodes: Array.isArray(projectRecord?.nodes) ? projectRecord.nodes as ProductionCanvasSnapshot["nodes"] : [],
            });
        });
        return () => { disposed = true; };
    }, [folder?.sharedAssetCanvasId, sharedAssetsReload, view]);

    if (!folder) return <div className="py-12 text-center text-sm text-muted-foreground">{t("canvas.loading")}</div>;

    const produceEpisode = onProduceEpisode || ((episode: DramaEpisode) => navigate(dramaWorkbenchPath(dramaId, episode.id)));
    const orderedSharedAssets = [...sharedAssets].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const sharedThumbs = orderedSharedAssets.slice(0, 5);
    const sharedCanvasProject = folder.sharedAssetCanvasId ? projects.find((item) => item.id === folder.sharedAssetCanvasId) : undefined;
    const sharedNodeCount = sharedCanvasProject?.summary?.nodeCount ?? sharedCanvasProject?.nodes.length;
    const sharedLastUpdate = orderedSharedAssets[0]?.updatedAt;
    const styleSource = sharedProduction?.draft.director?.source as Record<string, any> | undefined;
    const styleLock = styleSource?.style_lock as Record<string, unknown> | undefined;
    const styleAnchorAssetId = String(styleLock?.anchor_asset_id || "");
    const styleAnchorNodeId = String(styleSource?.style_anchor_node_id || "");
    const styleAssetPlan = Array.isArray(styleSource?.asset_plan) ? styleSource.asset_plan as Record<string, any>[] : [];
    const styleAssets = styleAssetPlan.filter(item => String(item.role || item.asset_type || "").toUpperCase() === "STYLE_MOTHER" || String(item.kind || "").toLowerCase() === "style");
    const sharedStyleNodes = productionCanvasNodes(folder.sharedAssetCanvasId || "", undefined, sharedCanvasSnapshot).filter(node => {
        const metadata = node.metadata || {};
        if (node.type === "image") return Boolean(metadata.storageKey);
        if (node.type === "character") return Array.isArray(metadata.characterImages) && metadata.characterImages.some((image: Record<string, unknown>) => typeof image.storageKey === "string" && image.storageKey);
        if (node.type === "scene") return Boolean((metadata.sceneImage as Record<string, unknown> | undefined)?.storageKey);
        if (node.type === "prop") return Boolean((metadata.propImage as Record<string, unknown> | undefined)?.storageKey);
        if (node.type === "config" && (metadata.generationMode || "image") === "image") {
            return metadata.smart === true
                ? Array.isArray(metadata.images) && metadata.images.some((image: Record<string, unknown>) => typeof image.storageKey === "string" && image.storageKey)
                : metadata.status === "success" && typeof metadata.storageKey === "string" && Boolean(metadata.storageKey);
        }
        return false;
    });
    const styleOptions = [
        ...styleAssets.map(item => ({ value: `asset:${String(item.asset_id || item.id || "")}`, label: String(item.asset_name || item.name || item.title || item.asset_id || item.id || "") })),
        ...sharedStyleNodes.map(node => ({ value: `node:${node.id}`, label: t("director.workspace.styleCanvasNode", { title: node.title || node.id }) })),
    ];
    const pendingStyleAnchorNodeId = String(folder.productionPlan?.styleAnchorNodeId || "");
    const styleValue = styleAnchorNodeId ? `node:${styleAnchorNodeId}` : styleAnchorAssetId ? `asset:${styleAnchorAssetId}` : pendingStyleAnchorNodeId ? `node:${pendingStyleAnchorNodeId}` : undefined;
    const patchSharedStyle = async (patch: Record<string, unknown>) => {
        if (!folder.sharedAssetCanvasId || !sharedProduction || styleSaving) return false;
        setStyleSaving(true);
        try {
            const result = await editEpisodeProduction({ projectId: folder.sharedAssetCanvasId }, sharedProduction.revision, [{ type: "patch_director_source", entity: "style", patch }], nanoid());
            setSharedProduction(result.production);
            setStyleWaiverDraft(String((result.production.draft.director?.source as Record<string, any> | undefined)?.style_policy_reason || ""));
            return true;
        } catch (error) {
            message.error(error instanceof Error ? error.message : String(error));
            return false;
        } finally { setStyleSaving(false); }
    };
    const clearPendingStyleAnchor = async (nodeId: string) => {
        const latest = await fetchBackendCanvasFolders();
        const current = (latest.folders || []).find(item => String(item.id || "") === dramaId) as unknown as CanvasFolder | undefined;
        if (!current || String(current.productionPlan?.styleAnchorNodeId || "") !== nodeId) return;
        const productionPlan = { ...current.productionPlan, styleAnchorNodeId: undefined };
        const saved = await upsertBackendCanvasFolder({ ...current, productionPlan, expectedPlanningUpdatedAt: current.updatedAt || current.createdAt, updatedAt: new Date().toISOString() });
        if (saved.folder) {
            useCanvasStore.setState(state => ({ folders: state.folders.map(item => item.id === dramaId ? saved.folder as unknown as CanvasFolder : item) }));
            setDraft(value => value ? { ...value, productionPlan: { ...value.productionPlan, styleAnchorNodeId: undefined }, expectedPlanningUpdatedAt: String((saved.folder as Record<string, unknown>).updatedAt || value.expectedPlanningUpdatedAt) } : value);
        }
    };
    useEffect(() => {
        if (!pendingStyleAnchorNodeId || !folder.sharedAssetCanvasId || !sharedProduction?.draft.director) return;
        const source = sharedProduction.draft.director.source as Record<string, unknown>;
        const currentAnchor = String(source.style_anchor_node_id || "");
        if (currentAnchor && currentAnchor !== pendingStyleAnchorNodeId) return;
        if (pendingStyleTransfer.current === pendingStyleAnchorNodeId) return;
        pendingStyleTransfer.current = pendingStyleAnchorNodeId;
        void (async () => {
            try {
                const transferred = currentAnchor === pendingStyleAnchorNodeId || await patchSharedStyle({
                    anchor_asset_id: "",
                    style_anchor_node_id: pendingStyleAnchorNodeId,
                    style_policy: "waived",
                    style_policy_reason: t("director.workspace.styleCanvasNodeReason", { title: t("drama.createProjectStyleNode") }),
                });
                if (transferred) await clearPendingStyleAnchor(pendingStyleAnchorNodeId);
                else pendingStyleTransfer.current = "";
            } catch (error) {
                pendingStyleTransfer.current = "";
                message.error(error instanceof Error ? error.message : String(error));
            }
        })();
    }, [pendingStyleAnchorNodeId, folder.sharedAssetCanvasId, sharedProduction, styleSaving, t, message]);
    const goToPlanning = () => navigate(`${location.pathname}?${productionWorkspaceQuery(new URLSearchParams(location.search), "series", { seriesView: "planning" }).toString()}`);
    const openSharedCanvas = async () => {
        if (openingSharedCanvas) return;
        if (!folder.sharedAssetCanvasId && !(folder.productionPlan?.confirmedAt && folder.productionPlan.confirmedOutline === folder.outline)) { goToPlanning(); return; }
        setOpeningSharedCanvas(true);
        try {
            const { project } = await ensureSharedAssetCanvas(folder.id);
            const projectId = String(project.id);
            useProductionFollowStore.getState().pause(t("productionCanvas.manualPause"));
            if (canvasHost) canvasHost.openCanvas({ projectId });
            else navigate(`/canvas/${encodeURIComponent(projectId)}`);
        }
        catch (error) { message.error(String(error)); }
        finally { setOpeningSharedCanvas(false); }
    };
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
    const saveFolder = async (confirm = true) => {
        if (!draft) return;
        if (confirm && !draft.productionPlan.storyboardImageMode) {
            message.warning(t("productionCanvas.storyboardImageRequired"));
            return;
        }
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

    return (
        <div>
            {(!view || view === "planning") && <section className="mb-5 space-y-3">
                <ProductionPageHeading titleAlreadyVisible={navigationTitleVisible} title={t("productionCanvas.dramaPlanning")} summary={t(folder.productionPlan?.confirmedAt && folder.productionPlan.confirmedOutline === folder.outline ? "productionCanvas.planConfirmed" : "productionCanvas.planUnconfirmed")} help={<p>{t("productionCanvas.dramaPlanningHint")}</p>} actions={<div className="flex flex-wrap justify-end gap-2"><Button disabled={savingPlan || uploadingCover} loading={uploadingCover} onClick={() => void saveFolder(false)}>{t("sceneProduction.saveDraft")}</Button><Button type="primary" loading={savingPlan} disabled={uploadingCover} onClick={() => void saveFolder()}>{t("productionCanvas.confirmPlan")}</Button></div>} />
                {draft ? <Tabs activeKey={planningTab} onChange={key => setPlanningTab(key as "info" | "settings")} items={[
                    { key: "info", label: t("productionCanvas.planningOverviewTab"), children: <div className="space-y-5 pt-1">
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
                <label className="block"><span className="mb-1.5 block text-sm font-medium">{t("drama.description")}</span><Input.TextArea rows={3} placeholder={t("drama.descriptionPlaceholder")} value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} /></label>
                    </div> },
                    { key: "settings", label: t("productionCanvas.planningSettingsTab"), children: <div className="space-y-5 pt-1">
                        <p className="text-xs text-muted-foreground">{t("productionCanvas.newEpisodeDefaults")}</p>
                <div className="grid gap-4 sm:grid-cols-2">
                    <label><p className="mb-2 text-sm">{t("productionCanvas.storyboardImageMode")}</p><Select className="w-full" placeholder={t("productionCanvas.storyboardImageRequired")} value={draft.productionPlan.storyboardImageMode} onChange={storyboardImageMode => setDraft({ ...draft, productionPlan: { ...draft.productionPlan, storyboardImageMode } })} options={[{ value: "generate", label: t("productionCanvas.storyboardImagesGenerate") }, { value: "skip", label: t("productionCanvas.storyboardImagesSkip") }]} />{!draft.productionPlan.storyboardImageMode && <p className="mb-1 mt-2 text-xs text-red-500">{t("productionCanvas.storyboardImageRequired")}</p>}<p className="mt-2 text-xs text-muted-foreground">{t("productionCanvas.storyboardImageModeHint")}</p></label>
                    <SceneProductionSettings value={draft.productionPlan} onChange={patch => setDraft({ ...draft, productionPlan: { ...draft.productionPlan, ...patch } })} />
                    <p className="text-xs text-muted-foreground">{t("sceneProduction.draftHint")}</p>
                    <div><p className="mb-2 text-sm">{t("productionCanvas.generalImageModel")}</p><ModelPicker config={modelConfig} capability="image" fullWidth value={draft.productionPlan.imageModel} onChange={imageModel => setDraft({ ...draft, productionPlan: { ...draft.productionPlan, imageModel } })} /></div>
                    {(["character", "scene", "prop", "style", "keyframe"] as const).map(kind => <div key={kind}><p className="mb-2 text-sm">{t(`productionCanvas.assetModel.${kind}`)}</p><ModelPicker config={modelConfig} capability="image" fullWidth placeholder={t("productionCanvas.inheritImageModel")} value={draft.productionPlan.imageModelsByKind[kind]} onChange={model => setDraft({ ...draft, productionPlan: { ...draft.productionPlan, imageModelsByKind: { ...draft.productionPlan.imageModelsByKind, [kind]: model } } })} /><Button type="link" size="small" disabled={!draft.productionPlan.imageModelsByKind[kind]} onClick={() => setDraft({ ...draft, productionPlan: { ...draft.productionPlan, imageModelsByKind: { ...draft.productionPlan.imageModelsByKind, [kind]: undefined } } })}>{t("productionCanvas.inheritImageModel")}</Button></div>)}
                    <div><p className="mb-2 text-sm">{t("productionCanvas.videoModel")}</p><ModelPicker config={modelConfig} capability="video" fullWidth value={draft.productionPlan.h3Model} onChange={h3Model => setDraft({ ...draft, productionPlan: { ...draft.productionPlan, h3Model } })} /></div>
                    <label><p className="mb-2 text-sm">{t("director.workspace.videoAspectRatio")}</p><Select className="w-full" allowClear value={draft.productionPlan.videoAspectRatio || undefined} onChange={videoAspectRatio => setDraft({ ...draft, productionPlan: { ...draft.productionPlan, videoAspectRatio: videoAspectRatio || null } })} options={["9:16", "16:9", "1:1", "4:3", "3:4", "2:3", "3:2", "21:9"].map(value => ({ value, label: value }))} /></label>
                </div>
                <div className="rounded-xl border border-red-200 p-4 dark:border-red-950">
                    <p className="text-sm font-medium text-red-600 dark:text-red-400">{t("productionCanvas.dangerZone")}</p>
                    <Button danger type="text" className="mt-2" icon={<Trash2 className="size-4" />} onClick={deleteDrama}>{t("drama.deleteProject")}</Button>
                </div>
                    </div> },
                ]} /> : null}
            </section>}
            {(!view || view === "shared") && <section data-drama-shared-canvas className="mb-5 space-y-4">
                <ProductionPageHeading titleAlreadyVisible={navigationTitleVisible} title={t("productionCanvas.sharedCanvas")} summary={t(folder.sharedAssetCanvasId ? "productionCanvas.sharedCanvasReady" : "productionCanvas.sharedCanvasEmpty")} help={<p>{t("productionCanvas.sharedCanvasDescription")}</p>} actions={<Button loading={openingSharedCanvas} onClick={() => void openSharedCanvas()}>{t("productionCanvas.openSharedCanvas")}<ArrowUpRight className="ml-1 size-4" /></Button>} />
                {folder.sharedAssetCanvasId ? (
                    <div className="overflow-hidden rounded-2xl border border-stone-200 bg-background dark:border-stone-800">
                        <div className="flex flex-col gap-5 p-5 sm:flex-row sm:items-center">
                            <div className="min-w-0 flex-1 space-y-3">
                                <div className="flex items-center gap-3">
                                    <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-orange-100 text-orange-600 dark:bg-orange-950/40 dark:text-orange-300"><Images className="size-5" /></span>
                                    <div className="min-w-0">
                                        <p className="truncate text-sm font-semibold" title={sharedCanvasProject?.title}>{sharedCanvasProject?.title || t("productionCanvas.sharedCanvas")}</p>
                                        <p className="mt-0.5 text-xs text-stone-500 dark:text-stone-400">{t("productionCanvas.sharedCanvasDescription")}</p>
                                    </div>
                                </div>
                                <div className="flex flex-wrap gap-2">
                                    <Tag color="orange">{t("productionCanvas.sharedAssetGalleryCount", { count: orderedSharedAssets.length })}</Tag>
                                    {typeof sharedNodeCount === "number" && <Tag>{t("productionCanvas.sharedCanvasNodes")}: {sharedNodeCount}</Tag>}
                                    {sharedLastUpdate && <Tag>{t("productionCanvas.sharedCanvasLastUpdate")}: {new Date(sharedLastUpdate).toLocaleDateString()}</Tag>}
                                </div>
                            </div>
                            {sharedThumbs.length > 0 && <div className="flex shrink-0 items-center">
                                {sharedThumbs.map((asset, index) => <MediaImage key={asset.id} src={sharedAssetImageSource(asset)} alt={asset.title} name={asset.title} className={`size-16 rounded-xl border-2 border-background object-cover shadow-sm ${index ? "-ml-4" : ""}`} preview={false} />)}
                                {orderedSharedAssets.length > sharedThumbs.length && <span className="-ml-4 grid size-16 shrink-0 place-items-center rounded-xl border-2 border-background bg-stone-100 text-xs font-medium text-stone-500 dark:bg-stone-900 dark:text-stone-400">+{orderedSharedAssets.length - sharedThumbs.length}</span>}
                            </div>}
                        </div>
                    </div>
                ) : (
                    <div className="flex items-center gap-4 rounded-2xl border border-dashed border-stone-300 bg-stone-50 p-5 dark:border-stone-700 dark:bg-stone-900/40">
                        <span className="grid size-10 shrink-0 place-items-center rounded-full bg-orange-100 text-orange-600 dark:bg-orange-950/40 dark:text-orange-300"><Images className="size-5" /></span>
                        <div className="min-w-0">
                            <p className="text-sm font-medium">{t("productionCanvas.sharedCanvasDescription")}</p>
                            <p className="mt-1 text-xs leading-5 text-stone-500 dark:text-stone-400">{t("productionCanvas.sharedCanvasEmpty")}</p>
                        </div>
                    </div>
                )}
                {folder.sharedAssetCanvasId && <div>
                    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                        <h3 className="text-sm font-semibold">{t("productionCanvas.sharedAssetGalleryTitle")}</h3>
                        {orderedSharedAssets.length > 0 && <span className="text-xs text-stone-400">{t("productionCanvas.sharedAssetGalleryCount", { count: orderedSharedAssets.length })}</span>}
                    </div>
                    {sharedAssetsError ? (
                        <div className="flex items-center justify-between gap-3 rounded-xl border border-dashed border-stone-300 px-4 py-4 text-sm text-stone-400 dark:border-stone-700">
                            <span>{t("productionCanvas.sharedAssetGalleryLoadFailed")}</span>
                            <Button size="small" onClick={() => setSharedAssetsReload((nonce) => nonce + 1)}>{t("productionCanvas.sharedAssetGalleryRetry")}</Button>
                        </div>
                    ) : orderedSharedAssets.length ? (
                        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                            {orderedSharedAssets.map((asset) => (
                                <button key={asset.id} type="button" onClick={() => void openSharedCanvas()} className="group min-w-0 overflow-hidden rounded-xl border border-stone-200 bg-background text-left transition hover:-translate-y-0.5 hover:border-orange-300 hover:shadow-lg hover:shadow-orange-950/5 dark:border-stone-800 dark:hover:border-orange-900">
                                    <MediaImage src={sharedAssetImageSource(asset)} alt={asset.title} name={asset.title} className="aspect-[4/3] w-full bg-stone-100 object-cover dark:bg-stone-900" preview={false} />
                                    <div className="space-y-1.5 p-3">
                                        <p className="truncate text-sm font-medium" title={asset.title}>{asset.title || t("productionCanvas.sharedAssetUntitled")}</p>
                                        <div className="flex items-center gap-2 text-xs text-stone-400">
                                            <span className="truncate">{t(`assets.kinds.${asset.kind}`)}</span>
                                            <span className="ml-auto shrink-0">{new Date(asset.updatedAt).toLocaleDateString()}</span>
                                        </div>
                                    </div>
                                </button>
                            ))}
                        </div>
                    ) : (
                        <div className="rounded-xl border border-dashed border-stone-300 px-4 py-6 text-center text-sm text-stone-400 dark:border-stone-700">{t("productionCanvas.sharedAssetGalleryEmpty")}</div>
                    )}
                </div>}
                {folder.sharedAssetCanvasId && sharedProduction?.draft.director && <div className="rounded-2xl border border-stone-200 bg-background p-5 dark:border-stone-800" data-shared-style-anchor>
                    <div className="mb-3">
                        <h3 className="text-sm font-semibold">{t("productionCanvas.sharedStyleAnchorTitle")}</h3>
                        <p className="mt-1 text-xs leading-5 text-stone-500 dark:text-stone-400">{t("productionCanvas.sharedStyleAnchorHint")}</p>
                    </div>
                    <div className="grid gap-4 md:grid-cols-2">
                        <label className="grid gap-1.5 text-sm">
                            <span className="font-medium">{t("director.workspace.styleMother")}</span>
                            <Select allowClear value={styleValue} disabled={styleSaving} placeholder={t("director.workspace.chooseStyleMother")} options={styleOptions} onChange={selected => {
                                if (!selected) void patchSharedStyle({ anchor_asset_id: "", style_anchor_node_id: "", style_policy: "waived", style_policy_reason: t("director.workspace.styleUnboundReason") });
                                else if (selected.startsWith("node:")) {
                                    const nodeId = selected.slice("node:".length);
                                    const node = sharedStyleNodes.find(item => item.id === nodeId);
                                    void patchSharedStyle({ anchor_asset_id: "", style_anchor_node_id: nodeId, style_policy: "waived", style_policy_reason: t("director.workspace.styleCanvasNodeReason", { title: node?.title || nodeId }) });
                                } else void patchSharedStyle({ anchor_asset_id: selected.slice("asset:".length), style_anchor_node_id: "", style_policy: "required", style_policy_reason: "" });
                            }} />
                        </label>
                        <label className="grid gap-1.5 text-sm">
                            <span className="font-medium">{t("director.workspace.stylePolicy")}</span>
                            <Select value={String(styleSource?.style_policy || "") || undefined} placeholder={t("director.workspace.styleOptional")} disabled={styleSaving || Boolean(styleAnchorNodeId)} options={[{ value: "required", label: t("director.workspace.styleRequired") }, { value: "waived", label: t("director.workspace.styleWaived") }]} onChange={value => void patchSharedStyle({ style_policy: value, style_policy_reason: value === "waived" ? String(styleSource?.style_policy_reason || "") : "" })} />
                        </label>
                        {String(styleSource?.style_policy || "") === "waived" && <label className="grid gap-1.5 text-sm md:col-span-2">
                            <span>{t("director.workspace.styleWaiverReason")}</span>
                            <Input.TextArea rows={2} value={styleWaiverDraft} disabled={styleSaving} onChange={event => setStyleWaiverDraft(event.target.value)} onBlur={() => { if (styleWaiverDraft !== String(styleSource?.style_policy_reason || "")) void patchSharedStyle({ style_policy_reason: styleWaiverDraft }); }} />
                        </label>}
                    </div>
                </div>}
            </section>}
            {(!view || view === "episodes") && <section>
                <div className="mb-3"><ProductionPageHeading titleAlreadyVisible={navigationTitleVisible} title={t("drama.episodeListTitle")} summary={`${episodes.length} ${t("drama.episodeUnit")}`} actions={<Button type="primary" onClick={() => openEpisodeEditor()} icon={<Plus className="size-4" />}>{t("drama.newEpisode")}</Button>} /></div>
                {episodes.length ? (
                    <div className="grid gap-4 sm:grid-cols-2">
                        {episodes.map((episode) => <EpisodeCard key={episode.id} episode={episode} project={episode.canvasId ? projects.find((item) => item.id === episode.canvasId) : undefined} onProduce={() => produceEpisode(episode)} onEdit={() => openEpisodeEditor(episode)} onDelete={() => removeEpisode(episode)} t={t} />)}
                    </div>
                ) : (
                    <div className="flex min-h-60 flex-col items-center justify-center rounded-2xl border border-dashed border-stone-300 px-6 text-center dark:border-stone-700">
                        <div className="grid size-12 place-items-center rounded-full bg-orange-100 text-orange-600 dark:bg-orange-950/40 dark:text-orange-300"><Clapperboard className="size-5" /></div>
                        <h3 className="mt-5 text-lg font-medium">{t("drama.emptyFolderTitle")}</h3>
                        <p className="mt-2 max-w-md text-sm leading-6 text-stone-500 dark:text-stone-400">{t("drama.emptyFolderDescription")}</p>
                        <Button type="primary" className="mt-5" icon={<Plus className="size-4" />} onClick={() => openEpisodeEditor()}>{t("drama.newEpisode")}</Button>
                    </div>
                )}
            </section>}

            {(!view || view === "shared" || view === "planning") && <section className="mt-10 rounded-2xl border border-stone-200 bg-background p-5 dark:border-stone-800">
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
            </section>}

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
            
            <input ref={coverInputRef} type="file" accept="image/*" className="hidden" onChange={(event) => void handleCoverChange(event)} />
        </div>
    );
}

function EpisodeCard({ episode, project, onProduce, onEdit, onDelete, t }: { episode: DramaEpisode; project?: CanvasProject; onProduce: () => void; onEdit: () => void; onDelete: () => void; t: TFunction }) {
    return <article className="group relative flex min-h-48 min-w-0 flex-col justify-between overflow-hidden rounded-2xl border border-stone-200 bg-background p-5 text-left transition hover:-translate-y-0.5 hover:border-orange-300 hover:shadow-lg hover:shadow-orange-950/5 dark:border-stone-800 dark:hover:border-orange-900">
        <div className="absolute right-0 top-0 h-24 w-24 translate-x-8 -translate-y-8 rounded-full border border-orange-200/70 transition group-hover:scale-125 dark:border-orange-950/60" />
        <div className="relative flex flex-wrap items-start justify-between gap-3">
            <button type="button" className="text-left text-xs font-medium text-orange-600 dark:text-orange-400" onClick={onProduce}>{t("drama.episodeLabel", { number: episode.episodeNumber })}</button>
            <div className="flex flex-wrap items-center gap-1">
                <Button size="small" onClick={onProduce}>{t("drama.editEpisodeDirector")}</Button>
                <Button type="text" size="small" className="!px-1.5 !text-stone-400 hover:!text-stone-900 dark:hover:!text-stone-100" onClick={onEdit} aria-label={t("drama.editEpisode")}><PencilLine className="size-4" /></Button>
                <Button type="text" size="small" danger className="!px-1.5" onClick={onDelete} aria-label={t("drama.deleteEpisodeTitle")}><Trash2 className="size-4" /></Button>
            </div>
        </div>
        <button type="button" className="relative mt-6 min-w-0 text-left" onClick={onProduce}>
            <h3 className="truncate text-lg font-semibold" title={episode.title}>{episode.title || t("drama.episodeLabel", { number: episode.episodeNumber })}</h3>
            <p className="mt-2 line-clamp-3 whitespace-pre-line break-words text-sm leading-6 text-stone-500 dark:text-stone-400">{episode.synopsis || t("drama.noEpisodeSynopsis")}</p>
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
