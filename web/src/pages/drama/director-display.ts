/** Read-only presentation helpers. They never rewrite the production source. */
import { productionScriptGroups } from "@basketikun/canvas-agent/drama/production-contract";
export type DirectorRecord = Record<string, any>;
export type ScriptSceneGroup = { key: string; sceneId: string; title: string; blocks: DirectorRecord[] };
export const records = (value: unknown): DirectorRecord[] => Array.isArray(value) ? value.filter(item => item && typeof item === 'object' && !Array.isArray(item)) : [];

export function groupScriptScenes(blocks: DirectorRecord[]): ScriptSceneGroup[] {
    return productionScriptGroups(blocks);
}

export function dialogueBody(block: DirectorRecord) {
    const text = typeof block.text === 'string' ? block.text : '';
    const speaker = String(block.speaker || '');
    const prefix = speaker && [speaker + '：', speaker + ':'].find(value => text.startsWith(value));
    return prefix ? text.slice(prefix.length).trimStart() : text;
}

/**
 * 对白说话人：① 注册表 id（character_id / speaker_id / speaker 命中 nameMap）→ 注册名；
 * ② 否则按 speaker_name 反查注册表（同一角色在注册表里可能有更规范的名字）；
 * ③ 都没有就退回原始字符串，最后才是占位文案。
 * 注意 v2 稿把说话人放在 speaker_id + speaker_name，旧的 character_id / speaker 常为空。
 */
export function dialogueSpeakerLabel(dialogue: DirectorRecord, nameMap: Record<string, string>, labels: { narration: string; speaker: string }) {
    const keys = [dialogue.character_id, dialogue.speaker_id, dialogue.speaker].map(value => String(value || ''));
    if (keys.some(key => key.toUpperCase() === 'NARRATOR')) return labels.narration;
    const registered = keys.find(key => key && nameMap[key]);
    if (registered) return nameMap[registered];
    const raw = humanName(dialogue.speaker_name, keys[0], '');
    const matched = raw && Object.keys(nameMap).find(key => nameMap[key].toLowerCase() === raw.toLowerCase());
    if (matched) return nameMap[matched];
    return raw || humanName(dialogue.speaker, keys[0], labels.speaker);
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


/** Story has its own semantics; a generic goal must not hide the authored action. */
export function storyBeatCards(beats: DirectorRecord[], sceneId?: string) {
    const selected = sceneId ? beats.filter(beat => String(beat.scene_id) === sceneId) : beats;
    const repeatedFields = ["goal", "obstacle", "cost"].filter(field => selected.length > 1 && selected.every(beat => typeof beat[field] === "string" && beat[field].trim() && beat[field].trim() === selected[0][field]?.trim()));
    return selected.map(beat => ({ beat, text: readableText(beat.summary || beat.description || beat.choice || beat.result || (repeatedFields.includes("goal") ? undefined : beat.goal)), repeatedFields }));
}


/**
 * 时长（秒）→ 帧数补丁：start_frame 由前序镜头决定，所以只推 end_frame；
 * 原稿已登记 duration_frames 时一起同步，避免两个字段各说各话。
 */
export function shotDurationPatch(shot: DirectorRecord, seconds: number, fps: number) {
    const startFrame = Number(shot.start_frame || 0);
    const rate = Number(fps) > 0 ? Number(fps) : 24;
    const frames = Math.max(1, Math.round(Number(seconds) * rate));
    const patch: Record<string, unknown> = { end_frame: startFrame + frames };
    if (Number.isFinite(Number(shot.duration_frames))) patch.duration_frames = frames;
    return patch;
}


/** Preview selection is local UI state and never selects a production reference. */
export function assetImagePreview(currentStorageKey: string, nodeImages: unknown, selectedKey?: string) {
    const images = [...new Set([currentStorageKey, ...records(nodeImages).filter(image => image.status === "success" && image.storageKey).map(image => String(image.storageKey))].filter(Boolean))];
    const previewKey = selectedKey && images.includes(selectedKey) ? selectedKey : currentStorageKey;
    return { images, previewKey, browsingHistory: previewKey !== currentStorageKey };
}
