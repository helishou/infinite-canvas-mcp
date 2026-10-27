import type { WorkflowField } from "../db.js";

type RunningHubWorkflowField = {
    id?: string;
    nodeId: string;
    fieldName: string;
    enabled?: boolean;
    source?: string;
};

/** Map values from local fields to their RH counterparts by stable node/input identity. */
export function bridgeLocalWorkflowValues(
    runningHubFields: RunningHubWorkflowField[],
    localFields: WorkflowField[],
    values: Record<string, unknown>,
) {
    const localValues = new Map<string, unknown>();
    for (const field of localFields) {
        const value = values[field.id] ?? field.default;
        if (value === undefined || value === null) continue;
        for (const nodeId of String(field.node || "").split(",").map((item) => item.trim()).filter(Boolean)) {
            localValues.set(`${nodeId}::${field.input}`, value);
        }
    }
    const bridged: Record<string, unknown> = {};
    for (const field of runningHubFields) {
        if (field.enabled === false || field.source && field.source !== "constant") continue;
        const key = `${field.nodeId}::${field.fieldName}`;
        const value = localValues.get(key);
        if (value !== undefined) bridged[field.id || key] = value;
    }
    return bridged;
}
