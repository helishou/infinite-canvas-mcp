import { shallow } from "zustand/shallow";
import type { WorkflowField } from "@/services/api/workflows";

/** 重复挂载/渲染时保留已存参数，只有实际切换工作流才重置。 */
export function reconcileWorkflowParams(
    current: Record<string, unknown> | undefined,
    fields: WorkflowField[],
    routed: Record<string, unknown>,
    reset: boolean,
): Record<string, unknown> | undefined {
    const next: Record<string, unknown> = {};
    for (const field of fields) {
        const options = field.options || [];
        const defaultValue = field.type === "dropdown"
            ? (options.includes(String(field.default ?? "")) ? field.default : options[0] ?? "")
            : field.default ?? (field.type === "boolean" ? false : field.type === "number" || field.type === "slider" ? 0 : "");
        next[field.id] = (!reset ? current?.[field.id] : undefined) ?? routed[field.id] ?? defaultValue;
    }
    return shallow(current || {}, next) ? current : next;
}
