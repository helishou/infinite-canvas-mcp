import { canonicalProduction } from "@basketikun/canvas-agent/drama/production-contract";
import { draftFieldConflicts, mergeDraftFields } from "./draft-field-merge";

export type ShotUtteranceValue = {
    utteranceId: string; speakerSubjectId: string; text: string; delivery: string; voiceover: boolean;
    localStartFrame: number; localEndFrame: number;
};
export type ShotFormValue = {
    title: string; visual: string; camera: Record<string, any>; duration_frames: number;
    subject_usages: Array<Record<string, any>>; keyframes: Array<Record<string, any>>; audio: unknown;
    utterances?: Array<ShotUtteranceValue>;
};
export type ShotFormDraft = { version: 1; shotId: string; base: ShotFormValue; value: ShotFormValue };
const rows = (value: unknown): Array<Record<string, any>> => Array.isArray(value) ? value : [];
const object = (value: unknown): value is Record<string, any> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const optionalStrings = (value: unknown) => value === undefined || (Array.isArray(value) && value.every(item => typeof item === "string"));
const validUtterances = (value: unknown) => value === undefined || (Array.isArray(value) && value.every(item => object(item)
    && typeof item.utteranceId === "string" && typeof item.speakerSubjectId === "string" && typeof item.text === "string"
    && Number.isFinite(item.localStartFrame) && Number.isFinite(item.localEndFrame)));
function validFormValue(value: unknown): value is ShotFormValue {
    if (!object(value) || typeof value.title !== "string" || typeof value.visual !== "string"
        || !Number.isFinite(value.duration_frames) || !object(value.camera)
        || !optionalStrings(value.camera.attention_subject_ids) || !validUtterances(value.utterances)) return false;
    return Array.isArray(value.subject_usages) && value.subject_usages.every(usage => object(usage)
        && typeof usage.subjectId === "string" && optionalStrings(usage.pictureBindingIds) && optionalStrings(usage.continuityFactIds))
        && Array.isArray(value.keyframes) && value.keyframes.every(frame => object(frame) && typeof frame.id === "string");
}

/** Join shot.utterance_refs with source.utterances into editable form rows. */
export function shotUtteranceRows(shot: Record<string, any>, source: Record<string, any> | undefined): Array<ShotUtteranceValue> {
    const byId = new Map(rows(source?.utterances).map(item => [String(item.id), item]));
    return rows(shot.utterance_refs).map(ref => {
        const utterance = byId.get(String(ref.utteranceId));
        return {
            utteranceId: String(ref.utteranceId), speakerSubjectId: String(utterance?.speakerSubjectId || ""),
            text: String(utterance?.text || ""), delivery: utterance?.delivery ? String(utterance.delivery) : "", voiceover: Boolean(utterance?.voiceover),
            localStartFrame: Number(ref.localStartFrame ?? 0), localEndFrame: Number(ref.localEndFrame ?? 0),
        };
    });
}

export function shotFormValue(shot: Record<string, any>, source?: Record<string, any>): ShotFormValue {
    const formal: ShotFormValue = structuredClone({ title: String(shot.title || ""), visual: String(shot.visual || ""),
        camera: shot.camera && typeof shot.camera === "object" && !Array.isArray(shot.camera) ? shot.camera : { path: String(shot.camera || "") },
        duration_frames: Number(shot.duration_frames || 1), subject_usages: rows(shot.subject_usages), keyframes: rows(shot.keyframes), audio: shot.audio ?? "" });
    if (source) formal.utterances = shotUtteranceRows(shot, source);
    return formal;
}

export function readShotFormDraft(raw: string | undefined, shot: Record<string, any>, source?: Record<string, any>) {
    const formal = shotFormValue(shot, source);
    if (!raw) return { draft: { version: 1, shotId: String(shot.id), base: formal, value: structuredClone(formal) } as ShotFormDraft, invalid: false };
    try {
        const draft = JSON.parse(raw) as ShotFormDraft;
        if (!object(draft) || draft.version !== 1 || draft.shotId !== String(shot.id)
            || !validFormValue(draft.base) || !validFormValue(draft.value)) throw new Error("Invalid Shot draft");
        return { draft: draftFieldConflicts(draft.base, draft.value, formal).length ? draft : rebaseShotFormDraft(draft, shot, source), invalid: false };
    } catch {
        return { draft: { version: 1, shotId: String(shot.id), base: formal, value: structuredClone(formal) } as ShotFormDraft, invalid: true };
    }
}

export const shotDraftChanged = (draft: ShotFormDraft) => canonicalProduction(draft.base) !== canonicalProduction(draft.value);
export const shotDraftSourceChanged = (draft: ShotFormDraft, shot: Record<string, any>, source?: Record<string, any>) => draftFieldConflicts(draft.base, draft.value, shotFormValue(shot, source)).length > 0;

export function shotFormChanges(draft: ShotFormDraft) {
    const patch: Record<string, unknown> = {};
    for (const key of ["title", "visual", "camera", "duration_frames", "subject_usages", "audio"] as const) {
        if (canonicalProduction(draft.base[key]) !== canonicalProduction(draft.value[key])) patch[key] = draft.value[key];
    }
    const submitUtterances = (items: ShotUtteranceValue[]) => items.filter(item => item.speakerSubjectId && item.text.trim())
        .map(({ utteranceId, delivery, ...rest }) => ({ ...rest, ...(utteranceId ? { utteranceId } : {}), ...(delivery.trim() ? { delivery } : {}) }));
    const submitted = submitUtterances(draft.value.utterances || []);
    const utterancesChanged = draft.value.utterances !== undefined
        && canonicalProduction(submitUtterances(draft.base.utterances || [])) !== canonicalProduction(submitted);
    return {
        patch,
        ...(canonicalProduction(draft.base.keyframes) !== canonicalProduction(draft.value.keyframes) ? { keyframes: draft.value.keyframes } : {}),
        ...(utterancesChanged ? { utterances: submitted } : {}),
    };
}

/** Explicitly keep the reviewed edits while retaining remote fields the user did not edit. */
export function rebaseShotFormDraft(draft: ShotFormDraft, shot: Record<string, any>, source?: Record<string, any>): ShotFormDraft {
    const base = shotFormValue(shot, source), value = mergeDraftFields(draft.base, draft.value, base) as ShotFormValue;
    return { version: 1, shotId: draft.shotId, base, value };
}

export function subjectDisplayName(source: Record<string, any>, subjectId: string) {
    const subject = rows(source.subject_registry).find(item => String(item.id) === subjectId), entity = subject?.entityRef;
    const registry = entity?.kind === "character" ? rows(source.character_registry) : entity?.kind === "scene" ? rows(source.scene_registry) : rows(source.asset_plan);
    const item = registry.find(item => String(item.id || item.asset_id) === String(entity?.id));
    return String(item?.name || item?.asset_name || item?.scene_name || item?.title || subjectId);
}

export function productionWorkbenchValue(production: Record<string, any>, view: "subject" | "shot" | "clip") {
    return production.workbench || production[`${view}Workbench`];
}


/** Edit the actual entity field rather than creating a second display description. */
export function subjectDescriptionField(kind: string, row: Record<string, any>) {
    const fields = kind === "character" ? ["appearance", "description", "prompt_description", "identity"] : kind === "environment" ? ["description", "prompt_description"] : ["description", "prompt"];
    return fields.find(field => typeof row[field] === "string" ? Boolean(row[field].trim()) : Boolean(row[field] && typeof row[field] === "object")) || fields[0];
}
