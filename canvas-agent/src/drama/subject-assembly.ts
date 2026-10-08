import { isSubjectPromptAssembly } from "./production-contract.js";

type Row = Record<string, any>;
const rows = (value: unknown): Row[] => Array.isArray(value) ? value.filter(item => item && typeof item === "object" && !Array.isArray(item)) : [];
const entityKey = (kind: unknown, id: unknown) => `${String(kind || "")}:${String(id || "")}`;

export type SubjectShotWindow = { shotId: string; timelineId: string; startFrame: number; endFrame: number };
export function subjectShotWindows(source: Record<string, unknown>): Map<string, SubjectShotWindow> {
    const result = new Map<string, SubjectShotWindow>();
    if (!isSubjectPromptAssembly(source)) {
        for (const shot of rows(source.shots)) result.set(String(shot.id), { shotId: String(shot.id), timelineId: String(shot.timeline_id || ""), startFrame: Number(shot.start_frame), endFrame: Number(shot.end_frame) });
        return result;
    }
    const origins = new Map(rows((source.ledger as Row | undefined)?.timelines).map(timeline => [String(timeline.id), Number.isInteger(timeline.start_frame) ? Number(timeline.start_frame) : 0]));
    const byTimeline = new Map<string, Row[]>();
    for (const shot of rows(source.shots)) {
        const timelineId = String(shot.timeline_id || "");
        const list = byTimeline.get(timelineId) || []; list.push(shot); byTimeline.set(timelineId, list);
    }
    for (const [timelineId, shots] of byTimeline) {
        let cursor = origins.get(timelineId) || 0;
        for (const shot of shots.sort((a, b) => Number(a.story_order) - Number(b.story_order))) {
            const startFrame = cursor;
            cursor += Number(shot.duration_frames);
            result.set(String(shot.id), { shotId: String(shot.id), timelineId, startFrame, endFrame: cursor });
        }
    }
    return result;
}

export type SubjectShotState = { start: Array<Record<string, unknown>>; end: Array<Record<string, unknown>>; unresolved: Array<Record<string, unknown>> };
/** Read-only ledger replay for Prompt/UI projection; never writes state snapshots into the source. */
export function subjectStateProjection(source: Record<string, unknown>): Record<string, SubjectShotState> {
    const ledger = source.ledger as Row | undefined;
    if (!isSubjectPromptAssembly(source) || ledger?.contract_version !== 2) return {};
    const subjects = rows(source.subject_registry), facts = rows(ledger.facts), events = rows(ledger.events), initial = rows(ledger.initial);
    const subjectByEntity = new Map(subjects.map(subject => [entityKey(subject.entityRef?.kind, subject.entityRef?.id), String(subject.id)]));
    const factsById = new Map(facts.map(fact => [String(fact.id), fact]));
    const ownerByFact = new Map(facts.map(fact => [String(fact.id), subjectByEntity.get(entityKey(fact.object_kind, fact.object_id))]));
    const windows = subjectShotWindows(source), shots = rows(source.shots), byTimeline = new Map<string, Row[]>(), output: Record<string, SubjectShotState> = {};
    for (const shot of shots) {
        const timelineId = String(shot.timeline_id || ""), list = byTimeline.get(timelineId) || [];
        list.push(shot); byTimeline.set(timelineId, list);
    }
    for (const [timelineId, stream] of byTimeline) {
        const state = new Map<string, string>();
        for (const item of initial.filter(row => row.timeline_id === timelineId)) state.set(String(item.fact_id), String(item.value));
        const orderedEvents = events.filter(event => event.timeline_id === timelineId).sort((a, b) => {
            const aw = windows.get(String(a.shot_id)), bw = windows.get(String(b.shot_id));
            return (Number(aw?.startFrame || 0) + Number(a.local_frame || 0)) - (Number(bw?.startFrame || 0) + Number(b.local_frame || 0)) || String(a.id).localeCompare(String(b.id));
        });
        const eventsByShot = new Map<string, Row[]>();
        for (const event of orderedEvents) { const list = eventsByShot.get(String(event.shot_id)) || []; list.push(event); eventsByShot.set(String(event.shot_id), list); }
        for (const shot of stream.sort((a, b) => Number(a.story_order) - Number(b.story_order))) {
            const shotId = String(shot.id), usedSubjectIds = new Set<string>(), usedFactIds = new Set<string>((shot.continuity_facts || []).map(String));
            for (const usage of rows(shot.subject_usages)) {
                usedSubjectIds.add(String(usage.subjectId));
                for (const factId of usage.continuityFactIds || []) usedFactIds.add(String(factId));
            }
            for (const [factId, ownerId] of ownerByFact) if (ownerId && usedSubjectIds.has(ownerId)) usedFactIds.add(factId);
            const project = () => [...usedFactIds].sort().flatMap(factId => {
                const fact = factsById.get(factId), value = state.get(factId);
                if (!fact || value === undefined || value === "unknown") return [];
                const subjectId = ownerByFact.get(factId);
                const description = fact.value_descriptions?.[value];
                return [{ subjectId, factId, property: fact.property || fact.name || factId, value, description: typeof description === "string" ? description : undefined }];
            });
            const unresolved = [...usedFactIds].filter(factId => !factsById.has(factId) || !state.has(factId) || state.get(factId) === "unknown").map(factId => ({ subjectId: ownerByFact.get(factId), factId, code: "CONTINUITY_STATE_UNRESOLVED" }));
            const start = project();
            for (const event of eventsByShot.get(shotId) || []) state.set(String(event.fact_id), String(event.after));
            output[shotId] = { start, end: project(), unresolved };
        }
    }
    return output;
}
