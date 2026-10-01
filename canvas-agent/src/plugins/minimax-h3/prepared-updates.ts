import { H3_MAX_EDIT_PREVIEWS, H3_TEXT_EDIT_FIELDS, type H3EditSummary } from "./narrative-edits.js";

export type PreparedH3Plan = {
    formatVersion: 1;
    projectId: string;
    nodeId: string;
    revision: number;
    operationId: string;
    operations: Array<Record<string, unknown>>;
    entries: Array<{ segmentId: string; segmentIndex: number; updatedFields: string[]; editSummary?: H3EditSummary }>;
    previewItems: Array<Record<string, unknown>>;
    selection: Array<{ segmentId: string; fields: Record<string, "patch" | "edits"> }>;
    sourceSha256: string;
    sourceBytes: number;
    originalUpdateBytes: number;
    selectedUpdateBytes: number;
};

export function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value);
}

function canonical(value: unknown): string {
    if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
    if (isRecord(value)) return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
    return JSON.stringify(value) ?? "undefined";
}

export function readPreparedSource(value: unknown, projectId: string, nodeId: string, revision: number, segments: Array<Record<string, unknown>>) {
    if (!isRecord(value) || value.formatVersion !== 1) throw new Error("修改文件需要 formatVersion=1");
    if (Object.keys(value).some((key) => !["formatVersion", "projectId", "nodeId", "expectedRevision", "items", "allowChanges"].includes(key))) throw new Error("修改文件含未知顶层字段");
    if (value.allowChanges !== undefined && (!Array.isArray(value.allowChanges) || value.allowChanges.some((key: unknown) => !["dialogue", "timing"].includes(String(key))))) throw new Error("allowChanges 只接受 dialogue/timing，须源于用户明确授权");
    if (value.projectId !== projectId || value.nodeId !== nodeId) throw new Error("修改文件目标 projectId/nodeId 不符");
    if (!Number.isSafeInteger(value.expectedRevision) || value.expectedRevision !== revision) throw new Error(`画布版本冲突：expectedRevision=${String(value.expectedRevision)}，当前 revision=${revision}`);
    if (!Array.isArray(value.items) || !value.items.length || value.items.length > 100) throw new Error("修改文件 items 必须包含 1–100 个 Clip");
    return value.items.map((item: unknown) => {
        if (!isRecord(item) || !isRecord(item.before) || !isRecord(item.update) || typeof item.segmentId !== "string" || item.update.segmentId !== item.segmentId) throw new Error("items 需要一致的 segmentId、before 和 update");
        const target = segments.find((segment) => segment.id === item.segmentId);
        if (!target) throw new Error(`找不到片段:${item.segmentId}`);
        for (const [key, before] of Object.entries(item.before)) if (!Object.hasOwn(target, key) || canonical(target[key]) !== canonical(before)) throw new Error(`Clip ${item.segmentId} 的 before 基线不符:${key}`);
        if (Object.keys(item.update).some((key) => !["segmentId", "patch", "edits"].includes(key))) throw new Error("update 含未知字段");
        if (item.update.patch !== undefined && !isRecord(item.update.patch)) throw new Error("update.patch 必须为对象");
        if (item.update.edits !== undefined && !Array.isArray(item.update.edits)) throw new Error("update.edits 必须为数组");
        const roots = new Set([...Object.keys(isRecord(item.update.patch) ? item.update.patch : {}), ...(Array.isArray(item.update.edits) ? item.update.edits.map((edit: unknown) => isRecord(edit) ? String(edit.field).split("[")[0] : "") : [])]);
        for (const field of roots) if (Object.hasOwn(target, field) && !Object.hasOwn(item.before, field)) throw new Error(`Clip ${item.segmentId} 修改字段缺少 before 基线:${field}`);
        return { segmentId: item.segmentId, ...(isRecord(item.update.patch) && Object.keys(item.update.patch).length ? { patch: item.update.patch } : {}), ...(item.update.edits !== undefined ? { edits: item.update.edits } : {}) };
    });
}

export function assertPreparedInvariants(source: unknown, targets: Array<Record<string, unknown>>, candidates: Array<Record<string, unknown>>) {
    const allowed = new Set(isRecord(source) && Array.isArray(source.allowChanges) ? source.allowChanges : []);
    for (let index = 0; index < targets.length; index++) {
        const old = targets[index], next = candidates[index];
        const dialogue = (value: unknown) => typeof value === "string" ? value.match(/<d>[\s\S]*?<\/d>/g) || [] : [];
        if (!allowed.has("dialogue") && canonical(dialogue(old.prompt)) !== canonical(dialogue(next.prompt))) throw new Error(`Clip ${String(old.id)} 的对白发生变化；默认保护对白`);
        if (!allowed.has("timing")) {
            const times = (value: unknown) => Array.isArray(value) ? value.map((row) => isRecord(row) ? [row.start, row.end] : row) : value;
            const codes = (value: unknown) => typeof value === "string" ? value.match(/\d+(?:\.\d+)?\s*[-–]\s*\d+(?:\.\d+)?\s*(?:s\b|秒)/g) || [] : [];
            if (old.duration !== next.duration || canonical(times(old.timeline)) !== canonical(times(next.timeline)) || canonical(codes(old.prompt)) !== canonical(codes(next.prompt))) throw new Error(`Clip ${String(old.id)} 的时长/镜头时间码发生变化；默认保护 timing`);
        }
    }
}

/** A single literal span is safe only when replacing it produces exactly the requested final value. */
function exactStringEdit(field: string, before: string, after: string) {
    if (!(H3_TEXT_EDIT_FIELDS as readonly string[]).includes(field) || before === after || !before.length) return undefined;
    const old = Array.from(before), next = Array.from(after);
    let start = 0, end = 0;
    while (start < old.length && start < next.length && old[start] === next[start]) start++;
    while (end < old.length - start && end < next.length - start && old[old.length - 1 - end] === next[next.length - 1 - end]) end++;
    let left = start, right = old.length - end, nextRight = next.length - end;
    if (left === right) { if (left > 0) left--; else { right++; nextRight++; } }
    const find = old.slice(left, right).join(""), replace = next.slice(left, nextRight).join("");
    if (!find) return undefined;
    const parts = before.split(find), matches = parts.length - 1;
    if (parts.join(replace) !== after) return undefined;
    return { field, find, replace, expectedMatches: matches };
}

export function selectCompactUpdate(target: Record<string, unknown>, original: Record<string, unknown>, finalPatch: Record<string, unknown>) {
    const patch: Record<string, unknown> = {}, edits: Array<Record<string, unknown>> = [], fields: Record<string, "patch" | "edits"> = {};
    for (const [field, value] of Object.entries(finalPatch)) {
        const originalEdits = Array.isArray(original.edits) ? original.edits.filter((edit: unknown) => isRecord(edit) && String(edit.field).split("[")[0] === field) as Array<Record<string, unknown>> : [];
        const generated = typeof target[field] === "string" && typeof value === "string" ? exactStringEdit(field, target[field] as string, value) : undefined;
        const alternatives = [originalEdits, generated ? [generated] : []].filter((list) => list.length);
        alternatives.sort((a, b) => Buffer.byteLength(JSON.stringify(a)) - Buffer.byteLength(JSON.stringify(b)));
        const best = alternatives[0];
        if (best && Buffer.byteLength(JSON.stringify({ edits: best })) < Buffer.byteLength(JSON.stringify({ patch: { [field]: value } }))) { edits.push(...best); fields[field] = "edits"; }
        else { patch[field] = value; fields[field] = "patch"; }
    }
    // Existing contract caps edits per Clip; fall back to the complete validated patch, never split a transaction.
    if (edits.length > 100) return { update: { segmentId: original.segmentId, patch: finalPatch }, fields: Object.fromEntries(Object.keys(finalPatch).map((key) => [key, "patch" as const])) };
    return { update: { segmentId: original.segmentId, ...(Object.keys(patch).length ? { patch } : {}), ...(edits.length ? { edits } : {}) }, fields };
}

export function addPreparedPatchPreviews(entries: PreparedH3Plan["entries"], targets: Array<Record<string, unknown>>, candidates: Array<Record<string, unknown>>) {
    let remaining = H3_MAX_EDIT_PREVIEWS;
    return entries.map((entry, index) => {
        const previews: Array<{ field: string; before: string; after: string }> = [];
        for (const field of entry.updatedFields) {
            if (!remaining) break;
            const old = targets[index][field], next = candidates[index][field];
            const oldText = typeof old === "string" ? old : JSON.stringify(old) ?? "undefined";
            const nextText = typeof next === "string" ? next : JSON.stringify(next) ?? "undefined";
            let at = 0; while (at < oldText.length && at < nextText.length && oldText[at] === nextText[at]) at++;
            const slice = (text: string) => {
                let start = Math.max(0, at - 50), end = Math.min(text.length, start + 200);
                if (start > 0 && text.charCodeAt(start) >= 0xDC00 && text.charCodeAt(start) <= 0xDFFF) start--;
                end = Math.min(text.length, start + 200);
                if (end < text.length && text.charCodeAt(end - 1) >= 0xD800 && text.charCodeAt(end - 1) <= 0xDBFF) end--;
                return text.slice(start, end);
            };
            previews.push({ field, before: slice(oldText), after: slice(nextText) }); remaining--;
        }
        return { ...entry, changePreviews: previews, changePreviewTruncated: previews.length < entry.updatedFields.length };
    });
}
