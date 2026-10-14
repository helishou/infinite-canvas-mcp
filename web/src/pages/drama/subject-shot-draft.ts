import { canonicalProduction } from "@basketikun/canvas-agent/drama/production-contract";
import { draftFieldConflicts, mergeDraftFields } from "./draft-field-merge";

export type ShotUtteranceValue = {
    utteranceId: string; speakerSubjectId: string; text: string; delivery: string; voiceover: boolean;
    localStartFrame: number; localEndFrame: number;
};
export type ShotFormValue = {
    title: string; visual: string; camera: Record<string, any>; duration_frames: number;
    subject_usages: Array<Record<string, any>>; keyframes: Array<Record<string, any>>; reference_requirements: Array<Record<string, any>>; audio: unknown;
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
        && typeof usage.subjectId === "string" && (usage.pictureBindingMode === undefined || ["default", "explicit"].includes(usage.pictureBindingMode))
        && optionalStrings(usage.pictureBindingIds) && optionalStrings(usage.continuityFactIds))
        && Array.isArray(value.keyframes) && value.keyframes.every(frame => object(frame) && typeof frame.id === "string")
        && (value.reference_requirements === undefined || Array.isArray(value.reference_requirements) && value.reference_requirements.every(reference => object(reference) && typeof reference.id === "string"));
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
    const legacyCompositionReferences = rows(shot.keyframes).filter(frame => frame.anchor === "composition").map(frame => {
        const assetId = String(frame.asset_id || frame.assetId || frame.id || "");
        const assetPlan = rows(source?.asset_plan).find(asset => String(asset.asset_id || asset.id || "") === assetId);
        return {
            id: String(frame.id), asset_id: assetId,
            ...(assetPlan?.version || frame.sourceNode?.nodeId ? { asset_version: String(assetPlan?.version || `node:${frame.sourceNode.nodeId}`) } : {}),
            purpose: "构图参考", sourceNode: frame.sourceNode, selection: frame.selection,
            retain: rows(frame.retain).map(String), exclude: rows(frame.exclude).map(String),
            requiredForSubmission: frame.requiredForSubmission !== false,
            ...(Array.isArray(frame.subjectIds) ? { subjectIds: frame.subjectIds } : {}),
            ...(frame.subjectPictureBindingIds && typeof frame.subjectPictureBindingIds === "object" ? { subjectPictureBindingIds: frame.subjectPictureBindingIds } : {}),
        };
    });
    const savedReferences = rows(shot.reference_requirements);
    const referenceById = new Map(savedReferences.map(reference => [String(reference.id || ""), reference]));
    for (const reference of legacyCompositionReferences) if (!referenceById.has(reference.id)) referenceById.set(reference.id, reference);
    const formal: ShotFormValue = structuredClone({ title: String(shot.title || ""), visual: String(shot.visual || ""),
        camera: shot.camera && typeof shot.camera === "object" && !Array.isArray(shot.camera) ? shot.camera : { path: String(shot.camera || "") },
        duration_frames: Number(shot.duration_frames || 1), subject_usages: rows(shot.subject_usages),
        keyframes: rows(shot.keyframes).filter(frame => frame.anchor !== "composition"),
        reference_requirements: [...referenceById.values()], audio: shot.audio ?? "" });
    if (source) formal.utterances = shotUtteranceRows(shot, source);
    return formal;
}

/** 「说话人是否在画面内」的唯一来源：subject_usages 的出场方式。voiceover 从它推导，消除声音 tab 的第二套旋钮。 */
export const speakerOnCamera = (usages: Array<Record<string, any>> | undefined, speakerId: string) =>
    Boolean(speakerId) && (usages || []).some(usage => String(usage?.subjectId) === speakerId && usage?.presentation === "visible");
/** 只读草稿值按当前出场方式重写每条对白的 voiceover；未登记任何主体用法的旧源稿保持存量标志，不做静默翻转。 */
export const normalizeUtteranceVoiceovers = (value: ShotFormValue) => {
    if (!value.subject_usages?.length) return value;
    (value.utterances || []).forEach(row => { row.voiceover = !speakerOnCamera(value.subject_usages, row.speakerSubjectId); });
    return value;
};

export function readShotFormDraft(raw: string | undefined, shot: Record<string, any>, source?: Record<string, any>) {
    const formal = shotFormValue(shot, source);
    if (!raw) return { draft: { version: 1, shotId: String(shot.id), base: formal, value: normalizeUtteranceVoiceovers(structuredClone(formal)) } as ShotFormDraft, invalid: false };
    try {
        const draft = JSON.parse(raw) as ShotFormDraft;
        for (const value of [draft?.base, draft?.value]) if (object(value)) {
            const legacy = rows(value.keyframes).filter(frame => frame.anchor === "composition").map(frame => {
                const assetId = String(frame.asset_id || frame.assetId || frame.id || "");
                const assetPlan = rows(source?.asset_plan).find(asset => String(asset.asset_id || asset.id || "") === assetId);
                return { id: String(frame.id), asset_id: assetId, ...(assetPlan?.version || frame.sourceNode?.nodeId ? { asset_version: String(assetPlan?.version || `node:${frame.sourceNode.nodeId}`) } : {}), purpose: "构图参考", sourceNode: frame.sourceNode, selection: frame.selection,
                    retain: rows(frame.retain).map(String), exclude: rows(frame.exclude).map(String), requiredForSubmission: frame.requiredForSubmission !== false,
                    ...(Array.isArray(frame.subjectIds) ? { subjectIds: frame.subjectIds } : {}), ...(frame.subjectPictureBindingIds && typeof frame.subjectPictureBindingIds === "object" ? { subjectPictureBindingIds: frame.subjectPictureBindingIds } : {}) };
            });
            const references = new Map(rows(value.reference_requirements).map(reference => [String(reference.id || ""), reference]));
            for (const reference of legacy) if (!references.has(reference.id)) references.set(reference.id, reference);
            value.reference_requirements = [...references.values()];
            value.keyframes = rows(value.keyframes).filter(frame => frame.anchor !== "composition");
        }
        if (!object(draft) || draft.version !== 1 || draft.shotId !== String(shot.id)
            || !validFormValue(draft.base) || !validFormValue(draft.value)) throw new Error("Invalid Shot draft");
        const resolved = draftFieldConflicts(draft.base, draft.value, formal).length ? draft : rebaseShotFormDraft(draft, shot, source);
        return { draft: { ...resolved, value: normalizeUtteranceVoiceovers(resolved.value) }, invalid: false };
    } catch {
        return { draft: { version: 1, shotId: String(shot.id), base: formal, value: normalizeUtteranceVoiceovers(structuredClone(formal)) } as ShotFormDraft, invalid: true };
    }
}

export const shotDraftChanged = (draft: ShotFormDraft) => canonicalProduction(draft.base) !== canonicalProduction(draft.value);
export const shotDraftSourceChanged = (draft: ShotFormDraft, shot: Record<string, any>, source?: Record<string, any>) => draftFieldConflicts(draft.base, draft.value, shotFormValue(shot, source)).length > 0;

export function shotFormChanges(draft: ShotFormDraft) {
    const patch: Record<string, unknown> = {};
    for (const key of ["title", "visual", "camera", "duration_frames", "subject_usages", "reference_requirements", "audio"] as const) {
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
    return { version: 1, shotId: draft.shotId, base, value: normalizeUtteranceVoiceovers(value) };
}

export function subjectDisplayName(source: Record<string, any>, subjectId: string) {
    const subject = rows(source.subject_registry).find(item => String(item.id) === subjectId), entity = subject?.entityRef;
    if (typeof subject?.display_name === "string" && subject.display_name.trim()) return subject.display_name;
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
