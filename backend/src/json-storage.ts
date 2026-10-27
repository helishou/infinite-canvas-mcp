import { gzipSync, gunzipSync } from "node:zlib";

/** SQLite TEXT for small/legacy JSON, gzip BLOB for compressible snapshots. */
export type StoredJson = string | Uint8Array;

export function encodeStoredJson(value: unknown): StoredJson {
    const json = JSON.stringify(value);
    const bytes = Buffer.byteLength(json, "utf8");
    // Encoding choice only: small values avoid compression work and header overhead.
    if (bytes < 1024) return json;
    const compressed = gzipSync(Buffer.from(json, "utf8"));
    return compressed.byteLength < bytes ? compressed : json;
}

export function storedJsonText(value: unknown): string {
    if (typeof value === "string") return value;
    if (value instanceof Uint8Array) return gunzipSync(value).toString("utf8");
    throw new Error("Unsupported JSON storage type");
}

/** Corrupt/unknown BLOBs must fail instead of becoming empty task inputs or history. */
export function decodeStoredJson<T>(value: unknown): T {
    return JSON.parse(storedJsonText(value)) as T;
}
