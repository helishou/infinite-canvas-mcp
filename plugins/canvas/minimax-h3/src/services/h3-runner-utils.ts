import type { H3Ref, H3Segment } from "../types";
import { restorableParams } from "./h3-segment-utils";

type GeneratedSegment = { media?: Array<{ mimeType: string; url?: string; storageKey?: string }> };

export function mapAutoSplitSegments(segment: H3Segment, generated: GeneratedSegment[], prompt: string, duration: number): H3Segment[] {
    return generated.map((item, index) => {
        const output = item.media?.find((media) => media.mimeType.startsWith("video/"));
        const url = output?.url || "";
        return {
            ...segment,
            id: `${segment.id}-${index + 1}`,
            prompt: String(segment.prompt || prompt),
            duration,
            start: 0,
            result: url,
            resultStorageKey: output?.storageKey,
            results: url ? [{ url, storageKey: output?.storageKey, type: "video", name: `Clip ${index + 1}` }] : [],
            status: "success",
        };
    });
}

export function mergeH3Segments(all: H3Segment[], generated: H3Segment[], activeId: string, runFromCurrent: boolean, autoSplit: boolean): H3Segment[] {
    if (runFromCurrent) return all.map((segment) => generated.find((item) => item.id === segment.id) || segment);
    if (autoSplit && generated.length) {
        const activeIndex = Math.max(0, all.findIndex((item) => item.id === activeId));
        return [...all.slice(0, activeIndex), ...generated, ...all.slice(activeIndex + 1)];
    }
    return all.map((segment) => generated.find((item) => item.id === segment.id) || segment);
}

export function generatedVideoMaterials(segments: H3Segment[]): H3Ref[] {
    // 每条输出材料挂一份生成时刻的参数快照，Output「设为当前 Clip」在源 Clip
    // 被删除/重建后仍能还原参数（buildRestoreParamsPatch 的最终兜底）。
    return segments.flatMap((segment, index) => (segment.results || []).filter((item) => item.type === "video").map((item) => ({ ...item, name: item.name || `Clip ${index + 1}`, segmentId: segment.id, params: restorableParams(segment as unknown as Record<string, unknown>) })));
}
