import type { CanvasNodeContext } from "@infinite-canvas/plugin-sdk";
import type { H3Ref, H3Segment } from "../types";
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
    return segment.storyboardModeEnabled ?? storyboardRefsForSegment(segment).length > 0;
}

export function storyboardTrackItems(segment: H3Segment) {
    const refs = storyboardRefsForSegment(segment);
    const clipDuration = Math.max(0.5, Number(segment.duration || 1));
    const raw = refs.map((ref) => {
        const value = Number(segment.storyboardDurations?.[ref.bindingId || ""] || 0);
        return Number.isFinite(value) ? Math.max(0, value) : 0;
    });
    const storedSum = raw.reduce((sum, duration) => sum + duration, 0);
    const base = raw.map((duration) => duration > 0 ? duration : refs.length ? Math.max(0, clipDuration - storedSum) / refs.filter((_, index) => raw[index] <= 0).length : 0);
    const baseSum = base.reduce((sum, duration) => sum + duration, 0);
    const ratio = baseSum > 0 ? clipDuration / baseSum : 0;
    let start = 0;
    return refs.map((ref, index) => {
        const duration = base[index] * ratio;
        const item = { ref, start, end: start + duration, duration };
        start += duration;
        return item;
    });
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
    const storyboardDurations = Object.fromEntries(items.map((item) => [item.ref.bindingId!, item.duration]));
    return {
        ...segment,
        storyboardDurations: {
            ...storyboardDurations,
            [left.ref.bindingId!]: nextLeft,
            [right.ref.bindingId!]: left.duration + right.duration - nextLeft,
        },
    };
}

export function reorderStoryboardRefs(segment: H3Segment, sourceBindingId: string, targetBindingId: string) {
    const refs = refsForSegment(segment);
    const storyboard = storyboardRefsForSegment(segment);
    const from = storyboard.findIndex((ref) => ref.bindingId === sourceBindingId);
    const to = storyboard.findIndex((ref) => ref.bindingId === targetBindingId);
    if (from < 0 || to < 0 || from === to) return segment;
    const reordered = [...storyboard];
    const [moved] = reordered.splice(from, 1);
    reordered.splice(to, 0, moved);
    let cursor = 0;
    const nextRefs = refs.map((ref) => ref.type === "image" && inferReferenceRole(ref) === "storyboard" ? reordered[cursor++] : ref);
    return withSegmentRefs(segment, nextRefs);
}

export function replaceStoryboardPromptSection(prompt: string, content: string) {
    const headerPattern = /^storyboard_timeline:[ \t]*(?:\r?\n)?/mi;
    const header = headerPattern.exec(prompt);
    const sectionEndPattern = /^(?:subject_definitions|summary|retention_analysis|detailed_description|overall_soundscape|non_diegetic_music|integrated_multimodal_description|storyboard_timeline):/mi;
    if (!header) return content.trim() ? `${prompt.trimEnd()}${prompt.trim() ? "\n\n" : ""}storyboard_timeline:\n${content.trim()}` : prompt;

    const bodyStart = header.index + header[0].length;
    const remainder = prompt.slice(bodyStart);
    const next = sectionEndPattern.exec(remainder);
    const bodyEnd = bodyStart + (next?.index ?? remainder.length);
    const before = prompt.slice(0, header.index).replace(/(?:\r?\n){2,}$/, "\n\n");
    const after = prompt.slice(bodyEnd).replace(/^(?:\r?\n)+/, "");
    if (!content.trim()) return `${before}${after ? `${before && !before.endsWith("\n\n") ? "\n" : ""}${after}` : ""}`.replace(/^\n+/, "").trimEnd();
    return `${before}storyboard_timeline:\n${content.trim()}${after ? `\n\n${after}` : ""}`;
}

export function storyboardPromptBlock(segment: H3Segment) {
    const refs = refsForSegment(segment);
    const items = storyboardTrackItems(segment);
    const pictureNumbers = new Map<string, number>();
    refs.filter((ref) => ref.type === "image").forEach((ref, index) => { if (ref.bindingId) pictureNumbers.set(ref.bindingId, index + 1); });
    return items.map(({ ref, start, end }) => {
        const bindingId = ref.bindingId;
        if (!bindingId) return "";
        const pictureNumber = pictureNumbers.get(bindingId) || 1;
        const name = ref.name ? ` · ${ref.name.replace(/[\r\n]+/g, " ")}` : "";
        return `${formatStoryboardTime(start)}–${formatStoryboardTime(end)} {{ref:${bindingId}}} <Picture ${pictureNumber}>${name}`;
    }).filter(Boolean).join("\n");
}

export async function syncStoryboardPrompt(ctx: CanvasNodeContext, segment: H3Segment) {
    if (!segment.id) return false;
    const target = { nodeId: ctx.node.id, segmentId: segment.id, field: "prompt" as const };
    const document = ctx.textDocument(target);
    try {
        await document.flush();
        const snapshot = document.getSnapshot();
        if (!snapshot.ready || snapshot.blocked) return false;
        const enabled = supportsStoryboardTrack(segment) && isStoryboardModeEnabled(segment) && storyboardRefsForSegment(segment).length > 0;
        const next = replaceStoryboardPromptSection(snapshot.text, enabled ? storyboardPromptBlock(segment) : "");
        if (next === snapshot.text) return true;
        return await ctx.replaceText(target, document.getDocumentId(), snapshot.text, next);
    } catch (error) {
        console.warn("H3 分镜时间轨提示词同步失败", error);
        return false;
    }
}

function formatStoryboardTime(value: number) {
    const seconds = Math.max(0, value);
    const minutes = Math.floor(seconds / 60);
    return `${String(minutes).padStart(2, "0")}:${(seconds % 60).toFixed(2).padStart(5, "0")}`;
}

export type { H3Ref };
