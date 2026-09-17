import crypto from "node:crypto";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function canonical(value: unknown): Json {
    if (value === null || typeof value === "boolean" || typeof value === "string") return value;
    if (typeof value === "number") return Number.isFinite(value) ? value : String(value) as unknown as Json;
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value as Record<string, unknown>)
            .filter(([, item]) => item !== undefined && typeof item !== "function")
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, item]) => [key, canonical(item)]));
    }
    return String(value);
}

export function stableH3Fingerprint(value: unknown): string {
    return crypto.createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

export function h3ClipDependsOnPrevious(segment: Record<string, unknown>, params: Record<string, unknown> = {}) {
    return segment.motionContextEnabled === true || params.motionContextEnabled === true
        || segment.previousVideoAsReference === true || params.previousVideoAsReference === true
        || segment.tailFrameContinuation === true || params.tailFrameContinuation === true
        || segment.previousTailFrameContinuation === true;
}

export function h3ClipCacheFingerprint(input: {
    segment: Record<string, unknown>;
    params: Record<string, unknown>;
    references: unknown[];
    compiledPrompt: string;
    previousFingerprint?: string;
}) {
    const { segment, params, references, compiledPrompt, previousFingerprint } = input;
    const dependency = h3ClipDependsOnPrevious(segment, params) ? String(previousFingerprint || "missing") : "independent";
    const segmentInputs = Object.fromEntries(Object.entries(segment).filter(([key]) => ![
        "result", "resultStorageKey", "results", "status", "progress", "runtimeTaskId", "errorDetails",
        "cacheFingerprint", "firstPassFingerprint", "firstPassReady", "firstPassResult", "firstPassStorageKey",
    ].includes(key)));
    const fingerprintParams = Object.fromEntries(Object.entries(params).filter(([key]) => !["confirmSecondPass", "postGenerationOnly"].includes(key)));
    return stableH3Fingerprint({ version: 1, segment: segmentInputs, params: fingerprintParams, references, compiledPrompt, dependency });
}

export function h3ConfirmationPhaseParams(segment: Record<string, unknown>, params: Record<string, unknown>, confirming = false): Record<string, unknown> {
    if (segment.confirmationMode !== true) return { ...params };
    if (confirming) return { ...params, postGenerationOnly: true, confirmSecondPass: true, motionContextEnabled: false };
    return {
        ...params,
        latentUpscaleEnabled: false,
        rtxEnabled: false,
        faceRefineEnabled: false,
        dlssUpscaleMode: "关闭",
        dlssFrameInterpolationEnabled: false,
    };
}

export function planH3CacheReuse(rows: Array<{
    segment: Record<string, unknown>;
    fingerprint: string;
}>) {
    return rows.map(({ segment, fingerprint }) => ({
        fingerprint,
        reusable: Boolean(segment.result) && segment.cacheFingerprint === fingerprint,
    }));
}
