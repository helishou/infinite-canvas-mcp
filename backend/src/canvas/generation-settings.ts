export type WorkflowGenerationField = {
    id: string;
    name?: string;
    input?: string;
    node?: string;
    type?: string;
    isPrompt?: boolean;
    sourceWorkflow?: string;
};

const OMIT_SETTING_KEYS = /(workflowJson|workflowGraph|comfyUrl|tempDir|api.?key|authorization|token|secret|password|dataUrl|references?|loopInputImages|videoReferences|audioReferences|referenceAudio|parentTaskId|canvasBinding|actualSubmission|submission|promptId|taskId|runtimeTaskId)/i;
const OMIT_WORKFLOW_VALUE = /(api.?key|authorization|token|secret|password)/i;
const INTERNAL_WORKFLOW_FIELD_ID = /^f_\d+_[a-z0-9]{4}$/i;

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
    const displayableFields = [...fieldsById.values()].filter((field) => {
        if (field.isPrompt || field.id.toLowerCase() === "prompt") return false;
        if (["image", "video", "audio", "mask"].includes(String(field.type || "").toLowerCase())) return false;
        if (["image", "video", "audio", "mask", "filename", "file"].includes(String(field.input || "").toLowerCase())) return false;
        const label = String(field.name || field.input || field.id).trim();
        if (OMIT_WORKFLOW_VALUE.test(`${label} ${field.input || ""} ${field.id}`)) return false;
        return Boolean(params && Object.prototype.hasOwnProperty.call(params, field.id));
    });
    const labelCounts = new Map<string, number>();
    for (const field of displayableFields) {
        if (field.sourceWorkflow) continue;
        const label = String(field.name || field.input || field.id).trim();
        labelCounts.set(label, (labelCounts.get(label) || 0) + 1);
    }
    for (const field of displayableFields) {
        const label = String(field.name || field.input || field.id).trim();
        const sourceWorkflow = field.sourceWorkflow?.split(/[\\/]/).pop()?.replace(/\.json$/i, "");
        const displayLabel = sourceWorkflow
            ? `${label} · ${sourceWorkflow}`
            : (labelCounts.get(label) || 0) > 1
                ? `${label} (${field.node || "?"}.${field.input || field.id})`
                : label;
        workflowParameters[displayLabel] = params![field.id];
    }
    const definedExplicit = Object.fromEntries(Object.entries(explicit).filter(([, value]) => value !== undefined));
    const baseParams = Object.fromEntries(Object.entries(params || {}).filter(([key]) => !fieldsById.has(key)));
    const result = clean({ ...baseParams, ...definedExplicit }) as Record<string, unknown>;
    const cleanedWorkflowParameters = clean(workflowParameters, "workflowParameters") as Record<string, unknown>;
    if (Object.keys(cleanedWorkflowParameters).length) result.workflowParameters = cleanedWorkflowParameters;
    return result;
}

/** Keep ComfyUI logs focused on workflow inputs, not channel/routing controls or generic image settings. */
export function workflowGenerationSettingsSnapshot(
    params: Record<string, unknown> | undefined,
    workflowFields: WorkflowGenerationField[] = [],
): Record<string, unknown> {
    const snapshot = generationSettingsSnapshot(params, {}, workflowFields);
    const workflowSettings = { ...snapshot };
    delete workflowSettings.channelId;
    delete workflowSettings.writeBackToTarget;
    for (const key of Object.keys(workflowSettings)) {
        if (INTERNAL_WORKFLOW_FIELD_ID.test(key)) delete workflowSettings[key];
    }
    return workflowSettings;
}
