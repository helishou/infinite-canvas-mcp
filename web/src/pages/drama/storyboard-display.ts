import { productionSceneEntries } from "@basketikun/canvas-agent/drama/production-contract";
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

/** Use narrative occurrences, never merge shots merely because their environment is shared. */
export function storyboardScenes(source: Row) {
    const scenes = productionSceneEntries(source);
    const assigned = new Set(scenes.flatMap(scene => scene.shotIds));
    return { scenes, unassigned: records(source.shots).filter(shot => !assigned.has(String(shot.id))).map(shot => String(shot.id)) };
}

/** Keep a whole existing Clip visible if any member belongs to the selected scene. */
export function storyboardSceneShotIds(source: Row, sceneId: string) {
    const { scenes, unassigned } = storyboardScenes(source);
    const ids = sceneId === "__unassigned__" ? unassigned : scenes.find(scene => scene.id === sceneId)?.shotIds;
    if (!sceneId || !ids) return new Set(records(source.shots).map(shot => String(shot.id)));
    const visible = new Set(ids);
    for (const clip of records(source.segments)) if ((clip.shot_ids || []).some((id: string) => visible.has(String(id)))) {
        for (const id of clip.shot_ids || []) visible.add(String(id));
    }
    return visible;
}

/** Freshness comes from the workbench projection, not a second client-side hash policy. */
export function storyboardArtifactState(artifact: Row | undefined, projection?: Row): "pending" | "stale" | "ready" | "recorded" {
    if (!artifact || artifact.status === "draft" || !artifact.receipt) return "pending";
    if (artifact.status === "stale") return "stale";
    const matching = projection?.id === artifact.id && projection?.sha256 === artifact.sha256;
    if (matching && projection?.current === false) return "stale";
    if (matching && projection?.current === true && projection?.status === "ready") return "ready";
    return artifact.status === "ready" ? "recorded" : "pending";
}
