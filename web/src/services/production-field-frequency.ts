import localforage from "localforage";

type FieldFrequency = Record<string, number>;

const storage = localforage.createInstance({ name: "infinite-canvas", storeName: "production_field_frequency" });
const storageKey = "shot-field-counts-v1";
let writeQueue: Promise<void> = Promise.resolve();

function validFieldPath(path: string) {
    return /^[a-zA-Z0-9_.*-]{1,120}$/.test(path) && !["__proto__", "constructor", "prototype"].includes(path);
}

/** Persist only aggregate field counts locally; never store values or object IDs. */
export function recordProductionShotFieldChanges(fieldPaths: string[]) {
    const fields = [...new Set(fieldPaths.filter(validFieldPath))];
    if (!fields.length) return Promise.resolve();

    const write = writeQueue.then(async () => {
        const counts = (await storage.getItem<FieldFrequency>(storageKey)) || {};
        for (const field of fields) {
            const current = Number.isSafeInteger(counts[field]) && counts[field] > 0 ? counts[field] : 0;
            counts[field] = Math.min(Number.MAX_SAFE_INTEGER, current + 1);
        }
        await storage.setItem(storageKey, counts);
    });
    writeQueue = write.catch(() => undefined);
    return write.catch(() => undefined);
}

/** Read the browser-local aggregate for diagnostics or a future local report. */
export async function getProductionShotFieldFrequency(): Promise<FieldFrequency> {
    await writeQueue;
    try {
        return (await storage.getItem<FieldFrequency>(storageKey)) || {};
    } catch {
        return {};
    }
}
