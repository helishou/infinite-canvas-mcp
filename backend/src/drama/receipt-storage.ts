/**
 * 回执在库中的编码（receipt_json 的压缩存储）。
 *
 * 背景（实测）：`episode_production_operations` 每行存一份完整 ProductionRecord 快照，
 * 2323 行 ≈ 4.4 GB。拆开三个主要分集的 2095 行（4.39 GB）后，体积分布是：
 *   draft.source 18.7% / published.source 18.0% / draft.workflow 17.3%
 *   draft.artifacts 14.4% / published.artifacts 13.8% / published.workflow 6.4%
 * 即体积来自「快照本身」，不是某个可去重的重复块——所以 `dedupReceipt` 的 `$ref`
 * 换不来空间，按年龄删行也换不来（陈旧行持有别处不存在的 published 快照）。
 *
 * 正确的修法是改存储形态而不是加保留策略：回执是**幂等重放缓存，不是业务事实源**
 * （事实在 episode_productions / episode_production_versions）。对它做无损压缩即可，
 * 决策成本为零——不丢任何数据，也就不需要判断「哪份快照还能删」。
 *
 * 实测（数据库里 receipt_json 的 UTF-8 字节口径）：
 *   迁移前 2324 行，5,176,506,065 bytes → gzip 后 827,373,213 bytes；
 *   其中 2323 行本次压缩、1 行原来已经是 gzip BLOB，逐行对照备份 0 差异。
 *   SQLite LENGTH(TEXT) 统计的是字符数（当时约 4.44 GB），不能拿它当 UTF-8 字节总量；
 *   真实节省 4.35 GB，逻辑空间剩 827 MB，随后 VACUUM 将 runtime.sqlite 从 6.08 GB 缩至 1.72 GB。
 *
 * 兼容性：历史行保持 TEXT 明文，新写入为 BLOB(gzip)。两种形态在库中共存，
 * 由 `decodeReceipt` 按类型分派，无需 schema 迁移，也无需一次性抹平历史。
 * （SQLite 的 TEXT 亲和性不会把 BLOB 转成字符串，写入 Buffer 读回即 Uint8Array。）
 */
import { gzipSync, gunzipSync } from "node:zlib";

/** 库中实际存的值：历史写明文 TEXT，新写入为 gzip BLOB。 */
export type StoredReceipt = string | Uint8Array;

/** 序列化为 gzip BLOB（当前写入形态）。 */
export function encodeReceipt(value: unknown): Uint8Array {
    return gzipSync(Buffer.from(JSON.stringify(value), "utf8"));
}

/** 按存储类型解码：TEXT → 明文 JSON；BLOB → gunzip 后 JSON。解压失败即真损坏，直接抛。 */
export function decodeReceipt<T = unknown>(stored: StoredReceipt): T {
    if (typeof stored === "string") return JSON.parse(stored) as T;
    if (stored instanceof Uint8Array) return JSON.parse(gunzipSync(Buffer.from(stored)).toString("utf8")) as T;
    throw new Error("回执存储类型不受支持");
}

/** 回执占用的字节数，用于迁移前后对账（与 SQLite LENGTH() 的字符数口径不同，按字节算）。 */
export function receiptBytes(stored: StoredReceipt): number {
    return typeof stored === "string" ? Buffer.byteLength(stored, "utf8") : stored.byteLength;
}
