/**
 * 从执行引擎 `comfyui2api/src/runtime/redact-inline-media.ts` 落地到画布的类型/纯函数副本。
 * 目的：画布不再 import 引擎 npm 包，双方只通过 HTTP 通信。
 * 同步方式：引擎侧该文件改动时，这里需要手工同步（内容已冻结，不含 I/O）。
 */
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
