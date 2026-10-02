import { shallow } from "zustand/shallow";
import type { WorkflowField } from "@/services/api/workflows";

function aspectFromSize(size: string) {
    const match = /^\s*(\d+(?:\.\d+)?)\s*([:x])\s*(\d+(?:\.\d+)?)\s*$/i.exec(size);
    if (!match) return null;
    const width = Number(match[1]);
    const height = Number(match[3]);
    return width > 0 && height > 0 ? width / height : null;
}

/** Resolve the actual workflow COMBO value, including a matching canvas size for a new node. */
export function workflowAspectOption(field: WorkflowField, current: unknown, routed: unknown, size: string) {
    if (field.input !== "aspect_ratio" || field.type !== "dropdown") return undefined;
    const options = field.options || [];
    const explicit = [current, routed].find((value) => options.includes(String(value)));
    if (explicit !== undefined) return String(explicit);
    const ratio = aspectFromSize(size);
    const sizeOption = ratio === null ? undefined : options.find((option) => {
        const optionRatio = aspectFromSize(option.match(/^\s*\d+(?:\.\d+)?\s*:\s*\d+(?:\.\d+)?/)?.[0] || "");
        return optionRatio !== null && Math.abs(optionRatio - ratio) < 0.01;
    });
    return sizeOption || (options.includes(String(field.default ?? "")) ? String(field.default) : options[0]);
}

/** 重复挂载/渲染时保留已存参数，只有实际切换工作流才重置。 */
export function reconcileWorkflowParams(
    current: Record<string, unknown> | undefined,
    fields: WorkflowField[],
    routed: Record<string, unknown>,
    reset: boolean,
    size = "auto",
): Record<string, unknown> | undefined {
    const next: Record<string, unknown> = {};
    for (const field of fields) {
        const options = field.options || [];
        const defaultValue = field.type === "dropdown"
            ? (options.includes(String(field.default ?? "")) ? field.default : options[0] ?? "")
            : field.default ?? (field.type === "boolean" ? false : field.type === "number" || field.type === "slider" ? 0 : "");
        next[field.id] = workflowAspectOption(field, !reset ? current?.[field.id] : undefined, routed[field.id], size)
            ?? (!reset ? current?.[field.id] : undefined) ?? routed[field.id] ?? defaultValue;
    }
    return shallow(current || {}, next) ? current : next;
}

/** 工作流字段 ID 可能在重新保存后变化；按 Comfy 节点和输入名迁移已保存值。 */
export function migrateWorkflowParams(
    current: Record<string, unknown> | undefined,
    previousFields: WorkflowField[],
    nextFields: WorkflowField[],
): Record<string, unknown> | undefined {
    if (!current) return current;
    let next: Record<string, unknown> | undefined;
    for (const previous of previousFields) {
        const field = nextFields.find((candidate) => candidate.node === previous.node && candidate.input === previous.input);
        if (!field || field.id === previous.id || !Object.prototype.hasOwnProperty.call(current, previous.id)) continue;
        next ??= { ...current };
        if (!Object.prototype.hasOwnProperty.call(next, field.id)) next[field.id] = current[previous.id];
        delete next[previous.id];
    }
    // 页面重载后拿不到旧字段映射时，仅在值与下拉选项唯一匹配时恢复孤立参数。
    if (!previousFields.length) {
        const fieldIds = new Set(nextFields.map((field) => field.id));
        const orphaned = Object.entries(current).filter(([id]) => !fieldIds.has(id));
        const candidates = nextFields
            .filter((field) => field.type === "dropdown" && !Object.prototype.hasOwnProperty.call(current, field.id))
            .map((field) => ({ field, values: orphaned.filter(([, value]) => (field.options || []).includes(String(value))) }));
        for (const candidate of candidates) {
            const match = candidate.values.length === 1 ? candidate.values[0] : undefined;
            if (!match) continue;
            const [id, value] = match;
            if (candidates.filter((item) => item.values.some(([candidateId]) => candidateId === id)).length !== 1) continue;
            next ??= { ...current };
            next[candidate.field.id] = value;
            delete next[id];
        }
    }
    return next || current;
}
