import { continuityChangeInputHint, continuityDraftFocusTarget, continuityTrackPoint, continuityTrackInsertFrame, continuityInlineReturnFocus, continuityRowInsertTarget, continuityValueWith } from "./continuity-workbench-interaction";
import { ContinuityEventFields } from "./continuity-event-fields";
import { continuityChangeFormInput, type ContinuityChangeInput } from "./continuity-event-draft";
import { continuityEventAnchor, continuityEventPositionPatch } from "./continuity-event-anchor";
import { Fragment, useEffect, useId, useMemo, useRef, useState, type Dispatch, type SetStateAction, type CSSProperties } from "react";
import { Button, Popover, Select } from "antd";
import type { TooltipRef } from "antd/es/tooltip";
import { ChevronDown, ChevronRight, Plus, RotateCcw, Trash2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { productionSceneEntries } from "@basketikun/canvas-agent/drama/production-contract";
import { continuityPresentation } from "./continuity-presentation";
import { subjectDisplayName } from "./subject-shot-draft";
import { records } from "./director-display";
import { continuityBlocksForShot, continuityEntityKey, continuityLocalFrame, continuityMarkerLanes, continuityTimelineShots, continuityUsage, orderedContinuityShots, replayContinuityFact, visibleContinuityTrack, type ContinuityRow as Row, type ContinuityMarker, type ContinuityTrack } from "./continuity-timeline-model";
import "./continuity-timeline.css";

type Selection = { shotId: string; factId: string; eventId?: string; frame?: number };
type InlinePoint = { shotId: string; factId: string; frame: number };
type Props = {
    recordContext?: { shotId: string; factId: string; visibleStart: number; eventId?: string }; onRecordContext: (context: { shotId: string; factId: string; visibleStart: number; eventId?: string } | undefined) => void; changeDraft?: ContinuityChangeInput; onChangeDraft: (value: ContinuityChangeInput | undefined) => void; focusEventId?: string; source: Row; ledger: Row; savedLedger: Row; shots: Row[]; display: ReturnType<typeof continuityPresentation>; sourceBlocks: Row[];
    subjectAssembly: boolean; disabled: boolean; editable: boolean; dirty: boolean; busy: boolean; saveBlocked: boolean;
    actions: { update: Dispatch<SetStateAction<Row>>;
        openEntry: (collection: string, row?: Row) => void; openBoundary: (from: string) => void; deleteEvent: (event: Row) => void; changeEvidence: (eventId: string, blockId: string) => Promise<boolean>; createEvent: (input: ContinuityChangeInput) => Promise<string | undefined> };
};

/** One presentation of the parent's ledger draft; no business state or storage copy. */
export function ContinuityTimelineWorkbench({ recordContext, onRecordContext, changeDraft, onChangeDraft, focusEventId, source, subjectAssembly, ledger, savedLedger, shots, display, sourceBlocks, disabled, editable, dirty, busy, saveBlocked, actions }: Props) {
    const { t } = useTranslation();
    const label = (key: string, values?: Record<string, unknown>) => t(`director.workspace.continuity.subjectTimeline.${key}`, values);
    const workbenchRoot = useRef<HTMLElement>(null);
    const inspectorBody = useRef<HTMLDivElement>(null), inlineBody = useRef<HTMLDivElement>(null);
    const inlinePopover = useRef<TooltipRef>(null);
    const triggerElement = useRef<HTMLElement | null>(null);
    const editContext = useRef({ disabled, source }); editContext.current = { disabled, source };
    const [inlinePoint, setInlinePoint] = useState<InlinePoint>();
    const closeInline = (restoreFocus = false) => {
        setInlinePoint(undefined);
        if (restoreFocus) requestAnimationFrame(() => {
            continuityInlineReturnFocus(triggerElement.current, workbenchRoot.current)?.focus({ preventScroll: true });
        });
    };
    useEffect(() => {
        if (!inlinePoint) return;
        const dismiss = (event: PointerEvent) => {
            const target = event.target;
            if (!(target instanceof Element) || target.closest('[data-continuity-inline-editor], [data-continuity-inline-trigger], .ant-select-dropdown, .ant-modal-root')) return;
            setInlinePoint(undefined);
        };
        document.addEventListener("pointerdown", dismiss);
        return () => document.removeEventListener("pointerdown", dismiss);
    }, [Boolean(inlinePoint)]);
    const previousDraftOpen = useRef(false), confirmedDraft = useRef(false);
    useEffect(() => {
        const isDraft = Boolean(changeDraft), selector = continuityDraftFocusTarget(previousDraftOpen.current, isDraft, confirmedDraft.current);
        if (selector) {
            const target = inlineBody.current?.querySelector<HTMLElement>(selector) || inspectorBody.current?.closest("[data-continuity-workspace]")?.querySelector<HTMLElement>(selector);
            (target || triggerElement.current)?.focus({ preventScroll: true });
        }
        if (isDraft) confirmedDraft.current = false;
        previousDraftOpen.current = isDraft;
    }, [Boolean(changeDraft)]);
    const [creating, setCreating] = useState(false), creatingRef = useRef(false);
    const focusedEvent = records(ledger.events).find(row => row.id === focusEventId);
    const [timelineFilter, setTimelineFilter] = useState(String(focusedEvent?.timeline_id || shots.find(shot => shot.id === recordContext?.shotId)?.timeline_id || ""));
    const [sceneFilter, setSceneFilter] = useState("all");
    const [subjectFilter, setSubjectFilter] = useState("all");
    const [changeOnly, setChangeOnly] = useState(false);
    const [unknownOnly, setUnknownOnly] = useState(false);
    const [showClips, setShowClips] = useState(true);
    const [expanded, setExpanded] = useState<Set<string>>(() => {
        const event = records(ledger.events)[0], fact = records(ledger.facts).find(row => row.id === event?.fact_id);
        const subject = records(source.subject_registry).find(row => continuityEntityKey(row.entityRef?.kind, row.entityRef?.id) === continuityEntityKey(fact?.object_kind, fact?.object_id));
        return new Set(subject ? [String(subject.id)] : []);
    });
    const [selection, setSelection] = useState<Selection | undefined>(() => focusedEvent ? { shotId: String(focusedEvent.shot_id), factId: String(focusedEvent.fact_id), eventId: String(focusedEvent.id) } : recordContext ? { shotId: recordContext.shotId, factId: recordContext.factId, eventId: recordContext.eventId } : undefined);
    const timelines = records(ledger.timelines), facts = records(ledger.facts), subjects = records(source.subject_registry);
    const adaptedShots = useMemo(() => continuityTimelineShots(source, ledger, shots), [source, ledger, shots]);
    const timelineId = changeDraft ? String(adaptedShots.find(row => row.id === changeDraft.shotId)?.timeline_id || "") : timelines.some(row => row.id === timelineFilter) ? timelineFilter : String(timelines[0]?.id || adaptedShots[0]?.timeline_id || "");
    const fullShots = orderedContinuityShots(adaptedShots, timelineId);
    const scenes = productionSceneEntries({ ...source, shots: adaptedShots });
    const occurrence = scenes.find(scene => scene.id === sceneFilter);
    const visibleShots = fullShots.filter(shot => sceneFilter === "all" || occurrence?.shotIds.includes(String(shot.id)));
    const tracks = useMemo(() => new Map(facts.map(fact => [String(fact.id), replayContinuityFact(ledger, adaptedShots, timelineId, String(fact.id))])), [ledger, adaptedShots, timelineId]);
    const owner = new Map(facts.map(fact => [String(fact.id), subjects.find(subject => continuityEntityKey(subject.entityRef?.kind, subject.entityRef?.id) === continuityEntityKey(fact.object_kind, fact.object_id))]));
    // People read positions in seconds; the exact frame stays next to it.
    const fps = Number(source.fps_num || 24) / Number(source.fps_den || 1);
    const trackFor = (factId: string, shotId: string) => tracks.get(factId)?.find(track => String(track.shot.id) === shotId);
    const viewFor = (factId: string, shotId: string) => {
        const track = trackFor(factId, shotId), subject = owner.get(factId);
        if (!track || !subject) return;
        const index = visibleShots.findIndex(shot => String(shot.id) === shotId), previousShot = visibleShots[index - 1];
        const adjacent = previousShot && fullShots.findIndex(shot => shot.id === track.shot.id) - fullShots.findIndex(shot => shot.id === previousShot.id) === 1;
        return visibleContinuityTrack(track, String(subject.id), previousShot && trackFor(factId, String(previousShot.id)), Boolean(adjacent));
    };
    const groups = subjects.filter(subject => subjectFilter === "all" || String(subject.id) === subjectFilter).map(subject => ({ subject, facts: facts.filter(fact => owner.get(String(fact.id))?.id === subject.id).filter(fact => {
        const visible = visibleShots.flatMap(shot => { const view = viewFor(String(fact.id), String(shot.id)); return view ? [view] : []; });
        return (!changeOnly || visible.some(view => view.markers.length)) && (!unknownOnly || visible.some(view => view.contextOnly || view.segments.some(segment => segment.value === "unknown") || view.markers.some(marker => marker.conflict || marker.duplicate)));
    }) })).filter(group => group.facts.length);
    const candidates = groups.flatMap(group => group.facts.flatMap(fact => visibleShots.filter(shot => viewFor(String(fact.id), String(shot.id))?.timelineWindows.length).map(shot => ({ fact, shot, view: viewFor(String(fact.id), String(shot.id))! }))));
    const explicitEvent = records(ledger.events).find(row => row.id === selection?.eventId && row.timeline_id === timelineId);
    const explicitFact = facts.find(fact => fact.id === (changeDraft?.factId || explicitEvent?.fact_id)), explicitShot = (changeDraft ? fullShots : visibleShots).find(shot => shot.id === (changeDraft?.shotId || explicitEvent?.shot_id));
    const explicitView = explicitFact && explicitShot ? viewFor(String(explicitFact.id), String(explicitShot.id)) : undefined;
    const explicitSelection = explicitFact && explicitShot && explicitView ? { fact: explicitFact, shot: explicitShot, view: explicitView } : undefined;
    const selected = explicitSelection || candidates.find(item => item.fact.id === selection?.factId && item.shot.id === selection?.shotId) || candidates.find(item => item.shot.id === selection?.shotId) || (!selection ? candidates.find(item => expanded.has(String(owner.get(String(item.fact.id))?.id)) && item.view.markers.length) : undefined) || candidates.find(item => item.view.markers.length) || candidates[0];
    const selectedEvent = selected && selection?.eventId ? records(ledger.events).find(row => row.id === selection.eventId && row.fact_id === selected.fact.id && row.shot_id === selected.shot.id && row.timeline_id === timelineId) : undefined;
    const event = selectedEvent || (!selection ? selected?.view.markers[0]?.event : undefined);
    useEffect(() => { if (inspectorBody.current) inspectorBody.current.scrollTop = 0; }, [Boolean(changeDraft), event?.id, selected?.shot.id, selected?.fact.id]);
    useEffect(() => { onRecordContext(selected ? { shotId: String(selected.shot.id), factId: String(selected.fact.id), visibleStart: selected.view.timelineWindows[0]?.start || 0, eventId: event?.id ? String(event.id) : undefined } : undefined); }, [selected?.shot.id, selected?.fact.id, selected?.view.timelineWindows[0]?.start, event?.id, onRecordContext]);
    const selectedMarker = selected && trackFor(String(selected.fact.id), String(selected.shot.id))?.markers.find(marker => marker.event.id === event?.id);
    const hiddenEvents = records(ledger.events).filter(event => String(event.timeline_id) === timelineId && !viewFor(String(event.fact_id), String(event.shot_id))?.markers.some(marker => marker.event.id === event.id));
    const select = (factId: string, shotId: string, eventId?: string, frame?: number) => setSelection({ factId, shotId, eventId, frame });
    const shortFact = (fact: Row) => String(fact.display_name || fact.name || fact.property || display.fact(String(fact.id)));
    const subjectName = (subject: Row) => subject.legacyUnregistered
        ? label("unregisteredSubject", { id: subject.legacyObjectId || subject.display_name })
        : subjectDisplayName(source, String(subject.id));
    const markerText = (factId: string, marker: ContinuityMarker) => marker.conflict ? label("conflictToUnknown") : `${display.value(factId, marker.event.before)} → ${display.value(factId, marker.event.after)}`;
    const frameText = (marker: ContinuityMarker, track: ContinuityTrack) => label("framePosition", { frame: marker.frame, duration: track.shot.duration_frames });
    const selectMarker = (factId: string, shotId: string, eventId: string, trigger?: HTMLElement) => { if (changeDraft || creating) return; const marker = trackFor(factId, shotId)?.markers.find(marker => marker.event.id === eventId); if (marker) { setInlinePoint({ factId, shotId, frame: marker.frame }); triggerElement.current = trigger || null; } select(factId, shotId, eventId, marker?.frame); const subject = owner.get(factId); if (subject) setExpanded(previous => new Set(previous).add(String(subject.id))); };
    const updateEvent = (patch: Row) => !disabled && event && actions.update(current => ({ ...current, events: records(current.events).map(row => row.id === event.id ? { ...row, ...patch } : row) }));
    const initial = selected && records(ledger.initial).find(row => row.timeline_id === timelineId && row.fact_id === selected.fact.id);
    const setInitial = (value: string) => !disabled && selected && actions.update(current => ({ ...current, initial: [...records(current.initial).filter(row => !(row.timeline_id === timelineId && row.fact_id === selected.fact.id)), { ...(initial || {}), timeline_id: timelineId, fact_id: selected.fact.id, value }] }));
    const restoreSelected = async () => {
        if (disabled) return;
        const restoreSource = source;
        if (event) { const original = records(savedLedger.events).find(saved => saved.id === event.id); if (original && original.source_anchor?.block_id !== event.source_anchor?.block_id && !await actions.changeEvidence(String(event.id), String(original.source_anchor?.block_id || ""))) return; }
        if (editContext.current.disabled || editContext.current.source !== restoreSource) return;
        if (event) actions.update(current => ({ ...current, events: records(current.events).flatMap(row => {
            if (row.id !== event.id) return [row]; const original = records(savedLedger.events).find(saved => saved.id === row.id); return original ? [structuredClone(original)] : [row];
        }) }));
        else if (selected) actions.update(current => ({ ...current, initial: [...records(current.initial).filter(row => !(row.timeline_id === timelineId && row.fact_id === selected.fact.id)), ...records(savedLedger.initial).filter(row => row.timeline_id === timelineId && row.fact_id === selected.fact.id).map(row => structuredClone(row))] }));
    };
    const canRestore = event ? records(savedLedger.events).some(row => row.id === event.id && JSON.stringify(row) !== JSON.stringify(event)) : Boolean(selected && JSON.stringify(initial) !== JSON.stringify(records(savedLedger.initial).find(row => row.timeline_id === timelineId && row.fact_id === selected.fact.id)));
    const initialValues = selected ? [...new Set([...(selected.fact.allowed_values || []), "unknown"])] : [];
    const eventFrame = event && selected ? continuityLocalFrame(event, selected.shot) : NaN;
    const selectedFrame = selected ? selection?.frame ?? (selected.view.timelineWindows.at(-1)?.end ?? 1) - 1 : 0;
    const selectedState = selected?.view.segments.find(segment => selectedFrame >= segment.start && selectedFrame < segment.end)?.value;
    const inlineOpen = Boolean(inlinePoint && selected?.fact.id === inlinePoint.factId && selected?.shot.id === inlinePoint.shotId && visibleShots.some(shot => shot.id === inlinePoint.shotId) && groups.some(group => expanded.has(String(group.subject.id)) && group.facts.some(fact => fact.id === inlinePoint.factId)));
    useEffect(() => {
        if (!inlineOpen) return;
        const frame = requestAnimationFrame(() => {
            inlinePopover.current?.forceAlign();
            (changeDraft ? inlineBody.current?.querySelector<HTMLElement>("[data-continuity-frame-slider]") : inlineBody.current)?.focus({ preventScroll: true });
        });
        return () => cancelAnimationFrame(frame);
    }, [inlineOpen]);
    useEffect(() => {
        if (!inlineOpen) return;
        const frame = requestAnimationFrame(() => inlinePopover.current?.forceAlign());
        return () => cancelAnimationFrame(frame);
    }, [inlineOpen, Boolean(changeDraft), event?.id]);
    const inheritedOrigin = selected && (tracks.get(String(selected.fact.id)) || []).slice(0, fullShots.findIndex(shot => shot.id === selected.shot.id) + 1).flatMap(track => track.invalidEvents.length
        ? [{ event: track.invalidEvents.at(-1)!, invalid: true }]
        : track.markers.filter(marker => track.shot.id !== selected.shot.id || marker.frame <= selectedFrame).map(marker => ({ event: marker.event, invalid: false }))).at(-1);
    const inheritedEvent = inheritedOrigin?.event;
    const context = selected && scenes.find(scene => scene.shotIds.includes(String(selected.shot.id)));
    let draftBefore: string | undefined, draftError = "";
    if (changeDraft) { try { if (!changeDraft.frame.trim()) throw new Error("INVALID_EVENT_FRAME"); draftBefore = continuityEventAnchor(ledger, adaptedShots, changeDraft.shotId, changeDraft.factId, Number(changeDraft.frame), true).before; } catch (error) { draftError = t("director.atomic.eventError." + (error instanceof Error ? error.message : "INVALID_EVENT_FRAME")); } }
    const inputHint = continuityChangeInputHint(changeDraft, draftError);
    const draftHintText = inputHint?.text || (inputHint ? label(inputHint.key, inputHint.count === undefined ? undefined : { count: inputHint.count }) : label("formUnsaved"));
    const draftHintId = useId();
    const draftOrigin = changeDraft ? (tracks.get(changeDraft.factId) || []).slice(0, fullShots.findIndex(shot => shot.id === changeDraft.shotId) + 1).flatMap(track => track.markers.filter(marker => track.shot.id !== changeDraft.shotId || marker.frame < Number(changeDraft.frame)).map(marker => ({ marker, shot: track.shot }))).at(-1) : undefined;

    const submitChange = async () => { if (!changeDraft || disabled || creatingRef.current) return; creatingRef.current = true; setCreating(true); try { const eventId = await actions.createEvent(changeDraft); if (eventId) { confirmedDraft.current = true; select(changeDraft.factId, changeDraft.shotId, eventId, Number(changeDraft.frame)); onChangeDraft(undefined); } } finally { creatingRef.current = false; setCreating(false); } };
    const beginInlineChange = (factId: string, shotId: string, frame: number, trigger?: HTMLElement) => {
        if (disabled || changeDraft || creating) return;
        const view = viewFor(factId, shotId);
        if (!view || !Number.isInteger(frame) || !view.segments.some(segment => frame >= segment.start && frame < segment.end)) return;
        select(factId, shotId, undefined, frame);
        setInlinePoint({ factId, shotId, frame });
        if (trigger) triggerElement.current = trigger;
        onChangeDraft({ factId, shotId, frame: String(frame), after: "", reason: "", sourceBlockId: "" });
    };
    /** The inspector owns a spacious form, so it opens the draft without the on-canvas popover. */
    const beginInspectorChange = (factId: string, shotId: string) => {
        if (disabled || changeDraft || creating) return;
        const view = viewFor(factId, shotId);
        if (!view) return;
        const frame = continuityTrackInsertFrame(view);
        if (frame === undefined) return;
        select(factId, shotId, undefined, frame);
        setInlinePoint(undefined);
        onChangeDraft(continuityChangeFormInput(ledger, view.shot, factId, frame));
    };
    /** Row-level add: the first visible Shot of this fact that still has a free change frame. */
    const rowInsertTarget = (factId: string) => continuityRowInsertTarget(visibleShots.flatMap(shot => {
        const view = viewFor(factId, String(shot.id));
        return view?.timelineWindows.length ? [{ shotId: String(shot.id), view }] : [];
    }));
    /** The inspector edits the chosen event in place; only the pin/label opens the on-canvas popover. */
    const selectInspectorEvent = (factId: string, shotId: string, eventId: string, frame: number) => {
        if (changeDraft || creating) return;
        select(factId, shotId, eventId, frame);
        const subject = owner.get(factId);
        if (subject) setExpanded(previous => new Set(previous).add(String(subject.id)));
    };
    /** A new after-state also joins the fact enum, so the ledger validator keeps accepting this event. */
    const addFactStateValue = (value: string) => {
        if (disabled || !selected) return;
        const fact = facts.find(row => row.id === String(selected.fact.id));
        if (!fact) return;
        const allowed = continuityValueWith(fact.allowed_values, value);
        if (allowed.length === (Array.isArray(fact.allowed_values) ? fact.allowed_values.length : 0)) return;
        actions.update(current => ({ ...current, facts: records(current.facts).map(row => row.id === fact.id ? { ...row, allowed_values: allowed } : row) }));
        if (changeDraft) onChangeDraft({ ...changeDraft, after: value.trim() });
        else if (event) updateEvent({ after: value.trim() });
    };
    const openTrack = (factId: string, shotId: string, trigger: HTMLElement, position?: number) => {
        if (changeDraft || creating) return;
        const view = viewFor(factId, shotId), point = view && continuityTrackPoint(view, position);
        if (!point) return;
        select(factId, shotId, point.eventId, point.frame);
        triggerElement.current = trigger;
        setInlinePoint({ factId, shotId, frame: point.frame });
    };
    const deleteSelectedEvent = () => {
        if (disabled || !event || !selected) return;
        const frame = Number.isFinite(eventFrame) ? eventFrame : selectedFrame;
        select(String(selected.fact.id), String(selected.shot.id), String(event.id), frame);
        setInlinePoint(current => current ? { ...current, frame } : current);
        actions.deleteEvent(event);
    };
    const renderEditor = (inline: boolean) => <>
                    {!selected ? <p className="text-sm text-muted-foreground">{label("empty")}</p> : <>
                        {!changeDraft && selected.view.markers.length > 1 && <label className="continuity-field"><span>{label("eventsInShot")}</span><Select size="small" aria-label={label("eventsInShot")} value={event?.id} placeholder={label("state")} options={selected.view.markers.map(marker => ({ value: String(marker.event.id), label: `f${marker.frame} · ${markerText(String(selected.fact.id), marker)}` }))} onChange={eventId => selectMarker(String(selected.fact.id), String(selected.shot.id), eventId, triggerElement.current || undefined)} /></label>}
                        {changeDraft ? <><div className="continuity-before-after is-from-only" title={draftOrigin ? label("inheritedFrom", { shot: display.target(String(draftOrigin.shot.id)), frame: draftOrigin.marker.frame }) : label("fromInitial", { timeline: display.timeline(timelineId) })}><div><span>{t("director.workspace.continuity.beforeChange")}</span><strong>{display.value(selected.fact.id, draftBefore)}</strong><small>{label("autoBeforeShort")}</small></div></div>{draftError && <p role="alert" className="continuity-local-warning">{draftError}</p>}<ContinuityEventFields value={changeDraft} onChange={patch => { if (!disabled && !creating) onChangeDraft({ ...changeDraft, ...patch }); }} onAddValue={addFactStateValue} shot={selected.shot} fact={selected.fact} blocks={continuityBlocksForShot(source, sourceBlocks, selected.shot)} display={display} fps={fps} disabled={disabled || creating} compact={inline} /></> : event ? <>
                            {!selected.view.markers.some(marker => marker.event.id === event.id) && <p className="continuity-local-warning">{label("outsideVisible")}</p>}
                            {selectedMarker?.conflict && <p className="continuity-local-warning">{label("beforeConflict", { value: display.value(selected.fact.id, selectedMarker.prior) })}</p>}
                            {selectedMarker?.duplicate && <p className="continuity-local-warning">{label("duplicate")}</p>}
                            <div className="continuity-before-after is-from-only" title={label("recordedBefore")}><div><span>{t("director.workspace.continuity.beforeChange")}</span><strong>{display.value(selected.fact.id, event.before)}</strong></div></div>
                            <ContinuityEventFields value={{ frame: Number.isFinite(eventFrame) ? String(eventFrame) : "", after: event.after, reason: event.reason || "", sourceBlockId: event.source_anchor?.block_id || "" }} onChange={patch => { if (disabled) return; if (patch.sourceBlockId !== undefined) { void actions.changeEvidence(String(event.id), patch.sourceBlockId); return; } updateEvent({ ...(patch.frame !== undefined ? continuityEventPositionPatch(event, selected.shot, patch.frame === "" ? "" : Number(patch.frame), subjectAssembly) : {}), ...(patch.after !== undefined ? { after: patch.after } : {}), ...(patch.reason !== undefined ? { reason: patch.reason } : {}) }); }} onAddValue={addFactStateValue} shot={selected.shot} fact={selected.fact} blocks={continuityBlocksForShot(source, sourceBlocks, selected.shot)} display={display} fps={fps} disabled={disabled} compact={inline} />
                            <details className="mb-3 text-xs"><summary>{label("correctBefore")}</summary><p className="my-2 text-muted-foreground">{label("recordedBefore")}</p><Select className="mt-2 w-full" aria-label={t("director.workspace.continuity.beforeChange")} size="small" disabled={disabled} value={event.before} options={initialValues.map(value => ({ value, label: display.value(selected.fact.id, value) }))} onChange={before => updateEvent({ before })} /></details>
                            <details className="mb-3 text-xs"><summary>{label("evidenceAdvanced")}</summary><p className="my-2 text-muted-foreground">{label("evidenceHint")}</p></details>
                            <Button type="link" size="small" onClick={() => actions.openEntry("coverage", records(ledger.coverage).find(row => (row.event_ids || []).includes(event.id)))}>{t("director.workspace.continuity.crud.sourceEvidence")}</Button>{editable && !inline && <Button danger type="text" size="small" disabled={disabled} onClick={deleteSelectedEvent}>{t("director.workspace.continuity.removeEntry")}</Button>}
                        </> : <>
                            {inline && <p className="mb-2 text-xs text-muted-foreground">{label("stateAtFrame", { frame: selectedFrame })}</p>}
                            <p className="continuity-current-state">{display.value(selected.fact.id, selectedState)}</p><p className="text-xs text-muted-foreground">{label("inheritedHint")}</p>{inheritedEvent ? <Button size="small" type="link" className="mt-1 !h-auto !whitespace-normal !px-0 text-left" onClick={click => {
                                const originView = viewFor(String(inheritedEvent.fact_id), String(inheritedEvent.shot_id));
                                if (originView?.markers.some(marker => marker.event.id === inheritedEvent.id) && visibleShots.some(shot => shot.id === inheritedEvent.shot_id)) selectMarker(String(inheritedEvent.fact_id), String(inheritedEvent.shot_id), String(inheritedEvent.id), click.currentTarget);
                                else actions.openEntry("events", inheritedEvent);
                            }}>{inheritedOrigin?.invalid ? label("unlocatedOrigin", { shot: display.target(String(inheritedEvent.shot_id)) }) : label("inheritedFrom", { shot: display.target(String(inheritedEvent.shot_id)), frame: continuityLocalFrame(inheritedEvent, adaptedShots.find(shot => shot.id === inheritedEvent.shot_id)!) })}</Button> : <p className="mt-2 text-xs text-muted-foreground">{label("fromInitial", { timeline: display.timeline(timelineId) })}</p>}
                            {!inline && selected.view.markers.length > 0 && <div className="continuity-shot-changes"><p className="text-xs text-muted-foreground">{label("shotChanges", { count: selected.view.markers.length })}</p>{selected.view.markers.map(marker => <button key={marker.event.id} type="button" className="continuity-change-row" disabled={disabled} title={label("clickToEdit")} onClick={() => selectInspectorEvent(String(selected.fact.id), String(selected.shot.id), String(marker.event.id), marker.frame)}><small>{label("localFrameOnly", { frame: marker.frame })}</small><span>{markerText(String(selected.fact.id), marker)}</span></button>)}</div>}
                            {!inline && <details className="mt-4 text-xs"><summary>{label("editTimelineInitial")}</summary><p className="my-2 text-muted-foreground">{label("initialScope")}</p><Select size="small" className="w-full" disabled={disabled} value={initial?.value} placeholder={t("director.workspace.continuity.stateUnknown")} options={initialValues.map(value => ({ value, label: display.value(selected.fact.id, value) }))} onChange={setInitial} /></details>}
                        </>}
                        {!changeDraft && !event && editable && <Button data-continuity-add-here type="primary" size="small" icon={<Plus size={13} />} disabled={disabled || (!inline && continuityTrackInsertFrame(selected.view) === undefined)} title={label(inline ? "addHere" : "addHereInspector")} onClick={() => inline ? beginInlineChange(String(selected.fact.id), String(selected.shot.id), selectedFrame) : beginInspectorChange(String(selected.fact.id), String(selected.shot.id))}>{label("addHere")}</Button>}
                        {!inline && <details className="mt-4 text-xs text-muted-foreground"><summary>{label("reportSeparation")}</summary><p className="mt-2">{label("previewNotReport")}</p><p>{label("rangeHint")}</p></details>}
                    </>}
    </>;
    const renderFooter = (inline = false) => <footer>{changeDraft ? <div key="new-change-actions" className="flex flex-wrap gap-2"><Button type="primary" size="small" aria-describedby={draftHintId} loading={creating} disabled={disabled || creating || Boolean(draftError) || !changeDraft.after} onClick={() => void submitChange()}>{label("applyChange")}</Button><Button size="small" disabled={creating} onClick={() => { if (!creating) onChangeDraft(undefined); }}>{label("cancelChange")}</Button></div> : editable && canRestore && (event || !inline) && <div><Button size="small" icon={<RotateCcw size={12} />} disabled={disabled} title={label("restoreEntry")} onClick={restoreSelected}>{label("restoreAction")}</Button></div>}<p id={changeDraft ? draftHintId : undefined} role="status" aria-live="polite" title={changeDraft ? draftHintText : label(dirty ? "draftDirty" : editable ? "draftSaved" : "published")}>{changeDraft ? draftHintText : label(dirty ? "footerDirty" : editable ? "footerSaved" : "published")}</p></footer>;
    const inlineFrame = changeDraft && changeDraft.frame.trim() && Number.isInteger(Number(changeDraft.frame)) ? Number(changeDraft.frame) : event && Number.isFinite(eventFrame) ? eventFrame : inlinePoint?.frame || 0;
    const inlinePosition = selected ? Math.min(Number(selected.shot.duration_frames) - 1, Math.max(0, inlineFrame)) / Number(selected.shot.duration_frames) : 0;
    const renderInline = (fact: Row, shot: Row) => {
        if (!inlinePoint || !inlineOpen || inlinePoint.factId !== fact.id || inlinePoint.shotId !== shot.id) return null;
        return <Popover ref={inlinePopover} open trigger={[]} placement="right" align={{ offset: [0, 0] }} autoAdjustOverflow classNames={{ root: "continuity-inline-popover" }} afterOpenChange={open => { if (open) (changeDraft ? inlineBody.current?.querySelector<HTMLElement>("[data-continuity-frame-slider]") : inlineBody.current)?.focus({ preventScroll: true }); }} content={
            <div ref={inlineBody} className="continuity-inline-editor" data-continuity-inline-editor role="dialog" aria-modal="false" aria-label={label("inlineTitle")} tabIndex={-1} onKeyDown={key => { if (key.key === "Escape" && !key.defaultPrevented && (key.target as HTMLElement).getAttribute("aria-expanded") !== "true") { key.stopPropagation(); closeInline(true); } }}>
                <header><div><strong>{display.fact(String(fact.id))}</strong><small>{display.target(String(shot.id))} · {label("localFrameOnly", { frame: changeDraft ? changeDraft.frame : event && Number.isFinite(eventFrame) ? eventFrame : inlinePoint.frame })}</small></div>
                    {event && !changeDraft && editable && <Button danger type="text" size="small" disabled={disabled} title={t("director.workspace.continuity.removeEntry")} aria-label={t("director.workspace.continuity.removeEntry")} icon={<Trash2 size={14} />} onClick={deleteSelectedEvent} />}
                    <Button type="text" size="small" aria-label={label("closeInline")} title={label("closeInline")} icon={<X size={15} />} onClick={() => closeInline(true)} />
                </header>
                <div className="continuity-inline-body">{renderEditor(true)}</div>
                {renderFooter(true)}
            </div>
        }><span className="continuity-inline-anchor" aria-hidden="true" style={{ left: `${inlinePosition * 100}%` }} /></Popover>;
    };
    const renderTrack = (fact: Row, shot: Row) => {
        const view = viewFor(String(fact.id), String(shot.id));
        if (!view?.timelineWindows.length) return <div key={shot.id} className="continuity-track-cell continuity-track-empty" data-continuity-empty={`${fact.id}:${shot.id}`} />;
        const lanes = continuityMarkerLanes(view.markers), extra = Math.max(0, ...lanes) * 20;
        return <div key={shot.id} className={`continuity-track-cell ${view.contextOnly ? "is-context-only" : ""} ${selected?.fact.id === fact.id && selected?.shot.id === shot.id ? "is-selected" : ""}`}>
            <button type="button" data-continuity-inline-trigger data-continuity-track={`${fact.id}:${shot.id}`} className="continuity-track-hit" disabled={Boolean(changeDraft) || creating} onClick={click => { const box = click.currentTarget.getBoundingClientRect(); openTrack(String(fact.id), String(shot.id), click.currentTarget, click.detail === 0 ? undefined : (click.clientX - box.left) / box.width); }} aria-label={`${display.fact(fact.id)} · ${display.target(shot.id)} · ${display.value(fact.id, view.segments[0]?.value)}${view.contextOnly ? ` · ${label("appearanceUnregistered")}` : ""}`}>
                {view.segments.map((segment, index) => <span key={`${segment.start}:${index}`} className={`continuity-state-line ${segment.value === "unknown" ? "is-unknown" : ""}`} style={{ left: `${segment.start / view.duration * 100}%`, width: `${(segment.end - segment.start) / view.duration * 100}%` }} title={`${display.value(fact.id, segment.value)} · ${segment.start}–${segment.end - 1}`} />)}
                {view.segments.filter(segment => segment.start === segment.windowStart && (segment.start > 0 || !view.continuous)).map((segment, index) => <span key={index} className="continuity-origin" style={{ left: `${segment.start / view.duration * 100}%` }} title={display.value(fact.id, segment.value)}>{!view.markers.length ? display.value(fact.id, segment.value) : ""}</span>)}
            </button>
            {editable && <button type="button" data-continuity-inline-trigger data-continuity-add={`${fact.id}:${shot.id}`} className={`continuity-track-add ${continuityTrackInsertFrame(view) === undefined ? "is-full" : ""}`} disabled={disabled || Boolean(changeDraft) || creating || continuityTrackInsertFrame(view) === undefined} title={continuityTrackInsertFrame(view) === undefined ? label("noFreeFrame") : label("addInShot", { shot: display.target(shot.id), fact: display.fact(fact.id) })} aria-label={label("addInShot", { shot: display.target(shot.id), fact: display.fact(fact.id) })} onClick={click => { const frame = continuityTrackInsertFrame(view); if (frame !== undefined) beginInlineChange(String(fact.id), String(shot.id), frame, click.currentTarget); }}><Plus size={13} /></button>}
            {inlinePoint && inlineOpen && inlinePoint.factId === fact.id && inlinePoint.shotId === shot.id && <span className="continuity-selected-position" style={{ left: `${inlinePosition * 100}%` }} />}
            {renderInline(fact, shot)}
            {view.markers.map((marker, index) => <Fragment key={marker.event.id}>
                <button type="button" className={`continuity-event-pin ${marker.conflict || marker.duplicate ? "is-conflict" : ""}`} style={{ left: `${marker.position * 100}%`, top: 9 + lanes[index] * 20 } as CSSProperties} title={`${display.target(shot.id)} · ${frameText(marker, view)} · ${markerText(fact.id, marker)}`} aria-label={`${display.target(shot.id)} · ${frameText(marker, view)} · ${markerText(fact.id, marker)}`} data-continuity-event={marker.event.id} data-continuity-inline-trigger disabled={Boolean(changeDraft) || creating} onClick={click => selectMarker(String(fact.id), String(shot.id), String(marker.event.id), click.currentTarget)}><span /></button>
                <button type="button" className={`continuity-event-label ${event?.id === marker.event.id ? "is-selected" : ""} ${marker.conflict || marker.duplicate ? "is-conflict" : ""}`} style={{ top: 29 + extra + index * 34 }} data-continuity-inline-trigger disabled={Boolean(changeDraft) || creating} onClick={click => selectMarker(String(fact.id), String(shot.id), String(marker.event.id), click.currentTarget)} title={`${markerText(fact.id, marker)} · ${label("clickToEdit")}`}><span>{markerText(fact.id, marker)}</span><small>{frameText(marker, view)}{marker.duplicate ? ` · ${label("duplicate")}` : ""}</small></button>
            </Fragment>)}
        </div>;
    };
    return <section ref={workbenchRoot} className="continuity-live-workbench" data-continuity-timeline>
        <div className="continuity-live-toolbar">
            <div className="flex min-w-0 flex-wrap gap-2">
                <Select disabled={Boolean(changeDraft)} size="small" aria-label={label("timeline")} value={timelineId || undefined} options={timelines.map(row => ({ value: String(row.id), label: display.timeline(String(row.id)) }))} onChange={value => { setInlinePoint(undefined); setTimelineFilter(value); setSceneFilter("all"); setSelection(undefined); }} style={{ minWidth: 135, maxWidth: 240 }} />
                <Select disabled={Boolean(changeDraft)} size="small" aria-label={label("scene")} value={sceneFilter} options={[{ value: "all", label: t("director.workspace.continuity.filterAllScenes") }, ...scenes.filter(scene => scene.shotIds.some(id => fullShots.some(shot => shot.id === id))).map(scene => ({ value: scene.id, label: scene.title }))]} onChange={value => { setInlinePoint(undefined); setSceneFilter(value); setSelection(undefined); }} style={{ minWidth: 110, maxWidth: 210 }} />
                <Select disabled={Boolean(changeDraft)} size="small" aria-label={label("subject")} value={subjectFilter} options={[{ value: "all", label: t("director.workspace.continuity.filterAllObjects") }, ...subjects.map(subject => ({ value: String(subject.id), label: subjectName(subject) }))]} onChange={value => { setInlinePoint(undefined); setSubjectFilter(value); setSelection(undefined); }} style={{ minWidth: 105, maxWidth: 180 }} />
            </div><div className="flex flex-wrap gap-1"><Button size="small" type={changeOnly ? "primary" : "default"} aria-pressed={changeOnly} onClick={() => setChangeOnly(!changeOnly)}>{label("changesOnly")}</Button><Button size="small" type={unknownOnly ? "primary" : "default"} aria-pressed={unknownOnly} onClick={() => setUnknownOnly(!unknownOnly)}>{label("unknownOnly")}</Button><Button size="small" type={showClips ? "primary" : "default"} aria-pressed={showClips} onClick={() => setShowClips(!showClips)}>{label("clipGroups")}</Button></div>
        </div>
        <div className="continuity-live-layout">
            <div className="continuity-live-timeline">
                <div className="continuity-grid-caption"><span>{label("inlineHint")}</span><div>{hiddenEvents.length > 0 && <Button size="small" type="text" onClick={() => actions.openEntry("events", hiddenEvents[0])}>{label("hiddenEvents", { count: hiddenEvents.length })}</Button>}<Button size="small" type="text" onClick={() => setExpanded(expanded.size ? new Set() : new Set(subjects.map(subject => String(subject.id))))}>{label(expanded.size ? "collapseAll" : "expandAll")}</Button></div></div>
                <div className="continuity-grid-scroll" tabIndex={0} aria-label={label("grid")}> <div className="continuity-grid" style={{ "--continuity-columns": visibleShots.length } as CSSProperties}>
                    <div className="continuity-grid-row continuity-ruler"><div className="continuity-label-cell">{label("subjectProperty")}</div>{visibleShots.map(shot => {
                        const clips = records(source.segments), clipIndex = clips.findIndex(clip => (clip.shot_ids || []).includes(shot.id)), clip = clips[clipIndex], nextClip = clips[clipIndex + 1];
                        const boundary = showClips && clip && nextClip && clip.shot_ids?.at(-1) === shot.id;
                        return <div key={shot.id} className="relative min-w-0"><button type="button" disabled={Boolean(changeDraft) || creating} className={`continuity-shot-head h-full w-full ${selected?.shot.id === shot.id ? "is-selected" : ""}`} onClick={() => setSelection({ shotId: String(shot.id), factId: String(selected?.fact.id || "") })}><small className="pr-5">{showClips && clip ? display.clip(String(clip.id)) : ""}</small><strong title={display.target(shot.id)}>{display.target(shot.id)}</strong><span>{label("duration", { frames: shot.duration_frames })}</span><span className="continuity-axis"><i>0</i><i>{shot.duration_frames}</i></span></button>{boundary && <button type="button" className="absolute right-1 top-1 flex size-6 items-center justify-center rounded hover:bg-muted" title={`${display.clip(String(clip.id))} → ${display.clip(String(nextClip.id))} · ${t("director.workspace.continuity.crud.clipContext")}`} aria-label={`${display.clip(String(clip.id))} → ${display.clip(String(nextClip.id))} · ${t("director.workspace.continuity.crud.clipContext")}`} onClick={() => actions.openBoundary(String(clip.id))}><ChevronRight className="size-3.5" /></button>}</div>;
                    })}</div>
                    {groups.map(({ subject, facts: subjectFacts }) => {
                        const open = expanded.has(String(subject.id));
                        const eventCount = (shot: Row) => subjectFacts.flatMap(fact => viewFor(String(fact.id), String(shot.id))?.markers.map(marker => ({ marker, fact })) || []).sort((a, b) => a.marker.frame - b.marker.frame);
                        const max = Math.max(0, ...visibleShots.map(shot => eventCount(shot).length));
                        return <Fragment key={subject.id}><div className="continuity-grid-row continuity-subject-row" style={{ minHeight: open ? 43 : 43 + Math.max(0, max - 1) * 26 }}><div className="continuity-label-cell"><button type="button" className="continuity-subject-toggle" onClick={() => setExpanded(current => { const next = new Set(current); if (next.has(String(subject.id))) next.delete(String(subject.id)); else next.add(String(subject.id)); return next; })} aria-expanded={open}><span>{subjectName(subject)}</span>{open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</button></div>{visibleShots.map(shot => {
                            const usage = continuityUsage(shot, String(subject.id)), events = eventCount(shot);
                            const showOrigin = subjectFacts.some(fact => !viewFor(String(fact.id), String(shot.id))?.continuous);
                            if (!usage.usages.length) return <div key={shot.id} className="continuity-presence-cell continuity-track-empty" />;
                            if (usage.contextual.length) return <div key={shot.id} className="continuity-presence-cell continuity-context-cell" title={label("appearanceUnregistered")}><span className="continuity-presence-label">{label("appearanceUnregistered")}</span>{events.length > 0 && <span className="continuity-change-count">{label("changeCount", { count: events.length })}</span>}</div>;
                            if (!usage.windows.length) return <div key={shot.id} className="continuity-presence-cell continuity-light-usage">{usage.light.map(kind => label(kind)).join(" · ")}</div>;
                            return <div key={shot.id} className="continuity-presence-cell"><span className="continuity-presence-label">{label("visible")}</span>{open ? events.length > 0 && <span className="continuity-change-count">{label("changeCount", { count: events.length })}</span> : events.length ? events.map(({ marker, fact }, index) => <button key={marker.event.id} className="continuity-collapsed-event" style={{ top: 13 + index * 26 }} type="button" data-continuity-inline-trigger disabled={Boolean(changeDraft) || creating} onClick={click => selectMarker(String(fact.id), String(shot.id), String(marker.event.id), click.currentTarget)} title={`${display.fact(fact.id)} · ${markerText(fact.id, marker)}`}><span>{markerText(fact.id, marker)}</span><small>f{marker.frame}</small><i style={{ left: `${marker.position * 100}%` }} /></button>) : <span className="continuity-collapsed-state" title={subjectFacts.map(fact => display.value(fact.id, viewFor(String(fact.id), String(shot.id))?.segments.at(-1)?.value)).join(" · ")}>{showOrigin ? subjectFacts.map(fact => display.value(fact.id, viewFor(String(fact.id), String(shot.id))?.segments.at(-1)?.value)).join(" · ") : "―"}</span>}</div>;
                        })}</div>{open && subjectFacts.map(fact => {
                            const height = Math.max(52, ...visibleShots.map(shot => { const markers = viewFor(String(fact.id), String(shot.id))?.markers || []; return markers.length ? 65 + (markers.length - 1) * 34 + Math.max(0, ...continuityMarkerLanes(markers)) * 20 : 52; }));
                            const target = rowInsertTarget(String(fact.id));
                            return <div key={fact.id} className="continuity-grid-row" style={{ height }}><div className="continuity-label-cell continuity-fact-label" title={display.fact(String(fact.id))}><span className="continuity-fact-name">{shortFact(fact)}</span>{editable && <button type="button" data-continuity-row-add className="continuity-row-add" disabled={disabled || Boolean(changeDraft) || creating || !target} title={target ? label("addChangeRowAt", { shot: display.target(target.shotId), frame: target.frame }) : label("addChangeRowFull")} aria-label={target ? label("addChangeRowAt", { shot: display.target(target.shotId), frame: target.frame }) : label("addChangeRowFull")} onClick={() => target && beginInlineChange(String(fact.id), target.shotId, target.frame)}><Plus size={12} /></button>}</div>{visibleShots.map(shot => renderTrack(fact, shot))}</div>;
                        })}</Fragment>;
                    })}
                    {!groups.length && <p className="continuity-empty">{label("empty")}</p>}
                </div></div>
                <div className="continuity-legend"><span>━ {label("held")}</span><span>◆ {label("change")}</span><span>{label("presenceHint")}</span><span>{label("appearanceUnregistered")}</span></div>
                {selected && <div className="continuity-story-context"><strong>{display.target(selected.shot.id)}</strong><span>{context?.title}</span><p>{String(selected.shot.visual || selected.shot.description || context?.text || "")}</p></div>}
            </div>
            <aside className="continuity-live-inspector" aria-label={label("inspector")}>
                <header>{selected && <Button className="float-right" type="text" size="small" onClick={() => actions.openEntry("facts", selected.fact)}>{t("director.workspace.continuity.crud.stateDefinition")}</Button>}<h3>{selected ? display.fact(String(selected.fact.id)) : label("emptySelection")}</h3>{selected && <p>{display.target(String(selected.shot.id))}{!changeDraft && event && Number.isFinite(eventFrame) ? ` · ${label("localFrameOnly", { frame: eventFrame })}` : ""}</p>}</header>
                <div ref={inspectorBody} className="continuity-inspector-body">
                    {!inlineOpen && changeDraft && <Button className="mb-3" size="small" data-continuity-resume onClick={() => { const frame = Number(changeDraft.frame); setInlinePoint({ factId: changeDraft.factId, shotId: changeDraft.shotId, frame: Number.isInteger(frame) ? frame : 0 }); const subject = owner.get(changeDraft.factId); if (subject) setExpanded(previous => new Set(previous).add(String(subject.id))); }}>{label("continueInline")}</Button>}
                    {inlineOpen ? <><p className="text-sm text-muted-foreground">{label("editingInline")}</p><Button size="small" onClick={() => inlineBody.current?.focus({ preventScroll: true })}>{label("continueInline")}</Button></> : renderEditor(false)}
                </div>
                {!inlineOpen && renderFooter()}
            </aside>
        </div>
    </section>;
}
