import { useMemo } from "@infinite-canvas/plugin-sdk";
import type { CanvasNodeContext } from "@infinite-canvas/plugin-sdk";
import type { H3Segment } from "../types";
import { defaultH3Model, defaultPrompt } from "../constants";
function resultUrl(value: unknown) { return typeof value === "string" ? value : value && typeof value === "object" ? String((value as Record<string, unknown>).url || (value as Record<string, unknown>).content || "") : ""; }
function canonicalTaskMode(value: unknown) {
    const mode = String(value || "").toLowerCase();
    if (mode === "t2v" || mode === "i2v" || mode === "fl2v" || mode === "ref2va") return mode;
    return "ref2va";
}

function parsedSeed(value: unknown) {
    const seed = Number(value);
    return Number.isSafeInteger(seed) && seed >= 0 ? seed : undefined;
}

export function segmentsFor(metadata: Record<string, unknown>): H3Segment[] {
    const value = metadata.segments;
    const raw: H3Segment[] = Array.isArray(value) && value.length
        ? value as H3Segment[]
        : [{ id: "segment-1", prompt: String(metadata.prompt || defaultPrompt), duration: Number(metadata.duration || 8), status: "idle" }];
    let start = 0;
    return raw.map((segment, index) => {
        const duration = Math.max(0.5, Math.min(60, Number(segment.duration || metadata.duration || 5)));
        const seed = segment.seed ?? (typeof metadata.seed === "string" || typeof metadata.seed === "number" ? metadata.seed : typeof metadata.noiseSeed === "string" || typeof metadata.noiseSeed === "number" ? metadata.noiseSeed : "");
        const seedMode = segment.noiseSeedMode === "fixed"
            ? "fixed"
            : segment.noiseSeedMode === "random"
                ? "random"
                : parsedSeed(seed) !== undefined && parsedSeed(seed) !== 0 ? "fixed" : "random";
        // A zero seed is the old placeholder for random mode, not a value to
        // show as if it were the effective seed that will be submitted.
        const visibleSeed = seedMode === "random" && parsedSeed(seed) === 0 ? "" : seed;
        const legacyLoraName = String(segment.loraName || metadata.loraName || "").trim();
        const loraSlots = segment.loraSlots?.length
            ? segment.loraSlots
            : legacyLoraName
                ? [{ name: legacyLoraName, strength: Number(segment.loraStrength ?? metadata.loraStrength ?? 1), enabled: true }]
                : segment.loraSlots;
        const mode = canonicalTaskMode(segment.mode ?? segment.taskMode ?? metadata.mode ?? metadata.taskMode ?? (metadata.videoSource ? "ref2va" : "ref2va"));
        const normalized: H3Segment = {
            ...segment,
            id: String(segment.id || `segment-${index + 1}`),
            start,
            duration,
            prompt: segment.prompt !== undefined ? String(segment.prompt) : metadata.prompt !== undefined ? String(metadata.prompt) : defaultPrompt,
            result: resultUrl(segment.result),
            mode,
            taskMode: mode,
            seed: visibleSeed,
            noiseSeedMode: seedMode,
            noiseSeed: visibleSeed,
            loraSlots,
            loraName: legacyLoraName,
            loraStrength: Number(segment.loraStrength ?? metadata.loraStrength ?? 1),
            modelName: String(segment.modelName || metadata.modelName || metadata.minimaxBaseModel || defaultH3Model),
            combatLoraWeight: Number(segment.combatLoraWeight ?? metadata.combatLoraWeight ?? 0),
            cinematicLoraWeight: Number(segment.cinematicLoraWeight ?? metadata.cinematicLoraWeight ?? 0),
            teAccel: segment.teAccel ?? (metadata.teAccel === true || metadata.minimaxGlobalTeAccel === true),
            noDub: segment.noDub ?? (metadata.noDub !== false),
            noCaption: segment.noCaption ?? (metadata.noCaption !== false),
            aspectRatio: String(segment.aspectRatio || metadata.aspectRatio || "16:9").replace(" (Widescreen)", ""),
            megapixels: Number(segment.megapixels || metadata.megapixels || metadata.minimaxGlobalMegapixels || 0.4),
            videoSteps: Number(segment.videoSteps || metadata.videoSteps || metadata.minimaxGlobalVideoSteps || 20),
            denoise: Number(segment.denoise ?? metadata.denoise ?? 1),
            motionContextNoiseEnabled: segment.motionContextNoiseEnabled !== false,
            audioMode: String(segment.audioMode || "native"),
            strictPromptTags: segment.strictPromptTags !== false,
        };
        start += duration;
        return normalized;
    });
}
export function compactSegmentStarts(segments: H3Segment[]) { let start = 0; return segments.map((segment) => { const next = { ...segment, start }; start += Math.max(0.5, Number(segment.duration || 1)); return next; }); }
export function useH3Segments(ctx: CanvasNodeContext) { const metadata = ctx.node.metadata || {}; const segments = useMemo(() => segmentsFor(metadata), [metadata]); return { segments, update: (next: H3Segment[]) => ctx.updateMetadata({ segments: compactSegmentStarts(next) }) }; }
