import { z } from "zod";
import { BASE_H3_NODE_METADATA } from "../plugins/minimax-h3/node-factory.js";
import { H3_PARAM_KEYS } from "../plugins/minimax-h3/runtime-params.js";
import { H3_NARRATIVE_FIELDS } from "../plugins/minimax-h3/narrative-edits.js";
export const nodePatchSchema = z.object({
    title: z.string().optional(), type: z.string().optional(),
    x: z.number().finite().optional(), y: z.number().finite().optional(),
    position: z.object({ x: z.number().finite(), y: z.number().finite() }).strict().optional(),
    width: z.number().finite().positive().optional(), height: z.number().finite().positive().optional(),
}).strict();
export const nodeUpdateFields = { patch: nodePatchSchema.optional(), metadata: z.record(z.unknown()).optional() };
export function validateNodeUpdate(operation: Record<string, any>, previous?: Record<string, any>) {
    const patch = nodePatchSchema.parse(operation.patch || {});
    if (!Object.keys(patch).length && !Object.keys(operation.metadata || {}).length && !operation.metadataDelete?.length) throw new Error("INVALID_NODE_PATCH: patch 或 metadata 必须包含修改字段");
    if (patch.position && (patch.x !== undefined || patch.y !== undefined)) throw new Error("INVALID_NODE_PATCH: position 与 x/y 不能同时提供");
    if (patch.x !== undefined || patch.y !== undefined) {
        if (!previous && (patch.x === undefined || patch.y === undefined)) return patch;
        const position = { x: patch.x ?? previous?.position?.x ?? 0, y: patch.y ?? previous?.position?.y ?? 0 };
        delete patch.x; delete patch.y; patch.position = position;
    }
    return patch;
}
const clipKeys = new Set([...H3_PARAM_KEYS, ...H3_NARRATIVE_FIELDS, ...Object.keys(BASE_H3_NODE_METADATA), "title", "taskMode", "h3ParameterPolicy", "referenceBindings", "storyboardShots", "subjects", "tailFrameContinuation", "sourceShotId", "styleTemplateId", "strictPromptTags"]);
export function validateH3Edit(patch: Record<string, any>, allowLegacy = false) {
    for (const [key, value] of Object.entries(patch)) {
        if (allowLegacy && ["refs", "refItems"].includes(key)) continue;
        if (!clipKeys.has(key)) throw new Error(`INVALID_CLIP_FIELD: patch.${key} 不属于可编辑 Clip 配置`);
        const base = BASE_H3_NODE_METADATA[key];
        if (typeof base === "boolean" && typeof value !== "boolean") throw new Error(`INVALID_CLIP_FIELD: patch.${key} 必须为 boolean`);
        if (typeof base === "number" && (typeof value !== "number" || !Number.isFinite(value))) throw new Error(`INVALID_CLIP_FIELD: patch.${key} 必须为有限 number`);
        if (["title", "prompt", ...H3_NARRATIVE_FIELDS.filter(field => field !== "timeline")].includes(key as any) && typeof value !== "string") throw new Error(`INVALID_CLIP_FIELD: patch.${key} 必须为 string`);
        if (["referenceBindings", "storyboardShots", "subjects", "timeline", "loraSlots"].includes(key) && !Array.isArray(value)) throw new Error(`INVALID_CLIP_FIELD: patch.${key} 必须为 array`);
        if (key === "duration" && (typeof value !== "number" && typeof value !== "string" || !Number.isFinite(Number(value)) || Number(value) <= 0)) throw new Error("INVALID_CLIP_FIELD: patch.duration 必须为正数");
        if (key === "taskMode" && !["t2v", "i2v", "fl2v", "l2v", "ref2va"].includes(String(value))) throw new Error("INVALID_CLIP_FIELD: patch.taskMode 无效");
    }
}

/** Extension metadata stays extensible; known H3 controls keep their declared types. */
export function validateH3Metadata(metadata: Record<string, any>) {
    validateH3Edit(Object.fromEntries(Object.entries(metadata).filter(([key]) => clipKeys.has(key) && !["status", "content", "segments"].includes(key))));
}
