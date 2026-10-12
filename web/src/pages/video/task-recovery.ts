/** A query error says nothing about the provider's terminal state. Legacy failed
 * receipts have no such evidence and must be queried before offering a new run. */
export type RecoverableVideoLog = { status: string; task?: { id: string }; video?: unknown; terminalConfirmed?: boolean; queryError?: string; submissionUnknown?: boolean };
export function videoNeedsVerification(log: RecoverableVideoLog) {
    return !log.video && (Boolean(log.submissionUnknown) || Boolean(log.task && !log.terminalConfirmed && (log.status === 'failed' || log.queryError)));
}
export class VideoTerminalFailure extends Error {}
export async function observeVideoTask<T>(options: {
    poll: () => Promise<{ status: 'pending' } | { status: 'failed'; error: string } | { status: 'completed'; result: T }>;
    signal: AbortSignal; wait: () => Promise<unknown>; timeoutMessage: string; attempts?: number;
}) {
    for (let attempt = 0; attempt < (options.attempts ?? 120); attempt++) {
        options.signal.throwIfAborted();
        const state = await options.poll();
        options.signal.throwIfAborted();
        if (state.status === 'completed') return state.result;
        if (state.status === 'failed') throw new VideoTerminalFailure(state.error);
        if (attempt === (options.attempts ?? 120) - 1) throw new Error(options.timeoutMessage);
        await options.wait();
    }
    throw new Error(options.timeoutMessage);
}

export function videoEndpoint(address: string) {
    try { const url = new URL(address); return url.origin + url.pathname; } catch { return ""; }
}
