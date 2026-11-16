import { useEffect, useMemo } from "@infinite-canvas/plugin-sdk";
import type { CanvasNodeContext } from "@infinite-canvas/plugin-sdk";
import type { H3Segment } from "../types";
import { defaultPrompt } from "../constants";
import { compactH3SegmentStarts } from "@basketikun/canvas-agent/runtime-fields";
import { canonicalH3TaskMode } from "@basketikun/canvas-agent/plugins/minimax-h3/runtime-params";
function resultUrl(value: unknown) { return typeof value === "string" ? value : value && typeof value === "object" ? String((value as Record<string, unknown>).url || (value as Record<string, unknown>).content || "") : ""; }

/** Timeline view only; never inject model/sampling defaults into saved Clips. */
/** H3 只走自选视频模型；没选过的老 Clip 默认落到引擎的展开流。 */
export const H3_DEFAULT_SELECTED_VIDEO_MODEL = "engine-local::H3 展开流";

export function segmentsFor(metadata: Record<string, unknown>): H3Segment[] {
    const value = metadata.segments;
    const raw: H3Segment[] = Array.isArray(value) && value.length
        ? value as H3Segment[]
        : metadata.productionSceneId ? [] : [{ id: "segment-1", prompt: String(metadata.prompt || defaultPrompt), duration: Number(metadata.duration || 8), status: "idle" }];
    let start = 0;
    return raw.map((segment, index) => {
        const duration = Math.max(0.5, Math.min(60, Number(segment.duration || metadata.duration || 5)));
        const mode = canonicalH3TaskMode(segment.taskMode ?? segment.mode ?? metadata.taskMode ?? metadata.mode) as H3Segment["mode"];
        const normalized: H3Segment = {
            ...segment,
            id: String(segment.id || `segment-${index + 1}`),
            start,
            duration,
            prompt: segment.prompt !== undefined ? String(segment.prompt) : metadata.prompt !== undefined ? String(metadata.prompt) : defaultPrompt,
            result: resultUrl(segment.result),
            mode,
            taskMode: mode,
            // 原生 H3 本地链路已下线：自选模型恒为开，未指定时落在展开流上。
            selectedVideoModelEnabled: true,
            selectedVideoModel: String(segment.selectedVideoModel || metadata.h3LastSelectedVideoModel || H3_DEFAULT_SELECTED_VIDEO_MODEL).trim(),
        };
        start += duration;
        return normalized;
    });
}
export function compactSegmentStarts(segments: H3Segment[]) { return compactH3SegmentStarts(segments); }

/** 老 Clip 是否还缺「自选视频模型」这两项（迁移判定用，不改动其它已保存参数）。 */
export function needsSelectedVideoModelMigration(metadata: Record<string, unknown>): boolean {
    const raw = Array.isArray(metadata.segments) ? metadata.segments as Array<Record<string, unknown>> : [];
    return raw.some((segment) => segment.selectedVideoModelEnabled !== true || !String(segment.selectedVideoModel || "").trim());
}

export function useH3Segments(ctx: CanvasNodeContext) {
    const metadata = ctx.node.metadata || {};
    const segments = useMemo(() => segmentsFor(metadata), [metadata]);
    // 一次性迁移：老 Clip 把「原生 H3」存成了 selectedVideoModelEnabled=false / 空模型，
    // 而预检要求提交参数与保存值一致，所以默认值必须真正写回 metadata，不能只在显示时补。
    useEffect(() => {
        if (!needsSelectedVideoModelMigration(metadata)) return;
        const raw = metadata.segments as Array<Record<string, unknown>>;
        ctx.updateMetadata({
            segments: raw.map((segment) => ({
                ...segment,
                selectedVideoModelEnabled: true,
                selectedVideoModel: String(segment.selectedVideoModel || "").trim() || H3_DEFAULT_SELECTED_VIDEO_MODEL,
            })),
        });
    }, [ctx, metadata]);
    return { segments, update: (next: H3Segment[]) => ctx.updateMetadata({ segments: compactSegmentStarts(next) }) };
}
