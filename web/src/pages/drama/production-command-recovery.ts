export type CommandRecoveryRecord = { status: "unknown" | "rejected"; httpStatus?: number; errorCode?: string; error?: string };

/** Rejected validation input is finished; only conflicts or unknown outcomes lock writes. */
export function commandNeedsRecovery(command: CommandRecoveryRecord | null | undefined): boolean {
    if (!command) return false;
    if (command.status === "unknown") return true;
    if (command.errorCode === "REVISION_CONFLICT" || command.errorCode === "IDEMPOTENCY_CONFLICT") return true;
    // Earlier persisted drafts only recorded the HTTP status in the error text.
    const status = command.httpStatus ?? Number(command.error?.match(/\bHTTP\s+(\d{3})\b/)?.[1] || 0);
    if (status === 409 || status === 408) return true;
    if (status >= 400 && status < 500) return false;
    return true;
}
