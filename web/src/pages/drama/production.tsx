import { ensureCanvasProjectLoaded, flushCanvasProjectBeforeGeneration } from "@/stores/canvas/use-canvas-store";
import { withH3ParameterEdits } from "@basketikun/canvas-agent/plugins/minimax-h3/runtime-params";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, App, Button, Input, Select, Tag } from "antd";
import { Activity, ArrowLeft, Clapperboard, ExternalLink, FileText, Image, ListChecks, PackageOpen, Settings2 } from "lucide-react";
import localforage from "localforage";
import { nanoid } from "nanoid";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams, useSearchParams, createSearchParams } from "react-router-dom";
import { directorModules, isSubjectPromptAssembly, productionSceneEntries, type ProductionOperation } from "@basketikun/canvas-agent/drama/production-contract";
import { backendConnection } from "@/lib/backend-connection";
import { ensureCanvasDraftLease, getCanvasDraftSessionId } from "@/lib/canvas/canvas-draft-session";
import { exportAchengDeliveryBundle } from "@/lib/acheng-delivery-export";
import { ACHENG_CANVAS_LANGUAGE_RULE } from "@/lib/agent/creative-launch";
import { useAgentStore } from "@/stores/use-agent-store";
import { useProductionFollowStore } from "@/stores/use-production-follow-store";
import { useProductionWorkspaceStore } from "@/stores/use-production-workspace-store";
import { useWorkbenchCanvas, useCanvasHost } from "@/lib/canvas/canvas-host";
import { WorkbenchCanvas } from "./workbench-canvas";
import { productionCanvasNodes, type ProductionCanvasSnapshot } from "./production-canvas-nodes";
import { readShotFormDraft, shotFormChanges, shotDraftSourceChanged } from "./subject-shot-draft";
import { startSingleFlightPoller } from "@/lib/single-flight-poll";
import { productionObjectPath, type ProductionObject } from "@/lib/production-object";
import { applyBackendCanvasEvent, useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { SharedAssetsPicker } from "@/components/production/canvas-production-workspace";
import {
  submitProductionSceneAction, type ProductionSceneAction, BackendApiError, editEpisodeProduction, previewEpisodeProductionImpact,
  fetchBackendCanvasDrama, fetchBackendDramaEpisode, fetchBackendDramaEpisodes, fetchBackendProject, fetchEpisodeProduction,
  fetchEpisodeProductionLegacy, fetchEpisodeProductionVersions, fetchProductionBatch, fetchProductionBatches,
  fetchProductionReadiness, pauseProductionBatch, publishEpisodeProduction, restoreEpisodeProduction,
  checkProductionContinuity, fetchProductionContinuity, previewProductionContinuityUpgrade, type ProductionContinuity,
  resumeProductionBatch, startProductionRun, type DramaEpisode, type EpisodeProduction,
  type ProductionBatch, type ProductionReadiness, type ProductionTarget, type ProductionCanvasContext,
  prepareProductionTargets, arrangeProductionScene, adoptProductionSharedAsset, ensureSharedAssetCanvas, fetchProductionCanvasContext,
  previewProductionSharedAssetPromotion, promoteExistingProductionSharedAsset,
  backendMediaUrl, startCanvasGeneration, fetchBackendTasks, type BackendRuntimeTask,
} from "@/services/backend-api";
import { DirectorPanel, type DirectorWorkspace, type AssetReview } from "./director-panel";
import { DramaManagePanel } from "./manage-panel";
import "./production.css";
import { registerProductionPromptEditor, sourceSegmentForCanvasClip } from "@/lib/canvas/production-editing";
import { dramaWorkbenchEpisode, dramaWorkbenchPath } from "./workbench-entry";
import { commandNeedsRecovery } from "./production-command-recovery";

type PendingCommand = { operationId: string; expectedRevision: number; status: "unknown" | "rejected"; error?: string; httpStatus?: number; errorCode?: string; workspace?: DirectorWorkspace } & (
  { kind: "scene"; command: ProductionSceneAction } | { kind: "edit"; ops: ProductionOperation[] } | { kind: "publish"; stage: "director" } | { kind: "restore"; version: number }
  | { kind: "prepare"; targets: string[] } | { kind: "arrange"; sceneId: string } | { kind: "adopt"; assetId: string; approvedId: string }
);
type PendingRunStart = { inputBasis?: "canvas" | "published"; expectedCanvasRevision?: number; expectedPlanHash?: string; runId: string; idempotencyKey: string; workId?: string; expectedRevision: number; version: number; targets: string[]; scope: "selected" | "all_ready" };
type LocalDraft = { brief?: string; sourceDrafts?: Record<string, string>; remoteRevision: number | null; pendingCommand?: PendingCommand | null; pendingRunStart?: PendingRunStart | null };
type LegacySource = { source: "fullPlot" | "script.md" | "storyboard.md"; sha256: string; text: string };
type VersionItem = { version: number; stage: string; createdAt: string };
const localDrafts = localforage.createInstance({ name: "episode-production-drafts", storeName: "unfinished" });
let draftWrites: Promise<unknown> = Promise.resolve();
function writeLocalDraft(key: string, value: LocalDraft | null) {
  const write = draftWrites.catch(() => undefined).then(async () => { if (value) await localDrafts.setItem(key, value); else await localDrafts.removeItem(key); });
  draftWrites = write;
  return write;
}
const workspaces: Array<{ key: DirectorWorkspace; icon: typeof ListChecks }> = [
  { key: "series", icon: Clapperboard },
  { key: "assets", icon: PackageOpen },
  { key: "overview", icon: ListChecks }, { key: "story", icon: FileText },
  { key: "shots", icon: Clapperboard }, { key: "continuity", icon: Activity },
  { key: "production", icon: Image }, { key: "advanced", icon: Settings2 },
];
/** 页签分组：剧目 / 角色与素材是全剧产物（全局），概览及之后是本集产物，设置与历史单独一组。 */
const workspaceScope = (key: DirectorWorkspace) => key === "advanced" ? "settings" : key === "series" || key === "assets" ? "series" : "episode";

export default function ProductionRoute({ dramaId }: { dramaId?: string } = {}) {
  const [query, setQuery] = useSearchParams(), navigate = useNavigate(), { t } = useTranslation();
  const [episodeRead, setEpisodeRead] = useState<{ dramaId: string; episodes?: DramaEpisode[]; error?: string }>();
  const refreshEpisodes = useCallback(() => {
    if (!dramaId) return;
    void fetchBackendDramaEpisodes(dramaId).then(result => { setEpisodeRead({ dramaId, episodes: result.episodes || [] }); })
      .catch(error => { setEpisodeRead({ dramaId, error: error instanceof Error ? error.message : String(error) }); });
  }, [dramaId]);
  useEffect(() => { refreshEpisodes(); }, [refreshEpisodes]);
  const episodes = dramaId && episodeRead?.dramaId === dramaId ? episodeRead.episodes : undefined;
  const requestedEpisodeId = query.get("episodeId");
  // URL 指向的分集已不存在（如在「剧目」页签中被删除）时清理地址，避免刷新后一直带回退逻辑。
  useEffect(() => {
    if (!dramaId || !episodes || !requestedEpisodeId) return;
    if (episodes.some(item => item.id === requestedEpisodeId)) return;
    const next = new URLSearchParams(query);
    next.delete("episodeId");
    setQuery(next, { replace: true });
  }, [dramaId, episodes, requestedEpisodeId, query, setQuery]);
  if (!dramaId) return <ProductionEditor />;
  const error = episodeRead?.dramaId === dramaId ? episodeRead.error : undefined;
  if (error) return <Alert className="m-6" type="error" message={t("director.loadFailed")} description={error} />;
  if (!episodes) return <div className="p-6">{t("drama.production.loading")}</div>;
  let selected;
  try { selected = dramaWorkbenchEpisode(episodes, requestedEpisodeId); }
  catch {
    // 请求的分集已不存在：回退到第一集，不再报「分集不属于当前剧目」。
    if (!episodes.length) return <SeriesSetupWorkbench dramaId={dramaId} onEpisodesChanged={refreshEpisodes} />;
    selected = dramaWorkbenchEpisode(episodes, null);
  }
  if (!selected) return <SeriesSetupWorkbench dramaId={dramaId} onEpisodesChanged={refreshEpisodes} />;
  return <ProductionEditor key={selected.id} owner={{ kind: "episode", id: selected.id }} series={{ id: dramaId, episodes }} onSeriesEpisodesChanged={refreshEpisodes} />;
}

/** 没有任何分集的剧目：直接落在工作台的「剧目」页签，规划完建分集即进入导演台。 */
function SeriesSetupWorkbench({ dramaId, onEpisodesChanged }: { dramaId: string; onEpisodesChanged: () => void }) {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const seriesName = useCanvasStore(state => state.folders.find(folder => folder.id === dramaId)?.name);
  return <main className="min-h-full bg-background px-4 py-4 text-foreground sm:px-6 lg:px-8">
    <div className="mx-auto max-w-[1440px]">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3"><Button type="text" icon={<ArrowLeft className="size-4" />} onClick={() => navigate("/production")}>{t("director.back")}</Button><div><h1 className="text-xl font-semibold tracking-tight sm:text-2xl">{seriesName || t("director.atomic.seriesWorkbench")}</h1><p className="mt-1 text-xs text-muted-foreground">{t("director.atomic.emptyDrama")}</p></div></div>
      </div>
      <aside className="min-w-0 border-b border-border">
        <nav aria-label={t("director.workspace.navigation")} className="flex w-full gap-1 overflow-x-auto py-2">
          <button type="button" aria-label={t("director.workspace.tab.series")} aria-current="page"
            className="flex min-h-11 shrink-0 items-center gap-2 rounded-lg border border-border bg-muted px-3 py-2 text-left text-sm font-medium text-foreground"
          ><Clapperboard className="size-4 shrink-0" /><span className="whitespace-nowrap">{t("director.workspace.tab.series")}</span></button>
        </nav>
      </aside>
      <section className="min-w-0 py-6">
        <DramaManagePanel dramaId={dramaId} onEpisodesChanged={onEpisodesChanged} />
      </section>
    </div>
  </main>;
}

type ProductionEditorProps = { owner?: ProductionCanvasContext["owner"]; embedded?: boolean; dialog?: boolean; series?: { id: string; episodes: DramaEpisode[] }; onSeriesEpisodesChanged?: () => void };
export function ProductionEditor(props: ProductionEditorProps) {
  const params = useParams();
  if (props.embedded) return <ProductionEditorContent {...props} />;
  return <WorkbenchCanvas key={`${props.owner?.kind || ""}:${props.owner?.id || params.episodeId || params.projectId || ""}`}><ProductionEditorContent {...props} /></WorkbenchCanvas>;
}
function ProductionEditorContent({ owner, embedded = false, dialog = false, series, onSeriesEpisodesChanged }: ProductionEditorProps) {
  const canvasHost = useWorkbenchCanvas();
  const surfaceHost = useCanvasHost();
  const params = useParams();
  const seriesName = useCanvasStore(state => state.folders.find(folder => folder.id === series?.id)?.name);
  const episodeId = owner?.kind === "episode" ? owner.id : owner ? "" : params.episodeId || "";
  const projectId = owner?.kind === "canvas" ? owner.id : owner ? "" : params.projectId || "";
  const contextProjectId = projectId;
  const [routeSearchParams, routeSetSearchParams] = useSearchParams();
  const searchParams = embedded && surfaceHost ? surfaceHost.search : routeSearchParams;
  const setSearchParams: typeof routeSetSearchParams = embedded && surfaceHost ? (next, options) => surfaceHost.navigate({ search: createSearchParams(typeof next === "function" ? next(searchParams) : next).toString() }, options) : routeSetSearchParams;
  const returnToDramas = searchParams.get("from") === "dramas" || Boolean(episodeId);
  const backPath = returnToDramas ? "/production" : "/director";
  const target = useMemo<ProductionTarget>(() => projectId ? { projectId } : episodeId, [projectId, episodeId]);
  const productionOwner = useMemo(() => owner || (projectId ? { kind: "canvas" as const, id: projectId } : { kind: "episode" as const, id: episodeId }), [owner, projectId, episodeId]);
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { message, modal } = App.useApp();
  const [title, setTitle] = useState("");
  const [canvasId, setCanvasId] = useState(projectId);
  const [productionContext, setProductionContext] = useState<ProductionCanvasContext | null>(null);
  const [episode, setEpisode] = useState<DramaEpisode | null>(null);
  const [canvasRead, setCanvasRead] = useState<ProductionCanvasSnapshot>();
  const liveCanvas = useCanvasStore(state => state.projects.find(project => project.id === canvasId));
  const canvasNodes = productionCanvasNodes(canvasId, liveCanvas, canvasRead);
  const [production, setProduction] = useState<EpisodeProduction | null>(null);
  const [readiness, setReadiness] = useState<ProductionReadiness | null>(null);
  const [continuityReport, setContinuityReport] = useState<ProductionContinuity | undefined>();
  const [continuitySnapshot, setContinuitySnapshot] = useState<"draft" | "published">("draft");
  const [legacy, setLegacy] = useState<LegacySource[]>([]);
  const [versions, setVersions] = useState<VersionItem[]>([]);
  const [batches, setBatches] = useState<ProductionBatch[]>([]);
  const [runtimeTasks, setRuntimeTasks] = useState<BackendRuntimeTask[]>([]);
  const [workspace, setWorkspace] = useState<DirectorWorkspace>("overview");
  const [briefDraft, setBriefDraft] = useState("");
  const priorFormalBrief = useRef<string | null>(null);
  const [sourceDrafts, setSourceDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [agentError, setAgentError] = useState("");
  const [remoteRevision, setRemoteRevision] = useState<number | null>(null);
  const [draftKey, setDraftKey] = useState<string | null>(null);
  const [commandNotice, setPendingCommand] = useState<PendingCommand | null>(null);
  const commandNoticeRef = useRef<PendingCommand | null>(null);
  const pendingCommand = commandNeedsRecovery(commandNotice) ? commandNotice : null;
  const pendingCommandRef = useRef<PendingCommand | null>(null);
  const [pendingRunStart, setPendingRunStart] = useState<PendingRunStart | null>(null);
  const pendingRunStartRef = useRef<PendingRunStart | null>(null);
  const startingRunRef = useRef(false);
  const handledAgentResultRef = useRef("");
  const setAgentState = useAgentStore(state => state.setAgentState);
  const agentTaskResult = useAgentStore(state => state.scopedTaskResult);
  const agentConversation = useAgentStore(state => state.conversation);
  const agentBusy = useAgentStore(state => state.sending || state.waiting);
  const pending = (value: PendingCommand | null) => { commandNoticeRef.current = value; pendingCommandRef.current = commandNeedsRecovery(value) ? value : null; setPendingCommand(value); };
  const setPendingRun = (value: PendingRunStart | null) => { pendingRunStartRef.current = value; setPendingRunStart(value); };
  const editorRootRef = useRef<HTMLElement>(null);
  const routeWorkspace = searchParams.get("workspace") as DirectorWorkspace | null;
  const routeTarget = searchParams.get("target") || "";
  const routeNodeId = searchParams.get("nodeId") || "";
  const routeSegmentId = searchParams.get("segmentId") || "";
  const routeWorkId = searchParams.get("workId") || "";

  const navigateWorkspace = (next: DirectorWorkspace, targetFocus?: { kind: string; id: string }) => {
    useProductionFollowStore.getState().pause("已手动切换导演工作区；自动跟随已暂停");
    setWorkspace(next);
    const query = new URLSearchParams(searchParams);
    query.set("workspace", next);
    query.delete("target"); query.delete("nodeId"); query.delete("segmentId");
    if (!embedded) { query.delete("runId"); query.delete("workId"); }
    if (targetFocus?.id) query.set("target", `${targetFocus.kind === "keyframe" ? "frame" : targetFocus.kind}:${targetFocus.id}`);
    setSearchParams(query, { replace: true });
  };
  const selectWorkspace = (next: DirectorWorkspace) => navigateWorkspace(next);

  const load = useCallback(async (isActive: () => boolean = () => true, preserveBrief = false) => {
    const contextRequest = projectId
        ? Promise.all([fetchBackendProject(projectId), fetchBackendCanvasDrama(projectId), fetchProductionCanvasContext(projectId)]).then(([canvas, relation, ownership]) => ({ canvas: canvas.project, episode: relation.episode, scene: null, productionContext: ownership.context }))
        : fetchBackendDramaEpisode(episodeId).then(result => {
          if (!result.episode) throw new Error(t("director.loadFailed"));
          const episode = result.episode;
          return { ...result, scene: null, productionContext: { role: "episode" as const, canvasId: episode.canvasId || "", episodeId: episode.id, dramaId: episode.dramaId, owner: { kind: "episode" as const, id: episode.id } } };
        });
    const [context, prod, old, history, ready, runHistory, continuity] = await Promise.all([
      contextRequest, fetchEpisodeProduction(target), fetchEpisodeProductionLegacy(target), fetchEpisodeProductionVersions(target),
      fetchProductionReadiness(target), fetchProductionBatches(target), fetchProductionContinuity(target),
    ]);
    const resolvedCanvasId = projectId || context.episode?.canvasId || "";
    const taskNodes = [...new Set([...(prod.production.draft.clipGroups || []).map(group => group.nodeId), ...Object.values(prod.production.draft.director?.assets || {}).map(asset => asset.nodeId)].filter((id): id is string => Boolean(id)))];
    const tasks = resolvedCanvasId && taskNodes.length ? (await fetchBackendTasks({ projectId: resolvedCanvasId, nodeIds: taskNodes })).tasks || [] : [];
    if (!isActive()) return null;
    setEpisode(context.episode || null);
    setProductionContext(context.productionContext);
    setTitle(context.episode?.title || String(context.canvas?.title || ""));
    setCanvasId(resolvedCanvasId);
    setCanvasRead(context.canvas && Array.isArray(context.canvas.nodes) ? { id: resolvedCanvasId, revision: Number(context.canvas.revision || 0), nodes: context.canvas.nodes as ProductionCanvasSnapshot["nodes"] } : undefined);
    setProduction(prod.production);
    setReadiness(ready.readiness);
    setContinuityReport(continuity.continuity);
    setLegacy(old.sources);
    setVersions(history.versions);
    setBatches(runHistory.runs);
    setRuntimeTasks(tasks);
    if (!preserveBrief) setBriefDraft(String(prod.production.draft.director?.source.brief || ""));
    setLoadError("");
    return context.episode?.id || (projectId ? `canvas:${projectId}` : episodeId);
  }, [target, projectId, contextProjectId, episodeId, t]);

  useEffect(() => {
    if (embedded && production) useProductionWorkspaceStore.getState().setSnapshot(productionOwner.id, production, readiness);
  }, [embedded, productionOwner.id, production, readiness]);
  useEffect(() => {
    if (!production) return;
    const remote = String(production.draft.director?.source.brief || "");
    const previous = priorFormalBrief.current;
    if (previous !== null && previous !== remote) setBriefDraft(current => current === previous ? remote : current);
    priorFormalBrief.current = remote;
  }, [production?.draft.director?.source.brief]);
  useEffect(() => {
    if (embedded && owner) useProductionWorkspaceStore.getState().setCommandBusy(productionOwner.id, busy || Boolean(pendingCommand));
  }, [embedded, owner, productionOwner.id, busy, pendingCommand]);
  useEffect(() => {
    if (embedded && owner) useProductionWorkspaceStore.getState().setRecoveryPending(productionOwner.id, Boolean(pendingCommand || pendingRunStart || remoteRevision !== null));
  }, [embedded, owner, productionOwner.id, pendingCommand, pendingRunStart, remoteRevision]);

  useEffect(() => {
    let active = true;
    void (async () => {
      await ensureCanvasDraftLease();
      const owner = await load(() => active);
      if (!owner || !active) return;
      const key = `${backendConnection().url}:${owner}:${getCanvasDraftSessionId()}`;
      await draftWrites.catch(() => undefined);
      const saved = await localDrafts.getItem<LocalDraft>(key);
      if (!active) return;
      if (saved) {
        const currentBrief = production?.draft.director?.source.brief;
        if (saved.brief !== undefined && saved.brief !== currentBrief) setBriefDraft(saved.brief);
        setSourceDrafts(saved.sourceDrafts || {});
        setRemoteRevision(saved.remoteRevision);
        pending(saved.pendingCommand || null);
        setPendingRun(saved.pendingRunStart || null);
      }
      setDraftKey(key);
    })().catch(error => { if (active) { setLoadError(String(error)); message.error(String(error)); } });
    return () => { active = false; };
  // The initial route key owns this recoverable local command and brief draft.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [episodeId, projectId, load, message]);

  useEffect(() => {
    if (!draftKey) return;
    const value: LocalDraft = { brief: briefDraft, sourceDrafts, remoteRevision, pendingCommand: commandNoticeRef.current, pendingRunStart: pendingRunStartRef.current };
    void (briefDraft.trim() || Object.keys(sourceDrafts).length || remoteRevision !== null || value.pendingCommand || value.pendingRunStart
      ? writeLocalDraft(draftKey, value)
      : writeLocalDraft(draftKey, null))
      .catch(error => message.error({ key: "episode-local-draft", content: error instanceof Error ? error.message : String(error) }));
  }, [draftKey, briefDraft, sourceDrafts, remoteRevision, commandNotice, pendingRunStart, message]);

  useEffect(() => {
    if (routeWorkspace === "series" ? !series : !workspaces.some(item => item.key === routeWorkspace)) return;
    if (routeWorkspace && workspace !== routeWorkspace) setWorkspace(routeWorkspace);
  }, [routeWorkspace, workspace, series?.id]);

  const storyboardSource = production?.draft.director?.source.shots;
  const storyboardCount = Array.isArray(storyboardSource) ? storyboardSource.length : 0;
  useEffect(() => {
    if (routeWorkspace || routeTarget || routeNodeId || routeSegmentId || productionContext?.role === "shared-assets") return;
    if (storyboardCount) setWorkspace("shots");
  }, [production?.episodeId, storyboardCount, routeWorkspace, routeTarget, routeNodeId, routeSegmentId, productionContext?.role]);

  useEffect(() => {
    if (!routeTarget && !routeNodeId && !routeSegmentId) return;
    let first = 0, second = 0;
    first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => {
        const root = embedded ? editorRootRef.current : document;
        if (embedded && useProductionWorkspaceStore.getState().panelTab !== "object") return;
        const direct = Array.from(root?.querySelectorAll<HTMLElement>("[data-production-target]") || []).find(element => element.dataset.productionTarget === routeTarget);
        if (direct) {
          const scroller = editorRootRef.current?.parentElement;
          if (embedded && scroller) scroller.scrollTop += direct.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 24;
          else direct.scrollIntoView({ block: "center", behavior: "smooth" });
        }
      });
    });
    return () => { cancelAnimationFrame(first); cancelAnimationFrame(second); };
  }, [workspace, routeTarget, routeNodeId, routeSegmentId, production, readiness]);

  useEffect(() => {
    if (!routeWorkId || !production || !canvasId) return;
    const owner = productionOwner;
    const active = useProductionFollowStore.getState().target;
    if (active?.workId !== routeWorkId || active.kind !== owner.kind || active.id !== owner.id) return;
    const reasons = Object.keys(sourceDrafts).length || briefDraft !== String(production.draft.director?.source.brief || "")
      ? "存在尚未保存的制作编辑" : pendingCommand ? t("productionHub.follow.pendingWrite") : pendingRunStart ? t("productionHub.follow.unknownRun") : exporting ? t("productionHub.follow.exportInProgress") : "";
    useProductionFollowStore.getState().setGuardReason("editor", reasons);
  }, [routeWorkId, projectId, episodeId, canvasId, production, sourceDrafts, briefDraft, pendingCommand, pendingRunStart, exporting, t]);

  const remoteSequence = useRef(0);
  useEffect(() => () => { remoteSequence.current++; useProductionFollowStore.getState().setGuardReason("editor", ""); }, [episodeId, projectId]);
  const refreshRemote = useCallback(async () => {
    const sequence = ++remoteSequence.current;
    const taskNodes = [...new Set([...(production?.draft.clipGroups || []).map(group => group.nodeId), ...Object.values(production?.draft.director?.assets || {}).map(asset => asset.nodeId)].filter((id): id is string => Boolean(id)))];
    const [prod, ready, history, runHistory, canvas, tasks, continuity] = await Promise.all([
      fetchEpisodeProduction(target), fetchProductionReadiness(target), fetchEpisodeProductionVersions(target), fetchProductionBatches(target),
      fetchBackendProject(canvasId).then(value => value.project).catch(() => null),
      canvasId && taskNodes.length ? fetchBackendTasks({ projectId: canvasId, nodeIds: taskNodes }).then(value => value.tasks || []) : Promise.resolve([]),
      fetchProductionContinuity(target, { snapshot: continuitySnapshot }),
    ]);
    if (sequence !== remoteSequence.current) return prod.production;
    setProduction(previous => !previous || previous.episodeId !== prod.production.episodeId || prod.production.revision > previous.revision ? prod.production : previous); setReadiness(ready.readiness); setContinuityReport(continuity.continuity); setVersions(history.versions); setBatches(runHistory.runs);
    setRuntimeTasks(tasks);
    if (canvas) setCanvasRead({ id: canvasId, revision: Number(canvas.revision || 0), nodes: (canvas.nodes || []) as ProductionCanvasSnapshot["nodes"] });
    return prod.production;
  }, [target, canvasId, continuitySnapshot, production?.draft.clipGroups, production?.draft.director?.assets]);

  useEffect(() => {
    const onProductionEvent = (event: Event) => {
      const value = (event as CustomEvent<{ type?: string; entityId?: string }>).detail;
      const aliases = new Set([projectId, episodeId, canvasId, episode?.id, episode?.canvasId, ...(readiness?.presentation?.aliases || [])].filter(Boolean));
      if (value?.type === "drama-production.updated" && value.entityId && aliases.has(value.entityId)) void refreshRemote();
    };
    window.addEventListener("backend-event", onProductionEvent);
    return () => window.removeEventListener("backend-event", onProductionEvent);
  }, [projectId, episodeId, canvasId, episode, readiness?.presentation?.aliases, refreshRemote]);

  const pollingTaskNodes = useMemo(() => [...new Set([...(production?.draft.clipGroups || []).map(group => group.nodeId), ...Object.values(production?.draft.director?.assets || {}).map(asset => asset.nodeId)].filter((id): id is string => Boolean(id)))], [production?.draft.clipGroups, production?.draft.director?.assets]);
  const pollingTaskNodesKey = JSON.stringify(pollingTaskNodes);
  const hasActiveSceneWork = production?.draft.director?.workflow.sharedReviewContinuation?.status === "active" || [...Object.values(production?.draft.director?.workflow.sceneWorks || {}), ...Object.values(production?.draft.director?.workflow.sharedReviewWorks || {})].some(work => ["pending", "running", "awaiting_media"].includes(work.status));
  const hasActiveClipRefresh = production?.clipRefreshes?.some(job => ["queued", "checking", "compiling", "applying"].includes(job.status)) || false;
  const hasActiveProductionWork = hasActiveSceneWork || hasActiveClipRefresh || batches.some(run => ["pending", "running"].includes(run.status)) || runtimeTasks.some(task => ["queued", "running", "awaiting_confirmation"].includes(task.status));
  useEffect(() => {
    if (!hasActiveProductionWork) return;
    let active = true;
    let lastReadinessPollAt = Date.now();
    const knownTaskStatuses = new Map(runtimeTasks.map(task => [task.id, task.status]));
    const refreshReadiness = async () => {
      try {
        const ready = await fetchProductionReadiness(target);
        if (!active) return;
        setReadiness(ready.readiness);
        lastReadinessPollAt = Date.now();
      } catch { /* Status events are advisory; the bounded poll remains the fallback. */ }
    };
    const poller = startSingleFlightPoller({
      intervalMs: 5000,
      initiallyPaused: document.hidden,
      poll: async () => {
        const [runs, tasks, sceneProduction] = await Promise.all([
          fetchProductionBatches(target),
          canvasId && pollingTaskNodes.length ? fetchBackendTasks({ projectId: canvasId, nodeIds: pollingTaskNodes }) : Promise.resolve({ tasks: [] as BackendRuntimeTask[] }),
          hasActiveSceneWork || hasActiveClipRefresh ? fetchEpisodeProduction(target) : Promise.resolve(undefined),
        ]);
        if (!active) return;
        const currentTasks = tasks.tasks || [];
        knownTaskStatuses.clear();
        for (const task of currentTasks) knownTaskStatuses.set(task.id, task.status);
        if (sceneProduction) setProduction(previous => !previous || sceneProduction.production.episodeId !== previous.episodeId || sceneProduction.production.revision > previous.revision
          || sceneProduction.production.revision === previous.revision && JSON.stringify(sceneProduction.production.clipRefreshes) !== JSON.stringify(previous.clipRefreshes) ? sceneProduction.production : previous);
        setBatches(runs.runs);
        setRuntimeTasks(currentTasks);
        if (!document.hidden && Date.now() - lastReadinessPollAt >= 15_000) await refreshReadiness();
      },
    });
    const onBackendEvent = (event: Event) => {
      if (document.hidden) return;
      const detail = (event as CustomEvent<{ type?: string; entityId?: string; payload?: BackendRuntimeTask }>).detail;
      const task = detail?.payload;
      if (detail?.type !== "task.updated" || !detail.entityId || !task || task.projectId !== canvasId) return;
      if (!knownTaskStatuses.has(detail.entityId) && (!task.nodeId || !pollingTaskNodes.includes(task.nodeId))) return;
      if (knownTaskStatuses.get(detail.entityId) === task.status) return;
      knownTaskStatuses.set(detail.entityId, task.status);
      poller.refreshNow();
      void refreshReadiness();
    };
    const onVisibilityChange = () => document.hidden ? poller.pause() : poller.resume();
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("backend-event", onBackendEvent);
    return () => {
      active = false;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("backend-event", onBackendEvent);
      poller.stop();
    };
  }, [hasActiveProductionWork, hasActiveSceneWork, target, canvasId, pollingTaskNodesKey]);

  const fail = (error: unknown) => {
    if (error instanceof BackendApiError && error.status === 409) {
      const current = error.details.current as EpisodeProduction | undefined;
      setRemoteRevision(current?.revision ?? null);
      message.warning(t("drama.production.conflict"));
    } else message.error(error instanceof Error ? error.message : String(error));
  };

  const setSourceDraft = (key: string, value: string | undefined) => {
    setSourceDrafts(current => {
      if (value === undefined) {
        if (!(key in current)) return current;
        const next = { ...current };
        delete next[key];
        return next;
      }
      if (current[key] === value) return current;
      return { ...current, [key]: value };
    });
  };

  const productionTargetLabel = (raw: string) => {
    const [kind, ...parts] = raw.split(":");
    const id = parts.length ? parts.join(":") : raw;
    const source = production?.draft.director?.source as Record<string, any> | undefined;
    const rows = (value: unknown): Record<string, any>[] => Array.isArray(value) ? value.filter(item => item && typeof item === "object") : value && typeof value === "object" ? Object.values(value as Record<string, any>) : [];
    const candidates = ["asset_plan", "script_scenes", "shots", "segments", "character_registry", "scene_registry"].flatMap(key => rows(source?.[key]));
    const match = candidates.find(item => [item.id, item.asset_id, item.scene_id, item.character_id].some(value => String(value || "") === id));
    const label = String(match?.asset_name || match?.scene_name || match?.title || match?.name || id);
    return parts.length ? `${kind} · ${label}` : label;
  };
  const pendingOperationDescription = (value: unknown) => {
    const op = value && typeof value === "object" ? value as Record<string, any> : {};
    const operation = String(op.type || "unknown");
    const labels: Record<string, string> = {
      upgrade_director_continuity: t("director.workspace.continuity.applyUpgrade"),
      adopt_director_clip_style: t("director.workspace.adoptClipStyle", { style: String(op.styleTemplateId || t("director.workspace.clipStyleNone")) }),
      patch_director_continuity: t("director.workspace.continuity.saveLedger"),
      review_director_asset: op.verdict === "rejected" ? t("director.workspace.returnAsset") : t("director.workspace.approve"),
      review_keyframe: t("director.workspace.review"),
      set_director_brief: t("director.workspace.saveBrief"),
      set_director_boundary: t("director.workspace.saveBoundary"),
    };
    const action = labels[operation] || t("drama.production.pendingOperation", { operation: operation.replaceAll("_", " ") });
    const target = String(op.assetId || op.sceneId || op.shotId || op.segmentId || op.targetId || op.id || op.scene?.id || op.shot?.id || op.group?.id || "");
    const boundary = op.boundary as Record<string, any> | undefined;
    const targetLabel = target ? productionTargetLabel(`${op.targetKind ? `${op.targetKind}:` : ""}${target}`) : boundary ? `${productionTargetLabel(String(boundary.from || ""))} → ${productionTargetLabel(String(boundary.to || ""))}` : "";
    return targetLabel ? t("drama.production.pendingOperationTarget", { action, target: targetLabel }) : action;
  };
  const pendingCommandDescription = (command: PendingCommand) => {
    if (command.kind === "edit") {
      const operations = command.ops.slice(0, 3).map(pendingOperationDescription).join("；");
      const more = command.ops.length > 3 ? t("drama.production.pendingMoreOperations", { count: command.ops.length - 3 }) : "";
      return `${t("drama.production.pendingCommandEdit")}: ${operations}${more}`;
    }
    if (command.kind === "publish") return t("drama.production.pendingCommandPublish", { stage: command.stage });
    if (command.kind === "restore") return t("drama.production.pendingCommandRestore", { version: command.version });
    if (command.kind === "prepare") return t("drama.production.pendingCommandPrepare", { targets: command.targets.map(productionTargetLabel).join("、") });
    if (command.kind === "arrange") return t("drama.production.pendingCommandArrange", { scene: productionTargetLabel(command.sceneId) });
    if (command.kind === "scene") return t(`sceneProduction.command.${command.command.action}`);
    return t("drama.production.pendingCommandAdopt", { asset: productionTargetLabel(command.assetId) });
  };
  const pendingCommandMessage = (command: PendingCommand) => t("drama.production.resolvePending", {
    action: pendingCommandDescription(command),
    status: t(command.status === "unknown" ? "drama.production.pendingStatusUnknown" : "drama.production.pendingStatusRejected"),
  });
  const warnPendingCommand = () => {
    const command = pendingCommandRef.current;
    message.warning(command ? pendingCommandMessage(command) : t("drama.production.commandInProgress"));
  };

  const sendCommand = async (input: PendingCommand) => {
    const command = { ...input, workspace: input.workspace || workspace };
    if (!draftKey) throw new Error(t("drama.production.draftNotReady"));
    await ensureCanvasDraftLease();
    const previous = pendingCommandRef.current;
    if (previous && (previous.operationId !== command.operationId || previous.status === "rejected")) throw new Error(pendingCommandMessage(previous));
    pendingCommandRef.current = command;
    await writeLocalDraft(draftKey, { brief: briefDraft, sourceDrafts, remoteRevision, pendingCommand: command, pendingRunStart } satisfies LocalDraft);
    pending(command);
    try {
      const result = command.kind === "scene" ? await submitProductionSceneAction(target, command.command, command.expectedRevision, command.operationId)
        : command.kind === "edit" ? await editEpisodeProduction(target, command.expectedRevision, command.ops, command.operationId)
        : command.kind === "publish" ? await publishEpisodeProduction(target, command.expectedRevision, command.stage, command.operationId)
        : command.kind === "prepare" ? await prepareProductionTargets(target, command.expectedRevision, command.targets, command.operationId)
        : command.kind === "arrange" ? await arrangeProductionScene(target, command.expectedRevision, command.sceneId, command.operationId)
        : command.kind === "adopt" ? await adoptProductionSharedAsset(target, { expectedRevision: command.expectedRevision, assetId: command.assetId, approvedId: command.approvedId, operationId: command.operationId })
        : await restoreEpisodeProduction(target, command.expectedRevision, command.version, command.operationId);
      if (!result.production || !Number.isInteger(result.production.revision)) throw new Error(t("drama.production.receiptMalformed"));
      pendingCommandRef.current = null;
      await writeLocalDraft(draftKey, { brief: briefDraft, sourceDrafts, remoteRevision: null, pendingCommand: null, pendingRunStart } satisfies LocalDraft);
      pending(null); setProduction(previous => !previous || previous.episodeId !== result.production.episodeId || result.production.revision > previous.revision ? result.production : previous); setRemoteRevision(null);
      return result.production;
    } catch (error) {
      const rejected = error instanceof BackendApiError && error.status >= 400 && error.status < 500 && error.status !== 408;
      const saved: PendingCommand = { ...command, status: rejected ? "rejected" : "unknown", error: error instanceof Error ? error.message : String(error),
        ...(error instanceof BackendApiError ? { httpStatus: error.status, errorCode: String(error.details.code || "") } : {}) };
      pending(saved);
      await writeLocalDraft(draftKey, { brief: briefDraft, sourceDrafts, remoteRevision, pendingCommand: saved, pendingRunStart } satisfies LocalDraft);
      throw error;
    }
  };

  const sendSceneCommand = async (command: ProductionSceneAction, expectedRevision: number) => {
    if (busy || pendingCommandRef.current || pendingRunStartRef.current) throw new Error(pendingCommandRef.current ? pendingCommandMessage(pendingCommandRef.current) : t("drama.production.commandInProgress"));
    setBusy(true);
    try { return await sendCommand({ kind: "scene", command: structuredClone(command), operationId: nanoid(), expectedRevision, status: "unknown" }); }
    finally { setBusy(false); }
  };

  const edit = async (ops: ProductionOperation[], revisionOverride?: number): Promise<boolean> => {
    if (!production || busy) return false;
    if (pendingCommandRef.current) { warnPendingCommand(); return false; }
    setBusy(true);
    try {
      await sendCommand({ kind: "edit", operationId: nanoid(), expectedRevision: revisionOverride ?? production.revision, ops: structuredClone(ops), status: "unknown" });
      await refreshRemote();
      return true;
    } catch (error) { fail(error); return false; }
    finally { setBusy(false); }
  };
  const workspaceCommandInFlight = useRef(false);
  const preparedScriptSource = useRef("");
  useEffect(() => {
    if (!embedded || !owner || !production || !draftKey) return;
    const receive = (event: Event) => {
      const detail = (event as CustomEvent<{ owner: NonNullable<ProductionCanvasContext["owner"]>; command: { kind: "prepare"; targets: string[] } | { kind: "arrange"; sceneId: string } | { kind: "adopt"; assetId: string; approvedId: string } }>).detail;
      if (!detail || detail.owner.kind !== owner.kind || detail.owner.id !== owner.id) return;
      if (pendingCommandRef.current) { warnPendingCommand(); return; }
      if (busy || workspaceCommandInFlight.current) { message.warning(t("drama.production.commandInProgress")); return; }
      workspaceCommandInFlight.current = true; setBusy(true);
      void (async () => {
        try { await sendCommand({ ...structuredClone(detail.command), operationId: nanoid(), expectedRevision: production.revision, status: "unknown" }); await refreshRemote(); }
        catch (error) { fail(error); }
        finally { workspaceCommandInFlight.current = false; setBusy(false); }
      })();
    };
    window.addEventListener("production-workspace-command", receive);
    return () => window.removeEventListener("production-workspace-command", receive);
  }, [embedded, owner?.kind, owner?.id, production, draftKey, busy, refreshRemote, message, t]);

  useEffect(() => {
    if (!embedded || !owner || !production?.draft.director || !draftKey || busy || pendingCommandRef.current || workspaceCommandInFlight.current) return;
    const key = `${owner.kind}:${owner.id}:${production.draft.director.sourceHash}`;
    if (preparedScriptSource.current === key) return;
    const targets = productionSceneEntries(production.draft.director.source).filter(scene => !canvasNodes.some(node => node.type === "text" && node.metadata?.productionScriptSceneId === scene.id)).map(scene => `scene:${scene.id}`);
    preparedScriptSource.current = key;
    if (targets.length) window.dispatchEvent(new CustomEvent("production-workspace-command", { detail: { owner, command: { kind: "prepare", targets } } }));
  }, [embedded, owner?.kind, owner?.id, production, draftKey, busy, canvasNodes]);

  const saveBrief = async (brief: string) => {
    if (busy || pendingCommandRef.current) return;
    setBriefDraft(brief);
    setBusy(true);
    try {
      const latest = await fetchEpisodeProduction(target).then(result => result.production);
      if (latest.draft.director?.source.brief === brief) { setProduction(latest); return; }
      await sendCommand({ kind: "edit", operationId: nanoid(), expectedRevision: latest.revision, ops: [{ type: "set_director_brief", brief }], status: "unknown" });
      await refreshRemote();
    } catch (error) { fail(error); }
    finally { setBusy(false); }
  };

  const publish = async () => {
    if (!production || busy) return;
    if (pendingCommandRef.current) return warnPendingCommand();
    setBusy(true);
    try {
      const { impact } = await previewEpisodeProductionImpact(target, "director");
      const command: PendingCommand = { kind: "publish", operationId: nanoid(), expectedRevision: production.revision, stage: "director", status: "unknown" };
      modal.confirm({
        title: t("drama.production.publishTitle"),
        content: <div className="space-y-1 text-sm">
          <p>{t("drama.production.impactSummary", { scenes: impact.changedSceneIds.length, shots: impact.affectedShotIds.length, images: impact.imageShotIds.length, clips: impact.clipGroupIds.length })}</p>
          {impact.assetIds?.length ? <p>{t("director.workspace.impactAssets", { count: impact.assetIds.length })}</p> : null}
          {impact.missingAssetNodeIds.length > 0 && <p className="text-amber-600">{t("drama.production.missingRefs", { count: impact.missingAssetNodeIds.length })}</p>}
        </div>,
        onOk: async () => {
          try {
            await sendCommand(command);
            await refreshRemote();
            message.success(t("drama.production.published"));
          } catch (error) { fail(error); throw error; }
        },
      });
    } catch (error) { fail(error); }
    finally { setBusy(false); }
  };

  const recoverPending = async () => {
    const command = pendingCommandRef.current || pendingCommand;
    if (!command || command.status !== "unknown" || busy) return;
    setBusy(true);
    try { await sendCommand(command); await refreshRemote(); message.success(t("drama.production.receiptRecovered")); }
    catch (error) { fail(error); }
    finally { setBusy(false); }
  };

  const resolveRejected = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await load(() => true, true);
      pendingCommandRef.current = null;
      if (draftKey) await writeLocalDraft(draftKey, { brief: briefDraft, sourceDrafts, remoteRevision: null, pendingCommand: null, pendingRunStart } satisfies LocalDraft);
      pending(null); setRemoteRevision(null);
    } catch (error) { fail(error); }
    finally { setBusy(false); }
  };

  const restoreVersion = (version: number) => {
    if (!production) return;
    if (pendingCommandRef.current) return warnPendingCommand();
    if (busy) return void message.warning(t("drama.production.commandInProgress"));
    const command: PendingCommand = { kind: "restore", operationId: nanoid(), expectedRevision: production.revision, version, status: "unknown" };
    modal.confirm({ title: t("drama.production.restoreTitle", { number: version }), onOk: async () => {
      try { await sendCommand(command); await refreshRemote(); } catch (error) { fail(error); throw error; }
    } });
  };

  const askDirector = async (scope: { workspace: DirectorWorkspace; targetId?: string; instruction?: string; brief?: string; workId?: string }) => {
    if (pendingCommandRef.current) return warnPendingCommand();
    const requestedBrief = scope.brief ?? briefDraft;
    let currentProduction = await fetchEpisodeProduction(target).then(result => result.production);
    if (requestedBrief !== String(currentProduction.draft.director?.source.brief || "")) {
      await saveBrief(requestedBrief);
      currentProduction = await fetchEpisodeProduction(target).then(result => result.production);
    }
    setProduction(currentProduction);
    const director = currentProduction.draft.director;
    if (!director) return message.error(t("director.workspace.engineUnavailable"));
    const storyboardImageMode = currentProduction.draft.settings.storyboardImageMode;
    if (String(director.source.brief || "") !== requestedBrief) return message.error(t("director.workspace.briefSaveFailed"));
    const agent = useAgentStore.getState();
    if (!agent.enabled || !agent.connected || !["ready", "warning"].includes(agent.conversation.status)) {
      useProductionWorkspaceStore.getState().setPanelTab("director");
      useAgentStore.getState().openPanel();
      return message.warning(t("director.workspace.agentDisconnected"));
    }
    if (agent.sending || agent.waiting || agent.loadingThreads || ["preparing", "running"].includes(agent.conversation.status)) return message.warning(t("director.workspace.agentBusy"));
    const moduleForWorkspace: Record<DirectorWorkspace, Array<(typeof directorModules)[number]>> = {
      series: [],
      overview: ["story", "assets", "shots", "performance", "effects", "model", "continuity"],
      story: ["story"], assets: ["assets"], shots: ["shots", "performance", "effects"], continuity: ["continuity"], production: ["model"], advanced: ["continuity"],
    };
    const readinessNow = await fetchProductionReadiness(target).then(result => result.readiness);
    setReadiness(readinessNow);
    const targetObject = scope.targetId ? readinessNow.targets.find(item => item.targetId === scope.targetId || item.id === scope.targetId) : undefined;
    const cursors = Object.fromEntries(moduleForWorkspace[scope.workspace].map(module => [module, director.modules[module]?.cursor ?? null]));
    const selectedModules = moduleForWorkspace[scope.workspace].join(", ");
    const drama = useCanvasStore.getState().folders.find(folder => folder.id === episode?.dramaId || folder.sharedAssetCanvasId === canvasId);
    const key = productionOwner.id;
    const id = nanoid();
    const ownerKind = productionOwner.kind;
    const followTarget = useProductionFollowStore.getState().target;
    const workId = scope.workId || (followTarget?.kind === ownerKind && followTarget.id === key ? followTarget.workId : nanoid());
    const text = [
      "$acheng-director",
      "这是导演工作台发起的独立阶段任务。按 Acheng 七模块规范完成本次范围，不把七个模块当成顺序关卡，不启动其他代理。涉及画布数据或媒体时，先读取项目 Skill canvas-video-production-sop 作为 Backend 与原生 MCP 适配；适配层不替代 Acheng 创作权属。",
      ACHENG_CANVAS_LANGUAGE_RULE,
      `制作对象：${key}；对象类型：${ownerKind}`,
      `Backend 正式 revision：${currentProduction.revision}；已发布版本：${currentProduction.publishedVersion}`,
      "本次创作、编译和校验使用本机当前激活的 Acheng 版本。先调用 production_get_contract 读取当前合同，不用制作记录中的历史引擎身份选择执行版本。",
      `本次工作区：${scope.workspace}；调用模块：${selectedModules}`,
      ...(scope.workspace === "continuity" ? ["开始 continuity 写入前，调用 production_get_contract({moduleId: \"continuity\"})，实际读取当前激活版本返回的模块入口与必读合同，再按该回执的 owner 规则修改源稿。当前 scope 必须有源哈希匹配的连续性覆盖及重放回执；诊断旧版只读，不自动迁移。"] : []),
      `分镜图模式：${storyboardImageMode || "尚未设置"}`,
      "若本对象尚未开始镜头设计且分镜图模式尚未设置，先通过正式 workflow.pendingDecisions 询问用户生成分镜图或跳过图片、只保留文字分镜；将答复写入正式 settings.storyboardImageMode（generate/skip）后再继续。skip 时保留文字 Shot、Segment 和 H3 提示词，所有 shotInputs.keyframePolicy 设为 none，不登记、准备或生成关键帧图片；角色、场景、道具等其他资产仍按制作需要处理。",
      `内容交付模式：${director.workflow.contentDeliveryMode || "auto_file_batch"}；媒体生产模式：${director.workflow.mediaProductionMode || "per_item"}`,
      `选中目标：${targetObject ? `${targetObject.kind}:${targetObject.targetId}` : scope.targetId || "当前工作区缺项"}`,
      `当前就绪回执：${targetObject ? `${targetObject.status}；${targetObject.blockers.join("；")}` : readinessNow.nextAction}`,
      `恢复游标：${JSON.stringify(cursors)}`,
      `持续制作 workId：${workId}。每次确认新工作目标后，通过 set_director_workflow 写入正式 currentWork，保持此 workId，并调用结构化 site_navigate({production:{kind:"${ownerKind}",id:"${key}",workId:"${workId}"}}) 呈现 Backend 当前阶段。不要凭聊天文本切页。`,
      "如需用户裁定创作选项，先回读当前 sourceHash，把问题、至少两个明确选项、目标、workId 和 sourceHash 写入 workflow.pendingDecisions；不要把问题只留在聊天中，也不要预选或自动批准。用户答复保存后，再从答复绑定的源稿继续。",
      `用户需求：${String(director.source.brief || requestedBrief)}`,
      scope.instruction ? `本次补充要求：${scope.instruction}` : "",
      drama ? `所属剧目：${drama.name}。全剧大纲：${drama.outline || "尚未填写"}。全剧制作要求：${drama.productionPlan?.requirements || "尚未填写"}。本集沿用其已保存的制作设置；不要因全剧默认值变更改写已有分集、共享批准版本或在途任务输入。` : "",
      "人工协作：定向读取目标时同时查看 canvasInputs 的当前画布内容、人工差异和导演基线。重新编译保留人工修改；只有用户明确指定的目标和字段可以采用导演更新。生成默认采用当前已保存内容，不要求为了手改重新发布。",
      "保留项：不覆盖已确认的源稿和未编辑字段；完整保存对白、参考职责、资产版本与工作流游标。只提交本次模块产物和编译证据，使用 Backend expectedRevision/operationId 处理写入冲突。",
      "媒体权限：本请求只授权创作、修订和编译，不授权图片或视频生成。只有用户在工作台点击生成目标时，才使用对应生产 runId；前段 MP4 不得自动加入输入。",
      "新合同局部修改固定走：读取 subject_workbench/shot_workbench/clip_workbench 并核对 targetStatus → 一次合并结构化源操作 → 消费 Backend 自动校验、编译和同步回执；不另手动重复编译或发布。旧合同走其兼容流程。发布和媒体生成独立执行，均不因自动刷新而推进。工具短回执不代表字段缺失，context 的 omittedSourceSections 和 ledgerSummary 指向需要另读的源条目；失败按诊断处理，源稿与状态未变不换键重提，未知响应恢复原 operationId 的回执。",
      "请先读取 Backend 正式制作稿、缺项与运行记录，再从此游标继续。聊天中说已完成不算提交；完成后回读 Backend 版本回执。",
    ].filter(Boolean).join("\n");
    handledAgentResultRef.current = "";
    setAgentError("");
    useProductionFollowStore.getState().setTarget({ kind: ownerKind, id: key, workId, threadId: director.workflow.agentThreadId || agent.activeThreadId || undefined });
    useProductionWorkspaceStore.getState().setPanelTab("director");
    setAgentState({
      panelOpen: true, panelMounted: true, activeTab: "chat", scopedTaskResult: null,
      scopedTask: { id, text, threadId: director.workflow.agentThreadId || agent.activeThreadId || undefined, productionId: key, revision: currentProduction.revision },
    });
  };

  const requestContinuityUpgradeFromAgent = async (instruction: string, workId?: string) => {
    const previousTaskId = useAgentStore.getState().scopedTask?.id;
    await askDirector({ workspace: "continuity", workId: workId || routeWorkId || undefined, instruction });
    const task = useAgentStore.getState().scopedTask;
    return task && task.id !== previousTaskId ? { id: task.id, threadId: task.threadId } : undefined;
  };

  const acceptRunStart = async (run: ProductionBatch) => {
    setBatches(current => [run, ...current.filter(item => item.runId !== run.runId)]);
    setPendingRun(null);
    pendingRunStartRef.current = null;
    if (draftKey) await writeLocalDraft(draftKey, { brief: briefDraft, sourceDrafts, remoteRevision, pendingCommand: commandNoticeRef.current, pendingRunStart: null } satisfies LocalDraft);
    message.success(t("director.workspace.runStarted"));
    const follow = useProductionFollowStore.getState();
    const owner = productionOwner;
    follow.setTarget({ ...owner, workId: follow.target?.workId || run.runId, runId: run.runId, threadId: follow.target?.threadId });
    follow.resume();
    if (embedded) useAgentStore.getState().closePanel();
    await refreshRemote();
    void fetchProductionBatches(target).then(value => setBatches(value.runs)).catch(() => undefined);
    void fetchProductionReadiness(target, { runId: run.runId }).then(value => setReadiness(value.readiness)).catch(() => undefined);
  };

  const startRun = async (targets: string[], scope: "selected" | "all_ready" = "selected") => {
    if (!production || !targets.length) return;
    if (startingRunRef.current) return;
    if (pendingRunStartRef.current) return void message.warning(t("director.workspace.runReceiptUnknown"));
    const active = batches.find(run => ["pending", "running", "paused", "awaiting_review"].includes(run.status) && run.targets.some(id => targets.includes(id)));
    if (active) return void message.warning(t("director.workspace.runTargetActive", { runId: active.runId }));
    if (!draftKey) return void message.warning(t("drama.production.draftNotReady"));
    if (Object.keys(sourceDrafts).length || briefDraft !== String(production.draft.director?.source.brief || "")) return void message.warning(t("productionHub.follow.saveEditsFirst"));
    if (!production.draft.director) return void message.warning(t("director.workspace.engineUnavailable"));
    startingRunRef.current = true;
    const runId = nanoid();
    try {
      const [targetKindRaw, ...targetParts] = targets[0].split(":");
      const targetId = targetParts.join(":");
      const targetKind: "keyframe" | "segment" | "asset" = targetKindRaw === "frame" ? "keyframe" : targetKindRaw === "segment" ? "segment" : "asset";
      if (canvasId) await flushCanvasProjectBeforeGeneration(canvasId);
      const latestSaved = await fetchEpisodeProduction(target).then(value => value.production);
      const workId = latestSaved.draft.director?.workflow.currentWork?.workId || nanoid();
      const currentWork = {
        workId, module: targetKind === "segment" ? "model" as const : "assets" as const, action: "produce" as const,
        targetKind, targetId, inputRevision: latestSaved.revision + 1, sourceHash: latestSaved.draft.director!.sourceHash,
      };
      if (!await edit([{ type: "set_director_workflow", patch: { currentWork } }], latestSaved.revision)) return;
      const focussedProduction = await fetchEpisodeProduction(target).then(value => value.production);
      setProduction(focussedProduction);
      setReadiness((await fetchProductionReadiness(target)).readiness);
      useProductionFollowStore.getState().setTarget({ ...productionOwner, workId, threadId: focussedProduction.draft.director?.workflow.agentThreadId || useAgentStore.getState().activeThreadId || undefined });
      const savedCanvas = canvasId ? (await fetchBackendProject(canvasId)).project : undefined;
      const request: PendingRunStart = { inputBasis: "canvas", expectedCanvasRevision: savedCanvas ? Number(savedCanvas.revision) : undefined, runId, idempotencyKey: runId, workId, expectedRevision: focussedProduction.revision, version: focussedProduction.publishedVersion, targets: [...targets], scope };
      setPendingRun(request);
      pendingRunStartRef.current = request;
      await writeLocalDraft(draftKey, { brief: briefDraft, sourceDrafts, remoteRevision, pendingCommand: commandNoticeRef.current, pendingRunStart: request } satisfies LocalDraft);
      const result = await startProductionRun(target, request);
      await acceptRunStart(result.run);
    } catch (error) {
      if (error instanceof BackendApiError && error.status >= 400 && error.status < 500) {
        setPendingRun(null);
        pendingRunStartRef.current = null;
        await writeLocalDraft(draftKey, { brief: briefDraft, sourceDrafts, remoteRevision, pendingCommand: commandNoticeRef.current, pendingRunStart: null } satisfies LocalDraft);
      }
      fail(error);
    }
    finally { startingRunRef.current = false; }
  };

  const recoverRunStart = async () => {
    const request = pendingRunStartRef.current;
    if (!request || startingRunRef.current) return;
    startingRunRef.current = true;
    try {
      const existing = await fetchProductionBatch(target, request.runId).then(result => result.run);
      const run = existing || (await startProductionRun(target, request)).run;
      await acceptRunStart(run);
    } catch (error) {
      if (error instanceof BackendApiError && error.status >= 400 && error.status < 500) {
        setPendingRun(null);
        pendingRunStartRef.current = null;
        if (draftKey) await writeLocalDraft(draftKey, { brief: briefDraft, sourceDrafts, remoteRevision, pendingCommand: commandNoticeRef.current, pendingRunStart: null } satisfies LocalDraft);
      }
      fail(error);
    }
    finally { startingRunRef.current = false; }
  };

  const pauseRun = async (runId: string) => {
    try { const result = await pauseProductionBatch(target, runId); setBatches(current => current.map(item => item.runId === runId ? result.run : item)); }
    catch (error) { fail(error); }
  };

  const resumeRun = async (runId: string) => {
    try {
      let owner = productionOwner;
      let record = await fetchEpisodeProduction(target).then(value => value.production);
      let currentWork = record.draft.director?.workflow.currentWork;
      if (record.draft.director && currentWork?.runId !== runId) {
        const batch = await fetchProductionBatch(target, runId).then(value => value.run);
        if (!batch) throw new Error(t("director.workspace.runNotFound"));
        const [kindRaw, ...parts] = batch.targets[0]?.split(":") || [];
        const targetKind = kindRaw === "frame" ? "keyframe" : kindRaw === "segment" ? "segment" : kindRaw === "asset" ? "asset" : undefined;
        if (!targetKind) throw new Error(t("director.workspace.runTargetMissing"));
        const focused = await edit([{ type: "set_director_workflow", patch: { currentWork: {
          workId: currentWork?.workId || runId, module: targetKind === "segment" ? "model" : "assets", action: "produce", targetKind,
          targetId: parts.join(":"), inputRevision: record.revision + 1, sourceHash: record.draft.director.sourceHash, runId,
        } } }]);
        if (!focused) return;
        record = await fetchEpisodeProduction(target).then(value => value.production);
        currentWork = record.draft.director?.workflow.currentWork;
      }
      const result = await resumeProductionBatch(target, runId);
      setBatches(current => current.map(item => item.runId === runId ? result.run : item));
      if (currentWork) useProductionFollowStore.getState().setTarget({ ...owner, workId: currentWork.workId, runId, threadId: record.draft.director?.workflow.agentThreadId });
      useProductionFollowStore.getState().resume();
      if (embedded) useAgentStore.getState().closePanel();
    }
    catch (error) { fail(error); }
  };

  const reviewAsset = async (review: AssetReview) => {
    const saved = await edit([{ type: "review_director_asset", ...review }]);
    const automaticRun = batches.find(batch => {
      const workflow = batch.settings.workflow as Record<string, unknown> | undefined;
      return batch.status === "awaiting_review" && workflow?.runScope === "all_ready" && workflow.mediaProductionMode === "automatic";
    });
    if (saved && review.verdict === "approved" && automaticRun) await resumeRun(automaticRun.runId);
    return saved;
  };
  const bindAsset = async (assetId: string, nodeId: string) => edit([{ type: "bind_director_asset", assetId, nodeId }]);
  const reviewAssetRef = useRef(reviewAsset);
  reviewAssetRef.current = reviewAsset;
  const selectHistoryResult = async (object: ProductionObject, generationLogId: string, storageKey: string, canvasRevision: number) => {
    const saved = await edit([{ type: "select_director_result", targetKind: object.targetKind === "segment" ? "segment" : object.targetKind === "shot" ? "keyframe" : "asset", targetId: object.targetId!, nodeId: object.nodeId!, generationLogId, storageKey, canvasRevision }]);
    if (!saved) return false;
    const { project } = await fetchBackendProject(object.canvasId);
    applyBackendCanvasEvent({ type: "canvas.updated", entityId: object.canvasId, revision: project.revision, payload: project }, true);
    window.dispatchEvent(new CustomEvent("production-history-selected", { detail: { canvasId: object.canvasId } }));
    message.success(t(object.targetKind === "segment" ? "productionCanvas.videoResultSelected" : "productionCanvas.imageResultSelected"));
    return true;
  };
  const selectHistoryResultRef = useRef(selectHistoryResult);
  selectHistoryResultRef.current = selectHistoryResult;
  const nodeActionInFlight = useRef(false);
  useEffect(() => {
    if (!owner || !production || !embedded) return;
    const receive = (event: Event) => {
      const detail = (event as CustomEvent<{ owner: NonNullable<ProductionCanvasContext["owner"]>; object: ProductionObject; action: "review" | "reject" | "source" | "generate" | "video" | "select-result"; history?: { generationLogId: string; storageKey: string; mimeType: string } }>).detail;
      if (!detail || detail.owner.kind !== owner.kind || detail.owner.id !== owner.id || nodeActionInFlight.current) return;
      const object = detail.object;
      const open = (value: ProductionObject) => { navigate(productionObjectPath(value)); useProductionWorkspaceStore.getState().setSelectedObject(value); useProductionWorkspaceStore.getState().setPanelTab("object"); useAgentStore.getState().openPanel(); };
      void (async () => {
        nodeActionInFlight.current = true;
        try {
          const director = production.draft.director;
          if (!director || !object.nodeId || object.canvasId !== canvasId) throw new Error(t("productionCanvas.targetUnavailable"));
          if (detail.action === "select-result" && detail.history) {
            const history = detail.history;
            const { project } = await fetchBackendProject(canvasId);
            if (useProductionWorkspaceStore.getState().context?.canvasId !== canvasId) return;
            let viewed = false;
            const ready = () => { viewed = true; confirmation.update({ okButtonProps: { disabled: false } }); };
            const confirmation = modal.confirm({ title: t("productionCanvas.selectResult"), width: 720, okText: t("productionCanvas.selectResult"), cancelText: t("common.cancel"), okButtonProps: { disabled: true }, content: <div className="space-y-4">{history.mimeType.startsWith("video/") ? <video src={backendMediaUrl(history.storageKey)} className="max-h-[45dvh] w-full" controls preload="metadata" onLoadedMetadata={ready} /> : <img src={backendMediaUrl(history.storageKey)} alt={object.title} className="mx-auto max-h-[45dvh] max-w-full object-contain" onLoad={ready} />}<p className="text-sm">{t("productionCanvas.selectResultHint")}</p></div>, onOk: async () => {
              if (!viewed || useProductionWorkspaceStore.getState().context?.canvasId !== canvasId) throw new Error(t("productionCanvas.targetUnavailable"));
              if (!await selectHistoryResultRef.current(object, history.generationLogId, history.storageKey, Number(project.revision))) throw new Error(t("productionCanvas.resultSelectFailed"));
            } });
            return;
          }
          const assetId = object.targetKind === "shot" ? director.shotInputs[object.targetId || ""]?.keyframeAssetId : object.targetId;
          if (detail.action === "source") {
            const artifact = director.artifacts.find(item => item.targetId === (object.targetKind === "segment" ? object.targetId : assetId));
            modal.info({ title: `${object.title} · ${t("productionCanvas.objectSource")}`, width: 720, content: <div className="space-y-3"><p>{t("productionCanvas.sourceVersion", { version: production.publishedVersion || "—" })}</p><p className="break-all text-xs text-muted-foreground">{t("productionCanvas.sourceNode")}: {object.nodeId}{object.segmentId && ` · ${object.segmentId}`}</p>{artifact && <details><summary className="cursor-pointer">{t("director.workspace.completePrompts")}</summary><p className="mt-3 text-xs text-muted-foreground">{t("productionCanvas.sourceDraftHint")}</p><pre className="mt-3 max-h-[45dvh] overflow-auto whitespace-pre-wrap break-words text-sm">{artifact.prompt}</pre></details>}</div> });
            return;
          }
          if (pendingCommandRef.current) throw new Error(pendingCommandMessage(pendingCommandRef.current));
          if (busy) throw new Error(t("drama.production.commandInProgress"));
          if (detail.action === "review" || detail.action === "reject") {
            const published = production.published?.director;
            const mapped = assetId ? published?.assets[assetId] : undefined;
            const frame = object.targetKind === "shot" ? production.published?.keyframes[object.targetId || ""] : undefined;
            const storageKey = frame?.storageKey || mapped && mapped.storageKey;
            const node = useCanvasStore.getState().projects.find(project => project.id === canvasId)?.nodes.find(node => node.id === object.nodeId);
            if (!assetId || !published || !production.publishedVersion || !storageKey || (frame?.nodeId || mapped && mapped.nodeId) !== object.nodeId || node?.metadata?.storageKey !== storageKey) { open(object); return; }
            const bytes = await fetch(backendMediaUrl(storageKey)).then(response => { if (!response.ok) throw new Error(t("director.workspace.mediaReadFailed")); return response.arrayBuffer(); });
            const hash = await crypto.subtle.digest("SHA-256", bytes);
            const sha256 = Array.from(new Uint8Array(hash)).map(value => value.toString(16).padStart(2, "0")).join("");
            if (useProductionWorkspaceStore.getState().context?.canvasId !== canvasId) return;
            const rejecting = detail.action === "reject";
            let viewed = false, reason = "";
            const updateReviewButton = () => confirmation.update({ okButtonProps: { disabled: !viewed || rejecting && !reason.trim(), danger: rejecting } });
            const confirmation = modal.confirm({ title: t(rejecting ? "productionCanvas.confirmReturn" : "productionCanvas.confirmImage"), content: <div className="space-y-4"><img src={backendMediaUrl(storageKey)} alt={object.title} className="mx-auto max-h-[45dvh] max-w-full object-contain" onLoad={() => { viewed = true; updateReviewButton(); }} onError={() => message.error(t("director.workspace.mediaReadFailed"))} />{rejecting && <Input.TextArea aria-label={t("productionCanvas.returnReason")} placeholder={t("productionCanvas.returnReason")} autoSize={{ minRows: 2, maxRows: 5 }} onChange={event => { reason = event.target.value; updateReviewButton(); }} />}</div>, width: 720, okText: t(rejecting ? "productionCanvas.returnImage" : "productionCanvas.useImage"), okButtonProps: { disabled: true, danger: rejecting }, cancelText: t("common.cancel"), onOk: async () => {
              if (useProductionWorkspaceStore.getState().context?.canvasId !== canvasId) throw new Error(t("productionCanvas.targetUnavailable"));
              if (!viewed || rejecting && !reason.trim()) throw new Error(t("director.workspace.reviewReasonRequired"));
              if (!await reviewAssetRef.current({ assetId, version: production.publishedVersion, sourceHash: published.sourceHash, nodeId: object.nodeId!, storageKey, sha256, verdict: rejecting ? "rejected" : "approved", evidence: rejecting ? reason.trim() : t("productionCanvas.reviewEvidence") })) throw new Error(t("productionCanvas.reviewFailed"));
            } });
            return;
          }
          if (detail.action === "video") {
            const groups = production.draft.clipGroups.filter(group => group.shotIds.includes(object.targetId || ""));
            if (groups.length !== 1) { open({ ...object, workspace: "production" }); message.info(t("productionCanvas.chooseClip")); return; }
            let group = groups[0];
            if (!group.nodeId || !group.segmentId) {
              const prepared = await sendCommand({ kind: "prepare", targets: [`segment:${group.id}`], operationId: nanoid(), expectedRevision: production.revision, status: "unknown" });
              group = prepared.draft.clipGroups.find(item => item.id === group.id)!; await refreshRemote();
            }
            if (!group?.nodeId || !group.segmentId) throw new Error(t("productionCanvas.targetUnavailable"));
            if (useProductionWorkspaceStore.getState().context?.canvasId !== canvasId) return;
            navigate(productionObjectPath({ ...object, workspace: "production", targetKind: "segment", targetId: group.id, nodeId: group.nodeId, segmentId: group.segmentId }));
            useAgentStore.getState().closePanel();
            await startCanvasGeneration({ mode: "video", operation: "h3-run", projectId: canvasId, nodeId: group.nodeId, segmentId: group.segmentId });
            return;
          }
          if (object.targetKind === "segment" && object.segmentId) {
            await startCanvasGeneration({ mode: "video", operation: "h3-run", projectId: canvasId, nodeId: object.nodeId, segmentId: object.segmentId });
          } else {
            const artifact = director.artifacts.find(item => item.kind === "image" && item.targetId === assetId);
            if (!artifact || artifact.status !== "ready") { open(object); message.info(t("productionCanvas.compileFirst")); return; }
            await startCanvasGeneration({ mode: "image", projectId: canvasId, nodeId: object.nodeId, prompt: artifact.prompt });
          }
        } catch (error) { fail(error); }
        finally { nodeActionInFlight.current = false; }
      })();
    };
    window.addEventListener("production-node-action", receive);
    return () => window.removeEventListener("production-node-action", receive);
  }, [embedded, owner?.kind, owner?.id, production, canvasId, busy, draftKey, briefDraft, sourceDrafts, remoteRevision, pendingRunStart, batches, navigate, t]);
  const regroupSegment = async (segmentId: string, shotIds: string[], removeSegmentIds: string[]) => edit([{ type: "set_director_segment_group", segmentId, shotIds, removeSegmentIds }]);
  const repartitionV2 = async (shotIds: string[], segments: Array<Record<string, unknown>>) => edit([{ type: "repartition_director_clips", shotIds, segments }]);
  const editV2Shot = async (operation: Extract<ProductionOperation, { type: "edit_director_shot" }>) => {
    const director = production?.draft.director;
    if (!director) return false;
    const captured: Record<string, string> = {}, ops: ProductionOperation[] = [];
    for (const id of [...new Set([operation.shotId, operation.targetShotId].filter((id): id is string => Boolean(id)))]) {
      const key = `v2shot:${id}`, raw = sourceDrafts[key];
      if (!raw) continue;
      const shot = (director.source.shots as Array<Record<string, any>>).find(shot => shot.id === id);
      if (!shot) continue;
      const { draft, invalid } = readShotFormDraft(raw, shot, director.source);
      if (invalid || shotDraftSourceChanged(draft, shot, director.source)) { message.error(t(invalid ? "director.atomic.invalidDraft" : "director.atomic.sourceChanged")); return false; }
      const changes = shotFormChanges(draft);
      if (Object.keys(changes.patch).length) ops.push({ type: "patch_director_source", entity: "shot", id, patch: changes.patch });
      if (changes.keyframes !== undefined) ops.push({ type: "set_director_shot_keyframes", shotId: id, keyframes: changes.keyframes as Extract<ProductionOperation, { type: "set_director_shot_keyframes" }>["keyframes"] });
      if (changes.utterances !== undefined) ops.push({ type: "set_director_shot_utterances", shotId: id, utterances: changes.utterances as Extract<ProductionOperation, { type: "set_director_shot_utterances" }>["utterances"] });
      captured[key] = raw;
    }
    const saved = await edit([...ops, operation]);
    if (saved) setSourceDrafts(current => Object.fromEntries(Object.entries(current).filter(([key, value]) => captured[key] !== value)));
    return saved;
  };
  const upsertSubject = async (subject: Extract<ProductionOperation, { type: "upsert_director_subject" }>["subject"]) => edit([{ type: "upsert_director_subject", subject }]);
  const deleteSubject = async (id: string) => edit([{ type: "delete_director_subject", id }]);
  const saveV2Shot = async (shotId: string, patch: Record<string, unknown>, keyframes?: Extract<ProductionOperation, { type: "set_director_shot_keyframes" }>["keyframes"], utterances?: Extract<ProductionOperation, { type: "set_director_shot_utterances" }>["utterances"]) => {
    const ops: ProductionOperation[] = [];
    if (Object.keys(patch).length) ops.push({ type: "patch_director_source", entity: "shot", id: shotId, patch });
    if (keyframes !== undefined) ops.push({ type: "set_director_shot_keyframes", shotId, keyframes });
    if (utterances !== undefined) ops.push({ type: "set_director_shot_utterances", shotId, utterances });
    return ops.length ? edit(ops) : true;
  };
  const patchSource = async (entity: "style" | "scene" | "environment" | "character" | "asset" | "shot" | "segment", id: string | undefined, patch: Record<string, unknown>) => edit([{ type: "patch_director_source", entity, ...(id ? { id } : {}), patch }]);
  const editCanvasClip = async (nodeId: string, segmentId: string, patch: Record<string, unknown>) => {
    if (!canvasId) return false;
    try {
      const project = await ensureCanvasProjectLoaded(canvasId);
      useCanvasStore.getState().updateProject(canvasId, { nodes: project.nodes.map(node => {
        if (node.id !== nodeId) return node;
        const metadata = node.metadata as Record<string, unknown>;
        const segments = (metadata.segments as Record<string, unknown>[] || []).map(segment => segment.id === segmentId ? { ...segment, ...withH3ParameterEdits(segment, patch) } : segment);
        return { ...node, metadata: { ...metadata, segments } as typeof node.metadata };
      }) });
      await flushCanvasProjectBeforeGeneration(canvasId);
      await refreshRemote(); return true;
    } catch (error) { fail(error); return false; }
  };
  const adoptDirectorFields = async (targetId: string, nodeId: string, segmentId: string | undefined, fields: string[]) => {
    if (!canvasId) return false;
    const { project } = await fetchBackendProject(canvasId);
    return edit([{ type: "adopt_director_fields", targetId, nodeId, segmentId, fields, canvasRevision: Number(project.revision) }]);
  };
  const adoptClipStyle = async (targetId: string, styleTemplateId: string | null) => {
    if (!production || busy || pendingCommandRef.current) return false;
    const group = production.draft.clipGroups.find(group => group.id === targetId);
    if (!group?.nodeId || !group.segmentId || !canvasId) return false;
    try {
      const { project } = await fetchBackendProject(canvasId);
      return await edit([{ type: "adopt_director_clip_style", targetId, nodeId: group.nodeId, segmentId: group.segmentId, canvasRevision: Number(project.revision), styleTemplateId }]);
    } catch (error) { fail(error); return false; }
  };
  const saveContinuity = async (ledger: Record<string, unknown>, upgradePreview?: Record<string, any>) => {
    if (!production) return false;
    const agentState = useAgentStore.getState();
    if (upgradePreview && (agentState.sending || agentState.waiting || ["preparing", "running"].includes(agentState.conversation.status))) {
      message.warning(t("director.workspace.continuity.upgradeWaitAgent"));
      return false;
    }
    if (upgradePreview?.activeRuns?.length) {
      message.warning(t("director.workspace.continuity.upgradeWaitRuns", { count: upgradePreview.activeRuns.length }));
      return false;
    }
    if (upgradePreview) return await new Promise<boolean>(resolve => modal.confirm({
      title: t("director.workspace.continuity.confirmUpgradeTitle"), content: t("director.workspace.continuity.confirmUpgradeBody"),
      okText: t("director.workspace.continuity.applyUpgrade"), cancelText: t("common.cancel"),
      onOk: async () => resolve(await edit([{ type: "upgrade_director_continuity", fromSourceHash: String(upgradePreview.fromSourceHash), previewRevision: Number(upgradePreview.revision), previewHash: String(upgradePreview.previewHash), toRuntimeId: String(upgradePreview.targetRuntime?.runtimeId), ledger }])),
      onCancel: () => resolve(false),
    }));
    const currentLedger = production.draft.director?.source.ledger as Record<string, any> | undefined;
    if (production.draft.director && isSubjectPromptAssembly(production.draft.director.source)) {
      const collections = ["facts", "timelines", "initial", "events", "requirements", "coverage"] as const;
      const rowId = (row: Record<string, any>) => String(row.id || String(row.timeline_id || "") + ":" + String(row.fact_id || ""));
      const changes = collections.flatMap(collection => {
        const before = Array.isArray(currentLedger?.[collection]) ? currentLedger![collection] as Record<string, any>[] : [];
        const after = Array.isArray(ledger[collection]) ? ledger[collection] as Record<string, any>[] : [];
        const previous = new Map(before.map(row => [rowId(row), row]));
        const next = new Map(after.map(row => [rowId(row), row]));
        return [
          ...before.filter(row => !next.has(rowId(row))).map(row => ({ collection, action: "delete" as const, id: rowId(row) })),
          ...after.filter(row => !previous.has(rowId(row)) || JSON.stringify(previous.get(rowId(row))) !== JSON.stringify(row))
            .map(row => ({ collection, action: "upsert" as const, id: rowId(row), value: row })),
        ];
      });
      return changes.length ? edit([{ type: "edit_director_continuity", changes }]) : true;
    }
    return edit([{ type: "patch_director_continuity", ledger }]);
  };
  const previewContinuityUpgrade = async (ledger: Record<string, unknown>, fromSourceHash: string) => {
    if (!production) throw new Error(t("director.loadFailed"));
    return (await previewProductionContinuityUpgrade(target, { expectedRevision: production.revision, operationId: nanoid(), fromSourceHash, ledger })).preview;
  };
  const checkContinuity = async () => {
    if (!production || busy || pendingCommandRef.current) return;
    setBusy(true);
    try {
      await checkProductionContinuity(target, { expectedRevision: production.revision, operationId: nanoid(), snapshot: continuitySnapshot });
      const [continuity, ready] = await Promise.all([fetchProductionContinuity(target, { snapshot: continuitySnapshot }), fetchProductionReadiness(target)]);
      setContinuityReport(continuity.continuity); setReadiness(ready.readiness);
    } catch (error) { fail(error); }
    finally { setBusy(false); }
  };
  const changeContinuitySnapshot = (snapshot: "draft" | "published") => {
    setContinuitySnapshot(snapshot);
    void fetchProductionContinuity(target, { snapshot }).then(value => setContinuityReport(value.continuity)).catch(fail);
  };
  const openSharedAsset = async (assetId: string, assetTitle: string) => {
    if (!productionContext?.dramaId) throw new Error(t("director.workspace.sharedCanvasUnavailable"));
    const { project, context } = await ensureSharedAssetCanvas(productionContext.dramaId);
    if (!context.owner) throw new Error(t("director.workspace.sharedCanvasUnavailable"));
    const sharedCanvasId = String(project.id || "");
    if (!sharedCanvasId) throw new Error(t("director.workspace.sharedCanvasUnavailable"));
    navigate(productionObjectPath({ owner: context.owner, canvasId: sharedCanvasId, workspace: "assets", targetKind: "asset", targetId: assetId, title: assetTitle }));
  };
  const promoteExistingSharedAsset = async (assetId: string, assetTitle: string) => {
    if (!production || productionContext?.role !== "episode") throw new Error(t("director.workspace.sharedCanvasUnavailable"));
    const { preview } = await previewProductionSharedAssetPromotion(target, assetId, production.revision);
    if (preview.approvedId) {
      message.info(t("director.workspace.sharedAssetAlreadyRegistered"));
      await openSharedAsset(assetId, assetTitle);
      return;
    }
    const operationId = nanoid();
    modal.confirm({
      title: t("director.workspace.promoteSharedAssetTitle", { title: preview.assetName }),
      content: <div className="space-y-2"><p>{t("director.workspace.promoteSharedAssetSource", { version: preview.publishedVersion, nodeId: preview.sourceNodeId })}</p><p className="break-all text-xs text-muted-foreground">{preview.storageKey} · SHA-256 {preview.sha256}</p><p className="text-sm">{preview.evidence}</p><p className="text-xs text-muted-foreground">{t("director.workspace.promoteSharedAssetPreserves")}</p></div>,
      okText: t("director.workspace.promoteExistingSharedAsset"),
      cancelText: t("common.cancel"),
      onOk: async () => {
        await promoteExistingProductionSharedAsset(target, { assetId, expectedRevision: production.revision, expectedSourceCanvasRevision: preview.sourceCanvasRevision,
          expectedSharedCanvasRevision: preview.sharedCanvasRevision, operationId });
        message.success(t("director.workspace.promoteSharedAssetComplete"));
        await openSharedAsset(assetId, assetTitle);
      },
    });
  };
  const saveSceneDrafts = async (ids: string[]) => {
    const fields = ids.flatMap(id => sourceDrafts[`scene:${id}:text`] !== undefined ? [{ id, key: `scene:${id}:text`, value: sourceDrafts[`scene:${id}:text`] }] : []);
    if (!fields.length) return true;
    const saved = await edit(fields.map(field => ({ type: "patch_director_source" as const, entity: "scene" as const, id: field.id, patch: { text: field.value } })));
    if (saved) setSourceDrafts(current => { const next = { ...current }; for (const field of fields) if (next[field.key] === field.value) delete next[field.key]; return next; });
    return saved;
  };
  const setBoundary = async (boundary: NonNullable<EpisodeProduction["draft"]["director"]>["boundaries"][number]) => edit([{ type: "set_director_boundary", boundary }]);
  const setWorkflow = async (patch: Partial<NonNullable<EpisodeProduction["draft"]["director"]>["workflow"]>) => edit([{ type: "set_director_workflow", patch }]);
  const answerDecision = async (decisionId: string, answer: string) => {
    const latest = await fetchEpisodeProduction(target).then(value => value.production);
    const director = latest.draft.director;
    const decision = director?.workflow.pendingDecisions?.find(item => item.id === decisionId);
    if (!director || !decision || !answer.trim()) return false;
    if (decision.status === "pending") {
      if (decision.sourceHash !== director.sourceHash) { message.warning(t("director.workspace.decisionStale")); return false; }
      if (!decision.choices.includes(answer) && !decision.allowFreeText) { message.warning(t("director.workspace.decisionChoiceInvalid")); return false; }
      const updated = director.workflow.pendingDecisions?.map(item => item.id === decisionId ? { ...item, status: "answered" as const, answer: answer.trim() } : item);
      if (!await edit([{ type: "set_director_workflow", patch: { pendingDecisions: updated } }])) return false;
    }
    const workspace: DirectorWorkspace = decision.module === "story" ? "story" : decision.module === "assets" ? "assets" : ["shots", "performance", "effects"].includes(decision.module) ? "shots" : "production";
    void askDirector({ workspace, targetId: decision.targetId, workId: decision.workId, instruction: `制作对象的待决定事项 ${decision.id} 已由用户明确答复：${answer.trim()}。请只在 ${decision.sourceHash} 所属的当前源稿版本上处理此决定，保留其他冻结事实与未编辑字段。` });
    return true;
  };
  const replaceDirector = async (director: NonNullable<EpisodeProduction["draft"]["director"]>) => edit([{ type: "set_director_production", director }]);
  const deleteScene = async (sceneId: string) => {
    if (!production || busy || !sceneId || !canvasId) return false;
    const { project } = await fetchBackendProject(canvasId);
    return edit([{ type: "archive_director_scene", sceneId, expectedCanvasRevision: Number(project.revision), confirmed: true }]);
  };
  const exportBundle = async (includeGeneratedMedia: boolean) => {
    if (!production || !readiness) return;
    setExporting(true);
    try {
      const owner = productionOwner;
      const bundle = await exportAchengDeliveryBundle({ owner, title, production, readiness, canvasNodes, includeGeneratedMedia });
      const url = URL.createObjectURL(bundle);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${String(title || owner.id).replace(/[^\p{L}\p{N}._-]+/gu, "_")}-acheng-r${production.revision}.zip`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1500);
      message.success(t("director.workspace.bundleDownloaded"));
    } catch (error) { fail(error); }
    finally { setExporting(false); }
  };

  useEffect(() => {
    if (!agentTaskResult || agentTaskResult.status !== "sent" || !agentTaskResult.threadId || !production?.draft.director) return;
    if (agentBusy || ["preparing", "running"].includes(agentConversation.status)) return;
    if (handledAgentResultRef.current === agentTaskResult.id) return;
    if (production.draft.director.workflow.agentThreadId === agentTaskResult.threadId) { handledAgentResultRef.current = agentTaskResult.id; return; }
    handledAgentResultRef.current = agentTaskResult.id;
    void (async () => {
      try {
        const latest = await fetchEpisodeProduction(target).then(value => value.production);
        if (latest.draft.director?.workflow.agentThreadId === agentTaskResult.threadId) return;
        await editEpisodeProduction(target, latest.revision, [{ type: "set_director_workflow", patch: { agentThreadId: agentTaskResult.threadId } }], nanoid());
        await refreshRemote();
      } catch { /* Session association is best-effort; the production and chat remain intact. */ }
    })();
  }, [agentTaskResult, agentConversation.status, agentBusy, production, target, refreshRemote]);

  useEffect(() => {
    if (!production || !canvasId) return;
    return registerProductionPromptEditor(canvasId, async input => {
      const segmentId = sourceSegmentForCanvasClip(production.draft.clipGroups, input.nodeId, input.segmentId);
      const { project } = await fetchBackendProject(canvasId);
      const sourceSaved = await edit([{ type: "reverse_sync_director_prompt", segmentId, artifactId: input.artifactId,
        sourceHash: input.sourceHash, basePromptHash: input.basePromptHash, prompt: input.prompt, canvasRevision: Number(project.revision) }]);
      if (sourceSaved) message.success(t("director.workspace.promptReverseSyncSaved"));
      return { sourceSaved };
    });
  }, [production, canvasId, edit, message, t]);

  useEffect(() => {
    if (agentTaskResult?.status === "failed") setAgentError(agentTaskResult.error || t("director.workspace.agentTaskFailed"));
  }, [agentTaskResult, t]);

  if (loadError) return <main className="p-8"><Alert type="error" message={t("director.loadFailed")} description={loadError} /><Button className="mt-4" onClick={() => { setLoadError(""); void load(() => true, true).catch(error => setLoadError(String(error))); }}>{t("director.refresh")}</Button><Button onClick={() => navigate(backPath)}>{t("director.back")}</Button></main>;
  if (!production) return <div className="p-8 text-muted-foreground">{t("drama.production.loading")}</div>;

  const showCommandNotice = commandNotice && (pendingCommand || commandNotice.workspace === workspace || (!commandNotice.workspace && workspace === "advanced"));
  const pendingNotice = showCommandNotice && commandNotice && <details className="mb-4 border-b border-border pb-3 text-sm">
    <summary className="cursor-pointer text-muted-foreground">{t(commandNotice.status === "unknown" ? "drama.production.receiptUnknown" : pendingCommand ? "drama.production.commandRejected" : "drama.production.commandRejectedEditable")}</summary>
    <div className="mt-2 space-y-1">
    <p className="font-medium">{pendingCommandDescription(commandNotice)}</p>
    <p>{commandNotice.status === "unknown" ? t("drama.production.receiptUnknown") : t(pendingCommand ? "drama.production.commandRejected" : "drama.production.commandRejectedEditable")}{commandNotice.error ? ` · ${commandNotice.error}` : ""}</p>
    <details className="mt-1 text-xs text-amber-800 dark:text-amber-200"><summary className="cursor-pointer">{t("drama.production.pendingDetails")}</summary><p className="mt-1 break-all">{commandNotice.operationId}</p></details>
    {pendingCommand && <Button className="mt-2" size="small" disabled={busy} onClick={pendingCommand.status === "unknown" ? () => void recoverPending() : resolveRejected}>{pendingCommand.status === "unknown" ? t("drama.production.recoverReceipt") : t("drama.production.resolveWithServer")}</Button>}
    </div>
  </details>;
  const pendingRunNotice = pendingRunStart && <div className="mb-4 rounded-xl border border-amber-400/60 bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950/30 dark:text-amber-100"><p>{t("director.workspace.runReceiptUnknown")} · {pendingRunStart.runId}</p><Button className="mt-2" size="small" disabled={busy} onClick={() => void recoverRunStart()}>{t("drama.production.recoverReceipt")}</Button></div>;
  const run = batches[0] || null;
  const activeTargetIds = [...new Set(batches.filter(item => ["pending", "running", "paused", "awaiting_review"].includes(item.status)).flatMap(item => item.targets))];
  const visibleWorkspaces = workspaces.filter(item => series || item.key !== "series");

  return <main ref={editorRootRef} data-production-inspector={embedded && !dialog || undefined} data-production-dialog={dialog || undefined} className={embedded ? "min-h-full bg-background p-3 text-foreground" : "min-h-full bg-background px-4 py-4 text-foreground sm:px-6 lg:px-8"}>
    <div className="mx-auto max-w-[1440px]">
      {!embedded && <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3"><Button type="text" icon={<ArrowLeft className="size-4" />} onClick={() => navigate(backPath)}>{t("director.back")}</Button><div><h1 className="text-xl font-semibold tracking-tight sm:text-2xl">{series ? seriesName || t("director.atomic.seriesWorkbench") : title || t("director.title")}</h1><p className="mt-1 text-xs text-muted-foreground">{episode ? `${t("director.episodeContext", { number: episode.episodeNumber })} · ${title}` : t("director.canvasContext")}</p></div></div>
        <div className="flex flex-wrap items-center gap-2">{series && <Select aria-label={t("director.atomic.chooseEpisode")} value={episodeId} className="min-w-44" showSearch optionFilterProp="label" options={[...series.episodes].sort((a, b) => a.episodeNumber - b.episodeNumber).map(item => ({ value: item.id, label: `${t("drama.episodeLabel", { number: item.episodeNumber })} · ${item.title}` }))} onChange={id => navigate(dramaWorkbenchPath(series.id, id, workspace))} />}<span className="text-xs text-muted-foreground">{t(Object.keys(sourceDrafts).length ? "director.studio.localDraft" : "director.studio.saved")}</span>{production.publishedVersion > 0 && <Tag>{t("director.studio.published", { number: production.publishedVersion })}</Tag>}{canvasId && <Button icon={<ExternalLink className="size-4" />} onClick={() => canvasHost ? canvasHost.hasCanvas ? canvasHost.restoreCanvas() : canvasHost.openCanvas({ projectId: canvasId }) : navigate(`/canvas/${encodeURIComponent(canvasId)}`)}>{t(canvasHost?.hasCanvas ? "director.canvasOverlay.expand" : "drama.production.openCanvas")}</Button>}</div>
      </div>}
      {agentError && <Alert className="mb-4" type="warning" showIcon message={agentError} closable onClose={() => setAgentError("")} />}
      {(remoteRevision !== null || showCommandNotice) && <div className="mb-4 text-sm">{remoteRevision !== null && <p>{t("drama.production.conflictDetail", { number: remoteRevision })}</p>}{pendingNotice}</div>}
      {pendingRunNotice}
      <div className="mb-4">
        <div className="min-w-0">
          <aside className="min-w-0 border-b border-border">
            <nav aria-label={t("director.workspace.navigation")} className="flex w-full gap-1 overflow-x-auto py-2">
              {visibleWorkspaces.map(({ key, icon: Icon }, index) => <Fragment key={key}>
                {index > 0 && workspaceScope(visibleWorkspaces[index - 1].key) !== workspaceScope(key) && <div data-workspace-divider aria-hidden className="mx-2 h-6 w-px shrink-0 self-center bg-border" />}
                <button type="button" aria-label={t(`director.workspace.tab.${key}`)} aria-current={workspace === key ? "page" : undefined}
                  onClick={() => selectWorkspace(key)}
                  className={`flex min-h-11 shrink-0 items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors ${workspace === key ? "border-border bg-muted font-medium text-foreground" : "border-transparent text-muted-foreground hover:bg-muted/60 hover:text-foreground"}`}
                ><Icon className="size-4 shrink-0" /><span className="min-w-0"><span className="block whitespace-nowrap">{t(`director.workspace.tab.${key}`)}</span></span></button>
              </Fragment>)}
            </nav>
          </aside>
          <section aria-label={t(`director.workspace.tab.${workspace}`)} className="min-w-0 py-6">
            {workspace === "series" && series ? <DramaManagePanel dramaId={series.id} onEpisodesChanged={() => onSeriesEpisodesChanged?.()} /> : <>
            {embedded && workspace === "assets" && (!/^(asset|frame):/.test(routeTarget) || productionContext?.role === "shared-assets") && <SharedAssetsPicker />}
            <DirectorPanel
              embedded={embedded} compact={dialog} generationSupported={productionOwner.kind !== "scene"} onSaveScript={saveSceneDrafts}
              workspace={workspace} director={production.draft.director} production={production} readiness={readiness || undefined} continuityReport={continuityReport} run={run} batches={batches} runtimeTasks={runtimeTasks}
              canvasNodes={canvasNodes} legacy={legacy} versions={versions} busy={busy} canvasId={canvasId} canvasRole={productionContext?.role || (projectId ? "ordinary" : "episode")} focusTarget={routeTarget}
              sourceDrafts={sourceDrafts} onSourceDraftChange={setSourceDraft}
              briefDraft={briefDraft} onBriefDraftChange={setBriefDraft}
              onBrief={saveBrief} onEditCanvasClip={editCanvasClip} onAdoptDirectorFields={adoptDirectorFields} onPatch={patchSource} onAdoptClipStyle={adoptClipStyle} onRegroup={regroupSegment} onWorkflow={setWorkflow} onSettings={patch => void edit([{ type: 'set_settings', patch }])} onBindAsset={(assetId, nodeId) => void bindAsset(assetId, nodeId)}
              onUpsertSubject={upsertSubject} onDeleteSubject={deleteSubject} onDeleteScene={deleteScene} onSaveV2Shot={saveV2Shot} onRepartitionClips={repartitionV2} onEditShot={editV2Shot}
              onOpenSharedAsset={(assetId, title) => void openSharedAsset(assetId, title).catch(fail)} onPromoteExistingSharedAsset={(assetId, title) => void promoteExistingSharedAsset(assetId, title).catch(fail)}
              onBoundary={setBoundary} onReview={reviewAsset} onPublish={() => void publish()} onSaveContinuity={saveContinuity} onPreviewContinuityUpgrade={previewContinuityUpgrade} onCheckContinuity={checkContinuity} onContinuitySnapshot={changeContinuitySnapshot}
              onReplace={value => void replaceDirector(value)} onAskDirector={scope => void askDirector(scope)} onRequestContinuityUpgrade={requestContinuityUpgradeFromAgent} onNavigate={navigateWorkspace}
              onLocateTarget={(kind, id) => {
                if (kind === "shot") { navigateWorkspace("shots", { kind, id }); return; }
                const group = production.draft.clipGroups.find(group => group.id === id);
                const frame = production.draft.keyframes[id];
                const assetId = kind === "keyframe" || kind === "frame" ? production.draft.director?.shotInputs[id]?.keyframeAssetId : id;
                const nodeId = kind === "segment" ? group?.nodeId : (kind === "keyframe" || kind === "frame" ? frame?.nodeId : undefined) || production.draft.director?.assets[assetId || ""]?.nodeId;
                if (!nodeId) { navigateWorkspace(kind === "segment" ? "production" : kind === "frame" || kind === "keyframe" ? "shots" : "assets", { kind: kind === "keyframe" || kind === "frame" ? "shot" : kind, id }); return; }
                const object: ProductionObject = { owner: owner || productionOwner, canvasId, workspace: kind === "segment" ? "production" : kind === "frame" || kind === "keyframe" ? "shots" : "assets", targetKind: kind === "frame" || kind === "keyframe" ? "shot" : kind, targetId: id, nodeId, ...(kind === "segment" && group?.segmentId ? { segmentId: group.segmentId } : {}), title: id };
                useProductionFollowStore.getState().pause(t("productionCanvas.manualPause"));
                if (canvasHost) canvasHost.openCanvas({ projectId: canvasId, nodeId, segmentId: object.segmentId });
                else navigate(productionObjectPath(object));
                useAgentStore.getState().closePanel();
              }}
              onAnswerDecision={answerDecision}
              onExport={exportBundle} exporting={exporting}
              onStart={(targets, scope) => void startRun(targets, scope)} onPause={runId => void pauseRun(runId)} onResume={runId => void resumeRun(runId)}
              runStartPending={Boolean(pendingRunStart)} activeTargetIds={activeTargetIds}
              onRestore={restoreVersion} onSceneCommand={sendSceneCommand} sceneCommandPending={Boolean(pendingCommand || pendingRunStart)} onRefresh={() => void load(() => true, true).catch(fail)}
            />
            </>}
          </section>
        </div>
      </div>
    </div>
  </main>;
}
