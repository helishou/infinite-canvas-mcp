import { useCanvasRoute, useCanvasHost } from "@/lib/canvas/canvas-host";
import { useEffect, useState } from "react";
import { App, Button, Dropdown, Input, Modal, Select, Tag } from "antd";
import { ArrowLeft, Check, ChevronDown, Clapperboard, Pencil, Search } from "lucide-react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { productionSceneEntries, type ProductionOperation } from "@basketikun/canvas-agent/drama/production-contract";
import { fetchProductionCanvasContext, fetchBackendDramaEpisodes, ensureEpisodeCanvas, ensureSharedAssetCanvas, fetchProductionSharedAssets,
    fetchBackendCanvasFolders, type ApprovedSharedAsset, type DramaEpisode } from "@/services/backend-api";
import { productionTarget } from "@/lib/production-navigation";
import { productionSegments, productionShots, productionSegmentRuntimeMatches, segmentShotIds, shotTitle } from "@/lib/production-source";
import { MediaImage } from "@/components/media/media-image";
import { useProductionWorkspaceStore } from "@/stores/use-production-workspace-store";
import { useProductionFollowStore } from "@/stores/use-production-follow-store";
import { useAgentStore } from "@/stores/use-agent-store";
import { useCanvasSidePanelStore } from "@/stores/use-canvas-side-panel-store";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { canvasThemes } from "@/lib/canvas-theme";
import { backendMediaUrl, fetchProductionSceneArchives, type ProductionSceneArchive } from "@/services/backend-api";

export function useCanvasProductionContext(projectId: string) {
    const { search: query } = useCanvasRoute();
    const { message } = App.useApp();
    const productionKind = query.get("productionKind"), productionId = query.get("productionId");
    useEffect(() => {
        let active = true;
        if (useProductionWorkspaceStore.getState().context?.canvasId !== projectId) useProductionWorkspaceStore.getState().setContext(null);
        useCanvasSidePanelStore.setState({ panelOpen: false, panelMounted: false, panelClosing: false });
        const agent = useAgentStore.getState();
        // Collapsing the dialog only changes its presentation; LocalAgentPanel and its active turn stay mounted.
        if (agent.panelOpen) agent.closePanel();
        void fetchProductionCanvasContext(projectId).then(({ context }) => {
            if (!active) return;
            if (context.role === "standalone" && !(productionKind === "canvas" && productionId === projectId)) context = { role: "ordinary", canvasId: projectId };
            if (!context.owner && productionKind === "canvas" && productionId === projectId) context = { ...context, role: "standalone", owner: { kind: "canvas", id: projectId } };
            useProductionWorkspaceStore.getState().setContext(context);
            if (context.owner && query.get("edit") === "1") {
                useProductionWorkspaceStore.getState().setPanelTab("object");
                useAgentStore.getState().openPanel();
            }
        }).catch(error => { if (active) message.error(String(error)); });
        return () => { active = false; };
    }, [projectId, productionKind, productionId, message]);
    // Release the snapshot on canvas departure, not on same-canvas context refreshes.
    useEffect(() => () => {
        if (useProductionWorkspaceStore.getState().context?.canvasId === projectId) useProductionWorkspaceStore.getState().setContext(null);
    }, [projectId]);
}

export function CanvasProductionToolbar() {
    const context = useProductionWorkspaceStore(state => state.context);
    const { t } = useTranslation();
    const { message } = App.useApp();
    const { navigate } = useCanvasRoute();
    const { search: query } = useCanvasRoute();
    // 制作画布覆盖层里已有「收起画布」（收起后就是工作台），返回按钮只在独立打开的画布页保留。
    const overlayHost = useCanvasHost();
    const theme = canvasThemes[useThemeStore(state => state.theme)];
    const [directoryOpen, setDirectoryOpen] = useState(false);
    const [filter, setFilter] = useState("");
    const [episodes, setEpisodes] = useState<DramaEpisode[]>([]);
    const [dramaName, setDramaName] = useState("");
    const [switching, setSwitching] = useState(false);
    const folderName = useCanvasStore(state => state.folders.find(folder => folder.id === context?.dramaId)?.name);
    useEffect(() => {
        let active = true; setEpisodes([]); setDramaName(folderName || "");
        if (context?.dramaId) {
            void fetchBackendDramaEpisodes(context.dramaId).then(result => { if (active) setEpisodes(result.episodes || []); }).catch(error => { if (active) message.error(String(error)); });
            if (!folderName) void fetchBackendCanvasFolders().then(result => { if (active) setDramaName(String(result.folders?.find(folder => folder.id === context.dramaId)?.name || "")); }).catch(error => { if (active) message.error(String(error)); });
        }
        return () => { active = false; };
    }, [context?.dramaId, folderName, message]);
    if (!context?.owner) return null;
    const currentEpisode = episodes.find(episode => episode.id === context.episodeId);
    const canvasLabel = context.role === "shared-assets" ? t("productionCanvas.sharedCanvas")
        : currentEpisode ? t("productionCanvas.episode", { number: currentEpisode.episodeNumber }) : t("productionCanvas.loadingEpisodes");
    const switchCanvas = async (id: string) => {
        if (switching || id === context.episodeId || id === "shared" && context.role === "shared-assets") return;
        setSwitching(true);
        if (!overlayHost?.switchProductionCanvas) {
            useProductionFollowStore.getState().pause(t("productionCanvas.manualPause"));
            useAgentStore.getState().closePanel();
        }
        try {
            if (id === "shared") {
                const canvasId = context.sharedAssetCanvasId || String((await ensureSharedAssetCanvas(context.dramaId!)).project.id);
                if (overlayHost?.switchProductionCanvas) overlayHost.switchProductionCanvas({ projectId: canvasId, dramaId: context.dramaId!, keepCanvasOpen: true });
                else navigate(`/canvas/${encodeURIComponent(canvasId)}`);
            } else {
                const episode = episodes.find(episode => episode.id === id);
                const canvasId = episode?.canvasId || String((await ensureEpisodeCanvas(id)).project.id);
                if (!episode?.canvasId) setEpisodes(current => current.map(episode => episode.id === id ? { ...episode, canvasId } : episode));
                if (overlayHost?.switchProductionCanvas) overlayHost.switchProductionCanvas({ projectId: canvasId, dramaId: context.dramaId!, episodeId: id, keepCanvasOpen: true });
                else navigate(`/canvas/${encodeURIComponent(canvasId)}`);
            }
        } catch (error) { message.error(String(error)); }
        finally { setSwitching(false); }
    };
    return <div className="flex min-w-0 items-center gap-1 text-xs" data-canvas-shortcuts-ignore>
        {!overlayHost && context.dramaId && <Link to={`/production?dramaId=${encodeURIComponent(context.dramaId)}&workspace=series`} aria-label={t("productionCanvas.backDrama")} title={t("productionCanvas.backDrama")} className="grid size-7 shrink-0 place-items-center rounded hover:bg-black/5 dark:hover:bg-white/10" style={{ color: theme.node.text }} onClick={() => useProductionFollowStore.getState().pause(t("productionCanvas.manualPause"))}><ArrowLeft className="size-4" /></Link>}
        {context.dramaId && <Dropdown trigger={["click"]} menu={{ selectedKeys: [context.role === "shared-assets" ? "shared" : context.episodeId || ""], items: [
            { key: "shared", label: t("productionCanvas.sharedCanvas"), icon: context.role === "shared-assets" ? <Check className="size-4" /> : undefined, onClick: () => void switchCanvas("shared") },
            { type: "divider" },
            ...episodes.map(episode => ({ key: episode.id, label: `${t("productionCanvas.episode", { number: episode.episodeNumber })} · ${episode.title}`, icon: episode.id === context.episodeId ? <Check className="size-4" /> : undefined, onClick: () => void switchCanvas(episode.id) })),
        ] }}><button type="button" disabled={switching} data-production-canvas-picker aria-label={t("productionCanvas.switchCanvas")} className="inline-flex min-w-0 max-w-[200px] items-center gap-2 px-2 py-1.5 text-sm hover:bg-black/5 sm:max-w-[420px] dark:hover:bg-white/10" style={{ color: theme.node.text }}>
            <Clapperboard className="size-4 shrink-0" /><span className="hidden max-w-48 truncate sm:inline">{dramaName || t("productionCanvas.drama")}</span><span className="hidden opacity-40 sm:inline">/</span>
            <span className="truncate">{canvasLabel}</span><ChevronDown className="size-3.5 shrink-0" />
        </button></Dropdown>}
        <Button type="text" size="small" icon={<Search className="size-3.5" />} aria-label={t("productionCanvas.find")} onClick={() => { useAgentStore.getState().closePanel(); useCanvasSidePanelStore.getState().closePanel(); setDirectoryOpen(true); }}><span className="hidden sm:inline">{t("productionCanvas.find")}</span></Button>
        <Modal title={t("productionCanvas.find")} open={directoryOpen} onCancel={() => setDirectoryOpen(false)} footer={null} width={520} styles={{ body: { maxHeight: "calc(100dvh - 220px)", overflow: "auto", color: theme.node.text } }}>
            <Input allowClear prefix={<Search className="size-4" />} value={filter} onChange={event => setFilter(event.target.value)} placeholder={t("productionCanvas.findPlaceholder")} aria-label={t("productionCanvas.findPlaceholder")} />
            <ProductionDirectory filter={filter} onLocate={() => setDirectoryOpen(false)} />
        </Modal>
    </div>;
}

export function ProductionDirectory({ filter = "", onLocate }: { filter?: string; onLocate?: () => void } = {}) {
    const { context, production, readiness } = useProductionWorkspaceStore();
    const { t } = useTranslation();
    const { navigate } = useCanvasRoute();
    const { search: query } = useCanvasRoute();
    const busy = useProductionWorkspaceStore(state => state.commandBusy);
    const { modal } = App.useApp();
    const canvasProject = useCanvasStore(state => state.projects.find(project => project.id === context?.canvasId));
    const canvasNodes = canvasProject?.nodes;
    const [archives, setArchives] = useState<ProductionSceneArchive[]>([]);
    useEffect(() => {
        let active = true;
        if (!context?.owner || !production?.draft.director) { setArchives([]); return () => { active = false; }; }
        void fetchProductionSceneArchives(productionTarget(context.owner)).then(result => { if (active) setArchives(result.archives); }).catch(() => { if (active) setArchives([]); });
        return () => { active = false; };
    }, [context?.owner?.kind, context?.owner?.id, production?.revision]);
    if (!context?.owner || !production?.draft.director) return <div className="p-3 text-xs">{t("productionCanvas.ready")}</div>;
    const director = production.draft.director;
    const scenes = productionSceneEntries(director.source);
    const sourceShots = productionShots(production);
    const sourceSegments = productionSegments(production);
    const select = (workspace: string, kind: string, id: string, edit = false) => {
        useProductionFollowStore.getState().pause(t("productionCanvas.manualPause"));
        const next = new URLSearchParams(query);
        next.set("workspace", workspace); next.set("target", `${kind}:${id}`); next.delete("nodeId"); next.delete("segmentId");
        if (kind === "scene") { next.delete("edit"); next.delete("workId"); next.delete("runId"); }
        const frameAsset = director.shotInputs[id]?.keyframeAssetId;
        const segment = sourceSegments.find(item => kind === "segment" ? item.id === id : kind === "shot" && segmentShotIds(item).includes(id));
        const runtimeMatches = segment && context?.owner && canvasNodes
            ? productionSegmentRuntimeMatches(canvasNodes as any, String(segment.id), context.owner) : [];
        const runtime = runtimeMatches.length === 1 ? runtimeMatches[0] : undefined;
        const nodeId = kind === "asset" ? director.assets[id]?.nodeId : kind === "scene" ? canvasNodes?.find(node => node.type === "text" && node.metadata?.productionScriptSceneId === id)?.id : director.assets[frameAsset || ""]?.nodeId || runtime?.node.id;
        if (nodeId) next.set("nodeId", nodeId);
        if (runtime?.segment.id && nodeId === runtime.node.id) next.set("segmentId", String(runtime.segment.id));
        navigate({ search: next.toString() }, { replace: true });
        onLocate?.();
        if (kind === "scene") { useAgentStore.getState().closePanel(); }
        else if (edit || !nodeId || kind === "story") { useProductionWorkspaceStore.getState().setPanelTab("object"); useAgentStore.getState().openPanel(); }
    };
    const prepare = (id: string) => { onLocate?.(); window.dispatchEvent(new CustomEvent("production-workspace-command", { detail: { owner: context.owner, command: { kind: "prepare", targets: [id] } } })); };
    const submitEdit = (op: ProductionOperation) => {
        if (!canvasProject) return;
        onLocate?.();
        window.dispatchEvent(new CustomEvent("production-workspace-command", { detail: { owner: context.owner, command: { kind: "edit", ops: [op] } } }));
    };
    const confirmArchive = (sceneId: string, title: string) => modal.confirm({ title: t("productionCanvas.archiveSceneConfirm", { scene: title }), okText: t("productionCanvas.archiveScene"), okType: "danger", cancelText: t("common.cancel"), onOk: () => submitEdit({ type: "archive_director_scene", sceneId, expectedCanvasRevision: Number(canvasProject?.revision || 0), confirmed: true }) });
    const confirmRestore = (archive: ProductionSceneArchive) => modal.confirm({ title: t("productionCanvas.restoreSceneConfirm", { scene: archive.sceneTitle }), okText: t("productionCanvas.restoreScene"), cancelText: t("common.cancel"), onOk: () => submitEdit({ type: "restore_director_scene", archiveId: archive.archiveId, expectedCanvasRevision: Number(canvasProject?.revision || 0) }) });
    const confirmClipDelete = (segmentId: string, title: string) => modal.confirm({ title: t("productionCanvas.deleteClipConfirm", { clip: title }), okText: t("productionCanvas.deleteClip"), okType: "danger", cancelText: t("common.cancel"), onOk: () => submitEdit({ type: "delete_director_clip", segmentId, expectedCanvasRevision: Number(canvasProject?.revision || 0), confirmed: true }) });
    const row = (kind: string, id: string, title: string, workspace: string, prepareId?: string) => {
        if (filter.trim() && !`${id} ${title}`.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase())) return null;
        const status = readiness?.targets.find(item => item.id === `${kind === "shot" ? "frame" : kind}:${id}`)?.status;
        return <div key={`${kind}:${id}`} className="flex min-w-0 items-center gap-1 py-1" data-production-directory-target={`${kind}:${id}`}>
            <button type="button" className="min-w-0 flex-1 truncate rounded px-2 py-1 text-left text-xs hover:bg-black/5 dark:hover:bg-white/10" aria-current={query.get("target") === `${kind}:${id}` ? "true" : undefined} onClick={() => select(workspace, kind, id)}>{title}</button>
            {status && <span className="text-[10px] opacity-60">{t(`director.workspace.targetStatus.${status}`, { defaultValue: status })}</span>}
            {prepareId && <Button size="small" type="text" disabled={busy} onClick={() => void prepare(prepareId)}>{t("productionCanvas.prepare")}</Button>}
            {kind === "segment" && <Button size="small" type="text" danger disabled={busy || !canvasProject} onClick={() => confirmClipDelete(id, title)}>{t("productionCanvas.deleteClip")}</Button>}
            {!prepareId && kind !== "scene" && <Button size="small" type="text" icon={<Pencil className="size-3" />} aria-label={t("productionCanvas.editNamed", { name: title })} onClick={() => select(workspace, kind, id, true)} />}
        </div>;
    };
    const plan = Array.isArray(director.source.asset_plan) ? director.source.asset_plan as Record<string, any>[] : [];
    return <div className="h-full overflow-auto p-2" data-canvas-shortcuts-ignore>
        {row("story", "brief", t("productionCanvas.story"), "story")}
        <details open><summary className="px-2 py-2 text-xs font-medium">{t("productionCanvas.assets")}</summary>
            {plan.filter(asset => !Object.values(director.shotInputs).some(input => input.keyframeAssetId === String(asset.asset_id || asset.id))).map(asset => { const id = String(asset.asset_id || asset.id); return row("asset", id, String(asset.asset_name || asset.name || asset.title || id), "assets", director.assets[id]?.nodeId ? undefined : `asset:${id}`); })}
        </details>
        {scenes.map((scene, index) => <details key={scene.id} open><summary className="px-2 py-2 text-xs font-medium">{index + 1}. {scene.title}
            <Button type="text" size="small" disabled={busy} onClick={event => { event.preventDefault(); event.stopPropagation(); window.dispatchEvent(new CustomEvent("production-workspace-command", { detail: { owner: context.owner, command: { kind: "arrange", sceneId: scene.id } } })); }}>{t("productionCanvas.arrange")}</Button>
            <Button type="text" size="small" danger disabled={busy || !canvasProject} onClick={event => { event.preventDefault(); event.stopPropagation(); confirmArchive(scene.id, scene.title); }}>{t("productionCanvas.archiveScene")}</Button></summary>
            {row("scene", scene.id, t("productionCanvas.script"), "story")}
            {scene.shotIds.map(id => row("shot", id, shotTitle(sourceShots.find(shot => String(shot.id) === id), id), "shots", director.shotInputs[id]?.keyframeAssetId && !director.assets[director.shotInputs[id].keyframeAssetId!]?.nodeId ? `frame:${id}` : undefined))}
            {sourceSegments.filter(segment => segmentShotIds(segment).some(id => scene.shotIds.includes(id))).map(segment => row("segment", String(segment.id), t("productionCanvas.clip", { number: sourceSegments.indexOf(segment) + 1 }), "production", `segment:${segment.id}`))}
        </details>)}
        {archives.some(archive => !filter.trim() || `${archive.sceneId} ${archive.sceneTitle}`.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase())) && <details className="mt-2" data-production-archived-scenes>
            <summary className="px-2 py-2 text-xs font-medium">{t("productionCanvas.archivedScenes")}</summary>
            {archives.filter(archive => !filter.trim() || `${archive.sceneId} ${archive.sceneTitle}`.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase())).map(archive => <div key={archive.archiveId} className="flex min-w-0 items-center gap-1 py-1 text-xs">
                <span className="min-w-0 flex-1 truncate px-2" title={archive.sceneId}>{archive.sceneTitle}</span>
                <span className="text-[10px] opacity-60">{t("productionCanvas.archiveCounts", { shots: archive.shotCount, clips: archive.clipCount, expires: new Date(archive.expiresAt).toLocaleString() })}</span>
                <Button size="small" type="text" disabled={busy || !canvasProject} onClick={() => confirmRestore(archive)}>{t("productionCanvas.restoreScene")}</Button>
            </div>)}
        </details>}
        {!scenes.length && sourceSegments.map((segment, index) => row("segment", String(segment.id), t("productionCanvas.clip", { number: index + 1 }), "production", `segment:${segment.id}`))}
        {row("story", "advanced", t("productionCanvas.advanced"), "advanced")}
    </div>;
}

export function SharedAssetsPicker() {
    const { context } = useProductionWorkspaceStore();
    const { t } = useTranslation(); const { message } = App.useApp();
    const [versions, setVersions] = useState<ApprovedSharedAsset[]>([]);
    const { search: query } = useCanvasRoute();
    const owner = context?.owner;
    useEffect(() => { let active = true; if (owner && context?.role === "shared-assets") void fetchProductionSharedAssets(productionTarget(owner)).then(result => { if (active) setVersions(result.versions); }).catch(error => { if (active) message.error(String(error)); }); return () => { active = false; }; }, [owner?.kind, owner?.id, context?.role, message]);
    if (context?.role === "shared-assets") return <details className="mb-3 border-b border-border pb-3" data-canvas-shortcuts-ignore><summary className="cursor-pointer text-sm">{t("productionCanvas.sharedVersionHistory")}</summary><div className="mt-2 space-y-3">{versions.filter(version => !query.get("target")?.startsWith("asset:") || version.assetId === query.get("target")?.slice(6)).map(version => <article key={version.id} className="flex items-start gap-3 text-xs"><MediaImage className="w-16" src={backendMediaUrl(version.storageKey)} alt={version.snapshot.title} /><div className="min-w-0"><p>{version.snapshot.title} · v{version.sourceVersion}</p></div></article>)}</div></details>;
    return null;
}
