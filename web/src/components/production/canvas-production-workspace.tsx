import { useEffect, useState } from "react";
import { App, Button, Image, Select, Tag } from "antd";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { productionSceneEntries } from "@basketikun/canvas-agent/drama/production-contract";
import { fetchProductionCanvasContext, fetchBackendDramaEpisodes, ensureSharedAssetCanvas, fetchProductionSharedAssets, retryProductionSharedUpdate,
    type ApprovedSharedAsset, type SharedAssetUpdate, type DramaEpisode } from "@/services/backend-api";
import { productionTarget } from "@/lib/production-navigation";
import { useProductionWorkspaceStore } from "@/stores/use-production-workspace-store";
import { useProductionFollowStore } from "@/stores/use-production-follow-store";
import { useAgentStore } from "@/stores/use-agent-store";
import { useCanvasSidePanelStore } from "@/stores/use-canvas-side-panel-store";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { backendMediaUrl } from "@/services/backend-api";

export function useCanvasProductionContext(projectId: string) {
    const [query] = useSearchParams();
    const { message } = App.useApp();
    const productionKind = query.get("productionKind"), productionId = query.get("productionId");
    useEffect(() => {
        let active = true;
        useProductionWorkspaceStore.getState().setContext(null);
        void fetchProductionCanvasContext(projectId).then(({ context }) => {
            if (!active) return;
            if (!context.owner && productionKind === "canvas" && productionId === projectId) context = { ...context, role: "standalone", owner: { kind: "canvas", id: projectId } };
            useProductionWorkspaceStore.getState().setContext(context);
            if (context.owner) { useCanvasSidePanelStore.getState().openPanel(); useAgentStore.getState().openPanel(); }
        }).catch(error => { if (active) message.error(String(error)); });
        return () => {
            active = false;
            if (useProductionWorkspaceStore.getState().context?.canvasId === projectId) useProductionWorkspaceStore.getState().setContext(null);
        };
    }, [projectId, productionKind, productionId, message]);
}

export function CanvasProductionToolbar() {
    const context = useProductionWorkspaceStore(state => state.context);
    const presentation = useProductionWorkspaceStore(state => state.readiness?.presentation);
    const following = useProductionFollowStore(state => state.following);
    const followTarget = useProductionFollowStore(state => state.target);
    const { t } = useTranslation();
    const { message } = App.useApp();
    const navigate = useNavigate();
    const [episodes, setEpisodes] = useState<DramaEpisode[]>([]);
    useEffect(() => {
        let active = true; setEpisodes([]);
        if (context?.dramaId) void fetchBackendDramaEpisodes(context.dramaId).then(result => { if (active) setEpisodes(result.episodes || []); }).catch(error => { if (active) message.error(String(error)); });
        return () => { active = false; };
    }, [context?.dramaId, message]);
    if (!context?.owner) return null;
    const switchCanvas = async (id: string) => {
        useProductionFollowStore.getState().pause(t("productionCanvas.manualPause"));
        try {
            if (id === "shared") {
                const { project } = await ensureSharedAssetCanvas(context.dramaId!);
                navigate(`/canvas/${encodeURIComponent(String(project.id))}`);
            } else navigate(`/drama/episodes/${encodeURIComponent(id)}/production`);
        } catch (error) { message.error(String(error)); }
    };
    return <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-3 px-3 text-xs" data-canvas-shortcuts-ignore>
        {context.dramaId && <Select size="small" variant="borderless" aria-label={t("productionCanvas.switchCanvas")} value={context.role === "shared-assets" ? "shared" : context.episodeId}
            options={[{ value: "shared", label: t("productionCanvas.sharedCanvas") }, ...episodes.map(episode => ({ value: episode.id, label: `${t("productionCanvas.episode", { number: episode.episodeNumber })} · ${episode.title}` }))]}
            onChange={id => void switchCanvas(id)} />}
        <span className="min-w-0 flex-1 truncate">{presentation?.reason || presentation?.targetId || t("productionCanvas.ready")}</span>
        <Button type="text" size="small" onClick={() => {
            if (following) useProductionFollowStore.getState().pause(t("productionCanvas.manualPause"));
            else if (followTarget?.id === context.owner!.id) useProductionFollowStore.getState().resume();
            else if (presentation) { useProductionFollowStore.getState().setTarget({ ...context.owner!, workId: presentation.workId, runId: presentation.runId }); }
        }}>{t(following && followTarget?.id === context.owner.id ? "productionCanvas.pauseFollow" : "productionCanvas.follow")}</Button>
        <Button type="text" size="small" onClick={() => { useProductionWorkspaceStore.getState().setPanelTab("object"); useAgentStore.getState().openPanel(); const query = new URLSearchParams(window.location.search); query.set("workspace", "production"); navigate({ search: query.toString() }, { replace: true }); }}>{t("productionCanvas.tasks")}</Button>
    </div>;
}

export function ProductionDirectory() {
    const { context, production, readiness } = useProductionWorkspaceStore();
    const { t } = useTranslation();
    const navigate = useNavigate();
    const [query] = useSearchParams();
    const busy = useProductionWorkspaceStore(state => state.commandBusy);
    const canvasNodes = useCanvasStore(state => state.projects.find(project => project.id === context?.canvasId)?.nodes);
    if (!context?.owner || !production?.draft.director) return <div className="p-3 text-xs">{t("productionCanvas.ready")}</div>;
    const director = production.draft.director;
    const scenes = productionSceneEntries(director.source);
    const select = (workspace: string, kind: string, id: string) => {
        useProductionFollowStore.getState().pause(t("productionCanvas.manualPause"));
        const next = new URLSearchParams(query);
        next.set("workspace", workspace); next.set("target", `${kind}:${id}`); next.delete("nodeId"); next.delete("segmentId");
        const frameAsset = director.shotInputs[id]?.keyframeAssetId;
        const group = production.draft.clipGroups.find(item => kind === "segment" ? item.id === id : kind === "shot" && item.shotIds.includes(id));
        const nodeId = kind === "asset" ? director.assets[id]?.nodeId : kind === "scene" ? canvasNodes?.find(node => node.metadata?.productionSceneId === id)?.id : director.assets[frameAsset || ""]?.nodeId || group?.nodeId;
        if (nodeId) next.set("nodeId", nodeId);
        if (group?.segmentId && nodeId === group.nodeId) next.set("segmentId", group.segmentId);
        navigate({ search: next.toString() }, { replace: true });
        useProductionWorkspaceStore.getState().setPanelTab("object"); useAgentStore.getState().openPanel();
    };
    const prepare = (id: string) => window.dispatchEvent(new CustomEvent("production-workspace-command", { detail: { owner: context.owner, command: { kind: "prepare", targets: [id] } } }));
    const row = (kind: string, id: string, title: string, workspace: string, prepareId?: string) => {
        const status = readiness?.targets.find(item => item.id === `${kind === "shot" ? "frame" : kind}:${id}`)?.status;
        return <div key={`${kind}:${id}`} className="flex min-w-0 items-center gap-1 py-1" data-production-directory-target={`${kind}:${id}`}>
            <button type="button" className="min-w-0 flex-1 truncate rounded px-2 py-1 text-left text-xs hover:bg-black/5 dark:hover:bg-white/10" aria-current={query.get("target") === `${kind}:${id}` ? "true" : undefined} onClick={() => select(workspace, kind, id)}>{title}</button>
            {status && <span className="text-[10px] opacity-60">{t(`director.workspace.targetStatus.${status}`, { defaultValue: status })}</span>}
            {prepareId && <Button size="small" type="text" disabled={busy} onClick={() => void prepare(prepareId)}>{t("productionCanvas.prepare")}</Button>}
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
            {row("scene", scene.id, t("productionCanvas.script"), "story")}
            {scene.shotIds.map(id => row("shot", id, production.draft.shots.find(shot => shot.id === id)?.title || id, "shots", director.shotInputs[id]?.keyframeAssetId && !director.assets[director.shotInputs[id].keyframeAssetId!]?.nodeId ? `frame:${id}` : undefined))}
            {production.draft.clipGroups.filter(group => group.shotIds.some(id => scene.shotIds.includes(id))).map(group => row("segment", group.id, group.id, "production", `segment:${group.id}`))}
        </details>)}
        {!scenes.length && production.draft.clipGroups.map(group => row("segment", group.id, group.id, "production", `segment:${group.id}`))}
        {row("story", "advanced", t("productionCanvas.advanced"), "advanced")}
    </div>;
}

export function SharedAssetsPicker() {
    const { context, production } = useProductionWorkspaceStore();
    const { t } = useTranslation(); const { message } = App.useApp();
    const [assets, setAssets] = useState<ApprovedSharedAsset[]>([]), [updates, setUpdates] = useState<SharedAssetUpdate[]>([]);
    const [versions, setVersions] = useState<ApprovedSharedAsset[]>([]);
    const [query] = useSearchParams();
    const [assetId, setAssetId] = useState<string>(), [approvedId, setApprovedId] = useState<string>(), [busy, setBusy] = useState(false);
    const commandBusy = useProductionWorkspaceStore(state => state.commandBusy);
    const owner = context?.owner;
    const refresh = () => {
        if (owner) return fetchProductionSharedAssets(productionTarget(owner)).then(result => { setAssets(result.assets); setVersions(result.versions); setUpdates(result.updates); });
        return Promise.resolve();
    };
    useEffect(() => { let active = true; if (owner && ["episode", "shared-assets"].includes(context?.role || "")) void fetchProductionSharedAssets(productionTarget(owner)).then(result => { if (active) { setAssets(result.assets); setVersions(result.versions); setUpdates(result.updates); } }).catch(error => { if (active) message.error(String(error)); }); return () => { active = false; }; }, [owner?.kind, owner?.id, context?.role, production?.revision, message]);
    if (context?.role === "shared-assets") return <details className="mb-3 border-b border-border pb-3" data-canvas-shortcuts-ignore><summary className="cursor-pointer text-sm">{t("productionCanvas.approvedHistory")}</summary><div className="mt-2 space-y-3">{versions.filter(version => !query.get("target")?.startsWith("asset:") || version.assetId === query.get("target")?.slice(6)).map(version => <article key={version.id} className="flex items-start gap-3 text-xs"><Image width={64} src={backendMediaUrl(version.storageKey)} alt={version.snapshot.title} /><div className="min-w-0"><p>{version.snapshot.title} · v{version.sourceVersion}</p><p className="mt-1 break-words opacity-70">{version.evidence}</p></div></article>)}</div></details>;
    if (context?.role !== "episode" || !owner || !production?.draft.director) return null;
    const plan = Array.isArray(production.draft.director.source.asset_plan) ? production.draft.director.source.asset_plan as Record<string, any>[] : [];
    return <section className="mb-3 border-b border-border pb-3" data-canvas-shortcuts-ignore>
        <p className="mb-2 text-sm font-medium">{t("productionCanvas.adoptShared")}</p>
        <div className="flex flex-col gap-2">
            <Select aria-label={t("productionCanvas.targetAsset")} placeholder={t("productionCanvas.targetAsset")} value={assetId} onChange={setAssetId} options={plan.map(asset => ({ value: String(asset.asset_id || asset.id), label: String(asset.asset_name || asset.name || asset.asset_id || asset.id) }))} />
            <Select aria-label={t("productionCanvas.approvedAsset")} placeholder={t("productionCanvas.approvedAsset")} value={approvedId} onChange={setApprovedId} options={assets.map(asset => ({ value: asset.id, label: `${asset.snapshot.title} · v${asset.sourceVersion}` }))} />
            <Button type="text" disabled={!assetId || !approvedId || busy || commandBusy} onClick={() => window.dispatchEvent(new CustomEvent("production-workspace-command", { detail: { owner, command: { kind: "adopt", assetId: assetId!, approvedId: approvedId! } } }))}>{t("productionCanvas.adopt")}</Button>
        </div>
        {updates.filter(update => update.status === "blocked").map(update => <div key={update.id} className="mt-2 text-xs"><Tag>{t("productionCanvas.updateBlocked")}</Tag><p>{update.error}</p><Button type="text" size="small" disabled={busy || commandBusy} onClick={async () => { setBusy(true); try { await retryProductionSharedUpdate(productionTarget(owner), update.id, production.revision); await refresh(); } catch (error) { message.error(String(error)); } finally { setBusy(false); } }}>{t("productionCanvas.retryUpdate")}</Button></div>)}
    </section>;
}
