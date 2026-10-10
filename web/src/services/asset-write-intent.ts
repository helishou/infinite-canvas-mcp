type Cache = { getItem<T>(key: string): Promise<T | null>; setItem<T>(key: string, value: T): Promise<T>; removeItem(key: string): Promise<void> };
type Pending = { body: Record<string, unknown>; method: "POST" | "PATCH"; path: string };

/** A single unresolved request, not a background retry queue. Recover its exact receipt first. */
export async function writeAssetIntent<T>(cache: Cache, key: string, intent: Pending, send: (intent: Pending) => Promise<T>, restoredMessage: string): Promise<T> {
    const pending = await cache.getItem<Pending>(key);
    const request = pending || intent;
    if (!pending) await cache.setItem(key, intent);
    try {
        const response = await send(request);
        await cache.removeItem(key);
        if (pending && JSON.stringify({ ...pending.body, operationId: undefined, id: undefined, createdAt: undefined, updatedAt: undefined }) !== JSON.stringify({ ...intent.body, operationId: undefined, id: undefined, createdAt: undefined, updatedAt: undefined })) throw new Error(restoredMessage);
        return response;
    } catch (error) {
        const status = (error as { status?: number }).status;
        // Deterministic rejection ends this request. UI/local canvas intent remains available for correction.
        if (status && status >= 400 && status < 500) await cache.removeItem(key);
        throw error;
    }
}
