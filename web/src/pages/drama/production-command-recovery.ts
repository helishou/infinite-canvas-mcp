export type CommandRecoveryRecord = { status: "unknown" | "rejected"; httpStatus?: number; errorCode?: string; error?: string; errorSummary?: string };

function commandHttpStatus(command: CommandRecoveryRecord): number {
    // Earlier persisted drafts only recorded the HTTP status in the error text.
    return command.httpStatus ?? Number(command.error?.match(/\bHTTP\s+(\d{3})\b/)?.[1] || 0);
}

/** An unsupported endpoint did not execute the command; other 5xx outcomes remain unknown. */
export function commandFailureStatus(httpStatus: number): CommandRecoveryRecord["status"] {
    return (httpStatus >= 400 && httpStatus < 500 && httpStatus !== 408) || httpStatus === 501 ? "rejected" : "unknown";
}

/** Normalize only confirmed rejections; an old unknown 501 does not prove it was the first attempt. */
export function normalizeCommandRecovery<T extends CommandRecoveryRecord>(command: T): T {
    return command.status === "rejected" && commandHttpStatus(command) === 501 ? { ...command, httpStatus: 501 } : command;
}

/** A failed recovery cannot establish that the original unknown submission never committed. */
export function commandFailureRecord<T extends CommandRecoveryRecord>(command: T, failure: { httpStatus: number; error: string; errorCode?: string; errorSummary?: string }, recovering: boolean): T {
    if (recovering && command.status === "unknown" && failure.httpStatus === 501) {
        return { ...command, status: "unknown", httpStatus: command.httpStatus ?? 0,
            error: [command.error, failure.error].filter(Boolean).join("\n"), errorSummary: commandErrorSummary(failure) };
    }
    return { ...command, ...failure, status: commandFailureStatus(failure.httpStatus) };
}

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
    const status = commandHttpStatus(command);
    if (command.status === "unknown") return true;
    if (status === 501) return false;
    if (status === 409 || status === 408) return true;
    if (status >= 400 && status < 500) return false;
    // 5xx 或完全未知：请求可能已到达，保留原请求。
    return true;
}

/** Show the server's useful explanation; transport routes remain available in technical details. */
export function commandErrorSummary(command: Pick<CommandRecoveryRecord, "error" | "errorSummary">): string {
    if (command.errorSummary?.trim()) return command.errorSummary.trim();
    const error = command.error || "";
    const http = error.match(/^Backend\s+\S+\s+.+?\s+failed:\s+HTTP\s+\d{3}\s*([\s\S]*)$/);
    if (http) return http[1].trim();
    if (/^无法连接 Backend[：:]/.test(error)) return "";
    return error;
}
