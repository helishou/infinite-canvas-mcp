import { productionEntities } from "@basketikun/canvas-agent/drama/production-contract";
import { matchesProductionAssetNode } from "./production-asset-identity";
import { withH3ParameterEdits } from "@basketikun/canvas-agent/plugins/minimax-h3/runtime-params";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Alert, App, Button, Input, Select, Tag } from "antd";
import { ArrowLeft, ExternalLink } from "lucide-react";
import localforage from "localforage";
import { nanoid } from "nanoid";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams, useSearchParams, createSearchParams } from "react-router-dom";
import { diagnosticBlocksAction, isSubjectPromptAssembly, productionSceneEntries, type ProductionBlockingAction, type ProductionDiagnostic, type ProductionOperation } from "@basketikun/canvas-agent/drama/production-contract";
import { backendConnection } from "@/lib/backend-connection";
import { ensureCanvasDraftLease, getCanvasDraftSessionId } from "@/lib/canvas/canvas-draft-session";
import { exportAchengDeliveryBundle } from "@/lib/acheng-delivery-export";
import { useAgentStore } from "@/stores/use-agent-store";
import { useBackendStore } from "@/stores/use-backend-store";
import { useProductionFollowStore } from "@/stores/use-production-follow-store";
import { useProductionWorkspaceStore } from "@/stores/use-production-workspace-store";
import { useWorkbenchCanvas, useCanvasHost } from "@/lib/canvas/canvas-host";
import { WorkbenchCanvas } from "./workbench-canvas";
import { productionCanvasNodes, type ProductionCanvasSnapshot } from "./production-canvas-nodes";
import { readShotFormDraft, shotFormChanges, shotDraftSourceChanged } from "./subject-shot-draft";
import { startSingleFlightPoller } from "@/lib/single-flight-poll";
import { productionObjectPath, type ProductionObject } from "@/lib/production-object";
import { productionSegments, productionSegmentRuntimeMatches, segmentShotIds } from "@/lib/production-source";
import { bindEntityPictureToNode } from "@/lib/production/subject-picture-binding";
import { watchSlowBrowserOperation } from "@/lib/slow-operation-monitor";
import { applyBackendCanvasEvent, ensureCanvasProjectLoaded, flushCanvasProjectBeforeGeneration, useCanvasStore, type CanvasProject } from "@/stores/canvas/use-canvas-store";
import { SharedAssetsPicker } from "@/components/production/canvas-production-workspace";
import {
  submitProductionSceneAction, type ProductionSceneAction, BackendApiError, editEpisodeProduction, previewEpisodeProductionImpact,
  applyBackendCanvasOperations, fetchBackendCanvasDrama, fetchBackendDramaEpisode, fetchBackendDramaEpisodes, fetchBackendProject, fetchEpisodeProduction,
  fetchEpisodeProductionVersions, fetchProductionBatch, fetchProductionBatches,
  fetchProductionReadiness, fetchProductionOperationReceipt, pauseProductionBatch, publishEpisodeProduction, restoreEpisodeProduction,
  checkProductionContinuity, fetchProductionContinuity, type ProductionContinuity,
  resumeProductionBatch, startProductionRun, type DramaEpisode, type EpisodeProduction,
  type ProductionBatch, type ProductionReadiness, type ProductionTarget, type ProductionCanvasContext,
  compileProduction, fetchProductionCompilation, applyProductionCompilation, type ProductionCompilationStatus, type ProductionCompilationDiagnostic,
  prepareProductionTargets, arrangeProductionScene, adoptProductionSharedAsset, ensureEpisodeCanvas, ensureSharedAssetCanvas, fetchProductionCanvasContext,
  previewProductionSharedAssetPromotion, promoteExistingProductionSharedAsset,
  backendMediaUrl, startCanvasGeneration, fetchBackendTasks, isBackendAvailabilityError, type BackendRuntimeTask,
} from "@/services/backend-api";
import { DirectorPanel, type DirectorWorkspace } from "./director-panel";
import { type CanvasAssetEditPayload } from "./canvas-asset-edit-modal";
import { DramaManagePanel } from "./manage-panel";
import "./production.css";
import { registerProductionPromptEditor, registerProductionStoryboardEditor, registerProductionBoundaryEditor, sourceSegmentForCanvasClip, buildDirectorClipStoryboardOperation } from "@/lib/canvas/production-editing";
import { dramaWorkbenchEpisode, dramaWorkbenchPath } from "./workbench-entry";
import { commandNeedsRecovery, commandFailureRecord, normalizeCommandRecovery, commandErrorSummary } from "./production-command-recovery";
import { productionNavigationGroups, productionTargetTitle, productionWorkspaceQuery, productionWorkspaces, seriesPlanningOption, seriesWorkspaceView, type SeriesWorkspaceView, type ProductionWorkspaceScope } from "./production-workspace";
import { ProductionWorkspaceBreadcrumb, ProductionWorkspaceNavigation } from "./production-workspace-navigation";
import { continuityDiagnosticLocations, frameTimecode } from "./continuity-diagnostic-context";
import { createManualDirectorAsset } from "./manual-director-assets";

type PendingCommand = { operationId: string; expectedRevision: number; status: "unknown" | "rejected"; error?: string; errorSummary?: string; httpStatus?: number; errorCode?: string; workspace?: DirectorWorkspace } & (
  { kind: "scene"; command: ProductionSceneAction } | { kind: "edit"; ops: ProductionOperation[] } | { kind: "publish"; stage: "director" } | { kind: "restore"; version: number }
  | { kind: "prepare"; targets: string[] } | { kind: "arrange"; sceneId: string } | { kind: "adopt"; assetId: string; approvedId: string }
);
type PendingRunStart = { inputBasis?: "canvas" | "published"; expectedCanvasRevision?: number; expectedPlanHash?: string; runId: string; idempotencyKey: string; workId?: string; expectedRevision: number; version: number; targets: string[]; scope: "selected" | "all_ready" };
type PendingCompilation = { operationId: string; expectedRevision: number; scope?: { sceneId?: string; targetIds?: string[] } };
type VersionItem = { version: number; stage: string; createdAt: string };
function sourceDraftDiffersFromSaved(key: string, value: string, director: NonNullable<EpisodeProduction["draft"]["director"]>) {
  const source = director.source as Record<string, any>;
  if (key.startsWith("v2shot:")) {
    const shotId = key.slice("v2shot:".length);
    const shot = (Array.isArray(source.shots) ? source.shots : []).find((item: Record<string, any>) => String(item.id) === shotId);
    if (!shot) return true;
    const parsed = readShotFormDraft(value, shot, source);
    if (parsed.invalid || shotDraftSourceChanged(parsed.draft, shot, source)) return true;
    const changes = shotFormChanges(parsed.draft);
    return Object.keys(changes.patch).length > 0 || changes.keyframes !== undefined || changes.utterances !== undefined;
  }
  if (key.startsWith("scene:")) {
    const [, sceneId, field] = key.split(":");
    if (field !== "text") return true;
    const scene = (Array.isArray(source.script_scenes) ? source.script_scenes : []).find((item: Record<string, any>) => String(item.id || item.scene_id) === sceneId);
    return !scene || String(scene.text || "") !== value;
  }
  return true;
}
function blocksCompilationDiagnostic(item: ProductionCompilationDiagnostic) {
  const severity = item.severity === "error" || item.severity === "unverified" ? item.severity : "warning";
  return diagnosticBlocksAction({
    code: item.code || "UNKNOWN_COMPILATION_DIAGNOSTIC",
    path: item.path || "compile",
    message: item.message || "",
    severity,
    ...(item.targetId ? { targetId: item.targetId } : {}),
    ...(Array.isArray(item.blockingActions) ? { blockingActions: item.blockingActions as ProductionBlockingAction[] } : {}),
    ...(typeof item.blocksCompilation === "boolean" ? { blocksCompilation: item.blocksCompilation } : {}),
  } as ProductionDiagnostic, "compile");
}
function mergeScopedCompilationDiagnostics(previous: ProductionCompilationDiagnostic[], current: ProductionCompilationDiagnostic[], touchedTargets: Set<string>, replaceAll: boolean) {
  if (replaceAll) return current;
  const retained = previous.flatMap(item => {
    const directHit = [item.targetId, item.shotId].some(id => id && touchedTargets.has(String(id)));
    const affected = item.affectedTargets || [], remainingAffected = affected.filter(id => !touchedTargets.has(String(id)));
    if (!directHit && remainingAffected.length === affected.length) return [item];
    if (!remainingAffected.length && (directHit || affected.length)) return [];
    return [{ ...item, ...(directHit ? { targetId: undefined } : {}), ...(affected.length ? { affectedTargets: remainingAffected } : {}) }];
  });
  return [...retained, ...current];
}
// 制作工作台以数据库为唯一数据源，不再有本机草稿存储；进入页面时一次性清理旧版本遗留的「unfinished」记录。
const legacyDraftPurge = (() => { let purged = false; return () => { if (purged) return; purged = true; void localforage.createInstance({ name: "episode-production-drafts", storeName: "unfinished" }).clear().catch(() => undefined); }; })();

export default function ProductionRoute({ dramaId }: { dramaId?: string } = {}) {
  const [query, setQuery] = useSearchParams(), { t } = useTranslation();
  const backendUrl = useBackendStore(state => state.url);
  const currentDramaId = dramaId || "";
  const episodeQuery = useQuery({
    queryKey: ["project-directory-episodes", backendUrl, currentDramaId],
    queryFn: async () => (await fetchBackendDramaEpisodes(currentDramaId)).episodes || [],
    enabled: Boolean(dramaId),
  });
  const episodes = episodeQuery.data;
  const refreshEpisodes = useCallback(() => {
    if (!dramaId) return;
    void episodeQuery.refetch();
  }, [dramaId, episodeQuery.refetch]);
  useEffect(() => {
    window.addEventListener("backend-retry", refreshEpisodes);
    window.addEventListener("backend-connected", refreshEpisodes);
    return () => {
      window.removeEventListener("backend-retry", refreshEpisodes);
      window.removeEventListener("backend-connected", refreshEpisodes);
    };
  }, [refreshEpisodes]);
  const requestedEpisodeId = query.get("episodeId");
  const episodeReadError = episodeQuery.error instanceof Error ? episodeQuery.error.message : String(episodeQuery.error || "");
  const episodesNotice = episodeQuery.isError && !isBackendAvailabilityError(episodeQuery.error) ? <Alert
    className="mb-5"
    type="warning"
    showIcon
    message={t("director.loadFailed")}
    description={episodeReadError}
  /> : undefined;
  // URL 指向的分集已不存在（如在「剧目」页签中被删除）时清理地址，避免刷新后一直带回退逻辑。
  useEffect(() => {
    if (!dramaId || !episodes || episodeQuery.isFetching || episodeQuery.isError || !requestedEpisodeId) return;
    if (episodes.some(item => item.id === requestedEpisodeId)) return;
    const next = new URLSearchParams(query);
    next.delete("episodeId");
    setQuery(next, { replace: true });
  }, [dramaId, episodes, episodeQuery.isFetching, episodeQuery.isError, requestedEpisodeId, query, setQuery]);
  if (!dramaId) return <ProductionEditor />;
  const seriesContext = { id: dramaId, episodes: episodes || [] };
  if (!episodes && !episodeQuery.isError) return <div className="p-6">{t("drama.production.loading")}</div>;
  if (!episodes && episodeQuery.isError) {
    if (requestedEpisodeId) return <ProductionEditor key={requestedEpisodeId} owner={{ kind: "episode", id: requestedEpisodeId }} series={seriesContext} notice={episodesNotice} />;
    // 读不到分集列表时不能把空列表当成「这个剧目还没有分集」，只标记列表不可读。
    return <ProductionEditor key={`series:${dramaId}`} series={seriesContext} episodesUnavailable onSeriesEpisodesChanged={refreshEpisodes} notice={episodesNotice ?? undefined} />;
  }
  if (episodes && episodeQuery.isError && requestedEpisodeId && !episodes.some(item => item.id === requestedEpisodeId)) {
    // A cached list cannot prove the selected episode was deleted while its refresh is failing.
    return <ProductionEditor key={requestedEpisodeId} owner={{ kind: "episode", id: requestedEpisodeId }} series={seriesContext} notice={episodesNotice} />;
  }
  const availableEpisodes = episodes ?? [];
  let selected;
  try { selected = dramaWorkbenchEpisode(availableEpisodes, requestedEpisodeId); }
  catch {
    // 请求的分集已不存在：回退到第一集，不再报「分集不属于当前剧目」。
    if (!availableEpisodes.length) return <ProductionEditor key={`series:${dramaId}`} series={{ id: dramaId, episodes: [] }} onSeriesEpisodesChanged={refreshEpisodes} />;
    selected = dramaWorkbenchEpisode(availableEpisodes, null);
  }
  if (!selected) return <ProductionEditor key={`series:${dramaId}`} series={{ id: dramaId, episodes: [] }} onSeriesEpisodesChanged={refreshEpisodes} notice={episodesNotice ?? undefined} />;
  return <ProductionEditor key={selected.id} owner={{ kind: "episode", id: selected.id }} series={seriesContext} onSeriesEpisodesChanged={refreshEpisodes} notice={episodesNotice} />;
}


type ProductionEditorProps = { owner?: ProductionCanvasContext["owner"]; embedded?: boolean; dialog?: boolean; series?: { id: string; episodes: DramaEpisode[] }; episodesUnavailable?: boolean; onSeriesEpisodesChanged?: () => void; notice?: ReactNode };
export function ProductionEditor(props: ProductionEditorProps) {
  const params = useParams();
  if (props.embedded) return <ProductionEditorContent {...props} />;
  // storageKey 与组件 key 同源：画布开合状态按制作对象隔离，刷新后按归属恢复。
  const ownerKey = `${props.owner?.kind || ""}:${props.owner?.id || params.episodeId || params.projectId || ""}`;
  return <WorkbenchCanvas key={ownerKey} storageKey={ownerKey}><ProductionEditorContent {...props} /></WorkbenchCanvas>;
}

function useOpenCanvasFromQuery(canvasHost: ReturnType<typeof useWorkbenchCanvas>, searchParams: URLSearchParams) {
  const openedRequest = useRef("");
  const projectId = searchParams.get("openCanvasId") || "";
  const nodeId = searchParams.get("nodeId") || undefined;
  const segmentId = searchParams.get("segmentId") || undefined;
  const requestKey = JSON.stringify([projectId, nodeId, segmentId]);
  useEffect(() => {
    if (!canvasHost || !projectId || openedRequest.current === requestKey) return;
    openedRequest.current = requestKey;
    canvasHost.openCanvas({ projectId, nodeId, segmentId });
  }, [canvasHost, projectId, nodeId, segmentId, requestKey]);
  return projectId;
}

function ProductionEditorContent({ owner, embedded = false, dialog = false, series, episodesUnavailable = false, onSeriesEpisodesChanged, notice }: ProductionEditorProps) {
  const canvasHost = useWorkbenchCanvas();
  const surfaceHost = useCanvasHost();
  const params = useParams();
  const folders = useCanvasStore(state => state.folders);
  const episodeId = owner?.kind === "episode" ? owner.id : owner ? "" : params.episodeId || "";
  const projectId = owner?.kind === "canvas" ? owner.id : owner ? "" : params.projectId || "";
  const contextProjectId = projectId;
  const [routeSearchParams, routeSetSearchParams] = useSearchParams();
  const searchParams = embedded && surfaceHost ? surfaceHost.search : routeSearchParams;
  const setSearchParams: typeof routeSetSearchParams = embedded && surfaceHost ? (next, options) => surfaceHost.navigate({ search: createSearchParams(typeof next === "function" ? next(searchParams) : next).toString() }, options) : routeSetSearchParams;
  const requestedCanvasId = useOpenCanvasFromQuery(canvasHost, searchParams);
  useEffect(() => {
    if (embedded || !requestedCanvasId || searchParams.get("openCanvasId") !== requestedCanvasId) return;
    setSearchParams(current => {
      const next = new URLSearchParams(current);
      next.delete("openCanvasId");
      return next;
    }, { replace: true });
  }, [embedded, requestedCanvasId, searchParams, setSearchParams]);
  const returnToDramas = searchParams.get("from") === "dramas" || Boolean(episodeId) || (Boolean(series) && !projectId && !episodeId);
  const backPath = returnToDramas ? "/projects?type=drama" : "/projects?type=canvas";
  const target = useMemo<ProductionTarget>(() => projectId ? { projectId } : episodeId, [projectId, episodeId]);
  // 只有剧目身份、没有分集或画布目标：跳过逐集取数，只渲染全剧规划工作区。
  const seriesOnly = Boolean(series) && !projectId && !episodeId;
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
  // 风格锚点等选择器需要同一剧目的共享资产画布节点；分集页本身只持有分集画布。
  const [sharedCanvasNodes, setSharedCanvasNodes] = useState<ProductionCanvasSnapshot>();
  const [production, setProduction] = useState<EpisodeProduction | null>(null);
  const sourceSegments = production ? productionSegments(production) : [];
  const clipRuntime = (segmentId: string, nodes: typeof canvasNodes = canvasNodes) => {
    const matches = productionSegmentRuntimeMatches(nodes as any, segmentId, productionContext?.owner);
    return matches.length === 1 ? matches[0] : undefined;
  };
  const [readiness, setReadiness] = useState<ProductionReadiness | null>(null);
  const [continuityReport, setContinuityReport] = useState<ProductionContinuity | undefined>();
  const [continuitySnapshot, setContinuitySnapshot] = useState<"draft" | "published">("draft");
  const [continuitySnapshotLoading, setContinuitySnapshotLoading] = useState(false);
  const continuityOwnerKey = `${productionOwner.kind}:${productionOwner.id}`;
  const continuityCheckRef = useRef<{ scope: object; operationId: string } | null>(null);
  const continuityReadRef = useRef({ ownerKey: continuityOwnerKey, snapshot: continuitySnapshot, displayedSnapshot: continuitySnapshot, loading: false, selection: 0, sequence: 0, active: true });
  if (continuityReadRef.current.ownerKey !== continuityOwnerKey) {
    continuityReadRef.current = { ownerKey: continuityOwnerKey, snapshot: continuitySnapshot, displayedSnapshot: continuitySnapshot, loading: false, selection: 0, sequence: 0, active: true };
  }
  useEffect(() => {
    const scope = continuityReadRef.current;
    scope.active = true;
    setContinuitySnapshotLoading(false);
    if (continuityCheckRef.current && continuityCheckRef.current.scope !== scope) {
      continuityCheckRef.current = null; setBusy(false);
    }
    return () => { scope.active = false; scope.sequence++; };
  }, [continuityOwnerKey]);
  // All report reads share one latest-request guard, including load/refresh/check.
  // Capture the owner as well: old callbacks must not adopt a new owner's scope.
  const beginContinuityRead = useCallback((snapshot = continuityReadRef.current.snapshot) => {
    const scope = continuityReadRef.current;
    const sequence = scope.ownerKey === continuityOwnerKey ? ++scope.sequence : scope.sequence;
    const selection = scope.selection;
    const isOwnerCurrent = () => scope.active && continuityReadRef.current === scope && scope.ownerKey === continuityOwnerKey;
    const isSelectionCurrent = () => isOwnerCurrent() && scope.selection === selection && scope.snapshot === snapshot;
    return { snapshot, isOwnerCurrent, isSelectionCurrent, isCurrent: () => isSelectionCurrent() && scope.sequence === sequence };
  }, [continuityOwnerKey]);
  const finishContinuityRead = useCallback((read: ReturnType<typeof beginContinuityRead>, report?: ProductionContinuity) => {
    if (!read.isCurrent()) return false;
    const scope = continuityReadRef.current;
    if (!report && !scope.loading) return false;
    scope.loading = false; setContinuitySnapshotLoading(false);
    if (report) { scope.displayedSnapshot = report.snapshot; setContinuityReport(report); }
    else {
      scope.snapshot = scope.displayedSnapshot; scope.selection++;
      setContinuitySnapshot(scope.displayedSnapshot);
    }
    return true;
  }, []);
  const [versions, setVersions] = useState<VersionItem[]>([]);
  const [batches, setBatches] = useState<ProductionBatch[]>([]);
  const [runtimeTasks, setRuntimeTasks] = useState<BackendRuntimeTask[]>([]);
  const [workspace, setWorkspace] = useState<DirectorWorkspace>("overview");
  const [briefDraft, setBriefDraft] = useState("");
  const priorFormalBrief = useRef<string | null>(null);
  const [sourceDrafts, setSourceDrafts] = useState<Record<string, string>>({});
  const dirtySourceDraftKeys = useMemo(() => Object.keys(sourceDrafts).filter(key => {
    const director = production?.draft.director;
    return !director || sourceDraftDiffersFromSaved(key, sourceDrafts[key], director);
  }), [sourceDrafts, production?.draft.director]);
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [loadError, setLoadError] = useState("");
  const backendReadFailed = useRef(false);
  const [agentError, setAgentError] = useState("");
  const [remoteRevision, setRemoteRevision] = useState<number | null>(null);
  const [draftKey, setDraftKey] = useState<string | null>(null);
  const [commandNotice, setPendingCommand] = useState<PendingCommand | null>(null);
  const [receiptRecoveryEpoch, setReceiptRecoveryEpoch] = useState(0);
  const [receiptRecovering, setReceiptRecovering] = useState(false);
  const commandNoticeRef = useRef<PendingCommand | null>(null);
  const pendingCommand = commandNeedsRecovery(commandNotice) ? commandNotice : null;
  const pendingCommandRef = useRef<PendingCommand | null>(null);
  const receiptRecoveryInFlight = useRef(false);
  const lastAutoReceiptCheckRef = useRef("");
  const [pendingRunStart, setPendingRunStart] = useState<PendingRunStart | null>(null);
  const pendingRunStartRef = useRef<PendingRunStart | null>(null);
  const [pendingCompilation, setPendingCompilation] = useState<PendingCompilation | null>(null);
  const pendingCompilationRef = useRef<PendingCompilation | null>(null);
  const [compiling, setCompiling] = useState(false);
  const [compileError, setCompileError] = useState("");
  const [compileNotice, setCompileNotice] = useState("");
  const [compileDiagnostics, setCompileDiagnostics] = useState<ProductionCompilationDiagnostic[]>([]);
  const [compileTargets, setCompileTargets] = useState<{ sourceHash: string; engineRuntimeId?: string; compilerHash?: string; items: Array<{ targetId: string; status: string }>; notReadyTargetIds?: string[] }>();
  const [autoTranslateCompilation, setAutoTranslateCompilation] = useState<{ id: string; targetIds: string[] } | null>(null);
  const startingRunRef = useRef(false);
  const handledAgentResultRef = useRef("");
  const setAgentState = useAgentStore(state => state.setAgentState);
  const agentTaskResult = useAgentStore(state => state.scopedTaskResult);
  const agentConversation = useAgentStore(state => state.conversation);
  const agentBusy = useAgentStore(state => state.sending || state.waiting);
  const pending = (value: PendingCommand | null) => { value = value ? normalizeCommandRecovery(value) : null; commandNoticeRef.current = value; pendingCommandRef.current = commandNeedsRecovery(value) ? value : null; setPendingCommand(value); };
  const setPendingRun = (value: PendingRunStart | null) => { pendingRunStartRef.current = value; setPendingRunStart(value); };
  const editorRootRef = useRef<HTMLElement>(null);
  const routeWorkspace = searchParams.get("workspace") as DirectorWorkspace | null;
  const seriesView = seriesWorkspaceView(searchParams.get("seriesView"));
  const routeTarget = searchParams.get("target") || "";
  const routeNodeId = searchParams.get("nodeId") || "";
  const routeSegmentId = searchParams.get("segmentId") || "";
  const routeWorkId = searchParams.get("workId") || "";

  const navigateWorkspace = (next: DirectorWorkspace, targetFocus?: { kind: string; id: string }, nextSeriesView?: SeriesWorkspaceView) => {
    useProductionFollowStore.getState().pause(t("productionCanvas.manualPause"));
    setSearchParams(productionWorkspaceQuery(searchParams, next, { embedded, target: targetFocus, seriesView: nextSeriesView }), { replace: true });
  };

  const load = useCallback(async (isActive: () => boolean = () => true, preserveBrief = false) => {
    const continuityRead = beginContinuityRead();
    const contextRequest = projectId
        ? Promise.all([fetchBackendProject(projectId), fetchBackendCanvasDrama(projectId), fetchProductionCanvasContext(projectId)]).then(([canvas, relation, ownership]) => ({ canvas: canvas.project, episode: relation.episode, scene: null, productionContext: ownership.context }))
        : fetchBackendDramaEpisode(episodeId).then(async result => {
          if (!result.episode) throw new Error(t("director.loadFailed"));
          const episode = result.episode;
          // 分集画布的 production-context 才会带上剧目共享资产画布 ID；读不到时按无共享画布处理。
          const ownership = episode.canvasId ? await fetchProductionCanvasContext(episode.canvasId).catch(() => null) : null;
          return { ...result, scene: null, productionContext: { role: "episode" as const, canvasId: episode.canvasId || "", episodeId: episode.id, dramaId: episode.dramaId, owner: { kind: "episode" as const, id: episode.id }, sharedAssetCanvasId: ownership?.context?.sharedAssetCanvasId || null } };
        });
    const [context, prod, history, ready, runHistory, continuity] = await Promise.all([
      contextRequest, fetchEpisodeProduction(target), fetchEpisodeProductionVersions(target),
      fetchProductionReadiness(target), fetchProductionBatches(target), fetchProductionContinuity(target, { snapshot: continuityRead.snapshot }),
    ]).catch(error => { finishContinuityRead(continuityRead); throw error; });
    const resolvedCanvasId = projectId || context.episode?.canvasId || "";
    const sourceSegmentNodes = productionSegments(prod.production).flatMap(segment => productionSegmentRuntimeMatches((context.canvas?.nodes || []) as any, String(segment.id), context.productionContext?.owner).map(match => match.node.id));
    const taskNodes = [...new Set([...sourceSegmentNodes, ...Object.values(prod.production.draft.director?.assets || {}).map(asset => asset.nodeId)].filter((id): id is string => Boolean(id)))];
    const tasks = resolvedCanvasId && taskNodes.length ? (await fetchBackendTasks({ projectId: resolvedCanvasId, nodeIds: taskNodes, summary: true }).catch(error => { finishContinuityRead(continuityRead); throw error; })).tasks || [] : [];
    const sharedCanvasId = String(context.productionContext?.sharedAssetCanvasId || "");
    const sharedNodes = sharedCanvasId && sharedCanvasId !== resolvedCanvasId ? (await fetchBackendProject(sharedCanvasId).catch(() => null))?.project : undefined;
    if (!isActive()) return null;
    setEpisode(context.episode || null);
    setProductionContext(context.productionContext);
    setTitle(context.episode?.title || String(context.canvas?.title || ""));
    setCanvasId(resolvedCanvasId);
    setCanvasRead(context.canvas && Array.isArray(context.canvas.nodes) ? { id: resolvedCanvasId, revision: Number(context.canvas.revision || 0), nodes: context.canvas.nodes as ProductionCanvasSnapshot["nodes"] } : undefined);
    setSharedCanvasNodes(sharedNodes && Array.isArray(sharedNodes.nodes) ? { id: sharedCanvasId, revision: Number(sharedNodes.revision || 0), nodes: sharedNodes.nodes as ProductionCanvasSnapshot["nodes"] } : undefined);
    setProduction(prod.production);
    setReadiness(ready.readiness);
    finishContinuityRead(continuityRead, continuity.continuity);
    setVersions(history.versions);
    setBatches(runHistory.runs);
    setRuntimeTasks(tasks);
    if (!preserveBrief) setBriefDraft(String(prod.production.draft.director?.source.brief || ""));
    backendReadFailed.current = false;
    setLoadError("");
    return context.episode?.id || (projectId ? `canvas:${projectId}` : episodeId);
  }, [target, projectId, contextProjectId, episodeId, t, beginContinuityRead, finishContinuityRead]);

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
    if (seriesOnly) return;
    let active = true;
    setDraftKey(null);
    void (async () => {
      await ensureCanvasDraftLease();
      if (!active) return;
      const ownerId = projectId ? `canvas:${projectId}` : episodeId;
      const key = `${backendConnection().url}:${ownerId}:${getCanvasDraftSessionId()}`;
      setDraftKey(key);
      const loadedOwner = await load(() => active);
      if (!loadedOwner || !active) return;
      legacyDraftPurge();
    })().catch(error => {
      if (!active) return;
      if (isBackendAvailabilityError(error)) {
        backendReadFailed.current = true;
        setLoadError("");
      } else {
        setLoadError(String(error));
        message.error(String(error));
      }
    });
    return () => { active = false; };
    // Initial route loads the remote formal draft; no local draft is restored or kept anymore.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [episodeId, projectId, load, message]);

  useEffect(() => {
    if (seriesOnly) return;
    const retry = () => {
      if (!backendReadFailed.current) return;
      backendReadFailed.current = false;
      void load(() => true, true).catch(error => {
        if (isBackendAvailabilityError(error)) backendReadFailed.current = true;
        else setLoadError(String(error));
      });
    };
    window.addEventListener("backend-retry", retry);
    window.addEventListener("backend-connected", retry);
    return () => {
      window.removeEventListener("backend-retry", retry);
      window.removeEventListener("backend-connected", retry);
    };
  }, [load, seriesOnly]);


  useEffect(() => {
    if (seriesOnly) { if (workspace !== "series") setWorkspace("series"); return; }
    if (routeWorkspace === "series" ? !series : !productionWorkspaces.includes(routeWorkspace as DirectorWorkspace)) {
        // 从剧目视图进入某个分集但没带显式工作区时回到分集总览，否则页面仍停在规划页像没有响应。
        if (!routeWorkspace && workspace === "series") setWorkspace("overview");
        return;
    }
    if (routeWorkspace && workspace !== routeWorkspace) setWorkspace(routeWorkspace);
  }, [routeWorkspace, workspace, series?.id, seriesOnly]);

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
          else if (workspace !== "shots") {
            const content = direct.closest<HTMLElement>("[data-production-workspace-content]");
            if (content) content.scrollTop += direct.getBoundingClientRect().top - content.getBoundingClientRect().top - 24;
          }
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
    const reasons = dirtySourceDraftKeys.length || briefDraft !== String(production.draft.director?.source.brief || "")
      ? "存在尚未保存的制作编辑" : pendingCommand ? t("productionHub.follow.pendingWrite") : pendingRunStart ? t("productionHub.follow.unknownRun") : exporting ? t("productionHub.follow.exportInProgress") : "";
    useProductionFollowStore.getState().setGuardReason("editor", reasons);
  }, [routeWorkId, projectId, episodeId, canvasId, production, dirtySourceDraftKeys, briefDraft, pendingCommand, pendingRunStart, exporting, t]);

  const remoteSequence = useRef(0);
  const refreshInFlight = useRef<Promise<EpisodeProduction | undefined> | null>(null);
  const refreshQueued = useRef(false);
  const skipProductionRefreshRevision = useRef<number | null>(null);
  const observedProductionRevision = useRef<{ episodeId: string; revision: number } | null>(null);
  useEffect(() => () => { remoteSequence.current++; useProductionFollowStore.getState().setGuardReason("editor", ""); }, [episodeId, projectId]);
  const refreshRemote = useCallback(async () => {
    // 一次编辑常触发两次刷新（显式调用 + drama-production.updated 事件）。合并成一次全量拉取，
    // in-flight 期间的后续调用只挂起一次尾随刷新，避免 7 个请求 × 2 的重复耗时。
    if (refreshInFlight.current) { refreshQueued.current = true; return refreshInFlight.current; }
    // 复用现有慢操作埋点：单请求各自记录，这里补一条整次扇出的总耗时，便于区分是哪个读取慢。
    const finishRefreshTelemetry = watchSlowBrowserOperation("production.refreshRemote");
    const run = (async () => {
      const sequence = ++remoteSequence.current;
      const continuityRead = beginContinuityRead();
      const sourceSegmentNodes = production ? productionSegments(production).flatMap(segment => productionSegmentRuntimeMatches(canvasNodes as any, String(segment.id), productionContext?.owner).map(match => match.node.id)) : [];
      const taskNodes = [...new Set([...sourceSegmentNodes, ...Object.values(production?.draft.director?.assets || {}).map(asset => asset.nodeId)].filter((id): id is string => Boolean(id)))];
      const [prod, ready, history, runHistory, canvas, tasks, continuity] = await Promise.all([
        fetchEpisodeProduction(target), fetchProductionReadiness(target), fetchEpisodeProductionVersions(target), fetchProductionBatches(target),
        fetchBackendProject(canvasId).then(value => value.project).catch(() => null),
        canvasId && taskNodes.length ? fetchBackendTasks({ projectId: canvasId, nodeIds: taskNodes, summary: true }).then(value => value.tasks || []) : Promise.resolve([]),
        fetchProductionContinuity(target, { snapshot: continuityRead.snapshot }),
      ]).catch(error => { finishContinuityRead(continuityRead); throw error; });
      if (sequence !== remoteSequence.current) return prod.production;
      const observed = observedProductionRevision.current;
      if (!observed || observed.episodeId !== prod.production.episodeId || prod.production.revision > observed.revision) {
        // Compile errors describe the source revision that produced them. A
        // newer saved/applied draft makes that local error obsolete.
        setCompileError("");
        setCompileNotice("");
      }
      observedProductionRevision.current = { episodeId: prod.production.episodeId, revision: prod.production.revision };
      setProduction(previous => !previous || previous.episodeId !== prod.production.episodeId || prod.production.revision > previous.revision ? prod.production : previous); setReadiness(previous => previous && previous.revision === ready.readiness.revision && previous.canvasRevision !== undefined && ready.readiness.canvasRevision !== undefined && previous.canvasRevision > ready.readiness.canvasRevision ? previous : ready.readiness); finishContinuityRead(continuityRead, continuity.continuity); setVersions(history.versions); setBatches(runHistory.runs);
      setRuntimeTasks(tasks);
      if (canvas) setCanvasRead({ id: canvasId, revision: Number(canvas.revision || 0), nodes: (canvas.nodes || []) as ProductionCanvasSnapshot["nodes"] });
      return prod.production;
    })();
    refreshInFlight.current = run;
    try { const value = await run; finishRefreshTelemetry("ok"); return value; }
    catch (error) { finishRefreshTelemetry(error instanceof Error ? `error:${error.name}` : "error"); throw error; }
    finally {
      refreshInFlight.current = null;
      if (refreshQueued.current) { refreshQueued.current = false; void refreshRemote(); }
    }
  }, [target, canvasId, beginContinuityRead, finishContinuityRead, production?.draft.director?.source.segments, production?.draft.director?.assets, canvasNodes, productionContext?.owner]);

  const refreshCompilationProjection = useCallback(async () => {
    const [prod, ready] = await Promise.all([fetchEpisodeProduction(target), fetchProductionReadiness(target)]);
    setProduction(previous => !previous || previous.episodeId !== prod.production.episodeId || prod.production.revision > previous.revision ? prod.production : previous);
    setReadiness(previous => previous && previous.revision > ready.readiness.revision ? previous : ready.readiness);
    return prod.production;
  }, [target]);

  const persistPendingCompilation = (value: PendingCompilation | null) => {
    pendingCompilationRef.current = value;
    setPendingCompilation(value);
  };

  const runProductionCompile = async (sceneId?: string, targetId?: string, requestedTargetIds?: string[]) => {
    if (compiling || !production?.draft.director) return;
    setCompiling(true);
    setCompileError("");
    setCompileNotice("");
    let compileRequestStarted = false;
    try {
      // The page can receive the production snapshot before its initial load
      // finishes. Verify the real session lease here instead of treating the
      // later UI draftKey state update as compile readiness.
      await ensureCanvasDraftLease();
      let compileSource = production;
      let pending = pendingCompilationRef.current;
      if (!pending) {
        if (pendingCommandRef.current) {
          setCompileError(pendingCommandMessage(pendingCommandRef.current));
          return;
        }
        if (dirtySourceDraftKeys.length || briefDraft !== String(production.draft.director.source.brief || "")) {
          // 编译使用 Backend 已保存源稿；未保存的前端编辑在编译时直接丢弃（无本机草稿兜底）。
          setBriefDraft(String(production.draft.director.source.brief || ""));
          setSourceDrafts({});
        }
        // Compile the canvas state the user just saved through this page, not a stale
        // Backend projection. Recovery keeps the original frozen operation unchanged.
        if (canvasId) await flushCanvasProjectBeforeGeneration(canvasId);
        compileSource = (await fetchEpisodeProduction(target)).production;
        setProduction(previous => !previous || previous.episodeId !== compileSource.episodeId || compileSource.revision > previous.revision ? compileSource : previous);
        const sourceSegments = productionSegments(compileSource);
        if (targetId && sourceSegments.some(segment => String(segment.id) === targetId && segment.locked === true)) {
          setCompileNotice(t("director.atomic.clipLocked"));
          return;
        }
        const sourceShots = compileSource.draft.director?.source.shots as Array<Record<string, any>> | undefined;
        const sceneShotIds = sceneId ? new Set((sourceShots || []).filter(shot => String(shot.scene_id || "") === sceneId).map(shot => String(shot.id))) : undefined;
        const eligibleClipIds = sourceSegments.filter(segment => segment.locked !== true
          && (!targetId || String(segment.id) === targetId)
          && (!requestedTargetIds || requestedTargetIds.includes(String(segment.id)))
          && (!sceneShotIds || (segment.shot_ids || []).some((id: string) => sceneShotIds.has(String(id)))))
          .map(segment => String(segment.id));
        if (!eligibleClipIds.length) {
          setCompileNotice(t("director.atomic.noUnlockedClips"));
          return;
        }
        pending = { operationId: `compile-${nanoid(14)}`, expectedRevision: compileSource.revision, scope: { targetIds: eligibleClipIds } };
        await persistPendingCompilation(pending);
      }
      compileRequestStarted = true;
      const started = await compileProduction(target, pending.expectedRevision, pending.operationId, pending.scope);
      let status: ProductionCompilationStatus = started.compilation;
      let waitedMs = 0;
      let pollDelayMs = 1200;
      const maxWaitMs = 600 * 1200;
      while (["queued", "running"].includes(status.status) && waitedMs < maxWaitMs) {
        const delayMs = Math.min(pollDelayMs, maxWaitMs - waitedMs);
        await new Promise(resolve => window.setTimeout(resolve, delayMs));
        waitedMs += delayMs;
        status = (await fetchProductionCompilation(target, pending.operationId)).compilation;
        pollDelayMs = Math.min(5000, Math.ceil(pollDelayMs * 1.6));
      }
      const diagnostics: ProductionCompilationDiagnostic[] = [];
      if (status.diagnosticCount) {
        let offset = 0;
        while (true) {
          const page = (await fetchProductionCompilation(target, pending.operationId, "diagnostics", { offset, pageSize: 100 })).compilation;
          const pageItems = page.items || [];
          diagnostics.push(...pageItems);
          if (!pageItems.length || page.nextOffset == null || page.nextOffset <= offset) break;
          offset = page.nextOffset;
        }
      }
      const targetResponse = status.targetCount
        ? await fetchProductionCompilation(target, pending.operationId, "targets", { pageSize: 100 }) : undefined;
      const compilationTargets = (targetResponse?.compilation.items || []) as Array<ProductionCompilationDiagnostic & { status?: string }>;
      const targetItems = compilationTargets.filter((item): item is ProductionCompilationDiagnostic & { targetId: string; status: string } => Boolean(item.targetId && item.status));
      const queueCompiledPromptTranslation = () => {
        const clipIds = new Set(productionSegments(compileSource).map(segment => String(segment.id || "")));
        const targetIds = targetItems.filter(item => item.status === "ready" && clipIds.has(String(item.targetId))).map(item => String(item.targetId));
        if (targetIds.length) setAutoTranslateCompilation({ id: nanoid(), targetIds });
      };
      const notReadyTargetIds = targetItems.filter(item => item.status !== "ready").map(item => item.targetId);
      const touchedCompileScopeIds = new Set([...(pending.scope?.targetIds || []).map(String), ...targetItems.map(item => String(item.targetId))]);
      const engineRuntimeId = status.engineRuntimeId ?? compileSource.draft.director?.engine.runtimeId;
      const compilerHash = status.compilerHash ?? compileSource.draft.director?.engine.compilerHash;
      const sameCompileBasis = compileTargets?.sourceHash === status.sourceHash
        && compileTargets.engineRuntimeId === engineRuntimeId
        && compileTargets.compilerHash === compilerHash;
      const previousNotReady = sameCompileBasis ? (compileTargets.notReadyTargetIds || []).filter(id => !touchedCompileScopeIds.has(String(id))) : [];
      const failedCompileScopeIds = new Set([...previousNotReady, ...notReadyTargetIds].map(String));
      const compileSourceValue = compileSource.draft.director?.source as Record<string, any> | undefined;
      for (const segment of Array.isArray(compileSourceValue?.segments) ? compileSourceValue!.segments : []) {
        if (touchedCompileScopeIds.has(String(segment.id))) for (const shotId of Array.isArray(segment.shot_ids) ? segment.shot_ids : []) touchedCompileScopeIds.add(String(shotId));
        if (!failedCompileScopeIds.has(String(segment.id))) continue;
        for (const shotId of Array.isArray(segment.shot_ids) ? segment.shot_ids : []) failedCompileScopeIds.add(String(shotId));
      }
      const diagnosticsForView = mergeScopedCompilationDiagnostics(compileDiagnostics, diagnostics, touchedCompileScopeIds, !pending.scope);
      const orderedDiagnostics = diagnosticsForView.map((item, index) => {
        const relatedToNotReady = [item.targetId, item.shotId, ...(item.affectedTargets || [])].some(id => id && failedCompileScopeIds.has(String(id)));
        const blocksCompile = item.blocksCompilation === true || item.severity === "error" || item.severity === "unverified" || item.blockingActions?.includes("compile");
        return { item, index, relatedToNotReady, priority: relatedToNotReady ? 0 : blocksCompile ? 1 : 2 };
      }).sort((left, right) => left.priority - right.priority || left.index - right.index).map(entry => entry.item);
      setCompileDiagnostics(orderedDiagnostics);
      const recordSyncedTargets = (referenceSync?: Array<{ targetId: string; status: string }>) => {
        if (!status.sourceHash) return;
        const hasSyncReceipt = Array.isArray(referenceSync), synced = new Set((referenceSync || []).filter(item => item.status === "ready").map(item => item.targetId));
        const items = hasSyncReceipt ? targetItems.filter(item => item.status === "ready" && synced.has(item.targetId)).map(item => ({ targetId: item.targetId, status: "ready" })) : [];
        const touchedIds = new Set((hasSyncReceipt ? targetItems : targetItems.filter(item => item.status !== "ready")).map(item => item.targetId));
        const newlyNotReadyIds = targetItems.filter(item => item.status !== "ready" || hasSyncReceipt && !synced.has(item.targetId)).map(item => item.targetId);
        setCompileTargets(current => {
          const previous = current?.sourceHash === status.sourceHash
            && current.engineRuntimeId === engineRuntimeId
            && current.compilerHash === compilerHash
            ? current
            : { sourceHash: status.sourceHash, engineRuntimeId, compilerHash, items: [], notReadyTargetIds: [] as string[] };
          const readyItems = [...previous.items.filter(item => !touchedIds.has(item.targetId)), ...items];
          const notReady = new Set((previous.notReadyTargetIds || []).filter(id => !touchedIds.has(id)));
          for (const id of newlyNotReadyIds) notReady.add(id);
          return { sourceHash: status.sourceHash, engineRuntimeId, compilerHash, items: readyItems, ...(notReady.size ? { notReadyTargetIds: [...notReady] } : {}) };
        });
      };
      const describe = (item: ProductionCompilationDiagnostic) => item.message?.trim() || "";
      const clipContext = (items: ProductionCompilationDiagnostic[]) => [...new Set(items.map(item => item.targetId).filter((id): id is string => Boolean(id)))].map(id => {
        const index = productionSegments(compileSource).findIndex(segment => String(segment.id) === id);
        if (index >= 0) return t("director.studio.clipNumber", { number: index + 1 });
        const source = compileSource.draft.director?.source as Record<string, any> | undefined;
        const asset = (Array.isArray(source?.asset_plan) ? source!.asset_plan : []).find((item: Record<string, any>) => String(item.id) === id);
        const assetName = String(asset?.asset_name || asset?.name || asset?.title || "").trim();
        return assetName ? `素材「${assetName}」` : id;
      }).join("、");
      const diagnosticContext = (items: ProductionCompilationDiagnostic[]) => [...new Set(items.map(describe).filter(Boolean))].join("；");
      const continuityLocationContext = (items: ProductionCompilationDiagnostic[]) => {
        const source = compileSource.draft.director?.source as Record<string, any> | undefined;
        if (!source) return "";
        const fps = Number(source.fps_num || 24) / Number(source.fps_den || 1);
        return continuityDiagnosticLocations(source, items).map(location => {
          const clipIndex = productionSegments(compileSource).findIndex(segment => String(segment.id) === location.segmentId);
          const clip = clipIndex >= 0 ? `${t("director.studio.clipNumber", { number: clipIndex + 1 })}（${location.segmentId}）` : location.segmentId;
          return t("director.atomic.compileFrameLocation", {
            clip, shot: `${location.shotTitle} (${location.shotId})`,
            start: frameTimecode(location.startFrame, fps), end: frameTimecode(location.endFrameExclusive, fps),
            firstFrame: location.startFrame + 1, lastFrame: location.endFrameExclusive,
          });
        }).join("；");
      };
      const appendContinuityLocations = (message: string, items: ProductionCompilationDiagnostic[]) => {
        const locations = continuityLocationContext(items);
        return locations ? `${message}\n${t("director.atomic.compileFrameRangeHint", { locations })}` : message;
      };
      const continuitySummary = (items: ProductionCompilationDiagnostic[]) => {
        const affectedClipIds = [...new Set(items.flatMap(item => item.affectedTargets || []))];
        const clipNames = affectedClipIds.map(id => {
          const index = productionSegments(compileSource).findIndex(segment => String(segment.id) === id);
          return index >= 0 ? `${t("director.studio.clipNumber", { number: index + 1 })}（${id}）` : id;
        });
        const count = affectedClipIds.length || new Set(items.map(item => item.targetId).filter(Boolean)).size || items.length;
        const clips = clipNames.length ? `（${clipNames.join("、")}）` : "";
        const message = items.some(item => item.code === "CONTINUITY_COVERAGE_MISSING")
          ? t("director.atomic.compileHintContinuity", { count: t("director.atomic.compileAffectedCount", { count }), clips: clipNames.join("、"), evidence: diagnosticContext(items) })
          : `${t("director.atomic.compileAffectedCount", { count })}${clips}：${diagnosticContext(items)}`;
        return appendContinuityLocations(message, items);
      };
      const groupedDiagnostics = new Map<string, ProductionCompilationDiagnostic[]>();
      for (const item of orderedDiagnostics) {
        const relatedToNotReady = [item.targetId, item.shotId, ...(item.affectedTargets || [])].some(id => id && failedCompileScopeIds.has(String(id)));
        const scope = relatedToNotReady ? "not-ready:" : "other:";
        const key = item.code === "CONTINUITY_COVERAGE_MISSING" || item.code === "PROMPT_SOURCE_MAP_INVALID"
          ? scope + item.code
          : scope + (describe(item) || item.code || "unknown");
        groupedDiagnostics.set(key, [...(groupedDiagnostics.get(key) || []), item]);
      }
      const warningDetails = [...groupedDiagnostics].slice(0, 10).map(([key, items]) => {
        const affected = new Set(items.map(item => item.targetId).filter(Boolean));
        const count = affected.size || items.length;
        const countText = t("director.atomic.compileAffectedCount", { count });
        if (items.some(item => item.code?.startsWith("CONTINUITY_"))) return continuitySummary(items);
        if (key.endsWith("PROMPT_SOURCE_MAP_INVALID")) return t("director.atomic.compileHintSourceMap", { count: countText, clips: clipContext(items) });
        return `${countText}：${describe(items[0]) || items[0].code || t("director.atomic.compileHintOther")}`;
      });
      const notReadyTargetReasons = (items: Array<ProductionCompilationDiagnostic & { targetId: string; status: string }>) => items.map(targetItem => {
        const targetId = String(targetItem.targetId), scopeIds = new Set([targetId]);
        const source = compileSource.draft.director?.source as Record<string, any> | undefined;
        const sourceSegment = (Array.isArray(source?.segments) ? source!.segments : []).find((item: Record<string, any>) => String(item.id) === targetId);
        for (const shotId of sourceSegment?.shot_ids || []) scopeIds.add(String(shotId));
        const segment = productionSegments(compileSource).find(item => String(item.id) === targetId);
        for (const shotId of segmentShotIds(segment || {})) scopeIds.add(String(shotId));
        const related = orderedDiagnostics.filter(item => [item.targetId, item.shotId, ...(item.affectedTargets || [])].some(id => id && scopeIds.has(String(id))));
        const blockers = related.filter(blocksCompilationDiagnostic);
        const reasons = [...new Set((blockers.length ? blockers : related).map(item => describe(item)).filter(Boolean))];
        const label = clipContext([targetItem]);
        return `${label}：${reasons.length ? reasons.join("；") : t("director.atomic.compileTargetNoReason", { status: targetItem.status })}`;
      });
      const completionNotice = () => {
        const warningNotice = status.verdict === "passed_with_warnings" && status.diagnosticCount
          ? ` · ${t("director.atomic.compileWarnings", { count: status.diagnosticCount })}` : "";
        const readyTargets = targetItems.filter(item => item.status === "ready");
        const notReadyTargets = targetItems.filter(item => item.status !== "ready");
        const clipIds = new Set(productionSegments(compileSource).map(segment => String(segment.id || "")).filter(Boolean));
        const readyClipCount = readyTargets.filter(item => clipIds.has(String(item.targetId))).length;
        const readyOtherTargetCount = readyTargets.length - readyClipCount;
        const targetCount = status.targetCount || productionSegments(compileSource).length;
        const resultNotice = targetItems.length && notReadyTargets.length
          ? t("director.atomic.compilePartial", { ready: readyTargets.length, total: targetItems.length, notReady: notReadyTargets.length, clips: clipContext(notReadyTargets) })
          : targetItems.length
            ? readyClipCount > 0
              ? readyOtherTargetCount > 0
                ? t("director.atomic.compileDoneWithOtherTargets", { clips: readyClipCount, other: readyOtherTargetCount })
                : t("director.atomic.compileDone", { count: readyClipCount })
              : t("director.atomic.compileDoneTargets", { count: readyTargets.length })
            : t("director.atomic.compileDoneTargets", { count: targetCount });
        const causeNotice = notReadyTargets.length ? `\n${t("director.atomic.compileTargetCauseTitle")}\n${notReadyTargetReasons(notReadyTargets).join("\n")}` : "";
        return resultNotice
          + causeNotice + warningNotice + (warningDetails.length ? `\n\n${warningDetails.join("\n\n")}` : "");
      };
      if (status.application?.revision !== undefined) {
        recordSyncedTargets(status.application.referenceSync);
        await persistPendingCompilation(null);
        skipProductionRefreshRevision.current = status.application.revision;
        setCompileNotice(completionNotice());
        await refreshCompilationProjection();
        queueCompiledPromptTranslation();
        return;
      }
      if (status.status === "succeeded" && status.verdict !== "blocked" && status.preparedId) {
        skipProductionRefreshRevision.current = compileSource.revision + 1;
        const applied = await applyProductionCompilation(target, status.preparedId);
        recordSyncedTargets(applied.receipt.referenceSync);
        skipProductionRefreshRevision.current = applied.receipt.revision ?? skipProductionRefreshRevision.current;
        await persistPendingCompilation(null);
        setCompileNotice(completionNotice());
        await refreshCompilationProjection();
        queueCompiledPromptTranslation();
        return;
      }
      if (["succeeded", "blocked", "interrupted", "failed"].includes(status.status)) await persistPendingCompilation(null);
      recordSyncedTargets();
      const blocker = status.blockingDiagnostic;
      const blockingItems = diagnostics.filter(blocksCompilationDiagnostic);
      const blockingDetails = [...new Set(blockingItems.map(item => {
        const matching = blockingItems.filter(candidate => candidate.code === item.code);
        const affected = new Set(matching.map(candidate => candidate.targetId).filter(Boolean));
        const count = affected.size || matching.length;
        const countText = t("director.atomic.compileAffectedCount", { count });
        if (matching.some(candidate => candidate.code?.startsWith("CONTINUITY_"))) return continuitySummary(matching);
        if (item.code === "PROMPT_SOURCE_MAP_INVALID") return t("director.atomic.compileHintSourceMap", { count: countText, clips: clipContext(matching) });
        return describe(item);
      }).filter(Boolean))].slice(0, 10);
      setCompileError(blockingDetails.length ? blockingDetails.join("\n") : blocker
        ? describe(blocker)
        : t("director.atomic.compileBlocked", { status: status.status === "succeeded" ? status.verdict : status.status }));
    } catch (error) {
      // 终局失败（连不上服务器 status 0、4xx 除 408）清掉待编译标记；只有可能已送达的
      // 408/5xx 保留标记以便幂等续编。
      const uncertain = error instanceof BackendApiError && (error.status === 408 || error.status >= 500);
      if (compileRequestStarted && !uncertain) await persistPendingCompilation(null);
      setCompileError(error instanceof Error ? error.message : String(error));
    } finally {
      setCompiling(false);
    }
  };

  useEffect(() => {
    const onProductionEvent = (event: Event) => {
      const value = (event as CustomEvent<{ type?: string; entityId?: string; payload?: { runId?: string; revision?: number } }>).detail;
      const aliases = new Set([projectId, episodeId, canvasId, episode?.id, episode?.canvasId, ...(readiness?.presentation?.aliases || [])].filter(Boolean));
      if (value?.payload?.revision && value.payload.revision === skipProductionRefreshRevision.current) {
        skipProductionRefreshRevision.current = null;
        return;
      }
      // Run receipts are covered by the active single-flight poller and task events.
      // A full refresh here fans each progress write into seven reads.
      if (value?.type === "drama-production.updated" && value.entityId && aliases.has(value.entityId) && !value.payload?.runId) void refreshRemote();
    };
    window.addEventListener("backend-event", onProductionEvent);
    return () => window.removeEventListener("backend-event", onProductionEvent);
  }, [projectId, episodeId, canvasId, episode, readiness?.presentation?.aliases, refreshRemote]);

  // A manually edited canvas Prompt does not change the director source revision.
  // Refresh only readiness after its confirmed canvas revision changes, not all source/history.
  useEffect(() => {
    const revision = liveCanvas?.revision;
    if (!production?.draft.director || !canvasId || revision === undefined || (readiness?.canvasRevision !== undefined && readiness.canvasRevision >= Number(revision))) return;
    let active = true;
    void fetchProductionReadiness(target).then(result => {
      if (!active) return;
      const currentRevision = useCanvasStore.getState().projects.find(project => project.id === canvasId)?.revision;
      if (result.readiness.canvasRevision !== undefined && currentRevision !== undefined && result.readiness.canvasRevision < Number(currentRevision)) return;
      setReadiness(previous => previous && previous.revision > result.readiness.revision ? previous : result.readiness);
    }).catch(fail);
    return () => { active = false; };
  }, [canvasId, liveCanvas?.revision, target, production?.revision]);

  const pollingTaskNodes = useMemo(() => {
    const segmentNodes = production ? productionSegments(production).flatMap(segment => productionSegmentRuntimeMatches(canvasNodes as any, String(segment.id), productionContext?.owner).map(match => match.node.id)) : [];
    return [...new Set([...segmentNodes, ...Object.values(production?.draft.director?.assets || {}).map(asset => asset.nodeId)].filter((id): id is string => Boolean(id)))];
  }, [production?.draft.director?.source.segments, production?.draft.director?.assets, canvasNodes, productionContext?.owner]);
  const pollingTaskNodesKey = JSON.stringify(pollingTaskNodes);
  const hasActiveSceneWork = production?.draft.director?.workflow.sharedReviewContinuation?.status === "active" || [...Object.values(production?.draft.director?.workflow.sceneWorks || {}), ...Object.values(production?.draft.director?.workflow.sharedReviewWorks || {})].some(work => ["pending", "running", "awaiting_media"].includes(work.status));
  const hasActiveClipRefresh = production?.clipRefreshes?.some(job => ["queued", "checking", "compiling", "applying"].includes(job.status)) || false;
  const hasActiveProductionWork = hasActiveSceneWork || hasActiveClipRefresh || batches.some(run => ["pending", "running"].includes(run.status)) || runtimeTasks.some(task => ["queued", "running", "awaiting_confirmation"].includes(task.status));
  useEffect(() => {
    if (!hasActiveProductionWork) return;
    let active = true;
    let lastReadinessPollAt = Date.now();
    let readinessRefreshQueued = false;
    const knownTaskStatuses = new Map(runtimeTasks.map(task => [task.id, task.status]));
    const refreshReadiness = async () => {
      if (readinessRefreshQueued || Date.now() - lastReadinessPollAt < 1_000) return;
      readinessRefreshQueued = true;
      try {
        const ready = await fetchProductionReadiness(target);
        if (!active) return;
        setReadiness(ready.readiness);
        lastReadinessPollAt = Date.now();
      } catch { /* Status events are advisory; the bounded poll remains the fallback. */ }
      finally { readinessRefreshQueued = false; }
    };
    const poller = startSingleFlightPoller({
      intervalMs: 5000,
      initiallyPaused: document.hidden,
      poll: async () => {
        const [runs, tasks, sceneProduction] = await Promise.all([
          fetchProductionBatches(target),
          canvasId && pollingTaskNodes.length ? fetchBackendTasks({ projectId: canvasId, nodeIds: pollingTaskNodes, summary: true }) : Promise.resolve({ tasks: [] as BackendRuntimeTask[] }),
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
    // 同一失败已经进入顶部回执卡（当前工作区可见）时不再重复弹 toast。
    const recorded = commandNoticeRef.current;
    if ((error as { commandRecorded?: boolean })?.commandRecorded && recorded && (recorded.workspace === workspace || !recorded.workspace)) return;
    if (error instanceof BackendApiError && error.status === 409) {
      const current = error.details.current as EpisodeProduction | undefined;
      setRemoteRevision(current?.revision ?? null);
      message.warning(t("drama.production.conflict"));
    } else if (error instanceof BackendApiError) {
      const summary = commandErrorSummary({ error: error.message, errorSummary: typeof error.details.error === "string" ? error.details.error : undefined });
      message.error(summary || t("apiErrors.requestFailed"));
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
      adopt_director_clip_style: t("director.workspace.adoptClipStyle", { style: String(op.styleTemplateId || t("director.workspace.clipStyleNone")) }),
      edit_director_continuity: t("director.workspace.continuity.saveLedger"),
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

  const sendCommand = async (input: PendingCommand, recovering = false) => {
    const command = { ...input, workspace: input.workspace || workspace };
    if (!draftKey) throw new Error(t("drama.production.draftNotReady"));
    await ensureCanvasDraftLease();
    const previous = pendingCommandRef.current;
    if (previous && (previous.operationId !== command.operationId || previous.status === "rejected")) throw new Error(pendingCommandMessage(previous));
    pendingCommandRef.current = command;
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
      pending(null); setProduction(previous => !previous || previous.episodeId !== result.production.episodeId || result.production.revision > previous.revision ? result.production : previous); setRemoteRevision(null);
      return result.production;
    } catch (error) {
      const saved = commandFailureRecord(command, {
        httpStatus: error instanceof BackendApiError ? error.status : 0,
        error: error instanceof Error ? error.message : String(error),
        errorSummary: error instanceof BackendApiError && typeof error.details.error === "string" ? error.details.error : undefined,
        errorCode: error instanceof BackendApiError ? String(error.details.code || "") : undefined,
      }, recovering);
      pending(saved);
      // 顶部回执卡已经记录了这次失败；标记后由 fail() 跳过重复 toast。
      if (error instanceof Error) (error as Error & { commandRecorded?: boolean }).commandRecorded = true;
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
      // sendCommand installs the authoritative production returned by the write.
      // The Backend update event refreshes readiness, canvas projections and other derived views;
      // don't make this editor wait for that second multi-request read before unlocking.
      return true;
    } catch (error) { fail(error); return false; }
    finally { setBusy(false); }
  };
  const workspaceCommandInFlight = useRef(false);
  const preparedProjectionSource = useRef("");
  useEffect(() => {
    if ((!embedded && workspace !== "assets") || !owner || !production || !draftKey) return;
    const receive = (event: Event) => {
      const detail = (event as CustomEvent<{ owner: NonNullable<ProductionCanvasContext["owner"]>; command: { kind: "prepare"; targets: string[] } | { kind: "arrange"; sceneId: string } | { kind: "adopt"; assetId: string; approvedId: string } | { kind: "edit"; ops: ProductionOperation[] } }>).detail;
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
  }, [embedded, workspace, owner?.kind, owner?.id, production, draftKey, busy, refreshRemote, message, t]);

  useEffect(() => {
    if ((!embedded && workspace !== "assets") || !owner || !production?.draft.director || !draftKey || busy || pendingCommandRef.current || workspaceCommandInFlight.current) return;
    const director = production.draft.director;
    const entities = productionEntities(director.source, owner);
    const plans = Array.isArray(director.source.asset_plan) ? director.source.asset_plan.map(value => value && typeof value === "object" ? value as Record<string, any> : {}) : [];
    const subjects = Array.isArray(director.source.subject_registry) ? director.source.subject_registry.map(value => value && typeof value === "object" ? value as Record<string, any> : {}) : [];
    const targets: string[] = [];
    const pictureProjectionTargets = entities.flatMap(entity => {
      if (entity.kind !== "prop" && entity.kind !== "scene") return [];
      const subjectKind = entity.kind === "prop" ? "asset" : "scene";
      const subject = subjects.find(item => item.entityRef?.ownerKind === owner.kind && item.entityRef?.ownerId === owner.id
        && item.entityRef?.kind === subjectKind && String(item.entityRef?.id || "") === entity.entityId);
      const bindings = Array.isArray(subject?.pictureBindings) ? subject.pictureBindings as Array<Record<string, any>> : [];
      const picture = bindings.find(item => Array.isArray(item.defaultFor) && item.defaultFor.includes("identity")) || bindings[0];
      const image = director.assets[String(picture?.assetId || "")];
      const storageKey = String(image?.storageKey || "");
      if (!picture || picture.sourceNode?.projectId !== canvasId || !storageKey) return [];
      const node = canvasNodes.find(item => matchesProductionAssetNode(item, entity.kind, owner, entity.entityId));
      if (!node || picture.sourceNode?.nodeId === node.id) return [];
      const field = entity.kind === "prop" ? "propImage" : "sceneImage";
      return String((node.metadata?.[field] as Record<string, any> | undefined)?.storageKey || "") !== storageKey ? [`entity:${entity.kind}:${entity.entityId}`] : [];
    });
    const sharedPictureState = entities.flatMap(entity => {
      const sharedPlan = plans.find(plan => String(plan.entity_id || plan.id || plan.asset_id || "") === entity.entityId && plan.sharedSource);
      if (!sharedPlan) return [];
      const subjectKind = entity.kind === "prop" ? "asset" : entity.kind;
      const subject = subjects.find(item => item.entityRef?.ownerKind === owner.kind && item.entityRef?.ownerId === owner.id
        && item.entityRef?.kind === subjectKind && String(item.entityRef?.id || "") === entity.entityId);
      const node = canvasNodes.find(item => matchesProductionAssetNode(item, entity.kind, owner, entity.entityId));
      if (!node || !subject) return [];
      const pictureBound = (Array.isArray(subject.pictureBindings) ? subject.pictureBindings : []).some((picture: Record<string, any>) => picture.sourceNode?.projectId === canvasId && picture.sourceNode?.nodeId === node.id);
      if (!pictureBound) targets.push(`entity:${entity.kind}:${entity.entityId}`);
      const metadata = node.metadata || ({ } as { characterImages?: Array<Record<string, any>>; sceneImage?: Record<string, any>; propImage?: Record<string, any>; storageKey?: string });
      const media = entity.kind === "character" ? (Array.isArray(metadata.characterImages) ? metadata.characterImages as Array<Record<string, any>> : []).map(image => image.storageKey || "")
        : entity.kind === "scene" ? [((metadata.sceneImage && typeof metadata.sceneImage === "object") ? metadata.sceneImage as Record<string, any> : {}).storageKey || ""]
          : [((metadata.propImage && typeof metadata.propImage === "object") ? metadata.propImage as Record<string, any> : {}).storageKey || metadata.storageKey || ""];
      return [[entity.entityId, pictureBound, media]];
    });
    targets.push(...entities.filter(entity => !canvasNodes.some(node => matchesProductionAssetNode(node, entity.kind, owner, entity.entityId))).map(entity => `entity:${entity.kind}:${entity.entityId}`), ...pictureProjectionTargets);
    const key = `${owner.kind}:${owner.id}:${production.revision}:${director.sourceHash}:${JSON.stringify(sharedPictureState)}:${[...new Set(targets)].sort().join(",")}`;
    if (preparedProjectionSource.current === key) return;
    preparedProjectionSource.current = key;
    if (targets.length) window.dispatchEvent(new CustomEvent("production-workspace-command", { detail: { owner, command: { kind: "prepare", targets: [...new Set(targets)] } } }));
  }, [embedded, workspace, owner?.kind, owner?.id, production, draftKey, busy, canvasNodes]);

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
    if (!command || command.status !== "unknown" || busy || receiptRecoveryInFlight.current) return;
    // Receipt reconciliation is read-only. Keep local source drafts editable while
    // the Backend is unavailable; pendingCommandRef still blocks every new write.
    receiptRecoveryInFlight.current = true;
    setReceiptRecovering(true);
    try {
      let receipt: Awaited<ReturnType<typeof fetchProductionOperationReceipt>> | undefined;
      try { receipt = await fetchProductionOperationReceipt(target, command.operationId); }
      catch (error) {
        // Older Backend builds do not expose receipt reads; exact idempotent replay remains safe.
        if (!(error instanceof BackendApiError) || error.status !== 404) throw error;
      }
      if (receipt?.found && receipt.production) {
        pendingCommandRef.current = null;
        pending(null);
        setProduction(current => !current || current.episodeId !== receipt.production!.episodeId || receipt.production!.revision > current.revision ? receipt.production! : current);
        setRemoteRevision(null);
        await refreshRemote();
        message.success(t("drama.production.receiptRecovered"));
        return;
      }
      if (!receipt) {
        // Older Backend builds lack the read endpoint; recover by exact idempotent replay.
        await sendCommand(command, true);
        await refreshRemote();
        message.success(t("drama.production.receiptRecovered"));
        return;
      }
      // Production edits and their receipt commit atomically. No durable receipt means
      // this command did not commit; drop only the command lock and preserve local edits.
      pendingCommandRef.current = null;
      pending(null);
      setRemoteRevision(null);
      await refreshRemote();
      message.info(t("drama.production.receiptNotFound"));
    }
    catch (error) { fail(error); }
    finally { receiptRecoveryInFlight.current = false; setReceiptRecovering(false); }
  };

  useEffect(() => {
    const retry = () => setReceiptRecoveryEpoch(value => value + 1);
    window.addEventListener("backend-connected", retry);
    window.addEventListener("online", retry);
    document.addEventListener("visibilitychange", retry);
    return () => {
      window.removeEventListener("backend-connected", retry);
      window.removeEventListener("online", retry);
      document.removeEventListener("visibilitychange", retry);
    };
  }, []);

  useEffect(() => {
    const command = pendingCommand;
    if (!command || busy || receiptRecovering || document.hidden) return;
    const checkKey = `${command.operationId}:${receiptRecoveryEpoch}`;
    if (lastAutoReceiptCheckRef.current === checkKey) return;
    lastAutoReceiptCheckRef.current = checkKey;
    void recoverPending();
  }, [pendingCommand?.operationId, busy, receiptRecovering, receiptRecoveryEpoch]);

  const resolveRejected = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await load(() => true, true);
      pendingCommandRef.current = null;
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

  const askDirector = async (scope: { workspace: DirectorWorkspace; targetId?: string; targetKind?: "scene"; instruction?: string; brief?: string; workId?: string; clipContext?: boolean }) => {
    if (pendingCommandRef.current) return warnPendingCommand();
    const requestedBrief = scope.brief;
    let currentProduction = await fetchEpisodeProduction(target).then(result => result.production);
    if (requestedBrief !== undefined && requestedBrief !== String(currentProduction.draft.director?.source.brief || "")) {
      await saveBrief(requestedBrief || "");
      currentProduction = await fetchEpisodeProduction(target).then(result => result.production);
    }
    setProduction(currentProduction);
    const director = currentProduction.draft.director;
    if (!director) return message.error(t("director.workspace.engineUnavailable"));
    if (requestedBrief !== undefined && String(director.source.brief || "") !== requestedBrief) return message.error(t("director.workspace.briefSaveFailed"));
    const agent = useAgentStore.getState();
    if (!agent.enabled || !agent.connected || !["ready", "warning"].includes(agent.conversation.status)) {
      useProductionWorkspaceStore.getState().setPanelTab("director");
      useAgentStore.getState().openPanel();
      return message.warning(t("director.workspace.agentDisconnected"));
    }
    if (agent.sending || agent.waiting || agent.loadingThreads || ["preparing", "running"].includes(agent.conversation.status)) return message.warning(t("director.workspace.agentBusy"));
    const readinessNow = await fetchProductionReadiness(target).then(result => result.readiness);
    setReadiness(readinessNow);
    const targetObject = scope.targetId ? readinessNow.targets.find(item => item.targetId === scope.targetId || item.id === scope.targetId) : undefined;
    const key = productionOwner.id;
    const id = nanoid();
    const ownerKind = productionOwner.kind;
    const followTarget = useProductionFollowStore.getState().target;
    const workId = scope.workId || (followTarget?.kind === ownerKind && followTarget.id === key ? followTarget.workId : nanoid());
    const targetId = scope.targetId || "";
    const readInstruction = (() => {
      const episodeArgs = `kind:"${ownerKind}", id:"${key}", snapshot:"draft"`;
      const targetList = targetId ? `, targetIds:["${targetId}"]` : "";
      const workbench = (view: "subject_workbench" | "shot_workbench" | "clip_workbench") => `mcp__infinite_canvas__production_get_workbench({${episodeArgs}, targetId:"${targetId}", view:"${view}"})`;
      const source = (section: string) => `mcp__infinite_canvas__production_get_source({${episodeArgs}, sourceSection:"${section}"${targetList}})`;
      if (scope.workspace === "series") return `mcp__infinite_canvas__drama_get_project({dramaId:"${episode?.dramaId || ""}"})`;
      if (scope.targetKind === "scene" && targetId) return `mcp__infinite_canvas__production_get_scene_production({sceneId:"${targetId}", snapshot:"draft"})`;
      if (scope.workspace === "continuity" || scope.workspace === "advanced") return `mcp__infinite_canvas__production_get_continuity({${episodeArgs}, view:"${targetId ? "issues" : "summary"}"${targetId ? `, targetId:"${targetId}"` : ""}})`;
      if (targetObject?.kind === "segment" || scope.clipContext) return workbench("clip_workbench");
      if (targetObject?.kind === "keyframe" || scope.workspace === "shots" && targetId) return workbench("shot_workbench");
      if (scope.workspace === "story") return source(targetId ? "script_scenes" : "script");
      if (scope.workspace === "assets") return source(targetId ? "asset_cards" : "asset_plan");
      if (scope.workspace === "shots") return source("shots");
      if (scope.workspace === "clips") return source("clip_groups");
      if (scope.workspace === "production") return targetId ? `mcp__infinite_canvas__production_get_artifact_index({kind:"${ownerKind}", id:"${key}", snapshot:"draft", targetIds:["${targetId}"]})` : `mcp__infinite_canvas__production_get({kind:"${ownerKind}", id:"${key}", snapshot:"draft"})`;
      if (scope.workspace === "overview" && targetObject?.kind === "asset") return source("asset_cards");
      if (scope.workspace === "overview" && targetId) return `mcp__infinite_canvas__production_get_artifact_index({kind:"${ownerKind}", id:"${key}", snapshot:"draft", targetIds:["${targetId}"]})`;
      if (scope.workspace === "overview") return `mcp__infinite_canvas__production_get({kind:"${ownerKind}", id:"${key}", snapshot:"draft"})`;
      return source("context");
    })();
    const contractModule = scope.targetKind === "scene" ? "shots"
      : targetObject?.kind === "segment" ? "shots"
      : targetObject?.kind === "keyframe" ? "shots"
      : targetObject?.kind === "asset" ? "assets"
      : ({ series: "story", overview: undefined, story: "story", assets: "assets", shots: "shots", continuity: "continuity", clips: "model", production: "model", advanced: "continuity" } as const)[scope.workspace];
    const text = [
      "$acheng-director",
      `请用中文围绕“${scope.workspace}${targetId ? ` · ${targetObject?.kind || scope.targetKind || "目标"} ${targetId}` : ""}”与用户讨论。`,
      `先调用 ${readInstruction} 读取当前正式内容，只看与本次讨论有关的信息。`,
      requestedBrief !== undefined ? `用户需求：${requestedBrief}` : "",
      scope.instruction ? `补充要求：${scope.instruction}` : "",
      "先讨论；只有用户明确要求修改时，才读取对应生产合同并按合同局部编辑。不要自动生成媒体或发布。",
      contractModule ? `需要修改时调用 mcp__infinite_canvas__production_get_contract({moduleId:"${contractModule}"})。` : "",
    ].filter(Boolean).join("\n");
    handledAgentResultRef.current = "";
    setAgentError("");
    useProductionFollowStore.getState().setTarget({ kind: ownerKind, id: key, workId });
    useProductionWorkspaceStore.getState().setPanelTab("director");
    setAgentState({
      panelOpen: true, panelMounted: true, activeTab: "chat", scopedTaskResult: null,
      scopedTask: { id, text, newThread: true, draftOnly: true, productionId: key, revision: currentProduction.revision },
    });
  };

  const acceptRunStart = async (run: ProductionBatch) => {
    setBatches(current => [run, ...current.filter(item => item.runId !== run.runId)]);
    setPendingRun(null);
    pendingRunStartRef.current = null;
    message.success(t("director.workspace.runStarted"));
    const follow = useProductionFollowStore.getState();
    const owner = productionOwner;
    follow.setTarget({ ...owner, workId: follow.target?.workId || run.runId, runId: run.runId, threadId: follow.target?.threadId });
    follow.resume();
    if (embedded) useAgentStore.getState().closePanel();
    // Starting a run only needs the refreshed production revision and this run's
    // readiness. A full workspace refresh also downloads versions, canvas, tasks,
    // and continuity, then used to repeat the batch/readiness reads below.
    const [current, ready] = await Promise.all([
      fetchEpisodeProduction(target),
      fetchProductionReadiness(target, { runId: run.runId }),
    ]);
    setProduction(previous => !previous || previous.episodeId !== current.production.episodeId || current.production.revision > previous.revision ? current.production : previous);
    setReadiness(previous => previous && previous.revision > ready.readiness.revision ? previous : ready.readiness);
  };

  const startRun = async (targets: string[], scope: "selected" | "all_ready" = "selected") => {
    if (!production || !targets.length) return;
    if (startingRunRef.current) return;
    if (pendingRunStartRef.current) return void message.warning(t("director.workspace.runReceiptUnknown"));
    const active = batches.find(run => ["pending", "running", "paused", "awaiting_review"].includes(run.status) && run.targets.some(id => targets.includes(id)));
    if (active) return void message.warning(t("director.workspace.runTargetActive", { runId: active.runId }));
    if (!draftKey) return void message.warning(t("drama.production.draftNotReady"));
    if (!production.draft.director) return void message.warning(t("director.workspace.engineUnavailable"));
    const director = production.draft.director;
    const targetIds = new Set<string>();
    const source = director.source as Record<string, any>;
    const shots = Array.isArray(source.shots) ? source.shots : [];
    const segments = Array.isArray(source.segments) ? source.segments : [];
    const addShot = (shotId: string) => {
      targetIds.add(shotId);
      const shot = shots.find((item: any) => String(item.id) === shotId);
      if (shot?.source_scene_id) targetIds.add(String(shot.source_scene_id));
      const shotInput = director.shotInputs[shotId];
      for (const assetId of [...(shotInput?.assetIds || []), ...((shot?.required_assets || []).map((item: any) => String(typeof item === "string" ? item : item?.asset_id || item?.id || ""))), ...(shotInput?.keyframeAssetId ? [shotInput.keyframeAssetId] : [])]) if (assetId) targetIds.add(String(assetId));
    };
    for (const id of targets) {
      const [kind, ...parts] = id.split(":");
      const targetId = parts.join(":"); targetIds.add(targetId);
      if (kind === "frame") addShot(targetId);
      if (kind === "segment") for (const shotId of segments.find((item: any) => String(item.id) === targetId)?.shot_ids || []) addShot(String(shotId));
    }
    const draftHasCurrentTargetEdits = dirtySourceDraftKeys.some(key => key.split(":").slice(1).some(part => targetIds.has(part)));
    if (draftHasCurrentTargetEdits || briefDraft !== String(director.source.brief || "")) return void message.warning(t("productionHub.follow.saveEditsFirst"));
    startingRunRef.current = true;
    const runId = nanoid();
    try {
      if (canvasId) await flushCanvasProjectBeforeGeneration(canvasId);
      const workId = director.workflow.currentWork?.workId || runId;
      const canvasRevision = canvasId ? useCanvasStore.getState().projects.find(project => project.id === canvasId)?.revision : undefined;
      const request: PendingRunStart = { inputBasis: "canvas", expectedCanvasRevision: canvasRevision === undefined ? undefined : Number(canvasRevision), runId, idempotencyKey: runId, workId, expectedRevision: production.revision, version: production.publishedVersion, targets: [...targets], scope };
      setPendingRun(request);
      pendingRunStartRef.current = request;
      const result = await startProductionRun(target, request);
      await acceptRunStart(result.run);
    } catch (error) {
      // 连不上服务器（status 0）请求根本没送达，是终局失败，必须释放启动态；
      // 4xx（除 408）也是确定拒绝。只有 408/409/5xx 才保留原 runId 等幂等恢复。
      const uncertain = error instanceof BackendApiError && (error.status === 408 || error.status === 409 || error.status >= 500);
      if (!uncertain) {
        setPendingRun(null);
        pendingRunStartRef.current = null;
        if (error instanceof BackendApiError && error.status === 409) void refreshRemote();
      }
      fail(error);
    }
    finally { startingRunRef.current = false; }
  };

  const generateClip = (clipId: string) => { void startRun([`segment:${clipId}`]); };

  const recoverRunStart = async () => {
    const request = pendingRunStartRef.current;
    if (!request || startingRunRef.current) return;
    startingRunRef.current = true;
    try {
      const existing = await fetchProductionBatch(target, request.runId).then(result => result.run);
      const run = existing || (await startProductionRun(target, request)).run;
      await acceptRunStart(run);
    } catch (error) {
      const uncertain = error instanceof BackendApiError && (error.status === 408 || error.status === 409 || error.status >= 500);
      if (!uncertain) {
        setPendingRun(null);
        pendingRunStartRef.current = null;
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

  const bindAsset = async (assetId: string, nodeId: string) => {
    if (!production || busy) return false;
    const latest = await fetchEpisodeProduction(target).then(value => value.production);
    return edit([{ type: "bind_director_asset", assetId, nodeId }], latest.revision);
  };
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
      const detail = (event as CustomEvent<{ owner: NonNullable<ProductionCanvasContext["owner"]>; object: ProductionObject; action: "source" | "generate" | "video" | "select-result"; history?: { generationLogId: string; storageKey: string; mimeType: string } }>).detail;
      if (!detail || detail.owner.kind !== owner.kind || detail.owner.id !== owner.id) return;
      event.preventDefault();
      if (nodeActionInFlight.current) return;
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
          if (detail.action === "video") {
            const groups = productionSegments(production).filter(segment => segmentShotIds(segment).includes(String(object.targetId || "")));
            if (groups.length !== 1) { open({ ...object, workspace: "production" }); message.info(t("productionCanvas.chooseClip")); return; }
            const sourceSegment = groups[0];
            const runtime = clipRuntime(String(sourceSegment.id));
            if (!runtime?.node.id || !runtime.segment.id) throw new Error(t("productionCanvas.targetUnavailable"));
            if (useProductionWorkspaceStore.getState().context?.canvasId !== canvasId) return;
            navigate(productionObjectPath({ ...object, workspace: "production", targetKind: "segment", targetId: String(sourceSegment.id), nodeId: runtime.node.id, segmentId: String(runtime.segment.id) }));
            useAgentStore.getState().closePanel();
            await startCanvasGeneration({ mode: "video", operation: "h3-run", projectId: canvasId, nodeId: runtime.node.id, segmentId: String(runtime.segment.id) });
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
  }, [embedded, owner?.kind, owner?.id, production, canvasId, busy, draftKey, briefDraft, dirtySourceDraftKeys, sourceDrafts, remoteRevision, pendingRunStart, batches, navigate, t]);
  const regroupSegment = async (segmentId: string, shotIds: string[], removeSegmentIds: string[]) => edit([{ type: "set_director_segment_group", segmentId, shotIds, removeSegmentIds }]);
  const repartitionV2 = async (shotIds: string[], segments: Array<Record<string, unknown>>) => edit([{ type: "repartition_director_clips", shotIds, segments }]);
  const editV2Shot = async (operation: Extract<ProductionOperation, { type: "edit_director_shot" }>) => {
    const director = production?.draft.director;
    if (!director) return false;
    if (!isSubjectPromptAssembly(director.source)) {
      fail(new Error(t("director.workspace.unsupportedProductionFormat")));
      return false;
    }
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
  // 局部保存统一追加 Clip 刷新：Backend 只对输入真正变化的 Clip 跑「校验 → 编译 → 应用」，
  // 进度回到 production.clipRefreshes，由 Clip 状态展示，不再让界面自己假装在编译。
  // 单批只允许一个刷新目标（Backend 对局部编辑有 CLIP_REFRESH_SCOPE 限制），取第一个命中项；
  // 还没投影到画布的 Clip 不刷新，避免准备阶段出现无意义的返修阻塞。
  const clipRefreshTarget = (segment: Record<string, any>) => Boolean(segment.id) && Array.isArray(canvasNodes)
    && productionSegmentRuntimeMatches(canvasNodes as any, String(segment.id), productionContext?.owner).length > 0;
  const clipRefreshOps = (segmentIds: readonly string[]): ProductionOperation[] => {
    const current = production;
    if (!current?.draft.director || !isSubjectPromptAssembly(current.draft.director.source)) return [];
    const ids = new Set(segmentIds.map(String));
    return productionSegments(current).filter(segment => ids.has(String(segment.id)) && clipRefreshTarget(segment)).slice(0, 1)
      .map(segment => ({ type: "request_director_clip_refresh" as const, segmentId: String(segment.id) }));
  };
  const shotClipRefreshOps = (shotIds: readonly string[]): ProductionOperation[] => {
    const current = production;
    if (!current?.draft.director || !isSubjectPromptAssembly(current.draft.director.source)) return [];
    const ids = new Set(shotIds.map(String));
    return productionSegments(current).filter(segment => segmentShotIds(segment).some(id => ids.has(id)) && clipRefreshTarget(segment)).slice(0, 1)
      .map(segment => ({ type: "request_director_clip_refresh" as const, segmentId: String(segment.id) }));
  };
  const saveV2Shot = async (shotId: string, patch: Record<string, unknown>, keyframes?: Extract<ProductionOperation, { type: "set_director_shot_keyframes" }>["keyframes"], utterances?: Extract<ProductionOperation, { type: "set_director_shot_utterances" }>["utterances"]) => {
    const ops: ProductionOperation[] = [];
    if (Object.keys(patch).length) ops.push({ type: "patch_director_source", entity: "shot", id: shotId, patch });
    if (keyframes !== undefined) ops.push({ type: "set_director_shot_keyframes", shotId, keyframes });
    if (utterances !== undefined) ops.push({ type: "set_director_shot_utterances", shotId, utterances });
    if (!ops.length) return true;
    ops.push(...shotClipRefreshOps([shotId]));
    return edit(ops);
  };
  const patchSource = async (entity: "style" | "spec" | "story" | "scene" | "environment" | "character" | "asset" | "asset_card" | "shot" | "segment", id: string | undefined, patch: Record<string, unknown>) => {
    if (entity === "scene" && id && typeof patch.scene_id === "string") return edit([{ type: "set_director_scene_environment", sceneId: id, environmentId: patch.scene_id }]);
    const lockOnly = entity === "segment" && Object.keys(patch).length > 0 && Object.keys(patch).every(key => key === "locked" || key === "preLockNoiseSeedMode");
    const expectedRefreshRevision = production ? production.revision + 1 : null;
    if (lockOnly && expectedRefreshRevision !== null) skipProductionRefreshRevision.current = expectedRefreshRevision;
    const saved = await edit([{ type: "patch_director_source", entity, ...(id ? { id } : {}), patch }]);
    if (!saved && lockOnly && skipProductionRefreshRevision.current === expectedRefreshRevision) skipProductionRefreshRevision.current = null;
    return saved;
  };
  const editCanvasClip = async (nodeId: string, segmentId: string, patch: Record<string, unknown>, refreshProduction = true) => {
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
      if (refreshProduction) await refreshRemote(); return true;
    } catch (error) { fail(error); return false; }
  };
  const applyTranslatedCompiledPrompts = async (items: Array<{ targetId: string; nodeId: string; segmentId: string; sourcePrompt: string; expectedCanvasPrompt: string; translatedPrompt: string }>) => {
    if (!canvasId || !items.length || busy || pendingCommandRef.current) throw new Error("当前制作画布正在处理其他操作，无法写入译文");
    const targets = new Set<string>();
    for (const item of items) {
      const identity = `${item.nodeId}\u0000${item.segmentId}`;
      if (!item.targetId || !item.nodeId || !item.segmentId || !item.sourcePrompt.trim() || !item.translatedPrompt.trim() || targets.has(identity)) throw new Error("翻译结果的 Clip 目标无效或重复");
      targets.add(identity);
    }
    // 译文生成期间可能发生过远端编辑；先收敛已有草稿，再从 Backend 读回并逐项核对原文。
    await flushCanvasProjectBeforeGeneration(canvasId);
    const latest = (await fetchBackendProject(canvasId)).project as unknown as CanvasProject;
    const operations = items.map(item => {
      const matches = productionSegmentRuntimeMatches(latest.nodes as any, item.targetId, productionContext?.owner);
      if (matches.length !== 1 || matches[0].node.id !== item.nodeId || String(matches[0].segment.id) !== item.segmentId || !/^minimax|^smart-minimax/i.test(String(matches[0].node.type || ""))) {
        throw new Error(`Clip ${item.targetId} 的 H3 目标已变化，译文没有写入`);
      }
      if (String(matches[0].segment.prompt || "") !== item.expectedCanvasPrompt) throw new Error(`Clip ${item.targetId} 的 H3 提示词在翻译期间发生变化，译文没有写入`);
      return { type: "update_h3_segment", nodeId: item.nodeId, segmentId: item.segmentId, patch: { prompt: item.translatedPrompt } };
    });
    const committed = await applyBackendCanvasOperations(canvasId, operations, Number(latest.revision), nanoid());
    applyBackendCanvasEvent({ type: "canvas.updated", entityId: canvasId, revision: committed.revision, payload: committed.project }, true);
  };
  const adoptDirectorFields = async (targetId: string, nodeId: string, segmentId: string | undefined, fields: string[]) => {
    if (!canvasId) return false;
    const { project } = await fetchBackendProject(canvasId);
    return edit([{ type: "adopt_director_fields", targetId, nodeId, segmentId, fields, canvasRevision: Number(project.revision) }]);
  };
  const adoptClipStyle = async (targetId: string, styleTemplateId: string | null) => {
    if (!production || busy || pendingCommandRef.current) return false;
    const runtime = clipRuntime(targetId);
    if (!runtime?.node.id || !runtime.segment.id || !canvasId) return false;
    try {
      const { project } = await fetchBackendProject(canvasId);
      return await edit([{ type: "adopt_director_clip_style", targetId, nodeId: runtime.node.id, segmentId: String(runtime.segment.id), canvasRevision: Number(project.revision), styleTemplateId }]);
    } catch (error) { fail(error); return false; }
  };
  const saveContinuity = async (ledger: Record<string, unknown>) => {
    if (!production) return false;
    const currentLedger = production.draft.director?.source.ledger as Record<string, any> | undefined;
    if (production.draft.director && (production.draft.director.source.ledger as Record<string, unknown> | undefined)?.contract_version === 2) {
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
    fail(new Error(t("director.workspace.unsupportedProductionFormat")));
    return false;
  };
  const checkContinuity = async () => {
    if (!production || busy || pendingCommandRef.current || continuityReadRef.current.loading) return;
    const continuityRead = beginContinuityRead();
    const checkOperation = { scope: continuityReadRef.current, operationId: nanoid() };
    continuityCheckRef.current = checkOperation;
    setBusy(true);
    try {
      await checkProductionContinuity(target, { expectedRevision: production.revision, operationId: checkOperation.operationId, snapshot: continuityRead.snapshot });
      if (!continuityRead.isSelectionCurrent() || continuityCheckRef.current !== checkOperation) return;
      const reportRead = beginContinuityRead(continuityRead.snapshot);
      const [continuity, ready] = await Promise.all([fetchProductionContinuity(target, { snapshot: reportRead.snapshot }), fetchProductionReadiness(target)]);
      if (finishContinuityRead(reportRead, continuity.continuity)) setReadiness(ready.readiness);
    } catch (error) { if (continuityRead.isSelectionCurrent() && continuityCheckRef.current === checkOperation) fail(error); }
    finally {
      if (continuityRead.isOwnerCurrent() && continuityCheckRef.current === checkOperation) { continuityCheckRef.current = null; setBusy(false); }
    }
  };
  const changeContinuitySnapshot = (snapshot: "draft" | "published") => {
    if (!continuityReadRef.current.active || continuityReadRef.current.ownerKey !== continuityOwnerKey) return;
    continuityReadRef.current.snapshot = snapshot;
    continuityReadRef.current.selection++;
    continuityReadRef.current.loading = true; setContinuitySnapshotLoading(true);
    setContinuitySnapshot(snapshot);
    const continuityRead = beginContinuityRead(snapshot);
    void fetchProductionContinuity(target, { snapshot }).then(value => {
      finishContinuityRead(continuityRead, value.continuity);
    }).catch(error => { if (finishContinuityRead(continuityRead)) fail(error); });
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
  const setH3Boundary = async (boundary: NonNullable<EpisodeProduction["draft"]["director"]>["boundaries"][number]) =>
    edit([{ type: "set_director_boundary", boundary }, ...clipRefreshOps([String(boundary.from)])]);
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
  const createManualAsset = async (operation: Extract<ProductionOperation, { type: "create_manual_director_asset" }>) => edit([operation]);
  const deleteScene = async (sceneId: string) => {
    if (!production || busy || !sceneId || !canvasId) return false;
    const { project } = await fetchBackendProject(canvasId);
    return edit([{ type: "archive_director_scene", sceneId, expectedCanvasRevision: Number(project.revision), confirmed: true }]);
  };
  const deleteAsset = async (assetId: string) => {
    if (!production || busy || !assetId) return false;
    return edit([{ type: "delete_director_asset", id: assetId, confirmed: true }]);
  };
  const removeCanvasAsset = async (nodeId: string) => {
    if (!production || busy || !canvasId || productionOwner.kind !== "episode" || !nodeId) return false;
    setBusy(true);
    try {
      // 资产列表可以显示 load() 读到的 Backend 快照；先保存已有画布编辑并
      // 用权威快照校准 Store，不能把 Store 中缺节点误报成 Backend 已删除。
      await flushCanvasProjectBeforeGeneration(canvasId);
      const latest = (await fetchBackendProject(canvasId)).project as unknown as CanvasProject;
      applyBackendCanvasEvent({ type: "canvas.updated", entityId: canvasId, revision: Number(latest.revision || 0), payload: latest }, true);
      if (!latest.nodes.some(item => item.id === nodeId)) { await refreshRemote(); return true; }
      const project = await ensureCanvasProjectLoaded(canvasId);
      const node = project.nodes.find(item => item.id === nodeId);
      if (!node) throw new Error("画布正在同步最新版本，请刷新后重试移除");
      if (!["character", "scene", "prop"].includes(node.type)) return false;
      useCanvasStore.getState().updateProject(canvasId, {
        nodes: project.nodes.filter(item => item.id !== nodeId),
        connections: project.connections.filter(connection => connection.fromNodeId !== nodeId && connection.toNodeId !== nodeId),
      });
      await flushCanvasProjectBeforeGeneration(canvasId);
      const saved = (await fetchBackendProject(canvasId)).project as unknown as CanvasProject;
      if (saved.nodes.some(item => item.id === nodeId)) throw new Error("Backend 尚未确认移除该素材，请刷新后重试");
      applyBackendCanvasEvent({ type: "canvas.updated", entityId: canvasId, revision: Number(saved.revision || 0), payload: saved }, true);
      await refreshRemote();
      return true;
    } catch (error) { fail(error); return false; }
    finally { setBusy(false); }
  };
  const patchCanvasAsset = async (target: { id: string; type?: string }, payload: CanvasAssetEditPayload) => {
    if (!production || busy || !canvasId || productionOwner.kind !== "episode" || !target.id || !payload.title.trim()) return false;
    setBusy(true);
    try {
      await flushCanvasProjectBeforeGeneration(canvasId);
      const latest = (await fetchBackendProject(canvasId)).project as unknown as CanvasProject;
      applyBackendCanvasEvent({ type: "canvas.updated", entityId: canvasId, revision: Number(latest.revision || 0), payload: latest }, true);
      const authoritative = latest.nodes.find(node => node.id === target.id);
      if (!authoritative || !["character", "scene", "prop"].includes(authoritative.type)) throw new Error("素材节点已不存在或类型已变化，请刷新本集素材列表");
      const entityBinding = authoritative.metadata?.productionEntity as { ownerKind?: string; ownerId?: string; entityId?: string } | undefined;
      const imageField = authoritative.type === "scene" ? "sceneImage" : "propImage";
      const imageKey = (image: unknown) => {
        const value = image && typeof image === "object" && !Array.isArray(image) ? image as Record<string, unknown> : {};
        return String(value.storageKey || value.url || "");
      };
      const requestedImage = authoritative.type === "scene" ? payload.sceneImage : authoritative.type === "prop" ? payload.propImage : undefined;
      if (entityBinding?.ownerKind === "episode" && entityBinding.ownerId === production.episodeId && (authoritative.type === "scene" || authoritative.type === "prop")
        && imageKey(authoritative.metadata?.[imageField]) !== imageKey(requestedImage)) {
        const current = (await fetchEpisodeProduction(production.episodeId)).production;
        const operation = bindEntityPictureToNode(current.draft.director?.source as Record<string, unknown> | undefined,
          entityBinding.ownerKind, entityBinding.ownerId, authoritative.type === "scene" ? "scene" : "prop", entityBinding.entityId || "", canvasId, authoritative.id);
        if (operation) await sendCommand({ kind: "edit", operationId: nanoid(), expectedRevision: current.revision, ops: [operation], status: "unknown" });
      }
      const freshCanvas = (await fetchBackendProject(canvasId)).project as unknown as CanvasProject;
      applyBackendCanvasEvent({ type: "canvas.updated", entityId: canvasId, revision: Number(freshCanvas.revision || 0), payload: freshCanvas }, true);
      const project = await ensureCanvasProjectLoaded(canvasId);
      // 按节点类型构造 metadata 补丁：只写 payload 提供的字段，未提供的字段保持原值。
      const metadataPatch: Record<string, unknown> =
        authoritative.type === "character" ? {
          characterName: payload.characterName ?? "",
          characterDescription: payload.characterDescription ?? "",
          characterImages: payload.characterImages,
          characterPrimaryIndex: payload.characterPrimaryIndex,
          characterVoiceUrl: payload.characterVoiceUrl,
          characterVoiceName: payload.characterVoiceName,
          characterVoiceDescription: payload.characterVoiceDescription,
          characterVoiceStorageKey: payload.characterVoiceStorageKey,
          characterVoiceAssetId: payload.characterVoiceAssetId,
        }
        : authoritative.type === "scene" ? {
          sceneName: payload.sceneName ?? "",
          sceneDescription: payload.sceneDescription ?? "",
          sceneImage: payload.sceneImage,
        }
        : {
          propName: payload.propName ?? "",
          propDescription: payload.propDescription ?? "",
          propImage: payload.propImage,
        };
      useCanvasStore.getState().updateProject(canvasId, { nodes: project.nodes.map(node => node.id === target.id ? {
        ...node, title: payload.title.trim(), metadata: { ...node.metadata, ...metadataPatch },
      } : node) });
      await flushCanvasProjectBeforeGeneration(canvasId);
      const saved = (await fetchBackendProject(canvasId)).project as unknown as CanvasProject;
      const savedNode = saved.nodes.find(node => node.id === target.id);
      if (!savedNode || savedNode.title !== payload.title.trim()) throw new Error("Backend 尚未确认素材信息更新，请刷新后重试");
      if ((authoritative.type === "scene" || authoritative.type === "prop") && imageKey(savedNode.metadata?.[imageField]) !== imageKey(requestedImage)) {
        throw new Error("Backend 尚未确认场景/道具主图更新，请刷新后重试");
      }
      applyBackendCanvasEvent({ type: "canvas.updated", entityId: canvasId, revision: Number(saved.revision || 0), payload: saved }, true);
      await refreshRemote();
      return true;
    } catch (error) { fail(error); return false; }
    finally { setBusy(false); }
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
      const segmentId = sourceSegmentForCanvasClip(canvasNodes as any, production.draft.director!.source as Record<string, any>, input.nodeId, input.segmentId);
      const { project } = await fetchBackendProject(canvasId);
      const sourceSaved = await edit([{ type: "reverse_sync_director_prompt", segmentId, artifactId: input.artifactId,
        sourceHash: input.sourceHash, basePromptHash: input.basePromptHash, prompt: input.prompt, canvasRevision: Number(project.revision) }]);
      if (sourceSaved) message.success(t("director.workspace.promptReverseSyncSaved"));
      return { sourceSaved };
    });
  }, [production, canvasId, edit, message, t]);

  useEffect(() => {
    if (!production?.draft.director || !canvasId) return;
    return registerProductionStoryboardEditor(canvasId, async input => {
      const groupId = sourceSegmentForCanvasClip(canvasNodes as any, production.draft.director!.source as Record<string, any>, input.nodeId, input.segmentId);
      const operation = buildDirectorClipStoryboardOperation(production.draft.director!, groupId, input);
      const sourceSaved = await edit([operation, ...clipRefreshOps([groupId])]);
      return { sourceSaved };
    });
  }, [production, canvasId, edit]);

  useEffect(() => {
    if (!production?.draft.director || !canvasId) return;
    return registerProductionBoundaryEditor(canvasId, async input => {
      const director = production.draft.director!;
      const segments = Array.isArray(director.source.segments) ? director.source.segments as Array<Record<string, any>> : [];
      const ops: ProductionOperation[] = [];
      for (const boundary of input.boundaries) {
        const index = segments.findIndex(segment => String(segment.id || "") === boundary.targetId);
        if (index < 0) throw new Error(`正式制作 Clip 不存在：${boundary.targetId}`);
        const next = segments[index + 1];
        if (!next) {
          if (input.requireNext) throw new Error("当前 H3 Clip 没有相邻的下一段，无法登记续段衔接");
          continue;
        }
        const to = String(next.id || "");
        if (!to) throw new Error("下一段缺少正式 Clip 标识，无法保存续段衔接");
        const previous = director.boundaries.find(edge => edge.from === boundary.targetId && edge.to === to);
        if (previous?.tailFrame === boundary.tailFrameContinuation && previous?.motionContext === boundary.motionContextEnabled && previous.reason?.trim()) continue;
        ops.push({ type: "set_director_boundary", boundary: {
          from: boundary.targetId, to, tailFrame: boundary.tailFrameContinuation, motionContext: boundary.motionContextEnabled,
          reason: "由场次 H3 节点续段衔接设置",
        } });
      }
      if (!ops.length) return { sourceSaved: true };
      return { sourceSaved: await edit(ops) };
    });
  }, [production, canvasId, setH3Boundary, edit]);

  useEffect(() => {
    if (agentTaskResult?.status === "failed") setAgentError(agentTaskResult.error || t("director.workspace.agentTaskFailed"));
  }, [agentTaskResult, t]);

  // 断联时保留已经加载的工作区：只有确实没有内容可显示时才用整页错误替换。
  if (loadError && !production) return <main className="p-8"><Alert type="error" message={t("director.loadFailed")} description={loadError} /></main>;
  if (!production) {
    if (series && !projectId && !episodeId) {
      // 无分集剧目：跳过逐集工作区，只保留全剧规划、分集与共享画布入口。
      const seriesNav = productionNavigationGroups({ hasSeries: true, scope: "episode", setup: true, seriesSubviews: true });
      const seriesTitle = folders.find(folder => folder.id === series.id)?.name || t("director.atomic.seriesWorkbench");
      const currentView = seriesView || "planning";
      return <main className="min-h-full bg-background px-4 py-5 text-foreground sm:px-6 lg:px-10 lg:py-7">
          {notice && <div className="mx-auto mb-4 w-full max-w-[1440px]">{notice}</div>}
        <div className="mx-auto max-w-[1440px]">
          <ProductionWorkspaceBreadcrumb items={[{ id: "projects", label: t("director.workspaceHierarchy.projects"), onSelect: () => navigate("/projects") }, { id: `drama:${series.id}`, label: seriesTitle }]} />
          <div className="mb-7 flex flex-wrap items-center gap-3"><Button type="text" icon={<ArrowLeft className="size-4" />} onClick={() => navigate(backPath)}>{t("director.back")}</Button><div><h1 className="text-xl font-medium tracking-tight sm:text-[26px]">{seriesTitle}</h1><p className="mt-2 text-xs text-muted-foreground">{t(episodesUnavailable ? "director.atomic.episodesUnavailable" : "director.atomic.emptyDrama")}</p></div></div>
          {!episodesUnavailable && <div className="grid min-w-0 items-start gap-5 lg:grid-cols-[220px_minmax(0,1fr)] lg:gap-8">
            <ProductionWorkspaceNavigation groups={seriesNav} selectedId={`series:${currentView}`} horizontal onSelect={item => navigateWorkspace(item.workspace, undefined, item.seriesView)} />
            <section className="min-w-0"><DramaManagePanel navigationTitleVisible dramaId={series.id} view={currentView} onEpisodesChanged={() => onSeriesEpisodesChanged?.()} /></section>
          </div>}
        </div>
      </main>;
    }
    return <div className="p-8 text-muted-foreground">{t("drama.production.loading")}</div>;
  }

  const showCommandNotice = commandNotice && (pendingCommand || commandNotice.workspace === workspace || (!commandNotice.workspace && workspace === "advanced"));
  // 保存状态只给一个结论：现在会不会丢内容。明细留在回执卡和镜头草稿定位里。
  const saveState = pendingCommand
    ? pendingCommand.status === "unknown" ? "unknown" as const : "rejected" as const
    : dirtySourceDraftKeys.length || briefDraft !== String(production.draft.director?.source.brief || "")
      ? "dirty" as const : "saved" as const;
  const saveStateDetail = saveState === "saved" ? undefined
    : saveState === "dirty" ? t("drama.production.saveStateDirtyDetail", { count: dirtySourceDraftKeys.length })
      : pendingCommand ? pendingCommandDescription(pendingCommand) : undefined;
  const pendingNotice = showCommandNotice && commandNotice && <details className="mb-4 border-b border-border pb-3 text-sm">
    <summary className="cursor-pointer text-muted-foreground">{t(commandNotice.status === "rejected" && commandNotice.httpStatus === 501 ? "drama.production.commandUnsupported" : workspace === "shots" ? commandNotice.status === "unknown" ? "director.atomic.shotReceiptUnknown" : "director.atomic.shotReceiptRejected" : commandNotice.status === "unknown" ? "drama.production.receiptUnknown" : pendingCommand ? "drama.production.commandRejected" : "drama.production.commandRejectedEditable")}</summary>
    <div className="mt-2 space-y-1">
    <p className="font-medium">{pendingCommandDescription(commandNotice)}</p>
    <p>{commandNotice.status === "rejected" && commandNotice.httpStatus === 501 ? t("drama.production.commandUnsupported") : commandNotice.status === "unknown" ? t("drama.production.receiptUnknown") : t(pendingCommand ? "drama.production.commandRejected" : "drama.production.commandRejectedEditable")}{commandErrorSummary(commandNotice) ? ` · ${commandErrorSummary(commandNotice)}` : ""}</p>
    <details className="mt-1 text-xs text-muted-foreground"><summary className="cursor-pointer">{t("director.workspace.continuity.technicalDetails")}</summary><p className="mt-1 break-all">{t("drama.production.pendingDetails")} · {commandNotice.operationId}</p>{commandNotice.error && <p className="mt-1 break-all">{commandNotice.error}</p>}</details>
    {pendingCommand?.status === "rejected" && pendingCommand.errorCode !== "RECEIPT_NOT_FOUND" && <Button className="mt-2" size="small" disabled={busy} onClick={resolveRejected}>{t("drama.production.resolveWithServer")}</Button>}
    </div>
  </details>;
  const pendingRunNotice = pendingRunStart && <div className="mb-4 rounded-lg border border-border bg-muted p-4 text-sm text-foreground"><p>{t("director.workspace.runReceiptUnknown")} · {pendingRunStart.runId}</p><Button className="mt-2" size="small" disabled={busy} onClick={() => void recoverRunStart()}>{t("drama.production.recoverReceipt")}</Button></div>;
  const run = batches[0] || null;
  const activeTargetIds = [...new Set(batches.filter(item => ["pending", "running", "paused", "awaiting_review"].includes(item.status)).flatMap(item => item.targets))];
  const readOnly = Boolean(production.archivedAt);
  // 归档是记录级开关，单独提交 set_archived；不与其他编辑混批，也不触发重编译或画布重投影。
  const archiveProduction = (archived: boolean) => edit([{ type: "set_archived", archived }]);
  const scope: ProductionWorkspaceScope = productionContext?.role === "shared-assets" ? "shared-assets" : productionOwner.kind === "episode" ? "episode" : "canvas";
  const navigationGroups = productionNavigationGroups({ hasSeries: Boolean(series), scope, setup: seriesOnly });
  // 剧目工作区的子 Tab 栏展开「剧目规划 / 共享资产画布 / 分集管理」；顶部下拉保持「规划与资产 / 分集管理」。
  const navigationGroupsWithSeriesSubtabs = workspace === "series" ? productionNavigationGroups({ hasSeries: Boolean(series), scope, setup: seriesOnly, seriesSubviews: true }) : navigationGroups;
  const selectedNavigationId = workspace === "series" ? `series:${seriesView || "planning"}` : workspace;
  const workspaceLabel = t(navigationGroups.flatMap(group => group.items).find(item => item.id === selectedNavigationId)?.labelKey || `director.workspace.tab.${workspace}`);
  const dramaId = series?.id || productionContext?.dramaId || episode?.dramaId;
  const seriesName = folders.find(folder => folder.id === dramaId)?.name;
  const objectTitle = workspace === "series" ? undefined : productionTargetTitle(production, routeTarget) || (routeNodeId ? canvasNodes.find(node => node.id === routeNodeId)?.title : undefined);
  const openWorkspaceCanvas = async () => {
    try {
      if (workspace === "series" && series) {
        const sharedCanvasId = folders.find(folder => folder.id === series.id)?.sharedAssetCanvasId
          || productionContext?.sharedAssetCanvasId
          || String((await ensureSharedAssetCanvas(series.id)).project.id);
        if (canvasHost) canvasHost.switchProductionCanvas({ projectId: sharedCanvasId, dramaId: series.id, keepCanvasOpen: true });
        else navigate(`/canvas/${encodeURIComponent(sharedCanvasId)}`);
        return;
      }
      if (canvasHost) {
        if (canvasHost.hasCanvas) canvasHost.restoreCanvas();
        else canvasHost.openCanvas({ projectId: canvasId });
      } else navigate(`/canvas/${encodeURIComponent(canvasId)}`);
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    }
  };
  const breadcrumbs = [
    { id: "projects", label: t("director.workspaceHierarchy.projects"), ...(!embedded ? { onSelect: () => navigate("/projects") } : {}) },
    ...(dramaId ? [{ id: `drama:${dramaId}`, label: seriesName || t("director.atomic.seriesWorkbench"), ...(series ? { onSelect: () => navigateWorkspace("series", undefined, "planning") } : {}) }] : []),
    ...(workspace === "series" ? [] : episode ? [{ id: `episode:${episode.id}`, label: `${t("drama.episodeLabel", { number: episode.episodeNumber })} · ${episode.title}`, onSelect: () => navigateWorkspace("overview") }] : title ? [{ id: `canvas:${canvasId}`, label: title, onSelect: () => navigateWorkspace("overview") }] : []),
    { id: `workspace:${workspace}`, label: workspaceLabel, ...(objectTitle ? { onSelect: () => navigateWorkspace(workspace) } : {}) },
    ...(objectTitle ? [{ id: "object", label: objectTitle }] : []),
  ];

  return <main ref={editorRootRef} data-production-inspector={embedded && !dialog || undefined} data-production-dialog={dialog || undefined} data-director-workspace data-production-workspace-shell={!embedded || undefined} data-shot-workspace-shell={!embedded && workspace === "shots" || undefined} className={embedded ? "min-h-full bg-background p-3 text-foreground" : "min-h-full bg-background px-4 py-5 text-foreground sm:px-6 lg:px-10 lg:py-7"}>
      {loadError && <div className="mx-auto w-full max-w-[1440px]"><Alert className="mb-5" type="warning" showIcon message={t("director.loadFailed")} description={loadError} /></div>}
      {notice && <div className="mx-auto w-full max-w-[1440px]">{notice}</div>}
    <div className="mx-auto max-w-[1440px]">
      <ProductionWorkspaceBreadcrumb items={breadcrumbs} />
      {!embedded && <div data-production-workspace-heading className="mb-7 flex flex-wrap items-center justify-between gap-x-6 gap-y-4">
        <div className="flex min-w-0 flex-wrap items-center gap-3"><Button type="text" icon={<ArrowLeft className="size-4" />} onClick={() => navigate(backPath)}>{t("director.back")}</Button><div><h1 className="text-xl font-medium tracking-tight sm:text-[26px]">{series ? seriesName || t("director.atomic.seriesWorkbench") : title || t("director.title")}</h1><p className="mt-2 text-xs text-muted-foreground">{episode ? `${t("director.episodeContext", { number: episode.episodeNumber })} · ${title}` : t("director.canvasContext")}</p></div>{series && <Select aria-label={t("director.atomic.chooseEpisode")} value={workspace === "series" ? ((seriesView || "planning") === "episodes" ? undefined : seriesPlanningOption) : episodeId} className="w-full min-w-44 sm:w-56" showSearch optionFilterProp="label" options={[{ value: seriesPlanningOption, label: t("director.workspaceHierarchy.planningAssets") }, ...[...series.episodes].sort((a, b) => a.episodeNumber - b.episodeNumber).map(item => ({ value: item.id, label: `${t("drama.episodeLabel", { number: item.episodeNumber })} · ${item.title}` }))]} onChange={async id => {
          try {
            if (id === seriesPlanningOption) {
              if (canvasHost) {
                const sharedCanvasId = folders.find(folder => folder.id === series.id)?.sharedAssetCanvasId || productionContext?.sharedAssetCanvasId;
                const projectId = sharedCanvasId || String((await ensureSharedAssetCanvas(series.id)).project.id);
                canvasHost.switchProductionCanvas({ projectId, dramaId: series.id, keepCanvasOpen: false });
              } else navigateWorkspace("series", undefined, "planning");
              return;
            }
            const selectedEpisode = series.episodes.find(item => item.id === id);
            if (canvasHost && selectedEpisode) {
              const projectId = selectedEpisode.canvasId || String((await ensureEpisodeCanvas(id)).project.id);
              canvasHost.switchProductionCanvas({ projectId, dramaId: series.id, episodeId: id, keepCanvasOpen: false });
              return;
            }
            useProductionFollowStore.getState().pause(t("productionCanvas.manualPause"));
            // 剧目视图里选分集＝进入该集导演稿；其他工作区保留当前工作区切换分集。
            if (workspace === "series") { navigate(dramaWorkbenchPath(series.id, id)); return; }
            const next = new URL(dramaWorkbenchPath(series.id, id, workspace), window.location.origin);
            navigate(`${next.pathname}${next.search}`);
          } catch (error) { message.error(error instanceof Error ? error.message : String(error)); }
        }} />}</div>
        <div className="flex w-full flex-wrap items-center gap-3 sm:w-auto"><Tag data-production-save-state={saveState} color={saveState === "saved" ? undefined : saveState === "dirty" ? "orange" : "red"} title={saveStateDetail}>{t(`drama.production.saveState.${saveState}`)}</Tag>{production.publishedVersion > 0 && <Tag>{t("director.studio.published", { number: production.publishedVersion })}</Tag>}{canvasId && <Button icon={<ExternalLink className="size-4" />} onClick={() => void openWorkspaceCanvas()}>{t(canvasHost?.hasCanvas ? "director.canvasOverlay.expand" : "drama.production.openCanvas")}</Button>}</div>
      </div>}
      {agentError && <Alert className="mb-4" type="warning" showIcon message={agentError} closable onClose={() => setAgentError("")} />}
      {production.storageFormat === "v2-projection-migration-required" && <Alert className="mb-4" type="warning" showIcon message={t("director.generation.sourceStorageMigration")} />}
      {production.publishedFormatStatus === "legacy-maintenance-required" && <Alert className="mb-4" type="info" showIcon message={t("director.generation.publishedLegacyHidden")} />}
      {readOnly && <Alert className="mb-4" type="info" showIcon message={t("drama.production.archivedNotice")} />}
      {(remoteRevision !== null || showCommandNotice) && <div data-production-recovery-notice className="mb-4 text-sm">{remoteRevision !== null && <p>{t("drama.production.conflictDetail", { number: remoteRevision })}</p>}{pendingNotice}</div>}
      {pendingRunNotice}
      <div data-production-workspace-layout className={embedded ? "min-w-0" : "grid min-w-0 items-start gap-5 lg:grid-cols-[220px_minmax(0,1fr)] lg:gap-8"}>
        <ProductionWorkspaceNavigation groups={navigationGroupsWithSeriesSubtabs} selectedId={selectedNavigationId} compact={embedded} horizontal={!embedded} onSelect={item => navigateWorkspace(item.workspace, undefined, item.seriesView)} />
        <section data-production-workspace-content={!embedded || undefined} aria-label={workspaceLabel} className="min-w-0">
          {workspace === "series" && series ? <DramaManagePanel navigationTitleVisible={!embedded} dramaId={series.id} view={seriesView || "planning"} onEpisodesChanged={() => onSeriesEpisodesChanged?.()} /> : <>
            {embedded && workspace === "assets" && <p className="mb-5 text-xs leading-5 text-muted-foreground" data-production-asset-scope={scope}>{t(`director.workspaceHierarchy.${scope === "episode" ? "episodeAssetsHint" : scope === "shared-assets" ? "sharedAssetsHint" : "projectAssetsHint"}`)}</p>}
            {embedded && workspace === "assets" && (!/^(asset|frame):/.test(routeTarget) || productionContext?.role === "shared-assets") && <SharedAssetsPicker />}
            <DirectorPanel
              assetScopeHint={!embedded ? t(`director.workspaceHierarchy.${scope === "episode" ? "episodeAssetsHint" : scope === "shared-assets" ? "sharedAssetsHint" : "projectAssetsHint"}`) : undefined}
              navigationTitleVisible={!embedded} embedded={embedded} compact={dialog} generationSupported={productionOwner.kind !== "scene"} onSaveScript={saveSceneDrafts}
              workspace={workspace} director={production.draft.director} production={production} readiness={readiness || undefined} continuityReport={continuityReport} continuitySnapshotLoading={continuitySnapshotLoading} run={run} batches={batches} runtimeTasks={runtimeTasks}
              canvasNodes={canvasNodes} sharedCanvasNodes={sharedCanvasNodes?.nodes} sharedCanvasId={sharedCanvasNodes?.id} versions={versions} busy={busy || readOnly} readOnly={readOnly} onArchive={productionOwner.kind === "episode" ? archiveProduction : undefined} canvasId={canvasId} canvasRole={productionContext?.role || (projectId ? "ordinary" : "episode")} focusTarget={routeTarget}
              sourceDrafts={sourceDrafts} onSourceDraftChange={setSourceDraft}
              briefDraft={briefDraft} onBriefDraftChange={setBriefDraft}
              onBrief={saveBrief} onEditCanvasClip={editCanvasClip} onAdoptDirectorFields={adoptDirectorFields} onPatch={patchSource} onAdoptClipStyle={adoptClipStyle} onRegroup={regroupSegment} onWorkflow={setWorkflow} onSettings={patch => void edit([{ type: 'set_settings', patch }])} onBindAsset={bindAsset}
              onPrepareEntities={async () => {
                if (!production.draft.director || busy || pendingCommandRef.current) return;
                setBusy(true);
                try {
                  const entityOwner = owner || { kind: projectId ? "canvas" as const : "episode" as const, id: projectId || episodeId! };
                  const source = production.draft.director.source;
                  const targets = productionEntities(source, entityOwner).map(entity => `entity:${entity.kind}:${entity.entityId}`);
                  const styleLock = source.style_lock as Record<string, unknown> | undefined;
                  const styleAnchorNodeReference = String(source.style_anchor_node_id || "");
                  const styleAnchorAssetId = styleAnchorNodeReference ? "" : String(styleLock?.anchor_asset_id || "");
                  const styleAnchorPlan = styleAnchorAssetId ? (Array.isArray(source.asset_plan) ? source.asset_plan : []).map(value => {
                    const asset = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
                    return asset;
                  }).find(asset => String(asset.asset_id || asset.id || "") === styleAnchorAssetId
                    && (String(asset.role || asset.asset_type || "").toUpperCase() === "STYLE_MOTHER" || String(asset.kind || "").toLowerCase() === "style")) : undefined;
                  const styleAsset = production.draft.director.assets[styleAnchorAssetId];
                  const styleAnchorScope = String(styleAnchorPlan?.canvas_scope || (styleAsset?.sharedSource || productionContext?.role === "shared-assets" ? "shared" : "episode"));
                  if (styleAnchorPlan && styleAnchorScope === (productionContext?.role === "shared-assets" ? "shared" : "episode")) targets.push(`asset:${styleAnchorAssetId}`);
                  if (targets.length) await sendCommand({ kind: "prepare", targets, operationId: nanoid(), expectedRevision: production.revision, status: "unknown" });
                  await refreshRemote();
                } catch (cause) { fail(cause); } finally { setBusy(false); }
              }}
              onUpsertSubject={upsertSubject} onDeleteSubject={deleteSubject} onDeleteScene={deleteScene} onDeleteAsset={deleteAsset} onRemoveCanvasAsset={removeCanvasAsset} onPatchCanvasAsset={patchCanvasAsset} onCreateManualAsset={createManualAsset}
              onSwitchToSharedNode={async (node, subject) => {
                if (!production?.draft.director || !episode || !sharedCanvasNodes || busy || productionOwner.kind !== "episode") return false;
                const kind = String(node.type || "") as "character" | "scene" | "prop";
                if (!["character", "scene", "prop"].includes(kind) || !matchesProductionAssetNode(node, kind, { kind: "canvas", id: sharedCanvasNodes.id })) return false;
                const sharedIdentity = `${encodeURIComponent(sharedCanvasNodes.id)}_${encodeURIComponent(node.id)}`;
                const assetId = `SHARED_${sharedIdentity}`;
                const entityId = kind === "prop" ? undefined : `${kind === "character" ? "CHAR" : "SCENE"}_${sharedIdentity}`;
                const name = String(node.title || node.metadata?.[`${kind}Name`] || node.id);
                const description = String(node.metadata?.[`${kind}Description`] || "");
                const source = createManualDirectorAsset(production.draft.director.source as Record<string, any>, {
                  id: assetId, ...(entityId ? { entityId } : {}), subjectId: `SUBJECT_${sharedIdentity}`, kind, name, description, prompt: "", purpose: "剧目共享资产",
                  canvasScope: "episode", registerSubject: true, ownerKind: "episode", ownerId: episode.id,
                  sharedSource: { dramaId: String(episode.dramaId), assetId, sourceProjectId: sharedCanvasNodes.id, sourceNodeId: node.id },
                });
                const includeOperation = { type: "create_manual_director_asset" as const, assetPlan: source.assetPlan, assetCard: source.assetCard,
                  ...(source.registryKind && source.registryEntity ? { registryKind: source.registryKind, registryEntity: source.registryEntity } : {}) } as Extract<ProductionOperation, { type: "create_manual_director_asset" }>;
                return edit([includeOperation, { type: "upsert_director_subject", subject }]);
              }}
              onIncludeSharedNode={async node => {
                if (!production?.draft.director || !episode || !sharedCanvasNodes || busy || productionOwner.kind !== "episode") return false;
                const kind = String(node.type || "") as "character" | "scene" | "prop";
                if (!["character", "scene", "prop"].includes(kind) || !matchesProductionAssetNode(node, kind, { kind: "canvas", id: sharedCanvasNodes.id })) return false;
                const sharedIdentity = `${encodeURIComponent(sharedCanvasNodes.id)}_${encodeURIComponent(node.id)}`;
                const assetId = `SHARED_${sharedIdentity}`;
                const entityId = kind === "prop" ? undefined : `${kind === "character" ? "CHAR" : "SCENE"}_${sharedIdentity}`;
                const name = String(node.title || node.metadata?.[`${kind}Name`] || node.id);
                const description = String(node.metadata?.[`${kind}Description`] || "");
                const source = createManualDirectorAsset(production.draft.director.source as Record<string, any>, {
                  id: assetId, ...(entityId ? { entityId } : {}), subjectId: `SUBJECT_${sharedIdentity}`, kind, name, description, prompt: "", purpose: "剧目共享资产",
                  canvasScope: "episode", registerSubject: true, ownerKind: "episode", ownerId: episode.id,
                  sharedSource: { dramaId: String(episode.dramaId), assetId, sourceProjectId: sharedCanvasNodes.id, sourceNodeId: node.id },
                });
                const operation = { type: "create_manual_director_asset" as const, assetPlan: source.assetPlan, assetCard: source.assetCard,
                  ...(source.registryKind && source.registryEntity ? { registryKind: source.registryKind, registryEntity: source.registryEntity } : {}), ...(source.subject ? { subject: source.subject } : {}) } as Extract<ProductionOperation, { type: "create_manual_director_asset" }>;
                return createManualAsset(operation);
              }}
              onRemoveSharedAsset={assetId => edit([{ type: "remove_shared_director_asset", id: assetId }])}
              onSaveV2Shot={saveV2Shot} onRepartitionClips={repartitionV2} onEditShot={editV2Shot}
              onOpenSharedAsset={(assetId, title) => void openSharedAsset(assetId, title).catch(fail)} onPromoteExistingSharedAsset={(assetId, title) => void promoteExistingSharedAsset(assetId, title).catch(fail)}
              onBoundary={setBoundary} onH3Boundary={setH3Boundary} onPublish={() => void publish()} onSaveContinuity={saveContinuity} onCheckContinuity={checkContinuity} onContinuitySnapshot={changeContinuitySnapshot}
              onReplace={value => void replaceDirector(value)} onAskDirector={scope => void askDirector(scope)} onNavigate={navigateWorkspace}
              onCompile={(sceneId, targetId, targetIds) => void runProductionCompile(sceneId, targetId, targetIds)} onApplyTranslatedPrompts={applyTranslatedCompiledPrompts} autoTranslateCompilation={autoTranslateCompilation} compileBusy={compiling} compilePending={Boolean(pendingCompilation)} compileError={compileError} compileNotice={compileNotice} compileDiagnostics={compileDiagnostics} compileTargets={compileTargets}
              onLocateTarget={(kind, id) => {
                if (kind === "shot") { navigateWorkspace("shots", { kind, id }); return; }
                 const runtime = kind === "segment" ? clipRuntime(id) : undefined;
                const frame = production.draft.keyframes[id];
                const assetId = kind === "keyframe" || kind === "frame" ? production.draft.director?.shotInputs[id]?.keyframeAssetId : id;
                 const nodeId = kind === "segment" ? runtime?.node.id : (kind === "keyframe" || kind === "frame" ? frame?.nodeId : undefined) || production.draft.director?.assets[assetId || ""]?.nodeId;
                if (!nodeId) { navigateWorkspace(kind === "segment" ? "production" : kind === "frame" || kind === "keyframe" ? "shots" : "assets", { kind: kind === "keyframe" || kind === "frame" ? "shot" : kind, id }); return; }
                 const object: ProductionObject = { owner: owner || productionOwner, canvasId, workspace: kind === "segment" ? "production" : kind === "frame" || kind === "keyframe" ? "shots" : "assets", targetKind: kind === "frame" || kind === "keyframe" ? "shot" : kind, targetId: id, nodeId, ...(kind === "segment" && runtime?.segment.id ? { segmentId: String(runtime.segment.id) } : {}), title: id };
                useProductionFollowStore.getState().pause(t("productionCanvas.manualPause"));
                if (canvasHost) canvasHost.openCanvas({ projectId: canvasId, nodeId, segmentId: object.segmentId });
                else navigate(productionObjectPath(object));
                useAgentStore.getState().closePanel();
              }}
              onAnswerDecision={answerDecision}
              onExport={exportBundle} exporting={exporting}
              onStart={(targets, scope) => void startRun(targets, scope)} onGenerateClip={productionOwner.kind === "scene" ? undefined : generateClip} onPause={runId => void pauseRun(runId)} onResume={runId => void resumeRun(runId)}
              runStartPending={Boolean(pendingRunStart)} activeTargetIds={activeTargetIds}
              onRestore={restoreVersion} onSceneCommand={sendSceneCommand} sceneCommandPending={Boolean(pendingCommand || pendingRunStart)} onRefresh={() => void load(() => true, true).catch(fail)}
            />
            </>}
        </section>
      </div>
    </div>
  </main>;
}
