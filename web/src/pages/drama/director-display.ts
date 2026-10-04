/** Read-only presentation helpers. They never rewrite the production source. */
export type DirectorRecord = Record<string, any>;
export type ScriptSceneGroup = { key: string; sceneId: string; title: string; blocks: DirectorRecord[] };
export const records = (value: unknown): DirectorRecord[] => Array.isArray(value) ? value.filter(item => item && typeof item === 'object' && !Array.isArray(item)) : [];

export function groupScriptScenes(blocks: DirectorRecord[]): ScriptSceneGroup[] {
    const groups: ScriptSceneGroup[] = [];
    for (const block of blocks) {
        const sceneId = String(block.scene_id || block.id || '');
        const prior = groups[groups.length - 1];
        // Returning to a location later in the story starts another scene.
        if (prior && prior.sceneId === sceneId && !Array.isArray(block.beat_ids) && !Array.isArray(prior.blocks[0].beat_ids)) prior.blocks.push(block);
        else groups.push({ key: String(block.id || `${sceneId}:${groups.length}`), sceneId, title: String(block.scene_name || block.heading || ''), blocks: [block] });
    }
    return groups;
}

export function dialogueBody(block: DirectorRecord) {
    const text = typeof block.text === 'string' ? block.text : '';
    const speaker = String(block.speaker || '');
    const prefix = speaker && [speaker + '：', speaker + ':'].find(value => text.startsWith(value));
    return prefix ? text.slice(prefix.length).trimStart() : text;
}

export function readableText(value: unknown, names: Record<string, string> = {}): string {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return names[value] || value;
    if (typeof value === 'number') return String(value);
    if (Array.isArray(value)) return value.map(item => readableText(item, names)).filter(Boolean).join(' · ');
    if (typeof value !== 'object') return '';
    const object = value as DirectorRecord;
    for (const key of ['description', 'prompt_description', 'text', 'summary', 'action', 'visual', 'name', 'title', 'purpose', 'goal', 'question']) {
        if (typeof object[key] === 'string' && object[key]) return readableText(object[key], names);
    }
    // Unknown structures stay available in Advanced instead of becoming editable JSON prose.
    return '';
}

export function shotDisplayText(shot: DirectorRecord): string {
    return readableText(shot.display_summary || shot.summary || shot.visual);
}

export function humanName(value: unknown, id: string, fallback: string) {
    const name = typeof value === 'string' ? value.trim() : '';
    return !name || name === id || /^[A-Z][A-Z0-9_-]{5,}$/.test(name) ? fallback : name;
}

export function formatSeconds(value: unknown) {
    if (value === null || value === undefined || value === "") return "—";
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? String(Math.round(number * 10) / 10) : '—';
}
