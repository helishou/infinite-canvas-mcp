export type WorkflowGenerationField = {
    id: string;
    name?: string;
    input?: string;
    node?: string;
    type?: string;
    isPrompt?: boolean;
};

const OMIT_SETTING_KEYS = /(workflowJson|workflowGraph|comfyUrl|tempDir|api.?key|authorization|token|secret|password|dataUrl|references?|loopInputImages|videoReferences|audioReferences|referenceAudio|parentTaskId|canvasBinding|actualSubmission|submission|promptId|taskId|runtimeTaskId)/i;
const OMIT_WORKFLOW_VALUE = /(api.?key|authorization|token|secret|password)/i;

/** Keep the settings sent for a run while excluding credentials, inline media and runtime bookkeeping. */
export function generationSettingsSnapshot(
    params: Record<string, unknown> | undefined,
    explicit: Record<string, unknown>,
    workflowFields: WorkflowGenerationField[] = [],
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
    const fieldsById = new Map(workflowFields.filter((field) => field.id).map((field) => [field.id, field]));
    const workflowParameters: Record<string, unknown> = {};
    const labelCounts = new Map<string, number>();
    for (const field of fieldsById.values()) {
        const label = String(field.name || field.input || field.id).trim();
        labelCounts.set(label, (labelCounts.get(label) || 0) + 1);
    }
    for (const field of fieldsById.values()) {
        if (field.isPrompt || field.id.toLowerCase() === "prompt") continue;
        if (["image", "video", "audio", "mask"].includes(String(field.type || "").toLowerCase())) continue;
        if (["image", "video", "audio", "mask", "filename", "file"].includes(String(field.input || "").toLowerCase())) continue;
        const label = String(field.name || field.input || field.id).trim();
        if (OMIT_WORKFLOW_VALUE.test(`${label} ${field.input || ""} ${field.id}`)) continue;
        if (!params || !Object.prototype.hasOwnProperty.call(params, field.id)) continue;
        const displayLabel = (labelCounts.get(label) || 0) > 1
            ? `${label} (${field.node || "?"}.${field.input || field.id})`
            : label;
        workflowParameters[displayLabel] = params[field.id];
    }
    const definedExplicit = Object.fromEntries(Object.entries(explicit).filter(([, value]) => value !== undefined));
    const baseParams = Object.fromEntries(Object.entries(params || {}).filter(([key]) => !fieldsById.has(key)));
    const result = clean({ ...baseParams, ...definedExplicit }) as Record<string, unknown>;
    const cleanedWorkflowParameters = clean(workflowParameters, "workflowParameters") as Record<string, unknown>;
    if (Object.keys(cleanedWorkflowParameters).length) result.workflowParameters = cleanedWorkflowParameters;
    return result;
}
