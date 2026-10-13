import { ProductionPageHeading } from "./production-page-heading";
import { canBindSubjectImage, manualWorkspaceProgress, manualTargetRecovery } from "./manual-production-guide";
import { productionEntities, productionEntityBinding } from "@basketikun/canvas-agent/drama/production-contract";
import { ProductionInputDiff } from "./production-input-diff";
import { currentClipRefreshes, groupedRefreshIssues } from "./production-refresh-display";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Alert, App, Button, Input, InputNumber, Modal, Select, Switch, Tag } from "antd";
import { ArrowRight, ArrowLeft, ArrowUp, ArrowDown, ArrowDownToLine, Check, Pause, Play, RotateCcw, WandSparkles, Users, MapPin, Image as ImageIcon, Film, Pencil, BookOpen, Search, ChevronDown, Plus, Trash2, TriangleAlert, Volume2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { directorModules, resolveSubjectPictureBindingIds, directorProductionSchema, isSubjectPromptAssembly, canonicalProduction, type DirectorProduction, type ProductionOperation } from "@basketikun/canvas-agent/drama/production-contract";
import { backendMediaUrl, fetchProductionWorkbench, type ProductionCompilationDiagnostic, type ProductionTarget, type ProductionSceneAction, type BackendRuntimeTask, type EpisodeProduction, type ProductionBatch, type ProductionReadiness } from "@/services/backend-api";
import { nanoid } from "nanoid";
import { MediaImage } from "@/components/media/media-image";
import { canvasNodeImage } from "@/lib/canvas/canvas-image-renderability";
import type { CanvasNodeData } from "@/types/canvas";
import { groupScriptScenes, dialogueBody, dialogueSpeakerLabel, readableText, humanName, records, formatSeconds, storyBeatCards, assetImagePreview, shotDurationPatch, matchesAssetSearch } from "./director-display";
import { useProductionFollowStore } from "@/stores/use-production-follow-store";
import { useMediaPreviewStore } from "@/stores/use-media-preview-store";
import { saveAs } from "file-saver";
import { ContinuityPanel } from "./continuity-panel";
import { SceneProductionPanel } from "./scene-production-panel";
import { H3_STYLE_TEMPLATES } from "../../../../canvas-agent/src/plugins/minimax-h3/style-templates";
import { subjectShotWindows } from "@basketikun/canvas-agent/drama/subject-assembly";
import { SubjectShotEditor } from "./subject-shot-editor";
import { keyframeBindingState } from "./keyframe-binding-state";
import { SubjectStoryboardWorkbench, type StoryboardViewMemory } from "./subject-storyboard-workbench";
import { productionWorkbenchValue, subjectDisplayName, subjectDescriptionField } from "./subject-shot-draft";
import { AudioDesignEditor, SevenStepsReferencesEditor, SegmentAudioBindingEditor, type AudioSourceEntry } from "./audio-design-editor";
import { ReferenceNodeLink } from "./reference-node-link";
import { SourceJsonEditor } from "./source-json-editor";
import { matchesProductionEntityTarget, subjectPictureNavigation } from "./subject-picture-navigation";
import { PictureBindingEditor } from "./picture-binding-editor";
import { SmartImageNodePicker } from "./smart-image-node-picker";
import type { ImageNodeChoice } from "./smart-image-node-options";
import { createManualDirectorAsset, manualAssetsForSubject, type ManualAssetKind } from "./manual-director-assets";
import { createManualScriptScene } from "./manual-director-scenes";
import { readClipPartitionDraft } from "./subject-clip-draft";
import { storyboardDurationFrames } from "./storyboard-display";
import { productionOverviewMedia } from "./production-overview-media";
import { useReferenceResultVersion } from "./use-reference-result-version";
import { ProductionSectionNavigation } from "./production-section-navigation";
import { CanvasAssetEditModal, type CanvasAssetEditPayload } from "./canvas-asset-edit-modal";

export type DirectorWorkspace = "series" | "overview" | "story" | "assets" | "shots" | "continuity" | "production" | "advanced";
type CanvasNodeOption = { id: string; title?: string; type?: string; metadata?: Record<string, unknown> };
type ProductionVersion = { version: number; stage: string; createdAt: string };
type DirectorDecision = NonNullable<DirectorProduction["workflow"]["pendingDecisions"]>[number];
const objectWorkspaces: Array<{ key: Exclude<DirectorWorkspace, "overview" | "advanced" | "series">; modules: Array<(typeof directorModules)[number]>; targetKinds: Array<"asset" | "keyframe" | "segment"> }> = [
  { key: "story", modules: ["story"], targetKinds: [] },
  { key: "assets", modules: ["assets"], targetKinds: ["asset"] },
  { key: "shots", modules: ["shots", "performance", "effects"], targetKinds: ["keyframe"] },
  { key: "continuity", modules: ["continuity"], targetKinds: ["segment"] },
  { key: "production", modules: ["model"], targetKinds: ["segment"] },
];
const COMBAT_JSON_FIELD_ORDER = ["force_source", "trajectory", "contact", "resistance", "impact_hold", "transfer", "recoil", "chain", "timing"];
const COMBAT_JSON_NESTED_FIELD_ORDER: Record<string, string[]> = {
  chain: ["attack", "response", "result", "continuation"],
  timing: ["axis_lock", "spatial_direction", "speed_curve", "camera_sync", "direction_facts", "speed_profile", "phases", "slow_motion"],
  direction_facts: ["origin", "target", "screen_direction", "body_orientation", "weapon_direction", "support_point", "result_direction"],
  speed_profile: ["support", "acceleration", "contact_read", "recovery"],
  phases: ["name", "start", "end", "playback", "purpose", "motion", "positions", "orientation", "action", "combat_logic", "camera", "dof", "composition", "dynamics", "tail_frame"],
  combat_logic: ["attacker", "target", "target_point", "intent", "defender_state", "response", "result", "next_authority"],
  camera: ["framing", "movement", "motion_vector", "action_anchor"],
  slow_motion: ["enabled", "start", "end", "rate", "trigger", "reason", "exit"],
};
const PERFORMANCE_JSON_FIELD_ORDER = ["beat_id", "dominant_track", "tracks", "acting_design", "strategy"];
const PERFORMANCE_JSON_NESTED_FIELD_ORDER: Record<string, string[]> = {
  tracks: ["gaze", "body_hands", "breath", "shoulder", "dialogue"],
  acting_design: ["objective", "tactic", "subtext", "trigger", "personality_signature", "action_units", "motion_arc", "speech_delivery", "cut_behavior", "continuity_in", "continuity_out", "exclusions"],
  gaze: ["start", "end", "cue", "visibility"], body_hands: ["start", "end", "cue", "visibility"], breath: ["start", "end", "cue", "visibility"], shoulder: ["start", "end", "cue", "visibility"], dialogue: ["start", "end", "cue", "visibility"],
  action_units: ["start", "end", "cause", "action", "gaze", "face", "follow_through", "speech_anchor", "delivery", "prop", "camera", "sound"],
  motion_arc: ["anticipation", "accent", "follow_through", "settle"],
  speech_delivery: ["voice_timbre", "pace", "pitch", "volume", "pauses", "emphasis"],
};

function Image({ src, alt, className }: { src: string; alt: string; className?: string }) {
  if (alt.startsWith("<Video")) return <video className="max-h-24 max-w-48 rounded object-contain" controls preload="metadata" src={src} aria-label={alt} />;
  if (alt.startsWith("<Audio")) return <audio className="max-w-64" controls preload="metadata" src={src} aria-label={alt} />;
  // 图片预览统一走全局 MediaPreviewHost，不再使用 antd 自带预览。
  return <MediaImage className={className} src={src} alt={alt} />;
}

function SubjectPictureBindings({ subject, canvasNodes, canvasId, owner, assets, assetPlan, busy, entitySource, usages, onSave, sourceDrafts, onSourceDraftChange }: {
  assets: Record<string, any>; assetPlan: Record<string, any>[]; usages: Array<Record<string, any>>; sourceDrafts: Record<string, string>; onSourceDraftChange: (key: string, value?: string) => void; subject: Record<string, any>; canvasNodes: CanvasNodeOption[]; canvasId: string; owner: ProductionTarget; busy: boolean; entitySource?: { projectId: string; nodeId: string }; onSave: (subject: Record<string, any>) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const [nodeChoice, setNodeChoice] = useState<ImageNodeChoice>();
  const [expanded, setExpanded] = useState(true);
  const [workbench, setWorkbench] = useState<Record<string, any>>();
  const [readError, setReadError] = useState("");
  const [reading, setReading] = useState(false);
  const [retry, setRetry] = useState(0);
  const readIdentity = useRef("");
  const bindings = records(subject.pictureBindings);
  const navigation = subjectPictureNavigation(bindings, entitySource, { id: canvasId, nodeIds: canvasNodes.map(node => node.id) });
  const referenceVersion = useReferenceResultVersion(bindings.map(binding => binding.sourceNode || {}));
  const ownerKey = JSON.stringify(owner);
  const sources = canvasNodes.filter(node => ["image", "character", "scene", "prop"].includes(String(node.type)) || node.type === "config" && node.metadata?.smart === true && (node.metadata?.generationMode || "image") === "image");
  const nodeChoiceValid = canBindSubjectImage(nodeChoice, canvasId, canvasNodes, bindings);
  const selectedSourceNode = nodeChoice?.projectId === canvasId ? sources.find(node => node.id === nodeChoice.nodeId) : undefined;
  const characterSourceImages = selectedSourceNode?.type === "character" ? records(selectedSourceNode.metadata?.characterImages).flatMap((image, index) => {
    const storageKey = String(image.storageKey || "").trim();
    return storageKey ? [{ image, index, storageKey, referenceId: `${selectedSourceNode.id}:character-image:${storageKey}` }] : [];
  }) : [];
  useEffect(() => { if (nodeChoice && !nodeChoiceValid) setNodeChoice(undefined); }, [nodeChoice, nodeChoiceValid]);
  const bindingStamp = JSON.stringify(bindings);
  const mediaStamp = JSON.stringify(sources.filter(node => bindings.some(binding => binding.sourceNode?.nodeId === node.id)).map(node => [node.id, node.metadata?.images, node.metadata?.characterImages, node.metadata?.storageKey, node.metadata?.smartImageReferenceSelection]));
  useEffect(() => {
    if (!expanded) return;
    let current = true;
    const identity = `${ownerKey}:${subject.id}:${bindingStamp}`;
    if (readIdentity.current !== identity) { setWorkbench(undefined); readIdentity.current = identity; }
    setReading(true); setReadError("");
    void fetchProductionWorkbench(owner, "subject_workbench", String(subject.id), "draft")
      .then(result => { if (current) setWorkbench(productionWorkbenchValue(result.production, "subject")); })
      .catch(error => { if (current) setReadError(error instanceof Error ? error.message : String(error)); })
      .finally(() => { if (current) setReading(false); });
    return () => { current = false; };
  }, [expanded, ownerKey, subject.id, bindingStamp, mediaStamp, referenceVersion, retry]);
  const add = async () => {
    if (!nodeChoice || !nodeChoiceValid || selectedSourceNode?.type === "character") return;
    const bindingId = `picture:${subject.id}:${encodeURIComponent(nodeChoice.projectId)}:${encodeURIComponent(nodeChoice.nodeId)}`;
    const binding = { id: bindingId, assetId: nodeChoice.assetId || bindingId,
      sourceNode: { projectId: nodeChoice.projectId, nodeId: nodeChoice.nodeId }, selection: { mode: "node_selection" },
      provides: ["identity"], retain: ["主体身份与已登记外观"], exclude: ["原图姿势", "无关背景"], applicableState: {}, defaultFor: bindings.some(item => (item.defaultFor || []).includes("identity")) ? [] : ["identity"] };
    if (await onSave({ ...subject, pictureBindings: [...bindings, binding] })) setNodeChoice(undefined);
  };
  const addCharacterImage = async (storageKey: string, referenceId: string) => {
    if (!nodeChoice || !canBindSubjectImage(nodeChoice, canvasId, canvasNodes, bindings, storageKey)) return;
    const bindingId = `picture:${subject.id}:${encodeURIComponent(nodeChoice.projectId)}:${encodeURIComponent(nodeChoice.nodeId)}:${encodeURIComponent(storageKey)}`;
    const binding = { id: bindingId, assetId: nodeChoice.assetId || bindingId,
      sourceNode: { projectId: nodeChoice.projectId, nodeId: nodeChoice.nodeId }, selection: { mode: "selected_result", resultId: referenceId },
      provides: ["identity"], retain: ["角色身份"], exclude: ["原图构图", "无关背景"], applicableState: {}, defaultFor: bindings.some(item => (item.defaultFor || []).includes("identity")) ? [] : ["identity"] };
    if (await onSave({ ...subject, pictureBindings: [...bindings, binding] })) setNodeChoice(undefined);
  };
  const remove = async (binding: Record<string, any>) => {
    await onSave({ ...subject, pictureBindings: bindings.filter(item => item.id !== binding.id) });
  };
  return <details className="rounded-lg border border-border p-3" data-subject-picture-bindings={String(subject.id)} open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary className="cursor-pointer text-sm font-medium">{t("director.workspace.subjectPictures")}</summary>
    <div className="mt-3 space-y-3">
    {readError && <div className="flex flex-wrap items-start gap-2 text-xs"><details className="min-w-0 flex-1"><summary className="cursor-pointer text-muted-foreground">{t("director.canvasOverlay.referenceReadFailed")}</summary><p className="mt-2 whitespace-pre-wrap break-words">{readError}</p></details><Button size="small" type="text" onClick={() => setRetry(value => value + 1)}>{t("director.atomic.retry")}</Button></div>}
    {busy && <p role="status" className="text-xs text-muted-foreground">{t("director.subjectImages.editingBusy")}</p>}
    {reading && <p role="status" className="text-xs text-muted-foreground">{t("director.atomic.loading")}</p>}
    {bindings.map((binding, index) => {
      const node = binding.sourceNode?.projectId === canvasId ? sources.find(item => item.id === binding.sourceNode?.nodeId) : undefined;
      const selection = binding.selection || { mode: "latest_success" };
      const sourceAction = navigation.pictures[index];
      const inUse = usages.some(usage => resolveSubjectPictureBindingIds(subject, usage).bindingIds.includes(String(binding.id)));
      const resolved = records(workbench?.pictureBindings).find(item => item.id === binding.id)?.resolved;
      const characterImages = node?.type === "character" ? records(node.metadata?.characterImages).flatMap((image, imageIndex) => {
        const storageKey = String(image.storageKey || "").trim();
        return storageKey ? [{ image, imageIndex, storageKey, referenceId: `${node.id}:character-image:${storageKey}` }] : [];
      }) : [];
      const selectedCharacterImage = characterImages.find(item => [item.storageKey, item.referenceId].includes(String(selection.resultId || "")))
        || characterImages.find(item => item.storageKey === String(resolved?.storageKey || ""));
      return <article key={binding.id} data-subject-picture={String(binding.id)} className="grid gap-3 border-b border-border py-4 last:border-b-0">
        <h4 className="text-xs font-medium text-muted-foreground">{t("director.subjectImages.referenceNumber", { number: index + 1 })}</h4>
        {resolved?.storageKey ? <MediaImage className="max-h-64 w-full rounded object-contain" src={backendMediaUrl(String(resolved.storageKey))} alt={String(subject.id)} /> : <div className="flex h-32 w-full items-center justify-center rounded border border-border text-xs text-muted-foreground">{readError ? "—" : t(reading ? "director.atomic.loading" : "director.workspace.noActivePicture")}</div>}
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-2"><strong className="text-sm">{node?.title || t("director.crud.boundImage")}</strong><Tag>{selection.mode === "node_selection" ? t("director.atomic.followNodeReference") : selection.mode === "selected_result" ? t("director.workspace.selectedHistory") : t("director.workspace.followLatest")}</Tag></div>
          <div className="flex flex-wrap items-center gap-2" data-picture-source-actions><span className="mr-auto">{sourceAction && <ReferenceNodeLink sourceNode={sourceAction.sourceNode} label={t(sourceAction.isEntity ? "director.subjectImages.openPictureAndSubject" : "director.subjectImages.openPictureSource")} />}</span><Button size="small" type="text" disabled={busy || inUse} title={inUse ? t("director.subjectImages.unbindInUse") : undefined} onClick={() => void remove(binding)}>{t("director.workspace.removePictureBinding")}</Button>{selection.mode !== "node_selection" && <Button size="small" type="text" disabled={busy} onClick={() => void onSave({ ...subject, pictureBindings: bindings.map(item => item.id === binding.id ? { ...item, selection: { mode: "node_selection" } } : item) })}>{t("director.atomic.followNodeReference")}</Button>}</div>
          <label className="grid gap-1 text-xs"><span>{t("director.subjectImages.replaceReference")}</span><SmartImageNodePicker canvasId={canvasId} canvasNodes={canvasNodes} assets={assets} assetPlan={assetPlan} value={binding.sourceNode} disabled={busy} onChange={choice => void onSave({ ...subject, pictureBindings: bindings.map(item => item.id === binding.id ? { ...item, assetId: choice.assetId || binding.id, sourceNode: { projectId: choice.projectId, nodeId: choice.nodeId }, selection: { mode: "node_selection" } } : item) })} /></label>
          {characterImages.length > 0 && <label className="grid gap-1 text-xs"><span>{t("director.subjectImages.pinCharacterImage")}</span><Select className="w-full" value={selectedCharacterImage?.storageKey} disabled={busy} options={characterImages.map(item => ({ value: item.storageKey, label: String(item.image.outfit || item.image.name || t("director.crud.frameNumber", { number: item.imageIndex + 1 })) }))} onChange={storageKey => { const chosen = characterImages.find(item => item.storageKey === storageKey); if (chosen) void onSave({ ...subject, pictureBindings: bindings.map(item => item.id === binding.id ? { ...item, selection: { mode: "selected_result", resultId: chosen.referenceId } } : item) }); }} /></label>}
          <PictureBindingEditor binding={binding} busy={busy} draftValue={sourceDrafts[`picture:${subject.id}:${binding.id}`]} onDraftChange={value => onSourceDraftChange(`picture:${subject.id}:${binding.id}`, value)} onSave={patch => onSave({ ...subject, pictureBindings: bindings.map(item => item.id === binding.id ? { ...item, ...patch } : item) })} />
          <p className="text-xs text-muted-foreground">{t("director.workspace.pictureUsage", { retain: (binding.retain || []).join(", "), exclude: (binding.exclude || []).join(", ") })}</p>
          <label className="flex items-center justify-between gap-3 text-xs text-muted-foreground"><span>{t("director.atomic.defaultIdentity")}</span><Switch size="small" checked={(binding.defaultFor || []).includes("identity")} disabled={busy} onChange={checked => void onSave({ ...subject, pictureBindings: bindings.map(item => ({ ...item, defaultFor: item.id === binding.id ? [...(item.defaultFor || []).filter((purpose: string) => purpose !== "identity"), ...(checked ? ["identity"] : [])] : checked ? (item.defaultFor || []).filter((purpose: string) => purpose !== "identity") : item.defaultFor || [] })) })} /></label>
          {inUse && <p className="text-xs text-muted-foreground">{t("director.subjectImages.unbindInUse")}</p>}
        </div>
      </article>;
    })}
    <section className="space-y-2 border-t border-border pt-3" data-subject-add-reference>
      <h4 className="text-sm font-medium">{t(bindings.length ? "director.subjectImages.addAnotherReference" : "director.subjectImages.addFirstReference")}</h4>
      <p className="text-xs text-muted-foreground">{t("director.subjectImages.addReferenceHint")}</p>
    <div className="flex flex-wrap gap-2">
      <SmartImageNodePicker canvasId={canvasId} canvasNodes={canvasNodes} assets={assets} assetPlan={assetPlan} value={nodeChoice} disabled={busy} placeholder={t("director.workspace.chooseSmartImageNode")} exclude={bindings.filter(binding => {
        const node = binding.sourceNode?.projectId === canvasId ? canvasNodes.find(item => item.id === binding.sourceNode?.nodeId) : undefined;
        return node?.type !== "character" || !canBindSubjectImage({ projectId: String(binding.sourceNode?.projectId || ""), nodeId: String(binding.sourceNode?.nodeId || "") }, canvasId, canvasNodes, bindings);
      }).map(binding => binding.sourceNode || {})} onUnavailable={() => setNodeChoice(undefined)} onChange={setNodeChoice} />
      {selectedSourceNode?.type === "character" ? <div className="w-full space-y-2">
        {characterSourceImages.map(({ image, index, storageKey, referenceId }) => <div key={storageKey} className="flex items-center gap-2 rounded border border-border p-2">
          <MediaImage className="h-12 w-12 shrink-0 rounded object-contain" src={image.url || backendMediaUrl(storageKey)} alt={String(image.outfit || image.name || subject.id)} />
          <span className="min-w-0 flex-1 truncate text-xs">{String(image.outfit || image.name || t("director.crud.frameNumber", { number: index + 1 }))}</span>
          <Button size="small" disabled={busy || !canBindSubjectImage(nodeChoice, canvasId, canvasNodes, bindings, storageKey)} onClick={() => void addCharacterImage(storageKey, referenceId)}>{t("director.subjectImages.addReference")}</Button>
        </div>)}
        {!characterSourceImages.length && <p className="text-xs text-muted-foreground">{t("director.subjectImages.stableMediaKeyRequired")}</p>}
      </div> : <Button size="small" disabled={busy || !nodeChoiceValid} onClick={() => void add()}>{t("director.subjectImages.addReference")}</Button>}
    </div>
    <ReferenceNodeLink sourceNode={{ projectId: canvasId }} label={t("director.subjectImages.prepareNewPicture")} />
    </section>
    </div>
  </details>;
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

function SourceField({ value, draftValue, onDraftChange, multiline, rows = 3, numeric, placeholder, ariaLabel, disabled, onCommit, commitOnBlur = true }: {
  value: unknown; draftValue?: string; onDraftChange?: (value: string | undefined) => void; multiline?: boolean; rows?: number; numeric?: boolean; placeholder?: string; ariaLabel?: string; disabled?: boolean; onCommit: (value: unknown) => Promise<boolean | void> | boolean | void;
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
    ? <Input.TextArea aria-label={ariaLabel} value={draft} autoSize={{ minRows: rows, maxRows: 12 }} disabled={disabled} placeholder={placeholder} onChange={event => { setDraft(event.target.value); onDraftChange?.(event.target.value); }} onBlur={() => { if (commitOnBlur) void save(); }} />
    : <Input aria-label={ariaLabel} value={draft} disabled={disabled} placeholder={placeholder} onChange={event => { setDraft(event.target.value); onDraftChange?.(event.target.value); }} onBlur={() => { if (commitOnBlur) void save(); }} />;
}

function CanvasAssetInfoCard({ item, busy, onSave, onRemove, canvasId }: {
  item: { node: CanvasNodeOption; kind: string; name: string; description: string; images: Array<{ storageKey?: string; url?: string; label: string; primary?: boolean }> };
  busy: boolean;
  onSave: (node: CanvasNodeOption, payload: CanvasAssetEditPayload) => Promise<boolean>;
  onRemove?: () => void;
  canvasId: string;
}) {
  const { t } = useTranslation();
  const [editOpen, setEditOpen] = useState(false);
  return <article className="flex min-w-0 gap-3 rounded-lg border border-border p-2.5" data-canvas-asset-node={item.node.id}>
    <div className="grid h-24 w-28 shrink-0 grid-cols-2 gap-1 overflow-y-auto rounded bg-muted/30 p-1">{item.images.length ? item.images.map((image, index) => {
      const imageSource = image.storageKey ? backendMediaUrl(image.storageKey) : image.url || "";
      return <div key={`${image.storageKey || image.url}:${index}`} className={`relative min-h-0 overflow-hidden rounded bg-background/40 ${item.images.length === 1 ? "col-span-2 row-span-2" : ""}`} title={image.label} aria-label={`${item.name}: ${image.label}`}>
        <MediaImage className="h-full w-full object-contain" src={imageSource} alt={`${item.name} ${image.label}`} />
        {image.primary && <span className="absolute bottom-0.5 left-0.5 rounded bg-background/80 px-1 text-[9px] leading-4 text-foreground">{t("director.workspace.currentImage")}</span>}
      </div>;
    }) : <div className="col-span-2 row-span-2 flex items-center justify-center"><ImageIcon className="size-7 text-muted-foreground/50" /></div>}</div>
    <div className="flex min-w-0 flex-1 flex-col justify-center gap-1.5">
      <div className="flex min-w-0 items-center justify-between gap-2"><strong className="min-w-0 truncate text-sm" title={item.name}>{item.name}</strong><Tag className="m-0 shrink-0">{t(`director.studio.filter.${item.kind}`)}</Tag></div>
      {item.description && <p className="line-clamp-2 text-xs text-muted-foreground">{item.description}</p>}
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1"><span className="flex flex-wrap items-center gap-1"><Button size="small" type="text" icon={<Pencil className="size-3.5" />} disabled={busy} onClick={() => setEditOpen(true)}>{t("director.crud.editCanvasAssetInfo")}</Button>{onRemove && <Button size="small" type="text" danger icon={<Trash2 className="size-3.5" />} disabled={busy} onClick={onRemove}>{t("director.crud.removeEpisodeAsset")}</Button>}</span><ReferenceNodeLink sourceNode={{ projectId: canvasId, nodeId: item.node.id }} label={t("director.crud.openEntityNode")} /></div>
    </div>
    <CanvasAssetEditModal open={editOpen} item={item} busy={busy} onCancel={() => setEditOpen(false)} onSave={payload => onSave(item.node, payload)} />
  </article>;
}

const SHOT_SOURCE_FIELDS = ["visual", "camera"] as const;
const SHOT_STATE_FIELDS = ["state_in", "state_out"] as const;
type KeyframeEditor = (input: { editing: boolean; nodeId?: string; onNodeChange: (nodeId: string) => void; onUnbind: () => void }) => ReactNode;

function BoundSubjectText({ text, shot, names }: { text: string; shot: Record<string, any>; names: Record<string, string> }) {
  const boundNames = [
    ...records(shot.subject_usages).map(usage => names[String(usage.subjectId)] || ""),
    ...(Array.isArray(shot.characters) ? shot.characters : []).map((character: any) => {
      const id = String(typeof character === "string" ? character : character?.id || character?.character_id || "");
      return String(typeof character === "object" ? character?.name || character?.display_name || names[id] : names[id] || character || "");
    }),
  ];
  const subjectNames = [...new Set(boundNames
    .filter(name => name && text.includes(name)))].sort((a, b) => b.length - a.length);
  if (!subjectNames.length) return <>{text}</>;
  const parts: Array<{ text: string; subject: boolean }> = [];
  for (let cursor = 0; cursor < text.length;) {
    const match = subjectNames
      .map(name => ({ name, index: text.indexOf(name, cursor) }))
      .filter(item => item.index >= 0)
      .sort((a, b) => a.index - b.index || b.name.length - a.name.length)[0];
    if (!match) { parts.push({ text: text.slice(cursor), subject: false }); break; }
    if (match.index > cursor) parts.push({ text: text.slice(cursor, match.index), subject: false });
    parts.push({ text: match.name, subject: true });
    cursor = match.index + match.name.length;
  }
  return <>{parts.map((part, index) => part.subject
    ? <strong key={index} className="font-semibold text-primary">{part.text}</strong>
    : part.text)}</>;
}

/**
 * 镜头源字段（画面与动作 / 机位与运镜 / 时长）的内联编辑器。
 * 原先这些字段装在「修改画面、摄影与起止状态」弹窗里；现在直接摊在页面上：
 * 右上角一枚「修改」，点开变成「保存 / 取消」，编辑期只动本地草稿，保存时把有改动的字段一次提交。
 * ⚠️ 起止状态（镜头开始时 / 镜头结束时）已按用户要求挪进左栏「连续性状态」模块（ShotStateFields），这里不再渲染，避免同一段文字重复出现。
 * ⚠️ 这是页面上「画面」的唯一展示位——别处不要再渲染 shot.visual / display_summary，否则同一段文字会重复出现。
 * ⚠️ 镜头素材不在「画面与摄影」里列（与右栏「本镜图片参考」重复）：右栏那份负责展示与跳转。
 */
function ShotSourceFields({ shot, busy, names, characters, fps, onSave, keyframeAssetId, keyframeEditor, includeCompleteSource = false }: {
  shot: Record<string, any>; busy: boolean; names: Record<string, string>;
  characters: Array<Record<string, any>>;
  fps: number;
  onSave: (patch: Record<string, unknown>, keyframeChange?: { type: "bind"; assetId: string; nodeId: string } | { type: "unbind"; shotId: string }) => Promise<boolean | void>;
  keyframeAssetId?: string;
  keyframeEditor?: KeyframeEditor;
  includeCompleteSource?: boolean;
}) {
  const { t } = useTranslation();
  const id = String(shot.id || "");
  const values: Record<string, string> = {
    visual: proseOf(shot.visual), camera: proseOf(shot.camera),
  };
  // 主体不匹配软提示（不作严格卡控）：「画面与动作」提到了未列入本镜可见主体的对象时给个提醒，不拦保存、不拦生成。
  // 只取长度大于 1 的名字并按最长名优先扫描，减少单字与子串的误报——提醒宁松勿严。
  const unboundSubjectNames = (() => {
    const text = values.visual;
    if (!text) return [];
    const registered = new Set([
      ...records(shot.subject_usages).map((usage: any) => String(names[String(usage?.subjectId)] || "")),
      ...(Array.isArray(shot.characters) ? shot.characters : []).map((character: any) => String(typeof character === "string" ? names[character] || character : character?.name || character?.display_name || names[String(character?.id || character?.character_id || "")] || "")),
    ].filter(Boolean));
    const candidates = [...new Set([...Object.values(names), ...characters.map(character => String(character?.name || character?.display_name || character?.id || "")).filter(Boolean)])]
      .filter(name => name.length > 1 && !registered.has(name)).sort((a, b) => b.length - a.length);
    if (!candidates.length) return [];
    const mentioned = new Set<string>();
    for (let cursor = 0; cursor < text.length;) {
      const match = candidates.map(name => ({ name, index: text.indexOf(name, cursor) }))
        .filter(item => item.index >= 0).sort((a, b) => a.index - b.index || b.name.length - a.name.length)[0];
      if (!match) break;
      mentioned.add(match.name);
      cursor = match.index + match.name.length;
    }
    return [...mentioned];
  })();
  // 字段可能是结构化对象（没有 prose 正文）：这时用提示文案代替空值。
  const structured = (field: string) => Boolean(shot[field]) && !proseOf(shot[field]);
  const startFrame = Number(shot.start_frame || 0);
  const frameCount = Math.max(0, Number(shot.end_frame || 0) - startFrame);
  const seconds = frameCount / fps;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [characterDraft, setCharacterDraft] = useState<string[]>([]);
  const [keyframeNodeDraft, setKeyframeNodeDraft] = useState<string>();
  const [keyframeUnbound, setKeyframeUnbound] = useState(false);
  const [secondsDraft, setSecondsDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const originalCharacters = Array.isArray(shot.characters) ? shot.characters : [];
  const visibleCharacterIds = originalCharacters.map(character => String(typeof character === "string" ? character : character?.id || character?.character_id || "")).filter(Boolean);
  const characterOptions = characters.map(character => ({ value: String(character.id), label: String(character.name || character.display_name || character.id) }));
  const characterValues = editing || saving ? characterDraft : visibleCharacterIds;
  useEffect(() => { setEditing(false); setDraft({}); setCharacterDraft([]); setSecondsDraft(""); }, [id]);
  const save = async () => {
    const patch: Record<string, unknown> = {};
    SHOT_SOURCE_FIELDS.forEach(field => { if ((draft[field] ?? "") !== values[field]) patch[field] = patchProse(shot[field], draft[field] ?? ""); });
    // 时长按秒录入，帧数由制作帧率换算：只推 end_frame（start_frame 由前序镜头决定）。
    const nextSeconds = Number(secondsDraft);
    if (secondsDraft.trim() !== "" && Number.isFinite(nextSeconds)) {
      const frames = Math.max(1, Math.round(nextSeconds * fps));
      if (frames !== frameCount) Object.assign(patch, shotDurationPatch(shot, nextSeconds, fps));
    }
    if (JSON.stringify(characterDraft) !== JSON.stringify(visibleCharacterIds)) patch.characters = characterDraft.map(characterId => originalCharacters.find(character => String(typeof character === "string" ? character : character?.id || character?.character_id || "") === characterId)
      ?? { id: characterId, name: characters.find(character => String(character.id) === characterId)?.name || characterId });
    const keyframeChange = keyframeUnbound
      ? { type: "unbind" as const, shotId: id }
      : keyframeNodeDraft && keyframeAssetId ? { type: "bind" as const, assetId: keyframeAssetId, nodeId: keyframeNodeDraft } : undefined;
    if (!Object.keys(patch).length && !keyframeChange) { setEditing(false); setDraft({}); setSecondsDraft(""); return; }
    setSaving(true);
    const saved = await onSave(patch, keyframeChange);
    setSaving(false);
    if (saved !== false) { setEditing(false); setDraft({}); setCharacterDraft([]); setSecondsDraft(""); setKeyframeNodeDraft(undefined); setKeyframeUnbound(false); }
  };
  return <section className="space-y-4" data-shot-source-fields={id}>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="text-sm font-medium">{t("director.studio.shotSource")}</h3>
      {editing ? <div className="flex items-center gap-2" data-shot-source-actions>
        <Button size="small" type="primary" icon={<Check className="size-3.5" />} loading={saving} disabled={busy || saving} onClick={() => void save()}>{t("common.save")}</Button>
        <Button size="small" disabled={saving} onClick={() => { setDraft({}); setCharacterDraft([]); setSecondsDraft(""); setKeyframeNodeDraft(undefined); setKeyframeUnbound(false); setEditing(false); }}>{t("common.cancel")}</Button>
      </div> : <Button size="small" type="text" data-shot-source-edit icon={<Pencil className="size-3.5" />} disabled={busy} onClick={() => { setDraft({ ...values }); setCharacterDraft((Array.isArray(shot.characters) ? shot.characters : []).map((character: any) => String(typeof character === "string" ? character : character?.id || character?.character_id || "")).filter(Boolean)); setSecondsDraft(String(Number(seconds.toFixed(3)))); setKeyframeNodeDraft(undefined); setKeyframeUnbound(false); setEditing(true); }}>{t("director.studio.editShotFields")}</Button>}
    </div>
    <div className="space-y-4">
      {keyframeEditor?.({ editing, nodeId: keyframeNodeDraft, onNodeChange: nodeId => { setKeyframeNodeDraft(nodeId); setKeyframeUnbound(false); }, onUnbind: () => { setKeyframeNodeDraft(undefined); setKeyframeUnbound(true); } })}
      <label className="grid gap-2"><span className="text-xs text-muted-foreground">{t("director.atomic.visibleSubjects")}</span><Select mode="multiple" value={characterValues} loading={busy || saving} disabled={!editing || busy || saving} options={characterOptions} onChange={ids => setCharacterDraft(ids)} /></label>
      {SHOT_SOURCE_FIELDS.map(field => <div key={field} className="grid gap-2">
        <span className="text-xs text-muted-foreground">{t(`director.studio.shotField.${field}`)}</span>
        {editing
          ? <Input.TextArea value={draft[field] ?? ""} autoSize={{ minRows: 3, maxRows: 12 }} disabled={busy || saving} placeholder={structured(field) ? t("director.studio.structuredState") : undefined} onChange={event => setDraft(current => ({ ...current, [field]: event.target.value }))} />
          : values[field] ? <p className="whitespace-pre-wrap break-words text-sm leading-7"><BoundSubjectText text={values[field]} shot={shot} names={names} /></p> : <p className="text-sm text-muted-foreground">{structured(field) ? t("director.studio.structuredState") : "—"}</p>}
      </div>)}
    </div>
    {unboundSubjectNames.length > 0 && !editing && <p className="flex items-start gap-1.5 rounded-md bg-amber-50 px-2.5 py-1.5 text-xs leading-5 text-amber-700 dark:bg-amber-950/30 dark:text-amber-400" data-shot-subject-mismatch><TriangleAlert className="mt-px size-3.5 shrink-0" /><span>{t("director.studio.shotSubjectMismatch", { names: unboundSubjectNames.join(", ") })}</span></p>}
        <div className="grid gap-2" data-shot-duration>
      <span className="text-xs text-muted-foreground">{t("director.studio.durationSeconds")}</span>
      {editing
        ? <div className="flex flex-wrap items-baseline gap-3"><InputNumber className="w-32" min={0.1} step={0.5} precision={2} addonAfter={t("director.studio.secondsUnit")} value={secondsDraft === "" ? null : Number(secondsDraft)} disabled={busy || saving} onChange={value => setSecondsDraft(value === null || value === undefined ? "" : String(value))} /><span className="text-xs text-muted-foreground">{t("director.studio.frameRange", { start: startFrame, end: startFrame + Math.max(1, Math.round(Number(secondsDraft || seconds) * fps)) })}</span></div>
        : <p className="text-sm tabular-nums">{formatSeconds(seconds)}s · {t("director.studio.frameRange", { start: startFrame, end: startFrame + frameCount })}</p>}
    </div>
    {/* A 类补齐：源稿结构化声音（foley / low_frequency_hz）原先完全不可见，这里就地编辑，走 shot patch 链路。 */}
    <details className="rounded-lg border border-border" data-shot-audio-design open={Boolean((shot.audio as Record<string, any> | undefined)?.foley?.length)}><summary className="cursor-pointer select-none px-3 py-2 text-xs font-medium text-muted-foreground"><span className="flex items-center gap-1.5"><Volume2 className="size-3.5" />{t("director.atomic.soundDesign")}</span></summary>{shot.audio && typeof shot.audio === "object" && !Array.isArray(shot.audio) ? <div className="p-3 pt-2"><AudioDesignEditor value={shot.audio} disabled={busy || saving} onPersist={async nextAudio => { if (saving) return false; setSaving(true); const saved = await onSave({ audio: nextAudio }); setSaving(false); return saved !== false; }} /></div> : <p className="px-3 pb-3 text-xs text-muted-foreground">{t("director.atomic.noStructuredAudio")}</p>}</details>
 {/* B 类补齐：镜头特性即时保存，兼容尚未初始化 features 的旧源稿。 */}
 {(() => { const current = shot.features && typeof shot.features === "object" && !Array.isArray(shot.features) ? shot.features as Record<string, unknown> : {}; const features = { core_emotion: false, combat: false, supernatural_vfx: false, colossal: false, ...current }; return <><div className="flex flex-wrap gap-x-4 gap-y-2 rounded-lg border border-border px-3 py-2" data-shot-features aria-label={t("director.studio.shotFeatures")}>{Object.entries(features).map(([key, value]) => <label key={key} className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground"><Switch size="small" checked={Boolean(value)} disabled={busy || saving} onChange={next => { const updated = { ...features, [key]: next }; void onSave({ features: updated, ...(key === "combat" ? next ? (!shot.combat ? { combat: {} } : {}) : { combat: null } : {}) }); }} />{t(`director.studio.shotFeature.${key}`, key)}</label>)}</div>
 <details className="rounded-lg border border-border p-3" data-shot-performance-editor><summary className="cursor-pointer text-xs font-medium">{t("director.studio.performancePayload")}</summary><div className="mt-2"><SourceJsonEditor title={t("director.studio.performancePayload")} hint={t("director.studio.performancePayloadHint")} value={shot.performance} fieldOrder={PERFORMANCE_JSON_FIELD_ORDER} nestedFieldOrder={PERFORMANCE_JSON_NESTED_FIELD_ORDER} disabled={busy || saving} onSave={next => onSave({ performance: next })} /></div></details>
 {Boolean(features.combat || shot.combat) && <details className="rounded-lg border border-border p-3" data-shot-combat-editor><summary className="cursor-pointer text-xs font-medium">{t("director.studio.combatPayload")}</summary><div className="mt-2"><SourceJsonEditor title={t("director.studio.combatPayload")} hint={t("director.studio.combatPayloadHint")} value={shot.combat} fieldOrder={COMBAT_JSON_FIELD_ORDER} nestedFieldOrder={COMBAT_JSON_NESTED_FIELD_ORDER} disabled={busy || saving} onSave={next => onSave({ combat: next })} /></div></details>}</>; })()}
    {includeCompleteSource && <details className="text-xs text-muted-foreground" data-shot-complete-source-details><summary className="cursor-pointer">{t("director.studio.shotCompleteSource")}</summary><div className="mt-3" data-shot-complete-source><SourceData value={shot} names={names} /></div></details>}
  </section>;
}

/**
 * 起止状态（镜头开始时 / 镜头结束时）的展示与内联编辑，归左栏「连续性状态」模块：
 * 原先摊在「画面与摄影」里，与连续性语境割裂；挪过来后和台账状态、边界开关同区阅读。
 * 保存仍走 shot patch 链路（onPatch("shot", id, patch)），只提交有改动的字段。
 */
function ShotStateFields({ shot, busy, onSave }: {
  shot: Record<string, any>; busy: boolean;
  onSave: (patch: Record<string, unknown>) => Promise<boolean | void>;
}) {
  const { t } = useTranslation();
  const id = String(shot.id || "");
  const values: Record<string, string> = {
    state_in: proseOf(shot.state_in), state_out: proseOf(shot.state_out),
  };
  // 起止状态可能是结构化对象（没有 prose 正文）：这时用提示文案代替空值。
  const structured = (field: string) => Boolean(shot[field]) && !proseOf(shot[field]);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  useEffect(() => { setEditing(false); setDraft({}); }, [id]);
  const save = async () => {
    const patch: Record<string, unknown> = {};
    SHOT_STATE_FIELDS.forEach(field => { if ((draft[field] ?? "") !== values[field]) patch[field] = patchProse(shot[field], draft[field] ?? ""); });
    if (!Object.keys(patch).length) { setEditing(false); setDraft({}); return; }
    setSaving(true);
    const saved = await onSave(patch);
    setSaving(false);
    if (saved !== false) { setEditing(false); setDraft({}); }
  };
  return <div className="space-y-2" data-shot-state-fields={id}>
    <div className="flex items-center justify-end gap-2" data-shot-state-actions>
      {editing ? <>
        <Button size="small" type="primary" icon={<Check className="size-3.5" />} loading={saving} disabled={busy || saving} onClick={() => void save()}>{t("common.save")}</Button>
        <Button size="small" disabled={saving} onClick={() => { setDraft({}); setEditing(false); }}>{t("common.cancel")}</Button>
      </> : <Button size="small" type="text" data-shot-state-edit icon={<Pencil className="size-3.5" />} disabled={busy} onClick={() => { setDraft({ ...values }); setEditing(true); }}>{t("director.studio.editShotFields")}</Button>}
    </div>
    <div className="grid gap-4 sm:grid-cols-2">
      {SHOT_STATE_FIELDS.map(field => <div key={field} className="grid gap-2">
        <span className="text-xs text-muted-foreground">{t(`director.studio.shotField.${field}`)}</span>
        {editing
          ? <Input.TextArea value={draft[field] ?? ""} autoSize={{ minRows: 2, maxRows: 8 }} disabled={busy || saving} placeholder={structured(field) ? t("director.studio.structuredState") : undefined} onChange={event => setDraft(current => ({ ...current, [field]: event.target.value }))} />
          : values[field] ? <p className="whitespace-pre-wrap break-words text-sm leading-7">{values[field]}</p> : <p className="text-sm text-muted-foreground">{structured(field) ? t("director.studio.structuredState") : "—"}</p>}
      </div>)}
    </div>
  </div>;
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
  return <article className="rounded-lg border border-border bg-card p-4">
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

function SubjectClipPartitionEditor({ shots, segments, fps, busy, shotTitle, onSave, draftValue, onDraftChange }: {
  shots: Array<Record<string, any>>; segments: Array<Record<string, any>>; fps: number; busy: boolean;
  shotTitle: (id: string) => string;
  onSave: (shotIds: string[], groups: Array<Record<string, unknown>>) => Promise<boolean>;
  draftValue?: string; onDraftChange: (value: string | undefined) => void;
}) {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const [saving, setSaving] = useState(false);
  const adjacency = (left: Record<string, any>, right: Record<string, any>) => `${left.id}\0${right.id}`;
  const initialCuts = () => {
    const groups = new Map(segments.flatMap(segment => (segment.shot_ids || []).map((id: string) => [String(id), String(segment.id)] as const)));
    return new Set(shots.slice(0, -1).flatMap((shot, index) => {
      const next = shots[index + 1];
      return shot.timeline_id !== next.timeline_id || groups.get(String(shot.id)) !== groups.get(String(next.id)) ? [adjacency(shot, next)] : [];
    }));
  };
  const base = JSON.stringify({ shots: shots.map(shot => [shot.id, shot.timeline_id, shot.duration_frames]), clips: segments.map(segment => [segment.id, segment.shot_ids, segment.mode, segment.mode_lock, segment.mode_selection_reason, segment.styleTemplateId]) });
  const { draft: preserved, invalid: invalidDraft, sourceChanged } = readClipPartitionDraft(draftValue, base);
  const cuts = new Set(preserved?.cuts || initialCuts()), profileChoices = preserved?.profileChoices || {};
  const disabled = busy || saving || sourceChanged || invalidDraft;
  const updatePartition = (nextCuts: Set<string>, nextProfiles = profileChoices) => onDraftChange(JSON.stringify({ base: preserved?.base || base, cuts: [...nextCuts], profileChoices: nextProfiles }));
  const dirty = JSON.stringify([...cuts].sort()) !== JSON.stringify([...initialCuts()].sort()) || Object.keys(profileChoices).length > 0;
  const groups: Array<Record<string, any>> = [];
  let current: Record<string, any>[] = [];
  for (let index = 0; index < shots.length; index++) {
    const shot = shots[index]; current.push(shot);
    if (index === shots.length - 1 || shot.timeline_id !== shots[index + 1].timeline_id || cuts.has(adjacency(shot, shots[index + 1]))) { if (current.length) groups.push({ shots: current }); current = []; }
  }
  const groupProfiles = groups.map(group => {
    const ids = group.shots.map((shot: Record<string, any>) => String(shot.id));
    const old = segments.filter(segment => (segment.shot_ids || []).some((id: string) => ids.includes(String(id))));
    const profiles = new Map(old.map(segment => [JSON.stringify({ mode: segment.mode, mode_lock: segment.mode_lock, mode_selection_reason: segment.mode_selection_reason, styleTemplateId: segment.styleTemplateId }), segment]));
    return { ids, old, profiles, exact: old.find(segment => JSON.stringify(segment.shot_ids || []) === JSON.stringify(ids)) };
  });
  const materialize = () => groups.map(group => {
    const ids = group.shots.map((shot: Record<string, any>) => String(shot.id)), profile = groupProfiles.find(item => JSON.stringify(item.ids) === JSON.stringify(ids))!;
    const chosenProfile = profile.exact || (profile.profiles.size === 1 ? [...profile.profiles.values()][0] : profile.old.find(item => item.id === profileChoices[ids.join("|")]));
    return { ...(profile.exact ? { id: profile.exact.id } : {}), shot_ids: ids,
      ...(!profile.exact && profile.profiles.size > 1 && chosenProfile ? { executionProfileSourceId: chosenProfile.id } : {}),
      ...(chosenProfile ? { mode: chosenProfile.mode, mode_lock: chosenProfile.mode_lock, mode_selection_reason: chosenProfile.mode_selection_reason, ...(Object.hasOwn(chosenProfile, "styleTemplateId") ? { styleTemplateId: chosenProfile.styleTemplateId } : {}) } : {}) };
  });
  const unresolvedProfile = groupProfiles.some(profile => !profile.exact && profile.profiles.size > 1 && !profileChoices[profile.ids.join("|")]);
  const save = async () => {
    if (disabled) return;
    setSaving(true);
    try { if (await onSave(shots.map(shot => String(shot.id)), materialize())) { onDraftChange(undefined); message.success(t("director.workspace.clipPartitionSaved")); } }
    catch (error) { message.error(error instanceof Error ? error.message : String(error)); }
    finally { setSaving(false); }
  };
  if (!shots.length) return <Alert type="info" message={t("director.workspace.noSegments")} />;
  return <section className="space-y-3 rounded-lg border border-border bg-card p-4" data-subject-clip-partition>
    <div><h3 className="font-semibold">{t("director.workspace.clipPartition")}</h3><p className="mt-1 text-xs text-muted-foreground">{t("director.workspace.clipPartitionHint")}</p></div>
    {(sourceChanged || invalidDraft) && <Alert type="warning" message={t(invalidDraft ? "director.atomic.invalidDraft" : "director.atomic.sourceChanged")} description={<div className="space-y-2"><details><summary>{t("director.atomic.reviewDraft")}</summary><pre className="max-h-48 overflow-auto whitespace-pre-wrap text-xs">{draftValue}</pre></details><Button size="small" disabled={busy || saving} onClick={() => onDraftChange(undefined)}>{t("director.atomic.resetDraft")}</Button></div>} />}
    {groupProfiles.filter(profile => !profile.exact && profile.profiles.size > 1).map(profile => <label key={profile.ids.join("|")} className="grid gap-1 text-sm"><span>{t("director.workspace.chooseExecutionProfile", { shots: profile.ids.length })}</span><Select value={profileChoices[profile.ids.join("|")]} disabled={disabled} placeholder={t("director.workspace.chooseExecutionProfilePlaceholder")} options={profile.old.map(item => ({ value: String(item.id), label: `${item.mode || "H3"} · ${String(item.id)}` }))} onChange={value => updatePartition(cuts, { ...profileChoices, [profile.ids.join("|")]: value })} /></label>)}
    <div className="space-y-2">{shots.map((shot, index) => {
      const duration = Number(shot.duration_frames || 0) / fps;
      const cut = index < shots.length - 1 && (shot.timeline_id !== shots[index + 1].timeline_id || cuts.has(adjacency(shot, shots[index + 1])));
      return <div key={shot.id}>
        <div className="flex items-center justify-between gap-3 rounded-lg bg-muted/30 p-3"><div className="min-w-0"><strong className="block truncate text-sm">{shotTitle(String(shot.id))}</strong><span className="text-xs text-muted-foreground">{formatSeconds(duration)}s · {String(shot.mode || "Shot")}</span></div><Tag>{(shot.subject_usages || []).length} {t("director.workspace.subjectCount")}</Tag></div>
        {index < shots.length - 1 && <label className="flex items-center justify-between gap-3 border-l border-border py-2 pl-4 text-xs text-muted-foreground"><span>{t("director.workspace.clipBoundaryBetween", { left: shotTitle(String(shot.id)), right: shotTitle(String(shots[index + 1].id)) })}</span><Switch checked={cut} disabled={disabled || shot.timeline_id !== shots[index + 1].timeline_id} onChange={value => { const next = new Set(cuts); const key = adjacency(shot, shots[index + 1]); if (value) next.add(key); else next.delete(key); updatePartition(next); }} /></label>}
      </div>;
    })}</div>
    <p className="text-xs text-muted-foreground">{groups.map(group => t("director.workspace.clipDerivedDuration", { duration: formatSeconds(group.shots.reduce((sum: number, shot: Record<string, any>) => sum + Number(shot.duration_frames || 0), 0) / fps), count: group.shots.length })).join(" · ")}</p>
    <Button type="primary" size="small" loading={saving} disabled={disabled || unresolvedProfile || !dirty} onClick={() => void save()}>{t("director.workspace.saveClipPartition")}</Button>
  </section>;
}

export function DirectorPanel({
  workspace, director, production, readiness, run, batches, runtimeTasks = [], canvasNodes, versions, busy, canvasId, canvasRole, focusTarget, embedded = false, continuityReport, continuitySnapshotLoading = false,
  briefDraft, onBriefDraftChange, onOpenSharedAsset, onPromoteExistingSharedAsset,
  onPrepareEntities, onUpsertSubject, onDeleteSubject, onDeleteScene, onDeleteAsset, onRemoveCanvasAsset, onPatchCanvasAsset, onCreateManualAsset, onSaveV2Shot, onRepartitionClips, onEditShot,
  compact = false, navigationTitleVisible = false, onSaveScript, generationSupported = true, assetScopeHint,
  onBrief, onPatch, onEditCanvasClip, onAdoptDirectorFields, onAdoptClipStyle, onRegroup, onWorkflow, onSettings, onSourceDraftChange, sourceDrafts, onBindAsset, onBoundary, onPublish, onReplace, onAskDirector, onAnswerDecision, onNavigate, onLocateTarget, onStart, onPause, onResume, onRestore, onRefresh, onSceneCommand, sceneCommandPending, onExport, exporting, runStartPending, activeTargetIds, onSaveContinuity, onCheckContinuity, onContinuitySnapshot,
  onCompile, compileBusy = false, compilePending = false, compileError = "", compileNotice = "", compileDiagnostics = [], compileTargets,
}: {
  workspace: DirectorWorkspace; director?: DirectorProduction; production: EpisodeProduction; readiness?: ProductionReadiness; run?: ProductionBatch | null;
  continuityReport?: import("@/services/backend-api").ProductionContinuity;
  continuitySnapshotLoading?: boolean;
  focusTarget?: string;
  embedded?: boolean;
  navigationTitleVisible?: boolean;
  briefDraft: string;
  onBriefDraftChange: (value: string) => void;
  compact?: boolean;
  generationSupported?: boolean;
  assetScopeHint?: string;
  onSaveScript?: (ids: string[]) => Promise<boolean>;
  batches: ProductionBatch[]; canvasNodes: CanvasNodeOption[]; versions: ProductionVersion[]; busy: boolean; canvasId: string;
  canvasRole: "ordinary" | "episode" | "shared-assets" | "standalone" | "scene";
  onOpenSharedAsset: (assetId: string, title: string) => void;
  onPromoteExistingSharedAsset: (assetId: string, title: string) => void;
  runtimeTasks?: BackendRuntimeTask[];
  onBrief: (brief: string) => Promise<void> | void;
  onPatch: (entity: "style" | "spec" | "story" | "scene" | "environment" | "character" | "asset" | "asset_card" | "shot" | "segment", id: string | undefined, patch: Record<string, unknown>) => Promise<boolean> | void;
  onPrepareEntities?: () => Promise<void>;
  onUpsertSubject?: (subject: Extract<ProductionOperation, { type: "upsert_director_subject" }>["subject"]) => Promise<boolean>;
  onDeleteSubject?: (id: string) => Promise<boolean>;
  onDeleteScene?: (sceneId: string) => Promise<boolean>;
  onDeleteAsset?: (assetId: string) => Promise<boolean>;
  onRemoveCanvasAsset?: (nodeId: string) => Promise<boolean>;
  onPatchCanvasAsset?: (node: CanvasNodeOption, payload: CanvasAssetEditPayload) => Promise<boolean>;
  onCreateManualAsset: (operation: Extract<ProductionOperation, { type: "create_manual_director_asset" }>) => Promise<boolean>;
  onSaveV2Shot?: (shotId: string, patch: Record<string, unknown>, keyframes?: Extract<ProductionOperation, { type: "set_director_shot_keyframes" }>["keyframes"], utterances?: Extract<ProductionOperation, { type: "set_director_shot_utterances" }>["utterances"]) => Promise<boolean>;
  onRepartitionClips?: (shotIds: string[], segments: Array<Record<string, unknown>>) => Promise<boolean>;
  onEditShot?: (operation: Extract<ProductionOperation, { type: "edit_director_shot" }>) => Promise<boolean>;

  onEditCanvasClip?: (nodeId: string, segmentId: string, patch: Record<string, unknown>) => Promise<boolean>;
  onAdoptDirectorFields?: (targetId: string, nodeId: string, segmentId: string | undefined, fields: string[]) => Promise<boolean>;
  onAdoptClipStyle?: (targetId: string, styleTemplateId: string | null) => Promise<boolean>;
  onRegroup: (segmentId: string, shotIds: string[], removeSegmentIds: string[]) => Promise<boolean> | void;
  sourceDrafts: Record<string, string>;
  onSourceDraftChange: (key: string, value: string | undefined) => void;
  onWorkflow: (patch: Partial<DirectorProduction["workflow"]>) => void;
  onSettings: (patch: Partial<EpisodeProduction['draft']['settings']>) => void;
  onBindAsset: (assetId: string, nodeId: string) => Promise<boolean>;
  onBoundary: (boundary: DirectorProduction["boundaries"][number]) => void;
  onSaveContinuity?: (ledger: Record<string, unknown>) => Promise<boolean>;
  onCheckContinuity?: () => Promise<void>;
  onContinuitySnapshot?: (value: "draft" | "published") => void;
  onPublish: () => void;
  onReplace: (value: DirectorProduction) => Promise<boolean> | void;
  onAskDirector: (scope: { workspace: DirectorWorkspace; targetId?: string; instruction?: string; brief?: string; workId?: string }) => void;
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
  onCompile?: (sceneId?: string) => void;
  compileBusy?: boolean;
  compilePending?: boolean;
  compileError?: string;
  compileNotice?: string;
  compileDiagnostics?: ProductionCompilationDiagnostic[];
  compileTargets?: { sourceHash: string; items: Array<{ targetId: string; status: string }> };
  runStartPending: boolean;
  activeTargetIds: string[];
}) {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const [activeSceneKey, setActiveSceneKey] = useState('');
  const [overviewShotId, setOverviewShotId] = useState('');
  const [overviewMediaErrors, setOverviewMediaErrors] = useState<Record<string, boolean>>({});
  useEffect(() => { setOverviewShotId(''); setOverviewMediaErrors({}); }, [canvasId, production.episodeId]);
  const [editingScript, setEditingScript] = useState(false);
  const [assetFilter, setAssetFilter] = useState('all');
  const [assetSearch, setAssetSearch] = useState('');
  const [newSubjectOpen, setNewSubjectOpen] = useState(false);
  const [newSubjectEntity, setNewSubjectEntity] = useState<string>();
  const [newAssetOpen, setNewAssetOpen] = useState(false);
  const [newAssetKind, setNewAssetKind] = useState<ManualAssetKind>("prop");
  const [newAssetName, setNewAssetName] = useState("");
  const [newAssetDescription, setNewAssetDescription] = useState("");
  const [newAssetPrompt, setNewAssetPrompt] = useState("");
  const [newAssetPurpose, setNewAssetPurpose] = useState("");
  const [creatingAsset, setCreatingAsset] = useState(false);
  const [selectedAssetId, setSelectedAssetId] = useState('');
  const [selectedSubjectId, setSelectedSubjectId] = useState('');
  const [selectedDeliveryId, setSelectedDeliveryId] = useState('');
  const [selectedGenerationId, setSelectedGenerationId] = useState('');
  const [videoPreviewErrors, setVideoPreviewErrors] = useState<Record<string, string>>({});
  const [assetPreviewKeys, setAssetPreviewKeys] = useState<Record<string, string>>({});
  const [json, setJson] = useState<string | null>(null);
  const [error, setError] = useState("");
  const storyboardViews = useRef<Record<string, StoryboardViewMemory>>({});
  const [decisionReplies, setDecisionReplies] = useState<Record<string, string>>({});
  // 预览统一走全站唯一弹窗（MediaPreviewHost）：这里只提交请求，不再自带 Modal。
  const previewOpen = useMediaPreviewStore(state => Boolean(state.request));
  const setMediaPreview = (next: { assetId: string; title: string; storageKey: string } | null) => {
    if (!next?.storageKey) { useMediaPreviewStore.getState().close(); return; }
    useMediaPreviewStore.getState().open({ url: backendMediaUrl(next.storageKey), name: next.title, type: /\.(mp4|webm|mov)(?:$|\?)/i.test(next.storageKey) ? "video" : "image" });
  };
  const [includeGeneratedMedia, setIncludeGeneratedMedia] = useState(false);
  const [downloadingAllClips, setDownloadingAllClips] = useState(false);
  const d = director;
  const subjectOwner: ProductionTarget = canvasRole === "scene" ? { sceneId: production.episodeId } : canvasRole === "ordinary" || canvasRole === "standalone" || canvasRole === "shared-assets" ? { projectId: canvasId } : production.episodeId;
  const source = d?.source || {};
  const scriptScenes = Array.isArray(source.script_scenes) ? source.script_scenes.map(value => value && typeof value === "object" ? value as Record<string, any> : {}) : [];
  const assetPlan = Array.isArray(source.asset_plan) ? source.asset_plan.map(value => value && typeof value === "object" ? value as Record<string, any> : {}) : [];
  const hasMissingEntityNode = Boolean(d && productionEntities(source, { kind: typeof subjectOwner === "string" ? "episode" : "canvas", id: typeof subjectOwner === "string" ? subjectOwner : canvasId }).some(entity => !canvasNodes.some(node => matchesProductionEntityTarget(productionEntityBinding(node.metadata?.productionEntity), { ...entity, ownerKind: typeof subjectOwner === "string" ? "episode" : "canvas", ownerId: typeof subjectOwner === "string" ? subjectOwner : canvasId }))));
  const styleAnchorNodeReference = String(source.style_anchor_node_id || "");
  const styleAnchorAssetId = styleAnchorNodeReference ? "" : String((source.style_lock as Record<string, unknown> | undefined)?.anchor_asset_id || "");
  const styleAnchorPlan = styleAnchorAssetId ? assetPlan.find(item => String(item.asset_id || item.id || "") === styleAnchorAssetId && (String(item.role || item.asset_type || "").toUpperCase() === "STYLE_MOTHER" || String(item.kind || "").toLowerCase() === "style")) : undefined;
  const styleAnchorNodeId = String(d?.assets[styleAnchorAssetId]?.nodeId || "");
  const styleAnchorScope = String(styleAnchorPlan?.canvas_scope || (d?.assets[styleAnchorAssetId]?.sharedSource || canvasRole === "shared-assets" ? "shared" : "episode"));
  const canPrepareStyleAnchor = Boolean(styleAnchorPlan && styleAnchorScope === (canvasRole === "shared-assets" ? "shared" : "episode"));
  const hasMissingStyleAnchorNode = Boolean(canPrepareStyleAnchor && !canvasNodes.some(node => node.id === styleAnchorNodeId || String(node.metadata?.productionAssetId || "") === styleAnchorAssetId));
  const subjectAssembly = isSubjectPromptAssembly(source);
  const subjectWindows = subjectAssembly ? subjectShotWindows(source) : new Map();
  const sourceShots = Array.isArray(source.shots) ? source.shots.map(value => {
    const shot = value && typeof value === "object" ? value as Record<string, any> : {};
    const window = subjectWindows.get(String(shot.id));
    return window ? { ...shot, start_frame: window.startFrame, end_frame: window.endFrame } : shot;
  }) : [];
  if (subjectAssembly) sourceShots.sort((a, b) => Number(a.story_order) - Number(b.story_order));
  const segments = Array.isArray(source.segments) ? source.segments.map(value => value && typeof value === "object" ? value as Record<string, any> : {}) : [];
  const characters = records(source.character_registry);
  const locations = records(source.scene_registry);
  const story = source.story && typeof source.story === 'object' ? source.story as Record<string, any> : {};
  const sceneGroups = useMemo(() => groupScriptScenes(scriptScenes), [JSON.stringify(scriptScenes)]);
  const nameMap = Object.fromEntries([
    ...[...characters, ...locations].map(item => [String(item.id || ''), String(item.name || item.scene_name || '')]),
    ...records(source.subject_registry).map(subject => {
      const entityId = String(subject.entityRef?.id || "");
      const entity = [...characters, ...locations, ...assetPlan].find(item => String(item.id || item.asset_id || "") === entityId);
      return [String(subject.id || ""), String(subject.name || entity?.name || entity?.asset_name || entity?.scene_name || "")];
    }),
  ].filter(([id, name]) => id && name));
  const focusedId = focusTarget?.replace(/^[^:]+:/, '') || '';
  useEffect(() => {
    const focused = sceneGroups.find(group => group.key === focusedId || group.sceneId === focusedId || group.blocks.some(block => String(block.id) === focusedId));
    if (focused) setActiveSceneKey(focused.key);
    else if (!sceneGroups.some(group => group.key === activeSceneKey)) setActiveSceneKey(sceneGroups[0]?.key || '');
  }, [focusedId, JSON.stringify(sceneGroups.map(group => group.key))]);
  useEffect(() => { if (focusTarget?.startsWith('asset:') || focusTarget?.startsWith('frame:')) { setAssetFilter('all'); setAssetSearch(''); } }, [focusTarget]);
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
  const addManualAsset = async () => {
    if (!d || !newAssetName.trim()) return;
    setCreatingAsset(true);
    try {
      const id = `AST_${nanoid()}`;
      const entityId = newAssetKind === "character" ? `CHAR_${nanoid()}` : newAssetKind === "scene" ? `SCENE_${nanoid()}` : undefined;
      const ownerKind = typeof subjectOwner === "string" ? "episode" : "canvas";
      const ownerId = typeof subjectOwner === "string" ? subjectOwner : canvasId;
      const created = createManualDirectorAsset(d.source as Record<string, any>, {
        id,
        ...(entityId ? { entityId } : {}),
        ...(subjectAssembly ? { subjectId: `SUBJECT_${nanoid()}` } : {}),
        kind: newAssetKind,
        name: newAssetName,
        description: newAssetDescription,
        prompt: newAssetPrompt,
        purpose: newAssetPurpose,
        canvasScope: canvasRole === "shared-assets" ? "shared" : canvasRole === "episode" ? "episode" : undefined,
        registerSubject: subjectAssembly,
        ownerKind,
        ownerId,
      });
      const operation = {
        type: "create_manual_director_asset" as const,
        assetPlan: created.assetPlan,
        assetCard: created.assetCard,
        ...(created.registryKind && created.registryEntity ? { registryKind: created.registryKind, registryEntity: created.registryEntity } : {}),
        ...(created.subject ? { subject: created.subject } : {}),
      } as Extract<ProductionOperation, { type: "create_manual_director_asset" }>;
      const saved = await onCreateManualAsset(operation);
      if (saved === false) return;
      setNewAssetOpen(false);
      setNewAssetName(""); setNewAssetDescription(""); setNewAssetPrompt(""); setNewAssetPurpose("");
      setSelectedAssetId(id);
      message.success(t("director.crud.manualAssetAdded"));
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : String(cause));
    } finally { setCreatingAsset(false); }
  };

  const addScene = async () => {
    if (!d) return;
    const created = createManualScriptScene(d.source as Record<string, any>, {
      blockId: nanoid(),
      sceneId: `SCENE_${nanoid()}`,
      name: t('director.workspace.untitledScene'),
      defaultTimelineName: t("director.crud.defaultTimeline"),
    });
    const nextSource = created.source;
    const sourceHash = await (async () => {
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalProduction(nextSource)));
      return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    })();
    const workflow = d.workflow.currentWork ? { ...d.workflow, currentWork: { ...d.workflow.currentWork, sourceHash } } : d.workflow;
    const nextDirector = { ...d, source: nextSource, sourceHash, artifacts: d.artifacts.map(item => ({ ...item, status: "stale" as const })), executionAuthorized: false, workflow };
    const saved = await onReplace(nextDirector);
    if (saved !== false) setActiveSceneKey(created.occurrence.id);
  };
  const deleteScene = (group: ReturnType<typeof groupScriptScenes>[number], index: number) => {
    Modal.confirm({
      title: t('director.workspace.deleteSceneTitle'),
      content: t('director.workspace.deleteSceneConfirm', { scene: sceneTitle(group, index), blocks: Array.isArray(group.blocks[0]?.blocks) ? group.blocks[0].blocks.length : group.blocks.length }),
      okText: t('director.workspace.deleteSceneConfirmButton'),
      okButtonProps: { danger: true, disabled: busy },
      cancelText: t('director.workspace.cancel'),
      onOk: async () => {
        const saved = await onDeleteScene?.(String(group.key));
        if (saved !== false && sceneGroups.length > 1) setActiveSceneKey(sceneGroups[Math.min(index, sceneGroups.length - 2)]?.key || sceneGroups[0]?.key || '');
      },
    });
  };
  const deleteAsset = (assetId: string) => Modal.confirm({
    title: t("director.workspace.deleteAssetTitle", { asset: assetName(assetId) }),
    content: t("director.workspace.deleteAssetConfirm", { asset: assetName(assetId) }),
    okText: t("director.workspace.deleteAssetAction"),
    okButtonProps: { danger: true, disabled: busy },
    cancelText: t("director.workspace.cancel"),
    onOk: async () => {
      if (!await onDeleteAsset?.(assetId)) throw new Error(t("director.workspace.deleteAssetFailed"));
    },
  });
  const removeCanvasAsset = (nodeId: string, name: string) => Modal.confirm({
    title: t("director.crud.removeEpisodeAssetTitle", { asset: name }),
    content: t("director.crud.removeEpisodeAssetConfirm"),
    okText: t("director.crud.removeEpisodeAsset"),
    okButtonProps: { danger: true, disabled: busy },
    cancelText: t("director.workspace.cancel"),
    onOk: async () => {
      if (!await onRemoveCanvasAsset?.(nodeId)) throw new Error(t("director.crud.removeEpisodeAssetFailed"));
    },
  });
  const frameForShot = (id: string) => {
    const input = d?.shotInputs[id];
    if (input?.keyframePolicy === "none") return "";
    const key = input?.keyframeAssetId;
    if (key) {
      const draftAsset = d?.assets[key];
      const draftImage = draftAsset?.storageKey;
      if (draftImage) return draftImage;
      const publishedAsset = publishedDirector?.assets[key];
      const publishedBindingMatches = publishedDirector?.shotInputs[id]?.keyframeAssetId === key
        && (!draftAsset?.nodeId || publishedAsset?.nodeId === draftAsset.nodeId);
      return publishedBindingMatches ? publishedAsset?.storageKey || "" : "";
    }
    return production.draft.keyframes[id]?.storageKey || production.published?.keyframes[id]?.storageKey;
  };
  const mode = d?.workflow.mediaProductionMode || "per_item";
  const delivery = d?.workflow.contentDeliveryMode || "auto_file_batch";
  const publishedDirector = production.published?.director;
  useEffect(() => {
    const reason = json !== null ? t("productionHub.follow.modalOpen")
      : previewOpen ? t("productionHub.follow.modalOpen")
        : briefDraft !== String(source.brief || "") ? t("productionHub.follow.saveEditsFirst") : "";
    useProductionFollowStore.getState().setGuardReason("director-panel", reason);
    return () => useProductionFollowStore.getState().setGuardReason("director-panel", "");
  }, [json, previewOpen, briefDraft, source.brief, t]);

  const readinessCounts = useMemo(() => {
    const items = readiness?.targets || [];
    return {
      ready: items.filter(item => item.status === "ready").length,
      blocked: items.filter(item => item.status === "blocked").length,
      review: items.filter(item => item.status === "needs_review").length,
      done: items.filter(item => item.status === "complete").length,
      readyAssets: items.filter(item => item.kind === "asset" && item.status === "ready").length,
      readyKeyframes: items.filter(item => item.kind === "keyframe" && item.status === "ready").length,
      readySegments: items.filter(item => item.kind === "segment" && item.status === "ready").length,
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
    const guide = manualWorkspaceProgress(item.key, source, readiness?.targets || [], continuityReport?.status);
    const current = presentationWorkspace === item.key;
    return { ...item, current, status: current ? "current" : guide.status, summary: t(`director.workspace.manual.${guide.summaryKey}`, guide.values), actionLabel: t(`director.workspace.manual.${guide.actionKey}`) };
  });
  const openManualTarget = (item: NonNullable<typeof readiness>["targets"][number]) => {
    const recovery = manualTargetRecovery(item, source);
    const subject = records(source.subject_registry).find(subject => records(subject.pictureBindings).some(binding => binding.assetId === item.targetId));
    if (subject) setSelectedSubjectId(String(subject.id));
    onNavigate(recovery.workspace, { kind: recovery.kind, id: recovery.id });
  };
  const manualBlockers = [...new Set((readiness?.targets || []).flatMap(target => target.blockers))];
  const nextManualTarget = readiness?.targets.find(target => target.status === "blocked") || readiness?.targets.find(target => target.kind === "segment" && target.status === "ready");
  const nextManualAction = nextManualTarget ? manualTargetRecovery(nextManualTarget, source) : undefined;

  const imageNodes = canvasNodes.filter(node => ["image", "character", "scene", "prop"].includes(String(node.type)) || (node.type === "config" && (node.metadata?.generationMode || "image") === "image"));
  const canvasImageStorageKey = (nodeId: string) => {
    const assetNode = canvasAssetRows.find(item => item.node.id === nodeId);
    if (assetNode) return assetNode.storageKey;
    const node = canvasNodes.find(item => item.id === nodeId);
    return node ? canvasNodeImage(node as unknown as CanvasNodeData)?.storageKey || "" : "";
  };
  const mediaForAsset = (assetId: string, shotId?: string) => {
    const mapped = d?.assets[assetId] || publishedDirector?.assets[assetId];
    const frame = shotId ? production.draft.keyframes[shotId] || production.published?.keyframes[shotId] : undefined;
    const review = shotId ? production.draft.keyframeReviews[shotId] || production.published?.keyframeReviews[shotId] : undefined;
    const frameMatchesBinding = !mapped?.nodeId || frame?.nodeId === mapped.nodeId;
    const status = shotId
      ? review?.verdict === "rejected" || review?.verdict === "needs-redo" ? "rejected" : frame?.storageKey && frameMatchesBinding ? "approved" : mapped?.status || "planned"
      : mapped?.status === "generated" && mapped.storageKey ? "approved" : mapped?.status || "planned";
    return { asset: mapped, nodeId: shotId ? frame?.nodeId && frameMatchesBinding ? frame.nodeId : mapped?.nodeId || "" : mapped?.nodeId || "", storageKey: shotId ? frame?.storageKey && frameMatchesBinding ? frame.storageKey : mapped?.storageKey || "" : mapped?.storageKey || "", sha256: mapped?.sha256 || "", status, inputOutdated: mapped?.inputOutdated, evidence: mapped?.evidence || review?.evidence || "" };
  };
  const deliveredClips = (production.published?.clipGroups || []).flatMap(group => {
    const node = canvasNodes.find(item => item.id === group.nodeId);
    const nodeSegments = Array.isArray(node?.metadata?.segments) ? node.metadata!.segments.map(value => value && typeof value === "object" ? value as Record<string, unknown> : {}) : [];
    const segment = nodeSegments.find(item => String(item.id || "") === String(group.segmentId || ""));
    const storageKey = String(segment?.resultStorageKey || "");
    return storageKey ? [{ group, storageKey }] : [];
  });
  const downloadDeliveredClip = async (storageKey: string, fileName: string) => {
    const response = await fetch(backendMediaUrl(storageKey));
    if (!response.ok) throw new Error(t("director.workspace.mediaReadFailed"));
    saveAs(await response.blob(), fileName);
  };
  const clipFileName = (index: number, label: string, contentType: string | null) => `${String(index + 1).padStart(2, "0")}-${label.replace(/[\\/:*?"<>|]/g, "_")}.${contentType?.includes("webm") ? "webm" : "mp4"}`;
  const downloadAllDeliveredClips = async () => {
    if (!deliveredClips.length || downloadingAllClips) return;
    setDownloadingAllClips(true);
    try {
      // 优先让用户选择保存目录（File System Access API，Chrome/Edge 支持；localhost/https 为安全上下文）
      const picker = (window as unknown as { showDirectoryPicker?: (opts?: { mode?: "readwrite" | "read" }) => Promise<any> }).showDirectoryPicker;
      let dirHandle: any = null;
      if (typeof picker === "function") {
        try {
          dirHandle = await picker({ mode: "readwrite" });
        } catch (pickErr: any) {
          if (pickErr?.name === "AbortError") {
            // 用户取消目录选择，静默退出
            setDownloadingAllClips(false);
            return;
          }
          dirHandle = null; // 权限/其他异常，降级到 saveAs 逐个下载
        }
      }
      let saved = 0;
      for (let index = 0; index < deliveredClips.length; index++) {
        const { group, storageKey } = deliveredClips[index];
        const response = await fetch(backendMediaUrl(storageKey));
        if (!response.ok) throw new Error(t("director.workspace.mediaReadFailed"));
        const blob = await response.blob();
        const fileName = clipFileName(index, segmentTitle(group.id), response.headers.get("content-type"));
        if (dirHandle) {
          const fileHandle = await dirHandle.getFileHandle(fileName, { create: true });
          const writable = await fileHandle.createWritable();
          await writable.write(blob);
          await writable.close();
        } else {
          saveAs(blob, fileName);
          await new Promise(resolve => setTimeout(resolve, 400));
        }
        saved++;
      }
      if (dirHandle) {
        message.success(t("director.workspace.downloadAllClipsToDirDone", { count: saved, dir: String(dirHandle.name) }));
      } else {
        message.success(t("director.workspace.downloadAllClipsDone", { count: saved }));
      }
    } catch (error) {
      message.error(String(error));
    } finally {
      setDownloadingAllClips(false);
    }
  };
  const assetTitle = (item: Record<string, any>) => String(item.asset_name || item.name || item.title || item.asset_id || item.id || t("director.workspace.untitledAsset"));
  const assetIdOf = (item: Record<string, any>) => String(item.asset_id || item.id || "");
  const keyframeAssetIds = new Set(Object.values(d?.shotInputs || {}).map(input => input.keyframeAssetId).filter((id): id is string => Boolean(id)));
  const allAssetIds = [...new Set([...assetPlan.map(assetIdOf).filter(Boolean), ...Object.keys(d?.assets || {}), ...keyframeAssetIds])];
  const canvasAssetRows = canvasNodes.flatMap(node => {
    if (!["character", "scene", "prop"].includes(String(node.type))) return [];
    const metadata = node.metadata || {};
    const kind = node.type === "character" ? "characters" : node.type === "scene" ? "locations" : "props";
    const images = Array.isArray(metadata.characterImages) ? metadata.characterImages as Array<Record<string, any>> : [];
    const primaryIndex = Math.min(Math.max(Number(metadata.characterPrimaryIndex) || 0, 0), Math.max(images.length - 1, 0));
    const primary = images[primaryIndex];
    const image = node.type === "character" ? primary : node.type === "scene" ? metadata.sceneImage as Record<string, any> | undefined : metadata.propImage as Record<string, any> | undefined;
    const imageGallery = node.type === "character" ? images.flatMap((item, index) => item.storageKey || item.url ? [{ storageKey: String(item.storageKey || ""), url: String(item.url || ""), label: String(item.outfit || item.name || `${index + 1}`), primary: index === primaryIndex }] : [])
      : image && (image.storageKey || image.url) ? [{ storageKey: String(image.storageKey || ""), url: String(image.url || ""), label: String(image.name || node.title || node.id), primary: true }] : [];
    return [{
      node, kind,
      name: String(metadata.characterName || metadata.sceneName || metadata.propName || node.title || node.id),
      description: String(metadata.characterDescription || metadata.sceneDescription || metadata.propDescription || ""),
      storageKey: String(image?.storageKey || (node.type === "image" ? metadata.storageKey : "") || ""),
      url: String(image?.url || metadata.content || ""),
      images: imageGallery,
    }];
  });

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
  // 人物/资产名称字段：解析顺序＝显式名称(asset_name/name/title) → entity_id 关联的注册表名（权威人物/场景名，如 Lixi）→ 画布节点标题主段（兜底，格式不统一）→ 回退 asset_title。
  // 源稿 asset 条目通常不带名称字段（assetTitle 会回退到内部 id），注册表名是权威来源；节点标题只读不动。
  const assetDisplayName = (assetId: string, item?: Record<string, any>) => {
    if (!item) return "";
    const explicit = String(item.asset_name || item.name || item.title || "").trim();
    if (explicit && explicit !== String(item.asset_id || item.id || "")) return explicit;
    const registryName = item.entity_id ? String(nameMap[String(item.entity_id)] || "").trim() : "";
    if (registryName) return registryName;
    const node = canvasNodes.find(node => node.id === d?.assets[assetId]?.nodeId);
    const title = String(node?.title || "").trim();
    const primary = title && title !== node?.id ? title.split(/\s*[|｜]\s*/)[0].trim() : "";
    if (primary) return primary;
    return explicit || assetTitle(item);
  };
  const assetNameLabelKey = (assetId: string, item?: Record<string, any>) => {
    const kind = String(item?.kind || "").toLowerCase() || assetCategory(assetId);
    return /character|person|角色/.test(kind) ? "director.workspace.assetCharacterName"
      : /scene|location|场景/.test(kind) ? "director.workspace.assetSceneName"
      : /prop|道具/.test(kind) ? "director.workspace.assetPropName"
      : "director.workspace.assetItemName";
  };
  const renderAssetNameField = (assetId: string, item: Record<string, any> | undefined, className: string) => item ? <label className={className}>{t(assetNameLabelKey(assetId, item))}<SourceField value={assetDisplayName(assetId, item)} draftValue={sourceDrafts[`asset:${assetId}:asset_name`]} onDraftChange={value => onSourceDraftChange(`asset:${assetId}:asset_name`, value)} disabled={busy}   onCommit={async value => {
    const name = String(value), previousName = assetDisplayName(assetId, item);
    const saved = await onPatch("asset", assetId, { asset_name: name });
    if (saved === false) return false;
    onSourceDraftChange(`asset:${assetId}:asset_name`, undefined);
    // asset 与其关联注册表由 Backend 同一制作事务同步；对白 speaker_name
    // 是快照文本，不随注册表刷新，因此仍需更新匹配的字面量。
    const key = previousName.trim().toLowerCase(), next = name.trim().toLowerCase();
    if (key && key !== next) {
      for (const shot of sourceShots) {
        const dialogues = Array.isArray(shot.dialogues) ? shot.dialogues : [];
        if (!dialogues.some(dialogue => String(dialogue?.speaker_name || "").trim().toLowerCase() === key)) continue;
        try { await onPatch("shot", String(shot.id), { dialogues: dialogues.map(dialogue => String(dialogue?.speaker_name || "").trim().toLowerCase() === key ? { ...dialogue, speaker_name: name } : dialogue) }); }
        catch { /* 单个镜头同步失败不阻塞整体改名 */ }
      }
    }
    return saved;
  }} /></label> : null;
  // 资产合同字段（描述/职责、版本、前置依赖、关联画布图）：素材大卡与分镜图详情共用这一份，避免两处维护。
  const renderAssetContractFields = (assetId: string, item: Record<string, any> | undefined, media: ReturnType<typeof mediaForAsset>, options: { description?: boolean; binding?: boolean } = {}) => {
    const field = item?.description !== undefined || item?.prompt === undefined ? "description" : "prompt";
    const dependencies = Array.isArray(item?.depends_on) ? item!.depends_on.map((value: unknown) => typeof value === "string" ? value : String((value as Record<string, unknown>)?.asset_id || (value as Record<string, unknown>)?.id || "")).filter(Boolean) : [];
    return <>
      {options.description && item && renderAssetNameField(assetId, item, "grid gap-1 text-xs text-muted-foreground")}
      {options.description && item && <label className="grid gap-1 text-xs text-muted-foreground">{t("director.workspace.description")}<SourceField value={proseOf(item[field] ?? item.visual ?? item.purpose)} draftValue={sourceDrafts[`asset:${assetId}:${field}`] ?? sourceDrafts[`asset:${assetId}:visual`]} onDraftChange={value => onSourceDraftChange(`asset:${assetId}:${field}`, value)} multiline rows={3} disabled={busy} onCommit={async value => { const saved = await onPatch("asset", assetId, { [field]: patchProse(item[field], value) }); if (saved !== false) onSourceDraftChange(`asset:${assetId}:visual`, undefined); return saved; }} /></label>}
      {item && <label className="grid gap-1 text-xs text-muted-foreground">{t("director.workspace.assetVersion")}<SourceField value={item.version || item.asset_version || "v1"} draftValue={sourceDrafts[`asset:${assetId}:version`]} onDraftChange={value => onSourceDraftChange(`asset:${assetId}:version`, value)} disabled={busy} onCommit={value => onPatch("asset", assetId, { version: String(value) })} /></label>}
      {item && <label className="grid gap-1 text-xs text-muted-foreground">{t("director.workspace.assetDependencies")}<Select mode="multiple" value={dependencies} disabled={busy} options={assetPlan.filter(value => assetIdOf(value) !== assetId).map(value => ({ value: assetIdOf(value), label: assetName(assetIdOf(value)) }))} onChange={value => void onPatch("asset", assetId, { depends_on: value })} /></label>}
      {options.binding !== false && <label className="grid gap-1 text-xs text-muted-foreground">{t("director.studio.linkImage")}<Select value={media.nodeId || undefined} disabled={busy || !imageNodes.length} placeholder={t("director.workspace.bindCanvasImage")} options={imageNodes.map((node, index) => ({ value: node.id, label: humanName(node.title, node.id, t("director.studio.imageNumber", { number: index + 1 })) }))} onChange={nodeId => nodeId && onBindAsset(assetId, nodeId)} /></label>}
    </>;
  };
  const renderAssetCard = (assetId: string, item?: Record<string, any>, keyframeShot?: string, options: { gallery?: boolean } = {}) => {
    const { gallery = false } = options;
    const media = mediaForAsset(assetId, keyframeShot);
    const imageNode = canvasNodes.find(node => node.id === media.nodeId);
    const nodeImages = imageNode?.type === "character" ? imageNode.metadata?.characterImages : imageNode?.metadata?.images;
    const { images: previewImages, previewKey, browsingHistory } = assetImagePreview(media.storageKey, nodeImages, gallery ? assetPreviewKeys[assetId] : undefined, imageNode?.type === "character");
    const title = keyframeShot ? `${shotTitle(keyframeShot)} · ${t("director.studio.keyframe")}` : assetName(assetId);
    const card = records(source.asset_cards).find(value => assetIdOf(value) === assetId);
    const field = item?.description !== undefined || item?.prompt === undefined ? "description" : "prompt";
    return <article key={`${assetId}:${keyframeShot || "asset"}`} data-production-target={keyframeShot ? `frame:${keyframeShot}` : `asset:${assetId}`} className={gallery ? "grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_320px]" : compact ? "grid min-w-0 items-start gap-4 md:grid-cols-[280px_minmax(0,1fr)]" : "min-w-0 overflow-hidden rounded-lg border border-border bg-card"}>
      <section className={gallery ? "flex min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-card" : "contents"}>
      {gallery && <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-3"><h3 className="min-w-0 truncate text-sm font-semibold">{title}</h3><Button size="small" type="text" disabled={!previewKey} onClick={() => setMediaPreview({ assetId, title, storageKey: previewKey })}>{t("director.workspace.viewOriginal")}</Button></header>}
      <button type="button" disabled={!previewKey} aria-label={t("director.studio.previewAsset", { title })} onClick={() => setMediaPreview({ assetId, title, storageKey: previewKey })} className={`flex w-full items-center justify-center overflow-hidden bg-muted/30 ${gallery ? "h-[min(52dvh,36rem)] p-4" : compact ? "h-[min(50dvh,420px)] rounded-lg" : "aspect-[4/3]"}`}>
        {previewKey && /\.(mp4|webm|mov)(?:$|\?)/i.test(previewKey) ? <Film className="size-10 text-muted-foreground" /> : previewKey ? <img className="h-full w-full object-contain" src={backendMediaUrl(previewKey)} alt={title} loading="lazy" /> : <div className="space-y-2 text-center text-muted-foreground"><ImageIcon className="mx-auto size-8 opacity-40" /><span className="text-xs">{t("director.studio.noImage")}</span></div>}
      </button>
      {gallery && <footer className="space-y-2 border-t border-border p-3"><p className="text-xs text-muted-foreground">{t(browsingHistory ? "director.studio.browsingImageHistory" : "director.studio.currentImage")}</p><div className="flex gap-2 overflow-x-auto">{previewImages.map((storageKey, index) => <button type="button" key={storageKey} aria-pressed={previewKey === storageKey} aria-label={index === 0 ? t("director.studio.currentImage") : t("director.workspace.pictureHistoryItem", { number: index })} onClick={() => setAssetPreviewKeys(current => ({ ...current, [assetId]: storageKey }))} className={`h-16 w-16 shrink-0 overflow-hidden rounded border p-1 ${previewKey === storageKey ? "border-primary bg-primary/5" : "border-border hover:bg-muted"}`}><img className="h-full w-full object-contain" src={backendMediaUrl(storageKey)} alt="" loading="lazy" /></button>)}</div></footer>}
      </section>
      <div className={gallery ? "min-w-0 rounded-lg border border-border bg-card p-4 xl:max-h-[72dvh] xl:overflow-y-auto" : compact ? "min-w-0" : "p-4"}><div className="flex items-start justify-between gap-2"><div className="min-w-0">{!compact && <h3 className="text-base font-semibold">{title}</h3>}<p className="mt-1 text-xs text-muted-foreground">{t(`director.studio.filter.${assetCategory(assetId)}`)}</p></div><Tag color={media.status === "approved" ? "green" : media.status === "generated" ? "blue" : media.status === "rejected" ? "red" : "default"}>{t(`director.workspace.assetStatus.${media.status}`)}</Tag></div>
      {gallery && media.nodeId && <div className="mt-3"><ReferenceNodeLink sourceNode={{ projectId: media.asset?.sharedSource?.sourceProjectId || canvasId, nodeId: media.asset?.sharedSource?.sourceNodeId || media.nodeId }} /></div>}
      {(compact || gallery) && item ? <>{renderAssetNameField(assetId, item, "mt-4 grid gap-2 text-sm")}<label className="grid gap-2 text-sm">{t("director.workspace.description")}<SourceField value={proseOf(item[field] ?? item.visual ?? item.purpose)} draftValue={sourceDrafts[`asset:${assetId}:${field}`] ?? sourceDrafts[`asset:${assetId}:visual`]} onDraftChange={value => onSourceDraftChange(`asset:${assetId}:${field}`, value)} multiline disabled={busy || Boolean(media.asset?.sharedSource)} onCommit={async value => { const saved = await onPatch("asset", assetId, { [field]: patchProse(item[field], value) }); if (saved !== false) onSourceDraftChange(`asset:${assetId}:visual`, undefined); return saved; }} /></label>{card && <label className="grid gap-2 text-sm">{t("director.crud.manualAssetPrompt")}<SourceField value={String(card.prompt || "")} draftValue={sourceDrafts[`asset_card:${assetId}:prompt`]} onDraftChange={value => onSourceDraftChange(`asset_card:${assetId}:prompt`, value)} multiline rows={5} disabled={busy || Boolean(media.asset?.sharedSource)} onCommit={value => onPatch("asset_card", assetId, { prompt: String(value) })} /></label>}{card && (records(card.seven_steps).length > 0 || records(card.references).length > 0) && <details className="mt-2 rounded-lg border border-border p-2 text-xs" data-asset-card-steps-gallery><summary className="cursor-pointer select-none font-medium text-muted-foreground">{t("director.crud.sevenStepsTitle")} · {records(card.references).length}</summary><div className="mt-2"><SevenStepsReferencesEditor key={`gallery:${assetId}`} card={card} disabled={busy || Boolean(media.asset?.sharedSource)} onSave={patch => onPatch("asset_card", assetId, patch)} /></div></details>}</> : proseOf(item?.description || item?.prompt || item?.visual || item?.purpose) && <p className="mt-3 line-clamp-3 whitespace-pre-wrap text-sm leading-6 text-muted-foreground">{proseOf(item?.description || item?.prompt || item?.visual || item?.purpose)}</p>}
      {media.evidence && (!compact || media.status === "rejected") && <p className="mt-3 text-xs leading-5 text-muted-foreground">{media.evidence}</p>}
      {item && !keyframeShot && ["episode", "shared-assets"].includes(canvasRole) && <div className="mt-3 grid gap-2"><label className="grid gap-1 text-xs text-muted-foreground">{t("director.workspace.assetCanvasScope")}<Select value={String(item.canvas_scope || (media.asset?.sharedSource || canvasRole === "shared-assets" ? "shared" : "episode"))} disabled={busy || Boolean(media.asset?.sharedSource) || canvasRole === "shared-assets"} options={[{ value: "episode", label: t("director.workspace.assetCanvasScopeEpisode") }, { value: "shared", label: t("director.workspace.assetCanvasScopeShared") }]} onChange={value => void onPatch("asset", assetId, { canvas_scope: value })} /></label>{canvasRole === "episode" && String(item.canvas_scope || (media.asset?.sharedSource ? "shared" : "episode")) === "shared" && <div className="flex flex-wrap items-center gap-2"><p className="m-0 text-xs text-muted-foreground">{t("director.workspace.sharedAssetNeedsAdoption")}</p>{media.status === "approved" && !media.asset?.sharedSource && <Button size="small" disabled={busy} onClick={() => onPromoteExistingSharedAsset(assetId, title)}>{t("director.workspace.promoteExistingSharedAsset")}</Button>}<Button size="small" disabled={busy} onClick={() => onOpenSharedAsset(assetId, title)}>{t("director.workspace.openSharedCanvas")}</Button></div>}</div>}
      <div className="mt-4 flex flex-wrap gap-2">{media.storageKey && !gallery && <Button size="small" onClick={() => setMediaPreview({ assetId, title, storageKey: media.storageKey })}>{t("director.workspace.viewOriginal")}</Button>}<Button icon={<WandSparkles className="size-3" />} size="small" onClick={() => onAskDirector({ workspace: "assets", targetId: assetId, instruction: t("director.workspace.reviseAssetContract") })}>{t("director.studio.collaborate")}</Button></div>
      <details className="mt-3 border-t border-border pt-3"><summary className="cursor-pointer text-xs text-muted-foreground">{t(compact ? "productionCanvas.objectDetails" : "director.studio.assetDetails")}</summary><div className="mt-3 space-y-3">{renderAssetContractFields(assetId, item, media, { description: !compact && !gallery })}</div></details>
      {media.inputOutdated && <p className="mt-2 text-xs">{t("productionCanvas.outdatedMedia")}</p>}
      </div>
    </article>;
  };

  // This is a read-only projection of the same formal shots and archived results.
  // Selecting a preview never edits the production source or starts a media task.
  const overviewShot = sourceShots.find(shot => String(shot.id) === overviewShotId) || sourceShots[0];
  const overviewShotIndex = overviewShot ? sourceShots.indexOf(overviewShot) : -1;
  const overviewMedia = overviewShot ? productionOverviewMedia(production, canvasNodes, String(overviewShot.id)) : {};
  const overviewFrame = overviewMedia.frame?.storageKey;
  const overviewClip = overviewMedia.clip;
  const overviewInputOutdated = Boolean((overviewClip || overviewMedia.frame)?.inputOutdated);
  const overviewStorageKey = overviewClip?.storageKey || overviewFrame || "";
  const overviewMediaFailed = Boolean(overviewMediaErrors[overviewStorageKey]);
  const overviewReady = overviewShot ? readiness?.targets.find(item => overviewClip ? item.kind === "segment" && item.targetId === overviewClip.id : item.kind === "keyframe" && item.targetId === String(overviewShot.id)) : undefined;
  const renderOverviewPreview = () => overviewShot && <section className="min-w-0" data-director-preview data-preview-kind={overviewClip ? "clip" : overviewFrame ? "keyframe" : "empty"}>
    <header className="mb-3 flex flex-wrap items-center justify-between gap-2">
      <div className="flex min-w-0 items-center gap-3">
        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{t("director.studio.shotNumber", { number: overviewShotIndex + 1 })}</span>
        <h2 className="min-w-0 truncate text-sm font-medium">{shotTitle(String(overviewShot.id))}</h2>
      </div>
      <span className="text-xs text-muted-foreground">{overviewInputOutdated ? t("productionCanvas.nodeStatus.outdated") : overviewStorageKey ? t("director.workspace.realMedia") : overviewReady ? t(`director.workspace.targetStatus.${overviewReady.status}`) : null}</span>
    </header>
    <div className="flex aspect-video items-center justify-center overflow-hidden rounded-lg border border-border bg-muted/40">
      {overviewMediaFailed ? <div role="status" className="flex max-w-md flex-col items-center gap-3 px-6 py-8 text-center"><ImageIcon className="size-7 text-muted-foreground" /><p className="text-sm text-muted-foreground">{t("director.workspace.mediaReadFailed")}</p><Button size="small" type="text" onClick={() => setOverviewMediaErrors(current => { const next = { ...current }; delete next[overviewStorageKey]; return next; })}>{t("director.atomic.retry")}</Button></div>
        : overviewClip ? <video key={overviewClip.storageKey} className="h-full w-full object-contain" src={backendMediaUrl(overviewClip.storageKey)} aria-label={t("director.studio.clipVideo", { title: segmentTitle(overviewClip.id) })} controls playsInline preload="metadata" onError={() => setOverviewMediaErrors(current => ({ ...current, [overviewClip.storageKey]: true }))} />
        : overviewFrame ? <button type="button" className="h-full w-full cursor-zoom-in focus-visible:outline-2 focus-visible:outline-offset-[-3px] focus-visible:outline-primary" aria-label={t("director.studio.previewAsset", { title: shotTitle(String(overviewShot.id)) })} onClick={() => setMediaPreview({ assetId: String(overviewShot.id), title: shotTitle(String(overviewShot.id)), storageKey: overviewFrame })}><img src={backendMediaUrl(overviewFrame)} alt={shotTitle(String(overviewShot.id))} className="h-full w-full object-contain" onError={() => setOverviewMediaErrors(current => ({ ...current, [overviewFrame]: true }))} /></button>
          : <div className="flex max-w-md flex-col items-center gap-3 px-6 py-8 text-center"><Film className="size-7 text-muted-foreground" /><p className="text-sm text-muted-foreground">{t("director.studio.noImage")}</p>{proseOf(overviewShot.visual) && <p className="line-clamp-4 text-sm leading-7 text-foreground">{proseOf(overviewShot.visual)}</p>}</div>}
    </div>
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border py-3">
      <div className="flex items-center gap-1">
        <Button type="text" size="small" icon={<ArrowLeft className="size-3.5" />} aria-label={t("director.studio.openShot", { number: Math.max(1, overviewShotIndex) })} disabled={overviewShotIndex <= 0} onClick={() => setOverviewShotId(String(sourceShots[overviewShotIndex - 1].id))} />
        <span className="px-2 text-xs tabular-nums text-muted-foreground">{String(overviewShotIndex + 1).padStart(2, "0")} / {String(sourceShots.length).padStart(2, "0")}</span>
        <Button type="text" size="small" icon={<ArrowRight className="size-3.5" />} aria-label={t("director.studio.openShot", { number: Math.min(sourceShots.length, overviewShotIndex + 2) })} disabled={overviewShotIndex >= sourceShots.length - 1} onClick={() => setOverviewShotId(String(sourceShots[overviewShotIndex + 1].id))} />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        {(overviewClip || overviewFrame) && <span className="text-xs text-muted-foreground">{overviewClip ? segmentTitle(overviewClip.id) : t("director.studio.keyframe")}</span>}
        <Button type="text" size="small" icon={<Pencil className="size-3.5" />} onClick={() => onNavigate("shots", { kind: "shot", id: String(overviewShot.id) })}>{t("director.workspace.manual.openEditor")}</Button>
      </div>
    </div>
    <nav className="mt-4 flex gap-3 overflow-x-auto pb-2" aria-label={t("director.atomic.timeline")}>
      {sourceShots.map((shot, index) => {
        const id = String(shot.id), frame = productionOverviewMedia(production, canvasNodes, id).frame?.storageKey, selected = id === String(overviewShot.id);
        return <button key={id} type="button" aria-pressed={selected} aria-label={t("director.studio.openShot", { number: index + 1 })} onClick={() => setOverviewShotId(id)} className={`w-36 shrink-0 rounded-md border p-1 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary sm:w-40 ${selected ? "border-primary bg-card" : "border-transparent hover:bg-muted"}`}>
          <span className="flex aspect-video items-center justify-center overflow-hidden rounded-sm bg-muted/50">{frame && !overviewMediaErrors[frame] ? <img src={backendMediaUrl(frame)} alt="" className="h-full w-full object-contain" loading="lazy" onError={() => setOverviewMediaErrors(current => ({ ...current, [frame]: true }))} /> : <Film className="size-5 text-muted-foreground" />}</span>
          <span className="flex items-start gap-2 px-1 py-2"><span className="pt-0.5 text-[10px] tabular-nums text-muted-foreground">{String(index + 1).padStart(2, "0")}</span><span className="line-clamp-2 text-xs leading-5">{shotTitle(id)}</span></span>
        </button>;
      })}
    </nav>
  </section>;

  const renderOverview = () => {
    const attentionTargets = (readiness?.targets || []).filter(item => item.status !== "complete" || Boolean(item.warnings?.length))
      .sort((a, b) => Number(b.status === "blocked") - Number(a.status === "blocked"));
    const decisions = (d?.workflow.pendingDecisions || []).filter(decision => decision.status === "pending" || decision.workId === d?.workflow.currentWork?.workId);
    const renderAttentionTarget = (item: NonNullable<typeof readiness>["targets"][number]) => {
      const recovery = manualTargetRecovery(item, source);
      return <details key={item.id} data-production-target={item.kind === "keyframe" ? `frame:${item.targetId}` : `${item.kind}:${item.targetId}`} className="border-b border-border py-2 last:border-b-0">
        <summary className="cursor-pointer text-sm marker:text-muted-foreground">
          <span className="font-medium">{targetName(item.kind, item.targetId, item.title)}</span>
          <span className="ml-2 text-xs text-muted-foreground">{t(`director.workspace.targetStatus.${item.status}`)}</span>
          <span className="mt-0.5 block truncate text-xs text-muted-foreground" title={humanMessage(item.blockers[0] || item.warnings?.[0] || t(`director.workspace.manual.${recovery.messageKey}`))}>{humanMessage(item.blockers[0] || item.warnings?.[0] || t(`director.workspace.manual.${recovery.messageKey}`))}</span>
        </summary>
        <div className="mt-2 space-y-2 pl-3">
          <p className="text-xs text-muted-foreground">{t(`director.workspace.manual.${recovery.messageKey}`)}</p>
          {[...item.blockers, ...(item.warnings || [])].map((reason, index) => <p key={index} className="whitespace-pre-wrap break-words text-xs text-muted-foreground">{humanMessage(reason)}</p>)}
          <div className="flex flex-wrap gap-2"><Button size="small" disabled={busy} onClick={() => openManualTarget(item)}>{t(`director.workspace.manual.${recovery.actionKey}`)}</Button>
            {item.kind === "segment" && onLocateTarget && production.draft.clipGroups.some(group => group.id === item.targetId && group.nodeId && group.segmentId) && <Button size="small" disabled={busy} onClick={() => onLocateTarget("segment", item.targetId)}>{t("director.workspace.manual.editCanvasPrompt")}</Button>}
            <Button size="small" type="text" disabled={busy} onClick={() => onAskDirector({ workspace: item.kind === "segment" ? "production" : item.kind === "keyframe" ? "shots" : "assets", targetId: item.targetId })}>{t("director.workspace.askDirector")}</Button>
          </div>
        </div>
      </details>;
    };
    return <div className="space-y-3" data-production-overview="compact">
      {production.draft.settings.parallelScenes && canvasRole !== "scene" && <SceneProductionPanel key={JSON.stringify({ canvasId, episodeId: production.episodeId })} disabled={busy} commandPending={sceneCommandPending} onCommand={onSceneCommand} onAskDirector={scope => onAskDirector({ workspace: "overview", ...scope })} production={production} owner={canvasRole === "episode" ? production.episodeId : { projectId: canvasId }} onRefresh={onRefresh} />}
      <section className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-3" aria-label={t("director.workspace.overview.currentTask")}>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2"><h2 className="text-sm font-medium">{humanMessage(d && presentation?.action === "author" ? t("director.workspace.manual.currentWorkspace", { workspace: t(`director.workspace.tab.${presentationWorkspace}`) }) : taskTitle)}</h2>{presentation?.status && <Tag color={presentation.status === "needs_review" ? "orange" : presentation.status === "blocked" ? "red" : presentation.status === "complete" ? "green" : undefined}>{t(`director.workspace.presentationStatus.${presentation.status}`)}</Tag>}</div>
          <p className="mt-1 text-xs text-muted-foreground">{nextManualAction ? t("director.workspace.manual.nextStep", { action: t(`director.workspace.manual.${nextManualAction.actionKey}`) }) : humanMessage(readiness?.nextAction || t("director.workspace.noNextAction"))}</p>
        </div>
        <div className="flex flex-wrap gap-2"><Button size="small" type="primary" disabled={busy} onClick={() => {
          if (!d) { const brief = document.getElementById("director-current-brief") as HTMLDetailsElement | null; if (brief) { brief.open = true; brief.scrollIntoView({ block: "center", behavior: "smooth" }); brief.querySelector<HTMLTextAreaElement>("textarea")?.focus({ preventScroll: true }); } return; }
          onNavigate(presentationWorkspace === "overview" ? "story" : presentationWorkspace, presentationFocus);
        }}>{!d ? t("director.workspace.overview.startFromBriefAction") : presentation?.status === "needs_review" ? t("director.workspace.overview.viewAndReview") : t("director.workspace.manual.openEditor")}</Button>
          {d && <Button size="small" type="text" disabled={busy} onClick={() => onAskDirector({ workspace: presentationWorkspace, targetId: presentation?.targetId, instruction: t("director.workspace.continueInstruction") })}>{t("director.workspace.askDirector")}</Button>}
        </div>
      </section>
      <section className="flex flex-wrap items-center justify-between gap-x-5 gap-y-2 text-xs" aria-label={t("director.workspace.readiness")} data-overview-progress>
        <div className="flex flex-wrap gap-x-5 gap-y-2">{([["ready", readinessCounts.ready], ["blocked", readinessCounts.blocked], ["review", readinessCounts.review], ["done", readinessCounts.done]] as const).map(([key, count]) => <span key={key} className="text-muted-foreground">{t(`director.workspace.readinessCount.${key}`)} <strong className="ml-1 text-sm font-semibold tabular-nums text-foreground">{count}</strong></span>)}</div>
        <div className="flex flex-wrap gap-2"><Tag>{t("director.workspace.targetKind.asset")} · {t("director.workspace.targetStatus.ready")}: {readinessCounts.readyAssets}</Tag><Tag>{t("director.workspace.targetKind.keyframe")} · {t("director.workspace.targetStatus.ready")}: {readinessCounts.readyKeyframes}</Tag><Tag>{t("director.workspace.targetKind.segment")} · {t("director.workspace.targetStatus.ready")}: {readinessCounts.readySegments}</Tag></div>
        <span className="text-muted-foreground">{t("director.atomic.counts", { shots: sourceShots.length, clips: segments.length, seconds: formatSeconds(sourceShots.reduce((sum, shot) => sum + storyboardDurationFrames(shot) / fps, 0)) })}</span>
      </section>
      <div className="grid min-w-0 items-start gap-4 lg:grid-cols-2" data-overview-workspaces>
        <section className="min-w-0" aria-label={t("director.workspace.overview.objectStatus")}>
          {objectRows.map(row => <button key={row.key} type="button" aria-current={row.current ? "page" : undefined} onClick={() => onNavigate(row.key)} title={humanMessage(row.summary)} className={`flex w-full items-center gap-3 border-b border-border px-2 py-2.5 text-left transition-colors last:border-b-0 ${row.current ? "bg-muted/40" : "hover:bg-muted/30"}`}>
            <strong className="w-20 shrink-0 text-sm font-medium">{t(`director.workspace.tab.${row.key}`)}</strong>
            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{humanMessage(row.summary)}</span>
            <span className={`shrink-0 text-xs ${row.status === "blocked" ? "text-destructive" : row.current ? "text-primary" : "text-muted-foreground"}`}>{t(`director.workspace.overview.rowStatus.${row.status}`)}</span><ArrowRight className="size-3.5 shrink-0 text-muted-foreground" />
          </button>)}
        </section>
        <section className="min-w-0" data-overview-attention>
          <div className="flex items-center justify-between gap-2 border-b border-border pb-1"><h2 className="text-sm font-medium">{t("director.workspace.targetsNeedingWork")} <span className="ml-1 tabular-nums text-muted-foreground">{attentionTargets.length}</span></h2><Button size="small" type="text" onClick={() => onNavigate("production")}>{t("director.workspace.tab.production")}<ArrowRight className="size-3" /></Button></div>
          {manualBlockers.length > 0 && <p className="mt-1 text-xs text-muted-foreground" title={t("director.workspace.manual.actualIssuesHint")}>{t("director.workspace.manual.actualIssues", { count: manualBlockers.length })}</p>}
          {attentionTargets.slice(0, 3).map(renderAttentionTarget)}
          {attentionTargets.length > 3 && <details className="pt-2" data-overview-more-targets><summary className="cursor-pointer text-xs text-muted-foreground">{t("director.workspace.manual.issueDetails")} · {attentionTargets.length - 3}</summary><div>{attentionTargets.slice(3).map(renderAttentionTarget)}</div></details>}
          {!attentionTargets.length && <p className="py-3 text-xs text-muted-foreground">{humanMessage(readiness?.nextAction || t("director.workspace.noNextAction"))}</p>}
        </section>
      </div>
      {decisions.map((decision: DirectorDecision) => <details key={decision.id} className="border-t border-border pt-2" data-overview-decision>
        <summary className="cursor-pointer text-sm"><span className="mr-2 text-xs text-muted-foreground">{t(`director.workspace.moduleName.${decision.module}`)}</span>{decision.prompt}</summary>
        {decision.status === "answered" ? <div className="mt-2 flex flex-wrap items-center justify-between gap-2"><p className="text-sm">{t("director.workspace.decisionSaved", { answer: decision.answer || "" })}</p><Button size="small" type="primary" disabled={busy} onClick={() => void onAnswerDecision(decision.id, decision.answer || "")}>{t("director.workspace.continueDecision")}</Button></div> : <>
          <div className="mt-2 flex flex-wrap gap-2">{decision.choices.map(choice => <Button key={choice} size="small" disabled={busy} onClick={() => void onAnswerDecision(decision.id, choice)}>{choice}</Button>)}</div>
          {decision.allowFreeText && <div className="mt-2 flex gap-2"><Input value={decisionReplies[decision.id] || ""} disabled={busy} aria-label={t("director.workspace.decisionAnswer")} onChange={event => setDecisionReplies(current => ({ ...current, [decision.id]: event.target.value }))} /><Button size="small" disabled={busy || !decisionReplies[decision.id]?.trim()} onClick={() => void onAnswerDecision(decision.id, decisionReplies[decision.id].trim())}>{t("director.workspace.submitDecision")}</Button></div>}
        </>}
      </details>)}
      {!embedded && overviewShot && <section className="flex min-w-0 flex-wrap items-center gap-3 border-t border-border pt-3" data-overview-media-summary>
        <div className="flex h-24 w-40 shrink-0 items-center justify-center overflow-hidden rounded border border-border bg-muted/40">
          {overviewMediaFailed ? <Button size="small" type="text" onClick={() => setOverviewMediaErrors(current => { const next = { ...current }; delete next[overviewStorageKey]; return next; })}>{t("director.atomic.retry")}</Button>
            : overviewClip ? <video className="h-full w-full object-contain" src={backendMediaUrl(overviewClip.storageKey)} aria-label={t("director.studio.clipVideo", { title: segmentTitle(overviewClip.id) })} controls playsInline preload="metadata" onError={() => setOverviewMediaErrors(current => ({ ...current, [overviewClip.storageKey]: true }))} />
            : overviewFrame ? <button type="button" className="h-full w-full cursor-zoom-in" aria-label={t("director.studio.previewAsset", { title: shotTitle(String(overviewShot.id)) })} onClick={() => setMediaPreview({ assetId: String(overviewShot.id), title: shotTitle(String(overviewShot.id)), storageKey: overviewFrame })}><img src={backendMediaUrl(overviewFrame)} alt={shotTitle(String(overviewShot.id))} className="h-full w-full object-contain" onError={() => setOverviewMediaErrors(current => ({ ...current, [overviewFrame]: true }))} /></button>
              : <Film className="size-6 text-muted-foreground" />}
        </div>
        <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{shotTitle(String(overviewShot.id))}</p><p className="mt-1 text-xs text-muted-foreground">{overviewMediaFailed ? t("director.workspace.mediaReadFailed") : overviewInputOutdated ? t("productionCanvas.nodeStatus.outdated") : overviewStorageKey ? t("director.workspace.realMedia") : t("director.studio.noImage")}</p><Button className="mt-1" type="text" size="small" onClick={() => onNavigate("shots", { kind: "shot", id: String(overviewShot.id) })}>{t("director.workspace.manual.openEditor")}</Button></div>
        <details className="w-full" data-overview-preview-details><summary className="cursor-pointer text-xs text-muted-foreground">{t("director.atomic.timeline")} · {sourceShots.length}</summary><div className="mt-3 max-w-2xl">{renderOverviewPreview()}{proseOf(overviewShot.visual) && <p className="mt-2 whitespace-pre-wrap text-sm text-muted-foreground">{proseOf(overviewShot.visual)}</p>}</div></details>
      </section>}
      <details id="director-current-brief" open={!d ? true : undefined} className="border-t border-border pt-2"><summary className="cursor-pointer text-sm font-medium">{t("director.studio.creativeNotes")}</summary>
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2"><span className="text-xs text-muted-foreground">{t("director.workspace.revision", { revision: production.revision })}</span><Button size="small" onClick={onRefresh}>{t("director.workspace.refresh")}</Button></div>
        <Input.TextArea className="mt-2" aria-label={t("director.studio.creativeNotes")} value={briefDraft} disabled={busy} autoSize={{ minRows: 3, maxRows: 10 }} placeholder={t("director.briefPlaceholder")} onChange={event => onBriefDraftChange(event.target.value)} />
        <Button className="mt-2" size="small" disabled={busy || briefDraft === String(source.brief || "")} onClick={() => void onBrief(briefDraft)}>{t("director.workspace.saveBrief")}</Button>
      </details>

      <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-border pt-2"><Button size="small" type="primary" icon={<WandSparkles className="size-3.5" />} disabled={busy || !briefDraft.trim()} onClick={async () => { if (briefDraft !== String(source.brief || "")) await onBrief(briefDraft); onAskDirector({ workspace: presentationWorkspace, targetId: presentation?.targetId, brief: briefDraft, instruction: t("director.workspace.continueInstruction") }); }}>{t("director.workspace.progressCurrent")}</Button></footer>
    </div>;
  };

  const renderStoryWorkspace = () => <div className="space-y-3">
    <ProductionPageHeading titleAlreadyVisible={navigationTitleVisible} title={t("director.studio.script")} summary={t("director.studio.scriptSummary", { scenes: sceneGroups.length, characters: characters.length })} actions={<> <Button icon={<Plus className="size-4" />} disabled={busy || !d} onClick={() => void addScene()}>{t("director.workspace.addScene")}</Button><Button icon={editingScript ? <BookOpen className="size-4" /> : <Pencil className="size-4" />} disabled={!activeScene} onClick={() => setEditingScript(value => !value)}>{t(editingScript ? "director.studio.readScript" : "director.studio.editScript")}</Button><Button icon={<WandSparkles className="size-4" />} disabled={busy} onClick={() => onAskDirector({ workspace: "story", targetId: activeScene?.key })}>{t("director.studio.collaborate")}</Button> </>} />
    <details className="border-b border-border pb-2">
      <summary className="cursor-pointer text-sm font-medium">{t("director.studio.creativeNotes")}</summary>
      <div className="mt-3 space-y-3">
        <Input.TextArea
          aria-label={t("director.studio.creativeNotes")}
          value={briefDraft}
          disabled={busy}
          autoSize={{ minRows: 4, maxRows: 10 }}
          onChange={event => onBriefDraftChange(event.target.value)}
        />
        <Button disabled={busy || briefDraft === String(source.brief || "")} onClick={() => void onBrief(briefDraft)}>
          {t("director.workspace.saveBrief")}
        </Button>
        {Object.keys(story).length > 0 && <section className="space-y-3 rounded-lg border border-border p-3" data-story-structure aria-label={t("director.studio.storyStructure")}>
          <p className="text-sm font-medium">{t("director.studio.storyStructure")}</p>
          {(["synopsis", "A", "B", "C"] as const).map(key => <label key={key} className="grid gap-1">
            <span className="text-xs text-muted-foreground">{t(`director.studio.storyThread.${key}`, key)}</span>
            <SourceField
              value={String(story[key] ?? "")}
              draftValue={sourceDrafts[`story:${key}`]}
              onDraftChange={value => onSourceDraftChange(`story:${key}`, value)}
              multiline rows={2} disabled={busy}
              onCommit={value => onPatch("story", undefined, { [key]: value })}
            />
          </label>)}
          <div className="space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">{t("director.studio.fiveStageArc")}</span>
            <div className="grid gap-1.5 md:grid-cols-5">
              {[0, 1, 2, 3, 4].map(index => <Input
                key={`arc:${String(story.five_stage_arc?.[index] ?? "")}:${index}`}
                size="small"
                defaultValue={String(story.five_stage_arc?.[index] ?? "")}
                placeholder={`${index + 1}`}
                disabled={busy}
                aria-label={t("director.studio.fiveStageArcSlot", { number: index + 1 })}
                onBlur={async event => {
                  onSourceDraftChange(`story:arc:${index}`, event.target.value);
                  const arcs = [0, 1, 2, 3, 4].map(slot => slot === index
                    ? event.target.value
                    : String(sourceDrafts[`story:arc:${slot}`] ?? story.five_stage_arc?.[slot] ?? "")).map(text => text.trim());
                  if (!arcs.every(Boolean)) return;
                  const saved = await onPatch("story", undefined, { five_stage_arc: arcs });
                  if (saved !== false) for (const slot of [0, 1, 2, 3, 4]) onSourceDraftChange(`story:arc:${slot}`, undefined);
                }}
              />)}
            </div>
          </div>
          {(["synopsis", "A", "B", "C"] as const).some(key => sourceDrafts[`story:${key}`] !== undefined)
            || [0, 1, 2, 3, 4].some(index => sourceDrafts[`story:arc:${index}`] !== undefined)
            ? <p className="text-xs text-amber-600">{t("director.studio.unsavedText")}</p>
            : null}
        </section>}
      </div>
    </details>
    {!d ? <Alert type="info" message={t("director.workspace.storyStartsFromBrief")} /> : !activeScene ? <Alert type="info" message={t("director.workspace.storyNotDrafted")} description={t("director.workspace.storyNotDraftedHint")} /> : <div className="grid items-start gap-6 md:grid-cols-[190px_minmax(0,1fr)] xl:grid-cols-[190px_minmax(0,1fr)_190px]">
      <nav aria-label={t("director.studio.sceneDirectory")} className="min-w-0 md:sticky md:top-4"><h3 className="mb-3 text-xs font-medium text-muted-foreground">{t("director.studio.sceneDirectory")}</h3><div className="flex gap-2 overflow-x-auto pb-2 md:flex-col md:overflow-visible">
        {sceneGroups.map((group, index) => <button key={group.key} type="button" aria-current={group.key === activeScene.key ? "true" : undefined} onClick={() => setActiveSceneKey(group.key)} className={`flex min-w-40 items-start gap-3 rounded-lg px-3 py-3 text-left transition-colors md:min-w-0 ${group.key === activeScene.key ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"}`}><span className="pt-0.5 text-xs tabular-nums">{String(index + 1).padStart(2, "0")}</span><span className="min-w-0"><strong className="block break-words text-sm font-medium">{sceneTitle(group, index)}</strong><span className="mt-1 block text-xs">{t("director.studio.blockCount", { count: Array.isArray(group.blocks[0]?.blocks) ? group.blocks[0].blocks.length : group.blocks.length })}</span></span></button>)}
      </div></nav>
      <div className="min-w-0">
        <article className="min-h-[380px] rounded-lg border border-border bg-card px-5 py-6 sm:px-8 sm:py-8">
          <div className="mb-7 border-b border-border pb-5"><p className="mb-2 text-xs font-medium text-muted-foreground">{t("director.studio.sceneNumber", { number: activeSceneIndex + 1 })}</p>{editingScript ? <><label className="grid gap-1.5"><span className="text-xs text-muted-foreground">{t("director.workspace.sceneName")}</span><SourceField ariaLabel={t("director.workspace.sceneName")} value={activeScene.blocks[0].scene_name || activeScene.blocks[0].heading || ""} placeholder={t("director.workspace.sceneName")} draftValue={sourceDrafts[`scene:${activeScene.key}:scene_name`]} onDraftChange={value => onSourceDraftChange(`scene:${activeScene.key}:scene_name`, value)} disabled={busy} onCommit={value => onPatch("scene", activeScene.key, { scene_name: value })} /></label>{(["location", "time_of_day"] as const).map(field => activeScene.blocks[0][field] ? <label key={field} className="grid gap-1.5"><span className="text-xs text-muted-foreground">{t(field === "location" ? "director.workspace.sceneLocation" : "director.workspace.sceneTimeOfDay")}</span><SourceField ariaLabel={t(field === "location" ? "director.workspace.sceneLocation" : "director.workspace.sceneTimeOfDay")} value={readableText(activeScene.blocks[0][field], nameMap)} draftValue={sourceDrafts[`scene:${activeScene.key}:${field}`]} onDraftChange={value => onSourceDraftChange(`scene:${activeScene.key}:${field}`, value)} disabled={busy} onCommit={value => onPatch("scene", activeScene.key, { [field]: value })} /></label> : null)}</> : <h3 className="break-words text-xl font-semibold">{sceneTitle(activeScene, activeSceneIndex)}</h3>}{(activeScene.blocks[0].location || activeScene.blocks[0].time_of_day) && <p className="mt-2 text-sm text-muted-foreground">{[readableText(activeScene.blocks[0].location, nameMap), readableText(activeScene.blocks[0].time_of_day)].filter(Boolean).join(" · ")}</p>}</div>
          <div className="space-y-6">{scriptParagraphList()}</div>
          <div className="mt-8 flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-border pt-4" data-production-danger="scene" data-story-scene-footer><Button type="text" size="small" onClick={() => onAskDirector({ workspace: "story", targetId: activeScene.key, instruction: t("director.workspace.reviseScene") })}>{t("director.studio.reviseScene")}</Button><span className="text-xs text-muted-foreground">{t(editingScript ? "director.studio.autosaveHint" : "director.studio.originalText")}</span><Button className="ml-auto" size="small" danger icon={<Trash2 className="size-4" />} disabled={busy || !activeScene} onClick={() => activeScene && deleteScene(activeScene, activeSceneIndex)}>{t("director.workspace.deleteScene")}</Button></div>
        </article>
        <div className="mt-4 flex items-center justify-between gap-2"><Button type="text" icon={<ArrowLeft className="size-4" />} disabled={activeSceneIndex === 0} onClick={() => setActiveSceneKey(sceneGroups[activeSceneIndex - 1].key)}>{t("director.studio.previousScene")}</Button><span className="text-xs tabular-nums text-muted-foreground">{activeSceneIndex + 1} / {sceneGroups.length}</span><Button type="text" disabled={activeSceneIndex === sceneGroups.length - 1} onClick={() => setActiveSceneKey(sceneGroups[activeSceneIndex + 1].key)}>{t("director.studio.nextScene")}<ArrowRight className="size-4" /></Button></div>
      </div>
      <aside className="min-w-0 space-y-6 md:col-start-2 xl:col-start-auto">
        <section><h3 className="mb-3 flex items-center gap-2 text-xs font-medium text-muted-foreground"><Users className="size-4" />{t("director.studio.characters")}</h3><div className="space-y-4">{characters.map((character, index) => <div key={character.id || index}><h4 className="text-sm font-medium">{humanName(character.name, String(character.id), t("director.studio.characterNumber", { number: index + 1 }))}</h4><p className="mt-1 line-clamp-3 text-xs leading-6 text-muted-foreground">{readableText(character.appearance || character.description || character.prompt_description || character.role, nameMap) || t("director.studio.detailsInAssets")}</p></div>)}</div><Button className="mt-3" size="small" type="text" onClick={() => onNavigate("assets")}>{t("director.studio.viewAssets")}<ArrowRight className="size-3" /></Button></section>
        <section><h3 className="mb-3 flex items-center gap-2 text-xs font-medium text-muted-foreground"><MapPin className="size-4" />{t("director.studio.locations")}</h3><div className="space-y-3">{locations.map((location, index) => <div key={location.id || index}><p className="text-sm">{humanName(location.name, String(location.id), t("director.studio.sceneNumber", { number: index + 1 }))}</p>{editingScript && typeof location.prompt_description === "string" && <label className="mt-1 grid gap-1"><span className="text-xs text-muted-foreground">{t("director.studio.locationPrompt")}</span><SourceField value={location.prompt_description} draftValue={sourceDrafts[`environment:${String(location.id)}:prompt_description`]} onDraftChange={value => onSourceDraftChange(`environment:${String(location.id)}:prompt_description`, value)} multiline rows={3} disabled={busy} onCommit={value => onPatch("environment", String(location.id), { prompt_description: value })} /></label>}</div>)}</div></section>
        {storyBeatCards(records(story.beats), activeScene?.sceneId).length > 0 && <section><h3 className="mb-3 text-xs font-medium text-muted-foreground">{t("director.studio.storyBeats")}</h3>{storyBeatCards(records(story.beats), activeScene?.sceneId).map(({ beat, text, repeatedFields }, index) => <article key={beat.id || index} className="mb-4 border-b border-border pb-3"><p className="text-sm leading-6">{text || t("director.canvasOverlay.beatNeedsDesign")}</p>{!text && <Button size="small" type="text" onClick={() => onAskDirector({ workspace: "story", targetId: String(beat.id || "") })}>{t("productionCanvas.discussObject")}</Button>}<details className="mt-2 text-xs text-muted-foreground"><summary className="cursor-pointer">{t("director.studio.beatAnalysis")}</summary>{["goal", "obstacle", "choice", "cost", "result"].map(field => beat[field] ? <p key={field} className="mt-2 leading-5"><strong>{t("director.studio.beatField." + field)}：</strong>{readableText(beat[field], nameMap)}</p> : null)}</details></article>)}</section>}
      </aside>
    </div>}
  </div>;

  // 结构化剧本场次把段落嵌在 .blocks[]（acheng v2 产物）；旧版把每个场次条目本身当作一个段落。
  // 两种形态在这里统一成"段落列表"；增段/删段/重排/换说话人以整段数组走 patch_director_source(scene.blocks)。
  const sceneParagraphs = (group: ReturnType<typeof groupScriptScenes>[number]): Record<string, any>[] => { const first = group.blocks[0]; return Array.isArray(first?.blocks) ? records(first.blocks) : []; };
  const commitSceneBlocks = (blocks: Record<string, any>[]) => onPatch("scene", activeScene.key, { blocks });
  const nextBlockId = (existing: Record<string, any>[]) => { let n = Math.max(0, ...existing.map(block => Number(String(block.id).match(/N(\d+)$/)?.[1]) || 0)) + 1; while (existing.some(block => String(block.id) === `${activeScene.key}-N${String(n).padStart(2, "0")}`)) n += 1; return `${activeScene.key}-N${String(n).padStart(2, "0")}`; };
  const speakerOptions = useMemo(() => { const names = new Set<string>(); for (const group of sceneGroups) for (const block of sceneParagraphs(group)) if (block.speaker) names.add(String(block.speaker)); for (const character of characters) if (character.name) names.add(String(character.name)); return [...names].map(name => ({ value: name, label: name })); }, [JSON.stringify(sceneGroups), JSON.stringify(characters)]);
  const scriptParagraphList = () => { const nested = sceneParagraphs(activeScene); const rows = nested.length ? nested : activeScene.blocks; const structural = nested.length > 0;
    const moveRow = (index: number, delta: number) => { const target = index + delta; if (!structural || target < 0 || target >= rows.length) return; const swapped = [...nested]; [swapped[index], swapped[target]] = [swapped[target], swapped[index]]; void commitSceneBlocks(swapped); };
    const removeRow = (blockId: string) => Modal.confirm({ title: t("director.workspace.deleteBlockTitle"), content: t("director.workspace.deleteBlockConfirm"), okText: t("director.workspace.deleteSceneConfirmButton"), okButtonProps: { danger: true, disabled: busy }, cancelText: t("director.workspace.cancel"), onOk: async () => { if (!(await commitSceneBlocks(nested.filter(item => String(item.id) !== blockId)))) throw new Error(t("director.workspace.deleteAssetFailed")); } });
    return <>{rows.map((block, index) => { const id = String(block.id || block.scene_id || ""); const isDialogue = Boolean(block.speaker) || block.kind === "dialogue" || block.type === "dialogue"; const localText = sourceDrafts[`scene:${id}:text`];
      const commitText = (value: unknown) => { const text = String(value ?? ""); return structural ? commitSceneBlocks(nested.map(item => String(item.id) === id ? { ...item, text } : item)) : (id ? onPatch("scene", id, { text }) : false); };
      return <div key={`${id}:${index}`} data-production-target={`scene:${id}`} className={isDialogue && !editingScript ? "ml-6 max-w-xl border-l-2 border-border pl-4 sm:ml-10" : ""}>
        {editingScript && structural && <span className="mb-1.5 flex items-center gap-1">{isDialogue ? <Select aria-label={t("director.studio.dialogue")} size="small" allowClear showSearch placeholder={t("director.workspace.chooseSpeaker")} value={block.speaker ? String(block.speaker) : undefined} options={speakerOptions} onChange={value => void commitSceneBlocks(nested.map(item => String(item.id) === id ? { ...item, speaker: String(value ?? "") } : item))} className="h-7 min-w-0 max-w-40 text-xs" /> : <span className="text-[11px] text-muted-foreground">{t("director.workspace.actionBlockLabel")}</span>}<span className="ml-auto flex items-center gap-0.5"><Button type="text" size="small" icon={<ArrowUp className="size-3.5" />} disabled={busy || index === 0} onClick={() => moveRow(index, -1)} aria-label={t("director.workspace.moveBlockUp")} /><Button type="text" size="small" icon={<ArrowDown className="size-3.5" />} disabled={busy || index === rows.length - 1} onClick={() => moveRow(index, 1)} aria-label={t("director.workspace.moveBlockDown")} /><Button type="text" size="small" danger icon={<Trash2 className="size-3.5" />} disabled={busy} onClick={() => removeRow(id)} aria-label={t("director.workspace.deleteBlockAction")} /></span></span>}
        {isDialogue && !editingScript && <p className="mb-2 text-sm font-semibold">{nameMap[block.speaker] || block.speaker || t("director.studio.dialogue")}</p>}
        {editingScript ? <label className="grid gap-1.5"><span className="text-xs text-muted-foreground">{t("director.workspace.scriptText")}</span><SourceField ariaLabel={t("director.workspace.scriptText")} value={block.text || ""} draftValue={localText} onDraftChange={value => onSourceDraftChange(`scene:${id}:text`, value)} multiline rows={3} disabled={busy} placeholder={t("director.workspace.scriptText")} onCommit={commitText} /></label> : <p className="whitespace-pre-wrap break-words text-base leading-8">{localText ?? (isDialogue ? dialogueBody(block) : String(block.text || ""))}</p>}
        {localText !== undefined && <p className="mt-2 text-xs text-amber-600">{t("director.studio.unsavedText")}</p>}
      </div>; })}
      {structural && editingScript && <span className="flex flex-wrap gap-2"><Button type="text" size="small" icon={<Plus className="size-3.5" />} disabled={busy} onClick={() => void commitSceneBlocks([...nested, { id: nextBlockId(nested), kind: "action", text: "" }])}>{t("director.workspace.addActionBlock")}</Button><Button type="text" size="small" icon={<Plus className="size-3.5" />} disabled={busy} onClick={() => void commitSceneBlocks([...nested, { id: nextBlockId(nested), kind: "dialogue", speaker: "", text: "" }])}>{t("director.workspace.addDialogueBlock")}</Button></span>}</>;
  };
  const visibleSubjects = records(source.subject_registry).filter(subject => (assetFilter === "all" || assetFilter === (["character", "animal"].includes(String(subject.kind)) ? "characters" : subject.kind === "scene" ? "locations" : "props")) && matchesAssetSearch(subjectDisplayName(source, String(subject.id)), assetSearch));
  const activeSubject = visibleSubjects.find(subject => subject.id === selectedSubjectId) || visibleSubjects[0];
  const renderAssets = () => <div className="space-y-3">
    <ProductionPageHeading titleAlreadyVisible={navigationTitleVisible} title={t(subjectAssembly ? "director.atomic.subjects" : "director.studio.assets")} summary={assetScopeHint} help={<p>{t(subjectAssembly ? "director.workspace.subjectBindingHint" : "director.studio.assetsHint")}</p>} actions={<> <Button icon={<Plus className="size-4" />} disabled={busy || !d} onClick={() => { setNewAssetKind("prop"); setNewAssetName(""); setNewAssetDescription(""); setNewAssetPrompt(""); setNewAssetPurpose(""); setNewAssetOpen(true); }}>{t("director.crud.addManualAsset")}</Button><Button icon={<WandSparkles className="size-4" />} disabled={busy} onClick={() => onAskDirector({ workspace: "assets" })}>{t("director.studio.collaborate")}</Button> </>} />
    <Modal open={newAssetOpen} title={t("director.crud.addManualAsset")} onCancel={() => setNewAssetOpen(false)} onOk={() => void addManualAsset()} okText={t("common.save")} cancelText={t("common.cancel")} confirmLoading={creatingAsset} okButtonProps={{ disabled: busy || !d || !newAssetName.trim() }}>
      <div className="space-y-3">
        <label className="grid gap-1 text-xs"><span>{t("director.crud.manualAssetKind")}</span><Select value={newAssetKind} disabled={creatingAsset} onChange={value => setNewAssetKind(value)} options={(["character", "scene", "prop"] as const).map(kind => ({ value: kind, label: t(`director.workspace.subjectKind.${kind}`) }))} /></label>
        <label className="grid gap-1 text-xs"><span>{t("director.crud.manualAssetName")}</span><Input autoFocus value={newAssetName} onChange={event => setNewAssetName(event.target.value)} /></label>
        <label className="grid gap-1 text-xs"><span>{t("director.crud.manualAssetPurpose")}</span><Input value={newAssetPurpose} onChange={event => setNewAssetPurpose(event.target.value)} /></label>
        <label className="grid gap-1 text-xs"><span>{t("director.crud.manualAssetDescription")}</span><Input.TextArea rows={3} value={newAssetDescription} onChange={event => setNewAssetDescription(event.target.value)} /></label>
        <label className="grid gap-1 text-xs"><span>{t("director.crud.manualAssetPrompt")}</span><Input.TextArea rows={4} value={newAssetPrompt} onChange={event => setNewAssetPrompt(event.target.value)} /></label>
      </div>
    </Modal>
    {error && <Alert type="error" showIcon message={error} />}
    {d && onPrepareEntities && (hasMissingEntityNode || hasMissingStyleAnchorNode) && <Button size="small" disabled={busy} onClick={() => void onPrepareEntities()}>{t("director.crud.prepareEntityNodes")}</Button>}
    {d && <details className="border-b border-border pb-4"><summary className="cursor-pointer text-sm text-muted-foreground">{t("director.studio.styleSettings")}</summary><section className="mt-3 grid gap-3 md:grid-cols-2">
      {(() => {
        const lock = source.style_lock as Record<string, unknown> | undefined;
        const anchorAssetId = String(lock?.anchor_asset_id || "");
        const anchorNodeId = String(source.style_anchor_node_id || "");
        const value = anchorNodeId ? `node:${anchorNodeId}` : anchorAssetId ? `asset:${anchorAssetId}` : undefined;
        const styleAssets = assetPlan.filter(item => String(item.role || item.asset_type || "").toUpperCase() === "STYLE_MOTHER" || String(item.kind || "").toLowerCase() === "style");
        const hasArchivedImage = (node: CanvasNodeOption) => {
          const metadata = node.metadata || {};
          if (node.type === "image") return Boolean(metadata.storageKey);
          if (node.type === "character") return Array.isArray(metadata.characterImages) && metadata.characterImages.some((image: Record<string, unknown>) => typeof image.storageKey === "string" && image.storageKey);
          if (node.type === "scene") return Boolean((metadata.sceneImage as Record<string, unknown> | undefined)?.storageKey);
          if (node.type === "prop") return Boolean((metadata.propImage as Record<string, unknown> | undefined)?.storageKey);
          if (node.type === "config" && (metadata.generationMode || "image") === "image") {
            return metadata.smart === true
              ? Array.isArray(metadata.images) && metadata.images.some((image: Record<string, unknown>) => typeof image.storageKey === "string" && image.storageKey)
              : metadata.status === "success" && typeof metadata.storageKey === "string" && Boolean(metadata.storageKey);
          }
          return false;
        };

        const styleNodes = canvasNodes.filter(hasArchivedImage);
        const options = [
          ...styleAssets.map(item => ({ value: `asset:${assetIdOf(item)}`, label: assetTitle(item) })),
          ...styleNodes.map(node => ({ value: `node:${node.id}`, label: t("director.workspace.styleCanvasNode", { title: node.title || node.id }) })),
        ];
        return <>
          <label className="grid gap-1 text-sm"><span className="font-medium">{t("director.workspace.styleMother")}</span><Select allowClear value={value} disabled={busy} placeholder={t("director.workspace.chooseStyleMother")} options={options} onChange={selected => {
            if (!selected) {
              void onPatch("style", undefined, { anchor_asset_id: "", style_anchor_node_id: "", style_policy: "waived", style_policy_reason: t("director.workspace.styleUnboundReason") });
            } else if (selected.startsWith("node:")) {
              const nodeId = selected.slice("node:".length);
              const node = styleNodes.find(item => item.id === nodeId);
              void onPatch("style", undefined, { anchor_asset_id: "", style_anchor_node_id: nodeId, style_policy: "waived", style_policy_reason: t("director.workspace.styleCanvasNodeReason", { title: node?.title || nodeId }) });
            } else {
              void onPatch("style", undefined, { anchor_asset_id: selected.slice("asset:".length), style_anchor_node_id: "", style_policy: "required", style_policy_reason: "" });
            }
          }} /></label>
          <label className="grid gap-1 text-sm"><span className="font-medium">{t("director.workspace.stylePolicy")}</span><Select value={String(source.style_policy || "") || undefined} placeholder={t("director.workspace.styleOptional")} disabled={busy || Boolean(anchorNodeId)} options={[{ value: "required", label: t("director.workspace.styleRequired") }, { value: "waived", label: t("director.workspace.styleWaived") }]} onChange={value => void onPatch("style", undefined, { style_policy: value, style_policy_reason: value === "waived" ? String(source.style_policy_reason || "") : "" })} /></label>
        </>;
      })()}
      {source.style_policy === "waived" && <label className="grid gap-1 text-sm md:col-span-2"><span>{t("director.workspace.styleWaiverReason")}</span><SourceField value={source.style_policy_reason || ""} draftValue={sourceDrafts["style:style_policy_reason"]} onDraftChange={value => onSourceDraftChange("style:style_policy_reason", value)} multiline rows={2} disabled={busy} onCommit={value => onPatch("style", undefined, { style_policy_reason: value })} /></label>}

    </section></details>}
    <div className="flex flex-wrap items-center justify-between gap-3"><div className="flex flex-wrap gap-1">{["all", "characters", "locations", "props"].map(filter => <button type="button" key={filter} aria-pressed={assetFilter === filter} className={`rounded-lg px-3 py-2 text-sm ${assetFilter === filter ? "bg-muted font-medium" : "text-muted-foreground hover:bg-muted/50"}`} onClick={() => setAssetFilter(filter)}>{t(`director.studio.filter.${filter}`)}</button>)}</div><div className="flex w-full flex-wrap items-center gap-2 sm:w-auto" data-asset-search-actions><div className="w-60 max-w-full"><Input allowClear className="w-full" prefix={<Search className="size-4 text-muted-foreground" />} placeholder={t("director.studio.searchAssets")} aria-label={t("director.studio.searchAssets")} value={assetSearch} onChange={event => setAssetSearch(event.target.value)} /></div>{d && subjectAssembly && <Button disabled={busy} onClick={() => setNewSubjectOpen(true)}>{t("director.crud.addSubject")}</Button>}</div></div>
    {(() => {
      const visibleCanvasAssets = canvasAssetRows.filter(item => {
        if (subjectAssembly) {
          const binding = productionEntityBinding(item.node.metadata?.productionEntity);
          if (records(source.subject_registry).some(subject => {
            const ref = subject.entityRef;
            return binding && ref && ref.ownerKind === binding.ownerKind && ref.ownerId === binding.ownerId
              && ref.id === binding.entityId && (ref.kind === "asset" ? "prop" : ref.kind) === binding.kind
              || records(subject.pictureBindings).some(picture => picture.sourceNode?.projectId === canvasId && picture.sourceNode?.nodeId === item.node.id);
          })) return false;
        }
        return (assetFilter === "all" || assetFilter === item.kind) && matchesAssetSearch(item.name, assetSearch);
      });
      return visibleCanvasAssets.length ? <details open={!subjectAssembly} className="space-y-2 rounded-lg border border-border bg-card p-3" data-canvas-asset-nodes>
        <summary className="cursor-pointer text-sm font-semibold">{t(subjectAssembly ? "director.crud.otherCanvasAssetNodes" : "director.crud.canvasAssetNodes")} <Tag>{visibleCanvasAssets.length}</Tag></summary>
        <div className="grid gap-2 sm:grid-cols-2 2xl:grid-cols-4">{visibleCanvasAssets.map(item => <CanvasAssetInfoCard key={item.node.id} item={item} busy={busy} canvasId={canvasId} onSave={(node, payload) => onPatchCanvasAsset?.(node, payload) ?? Promise.resolve(false)} onRemove={canvasRole === "episode" && onRemoveCanvasAsset ? () => removeCanvasAsset(item.node.id, item.name) : undefined} />)}</div>
      </details> : null;
    })()}
    {!d ? <Alert type="info" message={t("director.workspace.assetsNeedDirector")} /> : isSubjectPromptAssembly(source) ? <section className="space-y-3" data-subject-registry-editor>
      <Modal open={newSubjectOpen} title={t("director.crud.addSubject")} onCancel={() => setNewSubjectOpen(false)} footer={<Button type="primary" disabled={busy || !newSubjectEntity} onClick={() => {
        if (!newSubjectEntity || !onUpsertSubject) return;
        const subjectId = `SUBJECT_${crypto.randomUUID()}`;
        const entity = JSON.parse(newSubjectEntity), ownerKind = typeof subjectOwner === "string" ? "episode" : "canvas", ownerId = typeof subjectOwner === "string" ? subjectOwner : canvasId;
        void onUpsertSubject({ id: subjectId, kind: entity.kind === "character" ? "character" : entity.kind === "scene" ? "scene" : "prop", entityRef: { ownerKind, ownerId, kind: entity.kind, id: entity.id }, pictureBindings: [] }).then(saved => { if (saved) { setSelectedSubjectId(subjectId); setNewSubjectOpen(false); setNewSubjectEntity(undefined); } });
      }}>{t("director.crud.registerSubject")}</Button>}><p className="mb-3 text-sm text-muted-foreground">{t("director.crud.subjectRegisterHint")}</p><Select className="w-full" value={newSubjectEntity} onChange={setNewSubjectEntity} options={[...characters.map(row => ({ kind: "character", row })), ...locations.map(row => ({ kind: "scene", row })), ...assetPlan.map(row => ({ kind: "asset", row }))].filter(({ kind, row }) => !records(source.subject_registry).some(subject => subject.entityRef?.kind === kind && subject.entityRef?.id === String(row.id || row.asset_id))).map(({ kind, row }) => ({ value: JSON.stringify({ kind, id: String(row.id || row.asset_id) }), label: String(row.name || row.asset_name || row.scene_name || row.title || t("director.crud.unnamedEntity")) }))} /></Modal>
      {!visibleSubjects.length && <div className="production-empty-state"><p>{t(records(source.subject_registry).length ? "director.studio.emptySearch" : "director.atomic.noRegisteredSubjects")}</p>{records(source.subject_registry).length > 0 ? <Button onClick={() => { setAssetFilter("all"); setAssetSearch(""); }}>{t("director.atomic.clearFilters")}</Button> : <Button disabled={busy} onClick={() => setNewSubjectOpen(true)}>{t("director.crud.addSubject")}</Button>}</div>}
      <div className="grid items-start gap-5 lg:grid-cols-[200px_minmax(0,1fr)]"><nav className="max-h-64 overflow-y-auto rounded-xl border border-border lg:max-h-[70dvh]" aria-label={t("director.atomic.subjects")}>{visibleSubjects.map(subject => <button type="button" key={subject.id} aria-current={activeSubject?.id === subject.id ? "true" : undefined} onClick={() => setSelectedSubjectId(subject.id)} className={`block w-full border-b border-border px-3 py-3 text-left last:border-0 ${activeSubject?.id === subject.id ? "bg-muted" : "hover:bg-muted/40"}`}><span className="block truncate text-sm font-medium">{subjectDisplayName(source, String(subject.id))}</span><span className="mt-1 block text-xs text-muted-foreground">{t(`director.workspace.subjectKind.${String(subject.kind || "other")}`)} · {t("director.studio.boundPictures", { count: records(subject.pictureBindings).length })}</span></button>)}</nav><div className="min-w-0">{(activeSubject ? [activeSubject] : []).map(subject => {
        const entity = subject.entityRef || {}, entityId = String(entity.id || ""), character = records(source.character_registry).find(row => row.id === entityId), scene = records(source.scene_registry).find(row => row.id === entityId), asset = assetPlan.find(row => assetIdOf(row) === entityId);
        const title = String(character?.name || scene?.name || asset?.asset_name || asset?.name || entityId || subject.id);
        const usageCount = records(source.shots).filter(shot => records(shot.subject_usages).some(usage => usage.subjectId === subject.id)).length;
        const manualAssets = manualAssetsForSubject(source, subject, { kind: typeof subjectOwner === "string" ? "episode" : "canvas", id: typeof subjectOwner === "string" ? subjectOwner : canvasId });
        const entityNode = canvasNodes.find(node => matchesProductionEntityTarget(productionEntityBinding(node.metadata?.productionEntity), { entityId, kind: entity.kind === "asset" ? "prop" : entity.kind, ownerId: entity.ownerId, ownerKind: entity.ownerKind }));
        const entitySource = entityNode ? { projectId: canvasId, nodeId: entityNode.id } : undefined;
        const entityNavigation = subjectPictureNavigation(records(subject.pictureBindings), entitySource, { id: canvasId, nodeIds: canvasNodes.map(node => node.id) }).entitySource;
        return <article key={String(subject.id)} className="grid min-w-0 gap-4 rounded-lg border border-border bg-card p-4 xl:grid-cols-[minmax(0,1fr)_320px]">
          <div className="flex flex-wrap items-center justify-between gap-2 xl:col-span-2"><div><h3 className="font-semibold">{title}</h3><p className="text-xs text-muted-foreground">{t("director.workspace.subjectConsumers", { count: usageCount })}</p></div><div className="flex flex-wrap items-center gap-2"><Tag>{t(`director.workspace.subjectKind.${String(subject.kind || "other")}`)}</Tag></div></div>
          <details open className="min-w-0 border-t border-border pt-3 xl:col-start-2 xl:row-start-2 xl:max-h-[65dvh] xl:overflow-y-auto"><summary className="cursor-pointer text-sm">{t("director.crud.editSubject")}</summary><div className="mt-3 space-y-3">{entityNavigation && <div data-subject-material-actions><ReferenceNodeLink sourceNode={entityNavigation} label={t("director.subjectImages.openSubjectMaterial")} /></div>}{(() => {
            const entityType = entity.kind === "character" ? "character" : entity.kind === "scene" ? "environment" : "asset";
            const row = entity.kind === "character" ? character : entity.kind === "scene" ? scene : asset;
            const descriptionField = subjectDescriptionField(entityType, row || {});
            // A 类补齐：角色/环境按字段逐个编辑（原先只命中一个合并字段），仅展示源稿里实际有内容的字段。
            const descriptionFields: Array<[string, string]> = entityType === "character" ? [["appearance", "director.crud.fieldAppearance"], ["description", "director.crud.fieldDescription"], ["prompt_description", "director.crud.fieldPromptDescription"], ["identity", "director.crud.fieldIdentity"], ["voice_description", "director.crud.fieldVoice"]] : entityType === "environment" ? [["prompt_description", "director.crud.fieldPromptDescription"], ["description", "director.crud.fieldDescription"]] : [];
            const presentFields = descriptionFields.filter(([field]) => String((row || {})[field] || "").trim());
            const card = entityType === "asset" ? records(source.asset_cards).find(value => assetIdOf(value) === entityId) : undefined;
            const own = entity.ownerId === (typeof subjectOwner === "string" ? subjectOwner : canvasId);
            return row ? <><label className="grid gap-1 text-xs"><span>{t("director.crud.subjectName")}</span><SourceField value={row.name || row.asset_name || ""} draftValue={sourceDrafts[`subject:${subject.id}:name`]} onDraftChange={value => onSourceDraftChange(`subject:${subject.id}:name`, value)} disabled={busy || !own} onCommit={name => onPatch(entityType, entityId, { [entityType === "asset" ? "asset_name" : "name"]: name })} /></label>{presentFields.length ? presentFields.map(([field, labelKey]) => <label key={field} className="grid gap-1 text-xs"><span>{t(labelKey)}</span><SourceField value={proseOf(row[field])} draftValue={sourceDrafts[`subject:${subject.id}:${field}`]} onDraftChange={value => onSourceDraftChange(`subject:${subject.id}:${field}`, value)} multiline rows={4} disabled={busy || !own} onCommit={value => onPatch(entityType, entityId, { [field]: patchProse(row[field], value) })} /></label>) : <label className="grid gap-1 text-xs"><span>{t("director.crud.subjectDescription")}</span><SourceField value={proseOf(row[descriptionField])} draftValue={sourceDrafts[`subject:${subject.id}:description`]} onDraftChange={value => onSourceDraftChange(`subject:${subject.id}:description`, value)} multiline rows={3} disabled={busy || !own} onCommit={value => onPatch(entityType, entityId, { [descriptionField]: patchProse(row[descriptionField], value) })} /></label>}{card && <label className="grid gap-1 text-xs"><span>{t("director.crud.manualAssetPrompt")}</span><SourceField value={String(card.prompt || "")} draftValue={sourceDrafts[`asset_card:${entityId}:prompt`]} onDraftChange={value => onSourceDraftChange(`asset_card:${entityId}:prompt`, value)} multiline rows={4} disabled={busy || !own} onCommit={value => onPatch("asset_card", entityId, { prompt: String(value) })} /></label>}{card && (records(card.seven_steps).length > 0 || records(card.references).length > 0) && <details className="rounded-lg border border-border p-2 text-xs" data-asset-card-steps><summary className="cursor-pointer select-none font-medium text-muted-foreground">{t("director.crud.sevenStepsTitle")} · {records(card.references).length}</summary><div className="mt-2"><SevenStepsReferencesEditor key={entityId} card={card} disabled={busy || !own} onSave={patch => onPatch("asset_card", entityId, patch)} /></div></details>}{!own && <p className="text-xs text-muted-foreground">{t("director.crud.sharedEntityReadOnly")}</p>}</> : null;
          })()}<div className="space-y-1 border-t border-border pt-3">{records(source.shots).filter(shot => records(shot.subject_usages).some(usage => usage.subjectId === subject.id)).map(shot => <button key={shot.id} type="button" className="block w-full truncate text-left text-xs text-primary" onClick={() => onNavigate("shots", { kind: "shot", id: String(shot.id) })}>{shotTitle(String(shot.id))}</button>)}</div></div></details>
         <div className="min-w-0 xl:col-start-1 xl:row-start-2 xl:max-h-[65dvh] xl:overflow-y-auto"><SubjectPictureBindings subject={subject} assets={d.assets} assetPlan={assetPlan} canvasNodes={canvasNodes} canvasId={canvasId} owner={subjectOwner} busy={busy} entitySource={entitySource} usages={records(source.shots).flatMap(shot => records(shot.subject_usages).filter(usage => usage.subjectId === subject.id))} sourceDrafts={sourceDrafts} onSourceDraftChange={onSourceDraftChange} onSave={next => onUpsertSubject ? onUpsertSubject(next as Extract<ProductionOperation, { type: "upsert_director_subject" }>["subject"]) : Promise.resolve(false)} /></div>
          <details className="border-t border-border pt-3 xl:col-span-2" data-production-danger="subject"><summary className="cursor-pointer text-xs text-muted-foreground">{t("director.micro.objectManagement")}</summary><div className="mt-3 space-y-3"><div className="flex flex-wrap gap-2">{onDeleteAsset && manualAssets.map(plan => <Button key={assetIdOf(plan)} size="small" danger disabled={busy} onClick={() => deleteAsset(assetIdOf(plan))}>{t("director.workspace.deleteAssetAction")}{manualAssets.length > 1 ? ` · ${assetName(assetIdOf(plan))}` : ""}</Button>)}</div><Button size="small" danger type="text" disabled={busy || usageCount > 0} onClick={() => void onDeleteSubject?.(String(subject.id))}>{t("director.crud.removeSubject")}</Button><p className="text-xs text-muted-foreground">{t("director.crud.removeSubjectHint")}</p></div></details>
        </article>;
      })}</div></div>
      {!records(source.subject_registry).length && <Alert type="info" message={t("director.workspace.subjectsEmpty")} />}
    </section> : allAssetIds.length ? (() => {
      // 分镜关键帧归分镜工作台；这里展示普通制作资产。
      const visibleAssetIds = allAssetIds.filter(id => !keyframeAssetIds.has(id) && (!embedded || !focusTarget?.startsWith("asset:") || id === focusedId) && (assetFilter === "all" || assetCategory(id) === assetFilter) && matchesAssetSearch(assetName(id), assetSearch));
      const shotForAsset = (id: string) => Object.entries(d.shotInputs).find(([, input]) => input.keyframeAssetId === id)?.[0];
      const orderedAssetIds = visibleAssetIds;
      if (!orderedAssetIds.length) return <div className="production-empty-state"><p>{t("director.studio.emptySearch")}</p><Button onClick={() => { setAssetFilter("all"); setAssetSearch(""); }}>{t("director.atomic.clearFilters")}</Button></div>;
      const activeAssetId = orderedAssetIds.includes(selectedAssetId) ? selectedAssetId : orderedAssetIds[0];
      const activeShotId = activeAssetId ? shotForAsset(activeAssetId) : undefined;
      if (embedded && focusTarget?.startsWith("asset:") && activeAssetId) return renderAssetCard(activeAssetId, assetPlan.find(value => assetIdOf(value) === activeAssetId), activeShotId);
      return <div className="grid min-h-[28rem] items-start gap-4 lg:grid-cols-[220px_minmax(0,1fr)]">
        <nav aria-label={t("director.workspace.reviewQueue")} className="overflow-hidden rounded-lg border border-border bg-card">
          <div className="flex items-center justify-between border-b border-border px-4 py-3"><h3 className="text-sm font-semibold">{t("director.studio.assetList")}</h3><Tag>{orderedAssetIds.length}</Tag></div>
          <div className="max-h-64 overflow-y-auto lg:max-h-[70dvh]">
            {orderedAssetIds.map(assetId => {
              const shotId = shotForAsset(assetId);
              const media = mediaForAsset(assetId, shotId);
              const active = assetId === activeAssetId;
              const deletablePlan = !shotId && !keyframeAssetIds.has(assetId) && assetPlan.some(item => assetIdOf(item) === assetId);
              return <div key={assetId} className={`flex items-center gap-1 border-b border-border px-2 last:border-b-0 ${active ? "bg-muted/60" : "hover:bg-muted/30"}`}>
                <button type="button" aria-current={active ? "true" : undefined} onClick={() => setSelectedAssetId(assetId)} className="flex min-w-0 flex-1 items-center gap-2 py-2.5 text-left">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded border border-border">{media.storageKey ? <img className="h-full w-full object-contain" src={backendMediaUrl(media.storageKey)} alt="" loading="lazy" /> : <ImageIcon className="size-4 text-muted-foreground" />}</span><span className="min-w-0 flex-1"><strong className="block truncate text-sm font-medium" title={assetName(assetId)}>{shotId ? `${shotTitle(shotId)} · ${t("director.studio.keyframe")}` : assetName(assetId)}</strong><span className="mt-1 block truncate text-xs text-muted-foreground">{t(`director.studio.filter.${assetCategory(assetId)}`)}</span></span>
                  <Tag className="shrink-0" color={media.status === "generated" ? "blue" : media.status === "approved" ? "green" : media.status === "rejected" ? "red" : undefined}>{t(`director.workspace.assetStatus.${media.status}`)}</Tag>
                </button>
                {deletablePlan && onDeleteAsset && <Button size="small" type="text" danger icon={<Trash2 className="size-3.5" />} disabled={busy} aria-label={t("director.workspace.deleteAssetTitle", { asset: assetName(assetId) })} title={t("director.workspace.deleteAssetTitle", { asset: assetName(assetId) })} onClick={() => deleteAsset(assetId)} />}
              </div>;
            })}
          </div>
        </nav>
        <div className="min-w-0">{activeAssetId ? renderAssetCard(activeAssetId, assetPlan.find(value => assetIdOf(value) === activeAssetId), activeShotId, { gallery: true }) : <div className="flex h-full items-center justify-center rounded-xl border border-border bg-card p-8 text-sm text-muted-foreground">{t("director.workspace.noAssets")}</div>}</div>
      </div>;
    })() : <Alert type="info" message={t("director.workspace.noAssets")} description={t("director.workspace.noAssetsHint")} />}
  </div>;

  // 分镜图跟随镜头，但只占一小条：缩略图 + 状态；合同编辑收进「详情」。
  const renderShotKeyframe = (shotId: string, editor?: { editing: boolean; nodeId?: string; onNodeChange: (nodeId: string) => void; onUnbind: () => void }) => {
    const assetId = d?.shotInputs[shotId]?.keyframeAssetId;
    const media = assetId ? mediaForAsset(assetId, shotId) : undefined;
    const draftNodeId = editor?.editing ? editor.nodeId : undefined;
    const storageKey = draftNodeId ? canvasImageStorageKey(draftNodeId) : media?.storageKey || frameForShot(shotId) || "";
    const binding = keyframeBindingState(assetId, draftNodeId || media?.nodeId, storageKey, imageNodes.map(node => node.id));
    const previewNode = draftNodeId ? canvasNodes.find(node => node.id === draftNodeId) : undefined;
    if (!storageKey && !binding.registered) return null;
    const title = `${shotTitle(shotId)} · ${t("director.studio.keyframe")}`;
    const openPreview = () => setMediaPreview({ assetId: assetId || "", title, storageKey });
    return <section data-production-target={`frame:${shotId}`} className="rounded-lg border border-border bg-card">
      <div className="flex flex-wrap items-center gap-3 px-3 py-2">
        {storageKey ? <button type="button" onClick={openPreview} title={title} aria-label={t("director.studio.previewAsset", { title })} className="h-[54px] w-[96px] shrink-0 overflow-hidden rounded border border-border bg-muted/30">
          <img className="h-full w-full object-cover" src={backendMediaUrl(storageKey)} alt={title} loading="lazy" />
        </button> : <div aria-hidden="true" className="flex h-[54px] w-[96px] shrink-0 items-center justify-center rounded border border-border bg-muted/30"><ImageIcon className="size-5 text-muted-foreground" /></div>}
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          <span className="min-w-0 truncate text-xs font-medium">{previewNode?.title || (assetId ? assetName(assetId) : t("director.studio.canvasKeyframe"))}</span>
          {media && !draftNodeId && <Tag className="m-0" color={media.status === "approved" ? "green" : media.status === "generated" ? "blue" : media.status === "rejected" ? "red" : "default"}>{t(`director.workspace.assetStatus.${media.status}`)}</Tag>}
        </div>
        {/* 跳画布：直接定位到这张分镜图所在的画布节点（缩略图仍可点开大图预览）。 */}
        {(draftNodeId || media?.nodeId) && <ReferenceNodeLink sourceNode={{ projectId: media?.asset?.sharedSource?.sourceProjectId || canvasId, nodeId: draftNodeId || media?.nodeId || "" }} />}
      </div>
      {assetId && <div className="space-y-2 border-t border-border px-3 py-2" data-keyframe-binding>
        <div className="flex items-end gap-2"><label className="grid min-w-0 flex-1 gap-1 text-xs text-muted-foreground"><span>{t("director.studio.linkImage")}</span><Select value={editor?.nodeId || binding.selectedNodeId} disabled={!editor?.editing || busy || !imageNodes.length} placeholder={t("director.workspace.bindCanvasImage")} options={imageNodes.map((node, index) => ({ value: node.id, label: humanName(node.title, node.id, t("director.studio.imageNumber", { number: index + 1 })) }))} onChange={nodeId => nodeId && editor?.onNodeChange(nodeId)} /></label>
        </div>
        {binding.unavailableNode && <Alert type="warning" showIcon message={t("director.studio.keyframeNodeUnavailable")} />}
        {media && <details><summary className="cursor-pointer text-[11px] text-muted-foreground">{t("director.studio.keyframeDetails")}</summary><div className="mt-3 space-y-3">{renderAssetContractFields(assetId, assetPlan.find(item => assetIdOf(item) === assetId), media, { description: true, binding: false })}</div></details>}
      </div>}
    </section>;
  };

  const renderShotDetails = (shot: Record<string, any>, includeCompleteSource = false, workbench?: Record<string, any>) => {
    const id = String(shot.id || "");
    if (d && isSubjectPromptAssembly(d.source)) return <div className="space-y-5" data-shot-details-editor>
      <SubjectShotEditor preview={renderShotKeyframe(id)} key={id} shot={shot} source={d.source} canvasNodes={canvasNodes} canvasId={canvasId} busy={busy} workbench={workbench} assets={d.assets}
        draftValue={sourceDrafts[`v2shot:${id}`]} onDraftChange={value => onSourceDraftChange(`v2shot:${id}`, value)} onSave={onSaveV2Shot || (async () => false)} />
    </div>;
    return <div className="space-y-5" data-shot-reading={id}>
      {renderShotKeyframe(id)}
      {renderShotFields(shot, includeCompleteSource)}
      {(records(shot.dialogues).length > 0 || !includeCompleteSource) && <section className="space-y-2">
        <h4 className="text-xs font-medium text-muted-foreground">{t("director.studio.dialogue")}</h4>
        {records(shot.dialogues).length ? <dl className="space-y-3">{records(shot.dialogues).map((dialogue, index) => {
          const speaker = dialogueSpeakerLabel(dialogue, nameMap, { narration: t("director.studio.narration"), speaker: t("director.studio.speaker") });
          return <div key={String(dialogue.id || index)} className="flex gap-3"><dt className="w-16 shrink-0 pt-1 text-xs text-muted-foreground">{speaker}</dt><dd className="min-w-0 whitespace-pre-wrap text-sm leading-7">{dialogueBody({ ...dialogue, speaker })}</dd></div>;
        })}</dl> : <p className="text-sm text-muted-foreground">{t("director.studio.noDialogue")}</p>}
      </section>}
    </div>;
  };

  // 镜头操作（和导演讨论 / 跳到所在片段）：原先夹在「对白」和「连续性状态」之间，打断阅读顺序；
  // 现在统一挪到左栏最底部，由 renderShotActions 渲染（workbench 与 compact 两种布局共用）。
  const renderShotActions = (shot: Record<string, any>) => {
    const id = String(shot.id || "");
    const segment = segments.find(item => (item.shot_ids || []).includes(id));
    return <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3" data-shot-actions>
      <Button size="small" type="text" icon={<WandSparkles className="size-3.5" />} disabled={busy} onClick={() => onAskDirector({ workspace: "shots", targetId: id, instruction: t("director.workspace.reviseShot") })}>{t("productionCanvas.discussObject")}</Button>
      {segment && <Button size="small" type="text" icon={<Film className="size-3.5" />} onClick={() => onNavigate("production", { kind: "segment", id: String(segment.id) })}>{segmentTitle(String(segment.id))}<ArrowRight className="ml-1 size-3" /></Button>}
    </div>;
  };

  // 镜头源字段（画面 / 摄影 / 起止状态 / 素材 / 时长）：直接摊在页面上（不再开弹窗），右上角「修改」就地切换成「保存 / 取消」。
  // 由 renderShotDetails 统一渲染，workbench 不再单独注入一份，避免同一批字段在页面上出现两遍。
  const renderShotFields = (shot: Record<string, any>, includeCompleteSource = false, keyframeEditor?: KeyframeEditor) => {
    const id = String(shot.id || "");
    return <ShotSourceFields key={id} shot={shot} busy={busy} names={nameMap} characters={characters} fps={fps}
      keyframeAssetId={d?.shotInputs[id]?.keyframeAssetId} keyframeEditor={keyframeEditor}
      includeCompleteSource={includeCompleteSource}
      onSave={async (patch, keyframeChange) => {
        if (Object.keys(patch).length && await onPatch("shot", id, patch) === false) return false;
        if (keyframeChange?.type === "bind") return await onBindAsset(keyframeChange.assetId, keyframeChange.nodeId);
        if (keyframeChange?.type === "unbind") return false;
        return true;
      }} />;
  };

  // 起止状态（镜头开始时 / 镜头结束时）：从「画面与摄影」挪进左栏「连续性状态」模块，与边界开关同区展示。
  const renderShotState = (shot?: Record<string, any>) => {
    if (!shot || typeof shot !== "object" || !shot.id) return null;
    const id = String(shot.id || "");
    return <ShotStateFields key={id} shot={shot} busy={busy} onSave={async patch => { const saved = await onPatch("shot", id, patch); return saved !== false; }} />;
  };

  // 连续性动作（与下一段的边界开关）：归左栏编辑区下方的「连续性状态」模块。
  const renderShotContinuity = (shot?: Record<string, any>) => {
    // 聚焦镜头可能在路由目标已变更、源稿同步期间暂时不存在；连续性 UI 仅适用于有效镜头。
    if (!shot || typeof shot !== "object" || !shot.id) return null;
    const id = String(shot.id || "");
    const segment = segments.find(item => (item.shot_ids || []).includes(id));
    const boundary = segment && d?.boundaries.find(item => item.from === segment.id);
    // 边界开关要有初值：本段还没存过边界时，按「本段 → 下一段」补一个全关闭的草稿，
    // 这样用户能直接把开关打开（后端只接受相邻 Segment 的边界）。
    const nextSegment = segment ? segments[segments.indexOf(segment) + 1] : undefined;
    const boundaryDraft = boundary || (segment && nextSegment ? { from: String(segment.id), to: String(nextSegment.id), tailFrame: false, motionContext: false, reason: "" } : undefined);
    // 没有相邻段就没有边界可设：返回 null，避免在「连续性状态」里留一条空分隔线。
    if (!boundaryDraft) return null;
    return <div className="flex flex-wrap items-center gap-x-5 gap-y-2" data-shot-continuity>
      {([["tailFrame", "director.studio.tailFrameLabel"], ["motionContext", "director.studio.motionContextLabel"]] as const).map(([key, label]) => <label key={key} className="flex cursor-pointer items-center gap-2">
        <span>{t(label)}</span>
        {/* 两个边界互斥：打开一个自动关掉另一个（同一次提交里把另一个置 false）。开态用手工绿色，默认主题的 primary 在暗色下是近白色，开关几乎看不出差别。 */}
        <Switch size="small" checked={Boolean(boundaryDraft[key])} disabled={busy} aria-label={t(label)}
          style={boundaryDraft[key] ? { backgroundColor: "#10b981" } : undefined}
          onChange={checked => void onBoundary({ ...boundaryDraft, tailFrame: key === "tailFrame" && checked, motionContext: key === "motionContext" && checked })} />
      </label>)}
    </div>;
  };

  const renderShots = () => {
    if (d) return <SubjectStoryboardWorkbench key={JSON.stringify(subjectOwner)} viewMemory={storyboardViews.current[JSON.stringify(subjectOwner)] ||= {}} director={d} production={production} owner={subjectOwner} canvasNodes={canvasNodes} canvasId={canvasId} onLocateClip={id => onLocateTarget?.("segment", id)}
      initialShotId={focusTarget?.startsWith("shot:") ? focusedId : undefined} renderEditor={(shot, workbench) => renderShotDetails(shot, false, workbench)} onRepartitionClips={subjectAssembly ? onRepartitionClips : undefined} onEditShot={subjectAssembly ? onEditShot : undefined} onSaveShotPatch={subjectAssembly && onSaveV2Shot ? (shotId, patch) => onSaveV2Shot(shotId, patch) : undefined} shotDrafts={sourceDrafts}
      shotKeyframe={frameForShot}
      renderContinuity={isSubjectPromptAssembly(d.source) ? undefined : shot => renderShotContinuity(shot)}
      renderShotState={shot => renderShotState(shot)}
      renderShotActions={subjectAssembly ? undefined : shot => renderShotActions(shot)}
      clipEditor={scope => {
        const included = new Set(scope.shotIds);
        const scopedShots = sourceShots.filter(shot => included.has(String(shot.id)));
        const scopedSegments = segments.filter(segment => (segment.shot_ids || []).some((id: string) => included.has(String(id))));
        if (subjectAssembly) {
          const draftKey = scope.sceneId ? `v2clips:${scope.sceneId}` : "v2clips";
          return <SubjectClipPartitionEditor shots={scopedShots} segments={scopedSegments} fps={fps} busy={busy || !scope.editable} shotTitle={shotTitle} draftValue={sourceDrafts[draftKey]} onDraftChange={value => onSourceDraftChange(draftKey, value)} onSave={onRepartitionClips || (async () => false)} />;
        }
        return <div className="space-y-4">{scopedSegments.map(segment => <section key={segment.id} className="border-b border-border pb-4"><h3 className="text-sm font-medium">{segmentTitle(String(segment.id))}</h3><SegmentGroupEditor segment={segment} shots={scopedShots} segments={scopedSegments} fps={fps} draftValue={sourceDrafts[`segment:${segment.id}:shot_ids`]} onDraftChange={value => onSourceDraftChange(`segment:${segment.id}:shot_ids`, value)} disabled={busy || !scope.editable} onSave={onRegroup} /></section>)}</div>;
      }}
      onClip={id => onNavigate("production", { kind: "segment", id })}
      busy={busy} compileBusy={compileBusy} compilePending={compilePending} compileError={compileError} compileNotice={compileNotice} compileDiagnostics={compileDiagnostics} compileTargets={compileTargets} onCompile={onCompile}
      onDiscuss={targetId => onAskDirector({ workspace: "shots", targetId })} onNavigate={onNavigate} />;
    return <div className="space-y-3"><Alert type="info" message={t("director.workspace.noShots")} /><Button type="text" disabled={busy} icon={<WandSparkles className="size-3.5" />} onClick={() => onAskDirector({ workspace: "shots" })}>{t("director.studio.collaborate")}</Button></div>;
  };

  const continuitySource = continuityReport?.snapshot === "published" ? production.published?.director : d;
  const continuityWindows = subjectShotWindows(continuitySource?.source || {});
  const continuityShots = records(continuitySource?.source.shots || sourceShots).map(shot => {
    const window = continuityWindows.get(String(shot.id));
    return window ? { ...shot, start_frame: window.startFrame, end_frame: window.endFrame } : shot;
  });
  const renderContinuity = () => continuityReport?.snapshot === "published" && !continuitySource ? <section className="space-y-3" data-continuity-empty-published><ProductionPageHeading titleAlreadyVisible={navigationTitleVisible} title={t("director.workspace.tab.continuity")} actions={<Select aria-label={t("director.workspace.continuity.snapshot")} value="published" options={[{ value: "draft", label: t("director.workspace.continuity.snapshotDraft") }, { value: "published", label: t("director.workspace.continuity.snapshotPublished") }]} onChange={(value: "draft" | "published") => onContinuitySnapshot?.(value)} />} /><Alert type="info" showIcon message={t("director.workspace.continuity.subjectTimeline.noPublishedSource")} />{continuitySnapshotLoading && <p role="status">{t("director.workspace.continuity.subjectTimeline.snapshotLoading")}</p>}</section> : <ContinuityPanel titleAlreadyVisible={navigationTitleVisible} key={JSON.stringify(subjectOwner) + ":" + (continuityReport?.snapshot || "draft")} locations={records(continuitySource?.source.scene_registry)} ledger={continuitySource?.source.ledger as Record<string, unknown> | undefined} sourceHash={continuitySource?.sourceHash || ""} editable={continuityReport?.snapshot !== "published"}
    draftValue={continuityReport?.snapshot !== "published" ? sourceDrafts.v2ledger : undefined} onDraftChange={continuityReport?.snapshot !== "published" ? value => onSourceDraftChange("v2ledger", value) : undefined}
    source={continuitySource?.source} subjectAssembly={isSubjectPromptAssembly(continuitySource?.source || {})}
    workId={readiness?.presentation?.workId || continuitySource?.workflow.currentWork?.workId}
    scenes={Array.isArray(continuitySource?.source.script_scenes) ? records(continuitySource.source.script_scenes) : scriptScenes} shots={continuityShots} segments={Array.isArray(continuitySource?.source.segments) ? records(continuitySource.source.segments) : segments} boundaries={continuitySource?.boundaries || []} characters={Array.isArray(continuitySource?.source.character_registry) ? records(continuitySource.source.character_registry) : characters} assets={Array.isArray(continuitySource?.source.asset_plan) ? records(continuitySource.source.asset_plan) : assetPlan} report={continuityReport} busy={busy || continuitySnapshotLoading} snapshotLoading={continuitySnapshotLoading}
    onSave={onSaveContinuity || (async () => false)} onCheck={onCheckContinuity || (async () => undefined)} onBoundary={value => onBoundary(value as DirectorProduction["boundaries"][number])} onLocate={(kind, id) => onLocateTarget?.(kind, id)} onAskDirector={onAskDirector} onSnapshot={onContinuitySnapshot} />;

  const renderProduction = () => <div className="space-y-4" data-production-section-root>
    <ProductionPageHeading titleAlreadyVisible={navigationTitleVisible} title={t("director.workspace.tab.production")} help={<p>{t("director.generation.flowHint")}</p>} actions={<Button size="small" onClick={onRefresh}>{t("director.workspace.refresh")}</Button>} toolbar={<ProductionSectionNavigation items={[
      { id: "tasks", label: t("director.generation.chooseTarget") },
      { id: "delivery", label: t("director.micro.resultsDelivery") },
      { id: "checks", label: t("director.generation.prepareInputs") },
    ]} />} />
    {compileError && <Alert type="error" showIcon message={t("director.atomic.compileFailed")} description={compileError} style={{ whiteSpace: "pre-line" }} />}
    {compileNotice && <Alert type="success" showIcon message={compileNotice} style={{ whiteSpace: "pre-line" }} />}
    <section className="space-y-3" data-production-section="tasks" tabIndex={-1}>
    {!generationSupported && <Alert type="info" showIcon message={t("director.workspace.sceneGenerationUnavailable")} />}
    {run && <section className="rounded-lg border border-border bg-card p-4"><div className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-xs uppercase tracking-wide text-muted-foreground">{t("director.workspace.activeRun")}</p><h3 className="mt-1 font-semibold">{t(`director.studio.runStatus.${run.status}`, { defaultValue: run.status })}</h3></div><div className="flex gap-2">{["pending", "running"].includes(run.status) && <Button size="small" icon={<Pause className="size-3" />} onClick={() => onPause(run.runId)}>{t("director.workspace.pause")}</Button>}{["paused", "awaiting_review"].includes(run.status) && <Button size="small" type="primary" icon={<Play className="size-3" />} onClick={() => onResume(run.runId)}>{t("director.workspace.resume")}</Button>}</div></div><p className="mt-2 text-sm text-muted-foreground">{run.executionSnapshot?.inputBasis === "canvas" ? t("director.workspace.canvasRunSummary", { count: run.targets.length }) : t("director.studio.runSummary", { version: run.version, count: run.targets.length })}</p>{run.error && <Alert className="mt-3" type={run.status === "failed" ? "error" : "warning"} showIcon message={run.error} />}</section>}
    <div className="flex flex-wrap items-center justify-between gap-2"><div><h3 className="sr-only">{t("director.generation.chooseTarget")}</h3><p className="mt-1 text-xs text-muted-foreground">{t("director.generation.targetHint")}</p></div><Tag>{t(mode === "automatic" ? "director.workspace.automatic" : mode === "prompt_only" ? "director.workspace.promptOnly" : "director.workspace.perItem")}</Tag></div>
    {mode === "automatic" && <div className="flex flex-wrap items-center gap-3"><Button type="primary" icon={<Play className="size-4" />} disabled={!generationSupported || busy || runStartPending || !readiness?.targets.some(item => item.status === "ready" && !activeTargetIds.includes(item.id))} onClick={() => onStart((readiness?.targets || []).filter(item => item.status === "ready" && !activeTargetIds.includes(item.id)).map(item => item.id), "all_ready")}>{t("director.generation.generateReady", { count: readiness?.targets.filter(item => item.status === "ready" && !activeTargetIds.includes(item.id)).length || 0 })}</Button><span className="text-xs text-muted-foreground">{t("director.generation.automaticScope")}</span></div>}
    {mode === "prompt_only" && <Alert type="info" showIcon message={t("director.workspace.promptOnlyHint")} />}
    {readiness?.targets.length ? (() => {
      const selected = readiness.targets.find(target => target.id === selectedGenerationId) || readiness.targets.find(target => target.id === focusTarget) || readiness.targets.find(target => target.kind === "segment") || readiness.targets[0];
      const group = production.draft.clipGroups.find(group => selected.kind === "segment" && group.id === selected.targetId);
      const node = canvasNodes.find(node => node.id === group?.nodeId);
      const clip = records(node?.metadata?.segments).find(clip => clip.id === group?.segmentId);
      const segment = segments.find(segment => selected.kind === "segment" && segment.id === selected.targetId);
      const segmentShots = (segment?.shot_ids || []).map((id: string) => sourceShots.find(shot => String(shot.id) === String(id)));
      const sourceDuration = segmentShots.length && segmentShots.every((shot: Record<string, any> | undefined) => shot && storyboardDurationFrames(shot) > 0)
        ? segmentShots.reduce((total: number, shot: Record<string, any>) => total + storyboardDurationFrames(shot), 0) / fps : NaN;
      const explicitDuration = Number(segment?.generation_clip_duration);
      const legacyDuration = (Number(segment?.end_frame) - Number(segment?.start_frame)) / fps;
      const duration = [explicitDuration, sourceDuration, legacyDuration].find(value => Number.isFinite(value) && value > 0);
      const assetId = selected.kind === "keyframe" ? d?.shotInputs[selected.targetId]?.keyframeAssetId : selected.targetId;
      const media = selected.kind === "segment" ? undefined : mediaForAsset(assetId || selected.targetId, selected.kind === "keyframe" ? selected.targetId : undefined);
      const result = String(clip?.resultStorageKey || media?.storageKey || "");
      const activeRun = batches.find(batch => ["pending", "running", "paused", "awaiting_review"].includes(batch.status) && batch.targets.includes(selected.id));
      const active = activeTargetIds.includes(selected.id);
      const recovery = manualTargetRecovery(selected, source);
      const editSelected = () => {
        if (recovery.workspace !== "production") { openManualTarget(selected); return; }
        const firstShotId = segment?.shot_ids?.[0];
        if (selected.kind === "segment" && group?.nodeId && group.segmentId && !firstShotId) { onLocateTarget?.("segment", selected.targetId); return; }
        onNavigate(selected.kind === "asset" ? "assets" : "shots", { kind: firstShotId || selected.kind === "keyframe" ? "shot" : selected.kind, id: firstShotId ? String(firstShotId) : selected.targetId });
      };
      return <div className="grid items-start gap-4 lg:grid-cols-[minmax(190px,0.8fr)_minmax(0,2fr)]" data-generation-target-workbench>
        <nav className="max-h-64 overflow-y-auto rounded-lg border border-border lg:max-h-[58dvh]" aria-label={t("director.generation.chooseTarget")}>{readiness.targets.map(target => <button key={target.id} type="button" aria-current={selected.id === target.id ? "true" : undefined} onClick={() => setSelectedGenerationId(target.id)} className={`flex w-full items-start justify-between gap-2 border-b border-border px-3 py-3 text-left last:border-0 ${selected.id === target.id ? "bg-muted" : "hover:bg-muted/40"}`}><span className="min-w-0"><span className="block break-words text-sm font-medium">{targetName(target.kind, target.targetId, target.title)}</span><span className="mt-1 block text-xs text-muted-foreground">{t(`director.generation.kind.${target.kind}`)}</span></span><span className="shrink-0 text-xs text-muted-foreground">{activeTargetIds.includes(target.id) ? t("director.canvasOverlay.stage.running") : t(`director.workspace.targetStatus.${target.status}`)}</span></button>)}</nav>
        <article className="min-w-0 space-y-4 rounded-lg border border-border p-4" data-generation-selected-target={selected.id}>
          <div className="flex flex-wrap items-start justify-between gap-2"><div className="min-w-0"><h3 className="break-words font-semibold">{targetName(selected.kind, selected.targetId, selected.title)}</h3><p className="mt-1 text-xs text-muted-foreground">{t(`director.generation.kind.${selected.kind}`)}{duration !== undefined && ` · ${formatSeconds(duration)}s`}</p></div><Tag color={selected.status === "ready" ? "green" : selected.status === "blocked" ? "orange" : undefined}>{active ? t("director.canvasOverlay.stage.running") : t(`director.workspace.targetStatus.${selected.status}`)}</Tag></div>
          {segment && <p className="text-xs text-muted-foreground">{t("director.generation.containsShots", { shots: (segment.shot_ids || []).map((id: string) => shotTitle(String(id))).join(" · ") })}</p>}
          {/* A 类补齐：段级整体声景 / 非介观音乐原先只读（只在提示词里出现），契约允许 patch，补上直接编辑。 */}
          {selected.kind === "segment" && segment && <div className="space-y-3" data-generation-segment-sound>
            <label className="grid gap-1 text-xs text-muted-foreground"><span>{t("director.workspace.segmentSummary")}</span><SourceField value={String(segment.summary || "")} draftValue={sourceDrafts[`segment:${String(segment.id)}:summary`]} onDraftChange={value => onSourceDraftChange(`segment:${String(segment.id)}:summary`, value)} multiline rows={2} disabled={busy} onCommit={value => onPatch("segment", String(segment.id), { summary: value })} /></label>
            {(["overall_soundscape", "non_diegetic_music"] as const).map(field => <label key={field} className="grid gap-1 text-xs text-muted-foreground"><span>{t(field === "overall_soundscape" ? "director.workspace.overallSoundscape" : "director.workspace.nonDiegeticMusic")}</span><SourceField value={String(segment[field] || "")} draftValue={sourceDrafts[`segment:${String(segment.id)}:${field}`]} onDraftChange={value => onSourceDraftChange(`segment:${String(segment.id)}:${field}`, value)} multiline rows={2} disabled={busy} onCommit={value => onPatch("segment", String(segment.id), { [field]: value })} /></label>)}
            {segment.motion_profile && typeof segment.motion_profile === "object" && !Array.isArray(segment.motion_profile) && <section className="space-y-2 rounded border border-border p-3" data-segment-motion-profile><p className="text-xs font-medium">{t("director.workspace.motionProfile")}</p>{Object.entries(segment.motion_profile as Record<string, unknown>).map(([field, raw]) => <label key={field} className="grid gap-1 text-xs text-muted-foreground"><span>{t(`director.workspace.motionField.${field}`, field)}</span><SourceField value={String(raw ?? "")} draftValue={sourceDrafts[`segment:${String(segment.id)}:motion_profile:${field}`]} onDraftChange={value => onSourceDraftChange(`segment:${String(segment.id)}:motion_profile:${field}`, value)} disabled={busy} multiline rows={field.includes("principle") ? 2 : 1} onCommit={value => onPatch("segment", String(segment.id), { motion_profile: { ...(segment.motion_profile as Record<string, unknown>), [field]: value } })} /></label>)}</section>}
            <details className="rounded border border-border p-3" data-segment-audio-bindings><summary className="cursor-pointer text-xs font-medium">{t("director.workspace.audioBindings")}</summary><div className="mt-2"><SegmentAudioBindingEditor bindings={Array.isArray(segment.audio_bindings) ? segment.audio_bindings : []} shots={(segment.shot_ids || []).map(String)} sources={(source._canvas_subject_audio_sources && typeof source._canvas_subject_audio_sources === "object" ? source._canvas_subject_audio_sources : {}) as Record<string, AudioSourceEntry>} projectId={String(source.project_id || canvasId)} disabled={busy} onPersist={next => onPatch("segment", String(segment.id), { audio_bindings: next }) as Promise<boolean>} /></div></details>
            <details className="rounded border border-border p-3" data-segment-animation-term-editor><summary className="cursor-pointer text-xs font-medium">{t("director.studio.animationTermsPayload")}</summary><div className="mt-2"><SourceJsonEditor title={t("director.studio.animationTermsPayload")} hint={t("director.studio.animationTermsPayloadHint")} value={{ animation_term_ids: Array.isArray(segment.animation_term_ids) ? segment.animation_term_ids : [], animation_term_evidence: Array.isArray(segment.animation_term_evidence) ? segment.animation_term_evidence : [] }} fieldOrder={["animation_term_ids", "animation_term_evidence"]} nestedFieldOrder={{ animation_term_evidence: ["term_id", "term", "time_window", "observable_fact", "camera_or_layout", "sound_or_qa"] }} disabled={busy} onSave={next => { if (!Array.isArray(next.animation_term_ids) || !Array.isArray(next.animation_term_evidence)) return false; return onPatch("segment", String(segment.id), next) as Promise<boolean>; }} /></div></details>
          </div>}
          {selected.blockers.length > 0 && <div className="space-y-2" data-generation-blockers><h4 className="text-sm font-medium">{t("director.generation.currentIssues")}</h4><ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">{selected.blockers.map((reason, index) => <li key={`${index}:${reason}`}>{humanMessage(reason)}</li>)}</ul></div>}
          {selected.notice && <p className="text-sm text-muted-foreground">{humanMessage(selected.notice)}</p>}
          <div className="flex flex-wrap items-center gap-2" data-generation-target-actions>
            {activeRun && ["paused", "awaiting_review"].includes(activeRun.status) ? <Button type="primary" disabled={busy} onClick={() => onResume(activeRun.runId)}>{t("director.generation.resumeOriginal")}</Button> : selected.status === "ready" && !active && mode === "per_item" ? <Button type="primary" icon={<Play className="size-3.5" />} disabled={!generationSupported || busy || runStartPending} onClick={() => onStart([selected.id])}>{t(selected.kind === "segment" ? "director.workspace.generateClip" : "director.workspace.generateItem")}</Button> : selected.status === "blocked" || selected.status === "needs_review" ? <Button type="primary" disabled={busy} onClick={editSelected}>{t(selected.status === "needs_review" ? "director.workspace.manual.reviewMedia" : recovery.workspace === "production" ? "director.generation.editClip" : `director.workspace.manual.${recovery.actionKey}`)}</Button> : null}
            {selected.status !== "blocked" && selected.status !== "needs_review" && <Button size="small" onClick={editSelected}>{t(selected.kind === "segment" ? "director.generation.editClip" : "director.canvasOverlay.editSource")}</Button>}
            <Button type="text" size="small" onClick={() => onLocateTarget?.(selected.kind, selected.targetId)}>{t("drama.production.openCanvas")}</Button>
          </div>
          {active && <p className="text-xs text-muted-foreground">{t("director.generation.originalRunHint")}</p>}
          {result && <section className="space-y-2 border-t border-border pt-3" data-generation-existing-result><p className="text-xs text-muted-foreground">{t(selected.status === "complete" ? "director.generation.currentResult" : "director.generation.previousResult")}</p>{selected.kind === "segment" ? <><video className="max-h-64 w-full object-contain" src={backendMediaUrl(result)} controls preload="metadata" onError={() => setVideoPreviewErrors(current => current[selected.id] === result ? current : { ...current, [selected.id]: result })} onLoadedData={() => setVideoPreviewErrors(current => { if (current[selected.id] !== result) return current; const next = { ...current }; delete next[selected.id]; return next; })} />{videoPreviewErrors[selected.id] === result && <p className="text-xs text-muted-foreground">{t("director.workspace.targetStatus.complete")} · {t("composer.mentions.previewUnavailable")}</p>}</> : <Image className="max-h-64 max-w-full rounded object-contain" src={backendMediaUrl(result)} alt={targetName(selected.kind, selected.targetId, selected.title)} />}</section>}
          <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">{t("director.workspace.savedInput")}</summary>{inputDiff(selected)}</details>
        </article>
      </div>;
    })() : <div className="space-y-3 rounded-lg border border-dashed border-border p-5"><p className="text-sm text-muted-foreground">{readiness?.nextAction || t("director.workspace.noReadiness")}</p><Button onClick={() => onNavigate("shots")}>{t("director.workspace.manual.editShots")}</Button><Button type="text" onClick={() => onNavigate("assets")}>{t("director.workspace.manual.editAssets")}</Button></div>}
    </section>
    <details className="space-y-3 border-t border-border pt-4" data-production-section="checks" tabIndex={-1}><summary className="cursor-pointer text-sm font-medium">{t("director.generation.prepareInputs")}</summary>
      <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-xs text-muted-foreground">{t("director.generation.prepareHint")}</p></div><div className="flex flex-wrap gap-2"><Button size="small" loading={compileBusy} disabled={busy || compileBusy || !d || !onCompile} onClick={() => onCompile?.()}>{compilePending ? t("drama.production.recoverReceipt") : t("director.workspace.validateCompile")}</Button><Button disabled={busy || !d} onClick={onPublish}>{t("drama.production.directorPublish")}</Button></div></div>
    <details className="border-b border-border pb-2"><summary className="cursor-pointer text-sm font-medium">{t("director.micro.runParameters")}</summary><div className="mt-3 space-y-3">    <section className="rounded-lg border border-border bg-card p-4">
      <label className="mb-2 block text-sm font-medium">{t('director.workspace.videoAspectRatio')}</label>
      <Select className="min-w-48" disabled={busy} value={production.draft.settings.videoAspectRatio || ''} onChange={value => onSettings({ videoAspectRatio: value || null, videoAspectRatioConfirmed: true })} options={['', '9:16', '16:9', '1:1', '4:3', '3:4', '2:3', '3:2', '21:9'].map(value => ({ value, label: value || t('director.workspace.inheritVideoAspectRatio') }))} />
      <p className="mt-2 text-xs text-muted-foreground">{t('director.workspace.videoAspectRatioHint')}</p>
    </section>
    {d && <section className="grid gap-3 rounded-lg border border-border bg-card p-4 md:grid-cols-2" data-production-spec-settings aria-label={t("director.workspace.productionSpec")}>
      <label className="grid gap-1 text-sm"><span className="font-medium">{t("director.workspace.fps")}</span><div className="flex items-center gap-2"><InputNumber className="w-24" min={1} precision={0} disabled={busy || !onPatch} value={Number(source.fps_num ?? 24)} onChange={value => { if (Number.isInteger(value)) void onPatch("spec", undefined, { fps_num: value }); }} /><span className="text-xs text-muted-foreground">/</span><InputNumber className="w-24" min={1} precision={0} disabled={busy || !onPatch} value={Number(source.fps_den ?? 1)} onChange={value => { if (Number.isInteger(value)) void onPatch("spec", undefined, { fps_den: value }); }} /></div></label>
      <label className="grid gap-1 text-sm"><span className="font-medium">{t("director.workspace.totalDuration")}</span><Input key={`spec-duration:${String(source.production_total_duration ?? "")}`} defaultValue={String(source.production_total_duration ?? "")} placeholder="90 · 2160/24" disabled={busy || !onPatch} onBlur={event => { const value = event.target.value.trim(); if (!value || /^\d+(\.\d+)?$/.test(value) || /^\d+\/\d+$/.test(value)) void onPatch("spec", undefined, { production_total_duration: value }); else event.target.value = String(source.production_total_duration ?? ""); }} /></label>
      <label className="grid gap-1 text-sm"><span className="font-medium">{t("director.workspace.clipLimit")}</span><InputNumber className="w-28" min={1} precision={0} disabled={busy || !onPatch} value={Number(source.generation_clip_limit ?? 0) || null} placeholder="12" onChange={value => { if (Number.isInteger(value)) void onPatch("spec", undefined, { generation_clip_limit: value }); }} /></label>
      <label className="grid gap-1 text-sm"><span className="font-medium">{t("director.workspace.deliveryScope")}</span><Select className="min-w-40" disabled={busy || !onPatch} value={String(source.delivery_scope ?? "prompt_only")} options={[{ value: "prompt_only", label: t("director.workspace.promptOnly") }, { value: "full_production", label: t("director.workspace.fullProduction") }]} onChange={value => void onPatch("spec", undefined, { delivery_scope: value })} /></label>
      <label className="grid gap-1 text-sm md:col-span-2"><span className="font-medium">{t("director.workspace.detailPolicy")}</span><Input key={`spec-policy:${String((source.prompt_detail_policy as Record<string, unknown> | undefined)?.profile ?? "")}`} defaultValue={String((source.prompt_detail_policy as Record<string, unknown> | undefined)?.profile ?? "")} placeholder="ref2va_v2" disabled={busy || !onPatch} onBlur={event => { const profile = event.target.value.trim(); if (profile) void onPatch("spec", undefined, { prompt_detail_policy: { ...((source.prompt_detail_policy && typeof source.prompt_detail_policy === "object" && !Array.isArray(source.prompt_detail_policy) ? source.prompt_detail_policy : {}) as Record<string, unknown>), profile } }); }} /></label>
      <p className="text-xs text-muted-foreground md:col-span-2">{t("director.workspace.specHint")}</p>
    </section>}
    {d && <section className="grid gap-3 rounded-lg border border-border bg-card p-4 md:grid-cols-2"><label className="grid gap-1 text-sm"><span className="font-medium">{t("director.workspace.contentDelivery")}</span><Select value={delivery} disabled={busy} options={[{ value: "auto_file_batch", label: t("director.workspace.autoFileBatch") }, { value: "interactive_segment", label: t("director.workspace.interactiveSegment") }]} onChange={value => onWorkflow({ contentDeliveryMode: value })} /></label><label className="grid gap-1 text-sm"><span className="font-medium">{t("director.workspace.mediaProduction")}</span><Select value={mode} disabled={busy} options={[{ value: "prompt_only", label: t("director.workspace.promptOnly") }, { value: "per_item", label: t("director.workspace.perItem") }, { value: "automatic", label: t("director.workspace.automatic") }]} onChange={value => onWorkflow({ mediaProductionMode: value })} /></label><p className="text-xs text-muted-foreground md:col-span-2">{t("director.workspace.settingsNextRun")}</p></section>}
</div></details>
    </details>
    <section className="space-y-4 border-t border-border pt-5" data-production-section="delivery" tabIndex={-1}>
      <div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="font-semibold">{t("director.micro.resultsDelivery")}</h3><p className="mt-1 text-xs text-muted-foreground">{t("director.micro.resultsDeliveryHint")}</p></div><div className="flex flex-wrap items-center gap-2"><label className="flex items-center gap-2 text-xs text-muted-foreground"><Switch checked={includeGeneratedMedia} disabled={exporting} onChange={setIncludeGeneratedMedia} />{t("director.workspace.includeGeneratedMedia")}</label><Button size="small" loading={exporting} disabled={!d || exporting} onClick={() => void onExport(includeGeneratedMedia)}>{t("director.workspace.exportBundle")}</Button></div></div>
    {deliveredClips.length > 0 && (() => {
      const selected = deliveredClips.find(item => item.group.id === selectedDeliveryId) || deliveredClips[0];
      const index = deliveredClips.indexOf(selected);
      return <section className="space-y-3"><div className="flex flex-wrap items-center justify-between gap-2"><div><h3 className="font-semibold">{t("director.workspace.deliveredVideos")}</h3><p className="mt-1 text-xs text-muted-foreground">{t("director.workspace.technicalCloseout")}</p></div><Button size="small" icon={<ArrowDownToLine className="size-3" />} loading={downloadingAllClips} onClick={() => void downloadAllDeliveredClips()}>{t("director.workspace.downloadAllClips")}</Button></div><div className="grid items-start gap-4 lg:grid-cols-[240px_minmax(0,1fr)]"><nav className="max-h-64 overflow-y-auto rounded-xl border border-border lg:max-h-[60dvh]" aria-label={t("director.workspace.deliveredVideos")}>{deliveredClips.map(({ group }) => <button key={group.id} type="button" aria-current={selected.group.id === group.id ? "true" : undefined} onClick={() => setSelectedDeliveryId(group.id)} className={`flex w-full items-center gap-2 border-b border-border px-3 py-3 text-left last:border-0 ${selected.group.id === group.id ? "bg-muted" : "hover:bg-muted/40"}`}><Film className="size-4 shrink-0 text-muted-foreground" /><span className="truncate text-sm">{segmentTitle(group.id)}</span></button>)}</nav><article className="min-w-0 space-y-3 rounded-xl border border-border bg-card p-3"><video key={selected.storageKey} className="max-h-[52dvh] w-full rounded-lg" controls preload="metadata" src={backendMediaUrl(selected.storageKey)} onError={() => setVideoPreviewErrors(current => current[selected.group.id] === selected.storageKey ? current : { ...current, [selected.group.id]: selected.storageKey })} onLoadedData={() => setVideoPreviewErrors(current => { if (current[selected.group.id] !== selected.storageKey) return current; const next = { ...current }; delete next[selected.group.id]; return next; })} />{videoPreviewErrors[selected.group.id] === selected.storageKey && <p className="text-xs text-muted-foreground">{t("director.workspace.targetStatus.complete")} · {t("composer.mentions.previewUnavailable")}</p>}<div className="flex flex-wrap items-center justify-between gap-2"><p className="text-sm font-medium">{segmentTitle(selected.group.id)}</p><div className="flex flex-wrap gap-2"><Button size="small" onClick={() => onNavigate("shots", segments.find(segment => segment.id === selected.group.id)?.shot_ids?.[0] ? { kind: "shot", id: String(segments.find(segment => segment.id === selected.group.id)?.shot_ids?.[0]) } : undefined)}>{t("director.workspace.tab.shots")}</Button><Button size="small" onClick={() => onLocateTarget?.("segment", selected.group.id)}>{t("productionCanvas.locateResult")}</Button><Button size="small" icon={<ArrowDownToLine className="size-3" />} onClick={() => void downloadDeliveredClip(selected.storageKey, clipFileName(index, segmentTitle(selected.group.id), null)).catch(cause => message.error(String(cause)))}>{t("common.download")}</Button></div></div></article></div></section>;
    })()}

    {!deliveredClips.length && <div className="flex min-h-36 flex-col items-center justify-center rounded-xl border border-dashed border-border bg-muted/20 p-6 text-center"><Film className="mb-3 size-7 text-muted-foreground" /><h3 className="font-medium">{t("director.studio.noResults")}</h3><p className="mt-2 text-sm text-muted-foreground">{t("director.studio.noResultsHint")}</p></div>}
    {mode === "automatic" && <Button icon={<Play className="size-4" />} disabled={!generationSupported || busy || runStartPending || !readiness?.targets.some(item => item.status === "ready" && !activeTargetIds.includes(item.id))} onClick={() => onStart((readiness?.targets || []).filter(item => item.status === "ready" && !activeTargetIds.includes(item.id)).map(item => item.id), "all_ready")}>{t("director.workspace.startAutomatic")}</Button>}
    {mode === "prompt_only" && <Alert type="info" showIcon message={t("director.workspace.promptOnlyHint")} />}
    {readiness?.targets.length ? <section className="space-y-5" data-production-target-groups>{["preparing", "ready", "running", "results"].map(stage => {
      const targets = readiness.targets.filter(target => {
        const group = production.draft.clipGroups.find(group => target.kind === "segment" && group.id === target.targetId);
        const node = canvasNodes.find(node => node.id === group?.nodeId);
        const result = records(node?.metadata?.segments).find(clip => clip.id === group?.segmentId)?.resultStorageKey;
        return (activeTargetIds.includes(target.id) ? "running" : result ? "results" : target.status === "ready" ? "ready" : "preparing") === stage;
      });
      return targets.length ? <div key={stage}><h3 className="mb-2 flex items-center gap-2 text-sm font-medium">{t("director.canvasOverlay.stage." + stage)}<span className="text-xs text-muted-foreground">{targets.length}</span></h3><div className="grid gap-3 xl:grid-cols-2">{targets.map(target => {
        const group = production.draft.clipGroups.find(group => target.kind === "segment" && group.id === target.targetId);
        const node = canvasNodes.find(node => node.id === group?.nodeId);
        const result = String(records(node?.metadata?.segments).find(clip => clip.id === group?.segmentId)?.resultStorageKey || "");
        const segment = segments.find(segment => segment.id === target.targetId);
        return <article key={target.id} className="min-w-0 rounded-lg border border-border p-4"><div className="flex flex-wrap items-start justify-between gap-2"><div><strong className="text-sm">{targetName(target.kind, target.targetId, target.title)}</strong>{segment && <p className="mt-1 text-xs text-muted-foreground">{formatSeconds(segment.generation_clip_duration ?? (Number(segment.end_frame) - Number(segment.start_frame)) / fps)}s</p>}</div><Tag color={target.status === "ready" ? "green" : undefined}>{t(`director.workspace.targetStatus.${target.status}`)}</Tag></div>
          {result && <><video className="mt-3 max-h-40 w-full object-contain" src={backendMediaUrl(result)} controls preload="metadata" onError={() => setVideoPreviewErrors(current => current[target.id] === result ? current : { ...current, [target.id]: result })} onLoadedData={() => setVideoPreviewErrors(current => { if (current[target.id] !== result) return current; const next = { ...current }; delete next[target.id]; return next; })} />{videoPreviewErrors[target.id] === result && <p className="mt-1 text-xs text-muted-foreground">{t("director.workspace.targetStatus.complete")} · {t("composer.mentions.previewUnavailable")}</p>}</>}
          {target.blockers.length > 0 && <details className="mt-3 text-xs"><summary className="cursor-pointer text-muted-foreground">{t("director.workspace.shotIssueDetails")}</summary><p className="mt-2 whitespace-pre-wrap">{humanMessage(target.blockers.join("；"))}</p></details>}
          {target.notice && <p className="mt-2 text-xs text-muted-foreground">{humanMessage(target.notice)}</p>}
          <div className="mt-3 flex flex-wrap gap-2"><Button type="text" size="small" onClick={() => onNavigate(target.kind === "segment" ? "shots" : "assets", { kind: target.kind, id: target.targetId })}>{t("director.canvasOverlay.editSource")}</Button><Button type="text" size="small" onClick={() => onLocateTarget?.(target.kind, target.targetId)}>{t("drama.production.openCanvas")}</Button>{target.status === "ready" && mode !== "prompt_only" && mode !== "automatic" && <Button size="small" disabled={!generationSupported || busy || runStartPending || activeTargetIds.includes(target.id)} onClick={() => onStart([target.id])}>{target.kind === "segment" ? t("director.workspace.generateClip") : t("director.workspace.generateItem")}</Button>}</div>
          <details className="mt-2 text-xs text-muted-foreground"><summary className="cursor-pointer">{t("director.workspace.savedInput")}</summary>{inputDiff(target)}</details>
        </article>;
      })}</div></div> : null;
    })}</section> : <p className="text-sm text-muted-foreground">{readiness?.nextAction || t("director.workspace.noReadiness")}</p>}

    </section>
    {d && <details className="space-y-2 border-t border-border pt-4" data-production-section="compiler" tabIndex={-1}><summary className="cursor-pointer text-sm font-medium">{t("director.workspace.completePrompts")}</summary>{d.artifacts.map(artifact => {
      const receipt = artifact.receipt as Record<string, any>;
      const compilerDiagnostics = receipt.diagnostics && typeof receipt.diagnostics === "object" ? receipt.diagnostics as Record<string, any> : {};
      const blockers = Array.isArray(compilerDiagnostics.blockers) ? compilerDiagnostics.blockers.map(String) : [];
      return <details key={artifact.id} className="rounded-lg border border-border bg-card p-4"><summary className="cursor-pointer font-medium">{targetName(artifact.kind === "h3" ? "segment" : "asset", artifact.targetId)} · {artifact.status}</summary><div className="mt-3 space-y-3">{blockers.length > 0 && <Alert type="warning" showIcon message={t("director.atomic.compileFailed")} description={<ul className="list-disc space-y-1 pl-5">{blockers.map((blocker, index) => <li key={`${index}:${blocker}`}>{blocker}</li>)}</ul>} />}<pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/40 p-3 text-sm">{artifact.prompt}</pre>{artifact.references.length > 0 && <div className="space-y-2"><p className="text-sm font-medium">{t("director.workspace.actualReferences")}</p>{artifact.references.map(ref => <div key={`${artifact.id}:${ref.label}:${ref.storageKey}`} className="flex flex-wrap items-center gap-2 rounded-lg border border-border p-2 text-xs"><Image className="max-h-16 max-w-20 rounded object-contain" src={backendMediaUrl(ref.storageKey)} alt={ref.label} /><span>{ref.label}</span><Tag>{ref.role}</Tag></div>)}</div>}</div></details>;
    })}</details>}
  </div>;

  const renderAdvanced = () => <div className="space-y-3" data-production-section-root>
    <ProductionPageHeading titleAlreadyVisible={navigationTitleVisible} title={t("director.workspace.advancedTitle")} help={<p>{t("director.workspace.advancedHint")}</p>} toolbar={<ProductionSectionNavigation items={[
      { id: "history", label: t("director.micro.versionsHistory") },
      { id: "technical", label: t("director.micro.technicalSources") },
      { id: "management", label: t("director.micro.advancedManagement") },
    ]} />} />
    {compact && <details className="border-b border-border pb-4"><summary className="cursor-pointer font-medium">{t("productionCanvas.productionSettings")}</summary><div className="mt-4">{renderProduction()}</div></details>}
    <section className="space-y-5" data-production-section="history" tabIndex={-1}>
      <div><h3 className="font-semibold">{t("director.micro.versionsHistory")}</h3><p className="mt-1 text-xs text-muted-foreground">{t("director.micro.versionsHistoryHint")}</p></div>
    <section className="space-y-2"><h3 className="font-semibold">{t("director.workspace.history")}</h3>{versions.length ? versions.map(item => <article key={item.version} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-card p-3"><span>v{item.version} · {item.stage} · {new Date(item.createdAt).toLocaleString()}</span><Button size="small" icon={<RotateCcw className="size-3" />} disabled={busy} onClick={() => onRestore(item.version)}>{t("director.workspace.restore")}</Button></article>) : <p className="text-sm text-muted-foreground">{t("director.workspace.noHistory")}</p>}</section>
    {batches.length > 0 && <section className="space-y-2"><h3 className="font-semibold">{t("director.workspace.runHistory")}</h3>{batches.map(item => <article key={item.runId} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-card p-3"><div className="min-w-0"><p className="font-medium">{item.status} · {item.runId}</p><p className="break-all text-xs text-muted-foreground">{item.targets.join(", ")} · {item.submitted.length} {t("director.workspace.submittedTasks")}</p></div>{["paused", "awaiting_review"].includes(item.status) && <Button size="small" onClick={() => onResume(item.runId)}>{t("director.workspace.resume")}</Button>}</article>)}</section>}
    {!!production.clipRefreshes?.length && <details className="border-b border-border pb-3"><summary className="cursor-pointer text-sm">{t("director.workspace.refreshHistory", { count: production.clipRefreshes.length })}</summary><div className="mt-3 space-y-2">{production.clipRefreshes.map(job => <details key={job.operationId} className="text-xs text-muted-foreground"><summary className="cursor-pointer">{segmentTitle(job.segmentId)} · {t("director.atomic.clipRefreshPhase." + job.status)} · {job.savedRevision}</summary>{job.blockingDiagnostic && <p className="mt-1 whitespace-pre-wrap">{job.blockingDiagnostic.message}</p>}</details>)}</div></details>}
    </section>
    <section className="space-y-4 border-t border-border pt-5" data-production-section="technical" tabIndex={-1}>
      <h3 className="font-semibold">{t("director.micro.technicalSources")}</h3>
      {d && <details><summary className="cursor-pointer text-sm font-medium">{t("director.workspace.moduleRoles")}</summary><div className="mt-3">
    {d && <section className="rounded-lg border border-border bg-card p-5"><div className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-xs uppercase tracking-wide text-muted-foreground">{t("director.workspace.internalModules")}</p><h2 className="mt-1 text-lg font-semibold">{t("director.workspace.moduleRoles")}</h2></div><span className="text-xs text-muted-foreground">{t("director.workspace.modulesNotGates")}</span></div><div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">{directorModules.map(module => <div key={module} className="rounded-lg border border-border p-3"><div className="flex items-center justify-between gap-2"><strong>{t(`director.workspace.moduleName.${module}`)}</strong><Tag color={["committed", "continuity_passed"].includes(moduleViewStatus(module)) ? "green" : moduleViewStatus(module) === "blocked" ? "red" : undefined}>{t(`director.workspace.moduleStatus.${moduleViewStatus(module)}`)}</Tag></div><p className="mt-1 text-xs text-muted-foreground">{t("director.workspace.declaredModuleStatus", { status: t(`director.workspace.moduleStatus.${d.modules[module]?.status || "planned"}`) })}</p>{d.modules[module]?.unresolved.length ? <p className="mt-2 text-xs text-amber-600">{d.modules[module]?.unresolved[0]}</p> : null}</div>)}</div></section>}
      </div></details>}
    {d && <details className="rounded-lg border border-border bg-card p-4"><summary className="cursor-pointer font-medium">{t("director.studio.rawSource")}</summary><pre className="mt-4 max-h-[36rem] overflow-auto whitespace-pre-wrap break-words text-xs">{JSON.stringify({ revision: production.revision, localEdits: sourceDrafts, source: d.source, assets: d.assets, shotInputs: d.shotInputs, boundaries: d.boundaries, artifacts: d.artifacts, run, readiness }, null, 2)}</pre></details>}
    </section>
    <section className="space-y-3 border-t border-border pt-5" data-production-section="management" data-production-danger="source" tabIndex={-1}>
      <h3 className="font-semibold">{t("director.micro.advancedManagement")}</h3>
      <p className="text-xs text-muted-foreground">{t("director.micro.advancedManagementHint")}</p>
      <Button className="mt-2" disabled={!d} onClick={() => { setJson(JSON.stringify(d || {}, null, 2)); setError(""); }}>{t("director.workspace.editJson")}</Button>
    </section>
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
      <div className="space-y-5 py-3">{scriptParagraphList()}</div>
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
    {error && <Alert type="error" message={error} />}
  </section>;
  if (compact && workspace === "shots" && focusedShot) {
    const index = sourceShots.findIndex(shot => shot.id === focusedShot.id);
    return <section data-production-object-editor className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-4">
        <div><p className="text-xs text-muted-foreground">{t("director.studio.shotNumber", { number: index + 1 })} · {formatSeconds((Number(focusedShot.end_frame) - Number(focusedShot.start_frame)) / fps)}s</p><h2 className="mt-1 text-lg font-semibold">{shotTitle(focusedId)}</h2></div>
        <div className="flex items-center gap-1"><Button size="small" type="text" onClick={() => { onNavigate("shots"); }}>{t("director.studio.allShots")}</Button><Button size="small" type="text" aria-label={t("director.studio.previousShot")} icon={<ArrowLeft className="size-3.5" />} disabled={index <= 0} onClick={() => onNavigate("shots", { kind: "shot", id: String(sourceShots[index - 1].id) })} /><Button size="small" type="text" aria-label={t("director.studio.nextShot")} icon={<ArrowRight className="size-3.5" />} disabled={index >= sourceShots.length - 1} onClick={() => onNavigate("shots", { kind: "shot", id: String(sourceShots[index + 1].id) })} /></div>
      </header>
      {renderShotDetails(focusedShot)}
      {renderShotState(focusedShot)}
      <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3 text-xs text-muted-foreground">{renderShotContinuity(focusedShot)}</div>
      {!subjectAssembly && renderShotActions(focusedShot)}
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
      <details className="border-t border-border pt-4"><summary className="cursor-pointer text-sm text-muted-foreground">{t("productionCanvas.objectDetails")}</summary>{target?.blockers.slice(1).map(reason => <p key={reason} className="mt-2 text-sm text-muted-foreground">{humanMessage(reason)}</p>)}{subjectAssembly ? <SubjectClipPartitionEditor shots={sourceShots} segments={segments} fps={fps} busy={busy} shotTitle={shotTitle} draftValue={sourceDrafts.v2clips} onDraftChange={value => onSourceDraftChange("v2clips", value)} onSave={onRepartitionClips || (async () => false)} /> : <SegmentGroupEditor segment={focusedSegment} shots={sourceShots} segments={segments} fps={fps} draftValue={sourceDrafts[`segment:${focusedId}:shot_ids`]} onDraftChange={value => onSourceDraftChange(`segment:${focusedId}:shot_ids`, value)} disabled={busy} onSave={onRegroup} />}</details>
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
    {readiness?.targets.some(target => ["blocked", "needs_review"].includes(target.status) || Boolean(target.warnings?.length)) && <details className="border-t border-border pt-4"><summary className="cursor-pointer text-sm">{t("productionCanvas.needsAttention")}</summary><div className="mt-3 space-y-3">{readiness.targets.filter(target => ["blocked", "needs_review"].includes(target.status) || Boolean(target.warnings?.length)).map(target => <div key={target.id}><Button size="small" type="text" onClick={() => onLocateTarget?.(target.kind, target.targetId)}>{targetName(target.kind, target.targetId, target.title)}</Button><p className="mt-1 text-sm text-muted-foreground">{humanMessage(target.blockers[0] || target.warnings?.[0] || target.notice || t(`director.workspace.targetStatus.${target.status}`))}</p></div>)}</div></details>}
    <section className="space-y-3 border-t border-border pt-4"><div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-medium">{t("productionCanvas.deliveries")}</h3><div className="flex gap-2"><Button size="small" icon={<ArrowDownToLine className="size-3" />} loading={downloadingAllClips} disabled={!deliveredClips.length} onClick={() => void downloadAllDeliveredClips()}>{t("director.workspace.downloadAllClips")}</Button><Button size="small" loading={exporting} disabled={!d || exporting} onClick={() => void onExport(true)}>{t("productionCanvas.downloadPackage")}</Button></div></div>{deliveredClips.length ? deliveredClips.map(({ group, storageKey }) => <article key={`${group.id}:${storageKey}`} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border p-3"><span>{segmentTitle(group.id)}</span><div className="flex gap-2"><Button size="small" type="text" onClick={() => onLocateTarget?.("segment", group.id)}>{t("productionCanvas.locateResult")}</Button><Button size="small" aria-label={t("common.download")} onClick={() => { void fetch(backendMediaUrl(storageKey)).then(async response => { if (!response.ok) throw new Error(t("director.workspace.mediaReadFailed")); saveAs(await response.blob(), `${segmentTitle(group.id).replace(/[\\/:*?"<>|]/g, "_")}.${response.headers.get("content-type")?.includes("webm") ? "webm" : "mp4"}`); }).catch(error => message.error(String(error))); }}>{t("common.download")}</Button></div></article>) : <p className="text-sm text-muted-foreground">{t("productionCanvas.noDeliveries")}</p>}</section>
  </section>;
  const refreshIssues = groupedRefreshIssues(currentClipRefreshes(production.clipRefreshes || [], records(d?.source.segments).map(segment => String(segment.id)), d?.sourceHash));
  return <section className="space-y-4" data-director-panel={workspace}>
    {["overview", "production"].includes(workspace) && refreshIssues.length > 0 && <details className="border-b border-border pb-3 text-sm"><summary className="cursor-pointer text-muted-foreground">{t("director.workspace.refreshIssueSummary", { count: refreshIssues.length })}</summary><div className="mt-3 space-y-3">{refreshIssues.map(issue => <div key={JSON.stringify([issue.code, issue.message])}><p className="text-xs text-muted-foreground">{issue.segmentIds.map(segmentTitle).join("、")}</p><p className="mt-1 whitespace-pre-wrap">{issue.message}</p></div>)}</div></details>}
    {workspace === "overview" && renderOverview()}
    {workspace === "story" && renderStory()}
    {workspace === "assets" && renderAssets()}
    {workspace === "shots" && renderShots()}
    {workspace === "continuity" && renderContinuity()}
    {workspace === "production" && renderProduction()}
    {workspace === "advanced" && renderAdvanced()}
  </section>;
}
