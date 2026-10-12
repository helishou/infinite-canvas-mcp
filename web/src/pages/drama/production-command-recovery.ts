export type CommandRecoveryRecord = { status: "unknown" | "rejected"; httpStatus?: number; errorCode?: string; error?: string };

/**
 * 只有「请求可能已送达服务器、但回执丢失」时才需要恢复保护。
 *
 * 明确的终局结果绝不该占用提交态：
 * - `status === 0`：连不上 Backend，请求根本没送达，是确定的失败。
 * - 4xx（除 408）：服务器明确拒绝，输入有问题，重试同一条不会变。
 * - 408 / 5xx / 网络中断：无法判断是否已写入，必须保留原请求以便幂等重试。
 */
export function commandNeedsRecovery(command: CommandRecoveryRecord | null | undefined): boolean {
    if (!command) return false;
    if (command.errorCode === "REVISION_CONFLICT" || command.errorCode === "IDEMPOTENCY_CONFLICT") return true;
    // Earlier persisted drafts only recorded the HTTP status in the error text.
    const status = command.httpStatus ?? Number(command.error?.match(/\bHTTP\s+(\d{3})\b/)?.[1] || 0);
    // 连不上服务器（0）与明确的 4xx 拒绝都是终局失败，不锁提交态。
    if (status === 0) return false;
    if (status === 408 || status === 409) return true;
    if (status >= 400 && status < 500) return false;
    // 5xx 或完全未知：请求可能已到达，保留原请求。
    return true;
}
