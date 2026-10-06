import type { ProductionRecord } from "./production.js";

/**
 * Receipt 去重：receipt_json 是幂等重放缓存，不是业务事实源。
 * 写入时把与 draft 侧 JSON 序列化完全一致的 published.director / published.shots
 * 替换为 { "$ref": "<path>" }，读取时透明展开，调用方拿到的仍是完整 ProductionRecord。
 *
 * 设计：docs/receipt-dedup-design.md（GPT 审核 9.5/10）。
 * - 引用值用对象 { "$ref" } 而非裸字符串，避免业务字段类型从 Director 变成 string。
 * - 标记字段 __receiptDedupV1 带版本前缀，避免未来 schema 合法出现 _receiptDedup。
 * - 只白名单引用 director / shots 两个实测重复的大块，不抽象成通用 JSONPath resolver。
 * - 阈值 10KB 是工程阈值（当前最小重复块 ~476KB），非业务约束。
 * - 展开时 draft 侧路径缺失 → 抛 CorruptReceiptError，不静默 fallback。
 */

const DEDUP_MARKER = "__receiptDedupV1" as const;
const DEDUP_THRESHOLD_BYTES = 10 * 1024;
const DEDUP_TARGETS = ["director", "shots"] as const;

type DedupField = (typeof DEDUP_TARGETS)[number];
type DedupMarker = Record<string, string>;

export class CorruptReceiptError extends Error {
    constructor(field: string, reason: string) {
        super(`receipt 去重损坏：${field} ${reason}`);
        this.name = "CorruptReceiptError";
    }
}

function pathValue(obj: Record<string, unknown>, field: string): unknown {
    return obj[field];
}

function hasPath(obj: Record<string, unknown> | null | undefined, field: string): boolean {
    return !!obj && Object.prototype.hasOwnProperty.call(obj, field);
}

function makeRef(field: DedupField): { $ref: string } {
    return { $ref: `draft.${field}` };
}

function isRef(value: unknown): value is { $ref: string } {
    return !!value && typeof value === "object" && !Array.isArray(value)
        && typeof (value as { $ref?: unknown }).$ref === "string";
}

/**
 * 写入前：把 published 侧与 draft 侧 JSON 序列化完全一致且 > 阈值的字段替换为 $ref。
 * 返回浅拷贝，不污染入参。无重复时原样返回（不含标记）。
 */
export function dedupReceipt(record: ProductionRecord): ProductionRecord {
    const published = record.published;
    if (!published) return record;

    const draft = record.draft as Record<string, unknown>;
    const pub: Record<string, unknown> = { ...published }; // 先拷贝，避免污染入参
    const marker: DedupMarker = {};
    let changed = false;

    for (const field of DEDUP_TARGETS) {
        if (!hasPath(draft, field)) continue;
        if (!hasPath(pub, field)) continue;
        const draftValue = draft[field];
        const pubValue = pub[field];
        if (isRef(pubValue)) continue; // 已是引用
        const draftJson = JSON.stringify(draftValue);
        const pubJson = JSON.stringify(pubValue);
        if (draftJson !== pubJson) continue;
        if (draftJson.length < DEDUP_THRESHOLD_BYTES) continue;
        pub[field] = makeRef(field);
        marker[`published.${field}`] = `draft.${field}`;
        changed = true;
    }

    if (!changed) return record;
    const next: ProductionRecord = { ...record, published: pub as typeof record.published };
    (next as Record<string, unknown>)[DEDUP_MARKER] = marker;
    return next;
}

/**
 * 读取后：把 $ref 展开回 draft 侧的真实值，删除标记。
 * 无标记 → 原样返回（幂等/no-op）。draft 侧路径缺失 → 抛 CorruptReceiptError。
 * 返回浅拷贝，不污染入参。
 */
export function resolveReceiptDedup(record: ProductionRecord): ProductionRecord {
    const raw = record as Record<string, unknown>;
    const marker = raw[DEDUP_MARKER];
    if (!marker || typeof marker !== "object" || Array.isArray(marker)) return record;

    const published = record.published;
    if (!published) {
        // 有标记但 published 为 null：数据不一致
        throw new CorruptReceiptError(DEDUP_MARKER, "存在标记但 published 为 null");
    }
    const draft = record.draft as Record<string, unknown>;
    const pub = { ...published } as Record<string, unknown>;

    for (const [pubPath, draftPath] of Object.entries(marker)) {
        // pubPath = "published.<field>", draftPath = "draft.<field>"
        const pubField = pubPath.split(".").pop() as string;
        const draftField = draftPath.split(".").pop() as string;
        if (!hasPath(draft, draftField)) {
            throw new CorruptReceiptError(pubPath, `draft.${draftField} 不存在，无法展开`);
        }
        pub[pubField] = draft[draftField];
    }

    const next: Record<string, unknown> = { ...raw, published: pub };
    delete next[DEDUP_MARKER];
    return next as ProductionRecord;
}

/**
 * API 返回前防线：含标记的 record 不应外泄。
 */
export function assertPublicReceipt(record: ProductionRecord): void {
    if (DEDUP_MARKER in (record as Record<string, unknown>)) {
        throw new Error("receipt 含未展开的去重标记，禁止对外返回");
    }
}

export const RECEIPT_DEDUP_MARKER = DEDUP_MARKER;
export const RECEIPT_DEDUP_THRESHOLD_BYTES = DEDUP_THRESHOLD_BYTES;
export const RECEIPT_DEDUP_TARGETS = DEDUP_TARGETS;
