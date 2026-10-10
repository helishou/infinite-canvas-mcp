import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Input, message, Select, Switch, Tag } from "antd";
import { useTranslation } from "react-i18next";
import type { ProductionContinuity } from "@/services/backend-api";
import { useAgentStore } from "@/stores/use-agent-store";
import { continuityPresentation } from "./continuity-presentation";
import { continuityEventAnchor, continuityEventFrame } from "./continuity-event-anchor";
import { readContinuityLedgerDraft, rebaseContinuityLedger, continuityLedgerConflicts } from "./continuity-ledger-draft";

type Row = Record<string, any>;
const blankLedger = () => ({ contract_version: 2, facts: [], timelines: [], initial: [], events: [], requirements: [], coverage: [] });
const id = () => `C_${crypto.randomUUID()}`;
const stable = (value: any): string => Array.isArray(value) ? `[${value.map(stable).join(",")}]` : value && typeof value === "object" ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}` : JSON.stringify(value);
function ledgerV2FromAgent(text: string): Row | null {
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map(match => match[1]);
  for (const candidate of [...fenced.reverse(), text]) {
    try {
      const value = JSON.parse(candidate.trim());
      if (value && typeof value === "object" && value.contract_version === 2 && ["facts", "timelines", "initial", "events", "requirements", "coverage"].every(key => Array.isArray(value[key]))) return value;
    } catch { /* Check the next fenced block or the complete message. */ }
  }
  return null;
}
async function sourceDigest(sceneId: string, block: Row) {
  const bytes = new TextEncoder().encode(stable({ scene_id: sceneId, block }));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map(value => value.toString(16).padStart(2, "0")).join("");
}

function BoundaryContinuityRow({ from, to, fromLabel, toLabel, boundary, disabled, onSave }: { from: string; to: string; fromLabel: string; toLabel: string; boundary?: Row; disabled: boolean; onSave: (value: Row) => void }) {
  const { t } = useTranslation();
  const [tailFrame, setTailFrame] = useState(Boolean(boundary?.tailFrame));
  const [motionContext, setMotionContext] = useState(Boolean(boundary?.motionContext));
  const [reason, setReason] = useState(String(boundary?.reason || ""));
  useEffect(() => { setTailFrame(Boolean(boundary?.tailFrame)); setMotionContext(Boolean(boundary?.motionContext)); setReason(String(boundary?.reason || "")); }, [from, to, boundary?.tailFrame, boundary?.motionContext, boundary?.reason]);
  return <article className="space-y-3 rounded-xl border border-border p-3"><div className="flex flex-wrap items-center justify-between gap-2"><strong>{fromLabel} → {toLabel}</strong>{!boundary && <Tag color="orange">{t("director.workspace.continuity.stateUnknown")}</Tag>}</div>
    <div className="grid gap-2 sm:grid-cols-2"><label className="flex items-center justify-between rounded-lg border border-border p-2 text-sm">{t("director.workspace.tailFrame")}<Switch checked={tailFrame} disabled={disabled} onChange={setTailFrame} /></label><label className="flex items-center justify-between rounded-lg border border-border p-2 text-sm">{t("director.workspace.motionContext")}<Switch checked={motionContext} disabled={disabled} onChange={setMotionContext} /></label></div>
    <Input.TextArea value={reason} disabled={disabled} placeholder={t("director.workspace.continuityReason")} autoSize={{ minRows: 2, maxRows: 4 }} onChange={event => setReason(event.target.value)} />
    <Button size="small" disabled={disabled || !reason.trim() || boundary?.tailFrame === tailFrame && boundary?.motionContext === motionContext && boundary?.reason === reason.trim()} onClick={() => onSave({ from, to, tailFrame, motionContext, reason: reason.trim() })}>{t("director.workspace.saveBoundary")}</Button>
  </article>;
}

export function ContinuityPanel({ ledger: savedLedger, sourceHash, subjectAssembly = false, draftValue, onDraftChange, scenes, locations = [], shots, segments, boundaries, characters, assets, report, workId, agentThreadId, busy, editable, onSave, onPreviewUpgrade, onCheck, onLocate, onAskDirector, onRequestAgentUpgrade, onBoundary, onSnapshot }: {
  ledger?: Row; sourceHash: string; scenes: Row[]; locations?: Row[]; shots: Row[]; segments: Row[]; boundaries: Row[]; characters: Row[]; assets: Row[]; report?: ProductionContinuity;
  workId?: string; agentThreadId?: string;
  subjectAssembly?: boolean;
  draftValue?: string; onDraftChange?: (value: string | undefined) => void;
  busy: boolean; editable: boolean; onSave: (ledger: Row, upgradePreview?: Row) => Promise<boolean>; onPreviewUpgrade: (ledger: Row, fromSourceHash: string) => Promise<Row>; onCheck: () => Promise<void>; onLocate: (kind: string, id: string) => void; onAskDirector?: (scope: { workspace: "continuity"; targetId?: string; workId?: string; instruction: string }) => void; onRequestAgentUpgrade?: (instruction: string, workId?: string) => Promise<{ id: string; threadId?: string } | undefined>; onBoundary: (value: Row) => void; onSnapshot?: (value: "draft" | "published") => void;
}) {
  const { t } = useTranslation();
  const legacy = Boolean(savedLedger && savedLedger.contract_version !== 2);
  const formalLedger = savedLedger?.contract_version === 2 ? savedLedger : blankLedger();
  const retained = readContinuityLedgerDraft(subjectAssembly ? draftValue : undefined, formalLedger);
  const baselineLedger = useRef(retained.base);
  const [invalidLedgerDraft, setInvalidLedgerDraft] = useState(retained.invalid);
  const [ledger, setLedger] = useState<Row>(retained.value);
  const [sourceConflict, setSourceConflict] = useState(stable(retained.base) !== stable(formalLedger) && stable(retained.value) !== stable(formalLedger));
  const savedLedgerKey = savedLedger?.contract_version === 2 ? stable(savedLedger) : "legacy";
  const previousSource = useRef({ sourceHash, ledgerKey: savedLedgerKey });
  const [activeView, setActiveView] = useState<"ledger" | "issues" | "timeline" | "boundaries">("ledger");
  const [ledgerCategory, setLedgerCategory] = useState("facts");
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
  const [draftText, setDraftText] = useState("");
  const [draftError, setDraftError] = useState("");
  const [proposedLedger, setProposedLedger] = useState<Row | null>(null);
  const [upgradePreview, setUpgradePreview] = useState<Row | null>(null);
  const [agentUpgradeRequest, setAgentUpgradeRequest] = useState<{ id: string; threadId: string; baselineIds: string[]; sourceHash: string } | null>(null);
  const [agentUpgradeStarting, setAgentUpgradeStarting] = useState(false);
  const agentUpgradeProcessing = useRef("");
  const agentMessages = useAgentStore(state => state.messages);
  const agentBusy = useAgentStore(state => state.sending || state.waiting || ["preparing", "running"].includes(state.conversation.status));
  const agentTaskResult = useAgentStore(state => state.scopedTaskResult);

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
  const ledgerKey = stable(ledger);
  useEffect(() => {
    if (!subjectAssembly || !editable || !onDraftChange || invalidLedgerDraft) return;
    const next = ledgerKey === savedLedgerKey ? undefined : JSON.stringify({ version: 1, base: baselineLedger.current, value: ledger });
    if (next !== draftValue) onDraftChange(next);
  }, [ledgerKey, savedLedgerKey, subjectAssembly, editable, invalidLedgerDraft, draftValue, onDraftChange]);
  const saveLedger = () => { if (!busy && !sourceConflict && !invalidLedgerDraft) void onSave(ledger); };
  useEffect(() => { setProposedLedger(null); setUpgradePreview(null); setAgentUpgradeRequest(null); agentUpgradeProcessing.current = ""; }, [sourceHash]);

  const sourceBlocks: Row[] = useMemo(() => scenes.flatMap(scene => (Array.isArray(scene.blocks) ? scene.blocks : []).map((block: Row) => ({ sceneId: String(scene.scene_id || scene.id), sceneName: String(scene.scene_name || scene.heading || scene.id), sourceBlock: block, ...block }))), [stable(scenes)]);
  const factRows = Array.isArray(ledger.facts) ? ledger.facts as Row[] : [];
  const timeRows = Array.isArray(ledger.timelines) ? ledger.timelines as Row[] : [];
  const relevantShots = shots.filter(shot => !timelineId || shot.timeline_id === timelineId);
  const availableObjects = objectKind === "character" ? characters : objectKind === "scene" ? scenes : assets;
  const blocksForShot = sourceBlocks.filter(block => !shotId || shots.find(shot => shot.id === shotId)?.scene_id === block.sceneId);
  const append = (collection: string, row: Row) => setLedger(current => ({ ...current, [collection]: [...(Array.isArray(current[collection]) ? current[collection] : []), row] }));
  const removeEntry = (collection: string, index: number) => setLedger(current => ({ ...current, [collection]: (Array.isArray(current[collection]) ? current[collection] as Row[] : []).filter((_, rowIndex) => rowIndex !== index) }));
  const appendCoverage = (row: Row) => setLedger(current => {
    const existing = Array.isArray(current.coverage) ? current.coverage as Row[] : [];
    const prior = existing.find(item => item.source_anchor?.block_id === row.source_anchor?.block_id && item.timeline_id === row.timeline_id && item.evidence_kind === row.evidence_kind);
    if (!prior) return { ...current, coverage: [...existing, row] };
    const merged = { ...prior };
    for (const key of ["fact_ids", "event_ids", "shot_ids"] as const) merged[key] = [...new Set([...(prior[key] || []), ...(row[key] || [])])];
    return { ...current, coverage: existing.map(item => item.id === prior.id ? merged : item) };
  });
  const changeFact = (nextId: string) => { setFactId(nextId); const fact = factRows.find(item => item.id === nextId); setEventAfter(fact?.allowed_values?.[0] || ""); };
  const addTimeline = () => { if (!newTimelineName.trim()) return; const timeline = id(); append("timelines", { id: timeline, display_name: newTimelineName.trim() }); setTimelineId(timeline); setNewTimelineName(""); };
  const addFact = () => {
    const allowed = factValues.split(/[,，\n]/).map(value => value.trim()).filter(Boolean);
    if (!newFactId.trim() || !objectId || !allowed.length) return;
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
    if (!timelineId || !factId || !shotId || !sourceBlockId) return;
    const shot = shots.find(row => row.id === shotId), source = sourceBlocks.find(row => row.id === sourceBlockId);
    if (!shot || !source || !initial.some((row: Row) => row.timeline_id === timelineId && row.fact_id === factId)) return;
    let current;
    try { current = continuityEventAnchor(ledger, shots, shotId, factId, subjectAssembly ? 0 : Number(shot.start_frame), subjectAssembly).before; }
    catch (error) { message.error(t("director.atomic.eventError." + (error instanceof Error ? error.message : "EVENT_INITIAL_STATE_MISSING"))); return; }
    const requirementId = id();
    append("requirements", { id: requirementId, timeline_id: timelineId, shot_id: shotId, fact_id: factId, kind: "hold", value: current, source_anchor: { block_id: sourceBlockId } });
    appendCoverage({ id: id(), timeline_id: timelineId, source_anchor: { block_id: sourceBlockId }, source_digest: await sourceDigest(source.sceneId, source.sourceBlock), evidence_kind: "explicit_hold", fact_ids: [factId], event_ids: [], shot_ids: [shotId] });
  };
  const addEvent = async () => {
    const shot = shots.find(row => row.id === shotId), source = sourceBlocks.find(row => row.id === sourceBlockId), fact = factRows.find(row => row.id === factId);
    if (!shot || !source || !fact || !timelineId || !eventReason.trim() || !eventAfter || !fact.allowed_values.includes(eventAfter)) return;
    let state;
    try {
      if (!eventFrame.trim()) throw new Error("INVALID_EVENT_FRAME");
      state = continuityEventAnchor(ledger, shots, shotId, factId, Number(eventFrame), subjectAssembly);
    } catch (error) { message.error(t("director.atomic.eventError." + (error instanceof Error ? error.message : "INVALID_EVENT_FRAME"))); return; }
    const eventId = id();
    append("events", { id: eventId, timeline_id: timelineId, fact_id: factId, shot_id: shotId, ...state.anchor, before: state.before, after: eventAfter, reason: eventReason.trim(), source_anchor: { block_id: sourceBlockId } });
    append("requirements", { id: id(), timeline_id: timelineId, shot_id: shotId, fact_id: factId, kind: "change", event_ids: [eventId], source_anchor: { block_id: sourceBlockId } });
    appendCoverage({ id: id(), timeline_id: timelineId, source_anchor: { block_id: sourceBlockId }, source_digest: await sourceDigest(source.sceneId, source.sourceBlock), evidence_kind: "explicit_change", fact_ids: [factId], event_ids: [eventId], shot_ids: [shotId] });
  };
  const addExemption = async () => {
    const source = sourceBlocks.find(row => row.id === sourceBlockId);
    if (!source || !shotId || exemptionReason.trim().length < 8 || !reviewRef.trim()) return;
    appendCoverage({ id: id(), timeline_id: timelineId, source_anchor: { block_id: sourceBlockId }, source_digest: await sourceDigest(source.sceneId, source.sourceBlock), evidence_kind: "not_applicable_with_rule", fact_ids: [], event_ids: [], shot_ids: [shotId], rule: "dialogue_without_state_change", reason: exemptionReason.trim(), review_ref: reviewRef.trim() });
  };
  const saveJson = async () => {
    try {
      const parsed = JSON.parse(draftText);
      if (parsed.contract_version !== 2) throw new Error(t("director.workspace.continuity.ledgerV2Required"));
      setDraftError("");
      setProposedLedger(parsed);
      setUpgradePreview(await onPreviewUpgrade(parsed, sourceHash));
    } catch (error) { setDraftError(String(error)); }
  };
  const applyUpgrade = async () => {
    if (!proposedLedger || !upgradePreview || !await onSave(proposedLedger, upgradePreview)) return;
    setLedger(proposedLedger); setDraftText(""); setProposedLedger(null); setUpgradePreview(null);
  };
  const requestAgentUpgrade = async () => {
    if (!onRequestAgentUpgrade || busy || agentUpgradeRequest || agentUpgradeStarting) return;
    const agent = useAgentStore.getState();
    if (agent.sending || agent.waiting || ["preparing", "running"].includes(agent.conversation.status)) {
      message.warning(t("director.workspace.agentBusy"));
      return;
    }
    const expectedThreadId = agentThreadId || agent.activeThreadId || agent.conversation.threadId;
    const initialBaseline = agent.messages.filter(item => item.role === "assistant").map(item => item.id);
    setAgentUpgradeStarting(true); setDraftError(""); setProposedLedger(null); setUpgradePreview(null);
    try {
      const task = await onRequestAgentUpgrade(t("director.workspace.continuity.upgradeAgentPrompt"), workId);
      if (!task) return;
      const threadId = task.threadId || expectedThreadId;
      if (!threadId) { setDraftError(t("director.workspace.continuity.upgradeAgentJsonMissing")); return; }
      const baselineIds = threadId === expectedThreadId ? initialBaseline : useAgentStore.getState().messages.filter(item => item.role === "assistant").map(item => item.id);
      setAgentUpgradeRequest({ id: task.id, threadId, baselineIds, sourceHash });
    } catch (error) { setDraftError(error instanceof Error ? error.message : String(error)); }
    finally { setAgentUpgradeStarting(false); }
  };
  useEffect(() => {
    const request = agentUpgradeRequest;
    if (!request || agentBusy || agentUpgradeProcessing.current === request.id) return;
    if (request.sourceHash !== sourceHash) { setAgentUpgradeRequest(null); setDraftError(t("director.workspace.continuity.sourceConflict")); return; }
    const responses = agentMessages.filter(item => item.role === "assistant" && (!item.threadId || item.threadId === request.threadId) && !request.baselineIds.includes(item.id));
    const result = [...responses].reverse().map(item => ledgerV2FromAgent(item.text)).find((value): value is Row => Boolean(value));
    if (!result) {
      if (agentTaskResult?.id === request.id && agentTaskResult.status === "failed") {
        setAgentUpgradeRequest(null); setDraftError(agentTaskResult.error || t("director.workspace.agentTaskFailed"));
      } else if (responses.length) {
        setAgentUpgradeRequest(null); setDraftError(t("director.workspace.continuity.upgradeAgentJsonMissing"));
      }
      return;
    }
    agentUpgradeProcessing.current = request.id;
    setDraftText(JSON.stringify(result, null, 2)); setProposedLedger(result); setDraftError("");
    void onPreviewUpgrade(result, request.sourceHash).then(preview => {
      if (agentUpgradeProcessing.current === request.id) setUpgradePreview(preview);
    }).catch(error => {
      if (agentUpgradeProcessing.current === request.id) setDraftError(error instanceof Error ? error.message : String(error));
    }).finally(() => {
      if (agentUpgradeProcessing.current === request.id) { agentUpgradeProcessing.current = ""; setAgentUpgradeRequest(null); }
    });
  }, [agentUpgradeRequest, agentBusy, agentMessages, agentTaskResult, onPreviewUpgrade, sourceHash, t]);
  const issues = report?.report?.diagnostics || report?.items || [];
  const timeline = report?.report?.trajectories || {};
  const initial = Array.isArray(ledger.initial) ? ledger.initial : [];
  const ledgerSections = (["facts", "timelines", "initial", "events", "requirements", "coverage"] as const).map(collection => ({ collection, rows: Array.isArray(ledger[collection]) ? ledger[collection] as Row[] : [] }));
  const display = continuityPresentation({ facts: factRows, timelines: timeRows, scenes, locations, characters, assets, shots, segments, sourceBlocks }, (key, values) => t(`director.workspace.continuity.${key}`, values));
  const stateLabel = report?.status || "unchecked";
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
    return <article key={`${collection}:${row.id || index}`} className="min-w-0 rounded-xl border border-border p-4" data-continuity-entry={collection}>
      <div className="flex flex-wrap items-center justify-between gap-2"><h4 className="text-sm font-semibold">{title}</h4>{collection === "facts" ? <span className="text-xs text-muted-foreground">{t(`director.workspace.continuity.objectKindValue.${row.object_kind}`, { defaultValue: t("director.workspace.continuity.objectKindValue.asset") })}</span> : row.timeline_id ? <span className="text-xs text-muted-foreground">{display.timeline(row.timeline_id)}</span> : null}</div>
      {collection === "facts" && <><label className="mt-3 grid gap-1 text-xs"><span>{t("director.crud.factName")}</span><Input value={row.display_name || row.name || ""} disabled={busy || !editable || sourceConflict} onChange={event => setLedger(current => ({ ...current, facts: current.facts.map((fact: Row) => fact.id === row.id ? { ...fact, display_name: event.target.value } : fact) }))} /></label>
        {subjectAssembly && editable && <div className="mt-3 space-y-2">{(row.allowed_values || []).map((value: string) => <label key={value} className="grid gap-1 text-xs text-muted-foreground"><span>{t("director.atomic.stateDescription", { value: display.value(row.id, value) })}</span><Input.TextArea value={row.value_descriptions?.[value] || ""} disabled={busy || sourceConflict} autoSize={{ minRows: 1, maxRows: 4 }} onChange={event => setLedger(current => ({ ...current, facts: current.facts.map((fact: Row) => fact.id === row.id ? { ...fact, value_descriptions: { ...fact.value_descriptions, [value]: event.target.value } } : fact) }))} /></label>)}</div>}
        <div className="mt-3 space-y-3">{initial.filter((state: Row) => state.fact_id === row.id).map((state: Row, stateIndex: number) => <div key={stateIndex}><p className="text-xs text-muted-foreground">{display.timeline(state.timeline_id)} · {t("director.workspace.continuity.initialValue")}</p><p className="mt-1 break-words text-sm leading-relaxed">{display.value(row.id, state.value)}</p></div>)}{!initial.some((state: Row) => state.fact_id === row.id) && <p className="text-sm text-muted-foreground">{t("director.workspace.continuity.initialMissing")}</p>}</div>
        <details className="mt-3"><summary className="cursor-pointer text-xs text-muted-foreground">{t("director.workspace.continuity.availableStates", { count: row.allowed_values?.length || 0 })}</summary><ul className="mt-2 list-disc space-y-1.5 pl-5 text-sm leading-relaxed">{(row.allowed_values || []).map((value: string) => <li key={value} className="break-words">{display.value(row.id, value)}</li>)}</ul></details>
      </>}
      {collection === "timelines" && <p className="mt-2 text-sm text-muted-foreground">{t("director.workspace.continuity.timelineSummary", { facts: initial.filter((state: Row) => state.timeline_id === row.id).length, events: (ledger.events || []).filter((event: Row) => event.timeline_id === row.id).length })}</p>}
      {collection === "initial" && <p className="mt-2 break-words text-sm leading-relaxed">{display.value(row.fact_id, row.value)}</p>}
      {collection === "events" && <><p className="mt-2 text-xs text-muted-foreground">{display.target(row.shot_id)} · {t("director.workspace.continuity.atFrame", { frame: continuityEventFrame(row, shots) })}</p>{stateChange(row.fact_id, row.before, row.after)}{(row.display_reason || row.reason) && <p className="mt-3 break-words text-sm text-muted-foreground">{row.display_reason || row.reason}</p>}</>}
      {collection === "requirements" && <><p className="mt-2 text-xs text-muted-foreground">{display.target(row.shot_id)} · {t(`director.workspace.continuity.requirementKind.${row.kind}`, { defaultValue: t("director.workspace.continuity.otherRequirement") })}</p>{row.value !== undefined && <p className="mt-2 break-words text-sm">{display.value(row.fact_id, row.value)}</p>}{(row.event_ids || []).map((eventId: string) => { const event = (ledger.events || []).find((item: Row) => item.id === eventId); return event ? <div key={eventId}>{stateChange(row.fact_id, event.before, event.after)}</div> : <p key={eventId} className="mt-2 text-sm text-muted-foreground">{t("director.workspace.continuity.missingEvent")}</p>; })}</>}
      {collection === "coverage" && <><p className="mt-2 text-sm">{t(`director.workspace.continuity.coverageKind.${row.evidence_kind}`, { defaultValue: t("director.workspace.continuity.otherCoverage") })}</p>{row.fact_ids?.length > 0 && <p className="mt-2 text-xs text-muted-foreground">{row.fact_ids.map((factId: string) => display.fact(factId)).join(" · ")}</p>}{row.shot_ids?.length > 0 && <p className="mt-1 text-xs text-muted-foreground">{row.shot_ids.map((shotId: string) => display.target(shotId)).join(" · ")}</p>}{(row.display_reason || row.reason) && <p className="mt-2 break-words text-sm text-muted-foreground">{row.display_reason || row.reason}</p>}</>}
      {sourceId && <p className="mt-3 break-words border-t border-border pt-3 text-xs leading-relaxed text-muted-foreground">{t("director.workspace.continuity.scriptEvidence")}: {display.source(sourceId)}</p>}
      <details className="mt-3"><summary className="cursor-pointer text-xs text-muted-foreground">{t("director.workspace.continuity.technicalDetails")}</summary><pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-muted/30 p-3 text-xs">{JSON.stringify(row, null, 2)}</pre>{editable && !legacy && <Button danger size="small" disabled={busy} onClick={() => removeEntry(collection, index)}>{t("director.workspace.continuity.removeEntry")}</Button>}</details>
    </article>;
  };

  return <section className="space-y-5" data-continuity-workspace>
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-xl font-semibold">{t("director.workspace.tab.continuity")}</h2><p className="mt-1 text-sm text-muted-foreground">{t("director.workspace.continuity.semanticLimit")}</p><p className="mt-2 text-xs text-muted-foreground">{t("director.workspace.continuity.lastChecked")}: {report?.checkedAt ? new Date(report.checkedAt).toLocaleString() : t("director.workspace.continuity.neverChecked")} · {t("director.workspace.continuity.scopeCount", { count: report?.report?.selectedTargets?.length || 0 })}</p></div><div className="flex items-center gap-2"><Select aria-label={t("director.workspace.continuity.snapshot")} value={report?.snapshot || "draft"} options={[{ value: "draft", label: t("director.workspace.continuity.snapshotDraft") }, { value: "published", label: t("director.workspace.continuity.snapshotPublished") }]} onChange={value => onSnapshot?.(value)} /><Tag color={stateLabel === "passed" ? "green" : ["blocked", "stale"].includes(stateLabel) ? "red" : "gold"}>{t(`director.workspace.continuity.status.${stateLabel}`)}</Tag><Button loading={busy} onClick={() => void onCheck()}>{t("director.workspace.continuity.check")}</Button></div></div>
    {legacy && <Alert type="warning" showIcon message={t("director.workspace.continuity.legacyReadOnly")} description={t("director.workspace.continuity.legacyUpgradeHint")} />}
    {sourceConflict && <Alert type="warning" showIcon message={t("director.workspace.continuity.sourceConflict")} description={<details><summary>{t("director.atomic.reviewCurrentSource")}</summary><pre className="max-h-64 overflow-auto whitespace-pre-wrap text-xs">{JSON.stringify(formalLedger, null, 2)}</pre><Button disabled={busy} size="small" onClick={() => { try { setLedger(rebaseContinuityLedger(baselineLedger.current, ledger, formalLedger)); baselineLedger.current = structuredClone(formalLedger); setSourceConflict(false); } catch { message.error(t("director.atomic.ledgerIdsMissing")); } }}>{t("director.atomic.keepReviewedDraft")}</Button></details>} />}
    {invalidLedgerDraft && <Alert type="warning" showIcon message={t("director.atomic.invalidDraft")} description={<details><summary>{t("director.atomic.reviewDraft")}</summary><pre className="max-h-48 overflow-auto whitespace-pre-wrap text-xs">{draftValue}</pre><Button disabled={busy} size="small" onClick={() => { baselineLedger.current = structuredClone(formalLedger); setLedger(structuredClone(formalLedger)); setInvalidLedgerDraft(false); setSourceConflict(false); onDraftChange?.(undefined); }}>{t("director.atomic.resetDraft")}</Button></details>} />}
    {!editable && <Alert type="info" showIcon message={t("director.workspace.continuity.publishedReadOnly")} />}
    {report?.report?.semanticDiscovery === "not_performed" && <p className="rounded-lg border border-border px-3 py-2 text-xs text-muted-foreground">{t("director.workspace.continuity.registeredCoverageOnly")}</p>}
    <nav className="flex flex-wrap gap-2" aria-label={t("director.workspace.continuity.views")}>{(["ledger", "issues", "timeline", "boundaries"] as const).map(view => <Button key={view} size="small" type={activeView === view ? "primary" : "default"} onClick={() => setActiveView(view)}>{t(`director.workspace.continuity.view.${view}`)}{view === "issues" && issues.length > 0 ? ` · ${issues.length}` : ""}</Button>)}</nav>
    {activeView === "ledger" && <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-sm text-muted-foreground">{t("director.workspace.continuity.readableLedgerHint")}</p>{!legacy && editable && <Button type="primary" disabled={busy || sourceConflict || invalidLedgerDraft} onClick={saveLedger}>{t("director.workspace.continuity.saveLedger")}</Button>}</div>
      <nav className="flex flex-wrap gap-1" aria-label={t("director.workspace.continuity.registeredEntries")}>{ledgerSections.map(({ collection, rows }) => <Button key={collection} type="text" size="small" className={ledgerCategory === collection ? "bg-muted font-medium" : "text-muted-foreground"} aria-pressed={ledgerCategory === collection} onClick={() => setLedgerCategory(collection)}>{t(`director.workspace.continuity.entryType.${collection}`)} <span className="ml-1 text-muted-foreground">{rows.length}</span></Button>)}</nav>
      <div className="grid gap-3 lg:grid-cols-2">{(ledgerSections.find(section => section.collection === ledgerCategory)?.rows || []).map((row, index) => entryCard(ledgerCategory, row, index))}</div>
      {!(ledgerSections.find(section => section.collection === ledgerCategory)?.rows.length) && <p className="py-6 text-sm text-muted-foreground">{t("director.workspace.continuity.emptyEntries")}</p>}
    </div>}
    {activeView === "issues" && <div className="space-y-3"><div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4"><Select aria-label={t("director.workspace.continuity.filterScene")} value={filterScene} options={[{ value: "all", label: t("director.workspace.continuity.filterAllScenes") }, ...sceneIds.map(value => ({ value, label: display.scene(value) }))]} onChange={setFilterScene} /><Select aria-label={t("director.workspace.continuity.filterTarget")} value={filterTarget} options={[{ value: "all", label: t("director.workspace.continuity.filterAllTargets") }, ...targetOptions]} onChange={setFilterTarget} /><Select aria-label={t("director.workspace.continuity.filterObject")} value={filterObject} options={[{ value: "all", label: t("director.workspace.continuity.filterAllObjects") }, ...objectOptions]} onChange={setFilterObject} /><Select aria-label={t("director.workspace.continuity.filterCategory")} value={filterCategory} options={[{ value: "all", label: t("director.workspace.continuity.filterAllCategories") }, ...issueCategories.map(value => ({ value, label: t(`director.workspace.continuity.issueCategory.${value}`, { defaultValue: t("director.workspace.continuity.issueCategory.OTHER") }) }))]} onChange={setFilterCategory} /></div>{visibleIssues.length ? visibleIssues.map((issue, index) => { const targets = [...new Set([issue.targetId, ...(Array.isArray(issue.affectedTargets) ? issue.affectedTargets : [])].filter(Boolean).map(String))]; const fact = factRows.find(row => String(row.id) === String(issue.factId || "")); const sourceBlockId = String(issue.sourceBlockId || "") || String(issue.path || "").split(".blocks.")[1]?.split(".")[0]; const sourceBlock = sourceBlocks.find(block => String(block.id) === sourceBlockId); const displayValue = (value: unknown) => display.expected(String(issue.factId || ""), value); return <article key={`${issue.code}:${issue.targetId || ""}:${index}`} className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-border p-3"><div className="min-w-0"><div className="flex flex-wrap gap-2"><Tag color={issue.severity === "warning" ? "gold" : "red"}>{t(`director.workspace.continuity.issueCategory.${String(issue.code || "").split("_")[1]}`, { defaultValue: t("director.workspace.continuity.issueCategory.OTHER") })}</Tag>{fact && <Tag>{display.fact(fact.id)}</Tag>}{targets.map(target => <Tag key={target}>{display.target(target)}</Tag>)}</div><p className="mt-2 text-sm">{display.message(String(issue.display_message || issue.message || ""))}</p>{issue.expected !== undefined || issue.actual !== undefined ? <p className="mt-1 text-xs">{t("director.workspace.continuity.expectedActual", { expected: displayValue(issue.expected) ?? "—", actual: displayValue(issue.actual) ?? "—" })}</p> : null}{sourceBlock && <p className="mt-1 text-xs text-muted-foreground">{t("director.workspace.continuity.sourceEvidence", { block: display.scene(sourceBlock.sceneId), text: sourceBlock.sourceBlock.text || "" })}</p>}<details className="mt-3"><summary className="cursor-pointer text-xs text-muted-foreground">{t("director.workspace.continuity.technicalDetails")}</summary><pre className="mt-2 whitespace-pre-wrap break-all text-xs">{JSON.stringify(issue, null, 2)}</pre></details></div><div className="flex flex-wrap gap-1">{targets.map(target => <Button key={target} size="small" onClick={() => onLocate(segments.some(item => String(item.id) === target) ? "segment" : "shot", target)}>{t("director.workspace.continuity.locate")} · {display.target(target)}</Button>)}{onAskDirector && <Button size="small" disabled={busy || !editable} onClick={() => onAskDirector({
              workspace: "continuity", targetId: String(issue.targetId || targets[0] || ""), workId,
              instruction: `${t("director.workspace.continuity.handoffPrompt")}\n${JSON.stringify({ owner: report?.owner, workId, revision: report?.revision, publishedVersion: report?.publishedVersion, snapshot: report?.snapshot, sourceHash: report?.sourceHash, checkOperationId: report?.report?.operationId, issue: { code: issue.code, message: issue.message, path: issue.path, targetId: issue.targetId, affectedTargets: issue.affectedTargets, factId: issue.factId, expected: issue.expected, actual: issue.actual, sourceBlockId: issue.sourceBlockId }, sourceBlock: sourceBlock?.sourceBlock?.text }, null, 2)}`
            })}>{t("director.workspace.continuity.handoffToDirector")}</Button>}</div></article>; }) : <p className="rounded-xl border border-border p-4 text-sm text-muted-foreground">{visibleIssues.length === 0 && issues.length ? t("director.workspace.continuity.noFilterIssues") : t("director.workspace.continuity.noIssues")}</p>}</div>}
    {activeView === "timeline" && (() => {
      const entries = Object.entries(timeline) as Array<[string, Row]>;
      const selected = entries.find(([shotId]) => shotId === selectedTimelineShot) || entries[0];
      if (!selected) return <p className="py-6 text-sm text-muted-foreground">{t("director.workspace.continuity.timelineEmpty")}</p>;
      const [shotId, row] = selected;
      const changed = new Set([...Object.keys(row.start || {}), ...Object.keys(row.end || {})].filter(factId => row.start?.[factId] !== row.end?.[factId]));
      return <div className="grid items-start gap-4 lg:grid-cols-[220px_minmax(0,1fr)]"><nav className="max-h-64 overflow-y-auto rounded-xl border border-border lg:max-h-[70dvh]" aria-label={t("director.workspace.continuity.view.timeline")}>{entries.map(([id, item]) => <button type="button" key={id} aria-current={id === shotId ? "true" : undefined} onClick={() => setSelectedTimelineShot(id)} className={`block w-full border-b border-border px-3 py-3 text-left last:border-0 ${id === shotId ? "bg-muted" : "hover:bg-muted/40"}`}><span className="block truncate text-sm font-medium">{display.target(id)}</span><span className="mt-1 block truncate text-xs text-muted-foreground">{display.timeline(item.timelineId)}</span></button>)}</nav><article className="min-w-0 rounded-xl border border-border p-4"><div className="flex flex-wrap items-center justify-between gap-2"><div><strong className="text-sm">{display.target(shotId)}</strong><p className="mt-1 text-xs text-muted-foreground">{t("director.studio.changedStates", { count: changed.size })}</p></div><Button size="small" onClick={() => onLocate("shot", shotId)}>{t("director.workspace.continuity.locate")}</Button></div><div className="mt-4 grid gap-4 sm:grid-cols-2"><section className="min-w-0"><h3 className="text-xs font-medium text-muted-foreground">{t("director.workspace.continuity.startState")}</h3>{stateList(row.start, changed)}</section><section className="min-w-0 sm:border-l sm:border-border sm:pl-4"><h3 className="text-xs font-medium text-muted-foreground">{t("director.workspace.continuity.endState")}</h3>{stateList(row.end, changed)}</section></div></article></div>;
    })()}

    {activeView === "boundaries" && <div className="space-y-3">{segments.slice(0, -1).map((segment, index) => { const next = segments[index + 1]; const fromShot = shots.find(row => row.id === (segment.shot_ids || []).at(-1)); const toShot = shots.find(row => row.id === (next.shot_ids || [])[0]); const left = fromShot && timeline[String(fromShot.id)]?.end; const right = toShot && timeline[String(toShot.id)]?.start; const differences = left && right ? [...new Set([...Object.keys(left), ...Object.keys(right)])].filter(key => left[key] !== right[key]) : []; const title = (row: Row | undefined, fallback: string) => display.target(String(row?.id || fallback)); return <div key={`${segment.id}:${next.id}`} className="space-y-2"><article className="rounded-xl border border-border p-3"><div className="flex items-center justify-between"><strong>{title(fromShot, segment.id)} → {title(toShot, next.id)}</strong><Tag color={!left || !right ? "gold" : differences.length ? "red" : "green"}>{!left || !right ? t("director.workspace.continuity.stateUnknown") : differences.length ? t("director.workspace.continuity.stateDifference") : t("director.workspace.continuity.stateContinuous")}</Tag></div>{differences.length > 0 && <p className="mt-2 text-sm text-muted-foreground">{differences.map(key => `${display.fact(key)}：${display.value(key, left[key])} → ${display.value(key, right[key])}`).join(" · ")}</p>}</article><BoundaryContinuityRow from={String(segment.id)} to={String(next.id)} fromLabel={title(segment, String(segment.id))} toLabel={title(next, String(next.id))} boundary={boundaries.find(row => row.from === segment.id && row.to === next.id)} disabled={busy || !editable} onSave={onBoundary} /></div>; })}</div>}
    {!legacy && editable && <details className="border-t border-border pt-4"><summary className="cursor-pointer text-sm font-medium">{t("director.workspace.continuity.manualEditing")}</summary><div className="mt-4 space-y-4"><div><h3 className="font-medium">{t("director.workspace.continuity.timelineAndFacts")}</h3><p className="mt-1 text-xs text-muted-foreground">{t("director.workspace.continuity.factsHelper")}</p></div>
      <div className="grid gap-3 md:grid-cols-3"><Input aria-label={t("director.crud.timelineName")} placeholder={t("director.crud.timelineName")} value={newTimelineName} onChange={event => setNewTimelineName(event.target.value)} /><Button disabled={busy || !newTimelineName.trim()} onClick={addTimeline}>{t("director.workspace.continuity.addTimeline")}</Button><Select aria-label={t("director.workspace.continuity.selectTimeline")} value={timelineId || undefined} placeholder={t("director.workspace.continuity.selectTimeline")} options={timeRows.map(row => ({ value: row.id, label: display.timeline(row.id) }))} onChange={setTimelineId} />
      <Select aria-label={t("director.workspace.continuity.objectKind")} value={objectKind} options={["character", "scene", "asset"].map(value => ({ value, label: t(`director.workspace.continuity.objectKindValue.${value}`) }))} onChange={setObjectKind} /><Select aria-label={t("director.workspace.continuity.objectId")} value={objectId || undefined} placeholder={t("director.workspace.continuity.objectId")} options={availableObjects.map(row => ({ value: String(row.id || row.asset_id), label: String(row.name || row.asset_name || row.title || row.scene_name || t("director.crud.unnamedEntity")) }))} onChange={setObjectId} /><Input aria-label={t("director.crud.factName")} placeholder={t("director.crud.factName")} value={newFactId} onChange={event => setNewFactId(event.target.value)} />
      <Input aria-label={t("director.workspace.continuity.allowedValues")} placeholder={t("director.workspace.continuity.allowedValues")} value={factValues} onChange={event => setFactValues(event.target.value)} /><Button disabled={busy || !objectId || !newFactId.trim()} onClick={addFact}>{t("director.workspace.continuity.addFact")}</Button><Select aria-label={t("director.workspace.continuity.selectFact")} value={factId || undefined} placeholder={t("director.workspace.continuity.selectFact")} options={factRows.map(row => ({ value: row.id, label: display.fact(row.id) }))} onChange={changeFact} />
      <Select aria-label={t("director.workspace.continuity.initialValue")} value={initialValue || undefined} placeholder={t("director.workspace.continuity.initialValue")} options={[...(factRows.find(row => row.id === factId)?.allowed_values || []), "unknown"].map(value => ({ value, label: display.value(factId, value) }))} onChange={setInitialValue} /><Button disabled={busy || !timelineId || !factId || !initialValue} onClick={addInitial}>{t("director.workspace.continuity.setInitial")}</Button><Select aria-label={t("director.workspace.continuity.shot")} value={shotId || undefined} placeholder={t("director.workspace.continuity.shot")} options={relevantShots.map(row => ({ value: row.id, label: display.target(row.id) }))} onChange={value => { setShotId(value); setSourceBlockId(""); setEventFrame(subjectAssembly ? "0" : String(shots.find(row => row.id === value)?.start_frame ?? "")); }} />
      <Select aria-label={t("director.workspace.continuity.sourceBlock")} value={sourceBlockId || undefined} placeholder={t("director.workspace.continuity.sourceBlock")} options={blocksForShot.map(row => ({ value: row.id, label: display.source(row.id) }))} onChange={setSourceBlockId} />
      <Button disabled={busy || !timelineId || !shotId || !factId || !sourceBlockId} onClick={() => void addHold()}>{t("director.workspace.continuity.addHold")}</Button><Input value={eventFrame} type="number" aria-label={t(subjectAssembly ? "director.atomic.localEventFrame" : "director.workspace.continuity.eventFrame")} placeholder={t(subjectAssembly ? "director.atomic.localEventFrame" : "director.workspace.continuity.eventFrame")} onChange={event => setEventFrame(event.target.value)} />
      <Select aria-label={t("director.workspace.continuity.eventAfter")} value={eventAfter || undefined} placeholder={t("director.workspace.continuity.eventAfter")} options={factRows.find(row => row.id === factId)?.allowed_values?.map((value: string) => ({ value, label: display.value(factId, value) })) || []} onChange={setEventAfter} /><Input value={eventReason} aria-label={t("director.workspace.continuity.eventReason")} placeholder={t("director.workspace.continuity.eventReason")} onChange={event => setEventReason(event.target.value)} />
      <Button disabled={busy || !timelineId || !shotId || !factId || !sourceBlockId || !eventReason.trim()} onClick={() => void addEvent()}>{t("director.workspace.continuity.addChange")}</Button><Input value={exemptionReason} aria-label={t("director.workspace.continuity.exemptionReason")} placeholder={t("director.workspace.continuity.exemptionReason")} onChange={event => setExemptionReason(event.target.value)} />
      <Input value={reviewRef} aria-label={t("director.workspace.continuity.reviewRef")} placeholder={t("director.workspace.continuity.reviewRef")} onChange={event => setReviewRef(event.target.value)} /><Button disabled={busy || !exemptionReason.trim() || !reviewRef.trim()} onClick={() => void addExemption()}>{t("director.workspace.continuity.markReviewed")}</Button></div>
      <p className="text-xs text-muted-foreground">{t("director.workspace.continuity.ledgerCount", { facts: factRows.length, events: ledger.events?.length || 0, coverage: ledger.coverage?.length || 0 })}</p>
      {activeView !== "ledger" && <Button type="primary" disabled={busy || sourceConflict || invalidLedgerDraft} onClick={saveLedger}>{t("director.workspace.continuity.saveLedger")}</Button>}
    </div></details>}
    {legacy && editable && <div className="space-y-3"><Button type="primary" loading={agentUpgradeStarting || Boolean(agentUpgradeRequest)} disabled={busy || !onRequestAgentUpgrade} onClick={() => void requestAgentUpgrade()}>{t("director.workspace.continuity.upgradeWithAgent")}</Button><Input.TextArea value={draftText} disabled={busy || agentUpgradeStarting || Boolean(agentUpgradeRequest)} onChange={event => { setDraftText(event.target.value); setProposedLedger(null); setUpgradePreview(null); }} placeholder={t("director.workspace.continuity.upgradeJson")} autoSize={{ minRows: 5, maxRows: 12 }} />{draftError && <Alert type="error" message={draftError} />}<Button disabled={busy || agentUpgradeStarting || Boolean(agentUpgradeRequest) || !draftText.trim()} onClick={() => void saveJson()}>{t("director.workspace.continuity.previewUpgrade")}</Button>{upgradePreview && <div className="space-y-2 rounded-lg border border-border p-3"><Tag color={upgradePreview.report?.status === "passed" ? "green" : "orange"}>{t(`director.workspace.continuity.status.${upgradePreview.report?.status || "blocked"}`)}</Tag><p className="break-all text-xs">{t("director.workspace.continuity.upgradeSource")}: {upgradePreview.fromSourceHash}</p><p className="text-xs">{t("director.workspace.continuity.upgradeRuntime")}: {upgradePreview.targetRuntime?.version} · {upgradePreview.targetRuntime?.runtimeId}</p><p className="text-xs">{t("director.workspace.continuity.upgradeImpact", { count: upgradePreview.affectedTargets?.length || 0, unresolved: upgradePreview.report?.diagnostics?.length || 0 })}</p><div className="space-y-1 border-t border-border pt-2 text-xs text-muted-foreground"><p>{t("director.workspace.continuity.upgradeEquivalent", { count: upgradePreview.changeClassification?.equivalentConversions?.length || 0 })}</p><p>{t("director.workspace.continuity.upgradeHistorical", { count: upgradePreview.changeClassification?.historicalProjection?.length || 0 })}</p><p>{t("director.workspace.continuity.upgradeSemanticGaps", { count: upgradePreview.changeClassification?.semanticGaps?.length || 0 })}</p><p>{t("director.workspace.continuity.upgradeSpeculative", { count: upgradePreview.changeClassification?.speculativeSuggestions?.length || 0 })}</p></div>{(upgradePreview.activeRuns || []).length > 0 && <Alert type="warning" showIcon message={t("director.workspace.continuity.upgradeActiveRuns", { count: upgradePreview.activeRuns.length })} description={upgradePreview.activeRuns.map((run: Row) => `${run.runId} · ${run.status}`).join(" / ")} />}<Button type="primary" disabled={busy || (upgradePreview.activeRuns || []).length > 0} onClick={() => void applyUpgrade()}>{t("director.workspace.continuity.applyUpgrade")}</Button></div>}</div>}
  </section>;
}
