import type { WorkflowField } from "@/services/api/workflows";

/** Presentation only: every mapped field retains its identity and relative order. */
export function groupWorkflowFields(fields: WorkflowField[]) {
    return [
        { key: "content", fields: fields.filter(field => field.type === "text") },
        { key: "media", fields: fields.filter(field => ["image", "video", "audio"].includes(field.type)) },
        { key: "parameters", fields: fields.filter(field => !["text", "image", "video", "audio"].includes(field.type)) },
    ].filter(group => group.fields.length > 0);
}
