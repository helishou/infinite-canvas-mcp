import { ProductionInputDiff } from "./production-input-diff";
import { useEffect, useMemo, useState } from "react";
import { Alert, App, Button, Image as AntdImage, Input, Modal, Select, Switch, Tag } from "antd";
import { ArrowRight, ArrowLeft, Check, Pause, Play, RotateCcw, WandSparkles, Users, MapPin, Image as ImageIcon, Film, Pencil, BookOpen, Search, ChevronDown } from "lucide-react";
import { useTranslation } from "react-i18next";
import { directorModules, directorProductionSchema, type DirectorProduction } from "@basketikun/canvas-agent/drama/production-contract";
import { backendMediaUrl, type ProductionSceneAction, type BackendRuntimeTask, type EpisodeProduction, type ProductionBatch, type ProductionReadiness } from "@/services/backend-api";
import { groupScriptScenes, dialogueBody, readableText, humanName, records, formatSeconds, shotDisplayText } from "./director-display";
import { useProductionFollowStore } from "@/stores/use-production-follow-store";
import { saveAs } from "file-saver";
import { ContinuityPanel } from "./continuity-panel";
import { SceneProductionPanel } from "./scene-production-panel";
import { H3_STYLE_TEMPLATES } from "../../../../canvas-agent/src/plugins/minimax-h3/style-templates";

export type DirectorWorkspace = "overview" | "story" | "assets" | "shots" | "continuity" | "production" | "advanced";
type CanvasNodeOption = { id: string; title?: string; type?: string; metadata?: Record<string, unknown> };
type LegacySource = { source: "fullPlot" | "script.md" | "storyboard.md"; text: string; sha256?: string };
type ProductionVersion = { version: number; stage: string; createdAt: string };
export type AssetReview = { assetId: string; version: number; sourceHash: string; nodeId: string; storageKey: string; sha256: string; verdict: "approved" | "rejected"; evidence: string };
type DirectorDecision = NonNullable<DirectorProduction["workflow"]["pendingDecisions"]>[number];
const objectWorkspaces: Array<{ key: Exclude<DirectorWorkspace, "overview" | "advanced">; modules: Array<(typeof directorModules)[number]>; targetKinds: Array<"asset" | "keyframe" | "segment"> }> = [
  { key: "story", modules: ["story"], targetKinds: [] },
  { key: "assets", modules: ["assets"], targetKinds: ["asset", "keyframe"] },
  { key: "shots", modules: ["shots", "performance", "effects"], targetKinds: [] },
  { key: "continuity", modules: ["continuity"], targetKinds: ["segment"] },
  { key: "production", modules: ["model"], targetKinds: ["segment"] },
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
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return readableText(record);
  }
  return textOf(value);
}

function patchProse(value: unknown, text: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>), description: text }
    : text;
}

/** Read structured source without reducing objects to their description field. */
function SourceData({ value, names }: { value: unknown; names: Record<string, string> }) {
  const { t } = useTranslation();
  if (value === null || value === undefined) return <span>—</span>;
  if (Array.isArray(value)) return <div className="space-y-2">{value.map((item, index) => <div key={index}><SourceData value={item} names={names} /></div>)}</div>;
  if (typeof value === "object") return <dl className="space-y-2 border-l border-border pl-3">{Object.entries(value).map(([key, item]) => <div key={key} className="min-w-0"><dt className="text-xs text-muted-foreground">{t(`director.studio.sourceField.${key}`, { defaultValue: key })}</dt><dd className="mt-1 whitespace-pre-wrap break-words text-sm"><SourceData value={item} names={names} /></dd></div>)}</dl>;
  return <span className="whitespace-pre-wrap break-words">{typeof value === "boolean" ? t(value ? "director.studio.flagOn" : "director.studio.flagOff") : names[String(value)] || String(value)}</span>;
}

function SourceField({ value, draftValue, onDraftChange, multiline, rows = 3, numeric, placeholder, disabled, onCommit, commitOnBlur = true }: {
  value: unknown; draftValue?: string; onDraftChange?: (value: string | undefined) => void; multiline?: boolean; rows?: number; numeric?: boolean; placeholder?: string; disabled?: boolean; onCommit: (value: unknown) => Promise<boolean | void> | boolean | void;
  commitOnBlur?: boolean;
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
    ? <Input.TextArea value={draft} autoSize={{ minRows: rows, maxRows: 12 }} disabled={disabled} placeholder={placeholder} onChange={event => { setDraft(event.target.value); onDraftChange?.(event.target.value); }} onBlur={() => { if (commitOnBlur) void save(); }} />
    : <Input value={draft} disabled={disabled} placeholder={placeholder} onChange={event => { setDraft(event.target.value); onDraftChange?.(event.target.value); }} onBlur={() => { if (commitOnBlur) void save(); }} />;
}

function BoundaryCard({ from, to, fromLabel, toLabel, boundary, draftValue, onDraftChange, disabled, onSave }: {
  from: string; to: string; fromLabel?: string; toLabel?: string; boundary?: DirectorProduction["boundaries"][number]; draftValue?: string; onDraftChange: (value: string | undefined) => void; disabled: boolean; onSave: (next: DirectorProduction["boundaries"][number]) => Promise<boolean | void> | boolean | void;
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
      <div><p className="text-xs uppercase tracking-wide text-muted-foreground">{t("director.workspace.continuityBoundary")}</p><h3 className="mt-1 font-semibold">{fromLabel || from} <ArrowRight className="mx-1 inline size-3" /> {toLabel || to}</h3></div>
      {!boundary && <Tag color="orange">{t("director.workspace.undecided")}</Tag>}
    </div>
    <div className="mt-3 grid gap-3 sm:grid-cols-2">
      <label className="flex items-center justify-between gap-3 rounded-lg border border-border p-3 text-sm"><span>{t("director.workspace.tailFrame")}</span><Switch checked={tailFrame} disabled={disabled} onChange={value => { setTailFrame(value); persist({ tailFrame: value, motionContext, reason }); }} /></label>
      <label className="flex items-center justify-between gap-3 rounded-lg border border-border p-3 text-sm"><span>{t("director.workspace.motionContext")}</span><Switch checked={motionContext} disabled={disabled} onChange={value => { setMotionContext(value); persist({ tailFrame, motionContext: value, reason }); }} /></label>
    </div>
    <Input.TextArea className="mt-3" value={reason} autoSize={{ minRows: 2, maxRows: 4 }} disabled={disabled} placeholder={t("director.workspace.continuityReason")} onChange={event => { setReason(event.target.value); persist({ tailFrame, motionContext, reason: event.target.value }); }} />
    {motionContext && <p className="mt-2 text-xs text-muted-foreground">{t("director.workspace.motionGroupHint", { from: fromLabel || from, to: toLabel || to })}</p>}
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
    <label className="grid gap-1 text-xs text-muted-foreground"><span>{t("director.workspace.segmentEdit.shots")}</span><Select mode="multiple" value={selected} disabled={disabled} options={shots.map((shot, index) => ({ value: String(shot.id || ""), label: humanName(shot.title, String(shot.id), t("director.studio.shotNumber", { number: index + 1 })) }))} onChange={value => { setSelected(value); onDraftChange(JSON.stringify(value)); }} /></label>
    <Button size="small" disabled={disabled || JSON.stringify(selected) === JSON.stringify(segment.shot_ids || [])} onClick={save}>{t("director.workspace.segmentEdit.save")}</Button>
  </div>;
}

export function DirectorPanel({
  workspace, director, production, readiness, run, batches, runtimeTasks = [], canvasNodes, legacy, versions, busy, canvasId, canvasRole, focusTarget, embedded = false, continuityReport,
  briefDraft, onBriefDraftChange, onOpenSharedAsset, onPromoteExistingSharedAsset,
  compact = false, onSaveScript, generationSupported = true,
  onBrief, onPatch, onEditCanvasClip, onAdoptDirectorFields, onAdoptClipStyle, onRegroup, onWorkflow, onSettings, onSourceDraftChange, sourceDrafts, onBindAsset, onBoundary, onReview, onPublish, onReplace, onAskDirector, onRequestContinuityUpgrade, onAnswerDecision, onNavigate, onLocateTarget, onStart, onPause, onResume, onRestore, onRefresh, onSceneCommand, sceneCommandPending, onExport, exporting, runStartPending, activeTargetIds, onSaveContinuity, onPreviewContinuityUpgrade, onCheckContinuity, onContinuitySnapshot,
}: {
  workspace: DirectorWorkspace; director?: DirectorProduction; production: EpisodeProduction; readiness?: ProductionReadiness; run?: ProductionBatch | null;
  continuityReport?: import("@/services/backend-api").ProductionContinuity;
  focusTarget?: string;
  embedded?: boolean;
  briefDraft: string;
  onBriefDraftChange: (value: string) => void;
  compact?: boolean;
  generationSupported?: boolean;
  onSaveScript?: (ids: string[]) => Promise<boolean>;
  batches: ProductionBatch[]; canvasNodes: CanvasNodeOption[]; legacy: LegacySource[]; versions: ProductionVersion[]; busy: boolean; canvasId: string;
  canvasRole: "ordinary" | "episode" | "shared-assets" | "standalone" | "scene";
  onOpenSharedAsset: (assetId: string, title: string) => void;
  onPromoteExistingSharedAsset: (assetId: string, title: string) => void;
  runtimeTasks?: BackendRuntimeTask[];
  onBrief: (brief: string) => Promise<void> | void;
  onPatch: (entity: "style" | "scene" | "asset" | "shot" | "segment", id: string | undefined, patch: Record<string, unknown>) => Promise<boolean> | void;
  onEditCanvasClip?: (nodeId: string, segmentId: string, patch: Record<string, unknown>) => Promise<boolean>;
  onAdoptDirectorFields?: (targetId: string, nodeId: string, segmentId: string | undefined, fields: string[]) => Promise<boolean>;
  onAdoptClipStyle?: (targetId: string, styleTemplateId: string | null) => Promise<boolean>;
  onRegroup: (segmentId: string, shotIds: string[], removeSegmentIds: string[]) => Promise<boolean> | void;
  sourceDrafts: Record<string, string>;
  onSourceDraftChange: (key: string, value: string | undefined) => void;
  onWorkflow: (patch: Partial<DirectorProduction["workflow"]>) => void;
  onSettings: (patch: Partial<EpisodeProduction['draft']['settings']>) => void;
  onBindAsset: (assetId: string, nodeId: string) => void;
  onBoundary: (boundary: DirectorProduction["boundaries"][number]) => void;
  onSaveContinuity?: (ledger: Record<string, unknown>, upgradePreview?: Record<string, any>) => Promise<boolean>;
  onPreviewContinuityUpgrade?: (ledger: Record<string, unknown>, fromSourceHash: string) => Promise<Record<string, any>>;
  onCheckContinuity?: () => Promise<void>;
  onContinuitySnapshot?: (value: "draft" | "published") => void;
  onReview: (review: AssetReview) => Promise<boolean | void> | boolean | void;
  onPublish: () => void;
  onReplace: (value: DirectorProduction) => void;
  onAskDirector: (scope: { workspace: DirectorWorkspace; targetId?: string; instruction?: string; brief?: string; workId?: string }) => void;
  onRequestContinuityUpgrade?: (instruction: string, workId?: string) => Promise<{ id: string; threadId?: string } | undefined>;
  onAnswerDecision: (decisionId: string, answer: string) => Promise<boolean> | boolean;
  onNavigate: (workspace: DirectorWorkspace, target?: { kind: string; id: string }) => void;
  onLocateTarget?: (kind: string, id: string) => void;
  onStart: (targetIds: string[], scope?: "selected" | "all_ready") => void;
  onPause: (runId: string) => void;
  onResume: (runId: string) => void;
  onRestore: (version: number) => void;
  onRefresh: () => void;
  sceneCommandPending?: boolean;
  onSceneCommand: (action: ProductionSceneAction, revision: number) => Promise<unknown>;
  onExport: (includeGeneratedMedia: boolean) => Promise<void>;
  exporting: boolean;
  runStartPending: boolean;
  activeTargetIds: string[];
}) {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const [activeSceneKey, setActiveSceneKey] = useState('');
  const [editingScript, setEditingScript] = useState(false);
  const [assetFilter, setAssetFilter] = useState('all');
  const [assetSearch, setAssetSearch] = useState('');
  const [selectedReviewAssetId, setSelectedReviewAssetId] = useState('');
  const [selectedShot, setSelectedShot] = useState('');
  const [shotSearch, setShotSearch] = useState("");
  const [json, setJson] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [evidence, setEvidence] = useState<Record<string, string>>({});
  const [reviewingAssets, setReviewingAssets] = useState<Record<string, boolean>>({});
  const [decisionReplies, setDecisionReplies] = useState<Record<string, string>>({});
  const [mediaPreview, setMediaPreview] = useState<{ assetId: string; title: string; storageKey: string } | null>(null);
  const [includeGeneratedMedia, setIncludeGeneratedMedia] = useState(false);
  const d = director;
  const source = d?.source || {};
  const scriptScenes = Array.isArray(source.script_scenes) ? source.script_scenes.map(value => value && typeof value === "object" ? value as Record<string, any> : {}) : [];
  const assetPlan = Array.isArray(source.asset_plan) ? source.asset_plan.map(value => value && typeof value === "object" ? value as Record<string, any> : {}) : [];
  const sourceShots = Array.isArray(source.shots) ? source.shots.map(value => value && typeof value === "object" ? value as Record<string, any> : {}) : [];
  const displayedShots = embedded && focusTarget?.startsWith("shot:") ? sourceShots.filter(shot => String(shot.id) === focusTarget.slice(5)) : sourceShots;
  const segments = Array.isArray(source.segments) ? source.segments.map(value => value && typeof value === "object" ? value as Record<string, any> : {}) : [];
  const characters = records(source.character_registry);
  const locations = records(source.scene_registry);
  const story = source.story && typeof source.story === 'object' ? source.story as Record<string, any> : {};
  const sceneGroups = useMemo(() => groupScriptScenes(scriptScenes), [JSON.stringify(scriptScenes)]);
  const nameMap = Object.fromEntries([...characters, ...locations].map(item => [String(item.id || ''), String(item.name || item.scene_name || '')]).filter(([, name]) => name));
  const focusedId = focusTarget?.replace(/^[^:]+:/, '') || '';
  useEffect(() => {
    const focused = sceneGroups.find(group => group.key === focusedId || group.sceneId === focusedId || group.blocks.some(block => String(block.id) === focusedId));
    if (focused) setActiveSceneKey(focused.key);
    else if (!sceneGroups.some(group => group.key === activeSceneKey)) setActiveSceneKey(sceneGroups[0]?.key || '');
  }, [focusedId, JSON.stringify(sceneGroups.map(group => group.key))]);
  useEffect(() => { if (focusTarget?.startsWith('shot:')) setSelectedShot(focusedId); if (focusTarget?.startsWith('asset:') || focusTarget?.startsWith('frame:')) { setAssetFilter('all'); setAssetSearch(''); } }, [focusTarget]);
  const activeSceneIndex = Math.max(0, sceneGroups.findIndex(group => group.key === activeSceneKey));
  const activeScene = sceneGroups[activeSceneIndex];
  const fps = Number(source.fps_num || 24) / Number(source.fps_den || 1);
  const shotTitle = (id: string) => {
    const index = sourceShots.findIndex(shot => String(shot.id) === id);
    const shot = sourceShots[index];
    return humanName(shot?.title, id, index < 0 ? t('director.studio.unlinkedShot') : t('director.studio.shotNumber', { number: index + 1 }));
  };
  const segmentTitle = (id: string) => {
    const currentIndex = segments.findIndex(segment => String(segment.id) === id);
    const index = currentIndex >= 0 ? currentIndex : (production.published?.clipGroups || []).findIndex(group => group.id === id);
    return index < 0 ? t('director.studio.unlinkedClip') : t('director.studio.clipNumber', { number: index + 1 });
  };
  const sceneTitle = (group: ReturnType<typeof groupScriptScenes>[number], index: number) => humanName(group.title || nameMap[group.sceneId], group.sceneId, t('director.studio.sceneNumber', { number: index + 1 }));
  const frameForShot = (id: string) => {
    const key = d?.shotInputs[id]?.keyframeAssetId;
    return key ? d?.assets[key]?.storageKey || publishedDirector?.assets[key]?.storageKey : production.draft.keyframes[id]?.storageKey || production.published?.keyframes[id]?.storageKey;
  };
  const timelineStart = sourceShots.length ? Math.min(...sourceShots.map(shot => Number(shot.start_frame) || 0)) : 0;
  const timelineEnd = sourceShots.length ? Math.max(...sourceShots.map(shot => Number(shot.end_frame) || 0)) : 0;
  const mode = d?.workflow.mediaProductionMode || "per_item";
  const delivery = d?.workflow.contentDeliveryMode || "auto_file_batch";
  const publishedDirector = production.published?.director;
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
  const moduleViewStatus = (module: (typeof directorModules)[number]) => {
    const verified = String((readiness?.modules?.[module] as Record<string, unknown> | undefined)?.verifiedStatus || "");
    if (module === "continuity" && verified === "passed") return "continuity_passed";
    if (module === "continuity" && verified === "diagnosticOnly") return "diagnostic_only";
    if (verified === "passed") return "committed";
    if (verified === "partial" || verified === "evidence_incomplete" || verified === "diagnosticOnly") return "partial";
    if (verified === "blocked" || verified === "unresolved" || verified === "stale") return "blocked";
    return "unchecked";
  };
  const objectRows = objectWorkspaces.map(item => {
    const states = item.modules.map(module => d?.modules[module] ? { ...d.modules[module], status: moduleViewStatus(module) } : undefined).filter(Boolean);
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
      }) : item.modules.map(module => `${t(`director.workspace.moduleName.${module}`)} · ${t(`director.workspace.moduleStatus.${moduleViewStatus(module)}`)}`).join(" / "));
    return { ...item, current, status, summary };
  });

  const imageNodes = canvasNodes.filter(node => ["image", "character", "scene"].includes(String(node.type)) || (node.type === "config" && node.metadata?.generationMode === "image"));
  const mediaForAsset = (assetId: string, shotId?: string) => {
    const mapped = d?.assets[assetId] || publishedDirector?.assets[assetId];
    const frame = shotId ? production.draft.keyframes[shotId] || production.published?.keyframes[shotId] : undefined;
    const review = shotId ? production.draft.keyframeReviews[shotId] || production.published?.keyframeReviews[shotId] : undefined;
    const status = shotId
      ? review?.verdict === "approved" || review?.verdict === "auto-accepted" ? "approved" : review?.verdict === "rejected" || review?.verdict === "needs-redo" ? "rejected" : frame?.storageKey ? "generated" : mapped?.status || "planned"
      : mapped?.status || "planned";
    return { asset: mapped, nodeId: shotId ? frame?.nodeId || mapped?.nodeId || "" : mapped?.nodeId || "", storageKey: shotId ? frame?.storageKey || mapped?.storageKey || "" : mapped?.storageKey || "", sha256: mapped?.sha256 || "", status: mapped?.inputOutdated ? "generated" : status, inputOutdated: mapped?.inputOutdated, evidence: mapped?.evidence || review?.evidence || "" };
  };
  const deliveredClips = (production.published?.clipGroups || []).flatMap(group => {
    const node = canvasNodes.find(item => item.id === group.nodeId);
    const nodeSegments = Array.isArray(node?.metadata?.segments) ? node.metadata!.segments.map(value => value && typeof value === "object" ? value as Record<string, unknown> : {}) : [];
    const segment = nodeSegments.find(item => String(item.id || "") === String(group.segmentId || ""));
    const storageKey = String(segment?.resultStorageKey || "");
    return storageKey ? [{ group, storageKey }] : [];
  });
  const assetTitle = (item: Record<string, any>) => String(item.asset_name || item.name || item.title || item.asset_id || item.id || t("director.workspace.untitledAsset"));
  const assetIdOf = (item: Record<string, any>) => String(item.asset_id || item.id || "");
  const keyframeAssetIds = new Set(Object.values(d?.shotInputs || {}).map(input => input.keyframeAssetId).filter((id): id is string => Boolean(id)));
  const allAssetIds = [...new Set([...assetPlan.map(assetIdOf).filter(Boolean), ...Object.keys(d?.assets || {}), ...keyframeAssetIds])];

  const submitReview = async (assetId: string, nodeId: string, storageKey: string, providedHash: string, verdict: "approved" | "rejected") => {
    const currentAsset = d?.assets[assetId];
    if ((!publishedDirector || !production.publishedVersion) && !currentAsset?.generationTaskId) { setError(t("productionCanvas.reviewFailed")); return; }
    const note = evidence[assetId]?.trim() || (verdict === "approved" ? t("director.workspace.approvalEvidence") : "");
    if (!note) { setError(t("director.workspace.reviewReasonRequired")); return; }
    setReviewingAssets(current => ({ ...current, [assetId]: true }));
    setError("");
    try {
      let sha256 = providedHash;
      if (!sha256) {
        const response = await fetch(backendMediaUrl(storageKey));
        if (!response.ok) throw new Error(t("director.workspace.mediaReadFailed"));
        const digest = await crypto.subtle.digest("SHA-256", await response.arrayBuffer());
        sha256 = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
      }
      const saved = await onReview({ assetId, version: currentAsset?.generationTaskId ? 0 : production.publishedVersion, sourceHash: currentAsset?.generationTaskId ? d!.sourceHash : publishedDirector!.sourceHash, nodeId, storageKey, sha256, verdict, evidence: note });
      if (saved === false) {
        const failure = t("productionCanvas.reviewFailed");
        setError(failure); message.error(failure); return;
      }
      setError("");
      message.success(t(verdict === "approved" ? "director.workspace.reviewApproved" : "director.workspace.reviewReturned"));
    } catch (cause) {
      const failure = cause instanceof Error ? cause.message : String(cause);
      setError(failure); message.error(failure);
    } finally { setReviewingAssets(current => ({ ...current, [assetId]: false })); }
  };

  const assetName = (id: string) => {
    const item = assetPlan.find(item => assetIdOf(item) === id);
    const node = canvasNodes.find(node => node.id === d?.assets[id]?.nodeId);
    return humanName(item ? assetTitle(item) : undefined, id, humanName(node?.title || nameMap[id] || item?.purpose, id, allAssetIds.includes(id) ? t("director.studio.assetNumber", { number: allAssetIds.indexOf(id) + 1 }) : t("director.workspace.untitledAsset")));
  };
  const assetCategory = (id: string) => {
    if (keyframeAssetIds.has(id)) return "frames";
    const item = assetPlan.find(item => assetIdOf(item) === id);
    const type = String(item?.kind || item?.asset_type || item?.role || id).toLowerCase();
    if (/keyframe|storyboard|分镜|kf_/.test(type)) return "frames";
    if (/character|person|角色|char_/.test(type)) return "characters";
    if (/scene|environment|location|场景/.test(type)) return "locations";
    return "props";
  };
  const targetName = (kind: string, id: string, title?: string) => kind === "segment" ? segmentTitle(id) : kind === "keyframe" ? `${shotTitle(id)} · ${t("director.studio.keyframe")}` : humanName(title, id, assetName(id));
  const humanMessage = (text: string) => {
    const names = { ...nameMap, ...Object.fromEntries(allAssetIds.map(id => [id, assetName(id)])), ...Object.fromEntries(sourceShots.map(shot => [String(shot.id), shotTitle(String(shot.id))])), ...Object.fromEntries(segments.map(segment => [String(segment.id), segmentTitle(String(segment.id))])) };
    return Object.entries(names).sort(([a], [b]) => b.length - a.length).reduce((value, [id, name]) => id ? value.split(id).join(String(name)) : value, text);
  };
  const renderAssetCard = (assetId: string, item?: Record<string, any>, keyframeShot?: string) => {
    const media = mediaForAsset(assetId, keyframeShot);
    const dependencies = Array.isArray(item?.depends_on) ? item.depends_on.map((value: unknown) => typeof value === "string" ? value : String((value as Record<string, unknown>)?.asset_id || (value as Record<string, unknown>)?.id || "")).filter(Boolean) : [];
    const title = keyframeShot ? `${shotTitle(keyframeShot)} · ${t("director.studio.keyframe")}` : assetName(assetId);
    const publishedMedia = publishedDirector?.assets[assetId];
    const reviewTargetMatches = Boolean(media.nodeId && media.storageKey && media.status === "generated" && (media.asset?.generationTaskId || publishedMedia?.nodeId === media.nodeId && publishedMedia?.storageKey === media.storageKey && production.publishedVersion));
    const field = item?.description !== undefined || item?.prompt === undefined ? "description" : "prompt";
    return <article key={`${assetId}:${keyframeShot || "asset"}`} data-production-target={keyframeShot ? `frame:${keyframeShot}` : `asset:${assetId}`} className={compact ? "grid min-w-0 items-start gap-4 md:grid-cols-[280px_minmax(0,1fr)]" : "min-w-0 overflow-hidden rounded-xl border border-border bg-card"}>
      <button type="button" disabled={!media.storageKey} aria-label={t("director.studio.previewAsset", { title })} onClick={() => setMediaPreview({ assetId, title, storageKey: media.storageKey })} className={`flex w-full items-center justify-center overflow-hidden bg-muted/40 ${compact ? "h-[min(50dvh,420px)] rounded-lg" : "aspect-[4/3]"}`}>
        {media.storageKey && /\.(mp4|webm|mov)(?:$|\?)/i.test(media.storageKey) ? <Film className="size-10 text-muted-foreground" /> : media.storageKey ? <img className="h-full w-full object-contain" src={backendMediaUrl(media.storageKey)} alt={title} loading="lazy" /> : <div className="space-y-2 text-center text-muted-foreground"><ImageIcon className="mx-auto size-8 opacity-40" /><span className="text-xs">{t("director.studio.noImage")}</span></div>}
      </button>
      <div className={compact ? "min-w-0" : "p-4"}><div className="flex items-start justify-between gap-2"><div className="min-w-0">{!compact && <h3 className="text-base font-semibold">{title}</h3>}<p className="mt-1 text-xs text-muted-foreground">{t(`director.studio.filter.${assetCategory(assetId)}`)}</p></div><Tag color={media.status === "approved" ? "green" : media.status === "generated" ? "blue" : media.status === "rejected" ? "red" : "default"}>{t(`director.workspace.assetStatus.${media.status}`)}</Tag></div>
      {compact && item ? <label className="mt-4 grid gap-2 text-sm">{t("director.workspace.description")}<SourceField value={proseOf(item[field] ?? item.visual ?? item.purpose)} draftValue={sourceDrafts[`asset:${assetId}:${field}`] ?? sourceDrafts[`asset:${assetId}:visual`]} onDraftChange={value => onSourceDraftChange(`asset:${assetId}:${field}`, value)} multiline disabled={busy || Boolean(media.asset?.sharedSource)} onCommit={async value => { const saved = await onPatch("asset", assetId, { [field]: patchProse(item[field], value) }); if (saved !== false) onSourceDraftChange(`asset:${assetId}:visual`, undefined); return saved; }} /></label> : proseOf(item?.description || item?.prompt || item?.visual || item?.purpose) && <p className="mt-3 line-clamp-3 whitespace-pre-wrap text-sm leading-6 text-muted-foreground">{proseOf(item?.description || item?.prompt || item?.visual || item?.purpose)}</p>}
      {media.evidence && (!compact || media.status === "rejected") && <p className="mt-3 text-xs leading-5 text-muted-foreground">{media.evidence}</p>}
      {item && !keyframeShot && ["episode", "shared-assets"].includes(canvasRole) && <div className="mt-3 grid gap-2"><label className="grid gap-1 text-xs text-muted-foreground">{t("director.workspace.assetCanvasScope")}<Select value={String(item.canvas_scope || (media.asset?.sharedSource || canvasRole === "shared-assets" ? "shared" : "episode"))} disabled={busy || Boolean(media.asset?.sharedSource) || canvasRole === "shared-assets"} options={[{ value: "episode", label: t("director.workspace.assetCanvasScopeEpisode") }, { value: "shared", label: t("director.workspace.assetCanvasScopeShared") }]} onChange={value => void onPatch("asset", assetId, { canvas_scope: value })} /></label>{canvasRole === "episode" && String(item.canvas_scope || (media.asset?.sharedSource ? "shared" : "episode")) === "shared" && <div className="flex flex-wrap items-center gap-2"><p className="m-0 text-xs text-muted-foreground">{t("director.workspace.sharedAssetNeedsAdoption")}</p>{media.status === "approved" && !media.asset?.sharedSource && <Button size="small" disabled={busy} onClick={() => onPromoteExistingSharedAsset(assetId, title)}>{t("director.workspace.promoteExistingSharedAsset")}</Button>}<Button size="small" disabled={busy} onClick={() => onOpenSharedAsset(assetId, title)}>{t("director.workspace.openSharedCanvas")}</Button></div>}</div>}
      <div className="mt-4 flex flex-wrap gap-2">{media.storageKey && <Button size="small" onClick={() => setMediaPreview({ assetId, title, storageKey: media.storageKey })}>{t("director.workspace.viewOriginal")}</Button>}<Button icon={<WandSparkles className="size-3" />} size="small" onClick={() => onAskDirector({ workspace: "assets", targetId: assetId, instruction: t("director.workspace.reviseAssetContract") })}>{t("director.studio.collaborate")}</Button></div>
      <details className="mt-3 border-t border-border pt-3"><summary className="cursor-pointer text-xs text-muted-foreground">{t(compact ? "productionCanvas.objectDetails" : "director.studio.assetDetails")}</summary><div className="mt-3 space-y-3">
        {item && <>{!compact && <label className="grid gap-1 text-xs text-muted-foreground">{t("director.workspace.description")}<SourceField value={proseOf(item[field] ?? item.visual ?? item.purpose)} draftValue={sourceDrafts[`asset:${assetId}:${field}`] ?? sourceDrafts[`asset:${assetId}:visual`]} onDraftChange={value => onSourceDraftChange(`asset:${assetId}:${field}`, value)} multiline rows={3} disabled={busy} onCommit={async value => { const saved = await onPatch("asset", assetId, { [field]: patchProse(item[field], value) }); if (saved !== false) onSourceDraftChange(`asset:${assetId}:visual`, undefined); return saved; }} /></label>}<label className="grid gap-1 text-xs text-muted-foreground">{t("director.workspace.assetVersion")}<SourceField value={item.version || item.asset_version || "v1"} draftValue={sourceDrafts[`asset:${assetId}:version`]} onDraftChange={value => onSourceDraftChange(`asset:${assetId}:version`, value)} disabled={busy} onCommit={value => onPatch("asset", assetId, { version: String(value) })} /></label><label className="grid gap-1 text-xs text-muted-foreground">{t("director.workspace.assetDependencies")}<Select mode="multiple" value={dependencies} disabled={busy} options={assetPlan.filter(value => assetIdOf(value) !== assetId).map(value => ({ value: assetIdOf(value), label: assetName(assetIdOf(value)) }))} onChange={value => void onPatch("asset", assetId, { depends_on: value })} /></label></>}
        <label className="grid gap-1 text-xs text-muted-foreground">{t("director.studio.linkImage")}<Select value={media.nodeId || undefined} disabled={busy || !imageNodes.length} placeholder={t("director.workspace.bindCanvasImage")} options={imageNodes.map((node, index) => ({ value: node.id, label: humanName(node.title, node.id, t("director.studio.imageNumber", { number: index + 1 })) }))} onChange={nodeId => nodeId && onBindAsset(assetId, nodeId)} /></label>
      </div></details>
      {media.inputOutdated && <p className="mt-2 text-xs">{t("productionCanvas.outdatedMedia")}</p>}
      {reviewTargetMatches && <div className="mt-3 space-y-2 border-t border-border pt-3"><Input.TextArea value={evidence[assetId] ?? media.evidence} disabled={busy || Boolean(reviewingAssets[assetId])} autoSize={{ minRows: 1, maxRows: 3 }} placeholder={t("director.workspace.reviewReason")} onChange={event => setEvidence(current => ({ ...current, [assetId]: event.target.value }))} /><div className="flex flex-wrap gap-2"><Button size="small" type="primary" loading={Boolean(reviewingAssets[assetId])} disabled={busy || Boolean(reviewingAssets[assetId])} onClick={() => void submitReview(assetId, media.nodeId, media.storageKey, media.sha256, "approved")}>{t("director.workspace.approve")}</Button><Button size="small" danger loading={Boolean(reviewingAssets[assetId])} disabled={busy || Boolean(reviewingAssets[assetId])} onClick={() => void submitReview(assetId, media.nodeId, media.storageKey, media.sha256, "rejected")}>{t("director.workspace.returnAsset")}</Button></div></div>}
      </div>
    </article>;
  };

  const renderOverview = () => <div className="space-y-5">
    {production.draft.settings.parallelScenes && canvasRole !== "scene" && <SceneProductionPanel key={JSON.stringify({ canvasId, episodeId: production.episodeId })} disabled={busy} commandPending={sceneCommandPending} onCommand={onSceneCommand} onAskDirector={scope => onAskDirector({ workspace: "overview", ...scope })} production={production} owner={canvasRole === "episode" ? production.episodeId : { projectId: canvasId }} onRefresh={onRefresh} />}
    <section className="rounded-2xl border border-border bg-muted/40 p-4 sm:p-5" aria-label={t("director.workspace.overview.currentTask")}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0"><p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t("director.workspace.overview.currentTask")}</p><h2 className="mt-1 text-lg font-semibold sm:text-xl">{humanMessage(taskTitle)}</h2>
          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground"><span>{t(`director.workspace.tab.${presentationWorkspace}`)}{presentationTargetName ? ` · ${humanMessage(presentationTargetName)}` : ""}</span>{presentationModule && <span>{t("director.studio.collaborate")}</span>}</div>
          {presentation?.reason && <p className="mt-2 text-sm text-muted-foreground">{presentation.reason}</p>}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1">{presentation?.status && <Tag color={presentation.status === "needs_review" ? "orange" : presentation.status === "blocked" ? "red" : presentation.status === "complete" ? "green" : undefined}>{t(`director.workspace.presentationStatus.${presentation.status}`)}</Tag>}</div>
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button type="primary" disabled={busy || (!d && !briefDraft.trim())} onClick={() => {
          if (!d) { document.getElementById("director-current-brief")?.scrollIntoView({ block: "center", behavior: "smooth" }); return; }
          if (!presentation) { onAskDirector({ workspace: "overview", instruction: t("director.workspace.continueInstruction") }); return; }
          if (presentation?.status === "needs_review" || !["author", "compile"].includes(presentation?.action || "")) { onNavigate(presentationWorkspace, presentationFocus); return; }
          onAskDirector({ workspace: presentationWorkspace, targetId: presentation?.targetId, instruction: t("director.workspace.continueInstruction") });
        }}>{!d ? t("director.workspace.overview.startFromBriefAction") : !presentation ? t("director.workspace.askDirector") : presentation.status === "needs_review" ? t("director.workspace.overview.viewAndReview") : ["author", "compile"].includes(presentation.action || "") ? t("director.workspace.askDirector") : t("director.workspace.overview.openWorkspace")}</Button>
        {d && presentation && (presentation.status === "needs_review" || presentation.status === "blocked" || ["author", "compile"].includes(presentation.action)) && <Button onClick={() => presentation.action === "author" || presentation.action === "compile" ? onNavigate(presentationWorkspace, presentationFocus) : onAskDirector({ workspace: presentationWorkspace, targetId: presentation.targetId, instruction: t("director.workspace.overview.reviseCurrentTask") })}>{presentation.action === "author" || presentation.action === "compile" ? t("director.workspace.overview.openWorkspace") : t("director.workspace.overview.askDirectorToRevise")}</Button>}
      </div>
    </section>
    {(d?.workflow.pendingDecisions || []).filter(decision => decision.status === "pending" || decision.workId === d?.workflow.currentWork?.workId).map((decision: DirectorDecision) => <article key={decision.id} className="rounded-xl border border-orange-300/60 bg-orange-50/50 p-4 dark:border-orange-800 dark:bg-orange-950/20">
      <p className="text-xs text-muted-foreground">{t(`director.workspace.moduleName.${decision.module}`)}</p><h3 className="mt-1 font-semibold">{decision.prompt}</h3>
      {decision.status === "answered" ? <div className="mt-3 flex flex-wrap items-center justify-between gap-2"><p className="text-sm">{t("director.workspace.decisionSaved", { answer: decision.answer || "" })}</p><Button size="small" type="primary" disabled={busy} onClick={() => void onAnswerDecision(decision.id, decision.answer || "")}>{t("director.workspace.continueDecision")}</Button></div> : <>
        <div className="mt-3 flex flex-wrap gap-2">{decision.choices.map(choice => <Button key={choice} size="small" disabled={busy} onClick={() => void onAnswerDecision(decision.id, choice)}>{choice}</Button>)}</div>
        {decision.allowFreeText && <div className="mt-3 flex gap-2"><Input value={decisionReplies[decision.id] || ""} disabled={busy} aria-label={t("director.workspace.decisionAnswer")} onChange={event => setDecisionReplies(current => ({ ...current, [decision.id]: event.target.value }))} /><Button size="small" disabled={busy || !decisionReplies[decision.id]?.trim()} onClick={() => void onAnswerDecision(decision.id, decisionReplies[decision.id].trim())}>{t("director.workspace.submitDecision")}</Button></div>}
      </>}
    </article>)}
    <div className="grid gap-4">
      <details id="director-current-brief" open={!d ? true : undefined} className="rounded-2xl border border-border bg-card p-5"><summary className="cursor-pointer text-sm font-medium">{t("director.studio.creativeNotes")}</summary>
      <div className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-xs uppercase tracking-wide text-muted-foreground">{t("director.workspace.currentBrief")}</p><h2 className="mt-1 text-xl font-semibold">{t("director.briefTitle")}</h2></div><div className="flex gap-2"><Tag color="blue">{t("director.workspace.revision", { revision: production.revision })}</Tag><Button size="small" onClick={onRefresh}>{t("director.workspace.refresh")}</Button></div></div>
        <Input.TextArea className="mt-4" value={briefDraft} disabled={busy} autoSize={{ minRows: 4, maxRows: 10 }} placeholder={t("director.briefPlaceholder")} onChange={event => onBriefDraftChange(event.target.value)} />
        <div className="mt-3 flex flex-wrap gap-2"><Button disabled={busy || briefDraft === String(source.brief || "")} onClick={() => void onBrief(briefDraft)}>{t("director.workspace.saveBrief")}</Button></div>
      </details>
      <section className="rounded-2xl border border-border bg-card p-5">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">{t("director.workspace.readiness")}</p><h2 className="mt-1 text-xl font-semibold">{humanMessage(readiness?.nextAction || t("director.workspace.noNextAction"))}</h2>
        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {([["ready", readinessCounts.ready], ["blocked", readinessCounts.blocked], ["review", readinessCounts.review], ["done", readinessCounts.done]] as const).map(([key, count]) => <div key={key} className="rounded-lg border border-border p-3"><p className="text-xs text-muted-foreground">{t(`director.workspace.readinessCount.${key}`)}</p><p className="mt-1 text-2xl font-semibold">{count}</p></div>)}
        </div>
      </section>
    </div>
    <section className="overflow-hidden rounded-2xl border border-border bg-card" aria-label={t("director.workspace.overview.objectStatus")}>
      {objectRows.map(row => <button key={row.key} type="button" aria-current={row.current ? "page" : undefined} onClick={() => onNavigate(row.key)} className={`grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 border-b border-border px-4 py-3 text-left transition-colors last:border-b-0 sm:grid-cols-[minmax(150px,.8fr)_minmax(0,1.5fr)_auto] sm:gap-4 sm:px-5 ${row.current ? "bg-muted/40" : "hover:bg-muted/30"}`}>
        <span className="min-w-0"><strong className="block truncate font-medium">{t(`director.workspace.tab.${row.key}`)}</strong></span>
        <span className="col-span-2 row-start-2 min-w-0 truncate text-xs text-muted-foreground sm:col-span-1 sm:row-auto">{humanMessage(row.summary)}</span>
        <Tag className="col-start-2 row-start-1 sm:col-start-auto sm:row-auto" color={row.status === "current" ? "blue" : row.status === "blocked" ? "red" : row.status === "done" ? "green" : undefined}>{t(`director.workspace.overview.rowStatus.${row.status}`)}</Tag>
      </button>)}
    </section>
    {readiness?.targets.some(item => item.status !== "complete") && <section className="space-y-2"><div className="flex items-center justify-between"><h2 className="font-semibold">{t("director.workspace.targetsNeedingWork")}</h2><Tag>{readiness.targets.length}</Tag></div>
      {readiness.targets.filter(item => item.status !== "complete").slice(0, 8).map(item => <article key={item.id} data-production-target={item.kind === "keyframe" ? `frame:${item.targetId}` : `${item.kind}:${item.targetId}`} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card p-3"><div className="min-w-0"><p className="font-medium">{targetName(item.kind, item.targetId, item.title)}<Tag className="ml-2">{t(`director.workspace.targetKind.${item.kind}`)}</Tag></p><p className="mt-1 text-sm text-muted-foreground">{humanMessage(item.blockers[0] || item.notice || t(`director.workspace.targetStatus.${item.status}`))}</p></div><Button size="small" onClick={() => item.status === "needs_review" ? onNavigate(item.kind === "segment" ? "production" : "assets", { kind: item.kind === "keyframe" ? "frame" : item.kind, id: item.targetId }) : onAskDirector({ workspace: item.kind === "segment" ? "production" : item.kind === "keyframe" ? "shots" : "assets", targetId: item.targetId })}>{item.status === "needs_review" ? t(item.kind === "segment" ? "director.workspace.reviewInProduction" : "director.workspace.reviewInAssets") : t("director.workspace.askDirector")}</Button></article>)}
    </section>}
    {readiness?.unresolved.length ? <Alert type="warning" showIcon message={t("director.workspace.openIssues")} description={humanMessage(readiness.unresolved.join("；"))} /> : null}

    <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4"><span className="text-xs text-muted-foreground">{t("director.workspace.overview.footerHint")}</span><Button type="primary" icon={<WandSparkles className="size-4" />} disabled={busy || !briefDraft.trim()} onClick={async () => { if (briefDraft !== String(source.brief || "")) await onBrief(briefDraft); onAskDirector({ workspace: presentationWorkspace, targetId: presentation?.targetId, brief: briefDraft, instruction: t("director.workspace.continueInstruction") }); }}>{t("director.workspace.progressCurrent")}</Button></footer>
  </div>;

  const renderStoryWorkspace = () => <div className="space-y-6">
    <header className="flex flex-wrap items-center justify-between gap-3">
      <div><h2 className="text-2xl font-semibold tracking-tight">{t("director.studio.script")}</h2><p className="mt-1 text-sm text-muted-foreground">{t("director.studio.scriptSummary", { scenes: sceneGroups.length, characters: characters.length })}</p></div>
      <div className="flex gap-2"><Button icon={editingScript ? <BookOpen className="size-4" /> : <Pencil className="size-4" />} disabled={!activeScene} onClick={() => setEditingScript(value => !value)}>{t(editingScript ? "director.studio.readScript" : "director.studio.editScript")}</Button><Button icon={<WandSparkles className="size-4" />} disabled={busy} onClick={() => onAskDirector({ workspace: "story", targetId: activeScene?.key })}>{t("director.studio.collaborate")}</Button></div>
    </header>
    <details className="border-b border-border pb-4"><summary className="cursor-pointer text-sm font-medium">{t("director.studio.creativeNotes")}</summary><div className="mt-3 space-y-3"><Input.TextArea aria-label={t("director.studio.creativeNotes")} value={briefDraft} disabled={busy} autoSize={{ minRows: 4, maxRows: 10 }} onChange={event => onBriefDraftChange(event.target.value)} /><Button disabled={busy || briefDraft === String(source.brief || "")} onClick={() => void onBrief(briefDraft)}>{t("director.workspace.saveBrief")}</Button></div></details>
    {!d ? <Alert type="info" message={t("director.workspace.storyStartsFromBrief")} /> : !activeScene ? <Alert type="info" message={t("director.workspace.storyNotDrafted")} description={t("director.workspace.storyNotDraftedHint")} /> : <div className="grid items-start gap-6 md:grid-cols-[190px_minmax(0,1fr)] xl:grid-cols-[190px_minmax(0,1fr)_190px]">
      <nav aria-label={t("director.studio.sceneDirectory")} className="min-w-0 md:sticky md:top-4"><h3 className="mb-3 text-xs font-medium text-muted-foreground">{t("director.studio.sceneDirectory")}</h3><div className="flex gap-2 overflow-x-auto pb-2 md:flex-col md:overflow-visible">
        {sceneGroups.map((group, index) => <button key={group.key} type="button" aria-current={group.key === activeScene.key ? "true" : undefined} onClick={() => setActiveSceneKey(group.key)} className={`flex min-w-40 items-start gap-3 rounded-lg px-3 py-3 text-left transition-colors md:min-w-0 ${group.key === activeScene.key ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"}`}><span className="pt-0.5 text-xs tabular-nums">{String(index + 1).padStart(2, "0")}</span><span className="min-w-0"><strong className="block text-sm font-medium">{sceneTitle(group, index)}</strong><span className="mt-1 block text-xs">{t("director.studio.blockCount", { count: group.blocks.length })}</span></span></button>)}
      </div></nav>
      <div className="min-w-0">
        <article className="min-h-[380px] rounded-xl border border-border bg-card px-5 py-6 sm:px-8 sm:py-8">
          <div className="mb-7 border-b border-border pb-5"><p className="mb-2 text-xs font-medium text-muted-foreground">{t("director.studio.sceneNumber", { number: activeSceneIndex + 1 })}</p>{editingScript ? <SourceField value={activeScene.blocks[0].scene_name || activeScene.blocks[0].heading || ""} placeholder={t("director.workspace.sceneName")} draftValue={sourceDrafts[`scene:${activeScene.key}:scene_name`]} onDraftChange={value => onSourceDraftChange(`scene:${activeScene.key}:scene_name`, value)} disabled={busy} onCommit={value => onPatch("scene", activeScene.key, { scene_name: value })} /> : <h3 className="text-xl font-semibold">{sceneTitle(activeScene, activeSceneIndex)}</h3>}{(activeScene.blocks[0].location || activeScene.blocks[0].time_of_day) && <p className="mt-2 text-sm text-muted-foreground">{[readableText(activeScene.blocks[0].location, nameMap), readableText(activeScene.blocks[0].time_of_day)].filter(Boolean).join(" · ")}</p>}</div>
          <div className="space-y-6">{activeScene.blocks.map((block, index) => {
            const id = String(block.id || block.scene_id || ""); const isDialogue = Boolean(block.speaker) || block.kind === "dialogue" || block.type === "dialogue"; const localText = sourceDrafts[`scene:${id}:text`];
            return <div key={`${id}:${index}`} data-production-target={`scene:${id}`} className={isDialogue && !editingScript ? "mx-auto max-w-md" : ""}>
              {isDialogue && <p className="mb-2 text-sm font-semibold">{nameMap[block.speaker] || block.speaker || t("director.studio.dialogue")}</p>}
              {editingScript ? <SourceField value={block.text || ""} draftValue={localText} onDraftChange={value => onSourceDraftChange(`scene:${id}:text`, value)} multiline rows={3} disabled={busy} placeholder={t("director.workspace.scriptText")} onCommit={value => id ? onPatch("scene", id, { text: value }) : false} /> : <p className="whitespace-pre-wrap break-words text-base leading-8">{localText ?? (isDialogue ? dialogueBody(block) : String(block.text || ""))}</p>}
              {localText !== undefined && <p className="mt-2 text-xs text-amber-600">{t("director.studio.unsavedText")}</p>}
            </div>;
          })}</div>
          <div className="mt-8 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-4"><span className="text-xs text-muted-foreground">{t(editingScript ? "director.studio.autosaveHint" : "director.studio.originalText")}</span><Button type="text" size="small" onClick={() => onAskDirector({ workspace: "story", targetId: activeScene.key, instruction: t("director.workspace.reviseScene") })}>{t("director.studio.reviseScene")}</Button></div>
        </article>
        <div className="mt-4 flex items-center justify-between gap-2"><Button type="text" icon={<ArrowLeft className="size-4" />} disabled={activeSceneIndex === 0} onClick={() => setActiveSceneKey(sceneGroups[activeSceneIndex - 1].key)}>{t("director.studio.previousScene")}</Button><span className="text-xs tabular-nums text-muted-foreground">{activeSceneIndex + 1} / {sceneGroups.length}</span><Button type="text" disabled={activeSceneIndex === sceneGroups.length - 1} onClick={() => setActiveSceneKey(sceneGroups[activeSceneIndex + 1].key)}>{t("director.studio.nextScene")}<ArrowRight className="size-4" /></Button></div>
      </div>
      <aside className="min-w-0 space-y-6 md:col-start-2 xl:col-start-auto">
        <section><h3 className="mb-3 flex items-center gap-2 text-xs font-medium text-muted-foreground"><Users className="size-4" />{t("director.studio.characters")}</h3><div className="space-y-4">{characters.map((character, index) => <div key={character.id || index}><h4 className="text-sm font-medium">{humanName(character.name, String(character.id), t("director.studio.characterNumber", { number: index + 1 }))}</h4><p className="mt-1 line-clamp-3 text-xs leading-6 text-muted-foreground">{readableText(character.appearance || character.description || character.prompt_description || character.role, nameMap) || t("director.studio.detailsInAssets")}</p></div>)}</div><Button className="mt-3" size="small" type="text" onClick={() => onNavigate("assets")}>{t("director.studio.viewAssets")}<ArrowRight className="size-3" /></Button></section>
        <section><h3 className="mb-3 flex items-center gap-2 text-xs font-medium text-muted-foreground"><MapPin className="size-4" />{t("director.studio.locations")}</h3><div className="space-y-3">{locations.map((location, index) => <p key={location.id || index} className="text-sm">{humanName(location.name, String(location.id), t("director.studio.sceneNumber", { number: index + 1 }))}</p>)}</div></section>
        {records(story.beats).some(beat => readableText(beat, nameMap)) && <section><h3 className="mb-3 text-xs font-medium text-muted-foreground">{t("director.studio.storyBeats")}</h3>{records(story.beats).map((beat, index) => <p key={index} className="mb-3 text-sm leading-6">{readableText(beat, nameMap)}</p>)}</section>}
      </aside>
    </div>}
  </div>;

  const renderAssets = () => <div className="space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-2xl font-semibold">{t("director.studio.assets")}</h2><p className="mt-1 text-sm text-muted-foreground">{t("director.studio.assetsHint")}</p></div><Button icon={<WandSparkles className="size-4" />} disabled={busy} onClick={() => onAskDirector({ workspace: "assets" })}>{t("director.studio.collaborate")}</Button></div>
    {error && <Alert type="error" showIcon message={error} />}
    {d && <details className="border-b border-border pb-4"><summary className="cursor-pointer text-sm text-muted-foreground">{t("director.studio.styleSettings")}</summary><section className="mt-3 grid gap-3 md:grid-cols-2">
      <label className="grid gap-1 text-sm"><span className="font-medium">{t("director.workspace.styleMother")}</span><Select allowClear value={String((source.style_lock as Record<string, unknown> | undefined)?.anchor_asset_id || "") || undefined} disabled={busy} placeholder={t("director.workspace.chooseStyleMother")} options={assetPlan.filter(item => String(item.role || item.asset_type || "").toUpperCase() === "STYLE_MOTHER" || String(item.kind || "").toLowerCase() === "style").map(item => ({ value: assetIdOf(item), label: assetTitle(item) }))} onChange={value => void onPatch("style", undefined, { anchor_asset_id: value || "" })} /></label>
      <label className="grid gap-1 text-sm"><span className="font-medium">{t("director.workspace.stylePolicy")}</span><Select value={String(source.style_policy || "required")} disabled={busy} options={[{ value: "required", label: t("director.workspace.styleRequired") }, { value: "waived", label: t("director.workspace.styleWaived") }]} onChange={value => void onPatch("style", undefined, { style_policy: value })} /></label>
      {source.style_policy === "waived" && <label className="grid gap-1 text-sm md:col-span-2"><span>{t("director.workspace.styleWaiverReason")}</span><SourceField value={source.style_policy_reason || ""} draftValue={sourceDrafts["style:style_policy_reason"]} onDraftChange={value => onSourceDraftChange("style:style_policy_reason", value)} multiline rows={2} disabled={busy} onCommit={value => onPatch("style", undefined, { style_policy_reason: value })} /></label>}

    </section></details>}
    <div className="flex flex-wrap items-center justify-between gap-3"><div className="flex flex-wrap gap-1">{["all", "characters", "locations", "props", "frames"].map(filter => <button type="button" key={filter} aria-pressed={assetFilter === filter} className={`rounded-lg px-3 py-2 text-sm ${assetFilter === filter ? "bg-muted font-medium" : "text-muted-foreground hover:bg-muted/50"}`} onClick={() => setAssetFilter(filter)}>{t(`director.studio.filter.${filter}`)}</button>)}</div><Input className="max-w-60" prefix={<Search className="size-4 text-muted-foreground" />} placeholder={t("director.studio.searchAssets")} aria-label={t("director.studio.searchAssets")} value={assetSearch} onChange={event => setAssetSearch(event.target.value)} /></div>
    {!d ? <Alert type="info" message={t("director.workspace.assetsNeedDirector")} /> : allAssetIds.length ? (() => {
      const visibleAssetIds = allAssetIds.filter(id => (!embedded || !focusTarget?.startsWith("asset:") || id === focusedId) && (assetFilter === "all" || assetCategory(id) === assetFilter) && assetName(id).toLowerCase().includes(assetSearch.toLowerCase()));
      const shotForAsset = (id: string) => Object.entries(d.shotInputs).find(([, input]) => input.keyframeAssetId === id)?.[0];
      const isPendingReview = (id: string) => mediaForAsset(id, shotForAsset(id)).status === "generated";
      const orderedAssetIds = [...visibleAssetIds].sort((a, b) => Number(isPendingReview(b)) - Number(isPendingReview(a)) || visibleAssetIds.indexOf(a) - visibleAssetIds.indexOf(b));
      const activeAssetId = orderedAssetIds.includes(selectedReviewAssetId) ? selectedReviewAssetId : orderedAssetIds.find(isPendingReview) || orderedAssetIds[0];
      const activeShotId = activeAssetId ? shotForAsset(activeAssetId) : undefined;
      if (embedded && focusTarget?.startsWith("asset:") && activeAssetId) return renderAssetCard(activeAssetId, assetPlan.find(value => assetIdOf(value) === activeAssetId), activeShotId);
      return <div className="grid min-h-[28rem] gap-4 lg:grid-cols-[minmax(15rem,0.8fr)_minmax(0,1.6fr)]">
        <nav aria-label={t("director.workspace.reviewQueue")} className="overflow-hidden rounded-xl border border-border bg-card">
          <div className="flex items-center justify-between border-b border-border px-4 py-3"><h3 className="font-semibold">{t("director.workspace.reviewQueue")}</h3><Tag>{orderedAssetIds.filter(isPendingReview).length}</Tag></div>
          <div className="max-h-[65vh] overflow-y-auto">
            {orderedAssetIds.map(assetId => {
              const shotId = shotForAsset(assetId);
              const media = mediaForAsset(assetId, shotId);
              const active = assetId === activeAssetId;
              return <button key={assetId} type="button" aria-current={active ? "true" : undefined} onClick={() => setSelectedReviewAssetId(assetId)} className={`flex w-full items-center justify-between gap-3 border-b border-border px-4 py-3 text-left last:border-b-0 ${active ? "bg-muted/60" : "hover:bg-muted/30"}`}>
                <span className="min-w-0"><strong className="block truncate text-sm font-medium">{shotId ? `${shotTitle(shotId)} · ${t("director.studio.keyframe")}` : assetName(assetId)}</strong><span className="mt-1 block truncate text-xs text-muted-foreground">{t(`director.studio.filter.${assetCategory(assetId)}`)}</span></span>
                <Tag className="shrink-0" color={media.status === "generated" ? "blue" : media.status === "approved" ? "green" : media.status === "rejected" ? "red" : undefined}>{t(`director.workspace.assetStatus.${media.status}`)}</Tag>
              </button>;
            })}
            {!orderedAssetIds.length && <p className="p-5 text-sm text-muted-foreground">{t("director.studio.emptySearch")}</p>}
          </div>
        </nav>
        <div className="min-w-0">{activeAssetId ? renderAssetCard(activeAssetId, assetPlan.find(value => assetIdOf(value) === activeAssetId), activeShotId) : <div className="flex h-full items-center justify-center rounded-xl border border-border bg-card p-8 text-sm text-muted-foreground">{t("director.workspace.noPendingReviews")}</div>}</div>
      </div>;
    })() : <Alert type="info" message={t("director.workspace.noAssets")} description={t("director.workspace.noAssetsHint")} />}
    {d && allAssetIds.length > 0 && !allAssetIds.some(id => (assetFilter === "all" || assetCategory(id) === assetFilter) && assetName(id).toLowerCase().includes(assetSearch.toLowerCase())) && <p className="py-12 text-center text-sm text-muted-foreground">{t("director.studio.emptySearch")}</p>}
    <Modal open={Boolean(mediaPreview)} title={mediaPreview?.title} footer={null} width={960} onCancel={() => setMediaPreview(null)}>
      {mediaPreview && /\.(mp4|webm|mov)(?:$|\?)/i.test(mediaPreview.storageKey) ? <video className="max-h-[72dvh] w-full" controls src={backendMediaUrl(mediaPreview.storageKey)} onError={() => setError(t("director.workspace.mediaReadFailed"))} /> : mediaPreview && <img className="max-h-[72dvh] w-full object-contain" src={backendMediaUrl(mediaPreview.storageKey)} alt={mediaPreview.title} onError={() => setError(t("director.workspace.mediaReadFailed"))} />}
    </Modal>
  </div>;

  const renderShotDetails = (shot: Record<string, any>, includeCompleteSource = false) => {
    const id = String(shot.id || "");
    const input = d?.shotInputs[id];
    const segment = segments.find(item => (item.shot_ids || []).includes(id));
    const boundary = segment && d?.boundaries.find(item => item.from === segment.id);
    return <div className="space-y-5" data-shot-reading={id}>
      <section className="space-y-2">
        <h4 className="text-xs font-medium text-muted-foreground">{t("director.studio.readingSummary")}</h4>
        <p className="whitespace-pre-wrap text-sm leading-7">{shotDisplayText(shot) || t("director.studio.noVisual")}</p>
      </section>
      {(records(shot.dialogues).length > 0 || !includeCompleteSource) && <section className="space-y-2">
        <h4 className="text-xs font-medium text-muted-foreground">{t("director.studio.dialogue")}</h4>
        {records(shot.dialogues).length ? <dl className="space-y-3">{records(shot.dialogues).map((dialogue, index) => {
          const speakerId = String(dialogue.character_id || dialogue.speaker || "");
          const speaker = speakerId === "NARRATOR" ? t("director.studio.narration") : nameMap[speakerId] || humanName(dialogue.speaker, "", t("director.studio.speaker"));
          return <div key={String(dialogue.id || index)} className="flex gap-3"><dt className="w-16 shrink-0 pt-1 text-xs text-muted-foreground">{speaker}</dt><dd className="min-w-0 whitespace-pre-wrap text-sm leading-7">{dialogueBody({ ...dialogue, speaker })}</dd></div>;
        })}</dl> : <p className="text-sm text-muted-foreground">{t("director.studio.noDialogue")}</p>}
      </section>}
      {!includeCompleteSource && <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
        <Button size="small" type="text" icon={<WandSparkles className="size-3.5" />} disabled={busy} onClick={() => onAskDirector({ workspace: "shots", targetId: id, instruction: t("director.workspace.reviseShot") })}>{t("productionCanvas.discussObject")}</Button>
        {input?.keyframeAssetId && <Button size="small" type="text" icon={<ImageIcon className="size-3.5" />} onClick={() => onNavigate("assets", { kind: "frame", id })}>{t("director.studio.viewFrame")}</Button>}
        {segment && <Button size="small" type="text" icon={<Film className="size-3.5" />} onClick={() => onNavigate("production", { kind: "segment", id: String(segment.id) })}>{segmentTitle(String(segment.id))}<ArrowRight className="ml-1 size-3" /></Button>}
      </div>}
      {includeCompleteSource && <dl className="grid gap-3 text-sm sm:grid-cols-2" data-shot-reading-notes>{(["camera", "state_in", "state_out"] as const).map(field => {
        const text = readableText(shot[field], nameMap);
        return text ? <div key={field}><dt className="text-xs text-muted-foreground">{t(`director.studio.clipReading.${field}`)}</dt><dd className="mt-1 whitespace-pre-wrap leading-6">{text}</dd></div> : null;
      })}</dl>}
      {!includeCompleteSource && boundary && <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground" data-shot-continuity>
        <span>{t("director.studio.tailFrameLabel")} · {t(boundary.tailFrame ? "director.studio.flagOn" : "director.studio.flagOff")}</span>
        <span>{t("director.studio.motionContextLabel")} · {t(boundary.motionContext ? "director.studio.flagOn" : "director.studio.flagOff")}</span>
      </div>}
      <details className="border-t border-border pt-3" data-shot-source-details>
        <summary className="cursor-pointer text-xs text-muted-foreground">{t("director.studio.sourceDetails")}</summary>
        <div className="mt-4 space-y-4">{(["visual", "camera", "state_in", "state_out"] as const).map(field => <label key={field} className="grid gap-2 text-xs text-muted-foreground"><span>{t(`director.studio.shotField.${field}`)}</span><SourceField value={proseOf(shot[field])} draftValue={sourceDrafts[`shot:${id}:${field}`]} onDraftChange={value => onSourceDraftChange(`shot:${id}:${field}`, value)} multiline rows={3} disabled={busy} placeholder={(field === "state_in" || field === "state_out") && shot[field] && !proseOf(shot[field]) ? t("director.studio.structuredState") : undefined} onCommit={value => onPatch("shot", id, { [field]: patchProse(shot[field], value) })} /></label>)}</div>
        <div className="mt-4 flex flex-wrap gap-2">{input?.assetIds?.map(assetId => <button key={assetId} type="button" className="rounded border border-border px-2 py-1 text-xs" onClick={() => onNavigate("assets", { kind: "asset", id: assetId })}>{assetName(assetId)}</button>)}</div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">{(["start_frame", "end_frame"] as const).map(field => <label key={field} className="grid gap-1 text-xs text-muted-foreground"><span>{t(field === "start_frame" ? "director.workspace.startFrame" : "director.workspace.endFrame")}</span><SourceField value={shot[field]} draftValue={sourceDrafts[`shot:${id}:${field}`]} onDraftChange={value => onSourceDraftChange(`shot:${id}:${field}`, value)} numeric disabled={busy} onCommit={value => onPatch("shot", id, { [field]: value })} /></label>)}</div>
        {includeCompleteSource && <div className="mt-4" data-shot-complete-source><SourceData value={shot} names={nameMap} /></div>}
      </details>
    </div>;
  };

  const renderShots = () => {
    const sceneForShot = (shot: Record<string, any>) => sceneGroups.find(group => group.key === shot.source_scene_id || group.blocks.some(block => block.id === shot.source_scene_id)) || sceneGroups.find(group => group.sceneId === shot.scene_id);
    const visible = displayedShots.filter(shot => !shotSearch.trim() || `${shot.id} ${shotTitle(String(shot.id))} ${shotDisplayText(shot)} ${sceneForShot(shot)?.title || nameMap[shot.scene_id] || ""}`.toLocaleLowerCase().includes(shotSearch.trim().toLocaleLowerCase()));
    return <div className="space-y-4" data-storyboard-view>
    <header className="space-y-3 border-b border-border pb-4">
      <div className="flex flex-wrap items-center justify-between gap-3"><div>{!compact && <h2 className="text-xl font-semibold">{t("director.studio.storyboard")}</h2>}<p className="text-xs text-muted-foreground">{t("director.studio.shotsSummary", { shots: sourceShots.length, clips: segments.length, seconds: formatSeconds((timelineEnd - timelineStart) / fps) })}</p></div><Button type="text" size="small" icon={<WandSparkles className="size-3.5" />} disabled={busy} onClick={() => onAskDirector({ workspace: "shots" })}>{t("director.studio.collaborate")}</Button></div>
      <Input allowClear prefix={<Search className="size-3.5 text-muted-foreground" />} value={shotSearch} onChange={event => setShotSearch(event.target.value)} placeholder={t("director.studio.searchShots")} aria-label={t("director.studio.searchShots")} />
    </header>
    {displayedShots.length ? <div className="divide-y divide-border">{visible.map((shot, index) => {
      const id = String(shot.id || ""), number = sourceShots.findIndex(item => item.id === shot.id) + 1;
      const scene = sceneForShot(shot), sceneKey = String(shot.source_scene_id || shot.scene_id || "");
      const previous = visible[index - 1];
      const startScene = !previous || sceneKey !== String(previous.source_scene_id || previous.scene_id || "");
      const input = d?.shotInputs[id], segment = segments.find(item => (item.shot_ids || []).includes(id));
      const linkedFrame = frameForShot(id), referenceId = input?.assetIds?.find(assetId => assetCategory(assetId) === "frames" && d?.assets[assetId]?.storageKey);
      const image = linkedFrame || (referenceId ? d?.assets[referenceId]?.storageKey : undefined), expanded = selectedShot === id;
      return <div key={id}>
        {startScene && <div className="flex items-center gap-2 px-3 pt-5 pb-2 text-xs font-medium text-muted-foreground" data-storyboard-scene={sceneKey}><MapPin className="size-3.5" /><span>{scene?.title || nameMap[shot.scene_id] || sceneKey}</span></div>}
        <article data-production-target={`shot:${id}`} data-storyboard-row className={expanded ? "bg-muted/20" : ""}>
          <button type="button" aria-label={t("director.studio.openShot", { number })} aria-expanded={expanded} onClick={() => setSelectedShot(expanded ? "" : id)} className="flex w-full items-start gap-3 rounded px-3 py-3 text-left transition-colors hover:bg-muted/40">
            <span className="w-6 shrink-0 pt-1 text-xs tabular-nums text-muted-foreground">{String(number).padStart(2, "0")}</span>
            <span className="relative hidden h-12 w-20 shrink-0 items-center justify-center overflow-hidden rounded bg-muted/40 sm:flex">{image ? <img className="h-full w-full object-contain" src={backendMediaUrl(image)} alt={shotTitle(id)} loading="lazy" /> : <Film className="size-4 text-muted-foreground/50" />}</span>
            <span className="min-w-0 flex-1"><span className="flex flex-wrap items-center gap-x-3 gap-y-1"><strong className="text-sm font-medium">{shotTitle(id)}</strong><span className="text-xs tabular-nums text-muted-foreground">{formatSeconds((Number(shot.end_frame) - Number(shot.start_frame)) / fps)}s</span>{segment && <span className="text-xs text-muted-foreground">{segmentTitle(String(segment.id))}</span>}</span>{!expanded && <span className="mt-1 block text-sm leading-6 text-muted-foreground line-clamp-2">{shotDisplayText(shot) || t("director.studio.noVisual")}</span>}</span>
            <ChevronDown className={`mt-1 size-4 shrink-0 text-muted-foreground transition-transform ${expanded ? "rotate-180" : ""}`} />
          </button>
          {expanded && <div className="px-3 pb-5 sm:pl-12">{renderShotDetails(shot)}</div>}
        </article>
      </div>;
    })}{!visible.length && <p className="px-3 py-8 text-center text-sm text-muted-foreground">{t("director.studio.emptyShotSearch")}</p>}</div> : <Alert type="info" message={t("director.workspace.noShots")} description={t("director.workspace.noShotsHint")} />}
    <details className="border-t border-border pt-4" data-storyboard-arrangement>
      <summary className="cursor-pointer text-sm font-medium">{t("director.studio.arrangementDetails")}</summary>
      <div className="mt-4 space-y-6">
    <section className="space-y-3"><div><h3 className="font-semibold">{t("director.workspace.segmentsTitle")}</h3><p className="mt-1 text-sm text-muted-foreground">{t("director.workspace.segmentsHint")}</p></div>
      {segments.length ? segments.map((segment, index) => { const id = String(segment.id || index); const draftKey = `segment:${id}:shot_ids`; return <article key={id} data-production-target={`segment:${id}`} className="rounded-xl border border-border bg-card p-4"><div className="flex flex-wrap items-center justify-between gap-2"><div><h4 className="font-semibold">{segmentTitle(id)}</h4><p className="mt-1 text-sm text-muted-foreground">{(segment.shot_ids || []).map((shotId: string) => shotTitle(String(shotId))).join(" → ") || t("director.workspace.noShotInSegment")}</p></div><Tag color="blue">{String(segment.generation_clip_duration || "—")}s</Tag></div><div className="mt-3 flex flex-wrap gap-2"><Tag>{String(segment.mode || "H3")}</Tag><span className="text-xs text-muted-foreground">{formatSeconds(Number(segment.start_frame) / fps)}–{formatSeconds(Number(segment.end_frame) / fps)}s</span></div><SegmentGroupEditor segment={segment} shots={sourceShots} segments={segments} fps={Number(source.fps_num || 24) / Number(source.fps_den || 1)} draftValue={sourceDrafts[draftKey]} onDraftChange={value => onSourceDraftChange(draftKey, value)} disabled={busy} onSave={onRegroup} /></article>; }) : <Alert type="info" message={t("director.workspace.noSegments")} />}
    </section>
    {d && <section className="space-y-3"><div><h3 className="font-semibold">{t("director.workspace.continuityTitle")}</h3><p className="mt-1 text-sm text-muted-foreground">{t("director.workspace.continuityHint")}</p></div>{segments.slice(0, -1).map((segment, index) => {
      const from = String(segment.id || ""); const to = String(segments[index + 1].id || "");
      const draftKey = `boundary:${from}:${to}`;
      return <BoundaryCard key={from} from={from} to={to} fromLabel={segmentTitle(from)} toLabel={segmentTitle(to)} boundary={d.boundaries.find(item => item.from === from && item.to === to)} draftValue={sourceDrafts[draftKey]} onDraftChange={value => onSourceDraftChange(draftKey, value)} disabled={busy} onSave={onBoundary} />;
    })}</section>}
      </div>
    </details>
  </div>;
  };

  const continuitySource = continuityReport?.snapshot === "published" ? (production.published?.director || d) : d;
  const renderContinuity = () => <ContinuityPanel locations={records(continuitySource?.source.scene_registry)} ledger={continuitySource?.source.ledger as Record<string, unknown> | undefined} sourceHash={continuitySource?.sourceHash || ""} editable={continuityReport?.snapshot !== "published"}
    workId={readiness?.presentation?.workId || continuitySource?.workflow.currentWork?.workId}
    scenes={Array.isArray(continuitySource?.source.script_scenes) ? records(continuitySource.source.script_scenes) : scriptScenes} shots={Array.isArray(continuitySource?.source.shots) ? records(continuitySource.source.shots) : sourceShots} segments={Array.isArray(continuitySource?.source.segments) ? records(continuitySource.source.segments) : segments} boundaries={continuitySource?.boundaries || []} characters={Array.isArray(continuitySource?.source.character_registry) ? records(continuitySource.source.character_registry) : characters} assets={Array.isArray(continuitySource?.source.asset_plan) ? records(continuitySource.source.asset_plan) : assetPlan} report={continuityReport} busy={busy}
    onSave={onSaveContinuity || (async () => false)} onPreviewUpgrade={onPreviewContinuityUpgrade || (async () => ({}))} onCheck={onCheckContinuity || (async () => undefined)} onBoundary={value => onBoundary(value as DirectorProduction["boundaries"][number])} onLocate={(kind, id) => onLocateTarget?.(kind, id)} onAskDirector={onAskDirector} onRequestAgentUpgrade={onRequestContinuityUpgrade} agentThreadId={d?.workflow.agentThreadId} onSnapshot={onContinuitySnapshot} />;

  const renderProduction = () => <div className="space-y-5">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-xl font-semibold">{t("director.workspace.tab.production")}</h2><p className="mt-1 text-sm text-muted-foreground">{t("director.studio.productionSummary")}</p></div><div className="flex flex-wrap items-center gap-2"><label className="flex items-center gap-2 text-xs text-muted-foreground"><Switch checked={includeGeneratedMedia} disabled={exporting} onChange={setIncludeGeneratedMedia} />{t("director.workspace.includeGeneratedMedia")}</label><Button size="small" loading={exporting} disabled={!d || exporting} onClick={() => void onExport(includeGeneratedMedia)}>{t("director.workspace.exportBundle")}</Button><Button size="small" disabled={busy || !d} onClick={() => onAskDirector({ workspace: "production", targetId: readiness?.targets.find(item => item.status === "blocked")?.targetId, instruction: t("director.workspace.validateCompileCurrent") })}>{t("director.workspace.validateCompile")}</Button><Button size="small" onClick={onRefresh}>{t("director.workspace.refresh")}</Button><Button type="primary" disabled={busy || !d} onClick={onPublish}>{t("drama.production.directorPublish")}</Button></div></div>
    <details className="border-b border-border pb-4"><summary className="cursor-pointer text-sm text-muted-foreground">{t("director.studio.settings")}</summary><div className="mt-3 space-y-3">    <section className="rounded-xl border border-border bg-card p-4">
      <label className="mb-2 block text-sm font-medium">{t('director.workspace.videoAspectRatio')}</label>
      <Select className="min-w-48" disabled={busy} value={production.draft.settings.videoAspectRatio || ''} onChange={value => onSettings({ videoAspectRatio: value || null, videoAspectRatioConfirmed: true })} options={['', '9:16', '16:9', '1:1', '4:3', '3:4', '2:3', '3:2', '21:9'].map(value => ({ value, label: value || t('director.workspace.inheritVideoAspectRatio') }))} />
      <p className="mt-2 text-xs text-muted-foreground">{t('director.workspace.videoAspectRatioHint')}</p>
    </section>
    {d && <section className="grid gap-3 rounded-2xl border border-border bg-card p-4 md:grid-cols-2"><label className="grid gap-1 text-sm"><span className="font-medium">{t("director.workspace.contentDelivery")}</span><Select value={delivery} disabled={busy} options={[{ value: "auto_file_batch", label: t("director.workspace.autoFileBatch") }, { value: "interactive_segment", label: t("director.workspace.interactiveSegment") }]} onChange={value => onWorkflow({ contentDeliveryMode: value })} /></label><label className="grid gap-1 text-sm"><span className="font-medium">{t("director.workspace.mediaProduction")}</span><Select value={mode} disabled={busy} options={[{ value: "prompt_only", label: t("director.workspace.promptOnly") }, { value: "per_item", label: t("director.workspace.perItem") }, { value: "automatic", label: t("director.workspace.automatic") }]} onChange={value => onWorkflow({ mediaProductionMode: value })} /></label><p className="text-xs text-muted-foreground md:col-span-2">{t("director.workspace.settingsNextRun")}</p></section>}
</div></details>
    {!generationSupported && <Alert type="info" showIcon message={t("director.workspace.sceneGenerationUnavailable")} />}
    {run && <section className="rounded-2xl border border-border bg-card p-4"><div className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-xs uppercase tracking-wide text-muted-foreground">{t("director.workspace.activeRun")}</p><h3 className="mt-1 font-semibold">{t(`director.studio.runStatus.${run.status}`, { defaultValue: run.status })}</h3></div><div className="flex gap-2">{["pending", "running"].includes(run.status) && <Button size="small" icon={<Pause className="size-3" />} onClick={() => onPause(run.runId)}>{t("director.workspace.pause")}</Button>}{["paused", "awaiting_review"].includes(run.status) && <Button size="small" type="primary" icon={<Play className="size-3" />} onClick={() => onResume(run.runId)}>{t("director.workspace.resume")}</Button>}</div></div><p className="mt-2 text-sm text-muted-foreground">{run.executionSnapshot?.inputBasis === "canvas" ? t("director.workspace.canvasRunSummary", { count: run.targets.length }) : t("director.studio.runSummary", { version: run.version, count: run.targets.length })}</p>{run.error && <Alert className="mt-3" type={run.status === "failed" ? "error" : "warning"} showIcon message={run.error} />}</section>}
    {deliveredClips.length > 0 && <section className="space-y-3"><div><h3 className="font-semibold">{t("director.workspace.deliveredVideos")}</h3><p className="mt-1 text-xs text-muted-foreground">{t("director.workspace.technicalCloseout")}</p></div><div className="grid gap-3 md:grid-cols-2">{deliveredClips.map(({ group, storageKey }) => <article key={`${group.id}:${storageKey}`} className="rounded-xl border border-border bg-card p-3"><video className="w-full rounded-lg bg-black" controls preload="metadata" src={backendMediaUrl(storageKey)} /><p className="mt-2 text-sm font-medium">{segmentTitle(group.id)}</p></article>)}</div></section>}
    {!deliveredClips.length && <div className="flex min-h-36 flex-col items-center justify-center rounded-xl border border-dashed border-border bg-muted/20 p-6 text-center"><Film className="mb-3 size-7 text-muted-foreground" /><h3 className="font-medium">{t("director.studio.noResults")}</h3><p className="mt-2 text-sm text-muted-foreground">{t("director.studio.noResultsHint")}</p></div>}
    {mode === "automatic" && <Button icon={<Play className="size-4" />} disabled={!generationSupported || busy || runStartPending || !readiness?.targets.some(item => item.status === "ready" && !activeTargetIds.includes(item.id))} onClick={() => onStart((readiness?.targets || []).filter(item => item.status === "ready" && !activeTargetIds.includes(item.id)).map(item => item.id), "all_ready")}>{t("director.workspace.startAutomatic")}</Button>}
    {mode === "prompt_only" && <Alert type="info" showIcon message={t("director.workspace.promptOnlyHint")} />}
    {readiness?.targets.length ? <section className="space-y-2"><h3 className="font-semibold">{t("director.workspace.productionTargets")}</h3>{readiness.targets.map(target => <article key={target.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card p-3"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><strong>{targetName(target.kind, target.targetId, target.title)}</strong><Tag>{t(`director.workspace.targetKind.${target.kind}`)}</Tag><Tag color={target.status === "ready" ? "green" : target.status === "blocked" ? "red" : target.status === "needs_review" ? "orange" : "default"}>{t(`director.workspace.targetStatus.${target.status}`)}</Tag></div>{target.blockers.length > 0 && <p className="mt-1 text-sm text-amber-600">{humanMessage(target.blockers.join("；"))}</p>}{target.notice && <p className="mt-1 text-xs text-muted-foreground">{humanMessage(target.notice)}</p>}{activeTargetIds.includes(target.id) && <p className="mt-1 text-xs text-amber-600">{t("director.workspace.runTargetActiveInline")}</p>}</div>{target.status === "ready" && mode !== "prompt_only" && mode !== "automatic" && <Button size="small" disabled={!generationSupported || busy || runStartPending || activeTargetIds.includes(target.id)} onClick={() => onStart([target.id])}>{target.kind === "segment" ? t("director.workspace.generateClip") : t("director.workspace.generateItem")}</Button>}<p className="mt-2 text-xs text-muted-foreground">{t("director.workspace.savedInput")}</p>{inputDiff(target)}</article>)}</section> : <Alert type="info" message={readiness?.nextAction || t("director.workspace.noReadiness")} />}
    {d && <section className="space-y-2"><h3 className="font-semibold">{t("director.workspace.completePrompts")}</h3>{d.artifacts.map(artifact => <details key={artifact.id} className="rounded-xl border border-border bg-card p-4"><summary className="cursor-pointer font-medium">{targetName(artifact.kind === "h3" ? "segment" : "asset", artifact.targetId)}</summary><div className="mt-3 space-y-3"><pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/40 p-3 text-sm">{artifact.prompt}</pre>{artifact.references.length > 0 && <div className="space-y-2"><p className="text-sm font-medium">{t("director.workspace.actualReferences")}</p>{artifact.references.map(ref => <div key={`${artifact.id}:${ref.label}:${ref.storageKey}`} className="flex flex-wrap items-center gap-2 rounded-lg border border-border p-2 text-xs"><Image className="max-h-16 max-w-20 rounded object-contain" src={backendMediaUrl(ref.storageKey)} alt={ref.label} /><span>{ref.label}</span><Tag>{ref.role}</Tag></div>)}</div>}</div></details>)}</section>}
  </div>;

  const renderAdvanced = () => <div className="space-y-5">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-xl font-semibold">{t("director.workspace.advancedTitle")}</h2><p className="mt-1 text-sm text-muted-foreground">{t("director.workspace.advancedHint")}</p></div><details><summary className="cursor-pointer text-sm text-muted-foreground">{t("director.advanced")}</summary><Button className="mt-2" disabled={!d} onClick={() => { setJson(JSON.stringify(d || {}, null, 2)); setError(""); }}>{t("director.workspace.editJson")}</Button></details></div>
    {compact && <details className="border-b border-border pb-4"><summary className="cursor-pointer font-medium">{t("productionCanvas.productionSettings")}</summary><div className="mt-4">{renderProduction()}</div></details>}
    {d && <section className="rounded-2xl border border-border bg-card p-5"><div className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-xs uppercase tracking-wide text-muted-foreground">{t("director.workspace.internalModules")}</p><h2 className="mt-1 text-lg font-semibold">{t("director.workspace.moduleRoles")}</h2></div><span className="text-xs text-muted-foreground">{t("director.workspace.modulesNotGates")}</span></div><div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">{directorModules.map(module => <div key={module} className="rounded-lg border border-border p-3"><div className="flex items-center justify-between gap-2"><strong>{t(`director.workspace.moduleName.${module}`)}</strong><Tag color={["committed", "continuity_passed"].includes(moduleViewStatus(module)) ? "green" : moduleViewStatus(module) === "blocked" ? "red" : undefined}>{t(`director.workspace.moduleStatus.${moduleViewStatus(module)}`)}</Tag></div><p className="mt-1 text-xs text-muted-foreground">{t("director.workspace.declaredModuleStatus", { status: t(`director.workspace.moduleStatus.${d.modules[module]?.status || "planned"}`) })}</p>{d.modules[module]?.unresolved.length ? <p className="mt-2 text-xs text-amber-600">{d.modules[module]?.unresolved[0]}</p> : null}</div>)}</div></section>}
    {d && <details className="rounded-xl border border-border bg-card p-4"><summary className="cursor-pointer font-medium">{t("director.studio.rawSource")}</summary><pre className="mt-4 max-h-[36rem] overflow-auto whitespace-pre-wrap break-words text-xs">{JSON.stringify({ revision: production.revision, localEdits: sourceDrafts, source: d.source, assets: d.assets, shotInputs: d.shotInputs, boundaries: d.boundaries, artifacts: d.artifacts, run, readiness }, null, 2)}</pre></details>}
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

  const renderStory = () => !compact ? renderStoryWorkspace() : <div data-production-scene-editor className="mx-auto max-w-3xl space-y-5">
    {!activeScene ? <div className="space-y-4"><p className="text-sm text-muted-foreground">{t("productionCanvas.scriptEmpty")}</p><Input.TextArea aria-label={t("productionCanvas.story")} value={briefDraft} onChange={event => onBriefDraftChange(event.target.value)} autoSize={{ minRows: 5, maxRows: 12 }} disabled={busy} /><div className="flex justify-end gap-2"><Button disabled={busy} onClick={() => onAskDirector({ workspace: "story", brief: briefDraft })}>{t("productionCanvas.discussObject")}</Button><Button type="primary" disabled={busy || !briefDraft.trim()} onClick={() => void onBrief(briefDraft)}>{t("director.workspace.saveBrief")}</Button></div></div> : <>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-3">
        <Select variant="borderless" aria-label={t("productionCanvas.chooseScene")} value={activeScene.key} onChange={key => { setActiveSceneKey(key); onNavigate("story", { kind: "scene", id: key }); }} className="min-w-44 max-w-full" options={sceneGroups.map((group, index) => ({ value: group.key, label: `${t("director.studio.sceneNumber", { number: index + 1 })} · ${sceneTitle(group, index)}` }))} />
        <Button type="text" icon={editingScript ? <BookOpen className="size-4" /> : <Pencil className="size-4" />} onClick={() => setEditingScript(value => !value)}>{t(editingScript ? "director.studio.readScript" : "director.studio.editScript")}</Button>
      </div>
      {(activeScene.blocks[0].location || activeScene.blocks[0].time_of_day) && <p className="text-sm text-muted-foreground">{[readableText(activeScene.blocks[0].location, nameMap), readableText(activeScene.blocks[0].time_of_day)].filter(Boolean).join(" · ")}</p>}
      <div className="space-y-5 py-3">{activeScene.blocks.map((block, index) => {
        const id = String(block.id || block.scene_id || ""), dialogue = Boolean(block.speaker) || block.kind === "dialogue" || block.type === "dialogue";
        return <div key={`${id}:${index}`} data-production-target={`scene:${id}`}>
          {dialogue && <p className="mb-2 font-medium">{nameMap[block.speaker] || block.speaker || t("director.studio.dialogue")}</p>}
          {editingScript ? <SourceField value={block.text || ""} draftValue={sourceDrafts[`scene:${id}:text`]} onDraftChange={value => onSourceDraftChange(`scene:${id}:text`, value)} multiline rows={4} commitOnBlur={false} disabled={busy} onCommit={() => false} /> : <p className="whitespace-pre-wrap break-words text-base leading-8">{sourceDrafts[`scene:${id}:text`] ?? (dialogue ? dialogueBody(block) : String(block.text || ""))}</p>}
        </div>;
      })}</div>
      <div className="flex justify-end gap-2 border-t border-border pt-4"><Button type="text" disabled={busy} onClick={() => onAskDirector({ workspace: "story", targetId: activeScene.key, instruction: t("director.workspace.reviseScene") })}>{t("director.studio.reviseScene")}</Button>{editingScript && <Button type="primary" disabled={busy} onClick={async () => { if (await onSaveScript?.(activeScene.blocks.map(block => String(block.id || block.scene_id || "")))) setEditingScript(false); }}>{t("productionCanvas.saveScript")}</Button>}</div>
    </>}
  </div>;

  const renderSegmentStyle = (segment: Record<string, any>) => {
    const group = production.draft.clipGroups.find(group => group.id === segment.id);
    const node = canvasNodes.find(node => node.id === group?.nodeId);
    const clip = (Array.isArray(node?.metadata?.segments) ? node.metadata.segments as Record<string, any>[] : []).find(clip => clip.id === group?.segmentId);
    const styleDeclared = clip ? clip.productionClipProjection?.styleTemplateDeclared === true || clip.h3ParameterOverrides?.includes("styleTemplateId") : Object.hasOwn(segment, "styleTemplateId");
    const sourceStyle = segment.styleTemplateId ?? null;
    const liveStyle = clip?.styleTemplateId ?? null;
    const disabled = busy;
    const styleName = (value: string | null) => value ? t(`director.workspace.clipStyleNames.${value}`) : t("director.workspace.clipStyleNone");
    return <div className="mt-3 space-y-2" data-production-clip-style={segment.id}><label className="flex flex-wrap items-center gap-3 text-sm"><span>{t("director.workspace.clipStyle")}</span><Select className="w-56 max-w-full" aria-label={t("director.workspace.clipStyle")} value={styleDeclared ? (clip ? liveStyle : sourceStyle) || "" : "__inherit__"} disabled={disabled} options={[...(!styleDeclared ? [{ value: "__inherit__", label: t("director.workspace.clipStyleInherit"), disabled: true }] : []), { value: "", label: styleName(null) }, ...H3_STYLE_TEMPLATES.map(template => ({ value: template.id, label: styleName(template.id) }))]} onChange={value => { if (value !== "__inherit__") { if (onEditCanvasClip && group?.nodeId && group.segmentId) void onEditCanvasClip(group.nodeId, group.segmentId, { styleTemplateId: value || null }); else void onPatch("segment", segment.id, { styleTemplateId: value || null }); } }} /></label><p className="text-xs text-muted-foreground">{t("director.workspace.clipStyleHint")}</p>{clip && liveStyle !== sourceStyle && onAdoptClipStyle && <Button size="small" disabled={disabled} onClick={() => { void onAdoptClipStyle(segment.id, liveStyle); }}>{t("director.workspace.adoptClipStyle", { style: styleName(liveStyle) })}</Button>}</div>;
  };
  const inputDiff = (target: { id: string; targetId: string; kind: string }) => {
    const group = target.kind === "segment" ? production.draft.clipGroups.find(group => group.id === target.targetId) : undefined;
    const assetId = target.kind === "keyframe" ? d?.shotInputs[target.targetId]?.keyframeAssetId : target.targetId;
    const nodeId = group?.nodeId || (assetId ? d?.assets[assetId]?.nodeId : undefined);
    const node = canvasNodes.find(node => node.id === nodeId);
    if (!node || !onAdoptDirectorFields) return null;
    const sourceId = (node.metadata?.productionImageProjection as any)?.sourceNodeId;
    const sourceNode = !group && sourceId ? canvasNodes.find(node => node.id === sourceId) : undefined;
    const targetPromptChanged = !group && node.metadata?.prompt !== (node.metadata?.productionImageProjection as any)?.nextValues?.prompt;
    const chosenNode = sourceNode && !targetPromptChanged ? sourceNode : node;
    const current = group ? (node.metadata?.segments as Record<string, any>[] || []).find(clip => clip.id === group.segmentId) : { ...chosenNode.metadata, referenceNodeIds: chosenNode.metadata?.canvasReferenceNodeIds };
    if (!current) return null;
    return <ProductionInputDiff current={current} projection={group ? current.productionClipProjection : current.productionImageProjection} busy={busy}
      onAdopt={fields => onAdoptDirectorFields(group ? group.id : assetId!, chosenNode.id, group?.segmentId || undefined, fields)} />;
  };
  const focusedAsset = focusTarget?.startsWith("asset:") ? focusedId : focusTarget?.startsWith("frame:") ? d?.shotInputs[focusedId]?.keyframeAssetId : undefined;
  const focusedShot = focusTarget?.startsWith("shot:") ? sourceShots.find(shot => String(shot.id) === focusedId) : undefined;
  const focusedSegment = focusTarget?.startsWith("segment:") ? segments.find(segment => String(segment.id) === focusedId) : undefined;
  if (compact && workspace === "assets" && focusedAsset) return <section data-production-object-editor className="space-y-4">
    {renderAssetCard(focusedAsset, assetPlan.find(item => assetIdOf(item) === focusedAsset), focusTarget?.startsWith("frame:") ? focusedId : undefined)}
    <Modal open={Boolean(mediaPreview)} title={mediaPreview?.title} footer={null} width={960} onCancel={() => setMediaPreview(null)}>{mediaPreview && <img className="max-h-[72dvh] w-full object-contain" src={backendMediaUrl(mediaPreview.storageKey)} alt={mediaPreview.title} onError={() => setError(t("director.workspace.mediaReadFailed"))} />}</Modal>
    {error && <Alert type="error" message={error} />}
  </section>;
  if (compact && workspace === "shots" && focusedShot) {
    const index = sourceShots.findIndex(shot => shot.id === focusedShot.id);
    return <section data-production-object-editor className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-4">
        <div><p className="text-xs text-muted-foreground">{t("director.studio.shotNumber", { number: index + 1 })} · {formatSeconds((Number(focusedShot.end_frame) - Number(focusedShot.start_frame)) / fps)}s</p><h2 className="mt-1 text-lg font-semibold">{shotTitle(focusedId)}</h2></div>
        <div className="flex items-center gap-1"><Button size="small" type="text" onClick={() => { setSelectedShot(""); onNavigate("shots"); }}>{t("director.studio.allShots")}</Button><Button size="small" type="text" aria-label={t("director.studio.previousShot")} icon={<ArrowLeft className="size-3.5" />} disabled={index <= 0} onClick={() => onNavigate("shots", { kind: "shot", id: String(sourceShots[index - 1].id) })} /><Button size="small" type="text" aria-label={t("director.studio.nextShot")} icon={<ArrowRight className="size-3.5" />} disabled={index >= sourceShots.length - 1} onClick={() => onNavigate("shots", { kind: "shot", id: String(sourceShots[index + 1].id) })} /></div>
      </header>
      {renderShotDetails(focusedShot)}
      {frameForShot(focusedId) && <details className="border-t border-border pt-3"><summary className="cursor-pointer text-xs text-muted-foreground">{t("director.studio.viewFrame")}</summary><img className="mt-3 max-h-[32dvh] w-full object-contain" src={backendMediaUrl(frameForShot(focusedId)!)} alt={shotTitle(focusedId)} /></details>}
    </section>;
  }
  if (compact && workspace === "production" && focusedSegment) {
    const group = production.draft.clipGroups.find(group => group.id === focusedId);
    const node = canvasNodes.find(node => node.id === group?.nodeId);
    const clips = Array.isArray(node?.metadata?.segments) ? node.metadata.segments as Record<string, unknown>[] : [];
    const clip = clips.find(clip => clip.id === group?.segmentId);
    const media = String(clip?.resultStorageKey || "");
    const target = readiness?.targets.find(target => target.id === `segment:${focusedId}`);
    const clipShots = (Array.isArray(focusedSegment.shot_ids) ? focusedSegment.shot_ids : []).flatMap((id: string) => sourceShots.filter(shot => String(shot.id) === String(id)));
    const segmentIndex = segments.indexOf(focusedSegment);
    const adjacentPairs = [segmentIndex - 1, segmentIndex].filter(index => index >= 0 && index < segments.length - 1);
    const ledger = source.ledger;
    const running = activeTargetIds.includes(`segment:${focusedId}`) || ["queued", "running"].includes(String(clip?.status || ""));
    const canGenerate = target?.status === "ready" && mode !== "prompt_only" && mode !== "automatic";
    return <section data-production-object-editor className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3" data-clip-reading-header>
        <div className="min-w-0"><h2 className="text-xl font-semibold">{segmentTitle(focusedId)}</h2><p className="mt-2 text-sm text-muted-foreground">{t("director.studio.clipTiming", { seconds: focusedSegment.generation_clip_duration ?? "—", start: formatSeconds(Number(focusedSegment.start_frame) / fps), end: formatSeconds(Number(focusedSegment.end_frame) / fps) })}</p></div>
        <div className="flex flex-wrap items-center gap-2">
          {running ? <Tag>{t("director.studio.clipGenerating")}</Tag> : target && <Tag>{t(`director.workspace.targetStatus.${target.status}`)}</Tag>}
          <Button type="text" size="small" icon={<WandSparkles className="size-3.5" />} disabled={busy} onClick={() => onAskDirector({ workspace: "production", targetId: focusedId })}>{t("productionCanvas.discussObject")}</Button>
          {canGenerate && <Button type="text" size="small" icon={<Play className="size-3.5" />} disabled={!generationSupported || busy || runStartPending || running} loading={runStartPending} onClick={() => onStart([target!.id])}>{t("director.workspace.generateClip")}</Button>}
        </div>
      </header>
      <section className="space-y-3" data-clip-result>
        {media ? <video className="max-h-[36dvh] w-full" aria-label={t("director.studio.clipVideo", { title: segmentTitle(focusedId) })} src={backendMediaUrl(media)} controls preload="metadata" /> : <p className="text-sm text-muted-foreground">{t(running ? "director.studio.clipWaitingVideo" : "director.studio.clipNoVideo")}</p>}
        {Boolean(target?.blockers.length) && <details data-clip-checks><summary className="cursor-pointer text-sm text-muted-foreground">{t("director.studio.clipChecks", { count: target!.blockers.length })}</summary><ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted-foreground">{target!.blockers.map(reason => <li key={reason}>{humanMessage(reason.replace(/^[A-Z][A-Z0-9_]+[:：]\s*/, ""))}</li>)}</ul></details>}
      </section>
      {renderSegmentStyle(focusedSegment)}
      <section className="space-y-4 border-t border-border pt-5" data-clip-source-shots>
        <h3 className="font-semibold">{t("director.studio.clipStory")}</h3>
        {clipShots.length ? clipShots.map((shot, index) => <article key={shot.id} className="space-y-3 border-l-2 border-border pl-4"><div className="flex flex-wrap items-baseline gap-3"><span className="text-xs text-muted-foreground">{t("director.studio.shotNumber", { number: index + 1 })}</span><h4 className="font-medium">{shotTitle(String(shot.id))}</h4></div>{renderShotDetails(shot, true)}</article>) : <p className="text-sm text-muted-foreground">{t("director.workspace.noShotInSegment")}</p>}
      </section>
      {adjacentPairs.length > 0 && <details className="border-t border-border pt-4" data-clip-source-continuity>
        <summary className="cursor-pointer text-sm font-medium">{t("director.studio.clipConnections")}</summary>
        <div className="mt-4 space-y-3">{adjacentPairs.map(index => {
          const from = String(segments[index].id), to = String(segments[index + 1].id), draftKey = `boundary:${from}:${to}`;
          return <BoundaryCard key={draftKey} from={from} to={to} fromLabel={segmentTitle(from)} toLabel={segmentTitle(to)} boundary={d?.boundaries.find(item => item.from === from && item.to === to)} draftValue={sourceDrafts[draftKey]} onDraftChange={value => onSourceDraftChange(draftKey, value)} disabled={busy} onSave={onBoundary} />;
        })}<Button type="text" size="small" onClick={() => onNavigate("continuity")}>{t("director.studio.viewContinuity")}</Button></div>
      </details>}
      <details className="border-t border-border pt-4" data-clip-complete-source>
        <summary className="cursor-pointer text-sm text-muted-foreground">{t("director.studio.clipSourceDetails")}</summary>
        <div className="mt-4 space-y-4"><p className="text-xs text-muted-foreground">{t("director.studio.clipSourceHint")}</p><SourceData value={focusedSegment} names={nameMap} />{Boolean(ledger) && <details><summary className="cursor-pointer text-sm text-muted-foreground">{t("director.studio.continuityLedger")}</summary><div className="mt-3"><SourceData value={ledger} names={nameMap} /></div></details>}</div>
      </details>
      <details className="border-t border-border pt-4"><summary className="cursor-pointer text-sm text-muted-foreground">{t("productionCanvas.objectDetails")}</summary>{target?.blockers.slice(1).map(reason => <p key={reason} className="mt-2 text-sm text-muted-foreground">{humanMessage(reason)}</p>)}<SegmentGroupEditor segment={focusedSegment} shots={sourceShots} segments={segments} fps={fps} draftValue={sourceDrafts[`segment:${focusedId}:shot_ids`]} onDraftChange={value => onSourceDraftChange(`segment:${focusedId}:shot_ids`, value)} disabled={busy} onSave={onRegroup} /></details>
    </section>;
  }
  const batchTasks = new Set(batches.flatMap(batch => batch.submitted.map(task => task.taskId)));
  const standaloneTasks = runtimeTasks.filter(task => !task.parentTaskId && !batchTasks.has(task.id));
  const currentTaskKeys = new Set<string>();
  const currentTasks = standaloneTasks.filter(task => { const key = `${task.nodeId || task.input?.nodeId}:${task.segmentId || task.input?.segmentId || ""}`; if (currentTaskKeys.has(key)) return false; currentTaskKeys.add(key); return true; });
  if (compact && workspace === "production" && !focusTarget) return <section data-production-tasks-panel className="space-y-6">
    <div className="flex flex-wrap items-center justify-between gap-2"><span /><div className="flex gap-2"><Button size="small" type="text" onClick={onRefresh}>{t("director.workspace.refresh")}</Button><Button size="small" type="text" onClick={() => onNavigate("advanced")}>{t("productionCanvas.advanced")}</Button></div></div>
    {batches.length > 0 && <div className="space-y-3">{batches.map(batch => <article key={batch.runId} className="rounded-lg border border-border p-4"><div className="flex flex-wrap items-center justify-between gap-2"><span className="font-medium">{t(`director.studio.runStatus.${batch.status}`, { defaultValue: batch.status })}</span><div className="flex gap-2">{["pending", "running"].includes(batch.status) && <Button size="small" onClick={() => onPause(batch.runId)}>{t("director.workspace.pause")}</Button>}{["paused", "awaiting_review"].includes(batch.status) && <Button size="small" onClick={() => onResume(batch.runId)}>{t("director.workspace.resume")}</Button>}</div></div><p className="mt-2 text-xs text-muted-foreground">{t("productionCanvas.taskCount", { count: batch.targets.length, submitted: batch.submitted.length })}</p>{batch.error && <p className="mt-3 whitespace-pre-wrap text-sm text-muted-foreground">{humanMessage(batch.error)}</p>}<div className="mt-3 flex flex-wrap gap-2">{batch.targets.map(key => { const [kind, ...ids] = key.split(":"); const id = ids.join(":"); return <Button key={key} size="small" type="text" onClick={() => onLocateTarget?.(kind, id)}>{targetName(kind === "frame" ? "keyframe" : kind, id)}</Button>; })}</div></article>)}</div>}
    {currentTasks.map(task => { const nodeId = String(task.nodeId || task.input?.nodeId || ""), segmentId = String(task.segmentId || task.input?.segmentId || ""); const group = production.draft.clipGroups.find(group => group.nodeId === nodeId && group.segmentId === segmentId); const frame = Object.entries(production.draft.keyframes).find(([, frame]) => frame.nodeId === nodeId); const asset = Object.entries(d?.assets || {}).find(([, asset]) => asset.nodeId === nodeId); const kind = group ? "segment" : frame ? "keyframe" : "asset", id = group?.id || frame?.[0] || asset?.[0]; return <article key={task.id} className="rounded-lg border border-border p-4"><div className="flex flex-wrap items-center justify-between gap-2"><span>{id ? targetName(kind, id) : t("productionCanvas.videoTarget")}</span><Tag>{t(`productionCanvas.historyStatus.${task.status === "succeeded" ? "success" : task.status === "awaiting_confirmation" ? "confirmation" : task.status}`)}</Tag></div>{task.status === "running" && <p className="mt-2 text-xs text-muted-foreground">{Math.round((task.progress || 0) * 100)}%</p>}{task.error && <p className="mt-2 whitespace-pre-wrap text-sm text-muted-foreground">{humanMessage(task.error)}</p>}{id && <Button className="mt-2" type="text" size="small" onClick={() => onLocateTarget?.(kind, id)}>{t("productionCanvas.locateResult")}</Button>}</article>; })}
    {!batches.length && !currentTasks.length && <p className="text-sm text-muted-foreground">{t("productionCanvas.noTasks")}</p>}
    {readiness?.targets.some(target => ["blocked", "needs_review"].includes(target.status)) && <details className="border-t border-border pt-4"><summary className="cursor-pointer text-sm">{t("productionCanvas.needsAttention")}</summary><div className="mt-3 space-y-3">{readiness.targets.filter(target => ["blocked", "needs_review"].includes(target.status)).map(target => <div key={target.id}><Button size="small" type="text" onClick={() => onLocateTarget?.(target.kind, target.targetId)}>{targetName(target.kind, target.targetId, target.title)}</Button><p className="mt-1 text-sm text-muted-foreground">{humanMessage(target.blockers[0] || target.notice || t(`director.workspace.targetStatus.${target.status}`))}</p></div>)}</div></details>}
    <section className="space-y-3 border-t border-border pt-4"><div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-medium">{t("productionCanvas.deliveries")}</h3><Button size="small" loading={exporting} disabled={!d || exporting} onClick={() => void onExport(true)}>{t("productionCanvas.downloadPackage")}</Button></div>{deliveredClips.length ? deliveredClips.map(({ group, storageKey }) => <article key={`${group.id}:${storageKey}`} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border p-3"><span>{segmentTitle(group.id)}</span><div className="flex gap-2"><Button size="small" type="text" onClick={() => onLocateTarget?.("segment", group.id)}>{t("productionCanvas.locateResult")}</Button><Button size="small" aria-label={t("common.download")} onClick={() => { void fetch(backendMediaUrl(storageKey)).then(async response => { if (!response.ok) throw new Error(t("director.workspace.mediaReadFailed")); saveAs(await response.blob(), `${segmentTitle(group.id).replace(/[\\/:*?"<>|]/g, "_")}.${response.headers.get("content-type")?.includes("webm") ? "webm" : "mp4"}`); }).catch(error => message.error(String(error))); }}>{t("common.download")}</Button></div></article>) : <p className="text-sm text-muted-foreground">{t("productionCanvas.noDeliveries")}</p>}</section>
  </section>;
  return <section className="space-y-4">
    {workspace === "overview" && renderOverview()}
    {workspace === "story" && renderStory()}
    {workspace === "assets" && renderAssets()}
    {workspace === "shots" && renderShots()}
    {workspace === "continuity" && renderContinuity()}
    {workspace === "production" && renderProduction()}
    {workspace === "advanced" && renderAdvanced()}
  </section>;
}
