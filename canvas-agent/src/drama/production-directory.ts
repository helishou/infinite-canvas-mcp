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

/** Script occurrences and environment registry identities are deliberately separate. */
export function productionSceneEntries(source: Source) {
    const shots = entries(source.shots);
    const scripts = entries(source.script_scenes);
    const registry = entries(source.scene_registry);
    const groups = productionScriptGroups(scripts);
    return scripts.length ? groups.map(group => {
        const beats = new Set(group.blocks.flatMap(scene => Array.isArray(scene.beat_ids) ? scene.beat_ids.map(String) : []));
        const matching = shots.filter(shot => beats.size ? (shot.story_beat_ids || []).some((id: unknown) => beats.has(String(id)))
            : groups.filter(item => item.sceneId === group.sceneId).length === 1 && shot.scene_id === group.sceneId);
        return { id: group.key, environmentId: group.sceneId, title: group.title || String(registry.find(item => item.id === group.sceneId)?.name || group.key),
            text: group.blocks.map(scene => String(scene.text || "")).join("\n\n"), shotIds: [...new Set(matching.map(shot => String(shot.id)))] };
    }) : registry.map(scene => ({ id: String(scene.id), environmentId: String(scene.id), title: String(scene.name || scene.id), text: "", shotIds: shots.filter(shot => shot.scene_id === scene.id).map(shot => String(shot.id)) }));
}
