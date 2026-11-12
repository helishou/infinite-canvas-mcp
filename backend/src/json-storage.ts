import { brotliCompressSync, brotliDecompressSync, constants } from "node:zlib";

/** SQLite TEXT plus versioned Brotli BLOB for lossless JSON snapshots. */
export type StoredJson = string | Uint8Array;
const BROTLI_ENVELOPE = Buffer.from("ICBR1", "ascii");
/** Compress an existing JSON text verbatim into the versioned Brotli BLOB envelope. */
export function compressStoredJsonText(json: string): Uint8Array {
    const compressed = brotliCompressSync(Buffer.from(json, "utf8"), {
        params: { [constants.BROTLI_PARAM_QUALITY]: 4 },
    });
    return Buffer.concat([BROTLI_ENVELOPE, compressed]);
}

export function encodeStoredJson(value: unknown): StoredJson {
    const json = JSON.stringify(value);
    const bytes = Buffer.byteLength(json, "utf8");
    // Encoding choice only: small values avoid compression work and header overhead.
    if (bytes < 1024) return json;
    // Online writes use a single current-codec pass.
    const compressed = compressStoredJsonText(json);
    return compressed.byteLength < bytes ? compressed : json;
}

export function storedJsonText(value: unknown): string {
    if (typeof value === "string") return value;
    if (value instanceof Uint8Array) {
        const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
        try {
            if (bytes.length >= BROTLI_ENVELOPE.length && bytes.subarray(0, BROTLI_ENVELOPE.length).equals(BROTLI_ENVELOPE)) {
                return brotliDecompressSync(bytes.subarray(BROTLI_ENVELOPE.length)).toString("utf8");
            }
        } catch {
            throw new Error("Corrupt compressed JSON storage");
        }
        throw new Error("Unsupported compressed JSON storage format");
    }
    throw new Error("Unsupported JSON storage type");
}

/** Corrupt/unknown BLOBs must fail instead of becoming empty task inputs or history. */
export function decodeStoredJson<T>(value: unknown): T {
    const text = storedJsonText(value);
    try { return JSON.parse(text) as T; }
    catch { throw new Error("Stored JSON payload is invalid"); }
}
