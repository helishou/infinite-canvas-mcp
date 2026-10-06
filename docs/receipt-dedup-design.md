# episode_production_operations receipt 去重设计

> 状态：**已实施（2026-10-06）**。
> 代码提交 `16df354c`（模块 + 测试 + 迁移脚本 + 本设计稿）。
> `production.ts` 3 处调用点 + `package.json` 注册因混入 Acheng WIP 未独立提交。
> 生产库已迁移：144 行去重，省 28.95MB；VACUUM 后 607.1→574.0MB（释放 33.1MB）。
> backend 已用新代码重启（dist 重建）。integrity ok，FK 0。
> GPT 审核（2026-10-06）：8.5/10，按 6 条修正后 9.5/10 可安全上线。
> 修正：`__receiptDedupV1` 带版本、`$ref` 对象格式、missing path 抛错、迁移事务内、API assert、adoptSharedAsset 不改。
> 基于 2026-10-06 生产库**实测**（非推断）：269 行、207.11MB receipt。
> `published.director` 和 `draft.director` 在 73 行 JSON 序列化相同（无阈值）；
> `published.shots`（顶层）和 `draft.shots` 在 197 行相同（无阈值）。
> **迁移脚本实测**（>10KB 阈值）：144 行可去重，省 **28.95MB**，全通过 deepEqual 验证。

## 1. 现状（实测）

### 1.1 receipt 结构

`production.ts:1917-1918`（`commit()` :1879）写入：`JSON.stringify(next)`，
`next` 是完整 `ProductionRecord`：

```
{
  episodeId, revision, publishedVersion, updatedAt,
  impact, referenceSync,
  draft:     { director: {schemaVersion,engine,source,sourceHash,modules,
                          artifacts,assets,shotInputs,boundaries,...},
               scenes, shots, keyframes, keyframeReviews,
               clipGroups, settings, legacyImports },
  published: { 同 draft 结构 }
}
```

### 1.2 实测重复（逐字节比较 269 行）

| 比较字段 | 相同行数 | 省 |
|---|---:|---:|
| `draft.director` ↔ `published.director` | 73 | 13.55 MB |
| `draft.shots`（顶层）↔ `published.shots`（顶层） | 197 | 13.19 MB |
| **合计** | **230 行** | **26.74 MB** |

- `published` 未 publish 时为 `null`（不去重）。
- publish 后 `published.director` 通常与 `draft.director` 相同（刚发布）。
- `draft.director` 含 `source`(865KB)、`artifacts`(853KB) 等大字段，整块 ~1.74MB。
- `shots` 在**顶层** `draft.shots`（476KB），**不在** `draft.director.shots`
  （后者是 `null`）。这是本设计第一版错误，已按实测修正。

### 1.3 读取点（实测，3 处）

| 位置 | 方法 | 实际用途 |
|---|---|---|
| `production.ts:452` | `adoptSharedAsset` | parse 后**只提取** `draft.director.assets[assetId].nodeId`，再调 `this.edit()` 重新从 `episode_productions` 读。**不直接返回 receipt** |
| `production.ts:503` | `operationReceipt` | `JSON.parse(receipt_json)` → 返回完整 `ProductionRecord` |
| `production.ts:1879` | `commit()` | 幂等重放（:1887）：`JSON.parse` → 返回完整 `ProductionRecord & {replayed:true}` |

**真正返回完整 `ProductionRecord` 的只有 2 处**（`operationReceipt`、`commit`）；
`adoptSharedAsset` 只取 nodeId。下游业务读取（`selectDirectorResult`、
`getContinuity`、`get()` 等）全在 `episode_productions.draft_json/published_json`，
**不读 receipt**。receipt 只承担幂等重放"上次这个 operationId 的完整响应"。

## 2. 设计

### 2.1 原则

- **不改读取合同**：receipt parse 后仍是完整 `ProductionRecord`，下游无感知
- **整块引用去重**：`published.director` 和 `published.shots` 与 draft 侧
  逐字节相同时，published 侧改存引用标记，不存第二份
- **写入时去重、读取时透明展开**：调用方拿到的 `ProductionRecord` 完整一致
- **不裁字段**：所有业务字段完整保留，只是大字段不存两份
- **幂等**：展开函数对已展开/无引用标记的 receipt 是 no-op
- **可回滚**：去重后仍是合法 JSON；展开后与原始 `deepEqual`

### 2.2 去重格式

写入时，`published.director` 和 `draft.director` 的 JSON 序列化结果完全一致（且 > 阈值）→ 替换：

```json
{
  "draft":     { "director": { ...完整... }, "shots": [ ...完整... ], ... },
  "published": { "director": { "$ref": "draft.director" },
                 "shots":    { "$ref": "draft.shots" }, ... },
  "__receiptDedupV1": { "published.director": "draft.director",
                        "published.shots":    "draft.shots" }
}
```

- 引用值格式：`{ "$ref": "<JSONPath>" }` 对象（不是裸字符串，避免业务字段类型从 `Director` 变成 `string`）
- 只整块引用 `director` 和 `shots` 两个大块（白名单 `DEDUP_TARGETS`，不抽象成通用 JSONPath resolver）
- `__receiptDedupV1`（带版本前缀，避免未来 schema 合法出现 `_receiptDedup`）记录引用清单，返回前删除
- 阈值：整块 > 10KB 才引用（工程阈值，非业务约束；当前最小重复块 ~476KB）

### 2.3 写入路径（1 处）

`production.ts:1917-1918`（`commit()` :1879）：

```ts
// 原：
this.prepare("INSERT INTO ...").run(operationId, episodeId, requestHash, JSON.stringify(next), next.updatedAt);
// 改：
this.prepare("INSERT INTO ...").run(operationId, episodeId, requestHash, JSON.stringify(dedupReceipt(next)), next.updatedAt);
```

`dedupReceipt(record): ProductionRecord`：
1. `record.published` 为 null → 原样返回
2. `JSON.stringify(record.draft.director) === JSON.stringify(record.published.director)` 且 > 10KB
   → `published.director = { "$ref": "draft.director" }`，记入 `__receiptDedupV1`
3. `JSON.stringify(record.draft.shots) === JSON.stringify(record.published.shots)` 且 > 10KB
   → `published.shots = { "$ref": "draft.shots" }`，记入 `__receiptDedupV1`
4. 无引用 → 不加工 `__receiptDedupV1`
5. 返回（浅拷贝，不污染原 `next`）

### 2.4 读取路径（2 处返回完整对象 + 1 处取字段）

`operationReceipt`（:503-507）和 `commit()`（:1887 幂等重放）：

```ts
// 原：
return JSON.parse(row.receipt_json);
// 改：
return resolveReceiptDedup(JSON.parse(row.receipt_json));
```

`adoptSharedAsset`（:452-458）取 `draft.director.assets`：
- 去重只动 `published` 侧，`draft` 侧完整保留，**无需改**（nodeId 从 draft 读）。
- 不包 `resolveReceiptDedup`（只读 draft，不碰 published；避免大 receipt 展开的无谓开销）。

`resolveReceiptDedup(record): ProductionRecord`：
1. 无 `__receiptDedupV1` → 原样返回（幂等/no-op）
2. 遍历 `__receiptDedupV1` 每条目，取 `<path>`
3. 从 draft 侧取同路径值；**若 draft 侧该路径不存在 → 抛 `CorruptReceiptError`**（receipt 是幂等数据，不静默容忍损坏）
4. 赋给 published 侧对应位置
5. 删除 `__receiptDedupV1`
6. 返回完整 `ProductionRecord`

### 2.5 迁移

`backend/src/maintenance/dedup-production-receipts.ts`：

1. 独立副本上 `BEGIN IMMEDIATE` 遍历 269 行：`original = JSON.parse` → `compressed = dedupReceipt(original)` → 有 `__receiptDedupV1` 才 `UPDATE`
2. 验证：每个去重行 `expanded = resolveReceiptDedup(compressed)` → `assert deepEqual(expanded, original)`
3. 迁移前后统计：`count(*)`、`sum(length(receipt_json))`、`count(receipt_json LIKE '%__receiptDedupV1%')`，确认 230 行
4. 副本上确认省 26.74MB
5. 生产库：`VACUUM INTO` 备份 → 事务内迁移 → `VACUUM` 回收

### 2.6 不动的部分

- `episode_productions.draft_json/published_json`：不动（业务读取全在这）
- `episode_production_versions.snapshot_json`：不动
- `canvas_command_receipts` / `production_preparations.receipt_json`：不动
- 下游业务代码（`selectDirectorResult`/`getContinuity`/`get()`）：不改
- API 响应：不变（`resolveReceiptDedup` 透明展开，`__receiptDedupV1` 已删）
- **API 返回前 assert**：`assertPublicReceipt(record)` — 若含 `__receiptDedupV1` 则抛错，防未来有人忘记 resolve

## 3. 风险与边界

| 风险 | 应对 |
|---|---|
| 某些行 `director` 相同但 `shots` 不同（或反之） | 两块独立判断，各自引用，互不影响（实测 73 vs 197） |
| 未来 publish 后 `director` 与 draft 不同 | `dedupReceipt` 只在逐字节相同时才引用；否则原样存 |
| `__receiptDedupV1` 泄露到 API | `resolveReceiptDedup` 返回前删除；API 返回前 `assertPublicReceipt` 防泄漏 |
| 新旧 receipt 混存 | 两者都是合法 JSON；`resolveReceiptDedup` 对无标记行 no-op |
| 引用路径写死 `draft.director`/`draft.shots` | 只整块引用这两个实测重复的大块；其他字段不动 |
| 展开时 draft 侧字段缺失 | `dedupReceipt` 只在 draft 侧确有该字段时才引用；展开时发现缺失 → 抛 `CorruptReceiptError`（不静默 fallback） |

## 4. 收益（实测）

| 项 | 值 |
|---|---:|
| 去重前 `episode_production_operations` | 207.11 MB（270 行） |
| 可省（144 行，>10KB 阈值） | 28.95 MB |
| 去重后 receipt 总字节 | ~182.6 MB |
| 全库 `VACUUM` 后预计 | ~578 MB（从 606.9 MB 降 ~29 MB） |

> 口径说明：设计稿早期按"无阈值 union"算 230 行/26.74MB；迁移脚本按 >10KB 阈值过滤
> 后实测 144 行/28.95MB（过滤掉 86 行 <10KB 的小 shots，其 JSON 序列化后重复块
> 太小不值得引用）。以脚本实测为准。

## 5. 实施顺序

1. 新增 `dedupReceipt()` + `resolveReceiptDedup()`（独立模块 `receipt-dedup.ts`）
2. 改写入 1 处（`commit()` :1917-1918）
3. 改读取 2 处返回完整对象（`operationReceipt` :503-507、`commit` :1887）；`adoptSharedAsset` :452-458 不改（只读 draft）
4. 定向测试：
   - `dedupReceipt`：两者相同 / 仅 director 同 / 仅 shots 同 / 都不同 / published=null
   - `resolveReceiptDedup`：展开 `deepEqual` 原始 / 无标记 no-op / 幂等
   - `commit()` 幂等重放返回完整 `ProductionRecord`
   - `adoptSharedAsset` 取 nodeId 不受影响
   - `assertPublicReceipt`：含 `__receiptDedupV1` 的 record 抛错
   - `resolveReceiptDedup`：draft 侧路径缺失时抛 `CorruptReceiptError`
5. 迁移脚本 `dedup-production-receipts.ts` + 副本验证
6. 生产库迁移 + `VACUUM`

## 6. 验收

- [ ] `dedupReceipt` 仅对逐字节相同的 `director`/`shots` 生成引用
- [ ] `resolveReceiptDedup` 展开后 `deepEqual` 原始 `ProductionRecord`
- [ ] `resolveReceiptDedup` 对无 `__receiptDedupV1` 的行 no-op
- [ ] `resolveReceiptDedup` 对 draft 侧缺失路径抛 `CorruptReceiptError`（不静默 fallback）
- [ ] `assertPublicReceipt`：含 `__receiptDedupV1` 的 record 抛错
- [ ] `commit()` 幂等重放、`operationReceipt` 返回完整对象
- [ ] `adoptSharedAsset` 的 nodeId 提取不受影响
- [ ] 迁移后 230 行含 `__receiptDedupV1`，省 26.74MB
- [ ] `VACUUM` 后文件降 ~27MB
- [ ] 现有 production 测试全过
- [ ] 无 API 行为变化
