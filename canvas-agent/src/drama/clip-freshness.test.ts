import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { clipPromptFreshness } from "./clip-freshness.js";
import type { DirectorProduction } from "./production-contract.js";

const prompt = "integrated_multimodal_description:\n[Shot 1] Fixed shot.\n";
const promptHash = createHash("sha256").update(prompt).digest("hex");
const engine = { commit: "a".repeat(40), patchVersion: "test", runtimeId: "runtime", version: "4.3.9", compilerHashes: { h3: "h3", image: "image" } };
const artifact = (overrides: Record<string, unknown> = {}) => ({ id: "ARTIFACT", targetId: "SEG", kind: "h3", prompt, sha256: promptHash, sourceHash: "source", status: "ready",
    references: [], receipt: { sourceHash: "source", promptHash, engineRuntimeId: "runtime", engine }, ...overrides });
const director = (artifacts: unknown[] = [artifact()]) => ({ sourceHash: "source", engine, artifacts }) as unknown as DirectorProduction;

test("a Clip that applied the current artifact is current", () => {
    assert.deepEqual(clipPromptFreshness(director(), { segmentId: "SEG", projection: { artifactId: "ARTIFACT", promptHash } }), { state: "compiled_current", artifactId: "ARTIFACT", promptHash });
});

test("a Clip still pointing at an older artifact must be re-applied", () => {
    const freshness = clipPromptFreshness(director(), { segmentId: "SEG", projection: { artifactId: "OLD", promptHash: "old" } });
    assert.equal(freshness.state, "compiled_stale");
    if (freshness.state === "compiled_stale") assert.equal(freshness.staleReason, "clip_not_applied");
});

test("a stale artifact blocks even when the Clip projection matches it", () => {
    const freshness = clipPromptFreshness(director([artifact({ status: "stale" })]), { segmentId: "SEG", projection: { artifactId: "ARTIFACT", promptHash } });
    assert.equal(freshness.state, "compiled_stale");
    if (freshness.state === "compiled_stale") assert.equal(freshness.staleReason, "artifact_stale");
});

test("a missing artifact blocks with its own reason", () => {
    const freshness = clipPromptFreshness(director([]), { segmentId: "SEG", projection: { artifactId: "ARTIFACT" } });
    assert.equal(freshness.state, "compiled_stale");
    if (freshness.state === "compiled_stale") assert.equal(freshness.staleReason, "artifact_missing");
});
