const OMIT_SETTING_KEYS = /(workflowJson|workflowGraph|comfyUrl|tempDir|api.?key|authorization|token|secret|password|dataUrl|references?|loopInputImages|videoReferences|audioReferences|referenceAudio|parentTaskId|canvasBinding|actualSubmission|submission|promptId|taskId|runtimeTaskId)/i;

/** Keep the settings sent for a run while excluding credentials, inline media and runtime bookkeeping. */
export function generationSettingsSnapshot(
    params: Record<string, unknown> | undefined,
    explicit: Record<string, unknown>,
): Record<string, unknown> {
    const clean = (value: unknown, key = ""): unknown => {
        if (OMIT_SETTING_KEYS.test(key)) return undefined;
        if (typeof value === "string" && /^data:[^,]*;base64,/i.test(value)) return undefined;
        if (Array.isArray(value)) return value.map((item) => clean(item)).filter((item) => item !== undefined);
        if (!value || typeof value !== "object") return value;
        return Object.fromEntries(Object.entries(value as Record<string, unknown>)
            .map(([childKey, child]) => [childKey, clean(child, childKey)] as const)
            .filter(([, child]) => child !== undefined));
    };
    const definedExplicit = Object.fromEntries(Object.entries(explicit).filter(([, value]) => value !== undefined));
    return clean({ ...(params || {}), ...definedExplicit }) as Record<string, unknown>;
}
