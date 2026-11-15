/** 持久化边界统一使用：内联媒体只允许在执行内存中存在，不能写入任务/日志。 */
export function redactInlineMedia<T>(value: T): T {
    if (typeof value === "string") {
        const match = /^data:([^;,]+);base64,/i.exec(value);
        return (match ? `[inline-media:${match[1]}]` : value) as T;
    }
    if (Array.isArray(value)) return value.map((item) => redactInlineMedia(item)) as T;
    if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, redactInlineMedia(item)])) as T;
    }
    return value;
}
