export type PromptSourceMapEntry = {
    start: number;
    end: number;
    sourceKind: "shot" | "utterance";
    sourceId: string;
    field: "visual" | "action" | "audio" | "camera.editorial_reason" | "text";
    sourceText: string;
    sourceValue: string;
    sourceStart: number;
    sourceEnd: number;
};
export type PromptSourceMap = { version: 1; offsetUnit: "utf16"; segmentId: string; sourceHash: string; promptHash: string; entries: PromptSourceMapEntry[] };

function fail(code: string, message: string): never {
    throw Object.assign(new Error(message), { code });
}

/** Reverse one contiguous manual edit only when it falls inside one exact compiler-owned source span. */
export function reverseSyncPromptEdit(baseline: string, edited: string, sourceMap: PromptSourceMap) {
    if (edited === baseline) return { changed: false as const };
    let start = 0;
    while (start < baseline.length && start < edited.length && baseline[start] === edited[start]) start++;
    let oldEnd = baseline.length, newEnd = edited.length;
    while (oldEnd > start && newEnd > start && baseline[oldEnd - 1] === edited[newEnd - 1]) { oldEnd--; newEnd--; }

    const entries = sourceMap.entries.filter(entry => {
        if (!Number.isInteger(entry.start) || !Number.isInteger(entry.end) || entry.start < 0 || entry.end < entry.start || entry.end > baseline.length) return false;
        if (baseline.slice(entry.start, entry.end) !== entry.sourceText || entry.sourceValue.slice(entry.sourceStart, entry.sourceEnd) !== entry.sourceText) return false;
        return start === oldEnd ? entry.start <= start && start <= entry.end : entry.start <= start && oldEnd <= entry.end;
    });
    if (entries.length !== 1) fail("PROMPT_REVERSE_SYNC_AMBIGUOUS", "人工修改无法唯一定位到一个原始 Shot 或对白字段；保留画布 Prompt，未猜测回写。");
    const entry = entries[0];
    if (entry.sourceKind === "shot" && !["visual", "action", "audio", "camera.editorial_reason"].includes(entry.field)
        || entry.sourceKind === "utterance" && entry.field !== "text") {
        fail("PROMPT_REVERSE_SYNC_FIELD_UNSUPPORTED", "SourceMap 指向了不可反向同步的字段；保留人工 Prompt。");
    }
    const relativeStart = entry.sourceStart + start - entry.start, relativeEnd = entry.sourceStart + oldEnd - entry.start;
    const value = entry.sourceValue.slice(0, relativeStart) + edited.slice(start, newEnd) + entry.sourceValue.slice(relativeEnd);
    return { changed: true as const, sourceKind: entry.sourceKind, sourceId: entry.sourceId, field: entry.field, value };
}
