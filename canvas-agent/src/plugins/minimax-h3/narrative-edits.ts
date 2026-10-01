/** Literal, allow-listed narrative edits. Pure: no service access or persistence. */
export const H3_NARRATIVE_FIELDS = ["prompt", "openingState", "endingState", "continuityIn", "continuityOut", "summary", "soundscape", "music", "timeline"] as const;
export const H3_TEXT_EDIT_FIELDS = [
    "prompt", "openingState", "endingState", "continuityIn", "continuityOut", "summary", "soundscape", "music",
    "timeline[].action", "timeline[].camera", "timeline[].composition", "timeline[].effects", "timeline[].description",
] as const;
export const H3_MAX_EDIT_PREVIEWS = 20;

export type H3EditSummary = {
    operationCount: number;
    matchCount: number;
    byField: Record<string, number>;
    previews: Array<{ field: string; path: string; before: string; after: string }>;
    previewTruncated: boolean;
    remainingLiteralFields: string[];
};

function record(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Keep preview snippets small; never echo the entire prompt or cut a surrogate pair. */
function snippet(value: string, index: number) {
    let start = Math.max(0, index - 60);
    if (start > 0 && value.charCodeAt(start) >= 0xDC00 && value.charCodeAt(start) <= 0xDFFF) start--;
    let end = Math.min(value.length, start + 200);
    if (end < value.length && value.charCodeAt(end - 1) >= 0xD800 && value.charCodeAt(end - 1) <= 0xDBFF) end--;
    return value.slice(start, end);
}

export function buildNarrativeEditPatch(
    target: Record<string, unknown>, rawEdits: unknown, suppliedPatch: Record<string, unknown>,
    previewBudget: { remaining: number },
): { patch: Record<string, unknown>; summary: H3EditSummary } {
    if (!Array.isArray(rawEdits) || rawEdits.length < 1 || rawEdits.length > 100) throw new Error("edits 必须包含 1–100 项精确文本替换");
    const patch: Record<string, unknown> = {};
    const summary: H3EditSummary = { operationCount: rawEdits.length, matchCount: 0, byField: {}, previews: [], previewTruncated: false, remainingLiteralFields: [] };
    for (const raw of rawEdits) {
        if (!record(raw) || Object.keys(raw).some((key) => !["field", "find", "replace", "expectedMatches"].includes(key))) throw new Error("edits 项仅允许 field/find/replace/expectedMatches");
        if (typeof raw.field !== "string" || !(H3_TEXT_EDIT_FIELDS as readonly string[]).includes(raw.field)) throw new Error(`不允许增量修改字段:${String(raw.field)}`);
        if (typeof raw.find !== "string" || !raw.find.length || typeof raw.replace !== "string") throw new Error("find 必须为非空原文字串，replace 必须为字符串");
        if (raw.find === raw.replace) throw new Error("精确替换的新旧文字相同，无有效改动");
        if (!Number.isSafeInteger(raw.expectedMatches) || Number(raw.expectedMatches) < 1) throw new Error("expectedMatches 必须为正的安全整数");
        const field = raw.field;
        const root = field.startsWith("timeline[].") ? "timeline" : field;
        if (Object.hasOwn(suppliedPatch, root)) throw new Error(`patch 与 edits 修改同一字段，存在冲突:${root}`);
        if (!Object.hasOwn(patch, root)) patch[root] = structuredClone(target[root]);
        const cells: Array<{ path: string; owner: Record<string, unknown>; key: string; value: string }> = [];
        if (root === "timeline") {
            if (!Array.isArray(patch.timeline)) throw new Error("timeline 必须为数组，不能执行该增量修改");
            const key = field.slice("timeline[].".length);
            for (let i = 0; i < patch.timeline.length; i++) {
                const row = patch.timeline[i];
                if (!record(row) || !Object.hasOwn(row, key)) continue;
                if (typeof row[key] !== "string") throw new Error(`timeline[${i}].${key} 不是字符串`);
                cells.push({ path: `timeline[${i}].${key}`, owner: row, key, value: row[key] as string });
            }
        } else {
            if (typeof patch[root] !== "string") throw new Error(`字段 ${root} 不存在或不是字符串`);
            cells.push({ path: root, owner: patch, key: root, value: patch[root] as string });
        }
        const replacements = cells.map((cell) => ({ cell, parts: cell.value.split(raw.find as string) }));
        const actual = replacements.reduce((count, item) => count + item.parts.length - 1, 0);
        if (actual !== raw.expectedMatches) throw new Error(`字段 ${field} 精确匹配次数不符：expectedMatches=${String(raw.expectedMatches)}，实际命中=${actual}`);
        summary.matchCount += actual;
        summary.byField[field] = (summary.byField[field] || 0) + actual;
        for (const { cell, parts } of replacements) {
            if (parts.length === 1) continue;
            const next = parts.join(raw.replace as string);
            cell.owner[cell.key] = next;
            if (previewBudget.remaining > 0) {
                const index = cell.value.indexOf(raw.find as string);
                summary.previews.push({ field, path: cell.path, before: snippet(cell.value, index), after: snippet(next, index) });
                previewBudget.remaining--;
            } else summary.previewTruncated = true;
        }
    }
    // Scope reminder only: remaining literals do not authorize edits to other fields or dialogue.
    const candidate = { ...target, ...suppliedPatch, ...patch };
    const needles = [...new Set(rawEdits.map((item) => (item as Record<string, unknown>).find as string))];
    for (const field of H3_TEXT_EDIT_FIELDS) {
        const values: unknown[] = field.startsWith("timeline[].")
            ? (Array.isArray(candidate.timeline) ? candidate.timeline.map((row) => record(row) ? row[field.slice("timeline[].".length)] : undefined) : [])
            : [candidate[field]];
        if (values.some((value) => typeof value === "string" && needles.some((needle) => value.includes(needle)))) summary.remainingLiteralFields.push(field);
    }
    return { patch, summary };
}

export function projectNarrativeFields(segment: Record<string, unknown>, rawFields: unknown) {
    if (!Array.isArray(rawFields) || rawFields.length < 1 || rawFields.length > H3_NARRATIVE_FIELDS.length || new Set(rawFields).size !== rawFields.length) throw new Error("fields 必须为非空、无重复的叙事字段数组");
    const fields: Record<string, unknown> = {};
    const missingFields: string[] = [];
    for (const field of rawFields) {
        if (typeof field !== "string" || !(H3_NARRATIVE_FIELDS as readonly string[]).includes(field)) throw new Error(`不支持读取字段:${String(field)}`);
        if (!Object.hasOwn(segment, field) || segment[field] === undefined) missingFields.push(field);
        else fields[field] = structuredClone(segment[field]);
    }
    return { fields, ...(missingFields.length ? { missingFields } : {}) };
}
