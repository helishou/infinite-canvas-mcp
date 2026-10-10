import { useCanvasRoute, useCanvasHost } from "@/lib/canvas/canvas-host";
import { useEffect, useState } from "react";
import { App, Button, Dropdown, Input, Modal, Select, Tag } from "antd";
import { ArrowLeft, Check, ChevronDown, Clapperboard, Pencil, Search, Settings2 } from "lucide-react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { productionSceneEntries } from "@basketikun/canvas-agent/drama/production-contract";
import { fetchProductionCanvasContext, fetchBackendDramaEpisodes, ensureSharedAssetCanvas, fetchProductionSharedAssets, retryProductionSharedUpdate,
    fetchBackendCanvasFolders, type ApprovedSharedAsset, type SharedAssetUpdate, type DramaEpisode } from "@/services/backend-api";
import { productionTarget } from "@/lib/production-navigation";
import { MediaImage } from "@/components/media/media-image";
import { dramaWorkbenchPath } from "@/pages/drama/workbench-entry";
import { useProductionWorkspaceStore } from "@/stores/use-production-workspace-store";
import { useProductionFollowStore } from "@/stores/use-production-follow-store";
import { useAgentStore } from "@/stores/use-agent-store";
import { useCanvasSidePanelStore } from "@/stores/use-canvas-side-panel-store";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { canvasThemes } from "@/lib/canvas-theme";
import { backendMediaUrl } from "@/services/backend-api";

export function useCanvasProductionContext(projectId: string) {
    const { search: query } = useCanvasRoute();
    const { message } = App.useApp();
    const productionKind = query.get("productionKind"), productionId = query.get("productionId");
    useEffect(() => {
        let active = true;
        if (useProductionWorkspaceStore.getState().context?.canvasId !== projectId) useProductionWorkspaceStore.getState().setContext(null);
        useCanvasSidePanelStore.setState({ panelOpen: false, panelMounted: false, panelClosing: false });
        const agent = useAgentStore.getState();
        if (!agent.creativeLaunch && !agent.sending && !agent.waiting && !agent.prompt.trim() && !agent.attachments.length && !agent.canvasReferences.length) agent.closePanel();
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
        useProductionFollowStore.getState().pause(t("productionCanvas.manualPause"));
        useAgentStore.getState().closePanel();
        try {
            if (id === "shared") {
                const { project } = await ensureSharedAssetCanvas(context.dramaId!);
                navigate(`/canvas/${encodeURIComponent(String(project.id))}`);
            } else navigate(dramaWorkbenchPath(context.dramaId!, id));
        } catch (error) { message.error(String(error)); }
        finally { setSwitching(false); }
    };
    const editWorkspace = (workspace: string) => {
        setDirectoryOpen(false);
        useAgentStore.getState().closePanel();
        const next = new URLSearchParams(query); next.set("workspace", workspace);
        next.delete("target"); next.delete("nodeId"); next.delete("segmentId");
        navigate({ search: next.toString() }, { replace: true });
        useProductionWorkspaceStore.getState().setPanelTab("object");
        useAgentStore.getState().openPanel();
    };
    return <div className="flex min-w-0 items-center gap-1 text-xs" data-canvas-shortcuts-ignore>
        {!overlayHost && context.dramaId && <Link to={`/production?dramaId=${encodeURIComponent(context.dramaId)}&workspace=series`} aria-label={t("productionCanvas.backDrama")} title={t("productionCanvas.backDrama")} className="grid size-7 shrink-0 place-items-center rounded hover:bg-black/5 dark:hover:bg-white/10" style={{ color: theme.node.text }} onClick={() => useProductionFollowStore.getState().pause(t("productionCanvas.manualPause"))}><ArrowLeft className="size-4" /></Link>}
        {context.dramaId && <Dropdown trigger={["click"]} menu={{ selectedKeys: [context.role === "shared-assets" ? "shared" : context.episodeId || ""], items: [
            { key: "shared", label: t("productionCanvas.sharedCanvas"), icon: context.role === "shared-assets" ? <Check className="size-4" /> : undefined, onClick: () => void switchCanvas("shared") },
            { type: "divider" },
            ...episodes.map(episode => ({ key: episode.id, label: `${t("productionCanvas.episode", { number: episode.episodeNumber })} · ${episode.title}`, icon: episode.id === context.episodeId ? <Check className="size-4" /> : undefined, onClick: () => void switchCanvas(episode.id) })),
            { type: "divider" }, { key: "history", label: t("productionCanvas.advanced"), onClick: () => editWorkspace("advanced") },
        ] }}><button type="button" disabled={switching} data-production-canvas-picker aria-label={t("productionCanvas.switchCanvas")} className="inline-flex min-w-0 max-w-[200px] items-center gap-2 px-2 py-1.5 text-sm hover:bg-black/5 sm:max-w-[420px] dark:hover:bg-white/10" style={{ color: theme.node.text }}>
            <Clapperboard className="size-4 shrink-0" /><span className="hidden max-w-48 truncate sm:inline">{dramaName || t("productionCanvas.drama")}</span><span className="hidden opacity-40 sm:inline">/</span>
            <span className="truncate">{canvasLabel}</span><ChevronDown className="size-3.5 shrink-0" />
        </button></Dropdown>}
        <Button type="text" size="small" icon={<Search className="size-3.5" />} aria-label={t("productionCanvas.find")} onClick={() => { useAgentStore.getState().closePanel(); useCanvasSidePanelStore.getState().closePanel(); setDirectoryOpen(true); }}><span className="hidden sm:inline">{t("productionCanvas.find")}</span></Button>
        <span className="hidden md:inline-flex"><Button type="text" size="small" icon={<Settings2 className="size-3.5" />} aria-label={t("productionCanvas.advanced")} onClick={() => editWorkspace("advanced")} /></span>
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
    const canvasNodes = useCanvasStore(state => state.projects.find(project => project.id === context?.canvasId)?.nodes);
    if (!context?.owner || !production?.draft.director) return <div className="p-3 text-xs">{t("productionCanvas.ready")}</div>;
    const director = production.draft.director;
    const scenes = productionSceneEntries(director.source);
    const select = (workspace: string, kind: string, id: string, edit = false) => {
        useProductionFollowStore.getState().pause(t("productionCanvas.manualPause"));
        const next = new URLSearchParams(query);
        next.set("workspace", workspace); next.set("target", `${kind}:${id}`); next.delete("nodeId"); next.delete("segmentId");
        if (kind === "scene") { next.delete("edit"); next.delete("workId"); next.delete("runId"); }
        const frameAsset = director.shotInputs[id]?.keyframeAssetId;
        const group = production.draft.clipGroups.find(item => kind === "segment" ? item.id === id : kind === "shot" && item.shotIds.includes(id));
        const nodeId = kind === "asset" ? director.assets[id]?.nodeId : kind === "scene" ? canvasNodes?.find(node => node.type === "text" && node.metadata?.productionScriptSceneId === id)?.id : director.assets[frameAsset || ""]?.nodeId || group?.nodeId;
        if (nodeId) next.set("nodeId", nodeId);
        if (group?.segmentId && nodeId === group.nodeId) next.set("segmentId", group.segmentId);
        navigate({ search: next.toString() }, { replace: true });
        onLocate?.();
        if (kind === "scene") { useAgentStore.getState().closePanel(); }
        else if (edit || !nodeId || kind === "story") { useProductionWorkspaceStore.getState().setPanelTab("object"); useAgentStore.getState().openPanel(); }
    };
    const prepare = (id: string) => { onLocate?.(); window.dispatchEvent(new CustomEvent("production-workspace-command", { detail: { owner: context.owner, command: { kind: "prepare", targets: [id] } } })); };
    const row = (kind: string, id: string, title: string, workspace: string, prepareId?: string) => {
        if (filter.trim() && !`${id} ${title}`.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase())) return null;
        const status = readiness?.targets.find(item => item.id === `${kind === "shot" ? "frame" : kind}:${id}`)?.status;
        return <div key={`${kind}:${id}`} className="flex min-w-0 items-center gap-1 py-1" data-production-directory-target={`${kind}:${id}`}>
            <button type="button" className="min-w-0 flex-1 truncate rounded px-2 py-1 text-left text-xs hover:bg-black/5 dark:hover:bg-white/10" aria-current={query.get("target") === `${kind}:${id}` ? "true" : undefined} onClick={() => select(workspace, kind, id)}>{title}</button>
            {status && <span className="text-[10px] opacity-60">{t(`director.workspace.targetStatus.${status}`, { defaultValue: status })}</span>}
            {prepareId && <Button size="small" type="text" disabled={busy} onClick={() => void prepare(prepareId)}>{t("productionCanvas.prepare")}</Button>}
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
            <Button type="text" size="small" disabled={busy} onClick={event => { event.preventDefault(); event.stopPropagation(); window.dispatchEvent(new CustomEvent("production-workspace-command", { detail: { owner: context.owner, command: { kind: "arrange", sceneId: scene.id } } })); }}>{t("productionCanvas.arrange")}</Button></summary>
            {row("scene", scene.id, t("productionCanvas.script"), "story", canvasNodes?.some(node => node.type === "text" && node.metadata?.productionScriptSceneId === scene.id) ? undefined : `scene:${scene.id}`)}
            {scene.shotIds.map(id => row("shot", id, production.draft.shots.find(shot => shot.id === id)?.title || id, "shots", director.shotInputs[id]?.keyframeAssetId && !director.assets[director.shotInputs[id].keyframeAssetId!]?.nodeId ? `frame:${id}` : undefined))}
            {production.draft.clipGroups.filter(group => group.shotIds.some(id => scene.shotIds.includes(id))).map(group => row("segment", group.id, t("productionCanvas.clip", { number: production.draft.clipGroups.indexOf(group) + 1 }), "production", `segment:${group.id}`))}
        </details>)}
        {!scenes.length && production.draft.clipGroups.map((group, index) => row("segment", group.id, t("productionCanvas.clip", { number: index + 1 }), "production", `segment:${group.id}`))}
        {row("story", "advanced", t("productionCanvas.advanced"), "advanced")}
    </div>;
}

export function SharedAssetsPicker() {
    const { context, production } = useProductionWorkspaceStore();
    const { t } = useTranslation(); const { message } = App.useApp();
    const [assets, setAssets] = useState<ApprovedSharedAsset[]>([]), [updates, setUpdates] = useState<SharedAssetUpdate[]>([]);
    const [versions, setVersions] = useState<ApprovedSharedAsset[]>([]);
    const { search: query } = useCanvasRoute();
    const [assetId, setAssetId] = useState<string>(), [approvedId, setApprovedId] = useState<string>(), [busy, setBusy] = useState(false);
    const commandBusy = useProductionWorkspaceStore(state => state.commandBusy);
    const owner = context?.owner;
    const refresh = () => {
        if (owner) return fetchProductionSharedAssets(productionTarget(owner)).then(result => { setAssets(result.assets); setVersions(result.versions); setUpdates(result.updates); });
        return Promise.resolve();
    };
    useEffect(() => { let active = true; if (owner && ["episode", "shared-assets"].includes(context?.role || "")) void fetchProductionSharedAssets(productionTarget(owner)).then(result => { if (active) { setAssets(result.assets); setVersions(result.versions); setUpdates(result.updates); } }).catch(error => { if (active) message.error(String(error)); }); return () => { active = false; }; }, [owner?.kind, owner?.id, context?.role, production?.revision, message]);
    if (context?.role === "shared-assets") return <details className="mb-3 border-b border-border pb-3" data-canvas-shortcuts-ignore><summary className="cursor-pointer text-sm">{t("productionCanvas.approvedHistory")}</summary><div className="mt-2 space-y-3">{versions.filter(version => !query.get("target")?.startsWith("asset:") || version.assetId === query.get("target")?.slice(6)).map(version => <article key={version.id} className="flex items-start gap-3 text-xs"><MediaImage className="w-16" src={backendMediaUrl(version.storageKey)} alt={version.snapshot.title} /><div className="min-w-0"><p>{version.snapshot.title} · v{version.sourceVersion}</p><p className="mt-1 break-words opacity-70">{version.evidence}</p></div></article>)}</div></details>;
    if (context?.role !== "episode" || !owner || !production?.draft.director) return null;
    const plan = Array.isArray(production.draft.director.source.asset_plan) ? production.draft.director.source.asset_plan as Record<string, any>[] : [];
    return <section className="mb-3 border-b border-border pb-3" data-canvas-shortcuts-ignore>
        <p className="mb-2 text-sm font-medium">{t("productionCanvas.adoptShared")}</p>
        <div className="flex flex-col gap-2">
            <Select aria-label={t("productionCanvas.targetAsset")} placeholder={t("productionCanvas.targetAsset")} value={assetId} onChange={setAssetId} options={plan.map(asset => ({ value: String(asset.asset_id || asset.id), label: String(asset.asset_name || asset.name || asset.asset_id || asset.id) }))} />
            <Select aria-label={t("productionCanvas.approvedAsset")} placeholder={t("productionCanvas.approvedAsset")} value={approvedId} onChange={setApprovedId} options={assets.map(asset => ({ value: asset.id, label: `${asset.snapshot.title} · v${asset.sourceVersion} · ${t(`productionCanvas.reviewStatus.${asset.reviewStatus}`)}` }))} />
            <Button type="text" disabled={!assetId || !approvedId || busy || commandBusy} onClick={() => window.dispatchEvent(new CustomEvent("production-workspace-command", { detail: { owner, command: { kind: "adopt", assetId: assetId!, approvedId: approvedId! } } }))}>{t("productionCanvas.adopt")}</Button>
        </div>
        {updates.filter(update => update.status === "blocked").map(update => <div key={update.id} className="mt-2 text-xs"><Tag>{t("productionCanvas.updateBlocked")}</Tag><p>{update.error}</p><Button type="text" size="small" disabled={busy || commandBusy} onClick={async () => { setBusy(true); try { await retryProductionSharedUpdate(productionTarget(owner), update.id, production.revision); await refresh(); } catch (error) { message.error(String(error)); } finally { setBusy(false); } }}>{t("productionCanvas.retryUpdate")}</Button></div>)}
    </section>;
}
