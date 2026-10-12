import { directorSourceV2Diagnostics, productionSceneEntries } from "@basketikun/canvas-agent/drama/production-contract";
import { subjectShotWindows } from "@basketikun/canvas-agent/drama/subject-assembly";
import { records } from "./director-display";

export type ContinuityRow = Record<string, any>;
export type ContinuityWindow = { start: number; end: number };
export type ContinuityMarker = { event: ContinuityRow; frame: number; position: number; prior: string; after: string; conflict: boolean; duplicate: boolean; invalid: boolean };
export type ContinuityStateSpan = ContinuityWindow & { value: string };
export type ContinuityTrack = { shot: ContinuityRow; before: string; after: string; segments: ContinuityStateSpan[]; markers: ContinuityMarker[]; invalidEvents: ContinuityRow[] };
const id = (value: unknown) => String(value ?? "");
export const continuityEntityKey = (kind: unknown, value: unknown) => `${id(kind)}:${id(value)}`;

function legacyReferencesFact(shot: ContinuityRow, fact: ContinuityRow) {
    const objectKind = id(fact.object_kind), objectId = id(fact.object_id);
    const refs = (value: unknown) => Array.isArray(value) ? value.map(row => id(typeof row === "string" ? row : row?.id || row?.asset_id)) : [];
    if (Array.isArray(shot.continuity_facts) && shot.continuity_facts.some((row: unknown) => id(typeof row === "string" ? row : (row as ContinuityRow)?.fact_id || (row as ContinuityRow)?.id) === id(fact.id))) return true;
    if (objectKind === "character" && refs(shot.characters).includes(objectId)) return true;
    if (objectKind === "character" && Array.isArray(shot.dialogues) && shot.dialogues.some((row: unknown) => id(typeof row === "string" ? row : (row as ContinuityRow)?.speaker_id || (row as ContinuityRow)?.character_id) === objectId)) return true;
    if (objectKind === "scene" && id(shot.scene_id) === objectId) return true;
    if (objectKind === "asset" && [...refs(shot.required_assets), ...refs(shot.required_prop_ids)].includes(objectId)) return true;
    return false;
}

/**
 * View-only compatibility projection for v1 production sources with a real v2
 * ledger. Ledger object identity is authoritative; old Shot references only
 * establish a contextual association, never visible presence.
 */
export function continuityWorkbenchSource(source: ContinuityRow, ledger: ContinuityRow, input: ContinuityRow[] = records(source.shots)): ContinuityRow {
    if (ledger.contract_version !== 2) return source;
    const timelineIds = records(ledger.timelines).map(row => id(row.id)).filter(Boolean);
    const defaultTimelineId = timelineIds.includes("main") ? "main" : timelineIds[0] || "main";
    const nextOrder = new Map<string, number>(), occupied = new Map<string, Set<number>>();
    const shotsWithDefaults: ContinuityRow[] = input.map((shot: ContinuityRow): ContinuityRow => {
        const timelineId = id(shot.timeline_id) || defaultTimelineId;
        const used = occupied.get(timelineId) || new Set<number>();
        let storyOrder = Number.isInteger(shot.story_order) && Number(shot.story_order) >= 0 ? Number(shot.story_order) : nextOrder.get(timelineId) || 0;
        if (!Number.isInteger(shot.story_order) || Number(shot.story_order) < 0) while (used.has(storyOrder)) storyOrder++;
        used.add(storyOrder); occupied.set(timelineId, used);
        nextOrder.set(timelineId, Math.max(nextOrder.get(timelineId) || 0, storyOrder + 1));
        return { ...shot, timeline_id: timelineId, story_order: storyOrder };
    });
    const projectedLedger = timelineIds.length ? ledger : { ...ledger, timelines: [{ id: defaultTimelineId, start_frame: 0 }] };
    if (source.prompt_assembly?.version === 2) return { ...source, ledger: projectedLedger, shots: shotsWithDefaults };
    const subjects = records(source.subject_registry).map(row => ({ ...row }));
    const subjectByEntity = new Map(subjects.map(subject => [continuityEntityKey(subject.entityRef?.kind, subject.entityRef?.id), subject]));
    const registries: Record<string, ContinuityRow[]> = {
        character: records(source.character_registry),
        scene: records(source.scene_registry),
        asset: records(source.asset_plan),
    };
    const projectedFacts = records(ledger.facts).map(fact => {
        const key = continuityEntityKey(fact.object_kind, fact.object_id);
        let subject = subjectByEntity.get(key);
        if (!subject) {
            const kind = id(fact.object_kind), objectId = id(fact.object_id), existing = registries[kind]?.find(row => id(row.id || row.asset_id) === objectId);
            subject = {
                id: `legacy:${key}`,
                entityRef: { kind, id: objectId },
                display_name: id(existing?.name || existing?.asset_name || existing?.scene_name || existing?.title) || (objectId ? `${kind || "object"}:${objectId}` : "object:missing-id"),
                legacyProjection: true,
                legacyUnregistered: !existing,
                legacyObjectId: objectId,
            };
            subjects.push(subject); subjectByEntity.set(key, subject);
        }
        return { fact, subject };
    });
    const events = records(ledger.events);
    const shots: ContinuityRow[] = shotsWithDefaults.map((shot: ContinuityRow): ContinuityRow => {
        const usages = records(shot.subject_usages).map(row => ({ ...row }));
        const duration = Number(shot.duration_frames ?? Number(shot.end_frame) - Number(shot.start_frame));
        if (Number.isInteger(duration) && duration > 0) for (const { fact, subject } of projectedFacts) {
            const alreadyDeclared = usages.some(usage => id(usage.subjectId) === id(subject.id));
            const eventBound = events.some(event => id(event.shot_id) === id(shot.id) && id(event.fact_id) === id(fact.id));
            if (!alreadyDeclared && (eventBound || legacyReferencesFact(shot, fact))) usages.push({
                subjectId: subject.id, presentation: "state_context", localStartFrame: 0, localEndFrame: duration,
                continuityDisplay: "unregistered",
            });
        }
        return { ...shot, subject_usages: usages };
    });
    return { ...source, subject_registry: subjects, shots };
}

/** A view-only adapter. Absolute windows are derived, never written to v2 Shots. */
export function continuityTimelineShots(source: ContinuityRow, ledger: ContinuityRow, input = records(source.shots)): ContinuityRow[] {
    const windows = subjectShotWindows({ ...source, ledger, shots: input });
    return input.map(shot => {
        const window = windows.get(id(shot.id));
        return { ...shot, start_frame: window?.startFrame ?? shot.start_frame, end_frame: window?.endFrame ?? shot.end_frame,
            duration_frames: shot.duration_frames ?? Number(shot.end_frame) - Number(shot.start_frame) };
    });
}
export function orderedContinuityShots(shots: ContinuityRow[], timelineId: string) {
    return shots.filter(shot => id(shot.timeline_id) === timelineId).slice().sort((a, b) =>
        Number(a.story_order ?? a.start_frame) - Number(b.story_order ?? b.start_frame) || id(a.id).localeCompare(id(b.id)));
}
export function continuityLocalFrame(event: ContinuityRow, shot: ContinuityRow) {
    if (event.local_frame !== undefined) return Number.isInteger(event.local_frame) ? Number(event.local_frame) : NaN;
    return Number.isInteger(event.frame) ? Number(event.frame) - Number(shot.start_frame) : NaN;
}

/** Legal sources mirror continuity_v2.py, including explicit unknown -> known recovery.
 * Invalid frame drafts are conservatively unknown because they cannot be positioned.
 * This authored preview never replaces a scoped Backend report. */
export function replayContinuityFact(ledger: ContinuityRow, shots: ContinuityRow[], timelineId: string, factId: string): ContinuityTrack[] {
    let value = id(records(ledger.initial).filter(row => id(row.timeline_id) === timelineId && id(row.fact_id) === factId).at(-1)?.value || "unknown");
    const events = records(ledger.events).filter(event => id(event.timeline_id) === timelineId && id(event.fact_id) === factId);
    return orderedContinuityShots(shots, timelineId).map(shot => {
        const before = value, duration = Number(shot.duration_frames ?? Number(shot.end_frame) - Number(shot.start_frame));
        const changes = events.filter(event => id(event.shot_id) === id(shot.id)).slice().sort((a, b) =>
            (continuityLocalFrame(a, shot) - continuityLocalFrame(b, shot) || id(a.id).localeCompare(id(b.id))));
        const segments: ContinuityStateSpan[] = [], markers: ContinuityMarker[] = [], invalidEvents: ContinuityRow[] = [];
        const frames = new Set<number>(); let cursor = 0;
        for (const event of changes) {
            const frame = continuityLocalFrame(event, shot), invalid = !Number.isInteger(frame) || frame < 0 || frame >= duration;
            if (!invalid && frame > cursor) segments.push({ start: cursor, end: frame, value });
            const prior = value, conflict = prior !== event.before, duplicate = frames.has(frame);
            value = conflict ? "unknown" : id(event.after || "unknown");
            if (invalid) { invalidEvents.push(event); value = "unknown"; }
            else { markers.push({ event, frame, position: frame / duration, prior, after: value, conflict, duplicate, invalid }); cursor = frame; frames.add(frame); }
        }
        if (cursor < duration) segments.push({ start: cursor, end: duration, value });
        // An invalid anchor cannot assign a trustworthy position to either state.
        // Keep the editable event, but never paint its after-value across the Shot.
        if (invalidEvents.length) { segments.splice(0, segments.length, { start: 0, end: duration, value: "unknown" }); value = "unknown"; }
        return { shot, before, after: value, segments, markers, invalidEvents };
    });
}

/** All authored events replay before applying presence/scene filters. */
export function continuityUsage(shot: ContinuityRow, subjectId: string) {
    const duration = Number(shot.duration_frames ?? Number(shot.end_frame) - Number(shot.start_frame));
    const usages = records(shot.subject_usages).filter(usage => id(usage.subjectId) === subjectId);
    const visible = usages.filter(usage => usage.presentation === "visible").map(usage => ({
        start: Number(usage.localStartFrame ?? 0), end: Number(usage.localEndFrame ?? duration),
    })).filter(window => Number.isInteger(window.start) && Number.isInteger(window.end) && window.start >= 0 && window.end <= duration && window.end > window.start)
        .sort((a, b) => a.start - b.start);
    const contextual = usages.filter(usage => usage.presentation === "state_context" && usage.continuityDisplay === "unregistered").map(usage => ({
        start: Number(usage.localStartFrame ?? 0), end: Number(usage.localEndFrame ?? duration),
    })).filter(window => Number.isInteger(window.start) && Number.isInteger(window.end) && window.start >= 0 && window.end <= duration && window.end > window.start)
        .sort((a, b) => a.start - b.start);
    const windows: ContinuityWindow[] = [];
    for (const window of visible) {
        const previous = windows.at(-1);
        if (previous && window.start <= previous.end) previous.end = Math.max(previous.end, window.end); else windows.push({ ...window });
    }
    return { usages, windows, contextual, light: [...new Set(usages.filter(usage => usage.presentation !== "visible" && usage.continuityDisplay !== "unregistered").map(usage => id(usage.presentation)))] };
}
export function visibleContinuityTrack(track: ContinuityTrack, subjectId: string, previous?: ContinuityTrack, adjacent = false) {
    const usage = continuityUsage(track.shot, subjectId), duration = Number(track.shot.duration_frames), timelineWindows = [...usage.windows, ...usage.contextual].sort((a, b) => a.start - b.start);
    const segments = track.segments.flatMap(segment => timelineWindows.flatMap(window => {
        const start = Math.max(segment.start, window.start), end = Math.min(segment.end, window.end);
        return end > start ? [{ ...segment, start, end, windowStart: window.start }] : [];
    }));
    const markers = track.markers.filter(marker => timelineWindows.some(window => marker.frame >= window.start && marker.frame < window.end));
    const previousUsage = previous && continuityUsage(previous.shot, subjectId);
    const previousWindows = previousUsage ? [...previousUsage.windows, ...previousUsage.contextual] : [];
    const continuous = Boolean(adjacent && previous && previousWindows.some(window => window.end === Number(previous.shot.duration_frames)) && timelineWindows.some(window => window.start === 0));
    return { ...track, usage, timelineWindows, contextOnly: usage.windows.length === 0 && usage.contextual.length > 0, segments, markers, continuous, hiddenEvents: track.markers.filter(marker => !markers.includes(marker)).map(marker => marker.event).concat(track.invalidEvents), duration };
}

/** Canonical prior state for event creation/editing, with deterministic same-frame ordering. */
export function continuityPriorState(ledger: ContinuityRow, shots: ContinuityRow[], shotId: string, factId: string, frame: number, excludingEventId?: string) {
    const shot = shots.find(row => id(row.id) === shotId);
    if (!shot) throw new Error("INVALID_EVENT_FRAME");
    const timelineId = id(shot.timeline_id), stream = orderedContinuityShots(shots, timelineId), targetIndex = stream.findIndex(row => id(row.id) === shotId);
    const initial = records(ledger.initial).filter(row => id(row.timeline_id) === timelineId && id(row.fact_id) === factId).at(-1);
    let value = typeof initial?.value === "string" ? initial.value : "unknown", found = Boolean(initial);
    for (const [index, current] of stream.entries()) {
        if (index > targetIndex) break;
        const events = records(ledger.events).filter(event => id(event.id) !== excludingEventId && id(event.timeline_id) === timelineId && id(event.fact_id) === factId && id(event.shot_id) === id(current.id))
            .sort((a, b) => continuityLocalFrame(a, current) - continuityLocalFrame(b, current) || id(a.id).localeCompare(id(b.id)));
        const duration = Number(current.duration_frames ?? Number(current.end_frame) - Number(current.start_frame));
        // No canonical before-state may be created through an unpositioned draft event.
        if (events.some(event => { const local = continuityLocalFrame(event, current); return !Number.isInteger(local) || local < 0 || local >= duration; })) throw new Error("INVALID_EVENT_FRAME");
        for (const event of events) {
            const local = continuityLocalFrame(event, current);
            if (index === targetIndex && local === frame) throw new Error("EVENT_ANCHOR_OCCUPIED");
            if (index === targetIndex && local >= frame) break;
            value = value !== event.before ? "unknown" : id(event.after || "unknown"); found = true;
        }
    }
    if (!found) throw new Error("EVENT_INITIAL_STATE_MISSING");
    return value;
}

export function continuityMarkerLanes(markers: Array<{ position: number }>) {
    const positions: number[] = [];
    return markers.map(marker => { let lane = 0; while (positions[lane] !== undefined && marker.position - positions[lane] < .16) lane++; positions[lane] = marker.position; return lane; });
}

export function continuityPreviewStatus(report: ContinuityRow | undefined, sourceHash: string, dirty: boolean) {
    return dirty ? "unsaved" : report && report.sourceHash && report.sourceHash !== sourceHash ? "stale" : report?.status || "unchecked";
}

/** Only nested evidence blocks currently accepted by the continuity validator. */
export function continuitySourceBlocks(scenes: ContinuityRow[]) {
    return scenes.flatMap(scene => records(scene.blocks).map(block => ({ ...block,
        sceneId: String(scene.scene_id || scene.id), occurrenceId: String(scene.id || scene.scene_id),
        sceneName: String(scene.scene_name || scene.heading || scene.id), sourceBlock: block,
    })));
}
/** Never mix evidence from separate occurrences of the same physical room. */
export function continuityBlocksForShot(source: ContinuityRow, blocks: ContinuityRow[], shot?: ContinuityRow) {
    if (!shot) return blocks;
    const named = String(shot.source_scene_id || "");
    if (named && blocks.some(block => block.occurrenceId === named)) return blocks.filter(block => block.occurrenceId === named);
    const occurrences = productionSceneEntries(source).filter(entry => entry.shotIds.includes(String(shot.id)));
    const ids = new Set(occurrences.map(entry => entry.id));
    return blocks.filter(block => ids.has(block.occurrenceId));
}

/** Reuse the formal contract's technical event-position checks; quality warnings do not gate saves. */
export function continuityEventPositionIssues(source: ContinuityRow, ledger: ContinuityRow) {
    if (source.prompt_assembly?.version !== 2) {
        const shots = records(source.shots), issues: Array<{ path: (string | number)[]; message: string }> = [];
        const shotById = new Map(shots.map(shot => [id(shot.id), shot]));
        for (const [index, event] of records(ledger.events).entries()) {
            const shot = shotById.get(id(event.shot_id));
            if (!shot) { issues.push({ path: ["ledger", "events", index, "shot_id"], message: "Unknown Shot" }); continue; }
            const local = continuityLocalFrame(event, shot), duration = Number(shot.duration_frames ?? Number(shot.end_frame) - Number(shot.start_frame));
            if (!Number.isInteger(local) || local < 0 || local >= duration) issues.push({ path: ["ledger", "events", index, Number.isInteger(event.local_frame) ? "local_frame" : "frame"], message: "Event frame is outside the Shot" });
        }
        return issues;
    }
    // Position checks must still run if an unrelated registry draft fails early schema parsing.
    return directorSourceV2Diagnostics({ ...source, subject_registry: [], utterances: [], ledger }).filter(issue => issue.path[0] === "ledger" && issue.path[1] === "events" && ["local_frame", "shot_id"].includes(String(issue.path[3])));
}

/** Shared adapter for legacy-shaped read views of a v2 authored ledger. */
export function continuityReadProjection(source: ContinuityRow, ledger: ContinuityRow, input = records(source.shots)) {
    const shots = continuityTimelineShots(source, ledger, input);
    const trajectories: Record<string, { timelineId: string; start: Record<string, string>; end: Record<string, string> }> = {};
    const eventStates: Record<string, string> = {};
    for (const timelineId of new Set(shots.map(shot => id(shot.timeline_id)))) {
        for (const fact of records(ledger.facts)) for (const track of replayContinuityFact(ledger, shots, timelineId, id(fact.id))) {
            const row = trajectories[id(track.shot.id)] ||= { timelineId, start: {}, end: {} };
            row.start[id(fact.id)] = track.before; row.end[id(fact.id)] = track.after;
            for (const marker of track.markers) eventStates[id(marker.event.id)] = track.invalidEvents.length ? "unknown" : marker.after;
            for (const event of track.invalidEvents) eventStates[id(event.id)] = "unknown";
        }
    }
    return { trajectories, eventStates };
}
