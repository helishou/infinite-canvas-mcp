import type { CanvasNodeContext } from "@infinite-canvas/plugin-sdk";
import type { H3Ref, H3Segment } from "../types";
import { sameRef } from "./h3-compatibility";
import { segmentsFor } from "../hooks/useH3Segments";

export function refsForSegment(segment: H3Segment) {
    const buckets = segment.refs;
    const items = segment.refItems || [ ...(buckets?.image || []), ...(buckets?.video || []), ...(buckets?.audio || []) ];
    const refs = items.filter((item) => item?.url).map((item) => ({ ...item, type: item.type || (item as H3Ref & { kind?: H3Ref["type"] }).kind || "image" as const }));
    return refs.filter((item, index, all) => all.findIndex((other) => sameRef(other, item)) === index);
}

export function segmentRefsPatch(refs: H3Ref[]): Pick<H3Segment, "refItems" | "refs"> {
    return {
        refItems: refs,
        refs: {
            image: refs.filter((item) => item.type === "image"),
            video: refs.filter((item) => item.type === "video"),
            audio: refs.filter((item) => item.type === "audio"),
        },
    };
}

export function withSegmentRefs(segment: H3Segment, refs: H3Ref[]): H3Segment {
    return { ...segment, ...segmentRefsPatch(refs) };
}

export function resultUrl(value: unknown) {
    if (typeof value === "string") return value;
    if (!value || typeof value !== "object") return "";
    const item = value as Record<string, unknown>;
    return String(item.url || item.video_url || item.content || item.localUrl || "");
}

export function appendVideoMaterials(existing: unknown, additions: Array<{ url: string; storageKey?: string; type: string; name: string; segmentId?: string }>) {
    const current = Array.isArray(existing) ? existing.filter((item) => item && typeof item === "object") as Array<Record<string, unknown>> : [];
    return [...current, ...additions].filter((item, index, all) => Boolean(item.url) && all.findIndex((candidate) => String(candidate.url || "") === String(item.url || "")) === index);
}

export function updateSegment(ctx: CanvasNodeContext, metadata: Record<string, unknown>, index: number, patch: Partial<H3Segment>) {
    ctx.updateMetadata({ segments: segmentsFor(metadata).map((segment, itemIndex) => itemIndex === index ? { ...segment, ...patch } : segment) });
}
