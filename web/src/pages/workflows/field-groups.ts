import type { WorkflowField } from "@/services/api/workflows";

/** Presentation only: every mapped field retains its identity and relative order. */
export function groupWorkflowFields(fields: WorkflowField[]) {
    return [
        { key: "content", fields: fields.filter(field => field.type === "text") },
        { key: "media", fields: fields.filter(field => ["image", "video", "audio"].includes(field.type)) },
        { key: "parameters", fields: fields.filter(field => !["text", "image", "video", "audio"].includes(field.type)) },
    ].filter(group => group.fields.length > 0);
}

/**
 * 把媒体字段按 `orderedMediaIds` 的新顺序重排，非媒体字段保持原位置不动。
 * 这就是「拖拽调整参考图顺序」的落点：本地链按 config.fields 顺序注入媒体，
 * RunningHub 链按 source + index 注入，两条链都只认媒体字段的相对顺序，所以
 * 只动媒体、不动其它字段类型即可，不会破坏文本/参数输入。
 */
export function reorderMediaFields<T>(
    fields: T[],
    isMedia: (field: T) => boolean,
    getId: (field: T) => string,
    orderedMediaIds: string[],
): T[] {
    const mediaIds = new Set(fields.filter(isMedia).map(getId));
    const byId = new Map(fields.filter((field) => mediaIds.has(getId(field))).map((field) => [getId(field), field]));
    const queue = orderedMediaIds.map((id) => byId.get(id)).filter((field): field is T => field !== undefined);
    let cursor = 0;
    return fields.map((field) => {
        if (!mediaIds.has(getId(field))) return field;
        const next = queue[cursor++];
        // orderedMediaIds 比媒体字段少（或含未知 id）时，多余的媒体槽位保留原图，不落空。
        return next === undefined ? field : next;
    });
}
