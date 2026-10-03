import { useEffect, useMemo, useState } from "react";
import { Alert, App, Button, Image as AntdImage, Input, Modal, Select, Switch, Tag } from "antd";
import { ArrowRight, Check, Pause, Play, RotateCcw, WandSparkles } from "lucide-react";
import { useTranslation } from "react-i18next";
import { directorModules, directorProductionSchema, type DirectorProduction } from "@basketikun/canvas-agent/drama/production-contract";
import { backendMediaUrl, type EpisodeProduction, type ProductionBatch, type ProductionReadiness } from "@/services/backend-api";
import { useProductionFollowStore } from "@/stores/use-production-follow-store";

export type DirectorWorkspace = "overview" | "story" | "assets" | "shots" | "production" | "advanced";
type CanvasNodeOption = { id: string; title?: string; type?: string; metadata?: Record<string, unknown> };
type LegacySource = { source: "fullPlot" | "script.md" | "storyboard.md"; text: string; sha256?: string };
type ProductionVersion = { version: number; stage: string; createdAt: string };
export type AssetReview = { assetId: string; version: number; sourceHash: string; nodeId: string; storageKey: string; sha256: string; verdict: "approved" | "rejected"; evidence: string };
type DirectorDecision = NonNullable<DirectorProduction["workflow"]["pendingDecisions"]>[number];
const objectWorkspaces: Array<{ key: Exclude<DirectorWorkspace, "overview" | "advanced">; modules: Array<(typeof directorModules)[number]>; targetKinds: Array<"asset" | "keyframe" | "segment"> }> = [
  { key: "story", modules: ["story"], targetKinds: [] },
  { key: "assets", modules: ["assets"], targetKinds: ["asset", "keyframe"] },
  { key: "shots", modules: ["shots", "performance", "effects"], targetKinds: [] },
  { key: "production", modules: ["model", "continuity"], targetKinds: ["segment"] },
];

function Image({ src, alt, className }: { src: string; alt: string; className?: string }) {
  if (alt.startsWith("<Video")) return <video className="max-h-24 max-w-48 rounded object-contain" controls preload="metadata" src={src} aria-label={alt} />;
  if (alt.startsWith("<Audio")) return <audio className="max-w-64" controls preload="metadata" src={src} aria-label={alt} />;
  return <AntdImage preview={false} className={className} src={src} alt={alt} />;
}

function textOf(value: unknown) {
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function proseOf(value: unknown) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    return String(record.description || record.action || record.summary || JSON.stringify(value, null, 2));
  }
  return textOf(value);
}

function patchProse(value: unknown, text: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>), description: text }
    : text;
}

function SourceField({ value, draftValue, onDraftChange, multiline, rows = 3, numeric, placeholder, disabled, onCommit }: {
  value: unknown; draftValue?: string; onDraftChange?: (value: string | undefined) => void; multiline?: boolean; rows?: number; numeric?: boolean; placeholder?: string; disabled?: boolean; onCommit: (value: unknown) => Promise<boolean | void> | boolean | void;
}) {
  const source = textOf(value);
  const [draft, setDraft] = useState(draftValue ?? source);
  useEffect(() => setDraft(draftValue ?? source), [source, draftValue]);
  const save = async () => {
    if (draft === source) { if (draftValue !== undefined) onDraftChange?.(undefined); return; }
    if (numeric) {
      const parsed = Number(draft);
      if (!Number.isFinite(parsed)) return;
      if (await onCommit(parsed) !== false) onDraftChange?.(undefined);
    } else if (await onCommit(draft) !== false) onDraftChange?.(undefined);
  };
  return multiline
    ? <Input.TextArea value={draft} autoSize={{ minRows: rows, maxRows: 12 }} disabled={disabled} placeholder={placeholder} onChange={event => { setDraft(event.target.value); onDraftChange?.(event.target.value); }} onBlur={() => void save()} />
    : <Input value={draft} disabled={disabled} placeholder={placeholder} onChange={event => { setDraft(event.target.value); onDraftChange?.(event.target.value); }} onBlur={() => void save()} />;
}

function BoundaryCard({ from, to, boundary, draftValue, onDraftChange, disabled, onSave }: {
  from: string; to: string; boundary?: DirectorProduction["boundaries"][number]; draftValue?: string; onDraftChange: (value: string | undefined) => void; disabled: boolean; onSave: (next: DirectorProduction["boundaries"][number]) => Promise<boolean | void> | boolean | void;
}) {
  const { t } = useTranslation();
  const parseDraft = (value?: string) => {
    if (!value) return undefined;
    try { return JSON.parse(value) as Pick<DirectorProduction["boundaries"][number], "tailFrame" | "motionContext" | "reason">; }
    catch { return undefined; }
  };
  const savedDraft = parseDraft(draftValue);
  const [tailFrame, setTailFrame] = useState(savedDraft?.tailFrame ?? boundary?.tailFrame ?? false);
  const [motionContext, setMotionContext] = useState(savedDraft?.motionContext ?? boundary?.motionContext ?? false);
  const [reason, setReason] = useState(savedDraft?.reason ?? boundary?.reason ?? "");
  useEffect(() => {
    const next = parseDraft(draftValue);
    setTailFrame(next?.tailFrame ?? boundary?.tailFrame ?? false);
    setMotionContext(next?.motionContext ?? boundary?.motionContext ?? false);
    setReason(next?.reason ?? boundary?.reason ?? "");
  }, [draftValue, boundary?.from, boundary?.to, boundary?.tailFrame, boundary?.motionContext, boundary?.reason]);
  const persist = (next: { tailFrame: boolean; motionContext: boolean; reason: string }) => onDraftChange(JSON.stringify(next));
  const changed = !boundary || boundary.tailFrame !== tailFrame || boundary.motionContext !== motionContext || boundary.reason !== reason;
  return <article className="rounded-xl border border-border bg-card p-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div><p className="text-xs uppercase tracking-wide text-muted-foreground">{t("director.workspace.continuityBoundary")}</p><h3 className="mt-1 font-semibold">{from} <ArrowRight className="mx-1 inline size-3" /> {to}</h3></div>
      {!boundary && <Tag color="orange">{t("director.workspace.undecided")}</Tag>}
    </div>
    <div className="mt-3 grid gap-3 sm:grid-cols-2">
      <label className="flex items-center justify-between gap-3 rounded-lg border border-border p-3 text-sm"><span>{t("director.workspace.tailFrame")}</span><Switch checked={tailFrame} disabled={disabled} onChange={value => { setTailFrame(value); persist({ tailFrame: value, motionContext, reason }); }} /></label>
      <label className="flex items-center justify-between gap-3 rounded-lg border border-border p-3 text-sm"><span>{t("director.workspace.motionContext")}</span><Switch checked={motionContext} disabled={disabled} onChange={value => { setMotionContext(value); persist({ tailFrame, motionContext: value, reason }); }} /></label>
    </div>
    <Input.TextArea className="mt-3" value={reason} autoSize={{ minRows: 2, maxRows: 4 }} disabled={disabled} placeholder={t("director.workspace.continuityReason")} onChange={event => { setReason(event.target.value); persist({ tailFrame, motionContext, reason: event.target.value }); }} />
    {motionContext && <p className="mt-2 text-xs text-muted-foreground">{t("director.workspace.motionGroupHint", { from, to })}</p>}
    <Button className="mt-3" size="small" icon={<Check className="size-3" />} disabled={disabled || !reason.trim() || !changed} onClick={async () => { if (await onSave({ from, to, tailFrame, motionContext, reason: reason.trim() }) !== false) onDraftChange(undefined); }}>{t("director.workspace.saveBoundary")}</Button>
  </article>;
}

function SegmentGroupEditor({ segment, shots, segments, fps, draftValue, onDraftChange, disabled, onSave }: {
  segment: Record<string, any>; shots: Array<Record<string, any>>; segments: Array<Record<string, any>>; fps: number; draftValue?: string; onDraftChange: (value: string | undefined) => void; disabled: boolean;
  onSave: (segmentId: string, shotIds: string[], removeSegmentIds: string[]) => Promise<boolean | void> | boolean | void;
}) {
  const { t } = useTranslation();
  const { message, modal } = App.useApp();
  const segmentId = String(segment.id || "");
  const parseSelected = (value?: string) => {
    if (!value) return undefined;
    try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed.map(String) : undefined; }
    catch { return undefined; }
  };
  const [selected, setSelected] = useState<string[]>(parseSelected(draftValue) || (Array.isArray(segment.shot_ids) ? segment.shot_ids.map(String) : []));
  useEffect(() => setSelected(parseSelected(draftValue) || (Array.isArray(segment.shot_ids) ? segment.shot_ids.map(String) : [])), [segmentId, draftValue, JSON.stringify(segment.shot_ids || [])]);
  const save = () => {
    const chosen = shots.filter(shot => selected.includes(String(shot.id || "")));
    if (!segmentId || chosen.length !== selected.length || !chosen.length) return message.error(t("director.workspace.segmentEdit.needsShots"));
    const positions = chosen.map(shot => shots.findIndex(item => String(item.id || "") === String(shot.id || "")));
    if (positions.some((position, index) => index > 0 && position !== positions[index - 1] + 1)) return message.error(t("director.workspace.segmentEdit.adjacentOnly"));
    if (chosen.some((shot, index) => index > 0 && Number(shot.start_frame) !== Number(chosen[index - 1].end_frame))) return message.error(t("director.workspace.segmentEdit.frameGap"));
    const duration = (Number(chosen[chosen.length - 1].end_frame) - Number(chosen[0].start_frame)) / fps;
    if (!Number.isFinite(duration) || duration < 4 || duration > 15) return message.error(t("director.workspace.segmentEdit.window", { duration }));
    const removeSegmentIds = segments.filter(item => String(item.id || "") !== segmentId && Array.isArray(item.shot_ids) && item.shot_ids.some((id: string) => selected.includes(String(id)))).map(item => String(item.id || ""));
    const partialRemoval = removeSegmentIds.find(id => {
      const group = segments.find(item => String(item.id || "") === id)!;
      return group.shot_ids.some((shotId: string) => !selected.includes(String(shotId)));
    });
    if (partialRemoval) return message.error(t("director.workspace.segmentEdit.mergeWhole", { id: partialRemoval }));
    const apply = async () => {
      if (await onSave(segmentId, chosen.map(item => String(item.id)), removeSegmentIds) !== false) onDraftChange(undefined);
    };
    if (removeSegmentIds.length) modal.confirm({ title: t("director.workspace.segmentEdit.mergeTitle"), content: t("director.workspace.segmentEdit.mergeDescription", { ids: removeSegmentIds.join(", ") }), onOk: apply });
    else apply();
  };
  return <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
    <label className="grid gap-1 text-xs text-muted-foreground"><span>{t("director.workspace.segmentEdit.shots")}</span><Select mode="multiple" value={selected} disabled={disabled} options={shots.map((shot, index) => ({ value: String(shot.id || ""), label: `${index + 1}. ${String(shot.title || shot.id || "")}` }))} onChange={value => { setSelected(value); onDraftChange(JSON.stringify(value)); }} /></label>
    <Button size="small" disabled={disabled || JSON.stringify(selected) === JSON.stringify(segment.shot_ids || [])} onClick={save}>{t("director.workspace.segmentEdit.save")}</Button>
  </div>;
}

export function DirectorPanel({
  workspace, director, production, readiness, run, batches, canvasNodes, legacy, versions, busy, canvasId,
  onBrief, onPatch, onRegroup, onWorkflow, onSourceDraftChange, sourceDrafts, onBindAsset, onBoundary, onReview, onPublish, onReplace, onAskDirector, onAnswerDecision, onNavigate, onStart, onPause, onResume, onRestore, onRefresh, onExport, exporting, runStartPending, activeTargetIds,
}: {
  workspace: DirectorWorkspace; director?: DirectorProduction; production: EpisodeProduction; readiness?: ProductionReadiness; run?: ProductionBatch | null;
  batches: ProductionBatch[]; canvasNodes: CanvasNodeOption[]; legacy: LegacySource[]; versions: ProductionVersion[]; busy: boolean; canvasId: string;
  onBrief: (brief: string) => Promise<void> | void;
  onPatch: (entity: "style" | "scene" | "asset" | "shot" | "segment", id: string | undefined, patch: Record<string, unknown>) => Promise<boolean> | void;
  onRegroup: (segmentId: string, shotIds: string[], removeSegmentIds: string[]) => Promise<boolean> | void;
  sourceDrafts: Record<string, string>;
  onSourceDraftChange: (key: string, value: string | undefined) => void;
  onWorkflow: (patch: Partial<DirectorProduction["workflow"]>) => void;
  onBindAsset: (assetId: string, nodeId: string) => void;
  onBoundary: (boundary: DirectorProduction["boundaries"][number]) => void;
  onReview: (review: AssetReview) => void;
  onPublish: () => void;
  onReplace: (value: DirectorProduction) => void;
  onAskDirector: (scope: { workspace: DirectorWorkspace; targetId?: string; instruction?: string; brief?: string }) => void;
  onAnswerDecision: (decisionId: string, answer: string) => Promise<boolean> | boolean;
  onNavigate: (workspace: DirectorWorkspace, target?: { kind: string; id: string }) => void;
  onStart: (targetIds: string[], scope?: "selected" | "all_ready") => void;
  onPause: (runId: string) => void;
  onResume: (runId: string) => void;
  onRestore: (version: number) => void;
  onRefresh: () => void;
  onExport: (includeGeneratedMedia: boolean) => Promise<void>;
  exporting: boolean;
  runStartPending: boolean;
  activeTargetIds: string[];
}) {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const [briefDraft, setBriefDraft] = useState("");
  const [json, setJson] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [evidence, setEvidence] = useState<Record<string, string>>({});
  const [decisionReplies, setDecisionReplies] = useState<Record<string, string>>({});
  const [viewedMedia, setViewedMedia] = useState<Record<string, boolean>>({});
  const [mediaPreview, setMediaPreview] = useState<{ assetId: string; title: string; storageKey: string; sha256: string } | null>(null);
  const [includeGeneratedMedia, setIncludeGeneratedMedia] = useState(false);
  const d = director;
  const source = d?.source || {};
  const scriptScenes = Array.isArray(source.script_scenes) ? source.script_scenes.map(value => value && typeof value === "object" ? value as Record<string, any> : {}) : [];
  const assetPlan = Array.isArray(source.asset_plan) ? source.asset_plan.map(value => value && typeof value === "object" ? value as Record<string, any> : {}) : [];
  const sourceShots = Array.isArray(source.shots) ? source.shots.map(value => value && typeof value === "object" ? value as Record<string, any> : {}) : [];
  const segments = Array.isArray(source.segments) ? source.segments.map(value => value && typeof value === "object" ? value as Record<string, any> : {}) : [];
  const storyFacts = Object.fromEntries(Object.entries(source).filter(([key]) => /story|character|relationship|knowledge|foreshadow|ledger|timeline/i.test(key) && key !== "script_scenes"));
  const spatialFacts = Object.fromEntries(Object.entries(source).filter(([key]) => /scene_registry|scene_art|spatial|location_map/i.test(key)));
  const timelineStart = sourceShots.length ? Math.min(...sourceShots.map(shot => Number(shot.start_frame) || 0)) : 0;
  const timelineEnd = sourceShots.length ? Math.max(...sourceShots.map(shot => Number(shot.end_frame) || 0)) : 0;
  const timelineSpan = Math.max(1, timelineEnd - timelineStart);
  const timelineWidth = Math.max(720, sourceShots.length * 128);
  const mode = d?.workflow.mediaProductionMode || "per_item";
  const delivery = d?.workflow.contentDeliveryMode || "auto_file_batch";
  const publishedDirector = production.published?.director;
  useEffect(() => setBriefDraft(String(source.brief || "")), [source.brief]);
  useEffect(() => {
    const reason = json !== null ? t("productionHub.follow.modalOpen")
      : mediaPreview ? t("productionHub.follow.modalOpen")
        : briefDraft !== String(source.brief || "") ? t("productionHub.follow.saveEditsFirst") : "";
    useProductionFollowStore.getState().setGuardReason("director-panel", reason);
    return () => useProductionFollowStore.getState().setGuardReason("director-panel", "");
  }, [json, mediaPreview, briefDraft, source.brief, t]);

  const readinessCounts = useMemo(() => {
    const items = readiness?.targets || [];
    return {
      ready: items.filter(item => item.status === "ready").length,
      blocked: items.filter(item => item.status === "blocked").length,
      review: items.filter(item => item.status === "needs_review").length,
      done: items.filter(item => item.status === "complete").length,
    };
  }, [readiness?.targets]);
  const presentation = readiness?.presentation;
  const presentationTarget = presentation?.targetId ? readiness?.targets.find(item => item.targetId === presentation.targetId && (!presentation.targetKind || item.kind === (presentation.targetKind === "frame" ? "keyframe" : presentation.targetKind))) : undefined;
  const presentationWorkspace = (presentation?.workspace || "overview") as DirectorWorkspace;
  const presentationFocus = presentation?.targetKind && presentation.targetId ? { kind: presentation.targetKind, id: presentation.targetId } : undefined;
  const presentationModule = d?.workflow.currentWork?.module || objectWorkspaces.find(item => item.key === presentationWorkspace)?.modules[0];
  const presentationTargetName = presentationTarget?.title || presentation?.targetId || "";
  const taskTitle = !d ? t("director.workspace.overview.startFromBrief")
    : presentation?.status === "needs_review" ? t("director.workspace.overview.reviewFocus", { target: presentationTargetName || t("director.workspace.overview.currentTarget") })
      : presentation?.status === "blocked" ? t("director.workspace.overview.blockedFocus", { target: presentationTargetName || presentation.reason || t("director.workspace.overview.currentTarget") })
        : presentation?.action === "produce" ? t("director.workspace.overview.produceFocus", { target: presentationTargetName || t("director.workspace.overview.currentTarget") })
          : presentation?.action === "deliver" ? t("director.workspace.overview.deliverFocus", { target: presentationTargetName || t("director.workspace.overview.currentTarget") })
            : presentation ? t("director.workspace.overview.continueFocus", { module: t(`director.workspace.moduleName.${presentationModule || "story"}`) })
              : readiness?.nextAction || t("director.workspace.noNextAction");
  const objectRows = objectWorkspaces.map(item => {
    const states = item.modules.map(module => d?.modules[module]).filter(Boolean);
    const targets = readiness?.targets.filter(target => item.targetKinds.includes(target.kind)) || [];
    const unresolved = states.flatMap(state => state?.unresolved || []);
    const current = presentationWorkspace === item.key;
    const done = states.length > 0 && states.every(state => state?.status === "committed");
    const blocked = states.some(state => state?.status === "blocked") || unresolved.length > 0;
    const status = current ? "current" : !d ? "waiting" : done ? "done" : blocked ? "blocked" : "working";
    const summary = !d ? t("director.workspace.overview.waitingBrief")
      : unresolved[0] || (targets.length ? t("director.workspace.overview.targetSummary", {
        done: targets.filter(target => target.status === "complete").length,
        total: targets.length,
        review: targets.filter(target => target.status === "needs_review").length,
        blocked: targets.filter(target => target.status === "blocked").length,
      }) : item.modules.map(module => `${t(`director.workspace.moduleName.${module}`)} · ${t(`director.workspace.moduleStatus.${d.modules[module]?.status || "planned"}`)}`).join(" / "));
    return { ...item, current, status, summary };
  });

  const imageNodes = canvasNodes.filter(node => node.type === "image" || (node.type === "config" && node.metadata?.generationMode === "image"));
  const mediaForAsset = (assetId: string, shotId?: string) => {
    const mapped = publishedDirector?.assets[assetId] || d?.assets[assetId];
    const frame = shotId ? production.published?.keyframes[shotId] || production.draft.keyframes[shotId] : undefined;
    const review = shotId ? production.published?.keyframeReviews[shotId] || production.draft.keyframeReviews[shotId] : undefined;
    const status = shotId
      ? review?.verdict === "approved" || review?.verdict === "auto-accepted" ? "approved" : review?.verdict === "rejected" || review?.verdict === "needs-redo" ? "rejected" : frame?.storageKey ? "generated" : mapped?.status || "planned"
      : mapped?.status || "planned";
    return { asset: mapped, nodeId: shotId ? frame?.nodeId || mapped?.nodeId || "" : mapped?.nodeId || "", storageKey: shotId ? frame?.storageKey || mapped?.storageKey || "" : mapped?.storageKey || "", sha256: mapped?.sha256 || "", status, evidence: mapped?.evidence || review?.evidence || "" };
  };
  const deliveredClips = (production.published?.clipGroups || []).flatMap(group => {
    const node = canvasNodes.find(item => item.id === group.nodeId);
    const nodeSegments = Array.isArray(node?.metadata?.segments) ? node.metadata!.segments.map(value => value && typeof value === "object" ? value as Record<string, unknown> : {}) : [];
    const segment = nodeSegments.find(item => String(item.id || "") === String(group.segmentId || ""));
    const storageKey = String(segment?.resultStorageKey || "");
    return storageKey ? [{ group, storageKey }] : [];
  });
  const assetTitle = (item: Record<string, any>) => String(item.asset_name || item.name || item.title || item.kind || item.asset_id || item.id || t("director.workspace.untitledAsset"));
  const assetIdOf = (item: Record<string, any>) => String(item.asset_id || item.id || "");
  const keyframeAssetIds = new Set(Object.values(d?.shotInputs || {}).map(input => input.keyframeAssetId).filter((id): id is string => Boolean(id)));
  const allAssetIds = [...new Set([...assetPlan.map(assetIdOf).filter(Boolean), ...Object.keys(d?.assets || {}), ...keyframeAssetIds])];

  const submitReview = async (assetId: string, nodeId: string, storageKey: string, providedHash: string, verdict: "approved" | "rejected") => {
    if (!publishedDirector || !production.publishedVersion) return;
    const note = evidence[assetId]?.trim() || (verdict === "approved" ? t("director.workspace.approvalEvidence") : "");
    if (!note) { setError(t("director.workspace.reviewReasonRequired")); return; }
    try {
      let sha256 = providedHash;
      if (!sha256) {
        const response = await fetch(backendMediaUrl(storageKey));
        if (!response.ok) throw new Error(t("director.workspace.mediaReadFailed"));
        const digest = await crypto.subtle.digest("SHA-256", await response.arrayBuffer());
        sha256 = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
      }
      await onReview({ assetId, version: production.publishedVersion, sourceHash: publishedDirector.sourceHash, nodeId, storageKey, sha256, verdict, evidence: note });
      setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };

  const renderAssetCard = (assetId: string, item?: Record<string, any>, keyframeShot?: string) => {
    const media = mediaForAsset(assetId, keyframeShot);
    const authoredCards = Array.isArray(source.asset_cards) ? source.asset_cards.map(value => value && typeof value === "object" ? value as Record<string, any> : {}) : [];
    const authoredCard = authoredCards.find(value => String(value.asset_id || value.id || "") === assetId);
    const dependencies = Array.isArray(item?.depends_on) ? item.depends_on.map((value: unknown) => typeof value === "string" ? value : String((value as Record<string, unknown>)?.asset_id || (value as Record<string, unknown>)?.id || "")).filter(Boolean) : [];
    const artifact = d?.artifacts.find(value => value.kind === "image" && value.targetId === assetId);
    const styleMother = String((source.style_lock as Record<string, unknown> | undefined)?.anchor_asset_id || "") === assetId || String(item?.role || item?.asset_type || "").toUpperCase() === "STYLE_MOTHER";
    const title = keyframeShot ? `${t("director.workspace.keyframeFor")} ${keyframeShot}` : assetTitle(item || { id: assetId });
    const viewedKey = `${assetId}:${media.sha256}:${media.storageKey}`;
    const canReview = Boolean(media.nodeId && media.storageKey && publishedDirector && production.publishedVersion && media.status === "generated" && viewedMedia[viewedKey]);
    return <article key={`${assetId}:${keyframeShot || "asset"}`} data-production-target={keyframeShot ? `frame:${keyframeShot}` : `asset:${assetId}`} className="min-w-0 rounded-xl border border-border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div><h3 className="font-semibold">{title}</h3><p className="mt-1 break-all text-xs text-muted-foreground">{assetId}</p></div>
        <div className="flex flex-wrap gap-1">{styleMother && <Tag color="purple">STYLE_MOTHER</Tag>}<Tag color={media.status === "approved" ? "green" : media.status === "generated" ? "blue" : media.status === "rejected" ? "red" : "default"}>{t(`director.workspace.assetStatus.${media.status}`)}</Tag></div>
      </div>
      {item && <div className="mt-3 grid gap-2">
        <label className="text-xs text-muted-foreground">{t("director.workspace.description")}</label>
        <SourceField value={proseOf(item.description || item.prompt || item.visual || "")} draftValue={sourceDrafts[`asset:${assetId}:${item.description !== undefined ? "description" : item.prompt !== undefined ? "prompt" : "visual"}`]} onDraftChange={value => onSourceDraftChange(`asset:${assetId}:${item.description !== undefined ? "description" : item.prompt !== undefined ? "prompt" : "visual"}`, value)} multiline rows={2} disabled={busy} onCommit={value => {
          const field = item.description !== undefined ? "description" : item.prompt !== undefined ? "prompt" : "visual";
          return onPatch("asset", assetId, { [field]: patchProse(item[field], value) });
        }} />
      </div>}
      {item && <div className="mt-3 grid gap-3 sm:grid-cols-2"><label className="grid gap-1 text-xs text-muted-foreground"><span>{t("director.workspace.assetVersion")}</span><SourceField value={item.version || item.asset_version || "v1"} draftValue={sourceDrafts[`asset:${assetId}:version`]} onDraftChange={value => onSourceDraftChange(`asset:${assetId}:version`, value)} disabled={busy} onCommit={value => onPatch("asset", assetId, { version: String(value) })} /></label><label className="grid gap-1 text-xs text-muted-foreground"><span>{t("director.workspace.assetDependencies")}</span><Select mode="multiple" value={dependencies} disabled={busy} options={assetPlan.filter(value => assetIdOf(value) !== assetId).map(value => ({ value: assetIdOf(value), label: assetTitle(value) }))} onChange={value => void onPatch("asset", assetId, { depends_on: value })} /></label></div>}
      {(item || authoredCard) && <details className="mt-3 rounded-lg border border-border p-3"><summary className="cursor-pointer text-xs font-medium">{t("director.workspace.assetContract")}</summary><pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs">{JSON.stringify({ plan: item, card: authoredCard }, null, 2)}</pre><Button className="mt-2" size="small" onClick={() => onAskDirector({ workspace: "assets", targetId: assetId, instruction: t("director.workspace.reviseAssetContract") })}>{t("director.workspace.reviseWithDirector")}</Button></details>}
      <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
        <label className="grid gap-1 text-xs text-muted-foreground"><span>{t("director.workspace.canvasBinding")}</span>
          <Select allowClear value={media.nodeId || undefined} disabled={busy || !imageNodes.length} placeholder={t("director.workspace.bindCanvasImage")} options={imageNodes.map(node => ({ value: node.id, label: node.title || node.id }))} onChange={nodeId => nodeId && onBindAsset(assetId, nodeId)} />
        </label>
        {media.nodeId && <span className="break-all text-xs text-muted-foreground">{media.nodeId}</span>}
      </div>
      {media.storageKey && <div className="mt-3 grid gap-3 sm:grid-cols-[180px_1fr]">
        <AntdImage preview={false} className="max-h-36 max-w-full rounded-lg object-contain" src={backendMediaUrl(media.storageKey)} alt={title} />
        <div className="min-w-0"><p className="text-sm font-medium">{t("director.workspace.realMedia")}</p><p className="mt-1 break-all text-xs text-muted-foreground">{media.storageKey}</p>{media.evidence && <p className="mt-2 text-sm">{media.evidence}</p>}<Button className="mt-2" size="small" onClick={() => setMediaPreview({ assetId, title, storageKey: media.storageKey, sha256: media.sha256 })}>{t("director.workspace.viewOriginal")}</Button></div>
      </div>}
      {media.status === "generated" && !viewedMedia[viewedKey] && <p className="mt-3 text-xs text-amber-600">{t("director.workspace.viewOriginalBeforeReview")}</p>}
      {canReview && <div className="mt-3 space-y-2 border-t border-border pt-3">
        <Input.TextArea value={evidence[assetId] ?? media.evidence} disabled={busy} autoSize={{ minRows: 1, maxRows: 3 }} placeholder={t("director.workspace.reviewReason")} onChange={event => setEvidence(current => ({ ...current, [assetId]: event.target.value }))} />
        <div className="flex flex-wrap gap-2"><Button size="small" type="primary" disabled={busy} onClick={() => void submitReview(assetId, media.nodeId, media.storageKey, media.sha256, "approved")}>{t("director.workspace.approve")}</Button><Button size="small" danger disabled={busy} onClick={() => void submitReview(assetId, media.nodeId, media.storageKey, media.sha256, "rejected")}>{t("director.workspace.returnAsset")}</Button></div>
      </div>}
      {artifact && <p className="mt-3 text-xs text-muted-foreground">{t("director.workspace.compiledStatus")}: {artifact.status}</p>}
    </article>;
  };

  const renderOverview = () => <div className="space-y-5">
    <section className="rounded-2xl border border-border bg-muted/40 p-4 sm:p-5" aria-label={t("director.workspace.overview.currentTask")}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0"><p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t("director.workspace.overview.currentTask")}</p><h2 className="mt-1 text-lg font-semibold sm:text-xl">{taskTitle}</h2>
          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground"><span>{t(`director.workspace.tab.${presentationWorkspace}`)}{presentationTargetName ? ` · ${presentationTargetName}` : ""}</span>{presentationModule && <span>{t("director.workspace.overview.owner", { module: t(`director.workspace.moduleName.${presentationModule}`) })}</span>}</div>
          {presentation?.reason && <p className="mt-2 text-sm text-muted-foreground">{presentation.reason}</p>}
        </div>
        {presentation?.status && <Tag color={presentation.status === "needs_review" ? "orange" : presentation.status === "blocked" ? "red" : presentation.status === "complete" ? "green" : undefined}>{t(`director.workspace.presentationStatus.${presentation.status}`)}</Tag>}
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button type="primary" disabled={busy || (!d && !briefDraft.trim())} onClick={() => {
          if (!d) { document.getElementById("director-current-brief")?.scrollIntoView({ block: "center", behavior: "smooth" }); return; }
          if (presentation?.status === "needs_review" || !["author", "compile"].includes(presentation?.action || "")) { onNavigate(presentationWorkspace, presentationFocus); return; }
          onAskDirector({ workspace: presentationWorkspace, targetId: presentation?.targetId, instruction: t("director.workspace.continueInstruction") });
        }}>{!d ? t("director.workspace.overview.startFromBriefAction") : presentation?.status === "needs_review" ? t("director.workspace.overview.viewAndReview") : ["author", "compile"].includes(presentation?.action || "") ? t("director.workspace.askDirector") : t("director.workspace.overview.openWorkspace")}</Button>
        {d && <Button onClick={() => onAskDirector({ workspace: presentationWorkspace, targetId: presentation?.targetId, instruction: presentation?.status === "needs_review" ? t("director.workspace.overview.reviseCurrentTask") : t("director.workspace.continueInstruction") })}>{presentation?.status === "needs_review" ? t("director.workspace.overview.askDirectorToRevise") : t("director.workspace.progressCurrent")}</Button>}
      </div>
    </section>
    {(d?.workflow.pendingDecisions || []).filter(decision => decision.status === "pending" || decision.workId === d?.workflow.currentWork?.workId).map((decision: DirectorDecision) => <article key={decision.id} className="rounded-xl border border-orange-300/60 bg-orange-50/50 p-4 dark:border-orange-800 dark:bg-orange-950/20">
      <p className="text-xs text-muted-foreground">{decision.module}{decision.targetId ? ` · ${decision.targetId}` : ""}</p><h3 className="mt-1 font-semibold">{decision.prompt}</h3>
      {decision.status === "answered" ? <div className="mt-3 flex flex-wrap items-center justify-between gap-2"><p className="text-sm">{t("director.workspace.decisionSaved", { answer: decision.answer || "" })}</p><Button size="small" type="primary" disabled={busy} onClick={() => void onAnswerDecision(decision.id, decision.answer || "")}>{t("director.workspace.continueDecision")}</Button></div> : <>
        <div className="mt-3 flex flex-wrap gap-2">{decision.choices.map(choice => <Button key={choice} size="small" disabled={busy} onClick={() => void onAnswerDecision(decision.id, choice)}>{choice}</Button>)}</div>
        {decision.allowFreeText && <div className="mt-3 flex gap-2"><Input value={decisionReplies[decision.id] || ""} disabled={busy} aria-label={t("director.workspace.decisionAnswer")} onChange={event => setDecisionReplies(current => ({ ...current, [decision.id]: event.target.value }))} /><Button size="small" disabled={busy || !decisionReplies[decision.id]?.trim()} onClick={() => void onAnswerDecision(decision.id, decisionReplies[decision.id].trim())}>{t("director.workspace.submitDecision")}</Button></div>}
      </>}
    </article>)}
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1.5fr)_minmax(280px,0.8fr)]">
      <section id="director-current-brief" className="rounded-2xl border border-border bg-card p-5">
      <div className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-xs uppercase tracking-wide text-muted-foreground">{t("director.workspace.currentBrief")}</p><h2 className="mt-1 text-xl font-semibold">{t("director.briefTitle")}</h2></div><div className="flex gap-2"><Tag color="blue">{t("director.workspace.revision", { revision: production.revision })}</Tag><Button size="small" onClick={onRefresh}>{t("director.workspace.refresh")}</Button></div></div>
        <Input.TextArea className="mt-4" value={briefDraft} disabled={busy} autoSize={{ minRows: 4, maxRows: 10 }} placeholder={t("director.briefPlaceholder")} onChange={event => setBriefDraft(event.target.value)} />
        <div className="mt-3 flex flex-wrap gap-2"><Button disabled={busy || briefDraft === String(source.brief || "")} onClick={() => void onBrief(briefDraft)}>{t("director.workspace.saveBrief")}</Button></div>
      </section>
      <section className="rounded-2xl border border-border bg-card p-5">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">{t("director.workspace.readiness")}</p><h2 className="mt-1 text-xl font-semibold">{readiness?.nextAction || t("director.workspace.noNextAction")}</h2>
        <div className="mt-4 grid grid-cols-2 gap-2">
          {([["ready", readinessCounts.ready], ["blocked", readinessCounts.blocked], ["review", readinessCounts.review], ["done", readinessCounts.done]] as const).map(([key, count]) => <div key={key} className="rounded-lg border border-border p-3"><p className="text-xs text-muted-foreground">{t(`director.workspace.readinessCount.${key}`)}</p><p className="mt-1 text-2xl font-semibold">{count}</p></div>)}
        </div>
      </section>
    </div>
    {readiness?.targets.some(item => item.status !== "complete") && <section className="space-y-2"><div className="flex items-center justify-between"><h2 className="font-semibold">{t("director.workspace.targetsNeedingWork")}</h2><Tag>{readiness.targets.length}</Tag></div>
      {readiness.targets.filter(item => item.status !== "complete").slice(0, 8).map(item => <article key={item.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card p-3"><div className="min-w-0"><p className="font-medium">{item.title}<Tag className="ml-2">{t(`director.workspace.targetKind.${item.kind}`)}</Tag></p><p className="mt-1 text-sm text-muted-foreground">{item.blockers[0] || item.notice || t(`director.workspace.targetStatus.${item.status}`)}</p></div><Button size="small" onClick={() => item.status === "needs_review" ? onNavigate("assets") : onAskDirector({ workspace: item.kind === "segment" || item.kind === "keyframe" ? "shots" : "assets", targetId: item.targetId })}>{item.status === "needs_review" ? t("director.workspace.reviewInAssets") : t("director.workspace.askDirector")}</Button></article>)}
    </section>}
    {readiness?.unresolved.length ? <Alert type="warning" showIcon message={t("director.workspace.openIssues")} description={readiness.unresolved.join("；")} /> : null}
    {d && <section className="rounded-2xl border border-border bg-card p-5"><div className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-xs uppercase tracking-wide text-muted-foreground">{t("director.workspace.internalModules")}</p><h2 className="mt-1 text-lg font-semibold">{t("director.workspace.moduleRoles")}</h2></div><span className="text-xs text-muted-foreground">{t("director.workspace.modulesNotGates")}</span></div><div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">{directorModules.map(module => <div key={module} className="rounded-lg border border-border p-3"><div className="flex items-center justify-between gap-2"><strong className="capitalize">{module}</strong><Tag color={d.modules[module]?.status === "committed" ? "green" : d.modules[module]?.status === "blocked" ? "red" : undefined}>{d.modules[module]?.status || "planned"}</Tag></div>{d.modules[module]?.unresolved.length ? <p className="mt-2 text-xs text-amber-600">{d.modules[module]?.unresolved[0]}</p> : null}</div>)}</div></section>}
  </div>;

  const renderStory = () => <div className="space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-xl font-semibold">{t("director.workspace.storyTitle")}</h2><p className="mt-1 text-sm text-muted-foreground">{t("director.workspace.storyHint")}</p></div><Button icon={<WandSparkles className="size-4" />} disabled={busy} onClick={() => onAskDirector({ workspace: "story" })}>{t("director.workspace.askDirector")}</Button></div>
    {!d ? <Alert type="info" message={t("director.workspace.storyStartsFromBrief")} /> : <>
      <article className="rounded-xl border border-border bg-card p-4"><label className="mb-2 block text-sm font-medium">{t("director.workspace.storyBrief")}</label><Input.TextArea value={briefDraft} disabled={busy} autoSize={{ minRows: 3, maxRows: 8 }} onChange={event => setBriefDraft(event.target.value)} onBlur={() => briefDraft !== String(source.brief || "") && onBrief(briefDraft)} /></article>
      {Object.keys(storyFacts).length > 0 && <details className="rounded-xl border border-border bg-card p-4"><summary className="cursor-pointer font-medium">{t("director.workspace.registeredStoryFacts")}</summary><pre className="mt-3 max-h-[32rem] overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/40 p-3 text-xs">{JSON.stringify(storyFacts, null, 2)}</pre><Button className="mt-2" size="small" onClick={() => onAskDirector({ workspace: "story", instruction: t("director.workspace.reviseStoryFacts") })}>{t("director.workspace.reviseWithDirector")}</Button></details>}
      {scriptScenes.length ? scriptScenes.map((scene, index) => {
        const id = String(scene.id || scene.scene_id || "");
        return <article key={`${id}:${index}`} className="rounded-xl border border-border bg-card p-4"><div className="mb-3 flex items-center justify-between gap-3"><div><p className="text-xs text-muted-foreground">{t("director.workspace.scene", { number: index + 1 })} · {id}</p><SourceField value={scene.scene_name || ""} draftValue={sourceDrafts[`scene:${id}:scene_name`]} onDraftChange={value => onSourceDraftChange(`scene:${id}:scene_name`, value)} disabled={busy} placeholder={t("director.workspace.sceneName")} onCommit={value => id ? onPatch("scene", id, { scene_name: value }) : false} /></div><Button size="small" onClick={() => onAskDirector({ workspace: "story", targetId: id, instruction: t("director.workspace.reviseScene") })}>{t("director.workspace.reviseWithDirector")}</Button></div><SourceField value={scene.text || ""} draftValue={sourceDrafts[`scene:${id}:text`]} onDraftChange={value => onSourceDraftChange(`scene:${id}:text`, value)} multiline rows={4} disabled={busy} placeholder={t("director.workspace.scriptText")} onCommit={value => id ? onPatch("scene", id, { text: value }) : false} /></article>;
      }) : <Alert type="info" message={t("director.workspace.storyNotDrafted")} description={t("director.workspace.storyNotDraftedHint")} />}
    </>}
  </div>;

  const renderAssets = () => <div className="space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-xl font-semibold">{t("director.workspace.assetsTitle")}</h2><p className="mt-1 text-sm text-muted-foreground">{t("director.workspace.assetsHint")}</p></div><Button icon={<WandSparkles className="size-4" />} disabled={busy} onClick={() => onAskDirector({ workspace: "assets" })}>{t("director.workspace.askDirector")}</Button></div>
    {error && <Alert type="error" showIcon message={error} />}
    {d && <section className="grid gap-3 rounded-xl border border-border bg-card p-4 md:grid-cols-2">
      <label className="grid gap-1 text-sm"><span className="font-medium">{t("director.workspace.styleMother")}</span><Select allowClear value={String((source.style_lock as Record<string, unknown> | undefined)?.anchor_asset_id || "") || undefined} disabled={busy} placeholder={t("director.workspace.chooseStyleMother")} options={assetPlan.filter(item => String(item.role || item.asset_type || "").toUpperCase() === "STYLE_MOTHER" || String(item.kind || "").toLowerCase() === "style").map(item => ({ value: assetIdOf(item), label: assetTitle(item) }))} onChange={value => void onPatch("style", undefined, { anchor_asset_id: value || "" })} /></label>
      <label className="grid gap-1 text-sm"><span className="font-medium">{t("director.workspace.stylePolicy")}</span><Select value={String(source.style_policy || "required")} disabled={busy} options={[{ value: "required", label: t("director.workspace.styleRequired") }, { value: "waived", label: t("director.workspace.styleWaived") }]} onChange={value => void onPatch("style", undefined, { style_policy: value })} /></label>
      {source.style_policy === "waived" && <label className="grid gap-1 text-sm md:col-span-2"><span>{t("director.workspace.styleWaiverReason")}</span><SourceField value={source.style_policy_reason || ""} draftValue={sourceDrafts["style:style_policy_reason"]} onDraftChange={value => onSourceDraftChange("style:style_policy_reason", value)} multiline rows={2} disabled={busy} onCommit={value => onPatch("style", undefined, { style_policy_reason: value })} /></label>}
      {Object.keys(spatialFacts).length > 0 && <details className="rounded-lg border border-border p-3 md:col-span-2"><summary className="cursor-pointer text-sm font-medium">{t("director.workspace.spatialFacts")}</summary><pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs">{JSON.stringify(spatialFacts, null, 2)}</pre><Button className="mt-2" size="small" onClick={() => onAskDirector({ workspace: "assets", instruction: t("director.workspace.reviseSpatialFacts") })}>{t("director.workspace.reviseWithDirector")}</Button></details>}
    </section>}
    {!d ? <Alert type="info" message={t("director.workspace.assetsNeedDirector")} /> : allAssetIds.length ? <div className="grid gap-3 xl:grid-cols-2">{allAssetIds.map(assetId => {
      const item = assetPlan.find(value => assetIdOf(value) === assetId);
      const shotId = Object.entries(d.shotInputs).find(([, input]) => input.keyframeAssetId === assetId)?.[0];
      return renderAssetCard(assetId, item, shotId);
    })}</div> : <Alert type="info" message={t("director.workspace.noAssets")} description={t("director.workspace.noAssetsHint")} />}
    <Modal open={Boolean(mediaPreview)} title={mediaPreview?.title} footer={null} width={960} onCancel={() => setMediaPreview(null)}>
      {mediaPreview && <img className="max-h-[72dvh] w-full object-contain" src={backendMediaUrl(mediaPreview.storageKey)} alt={mediaPreview.title} onLoad={() => setViewedMedia(current => ({ ...current, [`${mediaPreview.assetId}:${mediaPreview.sha256}:${mediaPreview.storageKey}`]: true }))} onError={() => setError(t("director.workspace.mediaReadFailed"))} />}
    </Modal>
  </div>;

  const renderShots = () => <div className="space-y-5">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-xl font-semibold">{t("director.workspace.shotsTitle")}</h2><p className="mt-1 text-sm text-muted-foreground">{t("director.workspace.shotsHint")}</p></div><Button icon={<WandSparkles className="size-4" />} disabled={busy} onClick={() => onAskDirector({ workspace: "shots" })}>{t("director.workspace.askDirector")}</Button></div>
    {sourceShots.length > 0 && <section className="rounded-xl border border-border bg-card p-4"><div className="mb-3 flex items-center justify-between gap-2"><h3 className="font-semibold">{t("director.workspace.timeline")}</h3><span className="text-xs text-muted-foreground">{t("director.workspace.timelineScale", { start: timelineStart, end: timelineEnd, fps: Number(source.fps_num || 24) / Number(source.fps_den || 1) })}</span></div><div className="overflow-x-auto"><div className="relative h-20" style={{ minWidth: timelineWidth }}>
      {sourceShots.map((shot, index) => { const id = String(shot.id || ""); const left = (Number(shot.start_frame || 0) - timelineStart) / timelineSpan * 100; const width = Math.max(.8, (Number(shot.end_frame || 0) - Number(shot.start_frame || 0)) / timelineSpan * 100); return <button key={id} type="button" title={`${index + 1}. ${String(shot.title || id)} · ${(Number(shot.end_frame || 0) - Number(shot.start_frame || 0)) / (Number(source.fps_num || 24) / Number(source.fps_den || 1))}s`} aria-label={`${index + 1}. ${String(shot.title || id)}`} className="absolute top-1 h-9 truncate rounded border border-sky-600/50 bg-sky-500/15 px-2 text-left text-xs hover:bg-sky-500/25" style={{ left: `${left}%`, width: `${width}%` }} onClick={() => document.querySelector(`[data-production-target="shot:${CSS.escape(id)}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" })}>{String(shot.title || id)}</button>; })}
      {segments.map(segment => { const shotIds = Array.isArray(segment.shot_ids) ? segment.shot_ids.map(String) : []; const members = sourceShots.filter(shot => shotIds.includes(String(shot.id || ""))); if (!members.length) return null; const left = (Number(members[0].start_frame || 0) - timelineStart) / timelineSpan * 100; const width = Math.max(.8, (Number(members[members.length - 1].end_frame || 0) - Number(members[0].start_frame || 0)) / timelineSpan * 100); return <div key={String(segment.id)} className="absolute bottom-1 h-6 truncate rounded-sm bg-orange-500/20 px-2 text-[10px]" style={{ left: `${left}%`, width: `${width}%` }}>{String(segment.id || "")}</div>; })}
    </div></div></section>}
    {sourceShots.length ? <div className="space-y-3">{sourceShots.map((shot, index) => {
      const id = String(shot.id || "");
      const input = d?.shotInputs[id];
      const segment = segments.find(item => Array.isArray(item.shot_ids) && item.shot_ids.map(String).includes(id));
      const extraFields = Object.fromEntries(Object.entries(shot).filter(([key]) => !["id", "scene_id", "title", "visual", "camera", "start_frame", "end_frame", "state_in", "state_out"].includes(key)));
      return <article key={`${id}:${index}`} data-production-target={`shot:${id}`} className="rounded-xl border border-border bg-card p-4">
        <div className="flex flex-wrap items-center justify-between gap-3"><div className="flex items-center gap-2"><span className="font-mono text-sm text-orange-500">{index + 1}</span><h3 className="font-semibold">{String(shot.title || id)}</h3><Tag>{id}</Tag></div><div className="flex items-center gap-2">{segment && <Tag color="blue">{t("director.workspace.segmentTag", { id: String(segment.id || "") })}</Tag>}<Button size="small" onClick={() => onAskDirector({ workspace: "shots", targetId: id, instruction: t("director.workspace.reviseShot") })}>{t("director.workspace.reviseWithDirector")}</Button></div></div>
        <div className="mt-3 grid gap-3 md:grid-cols-2"><label className="grid gap-1 text-xs text-muted-foreground"><span>{t("director.workspace.visual")}</span><SourceField value={proseOf(shot.visual)} draftValue={sourceDrafts[`shot:${id}:visual`]} onDraftChange={value => onSourceDraftChange(`shot:${id}:visual`, value)} multiline rows={3} disabled={busy} onCommit={value => onPatch("shot", id, { visual: patchProse(shot.visual, value) })} /></label><label className="grid gap-1 text-xs text-muted-foreground"><span>{t("director.workspace.camera")}</span><SourceField value={proseOf(shot.camera)} draftValue={sourceDrafts[`shot:${id}:camera`]} onDraftChange={value => onSourceDraftChange(`shot:${id}:camera`, value)} multiline rows={3} disabled={busy} onCommit={value => onPatch("shot", id, { camera: patchProse(shot.camera, value) })} /></label><label className="grid gap-1 text-xs text-muted-foreground"><span>{t("director.workspace.startFrame")}</span><SourceField value={shot.start_frame} draftValue={sourceDrafts[`shot:${id}:start_frame`]} onDraftChange={value => onSourceDraftChange(`shot:${id}:start_frame`, value)} numeric disabled={busy} onCommit={value => onPatch("shot", id, { start_frame: value })} /></label><label className="grid gap-1 text-xs text-muted-foreground"><span>{t("director.workspace.endFrame")}</span><SourceField value={shot.end_frame} draftValue={sourceDrafts[`shot:${id}:end_frame`]} onDraftChange={value => onSourceDraftChange(`shot:${id}:end_frame`, value)} numeric disabled={busy} onCommit={value => onPatch("shot", id, { end_frame: value })} /></label><label className="grid gap-1 text-xs text-muted-foreground"><span>{t("director.workspace.openingState")}</span><SourceField value={proseOf(shot.state_in)} draftValue={sourceDrafts[`shot:${id}:state_in`]} onDraftChange={value => onSourceDraftChange(`shot:${id}:state_in`, value)} multiline rows={2} disabled={busy} onCommit={value => onPatch("shot", id, { state_in: patchProse(shot.state_in, value) })} /></label><label className="grid gap-1 text-xs text-muted-foreground"><span>{t("director.workspace.endingState")}</span><SourceField value={proseOf(shot.state_out)} draftValue={sourceDrafts[`shot:${id}:state_out`]} onDraftChange={value => onSourceDraftChange(`shot:${id}:state_out`, value)} multiline rows={2} disabled={busy} onCommit={value => onPatch("shot", id, { state_out: patchProse(shot.state_out, value) })} /></label></div>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground"><Tag>{t("director.workspace.keyframePolicy", { policy: input?.keyframePolicy || "none" })}</Tag>{input?.assetIds?.map(assetId => <Tag key={assetId}>{assetId}</Tag>)}</div>
        {Object.keys(extraFields).length > 0 && <details className="mt-3 rounded-lg border border-border p-3"><summary className="cursor-pointer text-xs font-medium">{t("director.workspace.extendedShotFacts")}</summary><pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs">{JSON.stringify(extraFields, null, 2)}</pre><Button className="mt-2" size="small" onClick={() => onAskDirector({ workspace: "shots", targetId: id, instruction: t("director.workspace.reviseShot") })}>{t("director.workspace.reviseWithDirector")}</Button></details>}
      </article>;
    })}</div> : <Alert type="info" message={t("director.workspace.noShots")} description={t("director.workspace.noShotsHint")} />}
    <section className="space-y-3"><div><h3 className="font-semibold">{t("director.workspace.segmentsTitle")}</h3><p className="mt-1 text-sm text-muted-foreground">{t("director.workspace.segmentsHint")}</p></div>
      {segments.length ? segments.map((segment, index) => { const id = String(segment.id || index); const draftKey = `segment:${id}:shot_ids`; return <article key={id} className="rounded-xl border border-border bg-card p-4"><div className="flex flex-wrap items-center justify-between gap-2"><div><h4 className="font-semibold">{String(segment.id || t("director.workspace.untitledSegment"))}</h4><p className="mt-1 text-sm text-muted-foreground">{(segment.shot_ids || []).map(String).join(" → ") || t("director.workspace.noShotInSegment")}</p></div><Tag color="blue">{String(segment.generation_clip_duration || "—")}s</Tag></div><div className="mt-3 flex flex-wrap gap-2"><Tag>{String(segment.mode || "H3")}</Tag><Tag>{t("director.workspace.frameRange", { start: String(segment.start_frame ?? "—"), end: String(segment.end_frame ?? "—") })}</Tag></div><SegmentGroupEditor segment={segment} shots={sourceShots} segments={segments} fps={Number(source.fps_num || 24) / Number(source.fps_den || 1)} draftValue={sourceDrafts[draftKey]} onDraftChange={value => onSourceDraftChange(draftKey, value)} disabled={busy} onSave={onRegroup} /></article>; }) : <Alert type="info" message={t("director.workspace.noSegments")} />}
    </section>
    {segments.length > 0 && <section className="space-y-2"><h3 className="font-semibold">{t("director.workspace.segmentExecutionDetails")}</h3>{segments.map(segment => { const id = String(segment.id || ""); return <details key={`details:${id}`} className="rounded-lg border border-border bg-card p-3"><summary className="cursor-pointer text-sm">{id} · {t("director.workspace.segmentAudioReferences")}</summary><pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words text-xs">{JSON.stringify({ mode: segment.mode, mode_lock: segment.mode_lock, mode_selection_reason: segment.mode_selection_reason, audio: segment.audio, sound: segment.sound, overall_soundscape: segment.overall_soundscape, non_diegetic_music: segment.non_diegetic_music, references: segment.references, subjects: segment.subjects }, null, 2)}</pre></details>; })}</section>}
    {d && <section className="space-y-3"><div><h3 className="font-semibold">{t("director.workspace.continuityTitle")}</h3><p className="mt-1 text-sm text-muted-foreground">{t("director.workspace.continuityHint")}</p></div>{segments.slice(0, -1).map((segment, index) => {
      const from = String(segment.id || ""); const to = String(segments[index + 1].id || "");
      const draftKey = `boundary:${from}:${to}`;
      return <BoundaryCard key={from} from={from} to={to} boundary={d.boundaries.find(item => item.from === from && item.to === to)} draftValue={sourceDrafts[draftKey]} onDraftChange={value => onSourceDraftChange(draftKey, value)} disabled={busy} onSave={onBoundary} />;
    })}</section>}
  </div>;

  const renderProduction = () => <div className="space-y-5">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-xl font-semibold">{t("director.workspace.productionTitle")}</h2><p className="mt-1 text-sm text-muted-foreground">{t("director.workspace.productionHint")}</p></div><div className="flex flex-wrap items-center gap-2"><label className="flex items-center gap-2 text-xs text-muted-foreground"><Switch checked={includeGeneratedMedia} disabled={exporting} onChange={setIncludeGeneratedMedia} />{t("director.workspace.includeGeneratedMedia")}</label><Button size="small" loading={exporting} disabled={!d || exporting} onClick={() => void onExport(includeGeneratedMedia)}>{t("director.workspace.exportBundle")}</Button><Button size="small" disabled={busy || !d} onClick={() => onAskDirector({ workspace: "production", targetId: readiness?.targets.find(item => item.status === "blocked")?.targetId, instruction: t("director.workspace.validateCompileCurrent") })}>{t("director.workspace.validateCompile")}</Button><Button size="small" onClick={onRefresh}>{t("director.workspace.refresh")}</Button><Button type="primary" disabled={busy || !d} onClick={onPublish}>{t("drama.production.directorPublish")}</Button></div></div>
    {d && <section className="grid gap-3 rounded-2xl border border-border bg-card p-4 md:grid-cols-2"><label className="grid gap-1 text-sm"><span className="font-medium">{t("director.workspace.contentDelivery")}</span><Select value={delivery} disabled={busy} options={[{ value: "auto_file_batch", label: t("director.workspace.autoFileBatch") }, { value: "interactive_segment", label: t("director.workspace.interactiveSegment") }]} onChange={value => onWorkflow({ contentDeliveryMode: value })} /></label><label className="grid gap-1 text-sm"><span className="font-medium">{t("director.workspace.mediaProduction")}</span><Select value={mode} disabled={busy} options={[{ value: "prompt_only", label: t("director.workspace.promptOnly") }, { value: "per_item", label: t("director.workspace.perItem") }, { value: "automatic", label: t("director.workspace.automatic") }]} onChange={value => onWorkflow({ mediaProductionMode: value })} /></label><p className="text-xs text-muted-foreground md:col-span-2">{t("director.workspace.settingsNextRun")}</p></section>}
    {run && <section className="rounded-2xl border border-border bg-card p-4"><div className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-xs uppercase tracking-wide text-muted-foreground">{t("director.workspace.activeRun")}</p><h3 className="mt-1 font-semibold">{run.status} · {run.runId}</h3></div><div className="flex gap-2">{["pending", "running"].includes(run.status) && <Button size="small" icon={<Pause className="size-3" />} onClick={() => onPause(run.runId)}>{t("director.workspace.pause")}</Button>}{["paused", "awaiting_review"].includes(run.status) && <Button size="small" type="primary" icon={<Play className="size-3" />} onClick={() => onResume(run.runId)}>{t("director.workspace.resume")}</Button>}</div></div><p className="mt-2 text-sm text-muted-foreground">{t("director.workspace.runScope", { version: run.version, targets: run.targets.join(", ") })}</p>{run.error && <Alert className="mt-3" type={run.status === "failed" ? "error" : "warning"} showIcon message={run.error} />}{run.submitted.length > 0 && <div className="mt-3 flex flex-wrap gap-2">{run.submitted.map((item, index) => <Tag key={`${item.taskId}:${index}`}>{item.kind} · {item.id} · task {item.taskId}</Tag>)}</div>}</section>}
    {deliveredClips.length > 0 && <section className="space-y-3"><div><h3 className="font-semibold">{t("director.workspace.deliveredVideos")}</h3><p className="mt-1 text-xs text-muted-foreground">{t("director.workspace.technicalCloseout")}</p></div><div className="grid gap-3 md:grid-cols-2">{deliveredClips.map(({ group, storageKey }) => <article key={`${group.id}:${storageKey}`} className="rounded-xl border border-border bg-card p-3"><video className="w-full rounded-lg bg-black" controls preload="metadata" src={backendMediaUrl(storageKey)} /><p className="mt-2 text-sm font-medium">{group.id}</p><p className="mt-1 break-all text-xs text-muted-foreground">{storageKey}</p></article>)}</div></section>}
    {mode === "automatic" && <Button icon={<Play className="size-4" />} disabled={busy || runStartPending || !readiness?.targets.some(item => item.status === "ready" && !activeTargetIds.includes(item.id))} onClick={() => onStart((readiness?.targets || []).filter(item => item.status === "ready" && !activeTargetIds.includes(item.id)).map(item => item.id), "all_ready")}>{t("director.workspace.startAutomatic")}</Button>}
    {mode === "prompt_only" && <Alert type="info" showIcon message={t("director.workspace.promptOnlyHint")} />}
    {readiness?.targets.length ? <section className="space-y-2"><h3 className="font-semibold">{t("director.workspace.productionTargets")}</h3>{readiness.targets.map(target => <article key={target.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card p-3"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><strong>{target.title}</strong><Tag>{t(`director.workspace.targetKind.${target.kind}`)}</Tag><Tag color={target.status === "ready" ? "green" : target.status === "blocked" ? "red" : target.status === "needs_review" ? "orange" : "default"}>{t(`director.workspace.targetStatus.${target.status}`)}</Tag></div>{target.blockers.length > 0 && <p className="mt-1 text-sm text-amber-600">{target.blockers.join("；")}</p>}{target.notice && <p className="mt-1 text-xs text-muted-foreground">{target.notice}</p>}{activeTargetIds.includes(target.id) && <p className="mt-1 text-xs text-amber-600">{t("director.workspace.runTargetActiveInline")}</p>}</div>{target.status === "ready" && mode !== "prompt_only" && mode !== "automatic" && <Button size="small" disabled={busy || runStartPending || activeTargetIds.includes(target.id)} onClick={() => onStart([target.id])}>{target.kind === "segment" ? t("director.workspace.generateClip") : t("director.workspace.generateItem")}</Button>}</article>)}</section> : <Alert type="info" message={readiness?.nextAction || t("director.workspace.noReadiness")} />}
    {d && <section className="space-y-2"><h3 className="font-semibold">{t("director.workspace.completePrompts")}</h3>{d.artifacts.map(artifact => <details key={artifact.id} className="rounded-xl border border-border bg-card p-4"><summary className="cursor-pointer font-medium">{artifact.targetId} · {artifact.kind} · {artifact.status}</summary><div className="mt-3 space-y-3"><p className="text-xs text-muted-foreground">{t("director.workspace.promptRevision", { sourceHash: artifact.sourceHash, promptHash: artifact.sha256 })}</p><pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/40 p-3 text-sm">{artifact.prompt}</pre>{artifact.references.length > 0 && <div className="space-y-2"><p className="text-sm font-medium">{t("director.workspace.actualReferences")}</p>{artifact.references.map(ref => <div key={`${artifact.id}:${ref.label}:${ref.storageKey}`} className="flex flex-wrap items-center gap-2 rounded-lg border border-border p-2 text-xs"><Image className="max-h-16 max-w-20 rounded object-contain" src={backendMediaUrl(ref.storageKey)} alt={ref.label} /><span>{ref.label}</span><Tag>{ref.role}</Tag><span className="break-all text-muted-foreground">{ref.storageKey}</span></div>)}</div>}</div></details>)}</section>}
  </div>;

  const renderAdvanced = () => <div className="space-y-5">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-xl font-semibold">{t("director.workspace.advancedTitle")}</h2><p className="mt-1 text-sm text-muted-foreground">{t("director.workspace.advancedHint")}</p></div><details><summary className="cursor-pointer text-sm text-muted-foreground">{t("director.advanced")}</summary><Button className="mt-2" disabled={!d} onClick={() => { setJson(JSON.stringify(d || {}, null, 2)); setError(""); }}>{t("director.workspace.editJson")}</Button></details></div>
    {d && <section className="rounded-xl border border-border bg-card p-4"><h3 className="font-semibold">{t("director.workspace.engineVersion")}</h3><p className="mt-2 break-all text-sm text-muted-foreground">Acheng {d.engine.version} · {d.engine.commit} · {d.engine.patchVersion} · {d.engine.runtimeId}</p></section>}
    <section className="space-y-2"><h3 className="font-semibold">{t("director.workspace.history")}</h3>{versions.length ? versions.map(item => <article key={item.version} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-card p-3"><span>v{item.version} · {item.stage} · {new Date(item.createdAt).toLocaleString()}</span><Button size="small" icon={<RotateCcw className="size-3" />} disabled={busy} onClick={() => onRestore(item.version)}>{t("director.workspace.restore")}</Button></article>) : <p className="text-sm text-muted-foreground">{t("director.workspace.noHistory")}</p>}</section>
    {batches.length > 0 && <section className="space-y-2"><h3 className="font-semibold">{t("director.workspace.runHistory")}</h3>{batches.map(item => <article key={item.runId} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-card p-3"><div className="min-w-0"><p className="font-medium">{item.status} · {item.runId}</p><p className="break-all text-xs text-muted-foreground">{item.targets.join(", ")} · {item.submitted.length} {t("director.workspace.submittedTasks")}</p></div>{["paused", "awaiting_review"].includes(item.status) && <Button size="small" onClick={() => onResume(item.runId)}>{t("director.workspace.resume")}</Button>}</article>)}</section>}
    <section className="space-y-2"><h3 className="font-semibold">{t("director.workspace.legacyTitle")}</h3><p className="text-sm text-muted-foreground">{t("director.workspace.legacyHint")}</p>{legacy.length ? legacy.map(item => <details key={item.source} className="rounded-xl border border-border bg-card p-3"><summary className="cursor-pointer font-medium">{item.source} · {item.sha256?.slice(0, 12)}</summary><pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-words text-sm">{item.text}</pre><Button className="mt-3" size="small" disabled={busy} onClick={() => onAskDirector({ workspace: "advanced", instruction: `${t("director.workspace.adaptLegacy")}: ${item.source}\n\n${item.text}` })}>{t("director.workspace.adaptLegacy")}</Button></details>) : <p className="text-sm text-muted-foreground">{t("director.workspace.noLegacy")}</p>}</section>
    <Modal open={json !== null} width={920} title={t("director.workspace.editJson")} onCancel={() => setJson(null)} onOk={() => {
      try { onReplace(directorProductionSchema.parse(JSON.parse(json || "{}"))); setJson(null); setError(""); }
      catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    }} confirmLoading={busy}>
      {error && <Alert className="mb-3" type="error" message={error} />}
      <Input.TextArea rows={20} value={json || ""} onChange={event => setJson(event.target.value)} />
    </Modal>
  </div>;

  return <section className="space-y-4">
    {workspace === "overview" && renderOverview()}
    {workspace === "story" && renderStory()}
    {workspace === "assets" && renderAssets()}
    {workspace === "shots" && renderShots()}
    {workspace === "production" && renderProduction()}
    {workspace === "advanced" && renderAdvanced()}
  </section>;
}
