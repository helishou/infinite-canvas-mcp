import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, App, Button, Input, InputNumber, Modal, Select, Tabs, Tag } from "antd";
import { ArrowDown, ArrowLeft, ArrowUp, ExternalLink, Plus, Trash2 } from "lucide-react";
import { useAgentStore } from "@/stores/use-agent-store";
import { DirectorPanel } from "./director-panel";
import { nanoid } from "nanoid";
import localforage from "localforage";
import { useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { ProductionOperation, ProductionScene, ProductionShot } from "@basketikun/canvas-agent/drama/production-contract";
import { backendConnection } from "@/lib/backend-connection";
import { ensureCanvasDraftLease, getCanvasDraftSessionId } from "@/lib/canvas/canvas-draft-session";
import {
  BackendApiError, backendMediaUrl, editEpisodeProduction, fetchBackendDramaEpisode, fetchEpisodeProduction,
  fetchEpisodeProductionLegacy, fetchEpisodeProductionVersions, previewEpisodeProductionImpact,
  publishEpisodeProduction, restoreEpisodeProduction, type DramaEpisode, type EpisodeProduction,
  syncEpisodeProductionClips, fetchEpisodeProductionRun,
  exportEpisodeProductionMarkdown, fetchBackendProject, fetchBackendCanvasDrama, type ProductionTarget,
} from "@/services/backend-api";

const newScene = (): ProductionScene => ({ id: nanoid(), heading: "", location: "", timeOfDay: "", blocks: [{ id: nanoid(), kind: "action", text: "" }] });
const newShot = (sceneId: string): ProductionShot => ({ id: nanoid(), sceneId, title: "", duration: 5, visual: "", camera: "", openingState: "", endingState: "", sound: "", assetNodeIds: [], keyframePolicy: "new" });
const localDrafts = localforage.createInstance({ name: "episode-production-drafts", storeName: "unfinished" });
type PendingCommand = { operationId: string; expectedRevision: number; status: "unknown" | "rejected"; error?: string } & (
  { kind: "edit"; ops: ProductionOperation[] } | { kind: "publish"; stage: "script" | "shots" | "director" } | { kind: "restore"; version: number }
);
type LocalDraft = { brief?: string; sceneEditor: ProductionScene | null; shotEditor: ProductionShot | null; remoteRevision: number | null; pendingCommand?: PendingCommand | null };

// A route identity owns its local drafts; changing project must remount the editor.
export default function ProductionRoute() {
  const { episodeId, projectId } = useParams();
  return <ProductionEditor key={projectId ? `canvas:${projectId}` : `episode:${episodeId}`} />;
}

function ProductionEditor() {
  const { episodeId = "", projectId = "" } = useParams();
  const target = useMemo<ProductionTarget>(() => projectId ? { projectId } : episodeId, [projectId, episodeId]);
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { message, modal } = App.useApp();
  const [title, setTitle] = useState("");
  const [canvasId, setCanvasId] = useState(projectId);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [loadError, setLoadError] = useState("");
  const [brief, setBrief] = useState("");
  const [episode, setEpisode] = useState<DramaEpisode | null>(null);
  const [canvasNodes, setCanvasNodes] = useState<Array<{ id: string; title?: string; type?: string; metadata?: Record<string, unknown> }>>([]);
  const [production, setProduction] = useState<EpisodeProduction | null>(null);
  const [legacy, setLegacy] = useState<Array<{ source: "fullPlot" | "script.md" | "storyboard.md"; text: string }>>([]);
  const [versions, setVersions] = useState<Array<{ version: number; stage: string; createdAt: string }>>([]);
  const [busy, setBusy] = useState(false);
  const [sceneEditor, setSceneEditor] = useState<ProductionScene | null>(null);
  const [shotEditor, setShotEditor] = useState<ProductionShot | null>(null);
  const [tab, setTab] = useState("director");
  const [remoteRevision, setRemoteRevision] = useState<number | null>(null);
  const [draftKey, setDraftKey] = useState<string | null>(null);
  const [pendingCommand, setPendingCommand] = useState<PendingCommand | null>(null);
  const pendingCommandRef = useRef<PendingCommand | null>(null);
  const pending = (value: PendingCommand | null) => { pendingCommandRef.current = value; setPendingCommand(value); };
  const [runStatus, setRunStatus] = useState<{ status: string; submitted: Array<{ kind: "image" | "h3"; id: string; taskId: string }>; error: string | null } | null>(null);
  const load = useCallback(async (isActive: () => boolean = () => true) => {
    const contextRequest = projectId ? Promise.all([fetchBackendProject(projectId), fetchBackendCanvasDrama(projectId)]).then(([canvas, relation]) => ({ canvas: canvas.project, episode: relation.episode })) : fetchBackendDramaEpisode(episodeId);
    const [context, prod, old, history] = await Promise.all([
      contextRequest, fetchEpisodeProduction(target), fetchEpisodeProductionLegacy(target), fetchEpisodeProductionVersions(target),
    ]);
    const run = prod.production.publishedVersion ? (await fetchEpisodeProductionRun(target, prod.production.publishedVersion)).run : null;
    if (!isActive()) return null;
    setEpisode(context.episode || null);
    setTitle(context.episode?.title || String(context.canvas?.title || ""));
    setCanvasId(projectId || context.episode?.canvasId || "");
    setCanvasNodes((context.canvas?.nodes || []) as Array<{ id: string; title?: string; type?: string; metadata?: Record<string, unknown> }>);
    setProduction(prod.production); setLegacy(old.sources); setVersions(history.versions); setRunStatus(run); setLoadError("");
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
      if (saved) { setBrief(saved.brief || ""); setSceneEditor(saved.sceneEditor); setShotEditor(saved.shotEditor); setRemoteRevision(saved.remoteRevision); pending(saved.pendingCommand || null); }
      setDraftKey(key);
    })().catch((error) => { if (active) { setLoadError(String(error)); message.error(String(error)); } });
    return () => { active = false; };
  }, [episodeId, load, message, loadAttempt]);
  useEffect(() => {
    if (!draftKey) return;
    const value: LocalDraft = { brief, sceneEditor, shotEditor, remoteRevision, pendingCommand };
    void (brief.trim() || sceneEditor || shotEditor || remoteRevision !== null || pendingCommand ? localDrafts.setItem(draftKey, value) : localDrafts.removeItem(draftKey))
      .catch((error) => message.error({ key: "episode-local-draft", content: error instanceof Error ? error.message : String(error) }));
  }, [draftKey, brief, sceneEditor, shotEditor, remoteRevision, pendingCommand, production, message]);

  const fail = (error: unknown) => {
    if (error instanceof BackendApiError && error.status === 409) {
      const current = error.details.current as EpisodeProduction | undefined;
      setRemoteRevision(current?.revision ?? null);
      message.warning(t("drama.production.conflict"));
    } else message.error(error instanceof Error ? error.message : String(error));
  };
  const sendCommand = async (command: PendingCommand) => {
    if (!draftKey) throw new Error(t("drama.production.draftNotReady"));
    await ensureCanvasDraftLease();
    const previous = pendingCommandRef.current;
    if (previous && (previous.operationId !== command.operationId || previous.status === "rejected")) throw new Error(t("drama.production.resolvePending"));
    await localDrafts.setItem(draftKey, { brief, sceneEditor, shotEditor, remoteRevision, pendingCommand: command } satisfies LocalDraft);
    pending(command);
    try {
      const result = command.kind === "edit" ? await editEpisodeProduction(target, command.expectedRevision, command.ops, command.operationId)
        : command.kind === "publish" ? await publishEpisodeProduction(target, command.expectedRevision, command.stage, command.operationId)
        : await restoreEpisodeProduction(target, command.expectedRevision, command.version, command.operationId);
      if (!result.production || !Number.isInteger(result.production.revision)) throw new Error(t("drama.production.receiptMalformed"));
      await localDrafts.setItem(draftKey, { brief, sceneEditor, shotEditor, remoteRevision: null, pendingCommand: null } satisfies LocalDraft);
      pending(null);
      setProduction(result.production);
      setRemoteRevision(null);
      return result.production;
    } catch (error) {
      const rejected = error instanceof BackendApiError && error.status > 0;
      const saved: PendingCommand = { ...command, status: rejected ? "rejected" : "unknown", error: error instanceof Error ? error.message : String(error) };
      await localDrafts.setItem(draftKey, { brief, sceneEditor, shotEditor, remoteRevision, pendingCommand: saved } satisfies LocalDraft);
      pending(saved);
      throw error;
    }
  };
  const edit = async (ops: ProductionOperation[], close?: () => void) => {
    if (!production || busy) return;
    if (pendingCommandRef.current) return void message.warning(t("drama.production.resolvePending"));
    setBusy(true);
    try {
      await sendCommand({ kind: "edit", operationId: nanoid(), expectedRevision: production.revision, ops: structuredClone(ops), status: "unknown" });
      close?.();
      message.success(t("drama.production.saved"));
    } catch (error) { fail(error); } finally { setBusy(false); }
  };
  const publish = async (stage: "script" | "shots" | "director") => {
    if (!production || busy) return;
    if (pendingCommandRef.current) return void message.warning(t("drama.production.resolvePending"));
    setBusy(true);
    try {
      const { impact } = await previewEpisodeProductionImpact(target, stage);
      const command: PendingCommand = { kind: "publish", operationId: nanoid(), expectedRevision: production.revision, stage, status: "unknown" };
      modal.confirm({
        title: t("drama.production.publishTitle"),
        content: <div className="space-y-1 text-sm">
          <p>{t("drama.production.impactSummary", { scenes: impact.changedSceneIds.length, shots: impact.affectedShotIds.length, images: impact.imageShotIds.length, clips: impact.clipGroupIds.length })}</p>
          {impact.missingAssetNodeIds.length > 0 && <p className="text-amber-600">{t("drama.production.missingRefs", { count: impact.missingAssetNodeIds.length })}</p>}
        </div>,
        onOk: async () => {
          try {
            const result = await sendCommand(command);
            setVersions((await fetchEpisodeProductionVersions(target)).versions);
            setRunStatus((await fetchEpisodeProductionRun(target, result.publishedVersion)).run);
            message.success(t("drama.production.published"));
          } catch (error) { fail(error); throw error; }
        },
      });
    } catch (error) { fail(error); } finally { setBusy(false); }
  };
  const recoverPending = async () => {
    const command = pendingCommandRef.current;
    if (!command || command.status !== "unknown" || busy) return;
    setBusy(true);
    try {
      await sendCommand(command);
      await load();
      message.success(t("drama.production.receiptRecovered"));
    } catch (error) { fail(error); } finally { setBusy(false); }
  };
  const resolveRejected = () => modal.confirm({
    title: t("drama.production.resolveTitle"), content: t("drama.production.resolveDescription"),
    onOk: async () => {
      await load();
      if (draftKey) await localDrafts.setItem(draftKey, { brief, sceneEditor, shotEditor, remoteRevision: null, pendingCommand: null } satisfies LocalDraft);
      pending(null);
      setRemoteRevision(null);
    },
  });
  const restoreVersion = (version: number) => {
    if (!production || busy || pendingCommandRef.current) return void message.warning(t("drama.production.resolvePending"));
    const command: PendingCommand = { kind: "restore", operationId: nanoid(), expectedRevision: production.revision, version, status: "unknown" };
    modal.confirm({ title: t("drama.production.restoreTitle", { number: version }), onOk: async () => {
      try { await sendCommand(command); await load(); } catch (error) { fail(error); throw error; }
    } });
  };
  const move = (sceneId: string, shotId: string, direction: number) => {
    if (!production) return;
    const shots = production.draft.shots.filter((item) => item.sceneId === sceneId);
    const index = shots.findIndex((item) => item.id === shotId);
    const next = index + direction;
    if (next < 0 || next >= shots.length) return;
    const ids = shots.map((item) => item.id);
    [ids[index], ids[next]] = [ids[next], ids[index]];
    void edit([{ type: "reorder_shots", sceneId, ids }]);
  };
  const draftShotsFromScript = () => {
    if (!production?.published?.scenes.length) return;
    const ops: ProductionOperation[] = production.published.scenes.filter((scene) => !production.draft.shots.some((shot) => shot.sceneId === scene.id)).flatMap((scene) => {
      const blocks = scene.blocks.filter((block) => block.text.trim());
      return blocks.map((block) => ({ type: "upsert_shot" as const, shot: { ...newShot(scene.id), title: block.kind === "dialogue" ? `${block.speaker || "人物"}对白` : scene.heading, visual: block.text, sound: block.kind === "dialogue" ? block.text : "", duration: Math.min(15, Math.max(3, Math.ceil(block.text.length / 5))) } }));
    });
    if (ops.length) void edit(ops);
    else message.info(t("drama.production.noDraftShots"));
  };
  const groupWithNext = (shotId: string) => {
    if (!production) return;
    const index = production.draft.shots.findIndex((shot) => shot.id === shotId);
    const next = production.draft.shots[index + 1];
    if (!next) return;
    const existing = production.draft.clipGroups.filter((group) => group.shotIds.includes(shotId) || group.shotIds.includes(next.id));
    if (existing.some((group) => group.shotIds.length > 1)) return message.warning(t("drama.production.splitFirst"));
    let reason = "";
    modal.confirm({ title: t("drama.production.groupTitle"), content: <Input.TextArea placeholder={t("drama.production.groupReason")} onChange={(event) => { reason = event.target.value; }} />, onOk: () => {
      if (!reason.trim()) throw new Error(t("drama.production.groupReason"));
      return edit([...existing.map((group): ProductionOperation => ({ type: "delete_clip_group", id: group.id })), { type: "set_clip_group", group: { id: nanoid(), shotIds: [shotId, next.id], nodeId: null, segmentId: null, sourceVersion: production.publishedVersion, continuityReason: reason.trim() } }]);
    } });
  };
  const draft = production?.draft;
  if (loadError) return <main className="p-8"><Alert type="error" message={t("director.loadFailed")} description={loadError} /><Button className="mt-4" onClick={() => { setLoadError(""); setLoadAttempt(n => n + 1); }}>{t("director.refresh")}</Button><Button onClick={() => navigate("/director")}>{t("director.back")}</Button></main>;
  if (!production || !draft) return <div className="p-8 text-muted-foreground">{t("drama.production.loading")}</div>;
  const downloadMarkdown = async (stage: "script" | "shots" | "director") => {
    try {
      const { fileName, markdown } = await exportEpisodeProductionMarkdown(target, stage);
      const url = URL.createObjectURL(new Blob([markdown], { type: "text/markdown;charset=utf-8" }));
      const link = document.createElement("a");
      link.href = url; link.download = fileName; link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (error) { fail(error); }
  };
  const sourceChoices = legacy.filter((item) => !draft.legacyImports.some((used) => used.source === item.source));
  const pendingEditorActions = pendingCommand && <div className="mb-4 rounded-xl border border-amber-400/60 p-3 text-sm">
    <p className="mb-2">{t(pendingCommand.status === "unknown" ? "drama.production.receiptUnknown" : "drama.production.commandRejected")}</p>
    <Button disabled={busy} onClick={pendingCommand.status === "unknown" ? () => void recoverPending() : resolveRejected}>{t(pendingCommand.status === "unknown" ? "drama.production.recoverReceipt" : "drama.production.resolveWithServer")}</Button>
  </div>;
  return <main className="min-h-full bg-background px-6 py-7 text-foreground lg:px-10">
    <div className="mx-auto max-w-7xl">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <Button type="text" icon={<ArrowLeft className="size-4" />} onClick={() => navigate("/director")}>{t("director.back")}</Button>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight">{title || t("director.title")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{episode ? t("director.episodeContext", { number: episode.episodeNumber }) : t("director.canvasContext")}</p>
        </div>
        <div className="flex items-center gap-2">
          <Tag>{t("drama.production.draftRevision", { number: production.revision })}</Tag>
          <Tag color="orange">{t("drama.production.publishedVersion", { number: production.publishedVersion })}</Tag>
          {canvasId && <Button icon={<ExternalLink className="size-4" />} onClick={() => navigate(`/canvas/${encodeURIComponent(canvasId)}`)}>{t("drama.production.openCanvas")}</Button>}
        </div>
      </div>
      {(remoteRevision !== null || pendingCommand) && <div className="mb-5 space-y-2 rounded-xl border border-amber-400/60 bg-amber-50 p-4 text-sm text-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
        {remoteRevision !== null && <p>{t("drama.production.conflictDetail", { number: remoteRevision })}</p>}
        {pendingCommand && <p>{t(pendingCommand.status === "unknown" ? "drama.production.receiptUnknown" : "drama.production.commandRejected")} · {pendingCommand.operationId}</p>}
        {pendingCommand?.status === "unknown" ? <Button size="small" disabled={busy} onClick={() => void recoverPending()}>{t("drama.production.recoverReceipt")}</Button> : <Button size="small" disabled={busy} onClick={resolveRejected}>{t("drama.production.resolveWithServer")}</Button>}
      </div>}
      <div className="mb-5 flex flex-wrap items-center gap-3 rounded-2xl border border-border bg-card p-4">
        <span className="font-medium">{t("drama.production.mode")}</span>
        <Select value={draft.settings.mode} className="w-44" options={[{ value: "manual", label: t("drama.production.manual") }, { value: "auto", label: t("drama.production.auto") }]} onChange={(mode) => void edit([{ type: "set_settings", patch: { mode } }])} disabled={busy} />
        {draft.settings.mode === "auto" && <span className="text-xs text-muted-foreground">{t("drama.production.autoHint")}</span>}
      </div>
      <section className="mb-6 border-y border-border py-5">
        <h2 className="mb-2 font-semibold">{t("director.briefTitle")}</h2>
        <Input.TextArea aria-label={t("director.briefTitle")} placeholder={t("director.briefPlaceholder")} autoSize={{ minRows: 3, maxRows: 8 }} value={brief} disabled={!draftKey} onChange={event => setBrief(event.target.value)} />
        <div className="mt-3 flex flex-wrap items-center gap-3"><Button type="primary" disabled={!brief.trim() || !draftKey} onClick={() => {
          const agent = useAgentStore.getState(); agent.openPanel();
          if (agent.prompt.trim() || agent.attachments.length || agent.canvasReferences.length || agent.sending || agent.waiting) {
            message.info(t("director.keepAgentDraft")); return;
          }
          agent.setAgentState({ activeTab: "chat", prompt: `$canvas-video-production-sop\n${t("director.agentRequest")}\n${canvasId ? `canvasProjectId: ${canvasId}` : ""}\n${episode?.id ? `episodeId: ${episode.id}` : ""}\n\n${brief.trim()}` });
          message.info(t("director.requestPrepared"));
        }}>{t("director.handoff")}</Button><span className="text-xs text-muted-foreground">{t("director.handoffHint")}</span></div>
      </section>
      <Tabs activeKey={tab} onChange={setTab} items={[
        { key: "director", label: "Acheng" },
        { key: "script", label: t("drama.production.script") },
        { key: "shots", label: t("drama.production.shots") },
        { key: "storyboard", label: t("drama.production.storyboard") },
        { key: "h3", label: t("drama.production.h3") },
      ]} />
      {tab === "director" && <DirectorPanel director={draft.director} busy={busy} onSave={async director => {
        if (busy || pendingCommandRef.current) throw new Error(t("drama.production.resolvePending"));
        setBusy(true);
        try { return await sendCommand({ kind: "edit", operationId: nanoid(), expectedRevision: production.revision, ops: [{ type: "set_director_production", director }], status: "unknown" }); }
        catch (error) { fail(error); throw error; } finally { setBusy(false); }
      }} onPublish={() => void publish("director")} />}
      {tab === "script" && <section className="space-y-4">
        <div className="flex flex-wrap gap-2"><Button type="primary" icon={<Plus className="size-4" />} onClick={() => setSceneEditor(newScene())}>{t("drama.production.addScene")}</Button><Button disabled={busy} onClick={() => void publish("script")}>{t("drama.production.publishScript")}</Button><Button disabled={!production.publishedVersion} onClick={() => void downloadMarkdown("script")}>{t("drama.production.exportScript")}</Button>
          {sourceChoices.length > 0 && <Select placeholder={t("drama.production.importLegacy")} className="min-w-48" options={sourceChoices.map((item) => ({ value: item.source, label: item.source }))} onChange={(source) => void edit([{ type: "import_legacy", source }])} />}
        </div>
        {draft.scenes.map((scene, index) => <article key={scene.id} className="rounded-2xl border border-border bg-card p-5">
          <div className="flex items-center justify-between gap-2"><div><span className="text-xs text-muted-foreground">{t("drama.production.sceneNumber", { number: index + 1 })} · {scene.id}</span><h2 className="text-lg font-semibold">{scene.heading || t("drama.production.untitledScene")}</h2><p className="text-sm text-muted-foreground">{scene.location} {scene.timeOfDay}</p></div><div className="flex gap-1"><Button size="small" onClick={() => setSceneEditor(structuredClone(scene))}>{t("drama.production.edit")}</Button><Button size="small" icon={<ArrowUp className="size-3" />} disabled={index === 0} onClick={() => { const ids = draft.scenes.map((item) => item.id); [ids[index - 1], ids[index]] = [ids[index], ids[index - 1]]; void edit([{ type: "reorder_scenes", ids }]); }} /><Button size="small" icon={<ArrowDown className="size-3" />} disabled={index === draft.scenes.length - 1} onClick={() => { const ids = draft.scenes.map((item) => item.id); [ids[index + 1], ids[index]] = [ids[index], ids[index + 1]]; void edit([{ type: "reorder_scenes", ids }]); }} /><Button size="small" danger icon={<Trash2 className="size-3" />} onClick={() => void edit([{ type: "delete_scene", id: scene.id }])} /></div></div>
          <div className="mt-4 space-y-2">{scene.blocks.map((block) => <div key={block.id} className="whitespace-pre-wrap rounded-xl bg-muted/50 px-4 py-2 text-sm">{block.kind === "dialogue" && <strong className="mr-3 text-orange-600">{block.speaker}</strong>}{block.text}</div>)}</div>
        </article>)}
      </section>}
      {tab === "shots" && <section className="space-y-4"><div className="flex flex-wrap gap-2"><Button type="primary" icon={<Plus className="size-4" />} disabled={!draft.scenes.length} onClick={() => setShotEditor(newShot(draft.scenes[0].id))}>{t("drama.production.addShot")}</Button><Button disabled={!production.published?.scenes.length} onClick={draftShotsFromScript}>{t("drama.production.draftShots")}</Button><Button disabled={busy} onClick={() => void publish("shots")}>{t("drama.production.publishShots")}</Button><Button disabled={!production.published?.shots.length} onClick={() => void downloadMarkdown("shots")}>{t("drama.production.exportShots")}</Button></div>
        {draft.scenes.map((scene) => <div key={scene.id} className="space-y-2"><h2 className="pt-3 font-semibold">{scene.heading}</h2>{draft.shots.filter((shot) => shot.sceneId === scene.id).map((shot, index) => <article key={shot.id} className="flex gap-3 rounded-xl border border-border bg-card p-4"><span className="w-10 shrink-0 font-mono text-sm text-orange-500">{index + 1}</span><div className="min-w-0 flex-1"><h3 className="font-medium">{shot.title || shot.visual.slice(0, 42)}</h3><p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">{shot.visual}</p><p className="mt-2 text-xs text-muted-foreground">{shot.duration}s · {shot.camera} · {shot.keyframePolicy}</p></div><div className="flex shrink-0 gap-1"><Button size="small" onClick={() => setShotEditor(structuredClone(shot))}>{t("drama.production.edit")}</Button><Button size="small" icon={<ArrowUp className="size-3" />} onClick={() => move(scene.id, shot.id, -1)} /><Button size="small" icon={<ArrowDown className="size-3" />} onClick={() => move(scene.id, shot.id, 1)} /><Button size="small" danger icon={<Trash2 className="size-3" />} onClick={() => void edit([{ type: "delete_shot", id: shot.id }])} /></div></article>)}</div>)}
      </section>}
      {tab === "storyboard" && <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{draft.shots.map((shot, index) => { const frame = draft.keyframes[shot.id]; const review = draft.keyframeReviews[shot.id]; return <article key={shot.id} className="rounded-2xl border border-border bg-card p-5"><div className="flex justify-between"><span className="text-xs text-orange-500">{t("drama.production.shotNumber", { number: index + 1 })}</span><Tag>{shot.keyframePolicy}</Tag></div><div className="mt-3 flex aspect-video items-center justify-center overflow-hidden rounded-xl bg-muted/60">{frame?.storageKey ? <img className="h-full w-full object-contain" src={backendMediaUrl(frame.storageKey)} alt={shot.title || shot.visual} /> : <span className="text-xs text-muted-foreground">{t("drama.production.noFrame")}</span>}</div><h3 className="mt-3 font-semibold">{shot.title || shot.visual}</h3><p className="mt-2 text-sm text-muted-foreground">{shot.openingState} → {shot.endingState}</p><p className="mt-3 text-xs">{frame?.nodeId || t("drama.production.noFrame")}</p><Tag color={review?.verdict === "auto-accepted" ? "green" : review?.verdict === "needs-redo" ? "red" : "default"}>{review ? t(`drama.production.review.${review.verdict}`) : t("drama.production.review.pending")}</Tag><Select className="mt-3 w-full" allowClear placeholder={t("drama.production.linkFrame")} value={frame?.nodeId} options={canvasNodes.filter((node) => node.type === "image" || node.type === "config").map((node) => ({ value: node.id, label: node.title || node.id }))} onChange={(nodeId) => void edit([{ type: "set_keyframe", shotId: shot.id, nodeId: nodeId || null }])} />{frame && canvasId && <Button type="link" onClick={() => navigate(`/canvas/${encodeURIComponent(canvasId)}?nodeId=${frame.nodeId}`)}>{t("drama.production.locate")}</Button>}</article>; })}</section>}
      {tab === "h3" && <section className="space-y-4"><p className="text-sm text-muted-foreground">{t("drama.production.h3Hint")}</p><div className="flex flex-wrap items-center gap-3"><Button disabled={!production.published?.shots.length || busy} onClick={() => { setBusy(true); void syncEpisodeProductionClips(target).then((result) => { setProduction(result.production); message.success(t("drama.production.synced")); }).catch(fail).finally(() => setBusy(false)); }}>{t("drama.production.syncClips")}</Button>{runStatus && <Tag color={runStatus.status === "succeeded" ? "green" : runStatus.status === "paused" ? "orange" : "blue"}>{t("drama.production.runStatus", { status: runStatus.status, count: runStatus.submitted.length })}</Tag>}<Button size="small" onClick={() => void fetchEpisodeProductionRun(target, production.publishedVersion).then((result) => setRunStatus(result.run))}>{t("drama.production.refresh")}</Button></div>{runStatus?.error && <p className="text-sm text-amber-600">{runStatus.error}</p>}{draft.shots.map((shot, index) => { const group = draft.clipGroups.find((item) => item.shotIds.includes(shot.id)); return <article key={shot.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card p-4"><span className="font-mono text-orange-500">{index + 1}</span><span className="min-w-48 flex-1">{shot.title || shot.visual.slice(0, 52)}</span><span className="text-xs text-muted-foreground">{group ? `${group.nodeId || "—"} / ${group.segmentId || "—"}` : t("drama.production.noClip")}</span>{index < draft.shots.length - 1 && (!group || group.shotIds.length === 1) && <Button size="small" onClick={() => groupWithNext(shot.id)}>{t("drama.production.groupNext")}</Button>}{group && group.shotIds.length > 1 && group.shotIds[0] === shot.id && <Button size="small" onClick={() => void edit([{ type: "delete_clip_group", id: group.id }, ...group.shotIds.map((id): ProductionOperation => ({ type: "set_clip_group", group: { id: `clip:${id}`, shotIds: [id], nodeId: null, segmentId: null, sourceVersion: production.publishedVersion } }))])}>{t("drama.production.splitGroup")}</Button>}{group?.nodeId && canvasId && <Button onClick={() => navigate(`/canvas/${encodeURIComponent(canvasId)}?nodeId=${encodeURIComponent(group.nodeId!)}&segmentId=${encodeURIComponent(group.segmentId || "")}`)}>{t("drama.production.locate")}</Button>}</article>; })}</section>}
      <div className="mt-10 border-t border-border pt-5"><h2 className="mb-3 font-semibold">{t("drama.production.history")}</h2><div className="flex flex-wrap gap-2">{versions.map((item) => <Button key={item.version} size="small" onClick={() => restoreVersion(item.version)}>v{item.version} · {item.stage} · {new Date(item.createdAt).toLocaleString()}</Button>)}</div></div>
    </div>
    <Modal title={t("drama.production.editScene")} open={!!sceneEditor} onCancel={() => setSceneEditor(null)} onOk={() => sceneEditor && void edit([{ type: "upsert_scene", scene: sceneEditor }], () => setSceneEditor(null))} confirmLoading={busy} width={780} okText={t("drama.production.saveDraft")}>
      {pendingEditorActions}
      {sceneEditor && <div className="space-y-3"><Input placeholder={t("drama.production.heading")} value={sceneEditor.heading} onChange={(event) => setSceneEditor({ ...sceneEditor, heading: event.target.value })} /><div className="flex gap-2"><Input placeholder={t("drama.production.location")} value={sceneEditor.location} onChange={(event) => setSceneEditor({ ...sceneEditor, location: event.target.value })} /><Input placeholder={t("drama.production.timeOfDay")} value={sceneEditor.timeOfDay} onChange={(event) => setSceneEditor({ ...sceneEditor, timeOfDay: event.target.value })} /></div>{sceneEditor.blocks.map((block, index) => <div key={block.id} className="rounded-xl border border-border p-3"><div className="mb-2 flex gap-2"><Select className="w-32" value={block.kind} options={[{ value: "action", label: t("drama.production.action") }, { value: "dialogue", label: t("drama.production.dialogue") }]} onChange={(kind) => setSceneEditor({ ...sceneEditor, blocks: sceneEditor.blocks.map((item) => item.id === block.id ? { ...item, kind } : item) })} />{block.kind === "dialogue" && <Input placeholder={t("drama.production.speaker")} value={block.speaker} onChange={(event) => setSceneEditor({ ...sceneEditor, blocks: sceneEditor.blocks.map((item) => item.id === block.id ? { ...item, speaker: event.target.value } : item) })} />}<Button icon={<ArrowUp className="size-3" />} disabled={!index} onClick={() => { const blocks = [...sceneEditor.blocks]; [blocks[index - 1], blocks[index]] = [blocks[index], blocks[index - 1]]; setSceneEditor({ ...sceneEditor, blocks }); }} /><Button danger icon={<Trash2 className="size-3" />} onClick={() => setSceneEditor({ ...sceneEditor, blocks: sceneEditor.blocks.filter((item) => item.id !== block.id) })} /></div><Input.TextArea autoSize={{ minRows: 2 }} value={block.text} onChange={(event) => setSceneEditor({ ...sceneEditor, blocks: sceneEditor.blocks.map((item) => item.id === block.id ? { ...item, text: event.target.value } : item) })} /></div>)}<Button icon={<Plus className="size-4" />} onClick={() => setSceneEditor({ ...sceneEditor, blocks: [...sceneEditor.blocks, { id: nanoid(), kind: "action", text: "" }] })}>{t("drama.production.addBlock")}</Button></div>}
    </Modal>
    <Modal title={t("drama.production.editShot")} open={!!shotEditor} onCancel={() => setShotEditor(null)} onOk={() => shotEditor && void edit([{ type: "upsert_shot", shot: shotEditor }], () => setShotEditor(null))} confirmLoading={busy} width={760} okText={t("drama.production.saveDraft")}>
      {pendingEditorActions}
      {shotEditor && <div className="grid gap-3"><Select value={shotEditor.sceneId} options={draft.scenes.map((scene) => ({ value: scene.id, label: scene.heading || scene.id }))} onChange={(sceneId) => setShotEditor({ ...shotEditor, sceneId })} /><Input placeholder={t("drama.production.shotTitle")} value={shotEditor.title} onChange={(event) => setShotEditor({ ...shotEditor, title: event.target.value })} /><Input.TextArea placeholder={t("drama.production.visual")} value={shotEditor.visual} onChange={(event) => setShotEditor({ ...shotEditor, visual: event.target.value })} /><Input placeholder={t("drama.production.camera")} value={shotEditor.camera} onChange={(event) => setShotEditor({ ...shotEditor, camera: event.target.value })} /><div className="flex gap-2"><InputNumber min={0} addonAfter="s" value={shotEditor.duration} onChange={(duration) => setShotEditor({ ...shotEditor, duration: duration ?? 0 })} /><Select className="flex-1" value={shotEditor.keyframePolicy} options={["new", "reuse", "none"].map((value) => ({ value, label: t(`drama.production.framePolicy.${value}`) }))} onChange={(keyframePolicy) => setShotEditor({ ...shotEditor, keyframePolicy })} /></div><Input placeholder={t("drama.production.openingState")} value={shotEditor.openingState} onChange={(event) => setShotEditor({ ...shotEditor, openingState: event.target.value })} /><Input placeholder={t("drama.production.endingState")} value={shotEditor.endingState} onChange={(event) => setShotEditor({ ...shotEditor, endingState: event.target.value })} /><Input placeholder={t("drama.production.sound")} value={shotEditor.sound} onChange={(event) => setShotEditor({ ...shotEditor, sound: event.target.value })} /><Select mode="multiple" placeholder={t("drama.production.assets")} value={shotEditor.assetNodeIds} options={canvasNodes.map((node) => ({ value: node.id, label: node.title || node.id }))} onChange={(assetNodeIds) => setShotEditor({ ...shotEditor, assetNodeIds })} /></div>}
    </Modal>
  </main>;
}
