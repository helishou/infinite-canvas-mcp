/**
 * diagnostics 表格的排序比较器。
 *
 * 缺失值（null / undefined / NaN）统一排到末尾，且不随升降序翻转：
 * 「未采集」的行如果跟着排序翻到榜首，就会把真正最大的耗时/返回体挤出视野。
 */

export type SortOrder = "ascend" | "descend" | null | undefined;

const toNumber = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

/** 缺失值判定：`null` / `undefined` / `NaN` / 空字符串。 */
export const isMissing = (value: unknown): boolean => (typeof value === "string" ? value === "" : toNumber(value) == null);

/** 缺失值恒在末尾；两端都缺失视为相等。 */
export function compareByNumber(a: unknown, b: unknown): number {
    const left = toNumber(a);
    const right = toNumber(b);
    if (left == null && right == null) return 0;
    if (left == null) return 1;
    if (right == null) return -1;
    return left - right;
}

/** 生成 antd `sorter` 用的比较器：降序只翻转「两个有效数值之间」的顺序，缺失值仍留在末尾。 */
export function numberSorter(order: SortOrder) {
    return (a: unknown, b: unknown) => {
        const result = compareByNumber(a, b);
        // 不能直接对结果取负：compareByNumber 用 +1/-1 表示「缺失排在后面」，
        // 取负会让缺失行在降序时跳到最前面，正好把最大的耗时/返回体藏起来。
        if (order !== "descend" || result === 0 || toNumber(a) == null || toNumber(b) == null) return result;
        return -result;
    };
}

/**
 * 工具名等中文列的两参比较：升序语义。缺失值恒在末尾。
 * 注意：不能直接交给 antd 的 `sorter`，因为 antd 降序时会对结果取反，
 * 缺失行会被翻到最前面。表格统一用 `sorter: true` + `sortRows` 自行排序。
 */
export const stringSorter = (a: unknown, b: unknown) => {
    const leftMissing = a == null || a === "";
    const rightMissing = b == null || b === "";
    if (leftMissing || rightMissing) {
        if (leftMissing && rightMissing) return 0;
        return leftMissing ? 1 : -1;
    }
    return String(a).localeCompare(String(b), "zh-Hans-CN");
};

/**
 * 按列自行排序：升序用比较器原序，降序只翻转「两端都是有效值」的情况，
 * 缺失值始终留在末尾。`order` 为 null/undefined 时保持原顺序。
 */
export function sortRows<T>(rows: T[], key: string | null, order: SortOrder, compare: (a: unknown, b: unknown) => number): T[] {
    if (!key || !order) return rows;
    return [...rows].sort((a, b) => {
        const result = compare((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]);
        if (order !== "descend" || result === 0 || isMissing((a as Record<string, unknown>)[key]) || isMissing((b as Record<string, unknown>)[key])) return result;
        return -result;
    });
}
