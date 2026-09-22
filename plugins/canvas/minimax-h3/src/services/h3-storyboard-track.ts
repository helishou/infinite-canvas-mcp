import type { CanvasNodeContext } from "@infinite-canvas/plugin-sdk";
import type { H3Ref, H3Segment, H3StoryboardShot } from "../types";
import { readH3PromptSection, replaceH3PromptSection } from "../../../../../canvas-agent/src/plugins/minimax-h3/prompt-sections";
import type { H3PromptSection } from "../../../../../canvas-agent/src/plugins/minimax-h3/prompt-sections";
import { stripDuplicateTransition } from "../../../../../canvas-agent/src/plugins/minimax-h3/prompt-rules";
import { sameRef } from "./h3-compatibility";
import { inferReferenceRole, refsForSegment, withSegmentRefs } from "./h3-data";

export const H3_STORYBOARD_MIN_DURATION = 0.5;

export function supportsStoryboardTrack(segment: H3Segment) {
    const mode = String(segment.mode || segment.taskMode || "ref2va");
    return mode !== "t2v" && mode !== "i2v" && mode !== "fl2v";
}

export function storyboardRefsForSegment(segment: H3Segment) {
    return refsForSegment(segment).filter((ref) => ref.type === "image" && inferReferenceRole(ref) === "storyboard");
}

export function isStoryboardModeEnabled(segment: H3Segment) {
    return segment.storyboardModeEnabled ?? (segment.storyboardShots !== undefined || storyboardRefsForSegment(segment).length > 0);
}

export function storyboardTrackItems(segment: H3Segment) {
    const refs = storyboardRefsForSegment(segment);
    const refsByBindingId = new Map(refs.flatMap((ref) => ref.bindingId ? [[ref.bindingId, ref] as const] : []));
    const shots: H3StoryboardShot[] = segment.storyboardShots ?? refs.map((ref, index) => ({
        id: ref.bindingId || `legacy-storyboard-${index}`,
        referenceBindingId: ref.bindingId,
        duration: segment.storyboardDurations?.[ref.bindingId || ""],
    }));
    const attachedRefs = new Set(shots.flatMap((shot) => shot.referenceBindingId ? [shot.referenceBindingId] : []));
    const allShots = [...shots, ...refs.filter((ref) => ref.bindingId && !attachedRefs.has(ref.bindingId)).map((ref) => ({
        id: ref.bindingId!, referenceBindingId: ref.bindingId, duration: segment.storyboardDurations?.[ref.bindingId!],
    }))];
    const clipDuration = Math.max(0.5, Number(segment.duration || 1));
    const raw = allShots.map((shot) => {
        const value = Number(shot.duration || segment.storyboardDurations?.[shot.referenceBindingId || shot.id] || 0);
        return Number.isFinite(value) ? Math.max(0, value) : 0;
    });
    const storedSum = raw.reduce((sum, duration) => sum + duration, 0);
    const base = raw.map((duration) => duration > 0 ? duration : allShots.length ? Math.max(0, clipDuration - storedSum) / allShots.filter((_, index) => raw[index] <= 0).length : 0);
    const baseSum = base.reduce((sum, duration) => sum + duration, 0);
    const ratio = baseSum > 0 && Math.abs(baseSum - clipDuration) > 1e-6 ? clipDuration / baseSum : 1;
    let start = 0;
    return allShots.map((shot, index) => {
        const duration = base[index] * ratio;
        const item = { ...shot, ref: shot.referenceBindingId ? refsByBindingId.get(shot.referenceBindingId) : undefined, start, end: start + duration, duration };
        start += duration;
        return item;
    });
}

function shotsFromItems(items: ReturnType<typeof storyboardTrackItems>): H3StoryboardShot[] {
    return items.map(({ id, ref, duration }) => ({ id, duration, ...(ref?.bindingId ? { referenceBindingId: ref.bindingId } : {}) }));
}

export function addStoryboardShot(segment: H3Segment) {
    const items = storyboardTrackItems(segment);
    const donor = items.at(-1);
    if (donor && donor.duration < H3_STORYBOARD_MIN_DURATION * 2) return segment;
    const duration = donor ? donor.duration / 2 : Math.max(0.5, Number(segment.duration || 1));
    const shots = shotsFromItems(items);
    if (donor) shots[shots.length - 1] = { ...shots[shots.length - 1], duration };
    shots.push({ id: `storyboard-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`, duration });
    return { ...segment, storyboardModeEnabled: true, storyboardShots: shots };
}

export function removeStoryboardShot(segment: H3Segment, shotId: string) {
    const items = storyboardTrackItems(segment);
    const target = items.find((item) => item.id === shotId);
    if (!target) return segment;
    const targetIndex = items.findIndex((item) => item.id === shotId);
    const remaining = items.filter((item) => item.id !== shotId);
    const recipientId = items[targetIndex + 1]?.id || items[targetIndex - 1]?.id;
    const merged = remaining.map((item) => item.id === recipientId ? { ...item, duration: item.duration + target.duration } : item);
    const refs = target.ref?.bindingId
        ? refsForSegment(segment).map((ref) => ref.bindingId === target.ref?.bindingId ? { ...ref, role: "other" as const } : ref)
        : refsForSegment(segment);
    const updated = withSegmentRefs(segment, refs);
    return { ...updated, storyboardModeEnabled: true, storyboardShots: shotsFromItems(merged) };
}

export function removeStoryboardImageReference(segment: H3Segment, reference: H3Ref) {
    if (reference.type !== "image" || inferReferenceRole(reference) !== "storyboard") return segment;
    const refs = refsForSegment(segment);
    const target = refs.find((ref) => reference.bindingId ? ref.bindingId === reference.bindingId : sameRef(ref, reference));
    if (!target) return segment;
    const items = storyboardTrackItems(segment);
    if (!items.some((item) => item.ref && sameRef(item.ref, target))) return segment;
    const storyboardShots = items.map(({ id, ref, duration }) => ({
        id,
        duration,
        ...(ref?.bindingId && !sameRef(ref, target) ? { referenceBindingId: ref.bindingId } : {}),
    }));
    const updated = withSegmentRefs(segment, refs.filter((ref) => !sameRef(ref, target)));
    return { ...updated, storyboardModeEnabled: true, storyboardShots };
}

export function setStoryboardMode(segment: H3Segment, enabled: boolean) {
    const withRefs = withSegmentRefs(segment, refsForSegment(segment));
    return { ...withRefs, storyboardModeEnabled: enabled };
}

export function setStoryboardBoundary(segment: H3Segment, index: number, leftDuration: number) {
    const items = storyboardTrackItems(segment);
    const left = items[index];
    const right = items[index + 1];
    if (!left || !right || left.duration + right.duration < H3_STORYBOARD_MIN_DURATION * 2) return segment;
    const nextLeft = Math.max(H3_STORYBOARD_MIN_DURATION, Math.min(left.duration + right.duration - H3_STORYBOARD_MIN_DURATION, leftDuration));
    const storyboardShots = shotsFromItems(items);
    storyboardShots[index] = { ...storyboardShots[index], duration: nextLeft };
    storyboardShots[index + 1] = { ...storyboardShots[index + 1], duration: left.duration + right.duration - nextLeft };
    return {
        ...segment,
        storyboardShots,
    };
}

export function reorderStoryboardShots(segment: H3Segment, sourceId: string, targetId: string) {
    const storyboard = storyboardTrackItems(segment);
    const from = storyboard.findIndex((item) => item.id === sourceId);
    const to = storyboard.findIndex((item) => item.id === targetId);
    if (from < 0 || to < 0 || from === to) return segment;
    const reordered = [...storyboard];
    [reordered[from], reordered[to]] = [reordered[to], reordered[from]];
    return { ...segment, storyboardShots: shotsFromItems(reordered) };
}

export function swapStoryboardReferences(segment: H3Segment, sourceBindingId: string, targetBindingId: string) {
    const storyboard = storyboardTrackItems(segment);
    const from = storyboard.findIndex((item) => item.ref?.bindingId === sourceBindingId);
    const to = storyboard.findIndex((item) => item.ref?.bindingId === targetBindingId);
    if (from < 0 || to < 0 || from === to) return segment;
    const swapped = [...storyboard];
    [swapped[from], swapped[to]] = [swapped[to], swapped[from]];
    return { ...segment, storyboardShots: shotsFromItems(swapped) };
}

const PROMPT_SECTION_END = /^(?:subject_definitions|summary|retention_analysis|detailed_description|overall_soundscape|non_diegetic_music|integrated_multimodal_description|storyboard_timeline):/mi;

function removeLegacyTimelineSection(prompt: string) {
    const header = /^storyboard_timeline:[ \t]*(?:\r?\n)?/mi.exec(prompt);
    if (!header) return prompt;
    const bodyStart = header.index + header[0].length;
    const remainder = prompt.slice(bodyStart);
    const next = PROMPT_SECTION_END.exec(remainder);
    const after = prompt.slice(bodyStart + (next?.index ?? remainder.length)).replace(/^(?:\r?\n)+/, "");
    const before = prompt.slice(0, header.index).replace(/(?:\r?\n){2,}$/, "\n\n").trimEnd();
    return `${before}${before && after ? "\n\n" : ""}${after}`;
}

type PromptShot = { body: string; bindingId?: string; managed: boolean; preciseCut: boolean };

function normalizeLegacyPictureTokens(content: string, imageRefs: H3Ref[]) {
    return content.replace(/\{\{\s*ref:\s*([^{}]+?)\s*\}\}/gu, (marker, rawId: string) => {
        const id = rawId.trim();
        const ordinal = imageRefs.findIndex((ref) => ref.bindingId === id) + 1;
        return ordinal > 0 ? `<Picture ${ordinal}>` : marker;
    });
}

function promptShotsOf(content: string, storyboardIds: Set<string>, imageRefs: H3Ref[]): { opening: string; shots: PromptShot[] } {
    const markers = [...content.matchAll(/\[Shot\s+\d+\]/giu)];
    if (!markers.length) return { opening: content.trim(), shots: [] };
    const shots = markers.map((marker, index) => {
        const start = marker.index! + marker[0].length;
        const body = content.slice(start, markers[index + 1]?.index ?? content.length).trim();
        const pictureNumber = body.match(/<Picture\s+(\d+)>/iu)?.[1];
        const bindingId = pictureNumber ? imageRefs[Number(pictureNumber) - 1]?.bindingId : undefined;
        const managedBindingId = bindingId && storyboardIds.has(bindingId) ? bindingId : undefined;
        return { body, bindingId: managedBindingId, managed: Boolean(managedBindingId), preciseCut: index > 0 && /^At\s+\d{1,2}:\d{2}(?:\.\d{1,3})?\s*,?/iu.test(body) };
    });
    return { opening: content.slice(0, markers[0].index).trim(), shots };
}

function stripShotTime(body: string) {
    return body
        .replace(/^At\s+\d{1,2}:\d{2}(?:\.\d{1,3})?\s*,?\s*/iu, "")
        .replace(/^\d{1,2}:\d{2}(?:\.\d{1,3})?\s*[:：]\s*/u, "")
        .trim();
}

function canonicalStoryboardCue(bindingId: string, imageRefs: H3Ref[]) {
    const pictureNumber = imageRefs.findIndex((ref) => ref.bindingId === bindingId) + 1;
    return `Use the approved storyboard frame from <Picture ${pictureNumber}> as the target composition reference for this shot.`;
}

function formatShot(index: number, start: number | undefined, body: string) {
    const time = index > 0 && start !== undefined ? ` At ${formatStoryboardTime(start)},` : "";
    return `[Shot ${index + 1}]${time}${body ? ` ${body.trim()}` : ""}`;
}

const SHOT_TRANSITION_LEADIN = {
    continuous: "the shot continues",
    cut: "the shot hard-cuts",
    dissolve: "the shot cross-dissolves",
    fade_black: "the shot fades out to black, then fades in",
} as const;

function transitionTypeOf(value: string): keyof typeof SHOT_TRANSITION_LEADIN {
    if (/continuous|continues|uninterrupted|no cut/iu.test(value)) return "continuous";
    if (/cross[- ]dissolve|dissolve/iu.test(value)) return "dissolve";
    if (/fade/iu.test(value)) return "fade_black";
    return "cut";
}

function normalizeTransition(body: string, hasPrecedingShot: boolean) {
    let text = body.trim();
    let transitionType: keyof typeof SHOT_TRANSITION_LEADIN | undefined;
    const cue = text.match(/Use the approved .+? from <Picture\s+\d+> as (?:the visual anchor|the target composition reference) for this shot\./iu)?.[0] || "";
    if (cue) text = text.replace(cue, " ").replace(/\s+/gu, " ").trim();
    const generated = text.match(/The shot transitions to the approved .+? from <Picture\s+\d+> using a (hard cut|cross-dissolve|fade|wipe|match cut)\./iu);
    if (generated) {
        transitionType = transitionTypeOf(generated[1]);
        text = text.replace(generated[0], " ").replace(/\s+/gu, " ").trim();
    }
    const bracket = text.match(/^\[Transition:\s*([^\]]+)\]\s*/iu);
    if (bracket) {
        transitionType = transitionTypeOf(bracket[1]);
        text = text.slice(bracket[0].length);
    } else {
        const natural = [
            [/^the shot hard-cuts(?:\s+to\s+|[.,]\s*)/iu, "cut"],
            [/^the shot cross-dissolves(?:\s+to\s+|[.,]\s*)/iu, "dissolve"],
            [/^the shot fades out to black, then fades in[.,]?\s*/iu, "fade_black"],
            [/^the shot continues[.,]?\s*/iu, "continuous"],
        ] as const;
        const match = natural.find(([pattern]) => pattern.test(text));
        if (match) {
            transitionType = match[1];
            text = text.replace(match[0], "");
        } else {
            const legacy = [
                [/^(?:the camera|the shot) cuts to\s*/iu, "cut"],
                [/^the shot (?:transitions|changes|switches) to\s*/iu, "cut"],
                [/^(?:the (?:shot|image) )?cross[- ]dissolves? to\s*/iu, "dissolve"],
                [/^(?:the (?:shot|image) )?fades? (?:to|into)\s*/iu, "fade_black"],
            ] as const;
            const old = legacy.find(([pattern]) => pattern.test(text));
            if (old) {
                transitionType ||= old[1];
                text = text.replace(old[0], "");
            }
        }
    }
    // 自愈：旧版解析曾把 lead/cue 成对泄进正文，这里循环剥掉残余副本，避免每次同步继续叠加。
    for (;;) {
        const residualCue = text.match(/^Use the approved .+? from <Picture\s+\d+> as (?:the visual anchor|the target composition reference) for this shot\.\s*/iu);
        if (residualCue) {
            text = text.slice(residualCue[0].length).replace(/\s+/gu, " ").trim();
            continue;
        }
        const withoutTransition = stripDuplicateTransition(text, transitionType || "cut");
        if (withoutTransition !== text) {
            text = withoutTransition;
            continue;
        }
        break;
    }
    return [
        hasPrecedingShot ? `${SHOT_TRANSITION_LEADIN[transitionType || "cut"]}.` : "",
        cue,
        text.trim(),
    ].filter(Boolean).join(" ");
}

function syncPromptShots(content: string, segment: H3Segment, activeItems: ReturnType<typeof storyboardTrackItems>) {
    const refs = refsForSegment(segment);
    const storyboardRefs = storyboardRefsForSegment(segment);
    const storyboardIds = new Set(storyboardRefs.flatMap((ref) => ref.bindingId ? [ref.bindingId] : []));
    const parsed = promptShotsOf(content, storyboardIds, refs.filter((ref) => ref.type === "image"));
    if (!activeItems.length && !parsed.shots.some((shot) => shot.managed)) return content;

    const activeIds = new Set(activeItems.map((item) => item.id));
    const bindingToShotId = new Map(activeItems.flatMap((item) => item.ref?.bindingId ? [[item.ref.bindingId, item.id] as const] : []));
    const oldShots = new Map<string, PromptShot>();
    const assigned = new Set<PromptShot>();
    for (const shot of parsed.shots) {
        const shotId = shot.bindingId ? bindingToShotId.get(shot.bindingId) : undefined;
        if (shotId && activeIds.has(shotId) && !oldShots.has(shotId)) {
            oldShots.set(shotId, shot);
            assigned.add(shot);
        }
    }
    // 老提示词常有逐镜描述但没有图片绑定；按顺序关联到当前分镜项目。
    const unboundShots = parsed.shots.filter((shot) => !assigned.has(shot) && !shot.managed && !shot.bindingId);
    let unboundIndex = 0;
    for (const item of activeItems) {
        if (oldShots.has(item.id)) continue;
        const shot = unboundShots[unboundIndex++];
        if (!shot) break;
        oldShots.set(item.id, shot);
        assigned.add(shot);
    }

    const tracked = activeItems.flatMap((item, index) => {
        const existing = oldShots.get(item.id);
        let body = existing ? stripShotTime(existing.body) : "";
        if (item.ref?.bindingId) {
            const pictureIndex = refs.filter((ref) => ref.type === "image").findIndex((ref) => ref.bindingId === item.ref?.bindingId);
            const pictureTag = `<Picture ${pictureIndex + 1}>`;
            const cuePattern = new RegExp(`Use the approved .+? from ${escapeRegExp(pictureTag)} as (?:the visual anchor|the target composition reference) for this shot\\.`, "iu");
            if (!cuePattern.test(body)) body = [canonicalStoryboardCue(item.ref.bindingId, refs.filter((ref) => ref.type === "image")), body].filter(Boolean).join(" ");
        }
        body = normalizeTransition(body, index > 0);
        return [formatShot(index, existing?.preciseCut ? item.start : undefined, body)];
    });

    const remaining = parsed.shots.filter((shot) => !assigned.has(shot)).flatMap((shot, index) => {
        if (!shot.managed) return [shot.body];
        const bindingId = shot.bindingId;
        if (bindingId && storyboardIds.has(bindingId)) {
            let body = stripShotTime(shot.body);
            const pictureIndex = refs.filter((ref) => ref.type === "image").findIndex((ref) => ref.bindingId === bindingId);
            const pictureTag = `<Picture ${pictureIndex + 1}>`;
            const cuePattern = new RegExp(`Use the approved .+? from ${escapeRegExp(pictureTag)} as (?:the visual anchor|the target composition reference) for this shot\\.`, "iu");
            if (!cuePattern.test(body)) body = [canonicalStoryboardCue(bindingId, refs.filter((ref) => ref.type === "image")), body].filter(Boolean).join(" ");
            return [normalizeTransition(body, index > 0)];
        }
        let body = stripShotTime(shot.body);
        body = normalizeTransition(body.replace(/\s+/gu, " ").trim(), index > 0);
        return body ? [body] : [];
    });

    const shotBodies = [...tracked, ...remaining.map((body, index) => formatShot(tracked.length + index, undefined, body))];
    return [parsed.opening, shotBodies.join("\n")].filter(Boolean).join("\n\n");
}

function escapeRegExp(value: string) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function syncStoryboardPrompt(ctx: CanvasNodeContext, segment: H3Segment) {
    if (!segment.id) return false;
    const target = { nodeId: ctx.node.id, segmentId: segment.id, field: "prompt" as const };
    const document = ctx.textDocument(target);
    try {
        await document.flush();
        const snapshot = document.getSnapshot();
        if (!snapshot.ready || snapshot.blocked) return false;
        const prompt = removeLegacyTimelineSection(snapshot.text);
        const enabled = supportsStoryboardTrack(segment) && isStoryboardModeEnabled(segment) && storyboardTrackItems(segment).length > 0;
        const mode = String(segment.mode || segment.taskMode || "ref2va");
        const section = (mode === "ref2va" ? "detailed_description" : "integrated_multimodal_description") as H3PromptSection;
        const sectionText = readH3PromptSection(prompt, section);
        const refs = refsForSegment(segment);
        const imageRefs = refs.filter((ref) => ref.type === "image");
        const normalizedSection = normalizeLegacyPictureTokens(sectionText, imageRefs);
        const activeItems = enabled ? storyboardTrackItems(segment) : [];
        const syncedSection = syncPromptShots(normalizedSection, segment, activeItems);
        const next = replaceH3PromptSection(prompt, section, syncedSection, mode);
        if (next === snapshot.text) return true;
        return await ctx.replaceText(target, document.getDocumentId(), snapshot.text, next);
    } catch (error) {
        console.warn("H3 分镜时间轨提示词同步失败", error);
        return false;
    }
}

function formatStoryboardTime(value: number) {
    const totalMilliseconds = Math.round(Math.max(0, value) * 1000);
    const minutes = Math.floor(totalMilliseconds / 60000);
    const seconds = Math.floor((totalMilliseconds % 60000) / 1000);
    const milliseconds = totalMilliseconds % 1000;
    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(milliseconds).padStart(3, "0")}`;
}

export type { H3Ref };
