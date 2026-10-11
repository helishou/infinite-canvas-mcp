const inFlightRequests = new Map<string, Promise<unknown>>();

/** Share only an identical request while it is in flight; settled results are never cached. */
export function coalesceInFlightRequest<T>(key: string, start: () => Promise<T>): Promise<T> {
    const existing = inFlightRequests.get(key);
    if (existing) return existing as Promise<T>;

    let shared!: Promise<T>;
    try {
        shared = Promise.resolve(start()).finally(() => {
            if (inFlightRequests.get(key) === shared) inFlightRequests.delete(key);
        });
    } catch (error) {
        shared = Promise.reject(error).finally(() => {
            if (inFlightRequests.get(key) === shared) inFlightRequests.delete(key);
        });
    }
    inFlightRequests.set(key, shared);
    return shared;
}
