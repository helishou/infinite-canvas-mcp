type Source = Record<string, unknown>;
const entries = (value: unknown): Record<string, any>[] => Array.isArray(value) ? value.filter(item => item && typeof item === "object") : [];

/** Script occurrences and environment registry identities are deliberately separate. */
export function productionSceneEntries(source: Source) {
    const shots = entries(source.shots);
    const scripts = entries(source.script_scenes);
    const registry = entries(source.scene_registry);
    return scripts.length ? scripts.map((scene, index) => {
        const beats = new Set(Array.isArray(scene.beat_ids) ? scene.beat_ids.map(String) : []);
        const matching = shots.filter(shot => beats.size ? (shot.story_beat_ids || []).some((id: unknown) => beats.has(String(id)))
            : scripts.filter(item => item.scene_id === scene.scene_id).length === 1 && shot.scene_id === scene.scene_id);
        return { id: String(scene.id || `script-${index}`), environmentId: String(scene.scene_id || ""), title: String(scene.scene_name || registry.find(item => item.id === scene.scene_id)?.name || scene.id || ""),
            text: String(scene.text || ""), shotIds: matching.map(shot => String(shot.id)) };
    }) : registry.map(scene => ({ id: String(scene.id), environmentId: String(scene.id), title: String(scene.name || scene.id), text: "", shotIds: shots.filter(shot => shot.scene_id === scene.id).map(shot => String(shot.id)) }));
}
