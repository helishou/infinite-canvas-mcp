/** Current receipt format is exclusively an ICBR1 Brotli BLOB. */
import { compressStoredJsonText, decodeStoredJson } from "../json-storage.js";

export type StoredReceipt = Uint8Array;

export function encodeReceipt(value: unknown): Uint8Array {
    const json = JSON.stringify(value);
    if (typeof json !== "string") throw new Error("Receipt value is not JSON serializable");
    return compressStoredJsonText(json);
}

export function decodeReceipt<T = unknown>(stored: unknown): T {
    if (!(stored instanceof Uint8Array)) throw new Error("Unsupported receipt storage type");
    return decodeStoredJson<T>(stored);
}

export function receiptBytes(stored: StoredReceipt): number { return stored.byteLength; }
