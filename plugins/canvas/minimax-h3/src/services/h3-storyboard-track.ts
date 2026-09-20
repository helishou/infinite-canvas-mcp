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

function readPromptSection(prompt: string, section: string) {
    const header = new RegExp(`^${section}:[ \\t]*(?:\\r?\\n)?`, "mi").exec(prompt);
    if (!header) return "";
    const bodyStart = header.index + header[0].length;
    const remainder = prompt.slice(bodyStart);
    const next = PROMPT_SECTION_END.exec(remainder);
    return remainder.slice(0, next?.index ?? remainder.length).trim();
}

function replacePromptSection(prompt: string, section: string, content: string, mode: string) {
    const headerPattern = new RegExp(`^${section}:[ \\t]*(?:\\r?\\n)?`, "mi");
    const header = headerPattern.exec(prompt);
    if (!header) {
        if (!content.trim()) return prompt;
        const order = mode === "ref2va"
            ? ["subject_definitions", "summary", "retention_analysis", "detailed_description", "overall_soundscape", "non_diegetic_music"]
            : ["integrated_multimodal_description", "overall_soundscape", "non_diegetic_music"];
        const nextSection = order.slice(order.indexOf(section) + 1).find((name) => new RegExp(`^${name}:[ \\t]*`, "mi").test(prompt));
        const next = nextSection ? new RegExp(`^${nextSection}:[ \\t]*`, "mi").exec(prompt) : null;
        const text = `${section}:\n${content.trim()}`;
        return next ? `${prompt.slice(0, next.index).trimEnd()}\n\n${text}\n\n${prompt.slice(next.index)}` : `${prompt.trimEnd()}${prompt.trim() ? "\n\n" : ""}${text}`;
    }
    const bodyStart = header.index + header[0].length;
    const remainder = prompt.slice(bodyStart);
    const next = PROMPT_SECTION_END.exec(remainder);
    const suffix = prompt.slice(bodyStart + (next?.index ?? remainder.length)).replace(/^(?:\r?\n)+/, "");
    return `${prompt.slice(0, header.index)}${section}:\n${content.trimEnd()}${suffix ? `\n\n${suffix}` : ""}`;
}

type PromptShot = { body: string; bindingId?: string; managed: boolean };

function promptShotsOf(content: string, storyboardIds: Set<string>, imageRefs: H3Ref[]): { opening: string; shots: PromptShot[] } {
    const markers = [...content.matchAll(/\[Shot\s+\d+\]/giu)];
    if (!markers.length) return { opening: content.trim(), shots: [] };
    const shots = markers.map((marker, index) => {
        const start = marker.index! + marker[0].length;
        const body = content.slice(start, markers[index + 1]?.index ?? content.length).trim();
        const refs = [...body.matchAll(/\{\{ref:([^{}]+)\}\}/gu)].map((match) => match[1]);
        const semanticRef = body.match(/Use the approved .+? from \{\{ref:([^{}]+)\}\} as (?:the visual anchor|the target composition reference) for this shot\./iu)?.[1];
        const pictureNumber = body.match(/<Picture\s+(\d+)>/iu)?.[1];
        const legacyBinding = pictureNumber ? imageRefs[Number(pictureNumber) - 1]?.bindingId : undefined;
        const bindingId = refs.find((id) => storyboardIds.has(id)) || semanticRef || (legacyBinding && storyboardIds.has(legacyBinding) ? legacyBinding : undefined);
        return { body, bindingId, managed: Boolean(bindingId || semanticRef) };
    });
    return { opening: content.slice(0, markers[0].index).trim(), shots };
}

function stripShotTime(body: string) {
    return body
        .replace(/^At\s+\d{1,2}:\d{2}(?:\.\d{1,3})?\s*,?\s*/iu, "")
        .replace(/^\d{1,2}:\d{2}(?:\.\d{1,3})?\s*[:：]\s*/u, "")
        .trim();
}

function canonicalStoryboardCue(bindingId: string) {
    return `Use the approved storyboard frame from {{ref:${bindingId}}} as the target composition reference for this shot.`;
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
    const cue = text.match(/Use the approved .+? from \{\{ref:[^{}]+\}\} as (?:the visual anchor|the target composition reference) for this shot\./iu)?.[0] || "";
    if (cue) text = text.replace(cue, " ").replace(/\s+/gu, " ").trim();
    const generated = text.match(/The shot transitions to the approved .+? from \{\{ref:[^{}]+\}\} using a (hard cut|cross-dissolve|fade|wipe|match cut)\./iu);
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
            [/^the shot hard-cuts[.,]?\s*/iu, "cut"],
            [/^the shot cross-dissolves[.,]?\s*/iu, "dissolve"],
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
        const residualCue = text.match(/^Use the approved .+? from \{\{ref:[^{}]+\}\} as (?:the visual anchor|the target composition reference) for this shot\.\s*/iu);
        if (residualCue) {
            text = text.slice(residualCue[0].length).replace(/\s+/gu, " ").trim();
            continue;
        }
        const residualLead = text.match(/^the shot (?:hard-cuts|cross-dissolves|continues|fades out to black, then fades in)[.,]?\s*/iu);
        if (residualLead) {
            text = text.slice(residualLead[0].length).replace(/\s+/gu, " ").trim();
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

    const activeIds = new Set(activeItems.flatMap((item) => item.ref.bindingId ? [item.ref.bindingId] : []));
    const oldShots = new Map<string, PromptShot>();
    const assigned = new Set<PromptShot>();
    for (const shot of parsed.shots) {
        if (shot.bindingId && activeIds.has(shot.bindingId) && !oldShots.has(shot.bindingId)) {
            oldShots.set(shot.bindingId, shot);
            assigned.add(shot);
        }
    }
    // 老提示词常有逐镜描述，但没有绑定稳定引用 ID；首次开启分镜轨时按顺序补齐图片绑定。
    const unboundShots = parsed.shots.filter((shot) => !assigned.has(shot) && !shot.managed && !shot.bindingId);
    let unboundIndex = 0;
    for (const item of activeItems) {
        const bindingId = item.ref.bindingId;
        if (!bindingId || oldShots.has(bindingId)) continue;
        const shot = unboundShots[unboundIndex++];
        if (!shot) break;
        oldShots.set(bindingId, shot);
        assigned.add(shot);
    }

    const tracked = activeItems.flatMap((item, index) => {
        const bindingId = item.ref.bindingId;
        if (!bindingId) return [];
        const existing = oldShots.get(bindingId);
        let body = existing ? stripShotTime(existing.body) : "";
        if (existing) {
            const pictureIndex = refs.filter((ref) => ref.type === "image").findIndex((ref) => ref.bindingId === bindingId);
            if (pictureIndex >= 0) body = body.replace(new RegExp(`<Picture\\s+${pictureIndex + 1}>`, "iu"), `{{ref:${bindingId}}}`);
        }
        const cuePattern = new RegExp(`Use the approved .+? from \\{\\{ref:${escapeRegExp(bindingId)}\\}\\} as (?:the visual anchor|the target composition reference) for this shot\\.`, "iu");
        if (!cuePattern.test(body)) body = [canonicalStoryboardCue(bindingId), body].filter(Boolean).join(" ");
        body = normalizeTransition(body, index > 0);
        return [formatShot(index, item.start, body)];
    });

    const remaining = parsed.shots.filter((shot) => !assigned.has(shot)).flatMap((shot, index) => {
        if (!shot.managed) return [shot.body];
        const semanticRef = shot.body.match(/Use the approved .+? from \{\{ref:([^{}]+)\}\} as (?:the visual anchor|the target composition reference) for this shot\./iu)?.[1];
        const bindingId = semanticRef || shot.bindingId;
        const stillExists = bindingId && refs.some((ref) => ref.bindingId === bindingId);
        if (bindingId && storyboardIds.has(bindingId)) {
            let body = stripShotTime(shot.body);
            const pictureIndex = refs.filter((ref) => ref.type === "image").findIndex((ref) => ref.bindingId === bindingId);
            if (pictureIndex >= 0) body = body.replace(new RegExp(`<Picture\\s+${pictureIndex + 1}>`, "iu"), `{{ref:${bindingId}}}`);
            const cuePattern = new RegExp(`Use the approved .+? from \\{\\{ref:${escapeRegExp(bindingId)}\\}\\} as (?:the visual anchor|the target composition reference) for this shot\\.`, "iu");
            if (!cuePattern.test(body)) body = [canonicalStoryboardCue(bindingId), body].filter(Boolean).join(" ");
            return [normalizeTransition(body, index > 0)];
        }
        let body = stripShotTime(shot.body);
        if (semanticRef) {
            const escaped = escapeRegExp(semanticRef);
            const ordinaryReference = stillExists ? `Use {{ref:${semanticRef}}} as a visual reference for this shot.` : "";
            body = body.replace(new RegExp(`Use the approved .+? from \\{\\{ref:${escaped}\\}\\} as (?:the visual anchor|the target composition reference) for this shot\\.`, "iu"), ordinaryReference);
            if (!stillExists) body = body.replace(new RegExp(`\\{\\{ref:${escaped}\\}\\}`, "gu"), "");
        }
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
        const enabled = supportsStoryboardTrack(segment) && isStoryboardModeEnabled(segment) && storyboardRefsForSegment(segment).length > 0;
        const mode = String(segment.mode || segment.taskMode || "ref2va");
        const section = mode === "ref2va" ? "detailed_description" : "integrated_multimodal_description";
        const sectionText = readPromptSection(prompt, section);
        const activeItems = enabled ? storyboardTrackItems(segment) : [];
        const syncedSection = syncPromptShots(sectionText, segment, activeItems);
        const next = replacePromptSection(prompt, section, syncedSection, mode);
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
