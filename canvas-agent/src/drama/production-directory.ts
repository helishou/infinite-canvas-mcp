type Source = Record<string, unknown>;
const entries = (value: unknown): Record<string, any>[] => Array.isArray(value) ? value.filter(item => item && typeof item === "object") : [];

export type ProductionScriptGroup = { key: string; sceneId: string; title: string; blocks: Record<string, any>[] };

/** Legacy action/dialogue blocks may carry their own beats; they are still blocks within a scene. */
export function productionScriptGroups(blocks: Record<string, any>[]): ProductionScriptGroup[] {
    const groups: ProductionScriptGroup[] = [];
    const isBlock = (block: Record<string, any>) => ["action", "dialogue"].includes(String(block.kind)) || !Array.isArray(block.beat_ids);
    for (const block of blocks) {
        const sceneId = String(block.scene_id || block.id || "");
        const prior = groups[groups.length - 1];
        const first = prior?.blocks[0];
        // Only consecutive blocks merge. Whole scene occurrences and a later return retain their identities.
        if (prior && prior.sceneId === sceneId && isBlock(block) && isBlock(first!)
            && (!(block.scene_name || block.heading) || !prior.title || String(block.scene_name || block.heading) === prior.title)
            && String(block.thread || "") === String(first!.thread || "")) prior.blocks.push(block);
        else groups.push({ key: String(block.id || `${sceneId}:${groups.length}`), sceneId, title: String(block.scene_name || block.heading || ""), blocks: [block] });
    }
    return groups;
}

/**
 * A shot names its script occurrence explicitly, or is mapped through story beats.
 * `shot.scene_id` is an environment registry reference and never identifies the occurrence when the
 * environment carries several of them. It is only decisive when that environment has exactly one
 * occurrence, which is the shape every single-scene environment has.
 */
function shotNamesSceneOccurrence(shot: Record<string, any>, group: { key: string; sceneId: string; blocks: Record<string, any>[] }, occurrencesPerEnvironment: Map<string, number>): boolean {
    const named = String(shot.source_scene_id || "");
    if (named) return named === group.key || named === group.sceneId;
    const beats = new Set(group.blocks.flatMap(block => Array.isArray(block.beat_ids) ? block.beat_ids.map(String) : []));
    if (beats.size > 0) return (shot.story_beat_ids || []).some((id: unknown) => beats.has(String(id)));
    return String(shot.scene_id || "") === group.sceneId && occurrencesPerEnvironment.get(group.sceneId) === 1;
}

/** Script occurrences and environment registry identities are deliberately separate. */
export function productionSceneEntries(source: Source) {
    const shots = entries(source.shots);
    const scripts = entries(source.script_scenes);
    const registry = entries(source.scene_registry);
    const groups = productionScriptGroups(scripts);
    const occurrencesPerEnvironment = new Map<string, number>();
    for (const group of groups) occurrencesPerEnvironment.set(group.sceneId, (occurrencesPerEnvironment.get(group.sceneId) || 0) + 1);
    return scripts.length ? groups.map(group => ({
        id: group.key, environmentId: group.sceneId, title: group.title || String(registry.find(item => item.id === group.sceneId)?.name || group.key),
        text: group.blocks.map(scene => String(scene.text || "")).join("\n\n"),
        shotIds: shots.filter(shot => shotNamesSceneOccurrence(shot, group, occurrencesPerEnvironment)).map(shot => String(shot.id)),
    })) : registry.map(scene => ({ id: String(scene.id), environmentId: String(scene.id), title: String(scene.name || scene.id), text: "", shotIds: shots.filter(shot => String(shot.scene_id || "") === String(scene.id)).map(shot => String(shot.id)) }));
}
