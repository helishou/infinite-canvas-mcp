import { useEffect, useRef, useState } from "react";
import { App, Button, Input, Modal, Radio, Tag } from "antd";
import { ArrowUpRight, Clapperboard, Plus, Search } from "lucide-react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { nanoid } from "nanoid";

import { applyBackendCanvasOperations, ensureSharedAssetCanvas, startCanvasGeneration, upsertBackendCanvasFolder, type DramaEpisode } from "@/services/backend-api";
import { resolveImageUrl, uploadImage, type UploadedImage } from "@/services/image-storage";
import { useCanvasStore, type CanvasFolder } from "@/stores/canvas/use-canvas-store";
import { ModelPicker } from "@/components/model-picker";
import { useConfigStore } from "@/stores/use-config-store";
import { dramaProductionPlanSchema, type DramaProductionPlan } from "@basketikun/canvas-agent/drama/production-contract";
import { cn } from "@/lib/utils";

import { dramaProjectDestination, matchesProjectQuery } from "@/pages/projects/directory-data";
import { useDramaDirectory } from "@/pages/projects/use-drama-directory";

export default function DramaPage({ searchQuery, compactEmpty = false }: { searchQuery?: string; compactEmpty?: boolean } = {}) {
    const { t } = useTranslation();
    const hydrated = useCanvasStore((state) => state.hydrated);
    const createFolder = useCanvasStore((state) => state.createFolder);
    const modelConfig = useConfigStore((state) => state.config);
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
        navigate(dramaProjectDestination(id, query.toString()));
    };
    const shownDramaFolders = [...dramaFolders]
        .sort((a, b) => (Date.parse(b.updatedAt || b.createdAt) || 0) - (Date.parse(a.updatedAt || a.createdAt) || 0))
        .filter(folder => matchesProjectQuery(folder.name, libraryQuery));
    const [createOpen, setCreateOpen] = useState(false);
    const [newDramaName, setNewDramaName] = useState("");
    const [newDramaPlan, setNewDramaPlan] = useState<DramaProductionPlan>(() => dramaProductionPlanSchema.parse({}));
    const [styleMode, setStyleMode] = useState<"upload" | "prompt" | "none">("upload");
    const [styleImageFile, setStyleImageFile] = useState<File>();
    const [stylePrompt, setStylePrompt] = useState("");
    const [creatingDrama, setCreatingDrama] = useState(false);
    const creationRef = useRef<{ folderId: string; image?: UploadedImage; imageNodeId: string; operationId: string; taskKey: string; mode: "upload" | "prompt" | "none"; prompt: string; plan: DramaProductionPlan } | undefined>(undefined);
    const openCreateDrama = () => {
        setNewDramaName(t("drama.defaultProjectName"));
        setNewDramaPlan(dramaProductionPlanSchema.parse({}));
        setStyleMode("upload");
        setStyleImageFile(undefined);
        setStylePrompt("");
        creationRef.current = undefined;
        setCreateOpen(true);
    };
    const createDrama = async () => {
        const name = newDramaName.trim();
        if (!name || creatingDrama || styleMode === "upload" && !styleImageFile || styleMode === "prompt" && !stylePrompt.trim()) return;
        setCreatingDrama(true);
        try {
            let creation = creationRef.current;
            if (!creation) {
                const uploaded = styleMode === "upload" && styleImageFile ? await uploadImage(styleImageFile, { category: "library" }) : undefined;
                const imageNodeId = (styleMode !== "none") ? nanoid() : "";
                const plan = {
                    ...newDramaPlan,
                    ...(imageNodeId ? { styleAnchorNodeId: imageNodeId } : {}),
                } as DramaProductionPlan;
                const folderId = createFolder(name, true, plan);
                creation = { folderId, image: uploaded, imageNodeId, operationId: nanoid(), taskKey: nanoid(), mode: styleMode, prompt: stylePrompt.trim(), plan };
                creationRef.current = creation;
            }
            const folder = useCanvasStore.getState().folders.find(item => item.id === creation!.folderId);
            if (!folder) throw new Error("新剧目已创建，但读取不到本地剧目信息");
            const saved = await upsertBackendCanvasFolder(folder as unknown as Record<string, unknown>);
            if (saved.folder) useCanvasStore.setState(state => ({ folders: state.folders.map(item => item.id === creation!.folderId ? saved.folder as unknown as CanvasFolder : item) }));
            if (creation.imageNodeId) {
                const { project } = await ensureSharedAssetCanvas(creation.folderId);
                const image = creation.image;
                const node = creation.mode === "prompt"
                    ? { type: "add_node", id: creation.imageNodeId, nodeType: "config", title: t("drama.createProjectStyleNode"), position: { x: 0, y: 0 }, width: 360, height: 260, metadata: { smart: true, generationMode: "image", prompt: creation.prompt, composerContent: creation.prompt, model: creation.plan.imageModelsByKind.style || creation.plan.imageModel || undefined, status: "idle", generationType: "generation", count: 1, styleMother: true } }
                    : { type: "add_node", id: creation.imageNodeId, nodeType: "image", title: t("drama.createProjectStyleNode"), position: { x: 0, y: 0 }, width: 360, height: Math.max(220, Math.min(420, 360 * ((image?.height || 1) / Math.max(1, image?.width || 1)))), metadata: { content: image?.url, storageKey: image?.storageKey, status: "success", naturalWidth: image?.width, naturalHeight: image?.height, bytes: image?.bytes, mimeType: image?.mimeType, styleMother: true } };
                await applyBackendCanvasOperations(String(project.id), [node], Number(project.revision || 0), creation.operationId);
                if (creation.mode === "prompt") {
                    await startCanvasGeneration({ mode: "image", projectId: String(project.id), nodeId: creation.imageNodeId, model: creation.plan.imageModelsByKind.style || creation.plan.imageModel || undefined, prompt: creation.prompt, count: 1, clientTaskId: creation.taskKey, idempotencyKey: creation.taskKey });
                }
            }
            setCreateOpen(false);
            creationRef.current = undefined;
            navigate(dramaProjectDestination(creation.folderId, query.toString()));
        } catch (error) {
            message.error(error instanceof Error ? error.message : String(error));
        } finally { setCreatingDrama(false); }
    };

    const updateAssetImageModel = (kind: keyof DramaProductionPlan["imageModelsByKind"], model: string) => setNewDramaPlan(current => ({
        ...current,
        imageModelsByKind: { ...current.imageModelsByKind, [kind]: model || undefined },
    }));

    return (
        <section className="text-foreground" aria-label={t("projects.drama")}>
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-5">
                {searchQuery === undefined ? <Input className="!w-full sm:!w-80" size="large" allowClear prefix={<Search className="mr-1 size-4 text-muted-foreground" />} aria-label={t("landing.searchSeries")} placeholder={t("landing.searchSeries")} value={libraryQuery} onChange={event => setLibraryQuery(event.target.value)} /> : <div><h2 className="text-lg font-medium tracking-tight">{t("projects.drama")}</h2><p className="mt-1 text-xs text-muted-foreground">{t("projects.dramaDescription")}</p></div>}
                <Button type="primary" disabled={!hydrated} onClick={openCreateDrama} icon={<Plus className="size-4" />}>{t("drama.createProject")}</Button>
            </div>
            <section className="mt-6">
                {!hydrated ? (
                    <div role="status" className="flex min-h-72 items-center justify-center rounded-xl border border-border bg-card/50 text-sm text-muted-foreground">{t("canvas.loading")}</div>
                ) : dramaFolders.length ? (
                    <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
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
            <Modal
                width={680}
                open={createOpen}
                title={t("drama.createProject")}
                okText={t("drama.createProject")}
                cancelText={t("common.cancel")}
                okButtonProps={{ disabled: !newDramaName.trim() || styleMode === "upload" && !styleImageFile || styleMode === "prompt" && !stylePrompt.trim() }}
                confirmLoading={creatingDrama}
                onOk={createDrama}
                onCancel={() => { if (!creatingDrama) setCreateOpen(false); }}
            >
                <div className="grid gap-5">
                    <Input autoFocus aria-label={t("drama.createProjectPrompt")} placeholder={t("drama.createProjectPrompt")} value={newDramaName} onChange={event => setNewDramaName(event.target.value)} />
                    <section className="grid gap-3">
                        <div><h3 className="text-sm font-medium">{t("drama.createAssetImageModels")}</h3><p className="mt-1 text-xs text-muted-foreground">{t("drama.createAssetImageModelsHint")}</p></div>
                        <label className="grid gap-1.5 text-sm"><span>{t("productionCanvas.generalImageModel")}</span><ModelPicker config={modelConfig} capability="image" fullWidth value={newDramaPlan.imageModel || undefined} onChange={imageModel => setNewDramaPlan(current => ({ ...current, imageModel }))} /><Button type="link" className="justify-self-start px-0" size="small" disabled={!newDramaPlan.imageModel} onClick={() => setNewDramaPlan(current => ({ ...current, imageModel: "" }))}>{t("productionCanvas.inheritImageModel")}</Button></label>
                        <div className="grid gap-3 sm:grid-cols-2">
                            {(["character", "scene", "prop", "style", "keyframe"] as const).map(kind => <label key={kind} className="grid gap-1.5 text-sm"><span>{t(`productionCanvas.assetModel.${kind}`)}</span><ModelPicker config={modelConfig} capability="image" fullWidth placeholder={t("productionCanvas.inheritImageModel")} value={newDramaPlan.imageModelsByKind[kind]} onChange={model => updateAssetImageModel(kind, model)} /><Button type="link" className="justify-self-start px-0" size="small" disabled={!newDramaPlan.imageModelsByKind[kind]} onClick={() => updateAssetImageModel(kind, "")}>{t("productionCanvas.inheritImageModel")}</Button></label>)}
                        </div>
                    </section>
                    <section className="grid gap-3">
                        <div><h3 className="text-sm font-medium">{t("drama.createStyleReference")}</h3><p className="mt-1 text-xs text-muted-foreground">{t("drama.createStyleReferenceHint")}</p></div>
                        <Radio.Group value={styleMode} onChange={event => setStyleMode(event.target.value as "upload" | "prompt" | "none")} options={[{ value: "upload", label: t("drama.uploadStyleReference") }, { value: "prompt", label: t("drama.generateStyleReference") }, { value: "none", label: t("drama.skipStyleReference") }]} />
                        {styleMode === "upload" && <div className="flex flex-wrap items-center gap-3"><input type="file" accept="image/*" aria-label={t("drama.uploadStyleReference")} onChange={event => setStyleImageFile(event.target.files?.[0])} />{styleImageFile && <span className="text-xs text-muted-foreground">{styleImageFile.name}</span>}</div>}
                        {styleMode === "prompt" && <Input.TextArea rows={3} value={stylePrompt} onChange={event => setStylePrompt(event.target.value)} placeholder={t("drama.styleReferencePrompt")} />}
                    </section>
                </div>
            </Modal>
        </section>
    );
}

function DramaCard({ folder, episodes, onOpen, t }: { folder: CanvasFolder; episodes: DramaEpisode[] | undefined; onOpen: () => void; t: import("i18next").TFunction }) {
    const [coverUrl, setCoverUrl] = useState("");
    useEffect(() => {
        let disposed = false;
        setCoverUrl("");
        if (!folder.coverStorageKey) return;
        void resolveImageUrl(folder.coverStorageKey).then((url) => { if (!disposed) setCoverUrl(url); });
        return () => { disposed = true; };
    }, [folder.coverStorageKey]);
    const boundCanvases = episodes?.filter((episode) => episode.canvasId).length;
    return <button type="button" className="group flex h-full flex-col overflow-hidden rounded-xl border border-border bg-card text-left transition-colors hover:border-primary/40 focus-visible:outline-primary" onClick={onOpen}>
        <div className="relative aspect-[16/9] w-full overflow-hidden border-b border-border bg-muted/50">
            {coverUrl ? <img src={coverUrl} alt={folder.name} className="h-full w-full object-cover" loading="lazy" /> : <div className="grid h-full place-items-center text-primary/60"><Clapperboard className="size-10 stroke-[1.2]" /></div>}

            <span className="absolute bottom-3 left-4 rounded-md border border-border/50 bg-card/95 px-2 py-1 text-[11px] font-medium text-foreground">{episodes ? t("drama.episodeCount", { count: episodes.length }) : t("projects.episodesUnavailable")}</span>
        </div>
        <div className="flex w-full flex-1 flex-col p-5">
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                    <h3 className="truncate text-lg font-medium tracking-tight">{folder.name}</h3>
                    <p className="mt-2 line-clamp-2 min-h-10 text-sm leading-5 text-muted-foreground">{folder.description || folder.outline || t("drama.outlineEmpty")}</p>
                </div>
                <ArrowUpRight className="mt-1 size-4 shrink-0 text-muted-foreground transition-colors group-hover:text-primary" />
            </div>
            {(folder.tags || []).length ? <div className="mt-4 flex gap-1.5 overflow-hidden">{(folder.tags || []).slice(0, 3).map((tag) => <Tag key={tag} className="m-0 max-w-28 truncate border-border bg-transparent text-xs text-muted-foreground">{tag}</Tag>)}</div> : null}
            <div className="mt-5 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-4 text-[11px] text-muted-foreground">
                <span>{episodes ? t("drama.boundCanvasCount", { count: boundCanvases }) : t("projects.episodesUnavailable")}</span>
                <span>{t("drama.enterProject")}</span>
            </div>
        </div>
    </button>;
}
