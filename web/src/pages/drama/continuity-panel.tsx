import { analyzeContinuityDeletion, applyContinuityDeletion, restoreContinuityDeletion, continuityLedgerEntryId, continuityLedgerFactDescriptions, type ContinuityLedgerCollection } from "./continuity-ledger-mutations";
import { appendContinuityHold, appendContinuityExemption, normalizedContinuityValues } from "./continuity-ledger-evidence";
import { useBlocker } from "react-router-dom";
import { appendContinuityChange, type ContinuityChangeInput } from "./continuity-event-draft";
import { ContinuityTimelineWorkbench } from "./continuity-timeline-workbench";
import { continuityLocalFrame, continuityReadProjection, continuityEventPositionIssues, continuityPreviewStatus, continuitySourceBlocks, continuityBlocksForShot, continuityDefaultEvidenceBlockId, continuityWorkbenchSource } from "./continuity-timeline-model";
import { ChevronDown, CircleHelp } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Alert, App, Button, Dropdown, Input, message, Popover, Select, Switch, Tag } from "antd";
import { useTranslation } from "react-i18next";
import type { ProductionContinuity } from "@/services/backend-api";
import { continuityPresentation } from "./continuity-presentation";
import { records } from "./director-display";
import { continuityEventAnchor, continuityEventFrame } from "./continuity-event-anchor";
import { readContinuityLedgerDraft, rebaseContinuityLedger, continuityLedgerConflicts } from "./continuity-ledger-draft";

type Row = Record<string, any>;
const blankLedger = () => ({ contract_version: 2, facts: [], timelines: [], initial: [], events: [], requirements: [], coverage: [] });
const id = () => `C_${crypto.randomUUID()}`;
const stable = (value: any): string => Array.isArray(value) ? `[${value.map(stable).join(",")}]` : value && typeof value === "object" ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}` : JSON.stringify(value);
async function sourceDigest(sceneId: string, block: Row) {
  const bytes = new TextEncoder().encode(stable({ scene_id: sceneId, block }));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map(value => value.toString(16).padStart(2, "0")).join("");
}

function BoundaryContinuityRow({ from, to, fromLabel, toLabel, boundary, disabled, onSave, summary }: { from: string; to: string; fromLabel: string; toLabel: string; boundary?: Row; disabled: boolean; onSave: (value: Row) => void; summary?: ReactNode }) {
  const { t } = useTranslation();
  const [tailFrame, setTailFrame] = useState(Boolean(boundary?.tailFrame));
  const [motionContext, setMotionContext] = useState(Boolean(boundary?.motionContext));
  const [reason, setReason] = useState(String(boundary?.reason || ""));
  useEffect(() => { setTailFrame(Boolean(boundary?.tailFrame)); setMotionContext(Boolean(boundary?.motionContext)); setReason(String(boundary?.reason || "")); }, [from, to, boundary?.tailFrame, boundary?.motionContext, boundary?.reason]);
  return <article className="space-y-3 rounded-xl border border-border p-3"><div className="flex flex-wrap items-center justify-between gap-2"><strong>{fromLabel} → {toLabel}</strong>{!boundary && <Tag color="orange">{t("director.workspace.continuity.crud.boundaryUnset")}</Tag>}</div>
    {summary}
    <div className="grid gap-2 sm:grid-cols-2"><label className="flex items-center justify-between rounded-lg border border-border p-2 text-sm">{t("director.workspace.tailFrame")}<Switch checked={tailFrame} disabled={disabled} onChange={value => { setTailFrame(value); if (value) setMotionContext(false); }} /></label><label className="flex items-center justify-between rounded-lg border border-border p-2 text-sm">{t("director.workspace.motionContext")}<Switch checked={motionContext} disabled={disabled} onChange={value => { setMotionContext(value); if (value) setTailFrame(false); }} /></label></div>
    <Input.TextArea value={reason} disabled={disabled} placeholder={t("director.workspace.continuityReason")} autoSize={{ minRows: 2, maxRows: 4 }} onChange={event => setReason(event.target.value)} />
    <Button size="small" disabled={disabled || !reason.trim() || boundary?.tailFrame === tailFrame && boundary?.motionContext === motionContext && boundary?.reason === reason.trim()} onClick={() => onSave({ from, to, tailFrame, motionContext, reason: reason.trim() })}>{t("director.workspace.saveBoundary")}</Button>
  </article>;
}

export function ContinuityPanel({ ledger: savedLedger, source, sourceHash, subjectAssembly = false, draftValue, onDraftChange, scenes, locations = [], shots, segments, boundaries, characters, assets, report, workId, busy, snapshotLoading = false, titleAlreadyVisible = false, editable, onSave, onCheck, onLocate, onAskDirector, onBoundary, onSnapshot }: {
  source?: Row; ledger?: Row; sourceHash: string; scenes: Row[]; locations?: Row[]; shots: Row[]; segments: Row[]; boundaries: Row[]; characters: Row[]; assets: Row[]; report?: ProductionContinuity;
  workId?: string;
  subjectAssembly?: boolean;
  draftValue?: string; onDraftChange?: (value: string | undefined) => void;
  snapshotLoading?: boolean; titleAlreadyVisible?: boolean; busy: boolean; editable: boolean; onSave: (ledger: Row) => Promise<boolean>; onCheck: () => Promise<void>; onLocate: (kind: string, id: string) => void; onAskDirector?: (scope: { workspace: "continuity"; targetId?: string; workId?: string; instruction: string; autoSend?: boolean }) => void; onBoundary: (value: Row) => void; onSnapshot?: (value: "draft" | "published") => void;
}) {
  const { t } = useTranslation();
  const { modal } = App.useApp();
  const [lastDeletion, setLastDeletion] = useState<{ sourceKey: string; rows: Array<{ collection: ContinuityLedgerCollection; row: Row; index: number }> }>();
  const legacy = Boolean(savedLedger && savedLedger.contract_version !== 2);
  const formalLedger = savedLedger?.contract_version === 2 ? savedLedger : blankLedger();
  const ledgerV2 = savedLedger?.contract_version === 2;
  const retained = readContinuityLedgerDraft(ledgerV2 ? draftValue : undefined, formalLedger);
  const baselineLedger = useRef(retained.base);
  const [invalidLedgerDraft, setInvalidLedgerDraft] = useState(retained.invalid);
  const [ledger, setLedger] = useState<Row>(retained.value);
  const [sourceConflict, setSourceConflict] = useState(stable(retained.base) !== stable(formalLedger) && stable(retained.value) !== stable(formalLedger));
  const savedLedgerKey = savedLedger?.contract_version === 2 ? stable(savedLedger) : "legacy";
  const previousSource = useRef({ sourceHash, ledgerKey: savedLedgerKey });
  const [recordContext, setRecordContext] = useState<{ shotId: string; factId: string; visibleStart: number; eventId?: string }>();
  const [changeDraft, setChangeDraft] = useState<ContinuityChangeInput>();
  const leaveBlocker = useBlocker(Boolean(changeDraft));
  useEffect(() => { if (!changeDraft) return; const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; }; window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn); }, [Boolean(changeDraft)]);
  const [workbenchEventId, setWorkbenchEventId] = useState<string>();
  const [activeView, setActiveView] = useState<"workbench" | "objects" | "shots" | "ledger" | "issues" | "timeline" | "boundaries">(ledgerV2 ? "workbench" : "objects");
  const [manualOpen, setManualOpen] = useState(false);
  const [ledgerCategory, setLedgerCategory] = useState("facts");
  const [entryFocus, setEntryFocus] = useState("");
  useEffect(() => {
    if (!["ledger", "boundaries"].includes(activeView) || !entryFocus) return;
    const frame = requestAnimationFrame(() => {
      const entry = document.querySelector<HTMLElement>(`[data-continuity-entry-id="${CSS.escape(entryFocus)}"]`);
      entry?.scrollIntoView({ block: "nearest" }); entry?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [activeView, ledgerCategory, entryFocus]);
  const [timelineId, setTimelineId] = useState("");
  const [selectedTimelineShot, setSelectedTimelineShot] = useState("");
  const [filterScene, setFilterScene] = useState("all");
  const [filterTarget, setFilterTarget] = useState("all");
  const [filterObject, setFilterObject] = useState("all");
  const [filterCategory, setFilterCategory] = useState("all");
  const [newFactId, setNewFactId] = useState("");
  const [newTimelineName, setNewTimelineName] = useState("");
  const [objectKind, setObjectKind] = useState("character");
  const [objectId, setObjectId] = useState("");
  const [factValues, setFactValues] = useState("");
  const [factId, setFactId] = useState("");
  const [initialValue, setInitialValue] = useState("");
  const [shotId, setShotId] = useState("");
  const [eventFrame, setEventFrame] = useState("");
  const [eventAfter, setEventAfter] = useState("");
  const [eventReason, setEventReason] = useState("");
  const [sourceBlockId, setSourceBlockId] = useState("");
  const [exemptionReason, setExemptionReason] = useState("");
  const [reviewRef, setReviewRef] = useState("");

  useEffect(() => {
    if (savedLedger?.contract_version === 2) {
      const localChanged = previousSource.current.ledgerKey !== "legacy" && stable(ledger) !== stable(baselineLedger.current);
      if (localChanged && stable(ledger) !== savedLedgerKey) {
        if (continuityLedgerConflicts(baselineLedger.current, ledger, savedLedger).length) { setSourceConflict(true); previousSource.current = { sourceHash, ledgerKey: savedLedgerKey }; return; }
        const merged = rebaseContinuityLedger(baselineLedger.current, ledger, savedLedger);
        baselineLedger.current = structuredClone(savedLedger); setLedger(merged); setSourceConflict(false);
        previousSource.current = { sourceHash, ledgerKey: savedLedgerKey }; return;
      }
      baselineLedger.current = structuredClone(savedLedger); setLedger(structuredClone(savedLedger)); setSourceConflict(false);
    }
    else if (!savedLedger) setLedger(blankLedger());
    // A legacy ledger is only displayed as a read-only diagnostic. It never
    // becomes an implicit v2 baseline in the editor.
    previousSource.current = { sourceHash, ledgerKey: savedLedgerKey };
  }, [sourceHash, savedLedgerKey]);
  useEffect(() => {
    if (ledgerV2) setActiveView("workbench");
  }, [ledgerV2]);
  const ledgerKey = stable(ledger);
  useEffect(() => {
    if (!ledgerV2 || !editable || !onDraftChange || invalidLedgerDraft) return;
    const next = ledgerKey === savedLedgerKey ? undefined : JSON.stringify({ version: 1, base: baselineLedger.current, value: ledger });
    if (next !== draftValue) onDraftChange(next);
  }, [ledgerKey, savedLedgerKey, ledgerV2, editable, invalidLedgerDraft, draftValue, onDraftChange]);
  const invalidEventPositions = ledgerV2 && source ? continuityEventPositionIssues(source, ledger) : [];
  const saveLedger = async () => {
    if (!editable || legacy || changeDraft || snapshotLoading || busy || sourceConflict || invalidLedgerDraft || invalidEventPositions.length) return;
    // The save contract needs a model-readable description per allowed value; fill missing ones before writing.
    const next = continuityLedgerFactDescriptions(ledger);
    if (next !== ledger) setLedger(next);
    if (await onSave(next)) setLastDeletion(undefined);
  };
  useEffect(() => { setLastDeletion(undefined); }, [sourceHash, stable(source), savedLedgerKey, editable]);

  const sourceBlocks: Row[] = useMemo(() => continuitySourceBlocks(scenes), [stable(scenes)]);
  const factRows = Array.isArray(ledger.facts) ? ledger.facts as Row[] : [];
  const timeRows = Array.isArray(ledger.timelines) ? ledger.timelines as Row[] : [];
  const relevantShots = shots.filter(shot => !timelineId || shot.timeline_id === timelineId);
  const availableObjects = objectKind === "character" ? characters : objectKind === "scene" ? locations : assets;
  const blocksForShot = continuityBlocksForShot({ ...source, script_scenes: scenes, shots }, sourceBlocks, shots.find(shot => shot.id === shotId));
  const append = (collection: string, row: Row) => setLedger(current => ({ ...current, [collection]: [...(Array.isArray(current[collection]) ? current[collection] : []), row] }));
  const removeEntry = (collection: ContinuityLedgerCollection, row: Row) => {
    if (!activeEditContext.current.editable || activeEditContext.current.busy) return;
    const sourceKey = activeEditContext.current.key, entryId = continuityLedgerEntryId(collection, row);
    const current = latestLedger.current, plan = analyzeContinuityDeletion(source, current, collection, entryId);
    const removedRows = plan.removals.flatMap(removal => records(current[removal.collection]).flatMap((item, index) => continuityLedgerEntryId(removal.collection, item) === removal.id ? [{ collection: removal.collection, row: structuredClone(item), index }] : []));
    const snapshot = stable({ plan, rows: removedRows });
    const rowLabel = (group: string, identity: string) => {
      const item = records(current[group]).find(item => continuityLedgerEntryId(group as ContinuityLedgerCollection, item) === identity);
      if (group === "facts") return display.fact(identity);
      if (group === "timelines") return display.timeline(identity);
      if (group === "shots") return display.target(identity);
      if (item) return [item.fact_id ? display.fact(item.fact_id) : "", item.shot_id ? display.target(item.shot_id) : "", item.timeline_id ? display.timeline(item.timeline_id) : "", item.source_anchor?.block_id ? display.source(item.source_anchor.block_id) : ""].filter(Boolean).join(" · ") || t(`director.workspace.continuity.entryType.${group}`);
      return t("director.workspace.continuity.crud.deleteReferences");
    };
    let dialog: { destroy: () => void } | undefined;
    const content = <div className="space-y-3 text-sm"><p>{rowLabel(collection, entryId)}</p>
      <p>{t("director.workspace.continuity.crud.deleteDraftOnly")}</p>
      {plan.references.length > 0 && <div><strong>{t("director.workspace.continuity.crud.deleteReferences")}</strong><ul className="mt-2 space-y-2">{plan.references.map((reference, index) => <li key={`${reference.collection}:${reference.id}:${index}`}><span>{rowLabel(reference.collection, reference.id)}</span>{reference.shotId && <Button type="link" size="small" onClick={() => { dialog?.destroy(); onLocate("shot", reference.shotId!); }}>{display.target(reference.shotId)}</Button>}{["facts", "timelines", "initial", "events", "requirements", "coverage"].includes(reference.collection) && <Button type="link" size="small" onClick={() => { dialog?.destroy(); setActiveView("ledger"); setLedgerCategory(reference.collection as typeof ledgerCategory); const index = records(latestLedger.current[reference.collection]).findIndex(item => continuityLedgerEntryId(reference.collection as ContinuityLedgerCollection, item) === reference.id); const item = records(latestLedger.current[reference.collection])[index]; setEntryFocus(`${reference.collection}:${item?.id || index}`); }}>{t("director.workspace.continuity.openEvent")}</Button>}</li>)}</ul></div>}
      {plan.allowed && plan.removals.length > 1 && <div><strong>{t("director.workspace.continuity.crud.deleteImpact")}</strong><ul className="list-disc pl-5">{plan.removals.map(removal => <li key={`${removal.collection}:${removal.id}`}>{t(`director.workspace.continuity.entryType.${removal.collection}`)} · {rowLabel(removal.collection, removal.id)}</li>)}</ul></div>}
      {plan.affectedShotIds.length > 0 && <p>{plan.affectedShotIds.map(display.target).join(" · ")}</p>}
      {["events", "initial"].includes(collection) && <p>{t("director.workspace.continuity.crud.deleteDownstream")}</p>}
    </div>;
    if (!plan.allowed) { dialog = modal.info({ title: t("director.workspace.continuity.crud.deleteBlocked"), content }); return; }
    dialog = modal.confirm({ title: t("director.workspace.continuity.crud.deleteTitle"), content, okText: t("director.workspace.continuity.removeEntry"), cancelText: t("common.cancel"), okButtonProps: { danger: true }, onOk: () => {
      if (!activeEditContext.current.alive || !activeEditContext.current.editable || activeEditContext.current.busy || activeEditContext.current.key !== sourceKey) { message.warning(t("director.workspace.continuity.crud.deleteChanged")); return; }
      const current = latestLedger.current, nextPlan = analyzeContinuityDeletion(source, current, collection, entryId);
      const rows = nextPlan.removals.flatMap(removal => records(current[removal.collection]).flatMap((item, index) => continuityLedgerEntryId(removal.collection, item) === removal.id ? [{ collection: removal.collection, row: structuredClone(item), index }] : []));
      if (stable({ plan: nextPlan, rows }) !== snapshot) { message.warning(t("director.workspace.continuity.crud.deleteChanged")); return; }
      try { const next = applyContinuityDeletion(source, current, collection, entryId); latestLedger.current = next; setLedger(next); setLastDeletion({ sourceKey, rows }); }
      catch { message.warning(t("director.workspace.continuity.crud.deleteChanged")); }
    } });
  };
  const undoDeletion = () => {
    if (!lastDeletion || !activeEditContext.current.alive || !activeEditContext.current.editable || activeEditContext.current.busy || activeEditContext.current.key !== lastDeletion.sourceKey) return;
    try { const next = restoreContinuityDeletion(latestLedger.current, lastDeletion.rows, source); latestLedger.current = next; setLedger(next); setLastDeletion(undefined); }
    catch { message.warning(t("director.workspace.continuity.crud.deleteChanged")); }
  };

  const changeFact = (nextId: string) => { setFactId(nextId); const fact = factRows.find(item => item.id === nextId); setEventAfter(fact?.allowed_values?.[0] || ""); };
  const addTimeline = () => { if (!newTimelineName.trim()) return; const timeline = id(); append("timelines", { id: timeline, display_name: newTimelineName.trim() }); setTimelineId(timeline); setNewTimelineName(""); };
  const openManualLedger = () => { setLedgerCategory("facts"); setActiveView("ledger"); setManualOpen(true); };
  const addFact = () => {
    const allowed = normalizedContinuityValues(factValues);
    if (!newFactId.trim() || !objectId || !allowed.length || !availableObjects.some(row => String(row.id || row.asset_id) === objectId)) return;
    const fact = id();
    append("facts", { id: fact, display_name: newFactId.trim(), object_kind: objectKind, object_id: objectId, allowed_values: allowed, value_descriptions: Object.fromEntries(allowed.map(value => [value, value])) });
    setFactId(fact); setNewFactId(""); setFactValues("");
  };
  const addInitial = () => {
    if (!timelineId || !factId || !initialValue || !(initialValue === "unknown" || factRows.find(row => row.id === factId)?.allowed_values.includes(initialValue))) return;
    const initial = (ledger.initial || []).filter((row: Row) => !(row.timeline_id === timelineId && row.fact_id === factId));
    setLedger(current => ({ ...current, initial: [...initial, { timeline_id: timelineId, fact_id: factId, value: initialValue }] }));
  };
  const addHold = async () => {
    const contextKey = activeEditContext.current.key;
    const shot = shots.find(row => row.id === shotId), block = blocksForShot.find(row => row.id === sourceBlockId);
    if (!shot || !block) return;
    try {
      const digest = await sourceDigest(block.sceneId, block.sourceBlock);
      if (!activeEditContext.current.alive || !activeEditContext.current.editable || activeEditContext.current.busy || activeEditContext.current.key !== contextKey) { message.warning(t("director.workspace.continuity.subjectTimeline.sourceChanged")); return; }
      const next = appendContinuityHold(latestLedger.current, shots, { timelineId, shotId, factId, blockId: sourceBlockId, digest }, id, subjectAssembly);
      latestLedger.current = next; setLedger(next);
    } catch (error) { message.error(t("director.atomic.eventError." + (error instanceof Error ? error.message : "EVENT_FIELDS_REQUIRED"))); }
  };
  const activeEditContext = useRef({ key: "", editable, busy, alive: true });
  activeEditContext.current = { key: sourceHash + stable(source), editable: editable && !sourceConflict && !invalidLedgerDraft && !legacy && !snapshotLoading, busy, alive: true };
  useEffect(() => { activeEditContext.current.alive = true; return () => { activeEditContext.current.alive = false; }; }, []);
  const latestLedger = useRef(ledger); latestLedger.current = ledger;
  const createChange = async (input: ContinuityChangeInput): Promise<string | undefined> => {
    const contextKey = activeEditContext.current.key;
    const shot = shots.find(row => row.id === input.shotId);
    const block = input.sourceBlockId ? continuityBlocksForShot({ ...source, script_scenes: scenes, shots }, sourceBlocks, shot).find(row => row.id === input.sourceBlockId) : undefined;
    if (!shot || input.sourceBlockId && !block) return;
    try {
      const digest = block ? await sourceDigest(block.sceneId, block.sourceBlock) : undefined;
      if (!activeEditContext.current.alive || !activeEditContext.current.editable || activeEditContext.current.busy || activeEditContext.current.key !== contextKey) { message.warning(t("director.workspace.continuity.subjectTimeline.sourceChanged")); return; }
      const result = appendContinuityChange(latestLedger.current, shots, input, digest, id, true, subjectAssembly);
      latestLedger.current = result.ledger; setLedger(result.ledger); return result.eventId;
    } catch (error) { message.error(t("director.atomic.eventError." + (error instanceof Error ? error.message : "INVALID_EVENT_FRAME"))); }
  };
  const changeEventEvidence = async (eventId: string, blockId: string): Promise<boolean> => {
    const contextKey = activeEditContext.current.key;
    const event = records(ledger.events).find(row => row.id === eventId), block = sourceBlocks.find(row => row.id === blockId);
    if (!event || !block || event.source_anchor?.block_id === blockId) return false;
    const requirements = records(ledger.requirements).filter(row => (row.event_ids || []).includes(eventId));
    const coverage = records(ledger.coverage).filter(row => (row.event_ids || []).includes(eventId));
    const shared = requirements.some(row => row.event_ids.length !== 1) || coverage.some(row => row.event_ids.length !== 1 || row.fact_ids?.some((id: string) => id !== event.fact_id) || row.shot_ids?.some((id: string) => id !== event.shot_id));
    const target = records(ledger.coverage).some(row => row.evidence_kind === "explicit_change" && row.source_anchor?.block_id === blockId && !(row.event_ids || []).includes(eventId));
    if (shared || target || !coverage.length) { message.warning(t("director.workspace.continuity.subjectTimeline.sharedEvidence")); return false; }
    const oldBlock = sourceBlocks.find(row => row.id === event.source_anchor?.block_id);
    if (!oldBlock) { message.warning(t("director.workspace.continuity.subjectTimeline.sharedEvidence")); return false; }
    const oldDigest = await sourceDigest(oldBlock.sceneId, oldBlock.sourceBlock);
    if (coverage.some(row => row.source_digest !== oldDigest)) { message.warning(t("director.workspace.continuity.subjectTimeline.sharedEvidence")); return false; }
    const digest = await sourceDigest(block.sceneId, block.sourceBlock), source_anchor = { ...event.source_anchor, block_id: blockId };
    if (!activeEditContext.current.alive || !activeEditContext.current.editable || activeEditContext.current.busy || activeEditContext.current.key !== contextKey) { message.warning(t("director.workspace.continuity.subjectTimeline.sourceChanged")); return false; }
    if (stable(latestLedger.current) !== stable(ledger)) { message.warning(t("director.workspace.continuity.subjectTimeline.sharedEvidence")); return false; }
    setLedger(current => ({ ...current, events: records(current.events).map(row => row.id === eventId ? { ...row, source_anchor } : row), requirements: records(current.requirements).map(row => requirements.some(item => item.id === row.id) ? { ...row, source_anchor } : row), coverage: records(current.coverage).map(row => coverage.some(item => item.id === row.id) ? { ...row, source_anchor, source_digest: digest } : row) }));
    message.success(t("director.workspace.continuity.subjectTimeline.evidenceUpdated")); return true;
  };
  const addEvent = () => createChange({ shotId, factId, frame: eventFrame, after: eventAfter, reason: eventReason, sourceBlockId });
  const addExemption = async () => {
    const contextKey = activeEditContext.current.key;
    const block = blocksForShot.find(row => row.id === sourceBlockId);
    if (!block) return;
    try {
      const digest = await sourceDigest(block.sceneId, block.sourceBlock);
      if (!activeEditContext.current.alive || !activeEditContext.current.editable || activeEditContext.current.busy || activeEditContext.current.key !== contextKey) { message.warning(t("director.workspace.continuity.subjectTimeline.sourceChanged")); return; }
      const next = appendContinuityExemption(latestLedger.current, shots, { timelineId, shotId, blockId: sourceBlockId, digest, reason: exemptionReason, reviewRef }, id);
      latestLedger.current = next; setLedger(next);
    } catch (error) { message.error(t("director.atomic.eventError." + (error instanceof Error ? error.message : "EVENT_FIELDS_REQUIRED"))); }
  };
  const issues = report?.report?.diagnostics || report?.items || [];
  const workbenchSource = useMemo(() => ledgerV2 && source ? continuityWorkbenchSource(source, ledger, shots) : source, [ledgerV2, source, ledgerKey, shots]);
  const workbenchShots = workbenchSource ? records(workbenchSource.shots) : shots;
  const readProjection = useMemo(() => ledgerV2 && source ? continuityReadProjection(source, ledger, shots) : undefined, [ledgerV2, source, ledgerKey, shots]);
  const timeline = readProjection?.trajectories || report?.report?.trajectories || {};
  const initial = Array.isArray(ledger.initial) ? ledger.initial : [];
  const ledgerSections = (["facts", "timelines", "initial", "events", "requirements", "coverage"] as const).map(collection => ({ collection, rows: Array.isArray(ledger[collection]) ? ledger[collection] as Row[] : [] }));
  const display = continuityPresentation({ facts: factRows, timelines: timeRows, scenes, locations, characters, assets, shots, segments, sourceBlocks }, (key, values) => t(`director.workspace.continuity.${key}`, values));
  const ledgerDirty = editable && !legacy && ledgerKey !== stable(formalLedger);
  const pendingLedgerEdits = ledgerDirty || Boolean(changeDraft) || editable && !legacy && (sourceConflict || invalidLedgerDraft);
  const stateLabel = continuityPreviewStatus(report, sourceHash, pendingLedgerEdits);
  const checkBlockReason = changeDraft ? "finishChangeBeforeCheck" : sourceConflict || invalidLedgerDraft ? "resolveDraftBeforeCheck" : ledgerDirty ? "saveBeforeCheck" : undefined;
  const checkBlocked = busy || snapshotLoading || Boolean(checkBlockReason);
  const checkSavedLedger = async () => { if (!checkBlocked) await onCheck(); };
  const sceneIds = scenes.map(row => String(row.scene_id || row.id || "")).filter(Boolean);
  const targetOptions = [...shots, ...segments].map(row => ({ value: String(row.id), label: display.target(String(row.id)) }));
  const objectOptions = [...new Map(factRows.map(row => [String(row.object_id), { value: String(row.object_id), label: display.object(row.object_kind, row.object_id) }])).values()];
  const issueCategories = [...new Set((issues as Row[]).map(issue => String(issue.code || "UNKNOWN").split("_")[1] || "OTHER"))];
  const sceneForTarget = (target: string) => {
    const shot = shots.find(row => String(row.id) === target) || shots.find(row => (segments.find(segment => String(segment.id) === target)?.shot_ids || []).includes(row.id));
    return String(shot?.scene_id || "");
  };
  const visibleIssues = (issues as Row[]).filter(issue => {
    const targets = [...new Set([issue.targetId, ...(Array.isArray(issue.affectedTargets) ? issue.affectedTargets : [])].filter(Boolean).map(String))];
    const issueScenes = new Set([...targets.map(sceneForTarget).filter(Boolean), ...sceneIds.filter(sceneId => String(issue.path || "").includes(sceneId))]);
    const fact = factRows.find(row => String(row.id) === String(issue.factId || ""));
    const category = String(issue.code || "UNKNOWN").split("_")[1] || "OTHER";
    return (filterScene === "all" || issueScenes.has(filterScene)) && (filterTarget === "all" || targets.includes(filterTarget)) &&
      (filterObject === "all" || String(fact?.object_id || "") === filterObject) && (filterCategory === "all" || category === filterCategory);
  });

  const stateList = (states: Row, changed: Set<string> = new Set()) => Object.keys(states || {}).length ? <dl className="mt-2 space-y-3">{Object.entries(states).map(([factId, value]) => <div key={factId} className={changed.has(factId) ? "border-l-2 border-primary pl-3" : undefined}><dt className="text-xs text-muted-foreground">{display.fact(factId)}</dt><dd className="mt-1 break-words text-sm leading-relaxed">{display.value(factId, value)}</dd></div>)}</dl> : <p className="mt-2 text-sm text-muted-foreground">{t("director.workspace.continuity.stateUnknown")}</p>;
  const stateChange = (factId: string, before: unknown, after: unknown) => <div className="mt-3 grid gap-3 sm:grid-cols-2"><div className="min-w-0"><p className="text-xs text-muted-foreground">{t("director.workspace.continuity.beforeChange")}</p><p className="mt-1 break-words text-sm leading-relaxed">{display.value(factId, before)}</p></div><div className="min-w-0"><p className="text-xs text-muted-foreground">{t("director.workspace.continuity.afterChange")}</p><p className="mt-1 break-words text-sm font-medium leading-relaxed">{display.value(factId, after)}</p></div></div>;
  const entryCard = (collection: string, row: Row, index: number) => {
    const sourceId = String(row.source_anchor?.block_id || "");
    const title = collection === "facts" ? display.fact(row.id) : collection === "timelines" ? display.timeline(row.id) : collection === "coverage" ? display.scene(String(sourceBlocks.find(block => block.id === sourceId)?.sceneId || "")) : display.fact(row.fact_id);
    return <article key={`${collection}:${row.id || index}`} className="min-w-0 rounded-xl border border-border p-4" data-continuity-entry={collection} data-continuity-entry-id={`${collection}:${row.id || index}`} tabIndex={-1}>
      <div className="flex flex-wrap items-center justify-between gap-2"><h4 className="text-sm font-semibold">{title}</h4>{collection === "facts" ? <span className="text-xs text-muted-foreground">{t(`director.workspace.continuity.objectKindValue.${row.object_kind}`, { defaultValue: t("director.workspace.continuity.objectKindValue.asset") })}</span> : row.timeline_id ? <span className="text-xs text-muted-foreground">{display.timeline(row.timeline_id)}</span> : null}</div>
      {collection === "facts" && <><label className="mt-3 grid gap-1 text-xs"><span>{t("director.crud.factName")}</span><Input value={row.display_name || row.name || ""} disabled={busy || !editable || legacy || sourceConflict || invalidLedgerDraft || snapshotLoading} onChange={event => setLedger(current => ({ ...current, facts: current.facts.map((fact: Row) => fact.id === row.id ? { ...fact, display_name: event.target.value } : fact) }))} /></label>
        {subjectAssembly && editable && <div className="mt-3 space-y-2">{(row.allowed_values || []).map((value: string) => <label key={value} className="grid gap-1 text-xs text-muted-foreground"><span>{t("director.atomic.stateDescription", { value: display.value(row.id, value) })}</span><Input.TextArea value={row.value_descriptions?.[value] || ""} disabled={busy || !editable || legacy || sourceConflict || invalidLedgerDraft || snapshotLoading} autoSize={{ minRows: 1, maxRows: 4 }} onChange={event => setLedger(current => ({ ...current, facts: current.facts.map((fact: Row) => fact.id === row.id ? { ...fact, value_descriptions: { ...fact.value_descriptions, [value]: event.target.value } } : fact) }))} /></label>)}</div>}
        <div className="mt-3 space-y-3">{initial.filter((state: Row) => state.fact_id === row.id).map((state: Row, stateIndex: number) => <div key={stateIndex}><p className="text-xs text-muted-foreground">{display.timeline(state.timeline_id)} · {t("director.workspace.continuity.initialValue")}</p><p className="mt-1 break-words text-sm leading-relaxed">{display.value(row.id, state.value)}</p></div>)}{!initial.some((state: Row) => state.fact_id === row.id) && <p className="text-sm text-muted-foreground">{t("director.workspace.continuity.initialMissing")}</p>}</div>
        <details className="mt-3"><summary className="cursor-pointer text-xs text-muted-foreground">{t("director.workspace.continuity.availableStates", { count: row.allowed_values?.length || 0 })}</summary><ul className="mt-2 list-disc space-y-1.5 pl-5 text-sm leading-relaxed">{(row.allowed_values || []).map((value: string) => <li key={value} className="break-words">{display.value(row.id, value)}</li>)}</ul></details>
      </>}
      {collection === "timelines" && editable && !legacy && <Input className="mt-2" aria-label={t("director.crud.timelineName")} value={row.display_name || row.name || ""} disabled={busy || !editable || legacy || sourceConflict || invalidLedgerDraft || snapshotLoading} onChange={event => setLedger(current => ({ ...current, timelines: records(current.timelines).map(item => item.id === row.id ? { ...item, display_name: event.target.value } : item) }))} />}
      {collection === "timelines" && <p className="mt-2 text-sm text-muted-foreground">{t("director.workspace.continuity.timelineSummary", { facts: initial.filter((state: Row) => state.timeline_id === row.id).length, events: (ledger.events || []).filter((event: Row) => event.timeline_id === row.id).length })}</p>}
      {collection === "initial" && <><p className="mt-2 text-xs text-muted-foreground">{t("director.workspace.continuity.subjectTimeline.initialScope")}</p>{editable && !legacy ? <Select className="mt-2 w-full" aria-label={t("director.workspace.continuity.initialValue")} disabled={busy || !editable || legacy || sourceConflict || invalidLedgerDraft || snapshotLoading} value={row.value} options={[...new Set([...(factRows.find(fact => fact.id === row.fact_id)?.allowed_values || []), "unknown"])].map(value => ({ value, label: display.value(row.fact_id, value) }))} onChange={value => setLedger(current => ({ ...current, initial: records(current.initial).map(item => item.timeline_id === row.timeline_id && item.fact_id === row.fact_id ? { ...item, value } : item) }))} /> : <p className="mt-2 break-words text-sm leading-relaxed">{display.value(row.fact_id, row.value)}</p>}</>}
      {collection === "events" && <>{subjectAssembly && <Button size="small" disabled={busy || !editable || legacy || sourceConflict || invalidLedgerDraft || snapshotLoading} onClick={() => { setWorkbenchEventId(String(row.id)); setActiveView("workbench"); }}>{t("director.workspace.continuity.subjectTimeline.editEvent")}</Button>}<p className="mt-2 text-xs text-muted-foreground">{display.target(row.shot_id)} · {Number.isFinite(subjectAssembly ? continuityLocalFrame(row, shots.find(shot => shot.id === row.shot_id) || {}) : continuityEventFrame(row, shots)) ? t(subjectAssembly ? "director.workspace.continuity.subjectTimeline.localFrameOnly" : "director.workspace.continuity.atFrame", { frame: subjectAssembly ? continuityLocalFrame(row, shots.find(shot => shot.id === row.shot_id) || {}) : continuityEventFrame(row, shots) }) : t("director.workspace.continuity.subjectTimeline.invalidPositionSave")}</p>{stateChange(row.fact_id, row.before, row.after)}{(row.display_reason || row.reason) && <p className="mt-3 break-words text-sm text-muted-foreground">{row.display_reason || row.reason}</p>}</>}
      {collection === "requirements" && <><p className="mt-2 text-xs text-muted-foreground">{display.target(row.shot_id)} · {t(`director.workspace.continuity.requirementKind.${row.kind}`, { defaultValue: t("director.workspace.continuity.otherRequirement") })}</p>{row.value !== undefined && <p className="mt-2 break-words text-sm">{display.value(row.fact_id, row.value)}</p>}{(row.event_ids || []).map((eventId: string) => { const event = (ledger.events || []).find((item: Row) => item.id === eventId); return event ? <div key={eventId}>{stateChange(row.fact_id, event.before, event.after)}</div> : <p key={eventId} className="mt-2 text-sm text-muted-foreground">{t("director.workspace.continuity.missingEvent")}</p>; })}</>}
      {collection === "coverage" && <><p className="mt-2 text-sm">{t(`director.workspace.continuity.coverageKind.${row.evidence_kind}`, { defaultValue: t("director.workspace.continuity.otherCoverage") })}</p>{row.fact_ids?.length > 0 && <p className="mt-2 text-xs text-muted-foreground">{row.fact_ids.map((factId: string) => display.fact(factId)).join(" · ")}</p>}{row.shot_ids?.length > 0 && <p className="mt-1 text-xs text-muted-foreground">{row.shot_ids.map((shotId: string) => display.target(shotId)).join(" · ")}</p>}{(row.display_reason || row.reason) && <p className="mt-2 break-words text-sm text-muted-foreground">{row.display_reason || row.reason}</p>}</>}
      {sourceId && <p className="mt-3 break-words border-t border-border pt-3 text-xs leading-relaxed text-muted-foreground">{t("director.workspace.continuity.scriptEvidence")}: {display.source(sourceId)}</p>}
      <details className="mt-3"><summary className="cursor-pointer text-xs text-muted-foreground">{t("director.workspace.continuity.technicalDetails")}</summary><pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-muted/30 p-3 text-xs">{JSON.stringify(row, null, 2)}</pre></details>{editable && !legacy && <Button danger size="small" disabled={busy || !editable || legacy || sourceConflict || invalidLedgerDraft || snapshotLoading} onClick={() => removeEntry(collection as ContinuityLedgerCollection, row)}>{t("director.workspace.continuity.removeEntry")}</Button>}
    </article>;
  };

  const readableFactRows = activeView === "objects" || activeView === "shots" ? factRows.filter(fact => activeView !== "objects" || filterObject === "all" || String(fact.object_id) === filterObject).flatMap(fact => {
          const events = records(ledger.events).filter(event => event.fact_id === fact.id && (activeView !== "shots" || filterTarget === "all" || event.shot_id === filterTarget || (segments.find(segment => segment.id === filterTarget)?.shot_ids || []).includes(event.shot_id))).sort((a, b) => continuityEventFrame(a, shots) - continuityEventFrame(b, shots));
          if (activeView === "shots" && filterTarget !== "all") {
            const ids = segments.find(segment => segment.id === filterTarget)?.shot_ids || [filterTarget];
            const states = readProjection?.trajectories || {};
            const held = ids.flatMap((shotId: string) => {
              const state = states[shotId], start = state?.start[fact.id], end = state?.end[fact.id];
              if (!start && !end) return [];
              const changes = events.filter(event => event.shot_id === shotId);
              return [{ id: `state:${shotId}:${fact.id}`, timeline_id: shots.find(shot => shot.id === shotId)?.timeline_id, shot_id: shotId, before: start, after: end, reason: changes.map(event => event.reason || event.description).filter(Boolean).join("；") || t("director.workspace.continuity.heldState"), local_frame: 0 }];
            });
            if (held.length) events.splice(0, events.length, ...held);
            else if (!events.length) return [];
          }
          const rows: Row[] = events.length ? events : records(ledger.initial).filter(row => row.fact_id === fact.id).map(row => ({ ...row, before: row.value, after: row.value, initial: true }));
          if (!rows.length) rows.push({ initial: true });
          return rows.map((event, index) => <tr key={`${fact.id}:${event.id || index}`} className="border-b border-border align-top"><td className="px-3 py-3"><button type="button" className="text-left font-medium hover:text-primary" onClick={() => { setActiveView("ledger"); setLedgerCategory("facts"); setEntryFocus(`facts:${fact.id}`); }}>{display.fact(fact.id)}</button><p className="mt-1 text-xs text-muted-foreground">{display.timeline(event.timeline_id)}</p></td><td className="px-3 py-3">{display.value(fact.id, event.before)}</td><td className="px-3 py-3"><button type="button" className="text-left hover:text-primary" onClick={() => { setActiveView("ledger");
            const original = records(ledger.events).find(row => row.id === event.id || row.fact_id === fact.id && row.shot_id === event.shot_id);
            const collection = original ? "events" : "initial";
            const rows = records(ledger[collection]), row = original || rows.find(row => row.fact_id === fact.id && (!event.timeline_id || row.timeline_id === event.timeline_id));
            setLedgerCategory(collection); if (row) setEntryFocus(`${collection}:${row.id || rows.indexOf(row)}`);
          }}>{event.reason || event.description || t(event.initial ? "director.workspace.continuity.initialValue" : "director.workspace.continuity.openEvent")}</button>{event.shot_id && <button type="button" className="mt-1 block text-xs text-primary" onClick={() => onLocate("shot", event.shot_id)}>{display.target(event.shot_id)} · {t(subjectAssembly ? "director.workspace.continuity.subjectTimeline.localFrameOnly" : "director.workspace.continuity.atFrame", { frame: subjectAssembly ? event.local_frame : continuityEventFrame(event, shots) })}</button>}</td><td className="px-3 py-3">{display.value(fact.id, readProjection?.eventStates[event.id] ?? event.after)}</td></tr>);
        }) : [];

  const reportCurrent = Boolean(sourceHash && report?.report && report.sourceHash === sourceHash && !pendingLedgerEdits && !["stale", "unsaved", "unchecked", "missing"].includes(stateLabel));
  const readingViews = ["objects", "shots", "timeline"];
  const managementViews = ["issues", "ledger", "boundaries"];
  const viewName = (view: string) => view === "issues"
    ? `${t("director.workspace.continuity.view.issues")}${reportCurrent ? ` · ${issues.length}` : ""}`
    : t(view === "workbench" ? "director.workspace.continuity.subjectTimeline.title" : `director.workspace.continuity.subjectTimeline.advanced.${view}`);
  const viewItems = [
    { type: "group" as const, key: "reading", label: t("director.workspace.continuity.crud.stateViews"), children: readingViews.filter(view => view !== "workbench").map(view => ({ key: view, label: viewName(view) })) },
    { type: "group" as const, key: "management", label: t("director.workspace.continuity.crud.reviewViews"), children: managementViews.map(view => ({ key: view, label: viewName(view) })) },
  ];
  if (legacy) return <Alert type="error" showIcon message={t("director.workspace.unsupportedProductionFormat")} />;
  return <section className={activeView === "workbench" ? "continuity-workspace-main" : "space-y-3"} data-continuity-workspace>
    <header className="continuity-view-tools" aria-label={t("director.workspace.tab.continuity")}><h2 className={titleAlreadyVisible ? "sr-only" : "m-0 text-base font-semibold"}>{t("director.workspace.tab.continuity")}</h2>
      <nav className="production-view-tabs" aria-label={t("director.workspace.continuity.views")}>
        {ledgerV2 && <Button data-continuity-timeline-entry type={activeView === "workbench" ? "primary" : "default"} size="small" aria-pressed={activeView === "workbench"} onClick={() => { setEntryFocus(""); setActiveView("workbench"); }}>{t("director.workspace.continuity.subjectTimeline.title")}</Button>}
        <Dropdown trigger={["click"]} menu={{ selectable: true, selectedKeys: [activeView], items: viewItems, onClick: ({ key }) => { setEntryFocus(""); setActiveView(key as typeof activeView); } }}>
          <Button data-continuity-view-selector size="small" aria-label={t("director.workspace.continuity.views")}>{t("director.workspace.continuity.views")}<ChevronDown className="size-3.5" /></Button>
        </Dropdown>
      </nav>
      <div className="continuity-view-actions">
        {(["objects", "shots"] as const).includes(activeView as "objects" | "shots") && <label className="continuity-object-filter" data-continuity-filter={activeView}>
          <span>{t(`director.workspace.continuity.${activeView === "objects" ? "filterObject" : "filterTarget"}`)}</span>
          <Select size="small" aria-label={t(`director.workspace.continuity.${activeView === "objects" ? "filterObject" : "filterTarget"}`)} value={activeView === "objects" ? filterObject : filterTarget}
            options={[{ value: "all", label: t(`director.workspace.continuity.${activeView === "objects" ? "filterAllObjects" : "filterAllTargets"}`) }, ...(activeView === "objects" ? objectOptions : targetOptions)]}
            onChange={activeView === "objects" ? setFilterObject : setFilterTarget} />
        </label>}
        <span className="text-xs text-muted-foreground">{t("director.workspace.continuity.crud.sourceLabel")}</span><Select aria-label={t("director.workspace.continuity.snapshot")} value={report?.snapshot || "draft"} options={[{ value: "draft", label: t("director.workspace.continuity.snapshotDraft") }, { value: "published", label: t("director.workspace.continuity.snapshotPublished") }]} onChange={value => { if (changeDraft) { message.warning(t("director.workspace.continuity.subjectTimeline.finishDraft")); return; } onSnapshot?.(value); }} />
        <Tag color={stateLabel === "passed" ? "green" : ["blocked", "stale"].includes(stateLabel) ? "red" : "gold"}>{stateLabel === "unsaved" ? t("director.workspace.continuity.subjectTimeline.uncheckedDraft") : t(`director.workspace.continuity.status.${stateLabel}`)}</Tag>
        {report?.report?.semanticDiscovery === "not_performed" && <span className="text-xs text-muted-foreground" title={t("director.workspace.continuity.registeredCoverageOnly")}>{t("director.workspace.continuity.subjectTimeline.registeredOnlyBrief")}</span>}
        {checkBlockReason && <span className="text-xs text-muted-foreground" role="status" data-continuity-check-blocked>{t(`director.workspace.continuity.subjectTimeline.${checkBlockReason}`)}</span>}
        {ledgerDirty && <Button data-continuity-save-action type="primary" loading={busy} disabled={busy || snapshotLoading || sourceConflict || invalidLedgerDraft || invalidEventPositions.length > 0 || Boolean(changeDraft)} onClick={saveLedger}>{t("director.workspace.continuity.subjectTimeline.saveEdits")}</Button>}
        <Button data-continuity-check-action loading={busy} disabled={checkBlocked} onClick={() => void checkSavedLedger()}>{t("director.workspace.continuity.subjectTimeline.checkSaved")}</Button>
        <Popover trigger="click" title={t("director.workspace.tab.continuity")} content={<div className="max-w-[min(28rem,75vw)] space-y-2 text-sm leading-6"><p>{t("director.workspace.continuity.semanticLimit")}</p>{report?.report?.semanticDiscovery === "not_performed" && <p>{t("director.workspace.continuity.registeredCoverageOnly")}</p>}<p>{t("director.workspace.continuity.lastChecked")}: {report?.checkedAt ? new Date(report.checkedAt).toLocaleString() : t("director.workspace.continuity.neverChecked")} · {t("director.workspace.continuity.scopeCount", { count: report?.report?.selectedTargets?.length || 0 })}</p></div>}><Button type="text" size="small" aria-label={`${t("director.workspace.tab.continuity")} · ${t("common.details")}`} icon={<CircleHelp className="size-4" />} /></Popover>
      </div>
    </header>
    {leaveBlocker.state === "blocked" && <Alert type="warning" message={t("director.workspace.continuity.subjectTimeline.leaveDraft")} action={<div className="flex gap-2"><Button size="small" onClick={() => leaveBlocker.reset()}>{t("director.workspace.continuity.subjectTimeline.keepEditing")}</Button><Button size="small" onClick={() => { setChangeDraft(undefined); leaveBlocker.proceed(); }}>{t("director.workspace.continuity.subjectTimeline.discardLeave")}</Button></div>} />}
    {snapshotLoading && <p className="text-xs text-muted-foreground" role="status">{t("director.workspace.continuity.subjectTimeline.snapshotLoading")}</p>}
    {invalidEventPositions.length > 0 && <p className="text-xs text-destructive" role="alert">{t("director.workspace.continuity.subjectTimeline.invalidPositionSave")}</p>}
    {lastDeletion && <div className="flex flex-wrap items-center gap-2 text-xs" role="status"><span>{t("director.workspace.continuity.crud.deletedDraft")}</span><Button size="small" disabled={busy || !editable || sourceConflict} onClick={undoDeletion}>{t("director.workspace.continuity.crud.undoDelete")}</Button></div>}
    {ledgerDirty && <p className="text-xs text-muted-foreground" data-continuity-unsaved>{t("director.workspace.continuity.subjectTimeline.draftDirty")}</p>}
    {sourceConflict && <Alert type="warning" showIcon message={t("director.workspace.continuity.sourceConflict")} description={<details><summary>{t("director.atomic.reviewCurrentSource")}</summary><pre className="max-h-64 overflow-auto whitespace-pre-wrap text-xs">{JSON.stringify(formalLedger, null, 2)}</pre><Button disabled={busy} size="small" onClick={() => { try { setLedger(rebaseContinuityLedger(baselineLedger.current, ledger, formalLedger)); baselineLedger.current = structuredClone(formalLedger); setSourceConflict(false); } catch { message.error(t("director.atomic.ledgerIdsMissing")); } }}>{t("director.atomic.keepReviewedDraft")}</Button></details>} />}
    {invalidLedgerDraft && <Alert type="warning" showIcon message={t("director.atomic.invalidDraft")} description={<details><summary>{t("director.atomic.reviewDraft")}</summary><pre className="max-h-48 overflow-auto whitespace-pre-wrap text-xs">{draftValue}</pre><Button disabled={busy} size="small" onClick={() => { baselineLedger.current = structuredClone(formalLedger); setLedger(structuredClone(formalLedger)); setInvalidLedgerDraft(false); setSourceConflict(false); onDraftChange?.(undefined); }}>{t("director.atomic.resetDraft")}</Button></details>} />}
    {!editable && <Alert type="info" showIcon message={t("director.workspace.continuity.publishedReadOnly")} />}
    {activeView !== "workbench" && report?.report?.semanticDiscovery === "not_performed" && <p className="rounded-lg border border-border px-3 py-2 text-xs text-muted-foreground">{t("director.workspace.continuity.registeredCoverageOnly")}</p>}
    {activeView === "workbench" && ledgerV2 && workbenchSource && <ContinuityTimelineWorkbench recordContext={recordContext} onRecordContext={setRecordContext} changeDraft={changeDraft} onChangeDraft={setChangeDraft} focusEventId={workbenchEventId} source={workbenchSource} subjectAssembly={subjectAssembly} ledger={ledger} savedLedger={formalLedger} shots={workbenchShots} display={display} sourceBlocks={sourceBlocks} disabled={busy || snapshotLoading || !editable || sourceConflict || invalidLedgerDraft || legacy} editable={editable} dirty={ledgerDirty} busy={busy} saveBlocked={invalidEventPositions.length > 0} actions={{
      update: setLedger,
      openEntry: (collection, row) => { setActiveView("ledger"); setLedgerCategory(collection); if (row) setEntryFocus(`${collection}:${row.id || records(ledger[collection]).indexOf(row)}`); },
      openBoundary: from => { setEntryFocus(`boundary:${from}`); setActiveView("boundaries"); },
      createEvent: createChange, changeEvidence: changeEventEvidence, deleteEvent: event => removeEntry("events", event),
    }} />}
    {(activeView === "objects" || activeView === "shots") && <section className="space-y-3" data-continuity-readable>
      {readableFactRows.length > 0 ? <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead className="border-b border-border text-xs text-muted-foreground"><tr>{["objectProperty", "beforeChange", "eventDescription", "afterChange"].map(key => <th key={key} className="min-w-40 px-3 py-3 font-medium">{t("director.workspace.continuity." + key)}</th>)}</tr></thead><tbody>
        {readableFactRows}
      </tbody></table></div> : <div className="continuity-empty-state" data-continuity-empty-state>
        <p role="status">{(activeView === "objects" ? filterObject : filterTarget) !== "all" ? t("director.workspace.continuity.subjectTimeline.empty") : factRows.length === 0 ? t("director.workspace.continuity.emptyEntries") : t("director.workspace.continuity.subjectTimeline.empty")}</p>
        {(activeView === "objects" ? filterObject : filterTarget) !== "all" && <Button data-continuity-empty-action size="small" onClick={() => activeView === "objects" ? setFilterObject("all") : setFilterTarget("all")}>{t(`director.workspace.continuity.${activeView === "objects" ? "filterAllObjects" : "filterAllTargets"}`)}</Button>}        {(activeView === "objects" ? filterObject : filterTarget) === "all" && factRows.length === 0 && editable && !legacy && <Button data-continuity-empty-action size="small" onClick={openManualLedger}>{t("director.workspace.continuity.manualEditing")}</Button>}
      </div>}
    </section>}
    {activeView === "ledger" && <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{t("director.workspace.continuity.readableLedgerHint")}</p>
      <nav className="flex flex-wrap gap-1" aria-label={t("director.workspace.continuity.registeredEntries")}>{ledgerSections.map(({ collection, rows }) => <Button key={collection} type="text" size="small" className={ledgerCategory === collection ? "bg-muted font-medium" : "text-muted-foreground"} aria-pressed={ledgerCategory === collection} onClick={() => setLedgerCategory(collection)}>{t(`director.workspace.continuity.entryType.${collection}`)} <span className="ml-1 text-muted-foreground">{rows.length}</span></Button>)}</nav>
      <div className="grid gap-3 lg:grid-cols-2">{(ledgerSections.find(section => section.collection === ledgerCategory)?.rows || []).map((row, index) => entryCard(ledgerCategory, row, index))}</div>
      {!(ledgerSections.find(section => section.collection === ledgerCategory)?.rows.length) && <p className="py-6 text-sm text-muted-foreground">{t("director.workspace.continuity.emptyEntries")}</p>}
    </div>}
    {activeView === "issues" && <p className="text-xs text-muted-foreground" role="status">{t(`director.workspace.continuity.subjectTimeline.${reportCurrent ? "savedReportTask" : "currentNotChecked"}`)}</p>}
    {activeView === "issues" && <div className="space-y-3"><div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4"><Select aria-label={t("director.workspace.continuity.filterScene")} value={filterScene} options={[{ value: "all", label: t("director.workspace.continuity.filterAllScenes") }, ...sceneIds.map(value => ({ value, label: display.scene(value) }))]} onChange={setFilterScene} /><Select aria-label={t("director.workspace.continuity.filterTarget")} value={filterTarget} options={[{ value: "all", label: t("director.workspace.continuity.filterAllTargets") }, ...targetOptions]} onChange={setFilterTarget} /><Select aria-label={t("director.workspace.continuity.filterObject")} value={filterObject} options={[{ value: "all", label: t("director.workspace.continuity.filterAllObjects") }, ...objectOptions]} onChange={setFilterObject} /><Select aria-label={t("director.workspace.continuity.filterCategory")} value={filterCategory} options={[{ value: "all", label: t("director.workspace.continuity.filterAllCategories") }, ...issueCategories.map(value => ({ value, label: t(`director.workspace.continuity.issueCategory.${value}`, { defaultValue: t("director.workspace.continuity.issueCategory.OTHER") }) }))]} onChange={setFilterCategory} /></div>{visibleIssues.length ? visibleIssues.map((issue, index) => { const targets = [...new Set([issue.targetId, ...(Array.isArray(issue.affectedTargets) ? issue.affectedTargets : [])].filter(Boolean).map(String))]; const fact = factRows.find(row => String(row.id) === String(issue.factId || "")); const sourceBlockId = String(issue.sourceBlockId || "") || String(issue.path || "").split(".blocks.")[1]?.split(".")[0]; const sourceBlock = sourceBlocks.find(block => String(block.id) === sourceBlockId); const displayValue = (value: unknown) => display.expected(String(issue.factId || ""), value); return <article key={`${issue.code}:${issue.targetId || ""}:${index}`} className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-border p-3"><div className="min-w-0"><div className="flex flex-wrap gap-2"><Tag color={issue.severity === "warning" ? "gold" : "red"}>{t(`director.workspace.continuity.issueCategory.${String(issue.code || "").split("_")[1]}`, { defaultValue: t("director.workspace.continuity.issueCategory.OTHER") })}</Tag>{fact && <Tag>{display.fact(fact.id)}</Tag>}{targets.map(target => <Tag key={target}>{display.target(target)}</Tag>)}</div><p className="mt-2 text-sm">{display.message(String(issue.display_message || issue.message || ""))}</p>{issue.expected !== undefined || issue.actual !== undefined ? <p className="mt-1 text-xs">{t("director.workspace.continuity.expectedActual", { expected: displayValue(issue.expected) ?? "—", actual: displayValue(issue.actual) ?? "—" })}</p> : null}{sourceBlock && <p className="mt-1 text-xs text-muted-foreground">{t("director.workspace.continuity.sourceEvidence", { block: display.scene(sourceBlock.sceneId), text: sourceBlock.sourceBlock.text || "" })}</p>}<details className="mt-3"><summary className="cursor-pointer text-xs text-muted-foreground">{t("director.workspace.continuity.technicalDetails")}</summary><pre className="mt-2 whitespace-pre-wrap break-all text-xs">{JSON.stringify(issue, null, 2)}</pre></details></div><div className="flex flex-wrap gap-1">{targets.map(target => <Button key={target} size="small" onClick={() => onLocate(segments.some(item => String(item.id) === target) ? "segment" : "shot", target)}>{t("director.workspace.continuity.locate")} · {display.target(target)}</Button>)}{onAskDirector && <Button size="small" disabled={busy || !editable} onClick={() => onAskDirector({
              workspace: "continuity", targetId: String(issue.targetId || targets[0] || ""), workId, autoSend: true,
              instruction: `${t("director.workspace.continuity.handoffPrompt")}\n${JSON.stringify({ owner: report?.owner, workId, revision: report?.revision, publishedVersion: report?.publishedVersion, snapshot: report?.snapshot, sourceHash: report?.sourceHash, checkOperationId: report?.report?.operationId, issue: { code: issue.code, message: issue.message, path: issue.path, targetId: issue.targetId, affectedTargets: issue.affectedTargets, factId: issue.factId, expected: issue.expected, actual: issue.actual, sourceBlockId: issue.sourceBlockId }, sourceBlock: sourceBlock?.sourceBlock?.text }, null, 2)}`
            })}>{t("director.workspace.continuity.handoffToDirector")}</Button>}</div></article>; }) : <p className="rounded-xl border border-border p-4 text-sm text-muted-foreground">{!reportCurrent ? t("director.workspace.continuity.subjectTimeline.currentNotChecked") : visibleIssues.length === 0 && issues.length ? t("director.workspace.continuity.noFilterIssues") : t("director.workspace.continuity.noIssues")}</p>}</div>}
    {(activeView === "timeline" || activeView === "boundaries") && subjectAssembly && <p className="text-xs text-muted-foreground">{t("director.workspace.continuity.subjectTimeline.previewNotReport")}</p>}
    {activeView === "timeline" && subjectAssembly && report?.report?.trajectories && <details className="text-xs text-muted-foreground"><summary>{t("director.workspace.continuity.subjectTimeline.savedReportHint")}</summary><pre className="max-h-64 overflow-auto whitespace-pre-wrap">{JSON.stringify(report.report.trajectories, null, 2)}</pre></details>}
    {activeView === "timeline" && (() => {
      const entries = Object.entries(timeline) as Array<[string, Row]>;
      const selected = entries.find(([shotId]) => shotId === selectedTimelineShot) || entries[0];
      if (!selected) return <p className="py-6 text-sm text-muted-foreground">{t("director.workspace.continuity.timelineEmpty")}</p>;
      const [shotId, row] = selected;
      const changed = new Set([...Object.keys(row.start || {}), ...Object.keys(row.end || {})].filter(factId => row.start?.[factId] !== row.end?.[factId]));
      return <div className="grid items-start gap-4 lg:grid-cols-[220px_minmax(0,1fr)]"><nav className="max-h-64 overflow-y-auto rounded-xl border border-border lg:max-h-[70dvh]" aria-label={t("director.workspace.continuity.view.timeline")}>{entries.map(([id, item]) => <button type="button" key={id} aria-current={id === shotId ? "true" : undefined} onClick={() => setSelectedTimelineShot(id)} className={`block w-full border-b border-border px-3 py-3 text-left last:border-0 ${id === shotId ? "bg-muted" : "hover:bg-muted/40"}`}><span className="block truncate text-sm font-medium">{display.target(id)}</span><span className="mt-1 block truncate text-xs text-muted-foreground">{display.timeline(item.timelineId)}</span></button>)}</nav><article className="min-w-0 rounded-xl border border-border p-4"><div className="flex flex-wrap items-center justify-between gap-2"><div><strong className="text-sm">{display.target(shotId)}</strong><p className="mt-1 text-xs text-muted-foreground">{t("director.studio.changedStates", { count: changed.size })}</p></div><Button size="small" onClick={() => onLocate("shot", shotId)}>{t("director.workspace.continuity.locate")}</Button></div><div className="mt-4 grid gap-4 sm:grid-cols-2"><section className="min-w-0"><h3 className="text-xs font-medium text-muted-foreground">{t("director.workspace.continuity.startState")}</h3>{stateList(row.start, changed)}</section><section className="min-w-0 sm:border-l sm:border-border sm:pl-4"><h3 className="text-xs font-medium text-muted-foreground">{t("director.workspace.continuity.endState")}</h3>{stateList(row.end, changed)}</section></div></article></div>;
    })()}

    {activeView === "boundaries" && <div className="space-y-3">{segments.length < 2 && <p className="production-empty-state">{t("director.atomic.noClipBoundaries")}</p>}{segments.slice(0, -1).map((segment, index) => {
      const next = segments[index + 1], fromShot = shots.find(row => row.id === (segment.shot_ids || []).at(-1)), toShot = shots.find(row => row.id === (next.shot_ids || [])[0]);
      const left = fromShot && timeline[String(fromShot.id)]?.end, right = toShot && timeline[String(toShot.id)]?.start;
      const differences = left && right ? [...new Set([...Object.keys(left), ...Object.keys(right)])].filter(key => left[key] !== right[key]) : [];
      const unknown = !left || !right || [...Object.values(left), ...Object.values(right)].some(value => value === "unknown" || value == null);
      return <div key={`${segment.id}:${next.id}`} data-continuity-entry-id={`boundary:${segment.id}`} tabIndex={-1}>
        <BoundaryContinuityRow from={String(segment.id)} to={String(next.id)} fromLabel={display.clip(String(segment.id))} toLabel={display.clip(String(next.id))} boundary={boundaries.find(row => row.from === segment.id && row.to === next.id)} disabled={busy || !editable || sourceConflict || snapshotLoading} onSave={onBoundary} summary={<div className="space-y-2 text-xs text-muted-foreground"><div className="flex flex-wrap items-center gap-2"><span>{fromShot ? display.target(String(fromShot.id)) : display.clip(String(segment.id))} → {toShot ? display.target(String(toShot.id)) : display.clip(String(next.id))}</span><Tag color={unknown ? "gold" : differences.length ? "red" : "green"}>{t("director.workspace.continuity.crud.ledgerState")} · {unknown ? t("director.workspace.continuity.stateUnknown") : differences.length ? t("director.workspace.continuity.stateDifference") : t("director.workspace.continuity.stateContinuous")}</Tag></div>{differences.length > 0 && <p>{differences.map(key => `${display.fact(key)}：${display.value(key, left[key])} → ${display.value(key, right[key])}`).join(" · ")}</p>}</div>} />
      </div>;
    })}</div>}
    {!legacy && editable && activeView !== "workbench" && <details open={manualOpen} onToggle={event => setManualOpen(event.currentTarget.open)} className="border-t border-border pt-4"><summary className="cursor-pointer text-sm font-medium">{t("director.workspace.continuity.manualEditing")}</summary><div className="mt-4 space-y-4"><div><h3 className="font-medium">{t("director.workspace.continuity.timelineAndFacts")}</h3><p className="mt-1 text-xs text-muted-foreground">{t("director.workspace.continuity.factsHelper")}</p></div>
      <div className="grid gap-4 lg:grid-cols-2">
<fieldset className="min-w-0 space-y-3 rounded-lg border border-border p-4" data-continuity-form-group="timelines"><legend className="px-1 text-sm font-medium">{t("director.micro.continuityTimelines")}</legend><div className="grid gap-3"><Input aria-label={t("director.crud.timelineName")} placeholder={t("director.crud.timelineName")} value={newTimelineName} onChange={event => setNewTimelineName(event.target.value)} />
<Button disabled={busy || !newTimelineName.trim()} onClick={addTimeline}>{t("director.workspace.continuity.addTimeline")}</Button></div></fieldset>
<fieldset className="min-w-0 space-y-3 rounded-lg border border-border p-4" data-continuity-form-group="facts"><legend className="px-1 text-sm font-medium">{t("director.micro.continuityFacts")}</legend><div className="grid gap-3"><Select aria-label={t("director.workspace.continuity.objectKind")} value={objectKind} options={["character", "scene", "asset"].map(value => ({ value, label: t(`director.workspace.continuity.objectKindValue.${value}`) }))} onChange={value => { setObjectKind(value); setObjectId(""); }} />
<Select aria-label={t("director.workspace.continuity.objectId")} value={objectId || undefined} placeholder={t("director.workspace.continuity.objectId")} options={availableObjects.map(row => ({ value: String(row.id || row.asset_id), label: String(row.name || row.asset_name || row.title || row.scene_name || t("director.crud.unnamedEntity")) }))} onChange={setObjectId} />
<Input aria-label={t("director.crud.factName")} placeholder={t("director.crud.factName")} value={newFactId} onChange={event => setNewFactId(event.target.value)} />
<Input aria-label={t("director.workspace.continuity.allowedValues")} placeholder={t("director.workspace.continuity.allowedValues")} value={factValues} onChange={event => setFactValues(event.target.value)} />
<p className="text-xs text-muted-foreground">{t("director.workspace.continuity.crud.valuesHint")}</p><Button disabled={busy || !objectId || !newFactId.trim() || !normalizedContinuityValues(factValues).length} onClick={addFact}>{t("director.workspace.continuity.addFact")}</Button></div></fieldset>
<section className="space-y-3 bg-muted/30 p-4 lg:col-span-2" data-continuity-form-group="context"><h3 className="text-sm font-medium">{t("director.micro.continuityContext")}</h3><p className="text-xs text-muted-foreground">{t("director.micro.continuityContextHint")}</p><div className="grid gap-3 sm:grid-cols-2"><Select aria-label={t("director.workspace.continuity.selectTimeline")} value={timelineId || undefined} placeholder={t("director.workspace.continuity.selectTimeline")} options={timeRows.map(row => ({ value: row.id, label: display.timeline(row.id) }))} onChange={setTimelineId} /><Select aria-label={t("director.workspace.continuity.selectFact")} value={factId || undefined} placeholder={t("director.workspace.continuity.selectFact")} options={factRows.map(row => ({ value: row.id, label: display.fact(row.id) }))} onChange={changeFact} /></div></section>
<fieldset className="min-w-0 space-y-3 rounded-lg border border-border p-4" data-continuity-form-group="initial"><legend className="px-1 text-sm font-medium">{t("director.workspace.continuity.initialValue")}</legend><div className="grid gap-3"><Select aria-label={t("director.workspace.continuity.initialValue")} value={initialValue || undefined} placeholder={t("director.workspace.continuity.initialValue")} options={[...(factRows.find(row => row.id === factId)?.allowed_values || []), "unknown"].map(value => ({ value, label: display.value(factId, value) }))} onChange={setInitialValue} />
<Button disabled={busy || !timelineId || !factId || !initialValue} onClick={addInitial}>{t("director.workspace.continuity.setInitial")}</Button></div></fieldset>
<fieldset className="min-w-0 space-y-3 rounded-lg border border-border p-4" data-continuity-form-group="coverage"><legend className="px-1 text-sm font-medium">{t("director.micro.continuityEvidence")}</legend><div className="grid gap-3"><Select aria-label={t("director.workspace.continuity.shot")} value={shotId || undefined} placeholder={t("director.workspace.continuity.shot")} options={relevantShots.map(row => ({ value: row.id, label: display.target(row.id) }))} onChange={value => { setShotId(value); const shot = shots.find(row => row.id === value); setSourceBlockId(continuityDefaultEvidenceBlockId(continuityBlocksForShot({ ...source, script_scenes: scenes, shots }, sourceBlocks, shot))); setEventFrame(subjectAssembly ? "0" : String(shot?.start_frame ?? "")); }} />
<Select aria-label={t("director.workspace.continuity.sourceBlock")} value={sourceBlockId || undefined} placeholder={t("director.workspace.continuity.sourceBlock")} options={blocksForShot.map(row => ({ value: row.id, label: display.source(row.id) }))} onChange={setSourceBlockId} />
<Button disabled={busy || !timelineId || !shotId || !factId || !sourceBlockId} onClick={() => void addHold()}>{t("director.workspace.continuity.addHold")}</Button></div></fieldset>
<fieldset className="min-w-0 space-y-3 rounded-lg border border-border p-4" data-continuity-form-group="events"><legend className="px-1 text-sm font-medium">{t("director.workspace.continuity.addChange")}</legend><div className="grid gap-3"><Input value={eventFrame} type="number" aria-label={t(subjectAssembly ? "director.atomic.localEventFrame" : "director.workspace.continuity.eventFrame")} placeholder={t(subjectAssembly ? "director.atomic.localEventFrame" : "director.workspace.continuity.eventFrame")} onChange={event => setEventFrame(event.target.value)} />
<Select aria-label={t("director.workspace.continuity.eventAfter")} value={eventAfter || undefined} placeholder={t("director.workspace.continuity.eventAfter")} options={[...new Set([...(factRows.find(row => row.id === factId)?.allowed_values || []), "unknown"])].map((value: string) => ({ value, label: display.value(factId, value) }))} onChange={setEventAfter} />
<Input value={eventReason} aria-label={t("director.workspace.continuity.eventReason")} placeholder={t("director.workspace.continuity.eventReason")} onChange={event => setEventReason(event.target.value)} />
<Button disabled={busy || !timelineId || !shotId || !factId || !eventAfter || !eventReason.trim()} onClick={() => void addEvent()}>{t("director.workspace.continuity.addChange")}</Button></div></fieldset>
<fieldset className="min-w-0 space-y-3 rounded-lg border border-border p-4" data-continuity-form-group="exemptions"><legend className="px-1 text-sm font-medium">{t("director.workspace.continuity.markReviewed")}</legend><div className="grid gap-3"><Input value={exemptionReason} aria-label={t("director.workspace.continuity.exemptionReason")} placeholder={t("director.workspace.continuity.exemptionReason")} onChange={event => setExemptionReason(event.target.value)} />
<Input value={reviewRef} aria-label={t("director.workspace.continuity.reviewRef")} placeholder={t("director.workspace.continuity.reviewRef")} onChange={event => setReviewRef(event.target.value)} />
<Button disabled={busy || !exemptionReason.trim() || !reviewRef.trim()} onClick={() => void addExemption()}>{t("director.workspace.continuity.markReviewed")}</Button></div></fieldset>
</div>
      <p className="text-xs text-muted-foreground">{t("director.workspace.continuity.ledgerCount", { facts: factRows.length, events: ledger.events?.length || 0, coverage: ledger.coverage?.length || 0 })}</p>
    </div></details>}
  </section>;
}
