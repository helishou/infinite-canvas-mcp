/**
 * 「同时生成数」从旧三池对象迁移到影策单值的收敛规则。
 * 旧设置取三值里的最小值，避免把用户当时给任何一池设过的并发上限放大。
 */
export function resolveConcurrency(raw: unknown, fallback: number): number {
    let value: number;
    if (raw && typeof raw === "object") {
        const parts = raw as Record<string, unknown>;
        const candidates = [parts.text, parts.video, parts.assemble]
            .map((part) => Number(part)).filter((part) => Number.isFinite(part) && part > 0);
        value = candidates.length ? Math.min(...candidates) : fallback;
    } else {
        value = Number(raw);
    }
    return Number.isFinite(value) && value > 0 ? Math.max(1, Math.min(16, Math.floor(value))) : fallback;
}
