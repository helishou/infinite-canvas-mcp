import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Input, Select, Switch, Tag } from "antd";
import { useTranslation } from "react-i18next";
import type { ProductionContinuity } from "@/services/backend-api";

type Row = Record<string, any>;
const blankLedger = () => ({ contract_version: 2, facts: [], timelines: [], initial: [], events: [], requirements: [], coverage: [] });
const id = () => `C_${crypto.randomUUID()}`;
const stable = (value: any): string => Array.isArray(value) ? `[${value.map(stable).join(",")}]` : value && typeof value === "object" ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}` : JSON.stringify(value);
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

export function ContinuityPanel({ ledger: savedLedger, sourceHash, scenes, shots, segments, boundaries, characters, assets, report, workId, busy, editable, onSave, onPreviewUpgrade, onCheck, onLocate, onAskDirector, onBoundary, onSnapshot }: {
  ledger?: Row; sourceHash: string; scenes: Row[]; shots: Row[]; segments: Row[]; boundaries: Row[]; characters: Row[]; assets: Row[]; report?: ProductionContinuity;
  workId?: string;
  busy: boolean; editable: boolean; onSave: (ledger: Row, upgradePreview?: Row) => Promise<boolean>; onPreviewUpgrade: (ledger: Row, fromSourceHash: string) => Promise<Row>; onCheck: () => Promise<void>; onLocate: (kind: string, id: string) => void; onAskDirector?: (scope: { workspace: "continuity"; targetId?: string; workId?: string; instruction: string }) => void; onBoundary: (value: Row) => void; onSnapshot?: (value: "draft" | "published") => void;
}) {
  const { t } = useTranslation();
  const legacy = Boolean(savedLedger && savedLedger.contract_version !== 2);
  const [ledger, setLedger] = useState<Row>(savedLedger?.contract_version === 2 ? structuredClone(savedLedger) : blankLedger());
  const [sourceConflict, setSourceConflict] = useState(false);
  const savedLedgerKey = savedLedger?.contract_version === 2 ? stable(savedLedger) : "legacy";
  const previousSource = useRef({ sourceHash, ledgerKey: savedLedgerKey });
  const [activeView, setActiveView] = useState<"issues" | "timeline" | "boundaries">("issues");
  const [timelineId, setTimelineId] = useState("");
  const [filterScene, setFilterScene] = useState("all");
  const [filterTarget, setFilterTarget] = useState("all");
  const [filterObject, setFilterObject] = useState("all");
  const [filterCategory, setFilterCategory] = useState("all");
  const [newFactId, setNewFactId] = useState("");
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

  useEffect(() => {
    if (savedLedger?.contract_version === 2) {
      const localChanged = previousSource.current.ledgerKey !== "legacy" && stable(ledger) !== previousSource.current.ledgerKey;
      if (localChanged && stable(ledger) !== savedLedgerKey) { setSourceConflict(true); previousSource.current = { sourceHash, ledgerKey: savedLedgerKey }; return; }
      setLedger(structuredClone(savedLedger)); setSourceConflict(false);
    }
    else if (!savedLedger) setLedger(blankLedger());
    // A legacy ledger is only displayed as a read-only diagnostic. It never
    // becomes an implicit v2 baseline in the editor.
    previousSource.current = { sourceHash, ledgerKey: savedLedgerKey };
  }, [sourceHash, savedLedgerKey]);
  useEffect(() => { setProposedLedger(null); setUpgradePreview(null); }, [sourceHash]);

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
  const addTimeline = () => { if (!timelineId.trim() || timeRows.some(row => row.id === timelineId.trim())) return; append("timelines", { id: timelineId.trim() }); setTimelineId(""); };
  const addFact = () => {
    const allowed = factValues.split(",").map(value => value.trim()).filter(Boolean);
    if (!newFactId.trim() || !objectId || !allowed.length || factRows.some(row => row.id === newFactId.trim())) return;
    append("facts", { id: newFactId.trim(), object_kind: objectKind, object_id: objectId, allowed_values: allowed });
    setFactId(newFactId.trim()); setNewFactId(""); setFactValues("");
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
    const current = initial.find((row: Row) => row.timeline_id === timelineId && row.fact_id === factId).value;
    const requirementId = id();
    append("requirements", { id: requirementId, timeline_id: timelineId, shot_id: shotId, fact_id: factId, kind: "hold", value: current, source_anchor: { block_id: sourceBlockId } });
    appendCoverage({ id: id(), timeline_id: timelineId, source_anchor: { block_id: sourceBlockId }, source_digest: await sourceDigest(source.sceneId, source.sourceBlock), evidence_kind: "explicit_hold", fact_ids: [factId], event_ids: [], shot_ids: [shotId] });
  };
  const addEvent = async () => {
    const shot = shots.find(row => row.id === shotId), source = sourceBlocks.find(row => row.id === sourceBlockId), fact = factRows.find(row => row.id === factId);
    if (!shot || !source || !fact || !timelineId || !eventReason.trim() || !eventAfter || !fact.allowed_values.includes(eventAfter)) return;
    const frame = Number(eventFrame);
    if (!Number.isInteger(frame) || frame < shot.start_frame || frame >= shot.end_frame) return;
    const relevantShotsByOrder = new Map(shots.map(row => [String(row.id), Number(row.story_order || 0)]));
    const before = [...(ledger.events || [])].filter((row: Row) => row.timeline_id === timelineId && row.fact_id === factId && (relevantShotsByOrder.get(String(row.shot_id)) || 0) <= Number(shot.story_order || 0))
      .sort((a: Row, b: Row) => (relevantShotsByOrder.get(String(a.shot_id)) || 0) - (relevantShotsByOrder.get(String(b.shot_id)) || 0) || a.frame - b.frame).at(-1)?.after
      || (ledger.initial || []).find((row: Row) => row.timeline_id === timelineId && row.fact_id === factId)?.value;
    if (typeof before !== "string") return;
    const eventId = id();
    append("events", { id: eventId, timeline_id: timelineId, fact_id: factId, shot_id: shotId, frame, before, after: eventAfter, reason: eventReason.trim(), source_anchor: { block_id: sourceBlockId } });
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
  const issues = report?.report?.diagnostics || report?.items || [];
  const timeline = report?.report?.trajectories || {};
  const initial = Array.isArray(ledger.initial) ? ledger.initial : [];
  const ledgerSections = (["facts", "timelines", "initial", "events", "requirements", "coverage"] as const).map(collection => ({ collection, rows: Array.isArray(ledger[collection]) ? ledger[collection] as Row[] : [] }));
  const stateLabel = report?.status || "unchecked";
  const sceneIds = scenes.map(row => String(row.scene_id || row.id || "")).filter(Boolean);
  const targetOptions = [...shots.map(row => ({ value: String(row.id), label: String(row.title || row.id) })), ...segments.map(row => ({ value: String(row.id), label: String(row.title || row.id) }))];
  const objectOptions = [...new Map(factRows.map(row => [String(row.object_id), { value: String(row.object_id), label: String(row.object_id) }])).values()];
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

  return <section className="space-y-5" data-continuity-workspace>
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-xl font-semibold">{t("director.workspace.tab.continuity")}</h2><p className="mt-1 text-sm text-muted-foreground">{t("director.workspace.continuity.semanticLimit")}</p><p className="mt-2 text-xs text-muted-foreground">{t("director.workspace.continuity.lastChecked")}: {report?.checkedAt ? new Date(report.checkedAt).toLocaleString() : t("director.workspace.continuity.neverChecked")} · {t("director.workspace.continuity.scopeCount", { count: report?.report?.selectedTargets?.length || 0 })}{report?.runtime?.runtimeId ? ` · ${String(report.runtime.runtimeId)}` : ""}</p></div><div className="flex items-center gap-2"><Select aria-label={t("director.workspace.continuity.snapshot")} value={report?.snapshot || "draft"} options={[{ value: "draft", label: t("director.workspace.continuity.snapshotDraft") }, { value: "published", label: t("director.workspace.continuity.snapshotPublished") }]} onChange={value => onSnapshot?.(value)} /><Tag color={stateLabel === "passed" ? "green" : ["blocked", "stale"].includes(stateLabel) ? "red" : "gold"}>{t(`director.workspace.continuity.status.${stateLabel}`)}</Tag><Button loading={busy} onClick={() => void onCheck()}>{t("director.workspace.continuity.check")}</Button></div></div>
    {legacy && <Alert type="warning" showIcon message={t("director.workspace.continuity.legacyReadOnly")} description={t("director.workspace.continuity.legacyUpgradeHint")} />}
    {sourceConflict && <Alert type="warning" showIcon message={t("director.workspace.continuity.sourceConflict")} />}
    {!editable && <Alert type="info" showIcon message={t("director.workspace.continuity.publishedReadOnly")} />}
    {report?.report?.semanticDiscovery === "not_performed" && <p className="rounded-lg border border-border px-3 py-2 text-xs text-muted-foreground">{t("director.workspace.continuity.registeredCoverageOnly")}</p>}
    <nav className="flex flex-wrap gap-2" aria-label={t("director.workspace.continuity.views")}>{(["issues", "timeline", "boundaries"] as const).map(view => <Button key={view} size="small" type={activeView === view ? "primary" : "default"} onClick={() => setActiveView(view)}>{t(`director.workspace.continuity.view.${view}`)}</Button>)}</nav>
    {activeView === "issues" && <div className="space-y-3"><div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4"><Select aria-label={t("director.workspace.continuity.filterScene")} value={filterScene} options={[{ value: "all", label: t("director.workspace.continuity.filterAllScenes") }, ...sceneIds.map(value => ({ value, label: value }))]} onChange={setFilterScene} /><Select aria-label={t("director.workspace.continuity.filterTarget")} value={filterTarget} options={[{ value: "all", label: t("director.workspace.continuity.filterAllTargets") }, ...targetOptions]} onChange={setFilterTarget} /><Select aria-label={t("director.workspace.continuity.filterObject")} value={filterObject} options={[{ value: "all", label: t("director.workspace.continuity.filterAllObjects") }, ...objectOptions]} onChange={setFilterObject} /><Select aria-label={t("director.workspace.continuity.filterCategory")} value={filterCategory} options={[{ value: "all", label: t("director.workspace.continuity.filterAllCategories") }, ...issueCategories.map(value => ({ value, label: value }))]} onChange={setFilterCategory} /></div>{visibleIssues.length ? visibleIssues.map((issue, index) => { const targets = [...new Set([issue.targetId, ...(Array.isArray(issue.affectedTargets) ? issue.affectedTargets : [])].filter(Boolean).map(String))]; const fact = factRows.find(row => String(row.id) === String(issue.factId || "")); const sourceBlockId = String(issue.sourceBlockId || "") || String(issue.path || "").split(".blocks.")[1]?.split(".")[0]; const sourceBlock = sourceBlocks.find(block => String(block.id) === sourceBlockId); const displayValue = (value: unknown) => typeof value === "string" ? value : JSON.stringify(value); return <article key={`${issue.code}:${issue.targetId || ""}:${index}`} className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-border p-3"><div className="min-w-0"><div className="flex flex-wrap gap-2"><Tag color={issue.severity === "warning" ? "gold" : "red"}>{issue.code}</Tag>{fact && <Tag>{fact.object_kind}:{fact.object_id} · {fact.id}</Tag>}{targets.map(target => <Tag key={target}>{target}</Tag>)}</div><p className="mt-2 text-sm">{issue.message}</p>{issue.expected !== undefined || issue.actual !== undefined ? <p className="mt-1 text-xs">{t("director.workspace.continuity.expectedActual", { expected: displayValue(issue.expected) ?? "—", actual: displayValue(issue.actual) ?? "—" })}</p> : null}{sourceBlock && <p className="mt-1 text-xs text-muted-foreground">{t("director.workspace.continuity.sourceEvidence", { block: sourceBlock.id, text: sourceBlock.sourceBlock.text || sourceBlock.sourceBlock.kind || "" })}</p>}{issue.path && <p className="mt-1 break-all text-xs text-muted-foreground">{issue.path}</p>}</div><div className="flex flex-wrap gap-1">{targets.map(target => <Button key={target} size="small" onClick={() => onLocate(segments.some(item => String(item.id) === target) ? "segment" : "shot", target)}>{t("director.workspace.continuity.locate")} · {target}</Button>)}{onAskDirector && <Button size="small" disabled={busy || !editable} onClick={() => onAskDirector({
              workspace: "continuity", targetId: String(issue.targetId || targets[0] || ""), workId,
              instruction: `${t("director.workspace.continuity.handoffPrompt")}\n${JSON.stringify({ owner: report?.owner, workId, revision: report?.revision, publishedVersion: report?.publishedVersion, snapshot: report?.snapshot, sourceHash: report?.sourceHash, checkOperationId: report?.report?.operationId, issue: { code: issue.code, message: issue.message, path: issue.path, targetId: issue.targetId, affectedTargets: issue.affectedTargets, factId: issue.factId, expected: issue.expected, actual: issue.actual, sourceBlockId: issue.sourceBlockId }, sourceBlock: sourceBlock?.sourceBlock?.text }, null, 2)}`
            })}>{t("director.workspace.continuity.handoffToDirector")}</Button>}</div></article>; }) : <p className="rounded-xl border border-border p-4 text-sm text-muted-foreground">{visibleIssues.length === 0 && issues.length ? t("director.workspace.continuity.noFilterIssues") : t("director.workspace.continuity.noIssues")}</p>}</div>}
    {activeView === "timeline" && <div className="space-y-3">{Object.entries(timeline).map(([shot, row]: [string, any]) => <article key={shot} className="rounded-xl border border-border p-3"><div className="flex items-center justify-between"><strong>{shot}</strong><Tag>{row.timelineId} · {row.storyOrder}</Tag></div><div className="mt-3 grid gap-3 sm:grid-cols-2"><div><h3 className="text-xs font-medium text-muted-foreground">{t("director.workspace.continuity.startState")}</h3><pre className="mt-1 overflow-x-auto whitespace-pre-wrap text-xs">{JSON.stringify(row.start, null, 2)}</pre></div><div><h3 className="text-xs font-medium text-muted-foreground">{t("director.workspace.continuity.endState")}</h3><pre className="mt-1 overflow-x-auto whitespace-pre-wrap text-xs">{JSON.stringify(row.end, null, 2)}</pre></div></div></article>)}</div>}
    {activeView === "boundaries" && <div className="space-y-3">{segments.slice(0, -1).map((segment, index) => { const next = segments[index + 1]; const fromShot = shots.find(row => row.id === (segment.shot_ids || []).at(-1)); const toShot = shots.find(row => row.id === (next.shot_ids || [])[0]); const left = fromShot && timeline[String(fromShot.id)]?.end; const right = toShot && timeline[String(toShot.id)]?.start; const differences = left && right ? [...new Set([...Object.keys(left), ...Object.keys(right)])].filter(key => left[key] !== right[key]) : []; const title = (row: Row | undefined, fallback: string) => row?.title || fallback; return <div key={`${segment.id}:${next.id}`} className="space-y-2"><article className="rounded-xl border border-border p-3"><div className="flex items-center justify-between"><strong>{title(fromShot, segment.id)} → {title(toShot, next.id)}</strong><Tag color={!left || !right ? "gold" : differences.length ? "red" : "green"}>{!left || !right ? t("director.workspace.continuity.stateUnknown") : differences.length ? t("director.workspace.continuity.stateDifference") : t("director.workspace.continuity.stateContinuous")}</Tag></div>{differences.length > 0 && <p className="mt-2 text-sm text-muted-foreground">{differences.map(key => `${key}: ${left[key]} → ${right[key]}`).join(" · ")}</p>}</article><BoundaryContinuityRow from={String(segment.id)} to={String(next.id)} fromLabel={title(segment, String(segment.id))} toLabel={title(next, String(next.id))} boundary={boundaries.find(row => row.from === segment.id && row.to === next.id)} disabled={busy} onSave={onBoundary} /></div>; })}</div>}
    {!legacy && editable && <div className="space-y-4 border-t border-border pt-4"><div><h3 className="font-medium">{t("director.workspace.continuity.timelineAndFacts")}</h3><p className="mt-1 text-xs text-muted-foreground">{t("director.workspace.continuity.factsHelper")}</p></div>
      <div className="grid gap-3 md:grid-cols-3"><Input aria-label={t("director.workspace.continuity.timelineId")} placeholder={t("director.workspace.continuity.timelineId")} value={timelineId} onChange={event => setTimelineId(event.target.value)} /><Button disabled={busy || !timelineId.trim()} onClick={addTimeline}>{t("director.workspace.continuity.addTimeline")}</Button><Select aria-label={t("director.workspace.continuity.selectTimeline")} value={timelineId || undefined} placeholder={t("director.workspace.continuity.selectTimeline")} options={timeRows.map(row => ({ value: row.id, label: row.id }))} onChange={setTimelineId} />
      <Select aria-label={t("director.workspace.continuity.objectKind")} value={objectKind} options={["character", "scene", "asset"].map(value => ({ value, label: t(`director.workspace.continuity.objectKindValue.${value}`) }))} onChange={setObjectKind} /><Select aria-label={t("director.workspace.continuity.objectId")} value={objectId || undefined} placeholder={t("director.workspace.continuity.objectId")} options={availableObjects.map(row => ({ value: String(row.id || row.asset_id), label: `${row.name || row.title || row.scene_name || row.id} · ${row.id || row.asset_id}` }))} onChange={setObjectId} /><Input aria-label={t("director.workspace.continuity.factId")} placeholder={t("director.workspace.continuity.factId")} value={newFactId} onChange={event => setNewFactId(event.target.value)} />
      <Input aria-label={t("director.workspace.continuity.allowedValues")} placeholder={t("director.workspace.continuity.allowedValues")} value={factValues} onChange={event => setFactValues(event.target.value)} /><Button disabled={busy || !objectId || !newFactId.trim()} onClick={addFact}>{t("director.workspace.continuity.addFact")}</Button><Select aria-label={t("director.workspace.continuity.selectFact")} value={factId || undefined} placeholder={t("director.workspace.continuity.selectFact")} options={factRows.map(row => ({ value: row.id, label: `${row.id} · ${row.object_id}` }))} onChange={changeFact} />
      <Select aria-label={t("director.workspace.continuity.initialValue")} value={initialValue || undefined} placeholder={t("director.workspace.continuity.initialValue")} options={[...(factRows.find(row => row.id === factId)?.allowed_values || []), "unknown"].map(value => ({ value, label: value }))} onChange={setInitialValue} /><Button disabled={busy || !timelineId || !factId || !initialValue} onClick={addInitial}>{t("director.workspace.continuity.setInitial")}</Button><Select aria-label={t("director.workspace.continuity.shot")} value={shotId || undefined} placeholder={t("director.workspace.continuity.shot")} options={relevantShots.map(row => ({ value: row.id, label: `${row.title || row.id} · ${row.id}` }))} onChange={value => { setShotId(value); setSourceBlockId(""); }} />
      <Select aria-label={t("director.workspace.continuity.sourceBlock")} value={sourceBlockId || undefined} placeholder={t("director.workspace.continuity.sourceBlock")} options={blocksForShot.map(row => ({ value: row.id, label: `${row.sceneName} · ${row.id}` }))} onChange={setSourceBlockId} />
      <Button disabled={busy || !timelineId || !shotId || !factId || !sourceBlockId} onClick={() => void addHold()}>{t("director.workspace.continuity.addHold")}</Button><Input value={eventFrame} type="number" aria-label={t("director.workspace.continuity.eventFrame")} placeholder={t("director.workspace.continuity.eventFrame")} onChange={event => setEventFrame(event.target.value)} />
      <Select aria-label={t("director.workspace.continuity.eventAfter")} value={eventAfter || undefined} placeholder={t("director.workspace.continuity.eventAfter")} options={factRows.find(row => row.id === factId)?.allowed_values?.map((value: string) => ({ value, label: value })) || []} onChange={setEventAfter} /><Input value={eventReason} aria-label={t("director.workspace.continuity.eventReason")} placeholder={t("director.workspace.continuity.eventReason")} onChange={event => setEventReason(event.target.value)} />
      <Button disabled={busy || !timelineId || !shotId || !factId || !sourceBlockId || !eventReason.trim()} onClick={() => void addEvent()}>{t("director.workspace.continuity.addChange")}</Button><Input value={exemptionReason} aria-label={t("director.workspace.continuity.exemptionReason")} placeholder={t("director.workspace.continuity.exemptionReason")} onChange={event => setExemptionReason(event.target.value)} />
      <Input value={reviewRef} aria-label={t("director.workspace.continuity.reviewRef")} placeholder={t("director.workspace.continuity.reviewRef")} onChange={event => setReviewRef(event.target.value)} /><Button disabled={busy || !exemptionReason.trim() || !reviewRef.trim()} onClick={() => void addExemption()}>{t("director.workspace.continuity.markReviewed")}</Button></div>
      <p className="text-xs text-muted-foreground">{t("director.workspace.continuity.ledgerCount", { facts: factRows.length, events: ledger.events?.length || 0, coverage: ledger.coverage?.length || 0 })}</p>
      <details className="rounded-xl border border-border p-3"><summary className="cursor-pointer text-sm font-medium">{t("director.workspace.continuity.registeredEntries")}</summary><div className="mt-3 space-y-3">{ledgerSections.map(({ collection, rows }) => rows.length > 0 && <section key={collection} className="space-y-1"><h4 className="text-xs font-medium text-muted-foreground">{t(`director.workspace.continuity.entryType.${collection}`)}</h4>{rows.map((row, index) => <div key={`${collection}:${row.id || index}`} className="flex items-start justify-between gap-2 rounded-lg bg-muted/30 px-2 py-1.5"><code className="min-w-0 break-all text-xs">{row.id ? `${row.id} · ` : ""}{JSON.stringify(row).slice(0, 220)}</code><Button danger size="small" disabled={busy || !editable} onClick={() => removeEntry(collection, index)}>{t("director.workspace.continuity.removeEntry")}</Button></div>)}</section>)}</div><p className="mt-3 text-xs text-muted-foreground">{t("director.workspace.continuity.removePreservesReferences")}</p></details>
      {!legacy && <Button type="primary" disabled={busy} onClick={() => { void onSave(ledger); }}>{t("director.workspace.continuity.saveLedger")}</Button>}
      {legacy && editable && <div className="space-y-2"><Input.TextArea value={draftText} onChange={event => { setDraftText(event.target.value); setProposedLedger(null); setUpgradePreview(null); }} placeholder={t("director.workspace.continuity.upgradeJson")} autoSize={{ minRows: 5, maxRows: 12 }} />{draftError && <Alert type="error" message={draftError} />}<Button disabled={busy || !draftText.trim()} onClick={() => void saveJson()}>{t("director.workspace.continuity.previewUpgrade")}</Button>{upgradePreview && <div className="space-y-2 rounded-lg border border-border p-3"><Tag color={upgradePreview.report?.status === "passed" ? "green" : "orange"}>{t(`director.workspace.continuity.status.${upgradePreview.report?.status || "blocked"}`)}</Tag><p className="break-all text-xs">{t("director.workspace.continuity.upgradeSource")}: {upgradePreview.fromSourceHash}</p><p className="text-xs">{t("director.workspace.continuity.upgradeRuntime")}: {upgradePreview.targetRuntime?.version} · {upgradePreview.targetRuntime?.runtimeId}</p><p className="text-xs">{t("director.workspace.continuity.upgradeImpact", { count: upgradePreview.affectedTargets?.length || 0, unresolved: upgradePreview.report?.diagnostics?.length || 0 })}</p><div className="space-y-1 border-t border-border pt-2 text-xs text-muted-foreground"><p>{t("director.workspace.continuity.upgradeEquivalent", { count: upgradePreview.changeClassification?.equivalentConversions?.length || 0 })}</p><p>{t("director.workspace.continuity.upgradeHistorical", { count: upgradePreview.changeClassification?.historicalProjection?.length || 0 })}</p><p>{t("director.workspace.continuity.upgradeSemanticGaps", { count: upgradePreview.changeClassification?.semanticGaps?.length || 0 })}</p><p>{t("director.workspace.continuity.upgradeSpeculative", { count: upgradePreview.changeClassification?.speculativeSuggestions?.length || 0 })}</p></div>{(upgradePreview.activeRuns || []).length > 0 && <Alert type="warning" showIcon message={t("director.workspace.continuity.upgradeActiveRuns", { count: upgradePreview.activeRuns.length })} description={upgradePreview.activeRuns.map((run: Row) => `${run.runId} · ${run.status}`).join(" / ")} />}<Button type="primary" disabled={busy || (upgradePreview.activeRuns || []).length > 0} onClick={() => void applyUpgrade()}>{t("director.workspace.continuity.applyUpgrade")}</Button></div>}</div>}
    </div>}
  </section>;
}
