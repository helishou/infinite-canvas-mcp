import { compilationArtifactFreshness } from "./compilation-scope.js";
import type { DirectorProduction } from "./production-contract.js";

/**
 * Why a Clip on the canvas can no longer produce: the compiled H3 artifact that
 * authored it is gone, changed, or has never been applied to the Clip row.
 * `artifact_stale` also covers a changed compiler/runtime or a changed scoped input.
 */
export type ClipPromptStaleReason = "artifact_missing" | "artifact_stale" | "clip_not_applied";

export type ClipPromptFreshness =
    | { state: "compiled_current"; artifactId: string; promptHash: string }
    | { state: "compiled_stale"; staleReason: ClipPromptStaleReason; artifactId?: string; artifactStatus?: string };

const identity = (value: unknown) => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/**
 * Clip freshness is derived from the identity the Clip recorded when the compiled
 * artifact was applied (`productionClipProjection.artifactId/promptHash`), never
 * from the Clip prompt text: the post-compile English translation rewrites that
 * text without producing a new artifact, so text comparison would false-positive.
 *
 * A Clip that never recorded an artifact identity falls back to "the artifact is
 * current", which keeps legacy Clips usable; missing or stale artifacts still block.
 */
export function clipPromptFreshness(director: DirectorProduction | undefined, input: { segmentId: string; projection?: unknown }): ClipPromptFreshness {
    const artifact = director?.artifacts?.find(item => item.kind === "h3" && item.targetId === input.segmentId);
    if (!director || !artifact) return { state: "compiled_stale", staleReason: "artifact_missing" };
    if (artifact.status !== "ready") return { state: "compiled_stale", staleReason: "artifact_stale", artifactId: artifact.id, artifactStatus: artifact.status };
    if (!compilationArtifactFreshness(director, artifact).current) return { state: "compiled_stale", staleReason: "artifact_stale", artifactId: artifact.id, artifactStatus: artifact.status };
    const projection = identity(input.projection);
    const projectedArtifactId = String(projection.artifactId || "");
    const projectedPromptHash = String(projection.promptHash || "");
    if (projectedArtifactId && projectedArtifactId !== artifact.id) return { state: "compiled_stale", staleReason: "clip_not_applied", artifactId: artifact.id };
    if (projectedPromptHash && projectedPromptHash !== artifact.sha256) return { state: "compiled_stale", staleReason: "clip_not_applied", artifactId: artifact.id };
    return { state: "compiled_current", artifactId: artifact.id, promptHash: artifact.sha256 };
}
