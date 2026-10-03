import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, App, Button, Tag } from "antd";
import { ArrowLeft, Clapperboard, ExternalLink, FileText, Image, ListChecks, PackageOpen, Settings2 } from "lucide-react";
import localforage from "localforage";
import { nanoid } from "nanoid";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { directorModules, type ProductionOperation } from "@basketikun/canvas-agent/drama/production-contract";
import { backendConnection } from "@/lib/backend-connection";
import { ensureCanvasDraftLease, getCanvasDraftSessionId } from "@/lib/canvas/canvas-draft-session";
import { exportAchengDeliveryBundle } from "@/lib/acheng-delivery-export";
import { useAgentStore } from "@/stores/use-agent-store";
import { useProductionFollowStore } from "@/stores/use-production-follow-store";
import {
  BackendApiError, editEpisodeProduction, previewEpisodeProductionImpact,
  fetchBackendCanvasDrama, fetchBackendDramaEpisode, fetchBackendProject, fetchEpisodeProduction,
  fetchEpisodeProductionLegacy, fetchEpisodeProductionVersions, fetchProductionBatch, fetchProductionBatches,
  fetchProductionReadiness, pauseProductionBatch, publishEpisodeProduction, restoreEpisodeProduction,
  resumeProductionBatch, startProductionRun, type DramaEpisode, type EpisodeProduction,
  type ProductionBatch, type ProductionReadiness, type ProductionTarget,
} from "@/services/backend-api";
import { DirectorPanel, type DirectorWorkspace, type AssetReview } from "./director-panel";

type PendingCommand = { operationId: string; expectedRevision: number; status: "unknown" | "rejected"; error?: string } & (
  { kind: "edit"; ops: ProductionOperation[] } | { kind: "publish"; stage: "director" } | { kind: "restore"; version: number }
);
type PendingRunStart = { runId: string; idempotencyKey: string; workId?: string; expectedRevision: number; version: number; targets: string[]; scope: "selected" | "all_ready" };
type LocalDraft = { brief?: string; sourceDrafts?: Record<string, string>; remoteRevision: number | null; pendingCommand?: PendingCommand | null; pendingRunStart?: PendingRunStart | null };
type LegacySource = { source: "fullPlot" | "script.md" | "storyboard.md"; sha256: string; text: string };
type VersionItem = { version: number; stage: string; createdAt: string };
const localDrafts = localforage.createInstance({ name: "episode-production-drafts", storeName: "unfinished" });
const workspaces: Array<{ key: DirectorWorkspace; icon: typeof ListChecks; roles: string }> = [
  { key: "overview", icon: ListChecks, roles: "" }, { key: "story", icon: FileText, roles: "story" },
  { key: "assets", icon: PackageOpen, roles: "assets" }, { key: "shots", icon: Clapperboard, roles: "shots · performance · effects" },
  { key: "production", icon: Image, roles: "model · continuity" }, { key: "advanced", icon: Settings2, roles: "" },
];

export default function ProductionRoute() {
  const { episodeId, projectId } = useParams();
  return <ProductionEditor key={projectId ? `canvas:${projectId}` : `episode:${episodeId}`} />;
}

function ProductionEditor() {
  const { episodeId = "", projectId = "" } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const returnToDramas = searchParams.get("from") === "dramas" || Boolean(episodeId);
  const backPath = returnToDramas ? "/production?view=dramas" : "/production?view=canvases";
  const target = useMemo<ProductionTarget>(() => projectId ? { projectId } : episodeId, [projectId, episodeId]);
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { message, modal } = App.useApp();
  const [title, setTitle] = useState("");
  const [canvasId, setCanvasId] = useState(projectId);
  const [episode, setEpisode] = useState<DramaEpisode | null>(null);
  const [canvasNodes, setCanvasNodes] = useState<Array<{ id: string; title?: string; type?: string; metadata?: Record<string, unknown> }>>([]);
  const [production, setProduction] = useState<EpisodeProduction | null>(null);
  const [readiness, setReadiness] = useState<ProductionReadiness | null>(null);
  const [legacy, setLegacy] = useState<LegacySource[]>([]);
  const [versions, setVersions] = useState<VersionItem[]>([]);
  const [batches, setBatches] = useState<ProductionBatch[]>([]);
  const [workspace, setWorkspace] = useState<DirectorWorkspace>("overview");
  const [briefDraft, setBriefDraft] = useState("");
  const [sourceDrafts, setSourceDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [agentError, setAgentError] = useState("");
  const [remoteRevision, setRemoteRevision] = useState<number | null>(null);
  const [draftKey, setDraftKey] = useState<string | null>(null);
  const [pendingCommand, setPendingCommand] = useState<PendingCommand | null>(null);
  const pendingCommandRef = useRef<PendingCommand | null>(null);
  const [pendingRunStart, setPendingRunStart] = useState<PendingRunStart | null>(null);
  const pendingRunStartRef = useRef<PendingRunStart | null>(null);
  const startingRunRef = useRef(false);
  const handledAgentResultRef = useRef("");
  const setAgentState = useAgentStore(state => state.setAgentState);
  const agentTaskResult = useAgentStore(state => state.scopedTaskResult);
  const agentConversation = useAgentStore(state => state.conversation);
  const agentBusy = useAgentStore(state => state.sending || state.waiting);
  const pending = (value: PendingCommand | null) => { pendingCommandRef.current = value; setPendingCommand(value); };
  const setPendingRun = (value: PendingRunStart | null) => { pendingRunStartRef.current = value; setPendingRunStart(value); };
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
    query.delete("target"); query.delete("nodeId"); query.delete("segmentId"); query.delete("runId"); query.delete("workId");
    if (targetFocus?.id) query.set("target", `${targetFocus.kind === "keyframe" ? "frame" : targetFocus.kind}:${targetFocus.id}`);
    setSearchParams(query, { replace: true });
  };
  const selectWorkspace = (next: DirectorWorkspace) => navigateWorkspace(next);

  const load = useCallback(async (isActive: () => boolean = () => true, preserveBrief = false) => {
    const contextRequest = projectId
      ? Promise.all([fetchBackendProject(projectId), fetchBackendCanvasDrama(projectId)]).then(([canvas, relation]) => ({ canvas: canvas.project, episode: relation.episode }))
      : fetchBackendDramaEpisode(episodeId);
    const [context, prod, old, history, ready, runHistory] = await Promise.all([
      contextRequest, fetchEpisodeProduction(target), fetchEpisodeProductionLegacy(target), fetchEpisodeProductionVersions(target),
      fetchProductionReadiness(target), fetchProductionBatches(target),
    ]);
    if (!isActive()) return null;
    setEpisode(context.episode || null);
    setTitle(context.episode?.title || String(context.canvas?.title || ""));
    setCanvasId(projectId || context.episode?.canvasId || "");
    setCanvasNodes((context.canvas?.nodes || []) as Array<{ id: string; title?: string; type?: string; metadata?: Record<string, unknown> }>);
    setProduction(prod.production);
    setReadiness(ready.readiness);
    setLegacy(old.sources);
    setVersions(history.versions);
    setBatches(runHistory.runs);
    if (!preserveBrief) setBriefDraft(String(prod.production.draft.director?.source.brief || ""));
    setLoadError("");
    return context.episode?.id || (projectId ? `canvas:${projectId}` : episodeId);
  }, [target, projectId, episodeId]);

  useEffect(() => {
    let active = true;
    void (async () => {
      await ensureCanvasDraftLease();
      const owner = await load(() => active);
      if (!owner || !active) return;
      const key = `${backendConnection().url}:${owner}:${getCanvasDraftSessionId()}`;
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
    const value: LocalDraft = { brief: briefDraft, sourceDrafts, remoteRevision, pendingCommand, pendingRunStart };
    void (briefDraft.trim() || Object.keys(sourceDrafts).length || remoteRevision !== null || pendingCommand || pendingRunStart
      ? localDrafts.setItem(draftKey, value)
      : localDrafts.removeItem(draftKey))
      .catch(error => message.error({ key: "episode-local-draft", content: error instanceof Error ? error.message : String(error) }));
  }, [draftKey, briefDraft, sourceDrafts, remoteRevision, pendingCommand, pendingRunStart, message]);

  useEffect(() => {
    if (routeWorkspace && workspaces.some(item => item.key === routeWorkspace) && workspace !== routeWorkspace) setWorkspace(routeWorkspace);
  }, [routeWorkspace, workspace]);

  useEffect(() => {
    if (!routeTarget && !routeNodeId && !routeSegmentId) return;
    let first = 0, second = 0;
    first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => {
        const elements = Array.from(document.querySelectorAll<HTMLElement>("[data-production-target], [data-canvas-node-id]"));
        const direct = elements.find(element => element.dataset.productionTarget === routeTarget
          || element.dataset.canvasNodeId === routeNodeId
          || element.dataset.canvasSegmentId === routeSegmentId);
        const targetId = routeTarget.split(":").slice(1).join(":");
        const textMatch = targetId ? Array.from(document.querySelectorAll<HTMLElement>("article")).find(article =>
          Array.from(article.querySelectorAll<HTMLElement>("h1,h2,h3,h4,p,span,code")).some(element => {
            const text = element.textContent?.trim() || "";
            return text === targetId || text.endsWith(`· ${targetId}`) || text.endsWith(`: ${targetId}`);
          })) : undefined;
        const match = direct || textMatch;
        match?.scrollIntoView({ block: "center", behavior: "smooth" });
      });
    });
    return () => { cancelAnimationFrame(first); cancelAnimationFrame(second); };
  }, [workspace, routeTarget, routeNodeId, routeSegmentId, production, readiness]);

  useEffect(() => {
    if (!routeWorkId || !production || !canvasId) return;
    const owner = projectId ? { kind: "canvas" as const, id: projectId } : { kind: "episode" as const, id: episodeId };
    const active = useProductionFollowStore.getState().target;
    if (active?.workId !== routeWorkId || active.kind !== owner.kind || active.id !== owner.id) return;
    const reasons = Object.keys(sourceDrafts).length || briefDraft !== String(production.draft.director?.source.brief || "")
      ? "存在尚未保存的制作编辑" : pendingCommand ? t("productionHub.follow.pendingWrite") : pendingRunStart ? t("productionHub.follow.unknownRun") : exporting ? t("productionHub.follow.exportInProgress") : "";
    useProductionFollowStore.getState().setGuardReason("editor", reasons);
  }, [routeWorkId, projectId, episodeId, canvasId, production, sourceDrafts, briefDraft, pendingCommand, pendingRunStart, exporting, t]);

  const refreshRemote = useCallback(async () => {
    const [prod, ready, history, runHistory, canvas] = await Promise.all([
      fetchEpisodeProduction(target), fetchProductionReadiness(target), fetchEpisodeProductionVersions(target), fetchProductionBatches(target),
      canvasId ? fetchBackendProject(canvasId).then(value => value.project) : Promise.resolve(null),
    ]);
    setProduction(prod.production); setReadiness(ready.readiness); setVersions(history.versions); setBatches(runHistory.runs);
    if (canvas) setCanvasNodes((canvas.nodes || []) as Array<{ id: string; title?: string; type?: string; metadata?: Record<string, unknown> }>);
    return prod.production;
  }, [target, canvasId]);

  useEffect(() => {
    const onProductionEvent = (event: Event) => {
      const value = (event as CustomEvent<{ type?: string; entityId?: string }>).detail;
      const aliases = new Set([projectId, episodeId, canvasId, episode?.id, episode?.canvasId, ...(readiness?.presentation?.aliases || [])].filter(Boolean));
      if (value?.type === "drama-production.updated" && value.entityId && aliases.has(value.entityId)) void refreshRemote();
    };
    window.addEventListener("backend-event", onProductionEvent);
    return () => window.removeEventListener("backend-event", onProductionEvent);
  }, [projectId, episodeId, canvasId, episode, readiness?.presentation?.aliases, refreshRemote]);

  useEffect(() => {
    if (!batches.some(run => ["pending", "running"].includes(run.status))) return;
    const timer = window.setInterval(() => { void fetchProductionBatches(target).then(result => setBatches(result.runs)).catch(() => undefined); }, 2500);
    return () => window.clearInterval(timer);
  }, [batches, target]);

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

  const sendCommand = async (command: PendingCommand) => {
    if (!draftKey) throw new Error(t("drama.production.draftNotReady"));
    await ensureCanvasDraftLease();
    const previous = pendingCommandRef.current;
    if (previous && (previous.operationId !== command.operationId || previous.status === "rejected")) throw new Error(t("drama.production.resolvePending"));
    await localDrafts.setItem(draftKey, { brief: briefDraft, sourceDrafts, remoteRevision, pendingCommand: command, pendingRunStart } satisfies LocalDraft);
    pending(command);
    try {
      const result = command.kind === "edit" ? await editEpisodeProduction(target, command.expectedRevision, command.ops, command.operationId)
        : command.kind === "publish" ? await publishEpisodeProduction(target, command.expectedRevision, command.stage, command.operationId)
        : await restoreEpisodeProduction(target, command.expectedRevision, command.version, command.operationId);
      if (!result.production || !Number.isInteger(result.production.revision)) throw new Error(t("drama.production.receiptMalformed"));
      await localDrafts.setItem(draftKey, { brief: briefDraft, sourceDrafts, remoteRevision: null, pendingCommand: null, pendingRunStart } satisfies LocalDraft);
      pending(null); setProduction(result.production); setRemoteRevision(null);
      return result.production;
    } catch (error) {
      const rejected = error instanceof BackendApiError && error.status > 0;
      const saved: PendingCommand = { ...command, status: rejected ? "rejected" : "unknown", error: error instanceof Error ? error.message : String(error) };
      await localDrafts.setItem(draftKey, { brief: briefDraft, sourceDrafts, remoteRevision, pendingCommand: saved, pendingRunStart } satisfies LocalDraft);
      pending(saved);
      throw error;
    }
  };

  const edit = async (ops: ProductionOperation[]): Promise<boolean> => {
    if (!production || busy) return false;
    if (pendingCommandRef.current) { message.warning(t("drama.production.resolvePending")); return false; }
    setBusy(true);
    try {
      await sendCommand({ kind: "edit", operationId: nanoid(), expectedRevision: production.revision, ops: structuredClone(ops), status: "unknown" });
      await refreshRemote();
      return true;
    } catch (error) { fail(error); return false; }
    finally { setBusy(false); }
  };

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
    if (pendingCommandRef.current) return void message.warning(t("drama.production.resolvePending"));
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
    const command = pendingCommandRef.current;
    if (!command || command.status !== "unknown" || busy) return;
    setBusy(true);
    try { await sendCommand(command); await refreshRemote(); message.success(t("drama.production.receiptRecovered")); }
    catch (error) { fail(error); }
    finally { setBusy(false); }
  };

  const resolveRejected = () => modal.confirm({
    title: t("drama.production.resolveTitle"), content: t("drama.production.resolveDescription"),
    onOk: async () => {
      await load(() => true, true);
      if (draftKey) await localDrafts.setItem(draftKey, { brief: briefDraft, sourceDrafts, remoteRevision: null, pendingCommand: null, pendingRunStart } satisfies LocalDraft);
      pending(null); setRemoteRevision(null);
    },
  });

  const restoreVersion = (version: number) => {
    if (!production || busy || pendingCommandRef.current) return void message.warning(t("drama.production.resolvePending"));
    const command: PendingCommand = { kind: "restore", operationId: nanoid(), expectedRevision: production.revision, version, status: "unknown" };
    modal.confirm({ title: t("drama.production.restoreTitle", { number: version }), onOk: async () => {
      try { await sendCommand(command); await refreshRemote(); } catch (error) { fail(error); throw error; }
    } });
  };

  const askDirector = async (scope: { workspace: DirectorWorkspace; targetId?: string; instruction?: string; brief?: string; workId?: string }) => {
    if (pendingCommandRef.current) return message.warning(t("drama.production.resolvePending"));
    const requestedBrief = scope.brief ?? briefDraft;
    let currentProduction = await fetchEpisodeProduction(target).then(result => result.production);
    if (requestedBrief !== String(currentProduction.draft.director?.source.brief || "")) {
      await saveBrief(requestedBrief);
      currentProduction = await fetchEpisodeProduction(target).then(result => result.production);
    }
    setProduction(currentProduction);
    const director = currentProduction.draft.director;
    if (!director) return message.error(t("director.workspace.engineUnavailable"));
    if (String(director.source.brief || "") !== requestedBrief) return message.error(t("director.workspace.briefSaveFailed"));
    const agent = useAgentStore.getState();
    if (!agent.enabled || !agent.connected || !["ready", "warning"].includes(agent.conversation.status)) {
      useAgentStore.getState().openPanel();
      return message.warning(t("director.workspace.agentDisconnected"));
    }
    if (agent.sending || agent.waiting || agent.loadingThreads || ["preparing", "running"].includes(agent.conversation.status)) return message.warning(t("director.workspace.agentBusy"));
    const moduleForWorkspace: Record<DirectorWorkspace, Array<(typeof directorModules)[number]>> = {
      overview: ["story", "assets", "shots", "performance", "effects", "model", "continuity"],
      story: ["story"], assets: ["assets"], shots: ["shots", "performance", "effects"], production: ["model", "continuity"], advanced: ["continuity"],
    };
    const readinessNow = await fetchProductionReadiness(target).then(result => result.readiness);
    setReadiness(readinessNow);
    const targetObject = scope.targetId ? readinessNow.targets.find(item => item.targetId === scope.targetId || item.id === scope.targetId) : undefined;
    const cursors = Object.fromEntries(moduleForWorkspace[scope.workspace].map(module => [module, director.modules[module]?.cursor ?? null]));
    const selectedModules = moduleForWorkspace[scope.workspace].join(", ");
    const key = projectId || episodeId;
    const id = nanoid();
    const ownerKind = projectId ? "canvas" : "episode";
    const followTarget = useProductionFollowStore.getState().target;
    const workId = scope.workId || (followTarget?.kind === ownerKind && followTarget.id === key ? followTarget.workId : nanoid());
    const text = [
      "$canvas-video-production-sop",
      "这是导演工作台发起的独立阶段任务。按 Acheng 七模块职责完成本次范围，不把七个模块当成顺序关卡，不启动其他代理。",
      `制作对象：${key}；对象类型：${projectId ? "canvas" : "episode"}`,
      `Backend 正式 revision：${currentProduction.revision}；已发布版本：${currentProduction.publishedVersion}`,
      `固定引擎：${director.engine.version} / ${director.engine.runtimeId} / commit ${director.engine.commit}`,
      `本次工作区：${scope.workspace}；调用模块：${selectedModules}`,
      `内容交付模式：${director.workflow.contentDeliveryMode || "auto_file_batch"}；媒体生产模式：${director.workflow.mediaProductionMode || "per_item"}`,
      `选中目标：${targetObject ? `${targetObject.kind}:${targetObject.targetId}` : scope.targetId || "当前工作区缺项"}`,
      `当前就绪回执：${targetObject ? `${targetObject.status}；${targetObject.blockers.join("；")}` : readinessNow.nextAction}`,
      `恢复游标：${JSON.stringify(cursors)}`,
      `持续制作 workId：${workId}。每次确认新工作目标后，通过 set_director_workflow 写入正式 currentWork，保持此 workId，并调用结构化 site_navigate({production:{kind:"${ownerKind}",id:"${key}",workId:"${workId}"}}) 呈现 Backend 当前阶段。不要凭聊天文本切页。`,
      "如需用户裁定创作选项，先回读当前 sourceHash，把问题、至少两个明确选项、目标、workId 和 sourceHash 写入 workflow.pendingDecisions；不要把问题只留在聊天中，也不要预选或自动批准。用户答复保存后，再从答复绑定的源稿继续。",
      `用户需求：${String(director.source.brief || requestedBrief)}`,
      scope.instruction ? `本次补充要求：${scope.instruction}` : "",
      "保留项：不覆盖已确认的源稿和未编辑字段；完整保存对白、参考职责、资产版本与工作流游标。只提交本次模块产物和编译证据，使用 Backend expectedRevision/operationId 处理写入冲突。",
      "媒体权限：本请求只授权创作、修订和编译，不授权图片或视频生成。只有用户在工作台点击生成目标时，才使用对应生产 runId；前段 MP4 不得自动加入输入。",
      "请先读取 Backend 正式制作稿、缺项与运行记录，再从此游标继续。聊天中说已完成不算提交；完成后回读 Backend 版本回执。",
    ].filter(Boolean).join("\n");
    handledAgentResultRef.current = "";
    setAgentError("");
    useProductionFollowStore.getState().setTarget({ kind: ownerKind, id: key, workId, threadId: director.workflow.agentThreadId || agent.activeThreadId || undefined });
    setAgentState({
      panelOpen: true, panelMounted: true, activeTab: "chat", scopedTaskResult: null,
      scopedTask: { id, text, threadId: director.workflow.agentThreadId || agent.activeThreadId || undefined, productionId: key, revision: currentProduction.revision, engineRuntimeId: director.engine.runtimeId },
    });
  };

  const acceptRunStart = async (run: ProductionBatch) => {
    setBatches(current => [run, ...current.filter(item => item.runId !== run.runId)]);
    setPendingRun(null);
    if (draftKey) await localDrafts.setItem(draftKey, { brief: briefDraft, sourceDrafts, remoteRevision, pendingCommand, pendingRunStart: null } satisfies LocalDraft);
    message.success(t("director.workspace.runStarted"));
    const follow = useProductionFollowStore.getState();
    const owner = projectId ? { kind: "canvas" as const, id: projectId } : { kind: "episode" as const, id: episodeId };
    follow.setTarget({ ...owner, workId: follow.target?.workId || run.runId, runId: run.runId, threadId: follow.target?.threadId });
    follow.resume();
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
      const workId = production.draft.director.workflow.currentWork?.workId || nanoid();
      const currentWork = {
        workId, module: targetKind === "segment" ? "model" as const : "assets" as const, action: "produce" as const,
        targetKind, targetId, inputRevision: production.revision + 1, sourceHash: production.draft.director.sourceHash,
      };
      if (!await edit([{ type: "set_director_workflow", patch: { currentWork } }])) return;
      const focussedProduction = await fetchEpisodeProduction(target).then(value => value.production);
      setProduction(focussedProduction);
      setReadiness((await fetchProductionReadiness(target)).readiness);
      useProductionFollowStore.getState().setTarget({ kind: projectId ? "canvas" : "episode", id: projectId || episodeId, workId, threadId: focussedProduction.draft.director?.workflow.agentThreadId || useAgentStore.getState().activeThreadId || undefined });
      const request: PendingRunStart = { runId, idempotencyKey: runId, workId, expectedRevision: focussedProduction.revision, version: focussedProduction.publishedVersion, targets: [...targets], scope };
      setPendingRun(request);
      await localDrafts.setItem(draftKey, { brief: briefDraft, sourceDrafts, remoteRevision, pendingCommand, pendingRunStart: request } satisfies LocalDraft);
      const result = await startProductionRun(target, request);
      await acceptRunStart(result.run);
    } catch (error) {
      if (error instanceof BackendApiError && error.status >= 400 && error.status < 500) {
        setPendingRun(null);
        await localDrafts.setItem(draftKey, { brief: briefDraft, sourceDrafts, remoteRevision, pendingCommand, pendingRunStart: null } satisfies LocalDraft);
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
        if (draftKey) await localDrafts.setItem(draftKey, { brief: briefDraft, sourceDrafts, remoteRevision, pendingCommand, pendingRunStart: null } satisfies LocalDraft);
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
      let owner = projectId ? { kind: "canvas" as const, id: projectId } : { kind: "episode" as const, id: episodeId };
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
      useAgentStore.getState().openPanel();
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
  const regroupSegment = async (segmentId: string, shotIds: string[], removeSegmentIds: string[]) => edit([{ type: "set_director_segment_group", segmentId, shotIds, removeSegmentIds }]);
  const patchSource = async (entity: "style" | "scene" | "asset" | "shot" | "segment", id: string | undefined, patch: Record<string, unknown>) => edit([{ type: "patch_director_source", entity, ...(id ? { id } : {}), patch }]);
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
  const exportBundle = async (includeGeneratedMedia: boolean) => {
    if (!production || !readiness) return;
    setExporting(true);
    try {
      const owner = projectId ? { kind: "canvas" as const, id: projectId } : { kind: "episode" as const, id: episodeId };
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
    if (agentTaskResult?.status === "failed") setAgentError(agentTaskResult.error || t("director.workspace.agentTaskFailed"));
  }, [agentTaskResult, t]);

  if (loadError) return <main className="p-8"><Alert type="error" message={t("director.loadFailed")} description={loadError} /><Button className="mt-4" onClick={() => { setLoadError(""); void load(() => true, true).catch(error => setLoadError(String(error))); }}>{t("director.refresh")}</Button><Button onClick={() => navigate(backPath)}>{t("director.back")}</Button></main>;
  if (!production) return <div className="p-8 text-muted-foreground">{t("drama.production.loading")}</div>;

  const pendingNotice = pendingCommand && <div className="mb-4 rounded-xl border border-amber-400/60 bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
    <p>{pendingCommand.status === "unknown" ? t("drama.production.receiptUnknown") : t("drama.production.commandRejected")} · {pendingCommand.operationId}{pendingCommand.error ? ` · ${pendingCommand.error}` : ""}</p>
    <Button className="mt-2" size="small" disabled={busy} onClick={pendingCommand.status === "unknown" ? () => void recoverPending() : resolveRejected}>{pendingCommand.status === "unknown" ? t("drama.production.recoverReceipt") : t("drama.production.resolveWithServer")}</Button>
  </div>;
  const pendingRunNotice = pendingRunStart && <div className="mb-4 rounded-xl border border-amber-400/60 bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950/30 dark:text-amber-100"><p>{t("director.workspace.runReceiptUnknown")} · {pendingRunStart.runId}</p><Button className="mt-2" size="small" disabled={busy} onClick={() => void recoverRunStart()}>{t("drama.production.recoverReceipt")}</Button></div>;
  const run = batches[0] || null;
  const activeTargetIds = [...new Set(batches.filter(item => ["pending", "running", "paused", "awaiting_review"].includes(item.status)).flatMap(item => item.targets))];

  return <main className="min-h-full bg-background px-4 py-5 text-foreground sm:px-6 sm:py-7 lg:px-10">
    <div className="mx-auto max-w-7xl">
      <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div><Button type="text" icon={<ArrowLeft className="size-4" />} onClick={() => navigate(backPath)}>{t("director.back")}</Button><h1 className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">{title || t("director.title")}</h1><p className="mt-1 text-sm text-muted-foreground">{episode ? t("director.episodeContext", { number: episode.episodeNumber }) : t("director.canvasContext")}</p></div>
        <div className="flex flex-wrap items-center gap-2"><Tag>{t("drama.production.draftRevision", { number: production.revision })}</Tag><Tag color="orange">{t("drama.production.publishedVersion", { number: production.publishedVersion })}</Tag>{canvasId && <Button icon={<ExternalLink className="size-4" />} onClick={() => navigate(`/canvas/${encodeURIComponent(canvasId)}`)}>{t("drama.production.openCanvas")}</Button>}</div>
      </div>
      {agentError && <Alert className="mb-4" type="warning" showIcon message={agentError} closable onClose={() => setAgentError("")} />}
      {(remoteRevision !== null || pendingCommand) && <div className="mb-4 rounded-xl border border-amber-400/60 p-3 text-sm">{remoteRevision !== null && <p>{t("drama.production.conflictDetail", { number: remoteRevision })}</p>}{pendingNotice}</div>}
      {pendingRunNotice}
      <div className="mb-4 overflow-hidden rounded-2xl border border-border bg-card">
        <div className="grid min-w-0 lg:grid-cols-[210px_minmax(0,1fr)]">
          <aside className="min-w-0 border-b border-border lg:border-b-0 lg:border-r">
            <nav aria-label={t("director.workspace.navigation")} className="flex w-full gap-1 overflow-x-auto p-2 lg:flex-col lg:overflow-visible lg:p-3">
              {workspaces.filter(item => item.key !== "advanced").map(({ key, icon: Icon, roles }) => <button
                key={key} type="button" aria-current={workspace === key ? "page" : undefined}
                onClick={() => selectWorkspace(key)}
                className={`flex min-h-11 shrink-0 items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors lg:w-full ${workspace === key ? "border-border bg-muted font-medium text-foreground" : "border-transparent text-muted-foreground hover:bg-muted/60 hover:text-foreground"}`}
              ><Icon className="size-4 shrink-0" /><span className="min-w-0"><span className="block whitespace-nowrap">{t(`director.workspace.tab.${key}`)}</span>{roles && <span className="hidden truncate text-[10px] font-normal opacity-70 lg:block">{roles}</span>}</span></button>)}
              <div className="mx-2 hidden border-t border-border lg:block" />
              <button type="button" aria-current={workspace === "advanced" ? "page" : undefined} onClick={() => selectWorkspace("advanced")}
                className={`flex min-h-11 shrink-0 items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors lg:w-full ${workspace === "advanced" ? "border-border bg-muted font-medium text-foreground" : "border-transparent text-muted-foreground hover:bg-muted/60 hover:text-foreground"}`}
              ><Settings2 className="size-4 shrink-0" /><span className="whitespace-nowrap">{t("director.workspace.tab.advanced")}</span></button>
            </nav>
          </aside>
          <section aria-label={t(`director.workspace.tab.${workspace}`)} className="min-w-0 p-3 sm:p-5 lg:p-6">
            <DirectorPanel
              workspace={workspace} director={production.draft.director} production={production} readiness={readiness || undefined} run={run} batches={batches}
              canvasNodes={canvasNodes} legacy={legacy} versions={versions} busy={busy} canvasId={canvasId}
              sourceDrafts={sourceDrafts} onSourceDraftChange={setSourceDraft}
              onBrief={saveBrief} onPatch={patchSource} onRegroup={regroupSegment} onWorkflow={setWorkflow} onBindAsset={(assetId, nodeId) => void bindAsset(assetId, nodeId)}
              onBoundary={setBoundary} onReview={reviewAsset} onPublish={() => void publish()}
              onReplace={value => void replaceDirector(value)} onAskDirector={scope => void askDirector(scope)} onNavigate={navigateWorkspace}
              onAnswerDecision={answerDecision}
              onExport={exportBundle} exporting={exporting}
              onStart={(targets, scope) => void startRun(targets, scope)} onPause={runId => void pauseRun(runId)} onResume={runId => void resumeRun(runId)}
              runStartPending={Boolean(pendingRunStart)} activeTargetIds={activeTargetIds}
              onRestore={restoreVersion} onRefresh={() => void load(() => true, true).catch(fail)}
            />
          </section>
        </div>
      </div>
    </div>
  </main>;
}
