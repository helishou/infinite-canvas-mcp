import { useEffect, useMemo, useRef, useState } from "react";
import { App, Button, Input, Modal, Radio, Tag } from "antd";
import { ArrowUpRight, Clapperboard, Plus, Search, Trash2 } from "lucide-react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { nanoid } from "nanoid";

import { applyBackendCanvasOperations, createBackendDramaEpisode, ensureSharedAssetCanvas, startCanvasGeneration, upsertBackendCanvasFolder, type DramaEpisode } from "@/services/backend-api";
import { resolveImageUrl, uploadImage, type UploadedImage } from "@/services/image-storage";
import { useCanvasStore, type CanvasFolder } from "@/stores/canvas/use-canvas-store";
import { ModelPicker } from "@/components/model-picker";
import { PageSectionHeader } from "@/components/layout/page-header";
import { useConfigStore } from "@/stores/use-config-store";
import { dramaProductionPlanSchema, type DramaProductionPlan } from "@basketikun/canvas-agent/drama/production-contract";
import { splitSourceIntoEpisodes, chaptersFromAnalysis, NOVEL_MAX_CHARS, NOVEL_MIN_CHARS } from "@/lib/drama/adapt";
import { EPISODE_SOURCE_CHARS } from "@basketikun/canvas-agent/drama/chapter-episodes";
import { analyzeNovelChapters } from "@basketikun/canvas-agent/drama/novel-chapters";
import { cn } from "@/lib/utils";

import { NewDramaFooter, NewDramaWizard, NEW_DRAMA_STEPS, newDramaStepValid } from "./new-drama-wizard";
import { clearNewDramaDraft, newDramaDraftHasContent, readNewDramaDraft, writeNewDramaDraft } from "./new-drama-draft";
import { planningPrompt, stashPlanningHandoff } from "./planning-director-launch";
import { TOPIC_DEFAULTS } from "./planning-topic-logic";
import { confirmDeleteDrama } from "./confirm-delete-drama";
import { dramaProjectDestination, matchesProjectQuery } from "@/pages/projects/directory-data";
import { useDramaDirectory } from "@/pages/projects/use-drama-directory";

export default function DramaPage({ searchQuery, compactEmpty = false, headingHidden = false, createOnly = false, onCreated, openInStudio = false }: { searchQuery?: string; compactEmpty?: boolean; headingHidden?: boolean; createOnly?: boolean; onCreated?: (folderId: string) => void; openInStudio?: boolean } = {}) {
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
        // openInStudio：作品列表页复用为「新制作台列表页」，进剧目直达 drama-studio。
        if (openInStudio) {
            const next = new URLSearchParams(query.toString());
            next.set("dramaId", id);
            next.delete("manage");
            navigate(`/drama-studio?${next.toString()}`);
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
    const [wizardStep, setWizardStep] = useState(0);
    const [restoredDraft, setRestoredDraft] = useState("");
    const [autoEpisodes, setAutoEpisodes] = useState(true);
    const [handoff, setHandoff] = useState(true);
    const creationRef = useRef<{ folderId: string; image?: UploadedImage; imageNodeId: string; operationId: string; taskKey: string; mode: "upload" | "prompt" | "none"; prompt: string; plan: DramaProductionPlan } | undefined>(undefined);
    const openCreateDrama = async () => {
        const blank = dramaProductionPlanSchema.parse({});
        const restored = await readNewDramaDraft().catch(() => null);
        if (restored && newDramaDraftHasContent(restored)) {
            // 上次没填完的草稿整份回填；上传的参考图留不住，回来要重选。
            setNewDramaName(restored.name);
            setNewDramaPlan(restored.plan);
            setStyleMode(restored.styleMode);
            setStyleImageFile(undefined);
            setStylePrompt(restored.stylePrompt);
            setWizardStep(Math.min(Math.max(0, restored.step), NEW_DRAMA_STEPS.length - 1));
            setAutoEpisodes(restored.autoEpisodes);
            setHandoff(restored.handoff);
            setRestoredDraft(restored.savedAt);
        } else {
            setNewDramaName(t("drama.defaultProjectName"));
            // 默认值与导演大师一致：女性 / 全龄 / 甜虐 / HE / 60 集 / 中文 / 时长交给模型。
            setNewDramaPlan({ ...blank, topic: { ...blank.topic, ...TOPIC_DEFAULTS, tones: [...TOPIC_DEFAULTS.tones] } });
            setStyleMode("none");
            setStyleImageFile(undefined);
            setStylePrompt("");
            setWizardStep(0);
            setAutoEpisodes(true);
            setHandoff(true);
            setRestoredDraft("");
        }
        creationRef.current = undefined;
        setCreateOpen(true);
    };
    /** 关弹窗时留一份草稿：原文与设置都在里面，下次打开接着填（空表单不留）。 */
    const closeCreateDrama = () => {
        if (creatingDrama) return;
        const draft = { name: newDramaName, plan: newDramaPlan, styleMode, stylePrompt, autoEpisodes, handoff, step: wizardStep };
        if (newDramaDraftHasContent(draft)) void writeNewDramaDraft(draft);
        else void clearNewDramaDraft();
        setCreateOpen(false);
    };
    const discardDraft = () => {
        void clearNewDramaDraft();
        const blank = dramaProductionPlanSchema.parse({});
        setRestoredDraft("");
        setNewDramaName(t("drama.defaultProjectName"));
        setNewDramaPlan({ ...blank, topic: { ...blank.topic, ...TOPIC_DEFAULTS, tones: [...TOPIC_DEFAULTS.tones] } });
        setStyleMode("none");
        setStyleImageFile(undefined);
        setStylePrompt("");
        setWizardStep(0);
    };
    const createDrama = async () => {
        const name = newDramaName.trim();
        if (!name || creatingDrama || styleMode === "upload" && !styleImageFile || styleMode === "prompt" && !stylePrompt.trim()) return;
        // 单集原文超上限时先减章：超限的集写不进一次提示词，建出来也做不下去。
        if (splitBlocked) {
            message.error(t("newDrama.split.oversize", { label: splitBlocked.label, chars: splitBlocked.chars, limit: EPISODE_SOURCE_CHARS }));
            setWizardStep(1);
            return;
        }
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
            // 共享资产画布是新制作台资产库的真值容器：无论有没有风格图都必须建（styleMode=none 也要），
            // ensure 幂等（已绑定直接返回），保证从原文新建的剧目天然具备共享资产画布。
            const { project } = await ensureSharedAssetCanvas(creation.folderId);
            if (creation.imageNodeId) {
                const image = creation.image;
                const node = creation.mode === "prompt"
                    ? { type: "add_node", id: creation.imageNodeId, nodeType: "config", title: t("drama.createProjectStyleNode"), position: { x: 0, y: 0 }, width: 360, height: 260, metadata: { smart: true, generationMode: "image", prompt: creation.prompt, composerContent: creation.prompt, model: creation.plan.imageModelsByKind.style || creation.plan.imageModel || undefined, status: "idle", generationType: "generation", count: 1, styleMother: true } }
                    : { type: "add_node", id: creation.imageNodeId, nodeType: "image", title: t("drama.createProjectStyleNode"), position: { x: 0, y: 0 }, width: 360, height: Math.max(220, Math.min(420, 360 * ((image?.height || 1) / Math.max(1, image?.width || 1)))), metadata: { content: image?.url, storageKey: image?.storageKey, status: "success", naturalWidth: image?.width, naturalHeight: image?.height, bytes: image?.bytes, mimeType: image?.mimeType, styleMother: true } };
                await applyBackendCanvasOperations(String(project.id), [node], Number(project.revision || 0), creation.operationId);
                if (creation.mode === "prompt") {
                    await startCanvasGeneration({ mode: "image", projectId: String(project.id), nodeId: creation.imageNodeId, model: creation.plan.imageModelsByKind.style || creation.plan.imageModel || undefined, prompt: creation.prompt, count: 1, clientTaskId: creation.taskKey, idempotencyKey: creation.taskKey });
                }
            }
            const episodeCount = autoEpisodes ? Number(creation.plan.topic?.episodes || 0) : 0;
            // 原文拆集不在建剧时做：原文与分集口径只进规划契约，建集统一在
            // 「剧目规划 · 原剧本」点「批量建集」，用的是同一份拆章结果，不做第二套。
            const split = splitSourceIntoEpisodes(creation.plan.sourceScript || "", creation.plan.sourceSplit);
            if (!split.groups.length) {
                for (let number = 1; number <= episodeCount; number += 1) {
                    try {
                        await createBackendDramaEpisode(creation.folderId, { episodeNumber: number });
                    } catch (error) {
                        message.warning(`${t("newDrama.episodeFailed", { number })}：${error instanceof Error ? error.message : String(error)}`);
                        break;
                    }
                }
            }
            void clearNewDramaDraft();
            if (handoff) {
                stashPlanningHandoff(creation.folderId, planningPrompt("outline", {
                    dramaId: creation.folderId,
                    name: creation.plan.topic?.logline ? `${name}` : name,
                    pendingEpisodes: Array.from({ length: episodeCount }, (_, index) => index + 1),
                }));
            }
            setCreateOpen(false);
            creationRef.current = undefined;
            // 嵌入新制作台时把新建的剧目 id 交回宿主，由宿主跳到新制作台（不跳老版 /production）。
            if (onCreated) { onCreated(creation.folderId); return; }
            // 有原文时落到「原剧本」页签：分集列表与批量建集就在那里，省掉找入口。
            const destination = split.groups.length
                ? `${dramaProjectDestination(creation.folderId, query.toString())}&workspace=series&seriesView=planning&seriesTab=source`
                : handoff
                    ? `${dramaProjectDestination(creation.folderId, query.toString())}&workspace=series&seriesView=planning`
                    : dramaProjectDestination(creation.folderId, query.toString());
            navigate(destination);
        } catch (error) {
            message.error(error instanceof Error ? error.message : String(error));
        } finally { setCreatingDrama(false); }
    };

    // 建集与界面用同一份拆章结果：原文只在文本变化时切一次，勾选与每集章数是廉价派生。
    const sourceAnalysis = useMemo(() => {
        const source = newDramaPlan.sourceScript || "";
        if (!source.trim()) return null;
        return analyzeNovelChapters(source, { maxChars: newDramaPlan.sourceSplit?.maxChars || NOVEL_MAX_CHARS, minChars: NOVEL_MIN_CHARS });
    }, [newDramaPlan.sourceScript, newDramaPlan.sourceSplit?.maxChars]);
    const splitPreview = useMemo(
        () => chaptersFromAnalysis(sourceAnalysis, { excluded: newDramaPlan.sourceSplit?.excluded, perEpisode: newDramaPlan.sourceSplit?.perEpisode }),
        [sourceAnalysis, newDramaPlan.sourceSplit],
    );
    const splitBlocked = splitPreview.groups.find(group => group.oversized);

    const updateAssetImageModel = (kind: keyof DramaProductionPlan["imageModelsByKind"], model: string) => setNewDramaPlan(current => ({
        ...current,
        imageModelsByKind: { ...current.imageModelsByKind, [kind]: model || undefined },
    }));

    // createOnly（嵌入新制作台，原文已写进草稿）：挂载即打开设置向导，自动回填草稿。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    useEffect(() => { if (createOnly && hydrated) void openCreateDrama(); }, [createOnly, hydrated]);

    return (
        <section className="text-foreground" aria-label={t("projects.drama")}>
            {!createOnly && (searchQuery === undefined ? (
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
            ))}
            {!createOnly && <section className="mt-6">
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
            </section>}
            <Modal
                width={760}
                open={createOpen}
                title={t("drama.createProject")}
                footer={null}
                maskClosable={false}
                onCancel={closeCreateDrama}
            >
                <div className="mb-4 flex flex-wrap items-center gap-2" data-new-drama-steps>
                    {NEW_DRAMA_STEPS.map((key, index) => <span key={key} data-new-drama-step-tab={key} data-state={index === wizardStep ? "current" : index < wizardStep ? "done" : "todo"}
                        className={index === wizardStep ? "rounded-full bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground" : index < wizardStep ? "rounded-full border border-primary/40 px-2.5 py-1 text-[11px] text-primary" : "rounded-full border border-border px-2.5 py-1 text-[11px] text-muted-foreground"}>
                        {index + 1} · {t(`newDrama.step.${key}`)}
                    </span>)}
                    {restoredDraft ? (
                        <span className="flex items-center gap-2 text-[11px] text-muted-foreground" data-new-drama-draft>
                            <span>{t("newDrama.draftRestored")}</span>
                            <button type="button" className="underline hover:text-foreground" onClick={discardDraft}>{t("newDrama.draftDiscard")}</button>
                        </span>
                    ) : null}
                </div>
                <div className="min-h-[320px]">
                <NewDramaWizard
                    step={wizardStep}
                    name={newDramaName} onName={setNewDramaName}
                    plan={newDramaPlan} onPlan={(patch) => setNewDramaPlan((current) => typeof patch === "function" ? patch(current) : { ...current, ...patch })}
                    styleMode={styleMode} onStyleMode={setStyleMode}
                    styleImageFile={styleImageFile} onStyleImageFile={setStyleImageFile}
                    stylePrompt={stylePrompt} onStylePrompt={setStylePrompt}
                    autoEpisodes={autoEpisodes} onAutoEpisodes={setAutoEpisodes}
                    handoff={handoff} onHandoff={setHandoff}
                    config={modelConfig}
                />
                </div>
                <div className="mt-5 border-t border-border pt-4">
                    <NewDramaFooter
                        step={wizardStep}
                        busy={creatingDrama}
                        valid={newDramaStepValid(wizardStep, { name: newDramaName, plan: newDramaPlan, styleMode, styleImageFile, stylePrompt }) && !splitBlocked}
                        blockedHint={wizardStep === 0 ? t("newDrama.needName") : wizardStep === 1 ? t("newDrama.needStyle") : splitBlocked ? t("newDrama.split.oversize", { label: splitBlocked.label, chars: splitBlocked.chars, limit: EPISODE_SOURCE_CHARS }) : undefined}
                        onPrev={() => setWizardStep((current) => Math.max(0, current - 1))}
                        onNext={() => setWizardStep((current) => Math.min(NEW_DRAMA_STEPS.length - 1, current + 1))}
                        onCreate={createDrama}
                        onCancel={closeCreateDrama}
                    />
                </div>
            </Modal>
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
