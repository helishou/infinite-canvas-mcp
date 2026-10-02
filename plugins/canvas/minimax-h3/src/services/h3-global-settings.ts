import type { H3Segment } from "../types";
import { compactSegmentStarts } from "../hooks/useH3Segments";

// Null records a cleared field so a later Clip does not inherit its previous value.
export function globalH3Settings(metadata: Record<string, unknown>): Record<string, unknown> {
    const value = metadata.h3GlobalSettings;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function applyH3GlobalSettings(segment: H3Segment, metadata: Record<string, unknown>): H3Segment {
    const settings = globalH3Settings(metadata);
    return { ...segment, ...Object.fromEntries(Object.entries(settings).map(([key, value]) => [key, value === null ? undefined : value])) };
}

export function patchH3GlobalSettings(metadata: Record<string, unknown>, patch: Partial<H3Segment>) {
    return { h3GlobalSettings: { ...globalH3Settings(metadata), ...Object.fromEntries(Object.entries(patch).map(([key, value]) => [key, value === undefined ? null : value])) } };
}

export function patchAllH3Clips(metadata: Record<string, unknown>, segments: H3Segment[], patch: Partial<H3Segment>) {
    return { ...patchH3GlobalSettings(metadata, patch), segments: compactSegmentStarts(segments.map((segment) => ({ ...segment, ...patch }))) };
}
