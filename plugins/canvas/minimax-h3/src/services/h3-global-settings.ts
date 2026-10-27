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
    const patch = Object.fromEntries(Object.entries(settings)
        .filter(([key]) => key !== "motionContextEnabled" && key !== "tailFrameContinuation")
        .map(([key, value]) => [key, value === null ? undefined : value]));
    const firstShotId = segment.storyboardShots?.[0]?.referenceBindingId;
    const firstShotRef = segment.referenceBindings?.find(ref => ref.id === firstShotId);
    const mode = String(segment.taskMode || segment.mode || "").toLowerCase();
    const explicitFirstFrame = (["i2v", "i2va", "fl2v", "fl2va"].includes(mode))
        ? segment.referenceBindings?.some(ref => ref.enabled !== false && !["video", "audio"].includes(String(ref.mediaType || "image"))) === true
        : Boolean(firstShotRef && firstShotRef.enabled !== false && !["video", "audio"].includes(String(firstShotRef.mediaType || "image")) && firstShotRef.role === "storyboard");
    const defaultTailFrame = !explicitFirstFrame && segment.motionContextEnabled !== true;
    return { motionContextEnabled: false, tailFrameContinuation: defaultTailFrame, ...segment, ...withH3ParameterEdits(segment as unknown as Record<string, unknown>, patch) } as H3Segment;
}

export function patchH3GlobalSettings(metadata: Record<string, unknown>, patch: Partial<H3Segment>) {
    return { h3GlobalSettings: { ...globalH3Settings(metadata), ...Object.fromEntries(Object.entries(patch).map(([key, value]) => [key, value === undefined ? null : value])) } };
}

export function patchAllH3Clips(metadata: Record<string, unknown>, segments: H3Segment[], patch: Partial<H3Segment>) {
    const { h3ParameterOverrides: _overrides, ...atomicPatch } = withH3ParameterEdits({}, patch);
    return { ...patchH3GlobalSettings(metadata, atomicPatch as Partial<H3Segment>), segments: compactSegmentStarts(segments.map((segment) => ({ ...segment, ...withH3ParameterEdits(segment as unknown as Record<string, unknown>, patch) } as H3Segment))) };
}

/** Resolve a global boundary edit against formal Clip identities; the final Clip has no outgoing edge. */
export function formalContinuationBoundaryUpdates(segments: H3Segment[], patch: Partial<H3Segment>) {
    const formal = segments.filter(segment => typeof segment.productionClipProjection?.targetId === "string" && Boolean(segment.productionClipProjection.targetId));
    const updated = formal.map(segment => {
        const effective = withH3ParameterEdits(segment as unknown as Record<string, unknown>, patch);
        return {
            segmentId: segment.id,
            tailFrameContinuation: effective.tailFrameContinuation === true,
            motionContextEnabled: effective.motionContextEnabled === true,
        };
    });
    if (updated.length) updated[updated.length - 1] = { ...updated[updated.length - 1], tailFrameContinuation: false, motionContextEnabled: false };
    return { boundaries: updated.slice(0, -1), projectedValues: updated };
}
