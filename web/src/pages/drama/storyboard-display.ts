import { records, readableText } from "./director-display";
import { subjectDisplayName } from "./subject-shot-draft";
type Row = Record<string, any>;

export function storyboardDurationFrames(shot: Row) {
    return Number(shot.duration_frames ?? Number(shot.end_frame) - Number(shot.start_frame));
}
export function storyboardPeople(source: Row, shot: Row, subjects: boolean) {
    if (subjects) return records(shot.subject_usages).map(usage => subjectDisplayName(source, String(usage.subjectId)));
    return (Array.isArray(shot.characters) ? shot.characters : []).map((character: any) => {
        const id = typeof character === "string" ? character : character?.id || character?.character_id;
        return String(character?.name || records(source.character_registry).find(row => row.id === id)?.name || id || "");
    }).filter(Boolean);
}
export function storyboardLegacyState(value: unknown) {
    if (!value) return [];
    if (typeof value !== "object" || Array.isArray(value)) return [{ factId: "state", description: readableText(value) }];
    return Object.entries(value).map(([factId, state]) => ({ factId, property: factId, description: readableText(state) || JSON.stringify(state) }));
}


export function storyboardReportedState(continuity: Row | undefined, shotId: string) {
    if (!continuity || continuity.stale !== false) return { start: [], end: [], unresolved: [] };
    const trajectory = continuity.trajectories?.[shotId];
    const facts = records(continuity.facts);
    const phase = (key: string) => Object.entries(trajectory?.[key] || {}).filter(([, value]) => value !== "unknown").map(([factId, value]) => ({ factId, value, property: facts.find(fact => fact.id === factId)?.name || factId }));
    return { start: phase("start"), end: phase("end"), unresolved: [] };
}
