import type { H3Segment } from "../types";
import { compactSegmentStarts } from "../hooks/useH3Segments";
import { withH3ParameterEdits } from "@basketikun/canvas-agent/plugins/minimax-h3/runtime-params";

// Null records a cleared field so a later Clip does not inherit its previous value.
export function globalH3Settings(metadata: Record<string, unknown>): Record<string, unknown> {
    const value = metadata.h3GlobalSettings;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function applyH3GlobalSettings(segment: H3Segment, metadata: Record<string, unknown>): H3Segment {
    const settings = globalH3Settings(metadata);
    const patch = Object.fromEntries(Object.entries(settings).map(([key, value]) => [key, value === null ? undefined : value]));
    return { ...segment, ...withH3ParameterEdits(segment as unknown as Record<string, unknown>, patch) } as H3Segment;
}

export function patchH3GlobalSettings(metadata: Record<string, unknown>, patch: Partial<H3Segment>) {
    return { h3GlobalSettings: { ...globalH3Settings(metadata), ...Object.fromEntries(Object.entries(patch).map(([key, value]) => [key, value === undefined ? null : value])) } };
}

export function patchAllH3Clips(metadata: Record<string, unknown>, segments: H3Segment[], patch: Partial<H3Segment>) {
    const { h3ParameterOverrides: _overrides, ...atomicPatch } = withH3ParameterEdits({}, patch);
    return { ...patchH3GlobalSettings(metadata, atomicPatch as Partial<H3Segment>), segments: compactSegmentStarts(segments.map((segment) => ({ ...segment, ...withH3ParameterEdits(segment as unknown as Record<string, unknown>, patch) } as H3Segment))) };
}
