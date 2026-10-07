import { useMemo } from "@infinite-canvas/plugin-sdk";
import type { CanvasNodeContext } from "@infinite-canvas/plugin-sdk";
import type { H3Segment } from "../types";
import { defaultPrompt } from "../constants";
import { compactH3SegmentStarts } from "@basketikun/canvas-agent/runtime-fields";
import { canonicalH3TaskMode } from "@basketikun/canvas-agent/plugins/minimax-h3/runtime-params";
function resultUrl(value: unknown) { return typeof value === "string" ? value : value && typeof value === "object" ? String((value as Record<string, unknown>).url || (value as Record<string, unknown>).content || "") : ""; }

/** Timeline view only; never inject model/sampling defaults into saved Clips. */
export function segmentsFor(metadata: Record<string, unknown>): H3Segment[] {
    const value = metadata.segments;
    const raw: H3Segment[] = Array.isArray(value) && value.length
        ? value as H3Segment[]
        : [{ id: "segment-1", prompt: String(metadata.prompt || defaultPrompt), duration: Number(metadata.duration || 8), status: "idle" }];
    let start = 0;
    return raw.map((segment, index) => {
        const duration = Math.max(0.5, Math.min(60, Number(segment.duration || metadata.duration || 5)));
        const mode = canonicalH3TaskMode(segment.mode ?? segment.taskMode ?? metadata.mode ?? metadata.taskMode) as H3Segment["mode"];
        const normalized: H3Segment = {
            ...segment,
            id: String(segment.id || `segment-${index + 1}`),
            start,
            duration,
            prompt: segment.prompt !== undefined ? String(segment.prompt) : metadata.prompt !== undefined ? String(metadata.prompt) : defaultPrompt,
            result: resultUrl(segment.result),
            mode,
            taskMode: mode,
        };
        start += duration;
        return normalized;
    });
}
export function compactSegmentStarts(segments: H3Segment[]) { return compactH3SegmentStarts(segments); }
export function useH3Segments(ctx: CanvasNodeContext) { const metadata = ctx.node.metadata || {}; const segments = useMemo(() => segmentsFor(metadata), [metadata]); return { segments, update: (next: H3Segment[]) => ctx.updateMetadata({ segments: compactSegmentStarts(next) }) }; }
