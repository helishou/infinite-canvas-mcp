import type { CanvasNodeContext } from "@infinite-canvas/plugin-sdk";
import type { H3Ref, H3Segment } from "../types";
import { segmentsFor } from "../hooks/useH3Segments";
import { resultUrl } from "./h3-data";

const RESTORABLE_PARAM_KEYS = ["prompt", "taskMode", "duration", "aspectRatio", "megapixels", "videoSteps", "denoise", "noiseSeedMode", "noiseSeed", "seed", "modelName", "loraName", "loraStrength", "teAccel", "noDub", "noCaption", "audioMode", "audioDenoiseStrength", "addSourceAsReference", "promptPrimaryAudioOrdinal", "strictPromptTags", "referenceVideoPolicy", "refImageSize", "motionContextEnabled", "tailFrameEnabled", "motionContextNoiseEnabled", "motionContextNoiseAlpha", "motionContextNoiseAlphaEnd", "motionContextNoiseRampFrames", "combatLoraWeight", "cinematicLoraWeight"] as const;

export function patchSelectedSegment(ctx: CanvasNodeContext, metadata: Record<string, unknown>, patch: Partial<H3Segment>) {
    const segments = segmentsFor(metadata);
    const selectedId = String(metadata.selectedSegmentId || segments[0]?.id || "");
    ctx.updateMetadata({ selectedSegmentId: selectedId, segments: segments.map((segment) => segment.id === selectedId ? { ...segment, ...patch } : segment) });
}

export function buildRestoreParamsPatch(segments: H3Segment[], ref: H3Ref): Partial<H3Segment> {
    const source = segments.find((segment) => resultUrl(segment.result) === ref.url || (segment.results || []).some((item) => item.url === ref.url));
    if (!source) return {};
    const record = source as Record<string, unknown>;
    return Object.fromEntries(RESTORABLE_PARAM_KEYS.filter((key) => record[key] !== undefined).map((key) => [key, record[key]])) as Partial<H3Segment>;
}
