import { mergeDirectorInput } from "./input-merge.js";
import { hasExecutableH3Prompt, inputHash } from "./canvas-inputs.js";
import { outgoingDirectorBoundary } from "@basketikun/canvas-agent/drama/production-validation";
import { isH3StyleTemplateId } from "@basketikun/canvas-agent/plugins/minimax-h3/style-templates";
import { BASE_H3_NODE_METADATA, createH3NodeMetadata } from "@basketikun/canvas-agent/plugins/minimax-h3/node-factory";
import { resolveH3Runtime, H3_PARAM_KEYS } from "@basketikun/canvas-agent/plugins/minimax-h3/runtime-params";
import crypto from "node:crypto";
import { currentCompilationArtifact } from "@basketikun/canvas-agent/drama/compilation-scope";
import { buildCharacterGroupFromExistingNode } from "@basketikun/canvas-agent/plugins/minimax-h3/character-groups";
import { assertReferenceCompilation, compileReferenceSubmission } from "@basketikun/canvas-agent/reference-contract";
import { canonicalProduction, isSubjectPromptAssembly, productionSceneEntries, promptSourceMapSchema, resolveSubjectPictureBindingIds, type EpisodeProductionData, type ProductionLayoutPlan } from "@basketikun/canvas-agent/drama/production-contract";
import { directorArtifact } from "./director.js";
import type { SharedSubjectPictureMedia } from "./shared-subject-picture.js";
import type { CanvasOperation } from "../canvas/project-ops.js";
const stableId = (kind: string, ...parts: string[]) => `${kind}-${crypto.createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 24)}`;
const object = (value: any): Record<string, any> => value && typeof value === "object" && !Array.isArray(value) ? value : {};
export type ReferenceSync = { targetId: string; status: "ready" | "blocked"; referenceCount: number; inputHash?: string; diagnostics: Array<{ code: string; message: string }> };
export const CLIP_PROJECTION_FIELDS = ["sourceShotId", "title", "duration", "taskMode", "prompt", "referenceBindings", "referenceOrder", "tailFrameContinuation", "motionContextEnabled", "directorEngine", "directorSourceHash", "styleTemplateId", "h3CharacterGroups", "storyboardShots", "aspectRatio", "modelName"];
const ACTIVE_H3_SEGMENT_STATUSES = new Set(["pending", "queued", "loading", "running", "generating", "awaiting_confirmation", "awaiting_review", "paused", "cancelling"]);
const TERMINAL_H3_SEGMENT_STATUSES = new Set(["idle", "success", "succeeded", "failed", "error", "cancelled", "canceled", "complete", "completed"]);
type SharedClipImage = { storageKey?: string; url?: string; mimeType?: string; name?: string; bindingId?: string };
function hasActiveH3SegmentTask(segment: Record<string, any>) {
    const status = String(segment.status || "").toLowerCase();
    if (ACTIVE_H3_SEGMENT_STATUSES.has(status)) return true;
    const hasTaskState = Boolean(segment.runtimeTaskId || segment.taskId) || Number(segment.progress || 0) > 0;
    return hasTaskState && !TERMINAL_H3_SEGMENT_STATUSES.has(status);
}
function normalizeProjectedReferenceRoles(value: unknown) {
    return Array.isArray(value) ? value.map(item => {
        const reference = object(item), role = String(reference.role || "");
        const normalized: Record<string, any> = { ...reference, ...(role === "character_identity" ? { role: "identity" } : role === "audio_reference" ? { role: "source_audio" } : {}) };
        // H3 stores generated asset IDs under a display-local namespace. The
        // source node plus storage key identifies the actual media across that
        // adapter boundary, so its generated assetId alias is not a user edit.
        delete normalized.assetId;
        return normalized;
    }) : value;
}

function enabledImageBindings(value: unknown) {
    return Array.isArray(value) ? value.map(object).filter(binding => binding.enabled !== false
        && (String(binding.mediaType || "image") === "image")) : [];
}

function referenceBindingMatch(left: Record<string, any>, right: Record<string, any>) {
    const leftId = String(left.id || ""), rightId = String(right.id || "");
    if (leftId && rightId && leftId === rightId) return true;
    const leftNodeId = String(left.sourceNodeId || ""), rightNodeId = String(right.sourceNodeId || "");
    const leftMedia = String(left.storageKey || left.url || ""), rightMedia = String(right.storageKey || right.url || "");
    return Boolean(leftNodeId && leftNodeId === rightNodeId && leftMedia && leftMedia === rightMedia);
}

/** Rebase Picture ordinals by binding identity after H3 references are reordered or extended. */
export function remapPromptPicturesByBinding(prompt: string, beforeValue: unknown, afterValue: unknown) {
    const before = enabledImageBindings(beforeValue), after = enabledImageBindings(afterValue);
    // A fresh compilation can add keyframes while the Clip still carries extra
    // manual references. Keep the compiler's Picture identities stable across
    // that larger effective list instead of skipping the rebase on count alone.
    const matches = before.map(binding => {
        const candidates = after.map((candidate, index) => ({ candidate, index })).filter(item => referenceBindingMatch(binding, item.candidate));
        return candidates.length === 1 ? candidates[0].index + 1 : undefined;
    });
    if (matches.some(value => value === undefined) || new Set(matches).size !== before.length) return undefined;
    const ordinals = new Map(before.map((_, index) => [index + 1, matches[index]!]));
    let unresolved = false;
    const remapped = prompt.replace(/<Picture\s+(\d+)>/giu, (tag, number: string) => {
        const target = ordinals.get(Number(number));
        if (target === undefined) { unresolved = true; return tag; }
        return `<Picture ${target}>`;
    });
    return unresolved ? undefined : remapped;
}

/**
 * `h3CharacterGroups` mixes authored selection with generated identity. An outfit
 * row's `id` is a hash of the source character node plus its image key, so
 * replacing or re-projecting that character node rewrites every outfit id with no
 * user edit at all; an absent `outfitEnabled` also means the same thing as `true`.
 * Comparing the raw rows would mark such a Clip as "manually edited" forever.
 */
function normalizeProjectedCharacterGroups(value: unknown) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([id, raw]) => {
        const group = object(raw), normalized: Record<string, unknown> = { ...group, outfitEnabled: group.outfitEnabled !== false };
        if (Array.isArray(group.outfits)) normalized.outfits = group.outfits.map(outfit => {
            const { id: _generatedOutfitId, ...rest } = object(outfit);
            return rest;
        });
        return [id, normalized];
    }));
}
/** Character-group outfits are a derived H3 view of the Subject bindings selected by this Clip. */
export function reconcileCharacterGroupOutfitSelection(groupsValue: unknown, bindingsValue: unknown) {
    if (!groupsValue || typeof groupsValue !== "object" || Array.isArray(groupsValue)) return groupsValue;
    const bindings = Array.isArray(bindingsValue) ? bindingsValue.map(object).filter(binding => binding.enabled !== false
        && String(binding.mediaType || "image") === "image") : [];
    return Object.fromEntries(Object.entries(groupsValue as Record<string, unknown>).map(([groupId, raw]) => {
        const group = object(raw);
        if (!Array.isArray(group.outfits)) return [groupId, group];
        const nodeId = String(group.characterNodeId || "");
        const outfits = group.outfits.map((rawOutfit) => {
            const outfit = object(rawOutfit), outfitId = String(outfit.id || "");
            const storageKey = String(outfit.storageKey || ""), url = String(outfit.url || "");
            const selected = bindings.some(binding => {
                const sameSlot = String(binding.groupId || "") === groupId && String(binding.outfitId || "") === outfitId;
                const sameSource = Boolean(nodeId && String(binding.sourceNodeId || "") === nodeId
                    && ((storageKey && String(binding.storageKey || "") === storageKey)
                        || (!storageKey && url && String(binding.url || "") === url)));
                return sameSlot || sameSource;
            });
            return { ...outfit, enabled: selected };
        });
        return [groupId, { ...group, outfits, outfitEnabled: outfits.some(outfit => object(outfit).enabled === true) }];
    }));
}
/** Compare a projected field the way its authored meaning is defined, not its generated bytes. */
function comparableProjectionField(field: string, value: unknown) {
    return field === "referenceBindings" ? normalizeProjectedReferenceRoles(value)
        : field === "h3CharacterGroups" ? normalizeProjectedCharacterGroups(value) : value;
}
function hasManualProjectionEdits(segment: Record<string, any>) {
    const projection = object(segment.productionClipProjection), nextValues = object(projection.nextValues);
    if (Object.keys(nextValues).length) return CLIP_PROJECTION_FIELDS.some(field =>
        canonicalProduction(comparableProjectionField(field, segment[field]) ?? null) !== canonicalProduction(comparableProjectionField(field, nextValues[field]) ?? null));
    const fieldHashes = object(projection.fieldHashes);
    return CLIP_PROJECTION_FIELDS.some(field => typeof fieldHashes[field] === "string" && clipFieldHash(segment[field]) !== fieldHashes[field]);
}
function clipFieldHash(value: unknown) { return crypto.createHash("sha256").update(canonicalProduction(value ?? null)).digest("hex"); }
function initialProjectionBaseline(existing: Record<string, any>, next: Record<string, any>) {
    const baseline: Record<string, string> = {};
    for (const key of CLIP_PROJECTION_FIELDS) {
        const value = existing[key];
        const empty = value === undefined || value === null || value === ""
            || Array.isArray(value) && value.length === 0
            || value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0;
        const blankPrompt = key === "prompt" && !hasExecutableH3Prompt(value);
        // A blank legacy Prompt/reference slot has no manual value to protect. Establish
        // that empty baseline once so the first successful compile can fill it in place.
        if (empty || blankPrompt || inputHash(value) === inputHash(next[key])) baseline[key] = inputHash(value);
    }
    return baseline;
}
export function clipInputHash(segment: Record<string, any>) {
    const fields: Array<[string, unknown]> = CLIP_PROJECTION_FIELDS.map(key => [key, segment[key] ?? null]);
    if (segment.productionClipProjection?.styleTemplateDeclared === true) fields.push(["styleTemplateDeclared", true]);
    return clipFieldHash(fields);
}

/** Rebase only H3 media fields that point at the changed shared entity source. */
export function sharedAssetClipInputOperations(project: Record<string, any>, source: { sourceProjectId: string; sourceNodeId: string },
    media: SharedSubjectPictureMedia[]): CanvasOperation[] {
    if (!media.length) return [];
    const nodes = Array.isArray(project.nodes) ? project.nodes as Array<Record<string, any>> : [];
    const nodeById = new Map(nodes.map(node => [String(node.id || ""), node]));
    const mediaByBindingId = new Map(media.map(item => [item.bindingId, item]));
    const linkedNode = (nodeId: string) => {
        const node = nodeById.get(nodeId), metadata = object(node?.metadata);
        const ref = object(metadata.sharedAssetReference || metadata.sharedAssetOrigin);
        return node && ref.sourceProjectId === source.sourceProjectId && ref.sourceNodeId === source.sourceNodeId ? node : undefined;
    };
    const roleMatches = (role: string, item: SharedSubjectPictureMedia) => {
        const aliases: Record<string, string[]> = { character_identity: ["identity", "appearance"], character_turnaround: ["identity", "turnaround", "clothing"], environment: ["environment", "scene"], scene: ["environment", "scene"], prop: ["prop", "identity"] };
        const values = aliases[role] || [role];
        return item.provides.some(value => values.includes(value)) || item.defaultFor.some(value => values.includes(value));
    };
    const characterImageFor = (reference: Record<string, any>, node: Record<string, any> | undefined): SharedClipImage | undefined => {
        if (!node || node.type !== "character") return undefined;
        const images = Array.isArray(node.metadata?.characterImages) ? node.metadata.characterImages as Array<Record<string, any>> : [];
        if (!images.length) return undefined;
        // The exact sourceNodeId has already established provenance. Within that node,
        // use the persisted H3 label to retain which shared look/outfit each slot means.
        const label = String(reference.label || "").split(/\s+[·•]\s+/).pop()?.trim() || "";
        const labels = (image: Record<string, any>) => [image.outfit, image.name, image.title].map(value => String(value || "").trim()).filter(Boolean);
        const matches = label ? images.filter(image => labels(image).some(value => label === value || label.endsWith(value))) : [];
        const picked = matches.length === 1 ? matches[0] : images.find(image => {
            const key = String(image.storageKey || image.url || image.content || "");
            return key && key === String(reference.storageKey || reference.url || "");
        });
        if (!picked) return undefined;
        return { ...picked, storageKey: String(picked.storageKey || ""), url: String(picked.url || picked.content || ""),
            mimeType: String(picked.mimeType || "image/png"), name: String(picked.outfit || picked.name || picked.title || node.title || "") };
    };
    const outfitImageBySlot = new Map<string, Map<string, SharedClipImage>>();
    for (const h3Node of nodes) {
        if (!String(h3Node.type || "").startsWith("minimax-h3:")) continue;
        const clipSegments = Array.isArray(h3Node.metadata?.segments) ? h3Node.metadata.segments as Array<Record<string, any>> : [];
        for (const segment of clipSegments) {
            for (const reference of Array.isArray(segment.referenceBindings) ? segment.referenceBindings as Array<Record<string, any>> : []) {
                const groupId = String(reference.groupId || ""), outfitId = String(reference.outfitId || ""), sourceNodeId = String(reference.sourceNodeId || "");
                if (!groupId || !outfitId || !linkedNode(sourceNodeId)) continue;
                const image = characterImageFor(reference, linkedNode(sourceNodeId));
                if (!image?.storageKey) continue;
                const slot = `${sourceNodeId}\0${groupId}\0${outfitId}`;
                const candidates = outfitImageBySlot.get(slot) || new Map<string, SharedClipImage>();
                candidates.set(image.storageKey, image);
                outfitImageBySlot.set(slot, candidates);
            }
        }
    }
    const mediaFor = (reference: Record<string, any>, nodeId: string): SharedClipImage | undefined => {
        const direct = String(reference.pictureBindingId || "");
        if (direct && mediaByBindingId.has(direct)) return mediaByBindingId.get(direct);
        const nodeCandidates = media.filter(item => item.nodeId === nodeId);
        const subjectCandidates = reference.subjectId ? nodeCandidates.filter(item => item.subjectId === String(reference.subjectId)) : [];
        // Older Clip snapshots sometimes store the stable production entity ID in
        // subjectId instead of the Subject registry ID. The exact source node is
        // still authoritative, so only use it when it yields an unambiguous binding.
        let candidates = subjectCandidates.length ? subjectCandidates : nodeCandidates;
        const roleCandidates = candidates.filter(item => roleMatches(String(reference.role || ""), item));
        if (roleCandidates.length) candidates = roleCandidates;
        if (candidates.length === 1) return candidates[0];
        const defaults = candidates.filter(item => item.defaultFor.includes("identity"));
        return defaults.length === 1 ? defaults[0] : undefined;
    };
    const operations: CanvasOperation[] = [];
    for (const node of nodes) {
        if (!String(node.type || "").startsWith("minimax-h3:")) continue;
        const segments = Array.isArray(node.metadata?.segments) ? node.metadata.segments as Array<Record<string, any>> : [];
        for (const segment of segments) {
            const priorHash = clipInputHash(segment);
            const refs = Array.isArray(segment.referenceBindings) ? segment.referenceBindings as Array<Record<string, any>> : [];
            let changed = false;
            const referenceBindings: Array<Record<string, any>> = refs.map(reference => {
                const sourceNodeId = String(reference.sourceNodeId || "");
                const sourceNode = linkedNode(sourceNodeId);
                if (!sourceNode) return reference;
                const selected = characterImageFor(reference, sourceNode) || mediaFor(reference, sourceNodeId);
                const next = selected
                    ? { ...reference, storageKey: selected.storageKey, url: selected.url || "", mimeType: selected.mimeType,
                        sourceNodeId, pictureBindingId: reference.pictureBindingId || selected.bindingId, enabled: true }
                    : { ...reference, storageKey: "", url: "", sourceNodeId };
                if (canonicalProduction(reference) !== canonicalProduction(next)) changed = true;
                return next;
            });
            const groups = object(segment.h3CharacterGroups);
            const h3CharacterGroups = Object.fromEntries(Object.entries(groups).map(([groupId, raw]) => {
                const group = object(raw), sourceNodeId = String(group.characterNodeId || ""), characterNode = linkedNode(sourceNodeId);
                if (!characterNode) return [groupId, raw];
                const metadata = object(characterNode.metadata);
                const groupEnabled = new Map(referenceBindings.filter(reference => String(reference.groupId || "") === groupId)
                    .map(reference => [String(reference.outfitId || ""), reference.enabled !== false]));
                const outfits = (Array.isArray(group.outfits) ? group.outfits : []).map((rawOutfit: unknown) => {
                    const outfit = object(rawOutfit);
                    const linkedReference = referenceBindings.find(reference => String(reference.groupId || "") === groupId
                        && String(reference.outfitId || "") === String(outfit.id || ""));
                    const siblingImages = outfitImageBySlot.get(`${sourceNodeId}\0${groupId}\0${String(outfit.id || "")}`);
                    const siblingImage = siblingImages?.size === 1 ? [...siblingImages.values()][0] : undefined;
                    const selected = (linkedReference ? characterImageFor(linkedReference, characterNode) : undefined)
                        || siblingImage || characterImageFor(outfit, characterNode)
                        || mediaFor({ ...outfit, subjectId: group.subjectId, role: outfit.role }, sourceNodeId);
                    const next = selected
                        ? { ...outfit, url: selected.url || "", storageKey: selected.storageKey, mimeType: selected.mimeType, name: selected.name,
                            pictureBindingId: outfit.pictureBindingId || selected.bindingId,
                            ...(groupEnabled.has(String(outfit.id || "")) ? { enabled: groupEnabled.get(String(outfit.id || "")) } : {}) }
                        : { ...outfit, url: "", storageKey: "" };
                    if (canonicalProduction(outfit) !== canonicalProduction(next)) changed = true;
                    return next;
                });
                const voice = metadata.characterVoiceUrl ? { url: metadata.characterVoiceUrl, name: metadata.characterVoiceName || "声线",
                    description: metadata.characterVoiceDescription || undefined, storageKey: metadata.characterVoiceStorageKey || undefined,
                    assetId: metadata.characterVoiceAssetId || undefined } : undefined;
                const nextGroup = { ...group, characterName: metadata.characterName || characterNode.title || group.characterName,
                    characterAssetId: metadata.characterAssetId || group.characterAssetId, outfits, voice };
                if (canonicalProduction(group) !== canonicalProduction(nextGroup)) changed = true;
                return [groupId, nextGroup];
            }));
            if (!changed) continue;
            const nextSegment: Record<string, any> = { ...segment, referenceBindings, h3CharacterGroups };
            const inputChanged = clipInputHash(nextSegment) !== priorHash;
            const projection = object(segment.productionClipProjection);
            const fieldHashes = { ...object(projection.fieldHashes),
                referenceBindings: clipFieldHash(referenceBindings), h3CharacterGroups: clipFieldHash(h3CharacterGroups) };
            nextSegment.productionClipProjection = { ...projection,
                nextValues: { ...object(projection.nextValues), referenceBindings, h3CharacterGroups }, fieldHashes,
                inputHash: clipInputHash(nextSegment) };
            if (segment.resultStorageKey && inputChanged) nextSegment.inputOutdated = true;
            operations.push({ type: "update_h3_segment", nodeId: String(node.id), segmentId: String(segment.id), patch: nextSegment });
        }
    }
    return operations;
}
function hasMissingPromptReferenceBindings(segment: Record<string, any>) {
    const bindings = Array.isArray(segment.referenceBindings) ? segment.referenceBindings.filter((binding: any) => binding?.enabled !== false) : [];
    const maximum: Record<string, number> = { Picture: 0, Video: 0, Audio: 0 };
    for (const match of String(segment.prompt || "").matchAll(/<(Picture|Video|Audio)\s+(\d+)>/g)) {
        maximum[match[1]] = Math.max(maximum[match[1]], Number(match[2]));
    }
    const count: Record<string, number> = {
        Picture: bindings.filter((binding: any) => String(binding.label || "").startsWith("<Picture ")).length,
        Video: bindings.filter((binding: any) => String(binding.label || "").startsWith("<Video ")).length,
        Audio: bindings.filter((binding: any) => String(binding.label || "").startsWith("<Audio ")).length,
    };
    return Object.entries(maximum).some(([kind, ordinal]) => ordinal > count[kind]);
}
function requiredSubjectStoryboardFrame(director: NonNullable<EpisodeProductionData["director"]>, shotId: string) {
    if (!isSubjectPromptAssembly(director.source)) return undefined;
    const shot = (Array.isArray(director.source.shots) ? director.source.shots : []).map(object).find(item => String(item.id || "") === shotId);
    const frames = Array.isArray(shot?.keyframes) ? shot.keyframes.map(object).filter(frame => frame.requiredForSubmission === true && frame.anchor !== "composition") : [];
    return frames.find(frame => frame.anchor === "opening") || frames[0];
}
function referenceMatchesSubjectFrame(director: NonNullable<EpisodeProductionData["director"]>, frame: Record<string, any>, reference: Record<string, any>) {
    const assetId = String(frame.assetId || frame.id || "");
    if (assetId && String(reference.assetId || "") === assetId) return true;
    const asset = director.assets[assetId];
    const nodeId = String(asset?.nodeId || frame.sourceNode?.nodeId || "");
    const referenceNodeId = String(reference.nodeId || reference.sourceNodeId || "");
    const storageKey = String(asset?.storageKey || "");
    return Boolean(nodeId && referenceNodeId === nodeId && (!storageKey || String(reference.storageKey || "") === storageKey));
}
function reconcileSubjectImageReferences(segment: Record<string, any>, director: NonNullable<EpisodeProductionData["director"]>, group: EpisodeProductionData["clipGroups"][number], compiledBindings?: unknown) {
    if (!isSubjectPromptAssembly(director.source)) return;
    const subjects = (Array.isArray(director.source.subject_registry) ? director.source.subject_registry : []).map(object);
    const subjectsById = new Map(subjects.map(subject => [String(subject.id || ""), subject]));
    const bindingsById = new Map<string, { subjectId: string; binding: Record<string, any> }>();
    const bindingsByNodeId = new Map<string, { subjectId: string; binding: Record<string, any> }[]>();
    for (const subject of subjects) for (const binding of (Array.isArray(subject.pictureBindings) ? subject.pictureBindings : []).map(object)) {
        const subjectId = String(subject.id || ""), bindingId = String(binding.id || "");
        if (bindingId) bindingsById.set(bindingId, { subjectId, binding });
        const nodeId = String(object(binding.sourceNode).nodeId || "");
        if (nodeId) bindingsByNodeId.set(nodeId, [...(bindingsByNodeId.get(nodeId) || []), { subjectId, binding }]);
    }
    const sourceShots = (Array.isArray(director.source.shots) ? director.source.shots : []).map(object);
    const usedBindingIds = new Set<string>();
    const visuallyUsedSubjectIds = new Set<string>();
    for (const shotId of group.shotIds) {
        const shot = sourceShots.find(item => String(item.id || "") === shotId);
        for (const usage of (Array.isArray(shot?.subject_usages) ? shot.subject_usages : []).map(object)) {
            const subjectId = String(usage.subjectId || ""), subject = subjectsById.get(subjectId);
            if (!subject) continue;
            const resolved = resolveSubjectPictureBindingIds(subject, usage);
            for (const bindingId of resolved.bindingIds) usedBindingIds.add(bindingId);
            if (usage.presentation === "visible" && resolved.bindingIds.length) visuallyUsedSubjectIds.add(subjectId);
        }
    }
    const referenceIsUsed = (reference: Record<string, any>): boolean | undefined => {
        const explicitSubjectId = String(reference.subjectId || "");
        const nodeId = String(reference.sourceNodeId || reference.nodeId || "");
        const nodeBindings = bindingsByNodeId.get(nodeId) || [];
        const knownSubjectId = explicitSubjectId && subjectsById.has(explicitSubjectId) ? explicitSubjectId : "";
        // Legacy character-group references may carry the stable production entity
        // node ID as subjectId. Resolve those only through the exact source node and
        // then the Shot's explicitly selected pictureBindingIds; never by display name.
        if (explicitSubjectId && !knownSubjectId && !nodeBindings.length) return false;
        const bindingId = String(reference.outfitId || reference.pictureBindingId || "");
        const byId = bindingsById.get(bindingId);
        if (byId) return usedBindingIds.has(bindingId);
        const subjectId = knownSubjectId
            ? knownSubjectId
            : new Set(nodeBindings.map(item => item.subjectId)).size === 1 ? nodeBindings[0]?.subjectId || "" : "";
        if (!subjectId) return undefined;
        const pictureBindingIds = nodeBindings.filter(item => item.subjectId === subjectId).map(item => String(item.binding.id || ""));
        return pictureBindingIds.length ? pictureBindingIds.some(id => usedBindingIds.has(id)) : visuallyUsedSubjectIds.has(subjectId);
    };
    const references = Array.isArray(segment.referenceBindings) ? segment.referenceBindings as Array<Record<string, any>> : [];
    segment.referenceBindings = references.filter(reference => {
        if (reference.enabled === false || reference.mediaType !== "image" || ["storyboard", "keyframe"].includes(String(reference.role || ""))) return true;
        // A bound picture is retained only when a Shot explicitly selects it for this Clip.
        // Keyframe subjectIds and camera attention do not participate in this decision.
        const used = referenceIsUsed(reference);
        return used === undefined || used;
    });
    const groups = reconcileCharacterGroupOutfitSelection(segment.h3CharacterGroups, compiledBindings ?? segment.referenceBindings) as Record<string, any>;
    segment.h3CharacterGroups = groups;
    for (const [id, value] of Object.entries(groups)) {
        const characterGroup = object(value), subjectId = String(characterGroup.subjectId || "");
        if (subjectId && subjectsById.has(subjectId) && !visuallyUsedSubjectIds.has(subjectId) && characterGroup.outfitEnabled !== false) {
            groups[id] = { ...characterGroup, outfitEnabled: false };
        }
    }
}
export function buildProductionClip(project: Record<string, any>, published: EpisodeProductionData, group: EpisodeProductionData["clipGroups"][number], segmentId: string, runSettings?: Record<string, unknown>) {
    const nodes: Record<string, any>[] = Array.isArray(project.nodes) ? project.nodes : [];
    const shots = group.shotIds.map(id => published.shots.find(shot => shot.id === id)).filter((shot): shot is NonNullable<typeof shot> => !!shot);
    const settings = runSettings || published.settings as unknown as Record<string, unknown>;
    // [临时] 注释掉 H3 模型设置强制覆盖，模型回落到节点 metadata（本地 ComfyUI 模型）
    // const h3Model = String(object(settings.h3Models)[group.id] || settings.h3Model || "");
    const authored = directorArtifact(published, "h3", group.id);
    const d = published.director!;
    if (!currentCompilationArtifact(d, authored) || authored.receipt.promptHash !== authored.sha256) throw new Error("编译回执已过期，请修改源稿后重新编译");
    const planned = (d.source.segments as Array<Record<string, any>>).find(s => s.id === group.id)!;
    const styleTemplateId = planned.styleTemplateId ?? null;
    if (styleTemplateId !== null && !(isH3StyleTemplateId(styleTemplateId) || typeof styleTemplateId === "string" && /^[a-z0-9][a-z0-9-]{0,47}$/i.test(styleTemplateId))) throw new Error(`无效 H3 风格模板 ID：${styleTemplateId}`);
    const subjectIdsByAsset = new Map<string, Set<string>>();
    for (const subject of Array.isArray(d.source.subject_registry) ? d.source.subject_registry as Array<Record<string, any>> : []) {
        for (const binding of Array.isArray(subject.pictureBindings) ? subject.pictureBindings as Array<Record<string, any>> : []) {
            const assetId = String(binding.assetId || "");
            if (!assetId) continue;
            const ids = subjectIdsByAsset.get(assetId) || new Set<string>();
            ids.add(String(subject.id)); subjectIdsByAsset.set(assetId, ids);
        }
    }
    const pictureBindingFor = (ref: Record<string, any>, subjectId: string | undefined) => {
        if (!subjectId) return undefined;
        const subject = (Array.isArray(d.source.subject_registry) ? d.source.subject_registry : [])
            .map(object).find(item => String(item.id || "") === subjectId);
        const matches = (Array.isArray(subject?.pictureBindings) ? subject.pictureBindings : []).map(object)
            .filter(binding => String(object(binding.sourceNode).nodeId || "") === String(ref.nodeId || "")
                && String(binding.assetId || "") === String(ref.assetId || ""));
        return matches.length === 1 ? matches[0] : undefined;
    };
    const bindings: Array<Record<string, unknown>> = authored.references.map((ref, index) => {
        const subjectIds = subjectIdsByAsset.get(String(ref.assetId || ""));
        const subjectId = ref.role === "keyframe" || ref.role === "storyboard" || subjectIds?.size !== 1 ? undefined : [...subjectIds][0];
        const pictureBinding = pictureBindingFor(ref, subjectId);
        const pictureBindingId = String(pictureBinding?.id || "") || undefined;
        const picturePurpose = Array.isArray(pictureBinding?.provides) ? pictureBinding.provides.map(String) : undefined;
        return {
            id: stableId("binding", group.id, ref.label), assetId: stableId("asset", ref.nodeId, ref.storageKey),
            label: ref.label, role: ref.role === "environment" ? "scene" : ref.role, tags: [], enabled: true, usage: "reference",
            mediaType: ref.label.startsWith("<Video") ? "video" : ref.label.startsWith("<Audio") ? "audio" : "image",
            storageKey: ref.storageKey, sourceNodeId: ref.nodeId, order: index,
            ...(ref.subjectId || subjectId ? { subjectId: ref.subjectId || subjectId } : {}),
            ...(pictureBindingId ? { pictureBindingId } : {}),
            ...(picturePurpose?.length ? { picturePurpose } : {}),
        };
    });
    const characterGroups: Record<string, unknown> = {};
    for (const characterNodeId of new Set(authored.references.filter(ref => nodes.some(n => n.id === ref.nodeId && n.type === "character")).map(ref => ref.nodeId))) {
        const refs = authored.references.filter(ref => ref.nodeId === characterNodeId);
        const characterNode = nodes.find(n => n.id === characterNodeId)!;
        // Some formal Subject bindings reference an archived image directly. A
        // projected `character` node can exist without a characterImages outfit
        // catalog; keep that verified binding instead of blocking Clip sync or
        // manufacturing a second catalog entry for the same image.
        if (!Array.isArray(object(characterNode.metadata).characterImages) || !object(characterNode.metadata).characterImages.length) continue;
        const built = buildCharacterGroupFromExistingNode(characterNode, {
            selectedOutfitStorageKeys: refs.filter(r => r.label.startsWith("<Picture")).map(r => r.storageKey),
            voiceEnabled: refs.some(r => r.label.startsWith("<Audio")), subjectId: String(refs.find(r => r.subjectId)?.subjectId || characterNodeId),
        });
        const pictureRefs = refs.filter(ref => ref.label.startsWith("<Picture"));
        const mappedPictureRefs = pictureRefs.map(ref => built.refs.find(candidate => candidate.storageKey === ref.storageKey && candidate.sourceNodeId === ref.nodeId));
        // Character groups have one slot per source image. If multiple authored
        // Picture labels resolve to the same slot, resolveCharacterGroupBindings
        // would collapse them and leave a prompt label without a Clip reference.
        // Keep the exact compiler bindings in that case; the group is optional UI
        // metadata and must not change the compiled image count.
        if (mappedPictureRefs.some(ref => !ref) || new Set(mappedPictureRefs.map(ref => ref!.id)).size !== pictureRefs.length) continue;
        const groupOutfits = built.group.outfits.map(outfit => {
            const projectedReference = bindings.find(ref => ref.sourceNodeId === characterNodeId && ref.storageKey === outfit.storageKey);
            const pictureBindingId = String(projectedReference?.pictureBindingId || "") || undefined;
            const picturePurpose = Array.isArray(projectedReference?.picturePurpose) ? projectedReference.picturePurpose.map(String) : undefined;
            return pictureBindingId || picturePurpose?.length ? { ...outfit, ...(pictureBindingId ? { pictureBindingId } : {}), ...(picturePurpose?.length ? { picturePurpose } : {}) } : outfit;
        });
        characterGroups[built.group.id] = { ...built.group, outfits: groupOutfits };
        bindings.forEach((binding, index) => {
            const groupRef = built.refs.find(ref => ref.storageKey === binding.storageKey && ref.sourceNodeId === binding.sourceNodeId);
            if (groupRef) bindings[index] = { ...groupRef, order: index,
                ...(binding.pictureBindingId ? { pictureBindingId: binding.pictureBindingId } : {}),
                ...(Array.isArray(binding.picturePurpose) ? { picturePurpose: binding.picturePurpose } : {}),
                ...(Array.isArray(binding.picturePurpose) ? { tags: [...new Set([...groupRef.tags, ...binding.picturePurpose.map(String)])] } : {}) };
        });
    }
    const taskMode = ({ T2VA: "t2v", I2VA: "i2v", FL2VA: "fl2v", L2VA: "l2v", Ref2VA: "ref2va" } as Record<string, string>)[String(planned.mode)];
    if (!taskMode) throw new Error(`未知 Acheng 模式 ${planned.mode}`);
    let prompt = authored.prompt;
    const boundary = outgoingDirectorBoundary(d, group.id);
    const subjectAssembly = isSubjectPromptAssembly(d.source);
    // Production Shot identity must survive independently of generated/approved keyframe media.
    // H3 renders unbound cells as placeholders; storyboardImageMode controls image references,
    // never the Shot-to-cell mapping itself.
    const storyboardShots = shots.map(shot => {
        const duration = Number(shot.duration || 0);
        if (settings.storyboardImageMode === "skip") return { id: shot.id, duration };
        if (subjectAssembly) {
            // Subject Prompt v2 owns keyframes on source.shots[].keyframes. The
            // legacy shotInputs projection can be stale or empty and must not
            // override that source (or block an otherwise valid Clip sync).
            const frame = requiredSubjectStoryboardFrame(d, String(shot.id));
            if (!frame) return { id: shot.id, duration };
            const binding = bindings.find(ref => (ref.role === "keyframe" || ref.role === "storyboard") && referenceMatchesSubjectFrame(d, frame, ref));
            if (!binding) throw new Error(`镜头 ${shot.id} 绑定的关键帧图片未进入当前分段引用`);
            binding.role = "storyboard";
            return { id: shot.id, referenceBindingId: String(binding.id), duration };
        }
        const input = d.shotInputs[shot.id];
        if (input?.keyframePolicy === "none" || !input?.keyframeAssetId) return { id: shot.id, duration };
        const asset = d.assets[input.keyframeAssetId];
        const sourceNodeId = asset?.nodeId || input.keyframeAssetId;
        const binding = bindings.find(ref => ref.sourceNodeId === sourceNodeId);
        if (!binding) throw new Error(`镜头 ${shot.id} 绑定的关键帧图片未进入当前分段引用`);
        binding.role = "storyboard";
        return { id: shot.id, referenceBindingId: String(binding.id), duration };
    });
    const segment: Record<string, any> = { id: segmentId, sourceShotId: group.shotIds.join("~"), title: shots.map(shot => shot.title).join(" / "),
        duration: storyboardShots.reduce((sum, shot) => sum + Number(shot.duration || 0), 0), taskMode, prompt, referenceBindings: bindings,
        // Keep the formal artifact's stable binding order explicit. Otherwise a
        // newly-created Clip can inherit a different order when standalone scene
        // references and derived character-group images are merged by the H3 UI.
        referenceOrder: bindings.map(binding => String(binding.id || "")).filter(Boolean),
        tailFrameContinuation: boundary?.tailFrame === true, motionContextEnabled: boundary?.motionContext === true,
        directorEngine: authored.receipt.engine || (authored.receipt.compilationScope as any)?.engine || d.engine, directorSourceHash: authored.sourceHash, styleTemplateId, h3CharacterGroups: characterGroups,
        ...(storyboardShots ? { storyboardShots } : {}),
        aspectRatio: settings.videoAspectRatio || object(nodes.find((node: any) => node.id === group.nodeId)?.metadata).aspectRatio || BASE_H3_NODE_METADATA.aspectRatio,
        modelName: /* h3Model || */ object(nodes.find((node: any) => node.id === group.nodeId)?.metadata).modelName || BASE_H3_NODE_METADATA.modelName };
    const preflight = compileReferenceSubmission(project, segment);
    assertReferenceCompilation(preflight);
    // The reference compiler also normalizes labels and may add authored outfit
    // guidance. Those legitimate text changes do not indicate a bad reference
    // mapping. Rebase only Picture ordinals by stable binding identity, then run
    // compilation again with that explicit order so its valid guidance is kept.
    const remappedPrompt = remapPromptPicturesByBinding(prompt, bindings, preflight.references);
    if (remappedPrompt === undefined) {
        const describe = (value: unknown) => enabledImageBindings(value).map((binding, index) => {
            const label = String(binding.label || binding.name || "图片");
            const source = String(binding.sourceNodeId || binding.nodeId || "未知节点");
            const media = String(binding.storageKey || "无媒体身份");
            return `<Picture ${index + 1}> ${label} [${source}; ${media}]`;
        }).join(" → ") || "无图片引用";
        throw new Error(`Segment ${group.id} 的图片引用无法按素材身份唯一对应；源稿：${describe(bindings)}；H3 输入：${describe(preflight.references)}。请修正缺失或重复绑定后重新编译。`);
    }
    segment.prompt = remappedPrompt;
    segment.referenceBindings = preflight.bindings;
    segment.referenceOrder = preflight.bindings.map(binding => String(binding.id || "")).filter(Boolean);
    const normalizedPreflight = compileReferenceSubmission(project, segment);
    assertReferenceCompilation(normalizedPreflight);
    prompt = normalizedPreflight.compiledPrompt;
    segment.prompt = prompt;
    segment.referenceBindings = normalizedPreflight.bindings;
    segment.referenceOrder = normalizedPreflight.bindings.map(binding => String(binding.id || "")).filter(Boolean);
    const promptSourceMap = promptSourceMapSchema.safeParse((authored.receipt as Record<string, any>).sourceMap);
    segment.productionClipProjection = { targetId: group.id, sourceHash: authored.sourceHash, artifactId: authored.id, promptHash: authored.sha256,
        promptAssemblyVersion: isSubjectPromptAssembly(d.source) ? 2 : 1, promptSourceMapAvailable: authored.status === "ready" && isSubjectPromptAssembly(d.source) && promptSourceMap.success && promptSourceMap.data.entries.length > 0,
        styleTemplateDeclared: Object.hasOwn(planned, "styleTemplateId"),
        fieldHashes: Object.fromEntries(CLIP_PROJECTION_FIELDS.map(key => [key, clipFieldHash(segment[key])])) };
    segment.productionClipProjection.inputHash = clipInputHash(segment);
    return segment;
}
/** Published content does not replace the model and generation settings saved in the Clip UI. */
export function buildPublishedProductionClip(project: Record<string, any>, published: EpisodeProductionData, group: EpisodeProductionData["clipGroups"][number], segmentId: string, defaults: Record<string, unknown>, runSettings?: Record<string, unknown>) {
    const node = (project.nodes || []).find((node: any) => node.id === group.nodeId);
    const metadata = object(node?.metadata);
    const saved = (metadata.segments || []).find((clip: any) => clip.id === segmentId);
    if (!saved) throw new Error("已发布 Clip 节点不存在");
    const authored = buildProductionClip(project, published, group, segmentId, runSettings);
    const runtime = resolveH3Runtime(saved, {}, metadata, defaults).params;
    const contentKeys = new Set(CLIP_PROJECTION_FIELDS.filter(key => key !== "modelName"));
    const settings = Object.fromEntries(H3_PARAM_KEYS.filter(key => !contentKeys.has(key) && runtime[key] !== undefined).map(key => [key, runtime[key]]));
    if (runtime.steps !== undefined) settings.videoSteps = runtime.steps;
    delete settings.steps;
    const segment: Record<string, any> = { ...authored, ...settings, h3ParameterPolicy: "overrides" };
    segment.productionClipProjection.fieldHashes.modelName = clipFieldHash(segment.modelName);
    segment.productionClipProjection.inputHash = clipInputHash(segment);
    return segment;
}

/** Shot membership and timing remain projectable even while the prompt artifact is stale. */
export function formalStoryboardTrack(data: EpisodeProductionData, group: EpisodeProductionData["clipGroups"][number], existing: Record<string, any>) {
    const director = data.director;
    if (!director) return undefined;
    const sourceShots = (Array.isArray(director.source.shots) ? director.source.shots : []).map(object);
    const shots = group.shotIds.map(id => sourceShots.find(shot => String(shot.id) === id));
    if (!shots.length || shots.some(shot => !shot)) return undefined;
    const fps = Number(director.source.fps_num || 24) / Number(director.source.fps_den || 1);
    if (!Number.isFinite(fps) || fps <= 0) return undefined;
    const refs = Array.isArray(existing.referenceBindings) ? existing.referenceBindings as Array<Record<string, any>> : [];
    const storyboardShots = (shots as Record<string, any>[]).map(shot => {
        const frames = Number(shot.duration_frames), start = Number(shot.start_frame), end = Number(shot.end_frame);
        const duration = Number.isFinite(frames) && frames > 0 ? frames / fps
            : Number.isFinite(start) && Number.isFinite(end) && end > start ? (end - start) / fps
                : Number(data.shots.find(item => item.id === shot.id)?.duration || 0);
        const subjectAssembly = isSubjectPromptAssembly(director.source);
        const frame = subjectAssembly ? requiredSubjectStoryboardFrame(director, String(shot.id)) : undefined;
        const input = subjectAssembly ? undefined : director.shotInputs[shot.id];
        const asset = input?.keyframePolicy !== "none" && input?.keyframeAssetId ? director.assets[input.keyframeAssetId] : undefined;
        const binding = subjectAssembly
            ? frame && refs.find(ref => ref.role === "storyboard" && ref.mediaType === "image" && referenceMatchesSubjectFrame(director, frame, ref))
            : asset && refs.find(ref => ref.role === "storyboard" && ref.mediaType === "image" && ref.storageKey === asset.storageKey
                && (!asset.nodeId || !ref.sourceNodeId || ref.sourceNodeId === asset.nodeId));
        return { id: String(shot.id), duration, ...(binding?.id ? { referenceBindingId: String(binding.id) } : {}) };
    });
    return { storyboardModeEnabled: true, storyboardShots, duration: storyboardShots.reduce((sum, shot) => sum + shot.duration, 0) };
}

export function productionClipProjection(project: Record<string, any>, data: EpisodeProductionData, group: EpisodeProductionData["clipGroups"][number], segmentId: string, existing?: Record<string, any>, overwriteCompiledPrompt = false) {
    const result: ReferenceSync = { targetId: group.id, status: "blocked", referenceCount: 0, diagnostics: [] };
    try {
        let segment = buildProductionClip(project, data, group, segmentId);
        const compiledReferenceBindings = structuredClone(segment.referenceBindings);
        if (existing) {
            const groups = [["referenceBindings", "storyboardShots", "duration"], ["h3CharacterGroups"],
                ...CLIP_PROJECTION_FIELDS.filter(key => !["referenceBindings", "h3CharacterGroups", "storyboardShots", "duration"].includes(key)).map(key => [key])];
            const nextValues = Object.fromEntries(CLIP_PROJECTION_FIELDS.filter(key => Object.hasOwn(segment, key)).map(key => [key, segment[key]]));
            const baseline = { ...(existing.productionClipProjection?.fieldHashes || initialProjectionBaseline(existing, segment)) };
            // Character image bindings are a projection of the Subject picture choice.
            // A stale H3 reference must not outrank the image selected in the production UI.
            const subjectRegistry = object(data.director?.source).subject_registry;
            const formalSubjects: Array<Record<string, any>> = Array.isArray(subjectRegistry) ? subjectRegistry.map(value => object(value)) : [];
            const formalSubjectIds = new Set(formalSubjects.flatMap(subject => [String(subject.id || ""), String(object(subject.entityRef).id || "")]).filter(Boolean));
            const formalBindingIds = new Set<string>();
            const formalCharacterNodeIds = new Set<string>();
            for (const subject of formalSubjects) {
                for (const binding of (Array.isArray(subject.pictureBindings) ? subject.pictureBindings : []).map(object)) {
                    if (binding.id) formalBindingIds.add(String(binding.id));
                    const sourceNode = object(binding.sourceNode);
                    if (sourceNode.nodeId) formalCharacterNodeIds.add(String(sourceNode.nodeId));
                }
                const entityRef = object(subject.entityRef);
                if (entityRef.id) formalCharacterNodeIds.add(String(entityRef.id));
            }
            const isFormalCharacterReference = (value: unknown) => {
                const reference = object(value), role = String(reference.role || "");
                return formalBindingIds.has(String(reference.pictureBindingId || reference.outfitId || ""))
                    || role.startsWith("character_") && (formalSubjectIds.has(String(reference.subjectId || ""))
                        || formalCharacterNodeIds.has(String(reference.sourceNodeId || reference.nodeId || "")));
            };
            const isFormalCharacterGroup = (value: unknown) => {
                const character = object(value), outfits = Array.isArray(character.outfits) ? character.outfits.map(object) : [];
                return formalSubjectIds.has(String(character.subjectId || ""))
                    || formalCharacterNodeIds.has(String(character.characterNodeId || ""))
                    || outfits.some(outfit => formalBindingIds.has(String(outfit.pictureBindingId || outfit.id || ""))
                        || formalCharacterNodeIds.has(String(outfit.sourceNodeId || "")));
            };
            const groupShotIds = new Set(group.shotIds.map(String));
            const formalShotReferenceNodeIds = new Set((Array.isArray(object(data.director?.source).shots) ? object(data.director?.source).shots as Array<Record<string, any>> : [])
                .filter(shot => groupShotIds.has(String(object(shot).id || "")))
                .flatMap(shot => (Array.isArray(object(shot).reference_requirements) ? object(shot).reference_requirements as Array<Record<string, any>> : [])
                    .filter(reference => object(reference).requiredForSubmission === true)
                    .map(reference => String(object(object(reference).sourceNode).nodeId || "")))
                .filter(Boolean));
            const isFormalShotReference = (value: unknown) => formalShotReferenceNodeIds.has(String(object(value).sourceNodeId || object(value).nodeId || ""));
            const compiledCharacterReferences = segment.referenceBindings.filter(isFormalCharacterReference);
            const compiledShotReferences = segment.referenceBindings.filter(isFormalShotReference);
            if (compiledCharacterReferences.length || compiledShotReferences.length) {
                const currentReferences = Array.isArray(existing.referenceBindings) ? existing.referenceBindings : [];
                const preservedReferences = currentReferences.filter(reference => !isFormalCharacterReference(reference) && !isFormalShotReference(reference));
                segment.referenceBindings = [...compiledCharacterReferences, ...compiledShotReferences, ...preservedReferences];
                baseline.referenceBindings = inputHash(existing.referenceBindings);
            }
            const compiledCharacterGroups = Object.entries(segment.h3CharacterGroups || {}).filter(([, value]) => isFormalCharacterGroup(value));
            if (compiledCharacterGroups.length) {
                const currentGroups = object(existing.h3CharacterGroups);
                const preservedGroups = Object.fromEntries(Object.entries(currentGroups).filter(([, value]) => !isFormalCharacterGroup(value)));
                segment.h3CharacterGroups = { ...preservedGroups, ...Object.fromEntries(compiledCharacterGroups) };
                baseline.h3CharacterGroups = inputHash(existing.h3CharacterGroups);
            }
            // An older projection can leave a stale referenceBindings array marked
            // as manual even while its saved Prompt is still byte-for-byte the
            // compiler output. When that exact Prompt has more Picture/Video/Audio
            // slots than the saved bindings, the array is an incomplete projection.
            // Rebase only referenceBindings from the same artifact; preserve manual
            // storyboard, duration, character-group, and all other field edits.
            if (existing.prompt === segment.prompt && hasMissingPromptReferenceBindings(existing)) {
                baseline.referenceBindings = inputHash(existing.referenceBindings);
                groups[0] = ["referenceBindings"];
            }
            // Older projection receipts may omit a Prompt baseline because the
            // legacy `DRAFT` scaffold was mistaken for authored text. Treat that
            // non-executable scaffold as empty once; preserve substantive manual
            // Prompts through the normal three-way merge.
            if (!hasExecutableH3Prompt(existing.prompt)) baseline.prompt = inputHash(existing.prompt);
            const merged = mergeDirectorInput(existing, segment, baseline, groups);
            const mergedSegment = merged.merged;
            const preserveManualCharacterGroups = merged.manualFields.includes("h3CharacterGroups");
            const hasManualCharacterGroups = Object.hasOwn(mergedSegment, "h3CharacterGroups");
            const manualCharacterGroups = preserveManualCharacterGroups && hasManualCharacterGroups ? structuredClone(mergedSegment.h3CharacterGroups) : undefined;
            // A successfully applied fresh H3 compilation owns the Prompt field.
            // Other Clip inputs still use the normal three-way merge, but an old
            // translated or hand-edited canvas Prompt must not block the new artifact.
            // The formal boundary also owns its outgoing continuation flags: applying
            // the fresh compilation must bring the scene H3 controls back in sync.
            if (overwriteCompiledPrompt) {
                mergedSegment.prompt = segment.prompt;
                mergedSegment.tailFrameContinuation = segment.tailFrameContinuation;
                mergedSegment.motionContextEnabled = segment.motionContextEnabled;
            }
            reconcileSubjectImageReferences(mergedSegment, data.director!, group, segment.referenceBindings);
            if (preserveManualCharacterGroups) {
                if (hasManualCharacterGroups) mergedSegment.h3CharacterGroups = manualCharacterGroups;
                else delete mergedSegment.h3CharacterGroups;
            }
            if (overwriteCompiledPrompt) {
                // The persisted referenceBindings array may omit character-group rows;
                // H3 appends the selected group outfits after standalone references.
                // Compile that effective H3 view before rebasing the formal artifact tags.
                const hasManualReferences = merged.manualFields.includes("referenceBindings");
                let alignedPrompt: string | undefined;
                try {
                    const effective = compileReferenceSubmission(project, mergedSegment);
                    alignedPrompt = remapPromptPicturesByBinding(segment.prompt, compiledReferenceBindings, effective.references);
                } catch {
                    alignedPrompt = undefined;
                }
                if (alignedPrompt !== undefined) {
                    mergedSegment.prompt = alignedPrompt;
                } else if (hasManualReferences) {
                    // The saved references were manually changed beyond a pure reorder.
                    // Keep their paired prompt and reference/group inputs until the user
                    // adopts the compiled pair from the projection receipt.
                    mergedSegment.prompt = existing.prompt;
                    mergedSegment.referenceBindings = existing.referenceBindings;
                    mergedSegment.h3CharacterGroups = existing.h3CharacterGroups;
                    if (canonicalProduction(existing.prompt ?? null) !== canonicalProduction(segment.prompt ?? null)) {
                        if (!merged.conflicts.includes("prompt")) merged.conflicts.push("prompt");
                        if (!merged.manualFields.includes("prompt")) merged.manualFields.push("prompt");
                    }
                } else {
                    mergedSegment.prompt = segment.prompt;
                }
            }
            // Keep the archived result attached; only mark it old when its projected input changes.
            const inputChanged = clipInputHash(existing) !== clipInputHash(mergedSegment);
            const inputOutdated = existing.inputOutdated === true || Boolean(existing.resultStorageKey && inputChanged);
            const storyboardDurations = Array.isArray(mergedSegment.storyboardShots)
                ? mergedSegment.storyboardShots.map((shot: any) => Number(object(shot).duration)) : [];
            const storyboardTotal = storyboardDurations.reduce((sum: number, duration: number) => sum + duration, 0);
            const repairDuration = storyboardDurations.length > 0
                && storyboardDurations.every((duration: number) => Number.isFinite(duration) && duration > 0)
                && Number(mergedSegment.duration) !== storyboardTotal;
            if (repairDuration) mergedSegment.duration = storyboardTotal;
            const conflicts = (repairDuration ? merged.conflicts.filter(field => field !== "duration") : merged.conflicts)
                .filter(field => canonicalProduction(mergedSegment[field] ?? null) !== canonicalProduction(segment[field] ?? null));
            const manualFields = (repairDuration ? merged.manualFields.filter(field => field !== "duration") : merged.manualFields)
                .filter(field => canonicalProduction(mergedSegment[field] ?? null) !== canonicalProduction(segment[field] ?? null));
            const projectionGroups = groups.flatMap(fields => fields.includes("referenceBindings")
                ? [["referenceBindings", "prompt"], fields.filter(field => field !== "referenceBindings" && field !== "prompt")]
                : fields.includes("prompt") ? [] : [fields]).filter(fields => fields.length > 0);
            const projection = { ...segment.productionClipProjection,
                ...(repairDuration ? { fieldHashes: { ...segment.productionClipProjection.fieldHashes, duration: clipFieldHash(storyboardTotal) } } : {}),
                nextValues, fieldGroups: projectionGroups, conflicts, manualFields };
            segment = { ...mergedSegment, inputOutdated, productionClipProjection: projection };
            if (inputOutdated) group.inputOutdated = true;
            if (conflicts.length) result.diagnostics.push({ code: "MANUAL_INPUT_CONFLICT", message: `存在人工修改与正式源稿冲突，已保留画布输入：${conflicts.join(",")}` });
        }
        // A same-field manual edit stays on the canvas while independent compiler fields
        // still synchronize. The conflict is diagnostic; it does not freeze the whole Clip.
        result.status = "ready";
        result.referenceCount = segment.referenceBindings.length; result.inputHash = segment.productionClipProjection.inputHash;
        return { segment, result };
    } catch (error) { result.diagnostics.push({ code: "CLIP_INPUT_BLOCKED", message: error instanceof Error ? error.message : String(error) }); return { result }; }
}
function emptyProductionClip(project: Record<string, any>, data: EpisodeProductionData, group: EpisodeProductionData["clipGroups"][number], segmentId: string, defaults: Record<string, unknown>) {
    const director = data.director!;
    const sourceSegment = (Array.isArray(director.source.segments) ? director.source.segments : []).map(object).find(item => item.id === group.id) || {};
    const sourceShots = (Array.isArray(director.source.shots) ? director.source.shots : []).map(object);
    const shots = group.shotIds.map(id => sourceShots.find(shot => String(shot.id) === id)).filter(Boolean) as Array<Record<string, any>>;
    const fps = Number(director.source.fps_num || 24) / Number(director.source.fps_den || 1);
    const durationOf = (shot: Record<string, any>) => {
        const frames = Number(shot.duration_frames), start = Number(shot.start_frame), end = Number(shot.end_frame);
        if (Number.isFinite(frames) && frames > 0 && fps > 0) return frames / fps;
        if (Number.isFinite(start) && Number.isFinite(end) && end > start && fps > 0) return (end - start) / fps;
        return Number(data.shots.find(item => item.id === shot.id)?.duration || 0);
    };
    const storyboardShots = shots.map(shot => ({ id: String(shot.id), duration: durationOf(shot) }));
    const taskMode = ({ T2VA: "t2v", I2VA: "i2v", FL2VA: "fl2v", L2VA: "l2v", Ref2VA: "ref2va" } as Record<string, string>)[String(sourceSegment.mode)] || "ref2va";
    const node = (project.nodes || []).find((item: Record<string, any>) => item.id === group.nodeId);
    const segment: Record<string, any> = {
        id: segmentId, sourceShotId: group.shotIds.join("~"), title: shots.map(shot => String(shot.title || shot.id)).join(" / "),
        duration: storyboardShots.reduce((sum, shot) => sum + shot.duration, 0), taskMode, prompt: "", referenceBindings: [],
        storyboardModeEnabled: true, storyboardShots, tailFrameContinuation: false, motionContextEnabled: false,
        directorSourceHash: director.sourceHash, styleTemplateId: sourceSegment.styleTemplateId ?? null,
        h3CharacterGroups: {}, aspectRatio: object(node?.metadata).aspectRatio || BASE_H3_NODE_METADATA.aspectRatio,
        modelName: object(node?.metadata).modelName || defaults.modelName || BASE_H3_NODE_METADATA.modelName,
    };
    segment.productionClipProjection = { targetId: group.id, sourceHash: director.sourceHash,
        fieldHashes: Object.fromEntries(CLIP_PROJECTION_FIELDS.map(key => [key, clipFieldHash(segment[key])])) };
    segment.productionClipProjection.inputHash = clipInputHash(segment);
    return segment;
}

function layoutSceneForClip(data: EpisodeProductionData, group: EpisodeProductionData["clipGroups"][number]) {
    const ids = new Set(group.shotIds);
    const scenes = data.director ? productionSceneEntries(data.director.source) : [];
    return scenes.find(scene => scene.shotIds.some(id => ids.has(id)))?.id;
}

/**
 * Project formal Clips onto their scene H3 nodes. A full projection mirrors the
 * whole Clip list, so missing rows are restored; `materializeTargets` additionally
 * gates node creation and every addition inside a Shot-local projection.
 */
export function clipInputOperations(project: Record<string, any>, data: EpisodeProductionData, layout: ProductionLayoutPlan,
    defaults: Record<string, unknown> = {}, materializeTargets: ReadonlySet<string> = new Set(), onlyTargets?: ReadonlySet<string>, overwriteCompiledPromptTargets?: ReadonlySet<string>, forceBoundaryTargets?: ReadonlySet<string>) {
    const operations: CanvasOperation[] = [], referenceSync: ReferenceSync[] = [];
    const nodes = Array.isArray(project.nodes) ? project.nodes as Array<Record<string, any>> : [];
    const pendingNodes = new Map<string, CanvasOperation>();
    const retainedProjectedSegments = new Map<string, Set<string>>();
    const unitForGroup = (group: EpisodeProductionData["clipGroups"][number]) => layout.units.find(unit => unit.targets.includes(`segment:${group.id}`) && unit.members.some(member => member.role === "video"));
    const nodeForGroup = (group: EpisodeProductionData["clipGroups"][number]) => group.nodeId || unitForGroup(group)?.members.find(member => member.role === "video")?.nodeId;
    // A source repartition can reach compilation after the new Clip IDs were
    // saved but before their H3 projection was updated. Rebind same-node orphan
    // rows by Shot overlap before additions are planned, so a two-Clip boundary
    // adjustment updates the existing two rows instead of appending two more.
    const groupsByNode = new Map<string, EpisodeProductionData["clipGroups"]>();
    for (const group of data.clipGroups) {
        const nodeId = nodeForGroup(group);
        if (!nodeId) continue;
        const groups = groupsByNode.get(nodeId) || [];
        groups.push(group);
        groupsByNode.set(nodeId, groups);
    }
    for (const [nodeId, groups] of groupsByNode) {
        const node = nodes.find(item => String(item.id) === nodeId);
        const segments = Array.isArray(object(node?.metadata).segments) ? object(node?.metadata).segments as Array<Record<string, any>> : [];
        const activeTargetIds = new Set(groups.map(group => group.id));
        const candidates = groups.flatMap(group => {
            const bound = segments.some(segment => String(segment.id) === String(group.segmentId || "")
                || String(object(segment.productionClipProjection).targetId || "") === group.id);
            if (bound) return [];
            const shotSet = new Set(group.shotIds.map(String));
            return segments.flatMap(segment => {
                const projection = object(segment.productionClipProjection), targetId = String(projection.targetId || "");
                if (!targetId || activeTargetIds.has(targetId) || hasActiveH3SegmentTask(segment)) return [];
                const overlap = String(segment.sourceShotId || object(projection.nextValues).sourceShotId || "").split("~").filter(id => shotSet.has(id)).length;
                return overlap ? [{ group, segment, overlap }] : [];
            });
        }).sort((a, b) => b.overlap - a.overlap || String(a.segment.id).localeCompare(String(b.segment.id)) || a.group.id.localeCompare(b.group.id));
        const claimedGroups = new Set<string>(), claimedSegments = new Set<string>();
        for (const candidate of candidates) {
            const segmentId = String(candidate.segment.id || "");
            if (!segmentId || claimedGroups.has(candidate.group.id) || claimedSegments.has(segmentId)) continue;
            candidate.group.nodeId ||= nodeId;
            candidate.group.segmentId = segmentId;
            claimedGroups.add(candidate.group.id);
            claimedSegments.add(segmentId);
        }
    }
    for (const group of data.clipGroups) {
        if (onlyTargets && !onlyTargets.has(group.id)) continue;
        const unit = unitForGroup(group);
        const member = unit?.members.find(member => member.role === "video");
        const nodeId = group.nodeId || member?.nodeId;
        if (!nodeId) continue;
        const segmentId = group.segmentId || stableId("clip", layout.owner.id, group.id);
        const node = nodes.find(item => item.id === nodeId);
        const pendingNode = pendingNodes.get(nodeId);
        const nodeMetadata = pendingNode ? object(pendingNode.metadata) : object(node?.metadata);
        const existingSegments = Array.isArray(nodeMetadata.segments) ? nodeMetadata.segments as Array<Record<string, any>> : [];
        const existing = existingSegments.find(segment => segment.id === segmentId || segment.productionClipProjection?.targetId === group.id);
        const projected = productionClipProjection(project, data, group, segmentId, existing, overwriteCompiledPromptTargets?.has(group.id) === true);
        if (existing && forceBoundaryTargets?.has(group.id)) {
            const boundary = data.director?.boundaries.find(item => item.from === group.id);
            const boundaryPatch = {
                tailFrameContinuation: boundary?.tailFrame === true,
                motionContextEnabled: boundary?.motionContext === true,
                ...(existing.resultStorageKey ? { inputOutdated: true } : {}),
            };
            if (projected.segment) Object.assign(projected.segment, boundaryPatch);
            else if (existing.tailFrameContinuation !== boundaryPatch.tailFrameContinuation
                || existing.motionContextEnabled !== boundaryPatch.motionContextEnabled) {
                operations.push({ type: "update_h3_segment", nodeId, segmentId: existing.id, patch: boundaryPatch });
            }
        }
        referenceSync.push(projected.result);
        const retained = retainedProjectedSegments.get(nodeId) || new Set<string>();
        if (existing) retained.add(String(existing.id));
        retainedProjectedSegments.set(nodeId, retained);
        if (existing) {
            if (!projected.segment) {
                const storyboard = formalStoryboardTrack(data, group, existing);
                if (storyboard && (canonicalProduction(existing.storyboardShots || []) !== canonicalProduction(storyboard.storyboardShots)
                    || Number(existing.duration || 0) !== storyboard.duration || existing.storyboardModeEnabled !== true)) {
                    operations.push({ type: "update_h3_segment", nodeId, segmentId: existing.id, patch: storyboard });
                }
            }
            if (projected.segment && (clipInputHash(existing) !== clipInputHash(projected.segment) || canonicalProduction(existing.productionClipProjection) !== canonicalProduction(projected.segment.productionClipProjection))) {
                if (pendingNode) nodeMetadata.segments = existingSegments.map(segment => segment.id === existing.id ? projected.segment! : segment);
                else operations.push({ type: "update_h3_segment", nodeId, segmentId: existing.id, patch: projected.segment });
            }
            continue;
        }
        // A full projection mirrors the whole formal Clip list onto its scene H3
        // node, so a row lost to an earlier scoped projection or a canvas repair is
        // restored by the next compile instead of staying missing forever. A
        // Shot-local projection stays additive: it only materializes the groups its
        // own operation created, and only creates nodes for those.
        if (!materializeTargets.has(group.id) && (onlyTargets || !node)) continue;
        const segment = projected.segment || emptyProductionClip(project, data, group, segmentId, defaults);
        retained.add(String(segment.id));
        if (pendingNode) {
            nodeMetadata.segments = [...existingSegments, segment];
            pendingNode.metadata = nodeMetadata;
        } else if (node) {
            operations.push({ type: "add_h3_segment", nodeId, segment });
        } else {
            if (!member || !unit) continue;
            const sceneId = unit.sceneId || layoutSceneForClip(data, group);
            const scene = sceneId && data.director ? productionSceneEntries(data.director.source).find(item => item.id === sceneId) : undefined;
            const metadata = { ...createH3NodeMetadata(defaults, { segments: [segment] }), ...(sceneId ? { productionSceneId: sceneId, productionOwnerKind: layout.owner.kind, productionOwnerId: layout.owner.id } : {}), productionLayoutUnitId: unit.id, productionLayoutBounds: unit.bounds.size };
            const operation = { type: "add_node", id: nodeId, nodeType: member.nodeType, title: `${scene?.title || sceneId || "场次"} · H3`, position: member.position, width: member.size.width, height: member.size.height, metadata } as Extract<CanvasOperation, { type: "add_node" }>;
            pendingNodes.set(nodeId, operation);
            operations.push(operation);
        }
    }
    // A Shot/Clip-local edit still reconciles the whole timeline on each H3 node
    // it touched, so every current formal Clip on those nodes is retained.
    const touchedNodeIds = onlyTargets
        ? new Set(data.clipGroups.filter(group => onlyTargets.has(group.id)).map(nodeForGroup).filter((id): id is string => Boolean(id)))
        : null;
    if (touchedNodeIds) {
        for (const nodeId of touchedNodeIds) {
            const node = nodes.find(item => String(item.id) === nodeId);
            const segments = Array.isArray(object(node?.metadata).segments) ? object(node?.metadata).segments as Array<Record<string, any>> : [];
            const retained = retainedProjectedSegments.get(nodeId) || new Set<string>();
            for (const group of data.clipGroups) {
                if (nodeForGroup(group) !== nodeId) continue;
                const expectedId = group.segmentId || stableId("clip", layout.owner.id, group.id);
                if (segments.some(segment => String(segment.id || "") === expectedId)) retained.add(expectedId);
            }
            retainedProjectedSegments.set(nodeId, retained);
        }
    }
    // A production H3 node is a projection of its current formal Clip groups. Earlier
    // compiles could leave projected segments behind after Clips were merged/split or
    // moved to another node; they then appeared as extra timeline segments. Reconcile
    // only compiler-owned segments, leaving manual H3 segments and their authored work intact.
    const managedNodeIds = new Set([...retainedProjectedSegments.keys()]);
    const currentProductionShotIds = new Set(data.clipGroups.flatMap(group => group.shotIds.map(String)));
    for (const node of nodes) {
        const nodeId = String(node.id || "");
        const metadata = object(node.metadata);
        if (!nodeId || pendingNodes.has(nodeId) || metadata.productionOwnerId !== layout.owner.id) continue;
        // A scoped projection never reconciles nodes outside its targets. Sweeping
        // them here would leave their intact Clips with an empty retain set and
        // delete them as orphans on an unrelated Shot edit.
        if (touchedNodeIds && !touchedNodeIds.has(nodeId)) continue;
        managedNodeIds.add(nodeId);
    }
    for (const nodeId of managedNodeIds) {
        if (pendingNodes.has(nodeId)) continue;
        const node = nodes.find(item => String(item.id) === nodeId);
        if (!node) continue;
        const segments = Array.isArray(object(node.metadata).segments) ? object(node.metadata).segments as Array<Record<string, any>> : [];
        const retained = retainedProjectedSegments.get(nodeId) || new Set<string>();
        for (const segment of segments) {
            const projection = object(segment.productionClipProjection);
            if (!Object.keys(projection).length || retained.has(String(segment.id || ""))) continue;
            const manuallyChanged = hasManualProjectionEdits(segment);
            const supersededByCurrentProduction = String(segment.sourceShotId || object(projection.nextValues).sourceShotId || "")
                .split("~").some(shotId => currentProductionShotIds.has(shotId));
            // The segment is no longer part of the active production timeline.
            // Deleting its node entry leaves completed media/task history intact.
            // A completed manual row is still retired when its Shot range has
            // been repartitioned into current formal Clips; otherwise it would
            // remain as a duplicate active Clip after the new rows are applied.
            // Rows without a current replacement, plus active tasks, stay put.
            if (manuallyChanged && !supersededByCurrentProduction || hasActiveH3SegmentTask(segment)) continue;
            operations.push({ type: "delete_h3_segment", nodeId, segmentId: String(segment.id || "") });
        }
    }
    // H3 keeps insertion order when a formal Clip changes its stable segment ID.
    // Reconcile projected rows to the production group order after additions and
    // orphan cleanup, while leaving any manually created H3 rows untouched.
    for (const nodeId of managedNodeIds) {
        if (pendingNodes.has(nodeId)) continue;
        const node = nodes.find(item => String(item.id) === nodeId);
        if (!node) continue;
        const original = Array.isArray(object(node.metadata).segments) ? object(node.metadata).segments as Array<Record<string, any>> : [];
        const removed = new Set(operations.filter(operation => operation.type === "delete_h3_segment" && String(operation.nodeId) === nodeId)
            .map(operation => String(operation.segmentId || "")));
        const simulated = original.filter(segment => !removed.has(String(segment.id || "")));
        for (const operation of operations) if (operation.type === "add_h3_segment" && String(operation.nodeId) === nodeId) simulated.push(object(operation.segment));
        const groupOrder = new Map(data.clipGroups.filter(group => nodeForGroup(group) === nodeId).map((group, index) => [group.id, index]));
        if (simulated.some(segment => !groupOrder.has(String(object(segment.productionClipProjection).targetId || "")))) continue;
        const ordered = [...simulated].sort((left, right) => groupOrder.get(String(object(left.productionClipProjection).targetId))! - groupOrder.get(String(object(right.productionClipProjection).targetId))!);
        for (let index = 0; index < ordered.length; index++) {
            const wantedId = String(ordered[index].id || ""), currentId = String(simulated[index]?.id || "");
            if (!wantedId || wantedId === currentId) continue;
            operations.push({ type: "move_h3_segment", nodeId, segmentId: wantedId, beforeSegmentId: currentId });
            const from = simulated.findIndex(segment => String(segment.id || "") === wantedId);
            if (from >= 0) {
                const [moved] = simulated.splice(from, 1);
                const to = simulated.findIndex(segment => String(segment.id || "") === currentId);
                if (to >= 0) simulated.splice(to, 0, moved);
            }
        }
    }
    return { operations, referenceSync };
}
