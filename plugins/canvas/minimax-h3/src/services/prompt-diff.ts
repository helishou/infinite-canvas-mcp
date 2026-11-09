/**
 * 画布 Prompt 与导演基线（productionClipProjection.nextValues.prompt）的行级差异。
 * 左右两侧分别代表「当前画布」与「导演基线」，只做展示，不改动任何持久数据。
 */
export type PromptDiffLine =
    | { kind: "same" | "removed" | "added"; text: string }
    | { kind: "gap"; count: number };

/** 行对齐按 LCS 计算；超出这个规模时退化为整体替换，避免为超长 Prompt 建大表。 */
const MAX_ALIGN_CELLS = 250_000;

function normalizeLines(text: string) {
    return String(text ?? "").replace(/\r\n?/g, "\n").replace(/\n+$/, "").split("\n");
}

export function diffPromptLines(current: string, director: string, context = 2): PromptDiffLine[] {
    const left = normalizeLines(current), right = normalizeLines(director);
    const n = left.length, m = right.length;
    if (!n && !m) return [];
    const raw: PromptDiffLine[] = [];
    if (n * m > MAX_ALIGN_CELLS) {
        for (const text of left) raw.push({ kind: "removed", text });
        for (const text of right) raw.push({ kind: "added", text });
    } else {
        const table: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
        for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
            table[i][j] = left[i] === right[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
        let i = 0, j = 0;
        while (i < n && j < m) {
            if (left[i] === right[j]) { raw.push({ kind: "same", text: left[i] }); i++; j++; }
            else if (table[i + 1][j] >= table[i][j + 1]) raw.push({ kind: "removed", text: left[i++] });
            else raw.push({ kind: "added", text: right[j++] });
        }
        while (i < n) raw.push({ kind: "removed", text: left[i++] });
        while (j < m) raw.push({ kind: "added", text: right[j++] });
    }
    if (!raw.some((line) => line.kind !== "same")) return [];
    // 折叠较长的相同片段，让窄侧栏里只剩真正改动的行。
    const keep = new Set<number>();
    raw.forEach((line, index) => {
        if (line.kind === "same") return;
        for (let offset = Math.max(0, index - context); offset <= Math.min(raw.length - 1, index + context); offset++) keep.add(offset);
    });
    const lines: PromptDiffLine[] = [];
    for (let index = 0; index < raw.length; index++) {
        if (keep.has(index)) { lines.push(raw[index]); continue; }
        let end = index;
        while (end < raw.length && !keep.has(end)) end++;
        lines.push({ kind: "gap", count: end - index });
        index = end - 1;
    }
    return lines;
}
