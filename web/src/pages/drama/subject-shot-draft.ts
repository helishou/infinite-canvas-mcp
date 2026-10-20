import { canonicalProduction } from "@basketikun/canvas-agent/drama/production-contract";
import { draftFieldConflicts, mergeDraftFields } from "./draft-field-merge";

export type ShotUtteranceValue = {
    utteranceId: string; speakerSubjectId: string; text: string; delivery: string; voiceover: boolean;
    localStartFrame: number; localEndFrame: number;
    textMode?: "whole" | "segment"; textCuts?: number[]; utteranceText?: string;
};
export type ShotFormValue = {
    title: string; visual: string; camera: Record<string, any>; duration_frames: number;
    subject_usages: Array<Record<string, any>>; keyframes: Array<Record<string, any>>; reference_requirements: Array<Record<string, any>>; audio: unknown;
    performance?: Record<string, any> | null;
    utterances?: Array<ShotUtteranceValue>;
};
export type ShotFormDraft = { version: 1 | 2; shotId: string; base: ShotFormValue; value: ShotFormValue };
const rows = (value: unknown): Array<Record<string, any>> => Array.isArray(value) ? value : [];
const object = (value: unknown): value is Record<string, any> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const optionalStrings = (value: unknown) => value === undefined || (Array.isArray(value) && value.every(item => typeof item === "string"));
const validUtterances = (value: unknown) => value === undefined || (Array.isArray(value) && value.every(item => object(item)
    && typeof item.utteranceId === "string" && typeof item.speakerSubjectId === "string" && typeof item.text === "string"
    && (item.textCuts === undefined || Array.isArray(item.textCuts) && item.textCuts.every(Number.isInteger))
    && (item.utteranceText === undefined || typeof item.utteranceText === "string")
    && Number.isFinite(item.localStartFrame) && Number.isFinite(item.localEndFrame)));
function validFormValue(value: unknown): value is ShotFormValue {
    if (!object(value) || typeof value.title !== "string" || typeof value.visual !== "string"
        || !Number.isFinite(value.duration_frames) || !object(value.camera)
        || (value.performance !== undefined && value.performance !== null && !object(value.performance))
        || !optionalStrings(value.camera.attention_subject_ids) || !validUtterances(value.utterances)) return false;
    return Array.isArray(value.subject_usages) && value.subject_usages.every(usage => object(usage)
        && typeof usage.subjectId === "string" && (usage.pictureBindingMode === undefined || ["default", "explicit"].includes(usage.pictureBindingMode))
        && optionalStrings(usage.pictureBindingIds) && optionalStrings(usage.continuityFactIds))
        && Array.isArray(value.keyframes) && value.keyframes.every(frame => object(frame) && typeof frame.id === "string")
        && (value.reference_requirements === undefined || Array.isArray(value.reference_requirements) && value.reference_requirements.every(reference => object(reference) && typeof reference.id === "string"));
}

/** Join shot.utterance_refs with source.utterances into editable form rows. */
export function shotUtteranceRows(shot: Record<string, any>, source: Record<string, any> | undefined, textMode: "whole" | "segment" = "segment"): Array<ShotUtteranceValue> {
    const byId = new Map(rows(source?.utterances).map(item => [String(item.id), item]));
    const allShots = rows(source?.shots);
    const shotReferences: Array<Record<string, any>> = [];
    for (const ref of rows(shot.utterance_refs).sort((a, b) => Number(a.localStartFrame) - Number(b.localStartFrame))) {
        const previous = shotReferences.at(-1);
        if (previous && previous.utteranceId === ref.utteranceId && previous.role === ref.role
            && previous.localEndFrame === ref.localStartFrame && previous.textEnd === ref.textStart) {
            previous.localEndFrame = ref.localEndFrame;
            previous.textEnd = ref.textEnd;
        } else shotReferences.push({ ...ref });
    }
    return shotReferences.map(ref => {
        const utteranceId = String(ref.utteranceId), utterance = byId.get(utteranceId);
        const text = String(utterance?.text || ""), characters = Array.from(text);
        const references = allShots.flatMap(owner => rows(owner.utterance_refs).filter(item => String(item.utteranceId) === utteranceId).map(item => ({ owner, ref: item })));
        const textCuts = references.slice(0, -1).map(item => Number(item.ref.textEnd));
        return {
            utteranceId, speakerSubjectId: String(utterance?.speakerSubjectId || ""),
            text: textMode === "whole" ? text : characters.slice(Number(ref.textStart || 0), Number(ref.textEnd || characters.length)).join(""),
            delivery: utterance?.delivery ? String(utterance.delivery) : "", voiceover: Boolean(utterance?.voiceover), textMode, textCuts,
            utteranceText: text,
            localStartFrame: Number(ref.localStartFrame ?? 0), localEndFrame: Number(ref.localEndFrame ?? 0),
        };
    });
}

export function shotFormValue(shot: Record<string, any>, source?: Record<string, any>, textMode: "whole" | "segment" = "segment"): ShotFormValue {
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
        reference_requirements: [...referenceById.values()], audio: shot.audio ?? "",
        ...(shot.performance !== undefined ? { performance: shot.performance } : {}) });
    if (source) formal.utterances = shotUtteranceRows(shot, source, textMode);
    return formal;
}

/** 单镜头内说话人是否入画由 subject_usages 决定；跨镜对白保留全局 utterance 的正式 voiceover 标志。 */
export const speakerOnCamera = (usages: Array<Record<string, any>> | undefined, speakerId: string) =>
    Boolean(speakerId) && (usages || []).some(usage => String(usage?.subjectId) === speakerId && usage?.presentation === "visible");
/** 单镜头对白可按出场方式推导；跨镜共享对白沿用正式源稿的全局 voiceover 标志。 */
export const normalizeUtteranceVoiceovers = (value: ShotFormValue, source?: Record<string, any>) => {
    if (!value.subject_usages?.length) return value;
    const sharedUtteranceIds = new Set(rows(source?.utterances)
        .filter(item => item.start?.shotId && item.end?.shotId && item.start.shotId !== item.end.shotId)
        .map(item => String(item.id)));
    (value.utterances || []).forEach(row => {
        // `voiceover` belongs to the utterance, which can span several Shots.
        // A per-Shot visibility check must not rewrite that saved global value.
        if (sharedUtteranceIds.has(String(row.utteranceId))) return;
        row.voiceover = !speakerOnCamera(value.subject_usages, row.speakerSubjectId);
    });
    return value;
};

export function readShotFormDraft(raw: string | undefined, shot: Record<string, any>, source?: Record<string, any>) {
    const formal = shotFormValue(shot, source);
    if (!raw) return { draft: { version: 2, shotId: String(shot.id), base: formal, value: normalizeUtteranceVoiceovers(structuredClone(formal), source) } as ShotFormDraft, invalid: false };
    try {
        const draft = JSON.parse(raw) as ShotFormDraft;
        const draftTextMode = draft?.version === 1 ? "whole" : "segment";
        const draftFormal = shotFormValue(shot, source, draftTextMode);
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
        if (!object(draft) || ![1, 2].includes(draft.version) || draft.shotId !== String(shot.id)
            || !validFormValue(draft.base) || !validFormValue(draft.value)) throw new Error("Invalid Shot draft");
        const formalUtterances = new Map((draftFormal.utterances || []).map(item => [item.utteranceId, item]));
        for (const formValue of [draft.base, draft.value]) for (const row of formValue.utterances || []) {
            const current = formalUtterances.get(row.utteranceId);
            if (current && row.textCuts === undefined) row.textCuts = current.textCuts;
            if (current && row.utteranceText === undefined) row.utteranceText = current.utteranceText;
        }
        const resolved = draftFieldConflicts(draft.base, draft.value, draftFormal).length ? draft : rebaseShotFormDraft(draft, shot, source);
        return { draft: { ...resolved, value: normalizeUtteranceVoiceovers(resolved.value, source) }, invalid: false };
    } catch {
        return { draft: { version: 2, shotId: String(shot.id), base: formal, value: normalizeUtteranceVoiceovers(structuredClone(formal), source) } as ShotFormDraft, invalid: true };
    }
}

export const shotDraftChanged = (draft: ShotFormDraft) => canonicalProduction(draft.base) !== canonicalProduction(draft.value);
export const shotDraftSourceChanged = (draft: ShotFormDraft, shot: Record<string, any>, source?: Record<string, any>) => draftFieldConflicts(draft.base, draft.value, shotFormValue(shot, source, draft.version === 1 ? "whole" : "segment")).length > 0;

export function shotFormChanges(draft: ShotFormDraft) {
    const patch: Record<string, unknown> = {};
    for (const key of ["title", "visual", "camera", "duration_frames", "subject_usages", "reference_requirements", "audio", "performance"] as const) {
        if (canonicalProduction(draft.base[key]) !== canonicalProduction(draft.value[key])) patch[key] = draft.value[key];
    }
    const baseUtterances = draft.base.utterances || [];
    const submitUtterances = (items: ShotUtteranceValue[]) => items.filter(item => item.speakerSubjectId && item.text.trim())
        .map(item => {
            const { utteranceId, delivery, textCuts, utteranceText: _utteranceText, textMode: _textMode, ...rest } = item;
            const base = baseUtterances.find(row => row.utteranceId === utteranceId);
            const cutsChanged = canonicalProduction(base?.textCuts || []) !== canonicalProduction(textCuts || []);
            const textModeValue = draft.version === 1 ? "whole" : cutsChanged && canonicalProduction(base?.text || "") === canonicalProduction(item.text) ? "partition" : "segment";
            return { ...rest, textMode: textModeValue, ...(textCuts?.length && (draft.version === 1 || cutsChanged) ? { textCuts } : {}), ...(utteranceId ? { utteranceId } : {}), ...(delivery.trim() ? { delivery } : {}) };
        });
    const submitted = submitUtterances(draft.value.utterances || []);
    const utterancesChanged = draft.value.utterances !== undefined
        && canonicalProduction(submitUtterances(draft.base.utterances || [])) !== canonicalProduction(submitted);
    return {
        patch,
        ...(canonicalProduction(draft.base.keyframes) !== canonicalProduction(draft.value.keyframes) ? { keyframes: draft.value.keyframes } : {}),
        ...(utterancesChanged ? { utterances: submitted } : {}),
    };
}

function changedFormFields(before: unknown, after: unknown, path: string, output: Set<string>) {
    if (canonicalProduction(before) === canonicalProduction(after)) return;
    if (path.endsWith(".subjectPictureBindingIds")) {
        output.add(path);
        return;
    }
    if (object(before) && object(after)) {
        for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
            changedFormFields(before[key], after[key], path ? `${path}.${key}` : key, output);
        }
        return;
    }
    if (Array.isArray(before) && Array.isArray(after)) {
        const identity = (item: unknown) => object(item)
            ? ["id", "subjectId", "utteranceId"].map(key => item[key]).find(value => typeof value === "string" && value.trim()) as string | undefined
            : undefined;
        const beforeIds = before.map(identity), afterIds = after.map(identity);
        if (before.length === after.length && beforeIds.every(Boolean) && afterIds.every(Boolean)
            && new Set(beforeIds).size === before.length && new Set(afterIds).size === after.length
            && beforeIds.every(id => afterIds.includes(id))) {
            const afterById = new Map(after.map((item, index) => [afterIds[index], item]));
            for (let index = 0; index < before.length; index++) {
                changedFormFields(before[index], afterById.get(beforeIds[index]!)!, `${path}.*`, output);
            }
        } else {
            output.add(path);
        }
        return;
    }
    output.add(path);
}

/** Return changed field paths only; values and object IDs are deliberately omitted. */
export function shotFormChangedFields(draft: ShotFormDraft) {
    const fields = new Set<string>();
    changedFormFields(draft.base, draft.value, "", fields);
    fields.delete("utterances.*.voiceover"); // Derived from subject presentation, not directly edited.
    return [...fields].filter(Boolean).sort();
}

/** Explicitly keep the reviewed edits while retaining remote fields the user did not edit. */
export function rebaseShotFormDraft(draft: ShotFormDraft, shot: Record<string, any>, source?: Record<string, any>): ShotFormDraft {
    const textMode = draft.version === 1 ? "whole" : "segment";
    const base = shotFormValue(shot, source, textMode), value = mergeDraftFields(draft.base, draft.value, base) as ShotFormValue;
    return { version: draft.version, shotId: draft.shotId, base, value: normalizeUtteranceVoiceovers(value, source) };
}

export function subjectDisplayName(source: Record<string, any>, subjectId: string) {
    const subject = rows(source.subject_registry).find(item => String(item.id) === subjectId), entity = subject?.entityRef;
    const registry = entity?.kind === "character" ? rows(source.character_registry) : entity?.kind === "scene" ? rows(source.scene_registry) : rows(source.asset_plan);
    const item = registry.find(item => String(item.id || item.asset_id) === String(entity?.id));
    const entityName = String(item?.name || item?.asset_name || item?.scene_name || item?.title || "");
    if (entityName.trim()) return entityName;
    // Fall back to stored display_name only when entity lookup fails (legacy/unregistered subjects).
    if (typeof subject?.display_name === "string" && subject.display_name.trim()) return subject.display_name;
    return subjectId;
}

export function productionWorkbenchValue(production: Record<string, any>, view: "subject" | "shot" | "clip") {
    return production.workbench || production[`${view}Workbench`];
}


/** Edit the actual entity field rather than creating a second display description. */
export function subjectDescriptionField(kind: string, row: Record<string, any>) {
    const fields = kind === "character" ? ["appearance", "description", "prompt_description", "identity"] : kind === "environment" ? ["description", "prompt_description"] : ["description", "prompt"];
    return fields.find(field => typeof row[field] === "string" ? Boolean(row[field].trim()) : Boolean(row[field] && typeof row[field] === "object")) || fields[0];
}
