# Infinite Canvas 画布写路径性能优化方案

> 状态：**§2 已实施**（commit `7aede9f8`）；§3/§4 暂缓（实测收益不成立）
> 原始统计基线 HEAD：`615fae28`。实施前重新检查 HEAD 和工作树；保留已有修改，**不要** `git add -A`，每项按文件及必要 hunk 独立提交。
> 数据来源：本地代码走查、730MB 一致性快照（`VACUUM INTO` from `runtime.sqlite`）实测统计和 chatgpt2api 外部评审。

---

## 0. 实测基线

730MB 一致性快照（`VACUUM INTO` from 运行中 `runtime.sqlite`，`integrity_check` ok）实测：

| 项 | 数值 |
|---|---|
| 数据库 | ~730 MB（`PRAGMA journal_mode = WAL`） |
| `canvas_operation_batches` | **71,213 行**，operations/results JSON ~92.7 MB |
| `mcp_observability_events` | **23,307 行**，~1.5K 行/天，无 `created_at` 单列索引，DELETE 全表 SCAN |
| `canvas_text_documents` | **623 行**（619 节点级 / 4 `globalPrompt` / 0 畸形），全项目扫描 20 次共 3.2 ms |
| `previewCanvasHistoryPrune` | 2.2 s，22 项目全 blocked，`batchCount=0`，未触发 `VACUUM INTO` |
| 当前 schema 版本 | 实施前 `30` → 实施后 `31` |

前端轮询与广播路径不在本次范围；本稿未提供其性能验收证据。源码行号仅供原始定位，实施时按符号核对当前代码。

### 0.1 测量与数据保护

- 运行中的用户库只做只读统计和 dry-run。通过 SQLite 一致性快照（如只读连接执行 `VACUUM INTO` 到新文件）取得副本，校验 `integrity_check` 和外键检查结果；不能只复制 WAL 模式下的主 `.sqlite` 文件。
- 在独立临时数据目录放置 `runtime.sqlite` 副本，通过 `INFINITE_CANVAS_DATA_DIR` 指向该目录；启动测试进程前核对解析后的 `DB_FILE` 确为副本。CLI 子进程也必须显式传入该环境变量，缺失时拒绝运行写入验收。
- 迁移、`--apply`、节点删除、无备份裁剪及故障注入全部在副本或临时构造数据上执行。真实库清理是另行授权的维护操作，不是实施验收步骤。
- 基线与改后使用内容相同的独立副本、相同操作和运行条件。记录节点数、文本行数、受影响文本数，单次删除及多操作批次的端到端耗时（重复测量的中位数和范围）、事务占锁时间、迁移回填耗时和备份耗时。区分首次与热运行，记录工具及样本数。
- `EXPLAIN QUERY PLAN` 只证明索引使用；必须同时报告上述前后数据。§2 属容量维护，§3 属编辑热路径，§4 属手动维护；测量后再决定优先级，不预先标为 P0。收益不明显时保留测量结果，暂缓相应优化。

---

## 1. 外部评审结论核对

| GPT 建议 | 核对 | 处理 |
|---|---|---|
| P1「每 operation 一次 stringify+UPDATE，合并」 | **误读**：`db.ts:1880-1962` 循环内只有校验+apply，`UPDATE`（1960）在循环外，每 commit 已只写 1 次 | **否决** |
| P0-3「reconstruct 从 revision 0 重放」 | **误读**：`history-maintenance.ts:32` 第一行读 checkpoint，只重放其后 batches | **否决** |
| observability retention | 属实 | **采纳** §2 |
| text_documents 加 node_id | 属实 | **采纳** §3 |
| `VACUUM INTO` 可选化 | 属实（`history-maintenance.ts:93`） | **采纳** §4 |
| P2 文档拆分 | 规模未到，风险大于收益 | 不做 |

---

## 2. 候选 1：`mcp_observability_events` 保留期清理 ✅ 已实施（`7aede9f8`）

### 2.1 现状

- 表 schema 包含 `created_at TEXT NOT NULL`，已有索引 `mcp_observability_trace (trace_id, created_at)`、`mcp_observability_tool_event (tool, event, created_at)`——两个索引的首列都不是 `created_at`，不能直接作为时间范围查找索引，实际计划用 `EXPLAIN QUERY PLAN` 验证。
- 写入点唯一：`db.ts:2888`（insert）。
- 无任何 DELETE。

### 2.2 改动 1：迁移加索引

`db.ts` 构造函数 schema 段（紧跟 `db.ts:362` 两个 observability 索引之后）加：

```sql
CREATE INDEX IF NOT EXISTS mcp_observability_created_at
  ON mcp_observability_events(created_at);
```

同时 `database-upgrade.ts:5` 版本 30 → **31**。现有机制（`prepareDatabaseUpgrade`，`database-upgrade.ts:8-19`）自动对 v30 库做备份后放行；索引是 `IF NOT EXISTS` 幂等，老库重跑安全。

### 2.3 改动 2：新增 CLI `backend/src/maintenance/prune-observability.ts`

完整文件草案（7 天候选值按 §2.5 确认后落地）：

```ts
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import { DB_FILE } from "../config.js";

// Manual only. Default is read-only: npm run prune-observability -- [days=7] [--apply]
const args = process.argv.slice(2);
const positional = args.filter((arg) => !arg.startsWith("--"));
if (args.some((arg) => arg.startsWith("--") && arg !== "--apply") || positional.length > 1)
    throw new Error("Usage: prune-observability [days=7] [--apply]");
const keepDays = Number(positional[0] ?? 7);
if (!Number.isFinite(keepDays) || keepDays <= 0) throw new Error("保留天数必须是正数");
const cutoff = new Date(Date.now() - keepDays * 86_400_000).toISOString();
const apply = args.includes("--apply");
if (!fs.existsSync(DB_FILE)) throw new Error("数据库不存在，拒绝创建空库进行维护");
const db = new DatabaseSync(DB_FILE, { readOnly: !apply });
try {
    const count = db.prepare("SELECT COUNT(*) AS n FROM mcp_observability_events WHERE created_at < ?").get(cutoff) as { n: number };
    let deleted = 0;
    if (apply) deleted = Number(db.prepare("DELETE FROM mcp_observability_events WHERE created_at < ?").run(cutoff).changes);
    console.log(JSON.stringify({ ok: true, dryRun: !apply, keepDays, cutoff, wouldDelete: count.n, deleted }));
} finally { db.close(); }
```

### 2.4 改动 3：注册 CLI

`backend/package.json` scripts（仿 `backend/package.json:21` 现有条目 `"prune-canvas-batches": "tsx src/maintenance/prune-canvas-batches.ts"`）：

```json
"prune-observability": "tsx src/maintenance/prune-observability.ts"
```

### 2.5 不做启动自动清理（决定 + 理由）

GPT 建议的"挂进 maintenance loop"前提不成立——现有维护入口为手动 CLI（`redact-inline-media`、`prune-canvas-batches`）。**保持手动 CLI**；2,423 是存量行数，不能推出增速或执行周期。示例中的 7 天是待确认的保留策略候选，实施前需说明适用数据、默认值、历史诊断影响和失败处理并取得确认；确认前不落为产品默认值。用 §7 的日增量与诊断需求确定保留期及运行频率；删除失败报告错误，不自动重试、不启动定期任务。

### 2.6 测试

新文件 `backend/src/maintenance/prune-observability.test.ts`：

1. 构造 3 行 `created_at`：cutoff 前 2 行、后 1 行。
2. dry-run：`wouldDelete == 2`，行数不变。
3. `--apply`：`deleted == 2`，仅剩 1 行。
4. `EXPLAIN QUERY PLAN DELETE FROM mcp_observability_events WHERE created_at < ?` 含 `mcp_observability_created_at`。

### 2.7 验收

- 用户库仅跑 dry-run；在独立副本用固定 cutoff 验证预览与删除数量一致，无并发写入。独立运行 CLI 时 cutoff 随时间变化，应按各自输出核对，不要求两次结果机械相等。
- v30 副本迁移幂等，重复打开不重建索引、不再次生成升级备份；缺库与非法参数拒绝路径不创建空库、不删除数据。

---

## 3. 候选 2：`canvas_text_documents` 加 `node_id` 派生列 ⏸️ 暂缓（实测收益不成立）

> **暂缓依据（实测）**：`canvas_text_documents` 仅 **623 行**（619 节点级 / 4 `globalPrompt` / 0 畸形），全项目扫描 20 次共 **3.2 ms**。加列 + 回填 + 写入/删除路径改造的复杂度，不足以覆盖这个规模下的收益。按 §0.1「收益不明显时暂缓」原则保留测量结果，不实施。下文为原设计稿，留作日后数据增长后参考。

### 3.1 现状

表（`db.ts:224-228`）：

```sql
CREATE TABLE IF NOT EXISTS canvas_text_documents (
    project_id TEXT NOT NULL REFERENCES canvas_projects(id) ON DELETE CASCADE,
    target_key TEXT NOT NULL,
    state BLOB NOT NULL,
    PRIMARY KEY (project_id, target_key)
);
```

（`document_id` 列由后续迁移 `ALTER TABLE ADD COLUMN` 补上，见 `db.ts:389` 的 `PRAGMA table_info` 幂等模式。）

`textKey` 将 `[target.nodeId || "", target.segmentId || "", target.field]` 编码为 JSON，存在 `textItemId` 时追加第四项，**nodeId 在第一位**。合法项目级 `globalPrompt` 的第一项为 `""`。

写入唯一入口 `saveCanvasText`（`db.ts:1586-1589`）：

```ts
private saveCanvasText(id: string, target: CanvasTextTarget, state: Uint8Array) {
    const row = this.db.prepare("INSERT INTO canvas_text_documents (project_id, target_key, state, document_id) VALUES (?, ?, ?, ?) ON CONFLICT(project_id, target_key) DO UPDATE SET state = excluded.state RETURNING document_id").get(id, textKey(target), state, crypto.randomUUID()) as { document_id: string };
    return row.document_id;
}
```

调用点 3 处：`db.ts:1581`、`db.ts:1609`、`db.ts:1940`——全走这一个函数，**只改这里**。

删除热路径（`db.ts:1925-1932`）：删节点时全项目 `SELECT target_key` + 逐条 `readText` 试错找孤儿。

### 3.2 改动 1：迁移（`db.ts` 的 `migrate`，确保文本表已建立）

仿现有幂等迁移模式（`PRAGMA table_info` 判列），将 DDL、索引和回填置于同一事务。若插入点已有迁移事务，复用它，不嵌套 `BEGIN`。旧库版本登记必须在成功回填之后。

先定义一个供迁移和清理共用的本地解析函数：校验 JSON 数组结构、共享 `textTargetSchema`，并按 `textKey` 往返验证。异常记录原样保留，以聚合数量报告，不输出完整文本或 key。

```ts
function parseStoredTextTarget(key: string): CanvasTextTarget | undefined {
    try {
        const parts: unknown = JSON.parse(key);
        if (!Array.isArray(parts) || (parts.length !== 3 && parts.length !== 4)) return;
        const [nodeId, segmentId, field, textItemId] = parts;
        if (typeof nodeId !== "string" || typeof segmentId !== "string") return;
        const parsed = textTargetSchema.safeParse({
            nodeId: nodeId || undefined, segmentId: segmentId || undefined,
            field, ...(parts.length === 4 ? { textItemId } : {}),
        });
        if (!parsed.success || textKey(parsed.data) !== key) return;
        const target = parsed.data;
        if (!target.nodeId && (target.field !== "globalPrompt" || target.segmentId || target.textItemId)) return;
        if (target.nodeId && target.field === "globalPrompt") return;
        if (target.segmentId && (target.field !== "prompt" || target.textItemId)) return;
        if (target.textItemId && target.field !== "content") return;
        return parsed.data;
    } catch { return; }
}
```

派生列约定：节点级文本存节点 ID；合法项目级文本存 `""`；无法解析的历史记录保持 NULL。没有节点关联不等于无效数据。

```ts
this.db.exec("BEGIN IMMEDIATE");
try {
    const columns = this.db.prepare("PRAGMA table_info(canvas_text_documents)").all() as Array<{ name: string }>;
    if (!columns.some((c) => c.name === "node_id")) {
        this.db.exec("ALTER TABLE canvas_text_documents ADD COLUMN node_id TEXT");
    }
    this.db.exec("CREATE INDEX IF NOT EXISTS canvas_text_documents_project_node ON canvas_text_documents(project_id, node_id)");
    // iterate 避免把全部 BLOB 或全部 key 一次性加载到内存。
    const rows = this.db.prepare("SELECT project_id, target_key FROM canvas_text_documents WHERE node_id IS NULL");
    const backfill = this.db.prepare("UPDATE canvas_text_documents SET node_id = ? WHERE project_id = ? AND target_key = ? AND node_id IS NULL");
    let invalidRows = 0;
    for (const row of rows.iterate()) {
        const target = parseStoredTextTarget(String(row.target_key));
        if (!target) { invalidRows++; continue; }
        backfill.run(target.nodeId || "", row.project_id, row.target_key);
    }
    // 实施时将本阶段 schema_migrations 的版本登记置于此事务内、COMMIT 前。
    this.db.exec("COMMIT");
    if (invalidRows) console.warn(`[database] Unparsed canvas text documents retained: ${invalidRows}`);
} catch (error) { this.db.exec("ROLLBACK"); throw error; }
```

版本 31 → **32**（若与 §2 同一提交则只 bump 一次到 32）。

**实施前先量**：v30 库只查 `SELECT COUNT(*) FROM canvas_text_documents`，再只读遍历 `target_key`，区分节点级、项目级、畸形记录；此时尚无 `node_id` 列，不能查询它。迁移后在副本统计 `node_id IS NULL`，应等于保留的异常记录数。流式回填仍需测耗时与占锁时间，见 §7。

### 3.3 改动 2：写入路径同步（`db.ts:1586`）

```ts
private saveCanvasText(id: string, target: CanvasTextTarget, state: Uint8Array) {
    const nodeId = target.nodeId || "";
    const row = this.db.prepare("INSERT INTO canvas_text_documents (project_id, target_key, state, document_id, node_id) VALUES (?, ?, ?, ?, ?) ON CONFLICT(project_id, target_key) DO UPDATE SET state = excluded.state, node_id = excluded.node_id RETURNING document_id").get(id, textKey(target), state, crypto.randomUUID(), nodeId) as { document_id: string };
    return row.document_id;
}
```

说明：调用方沿现有 schema 校验；`node_id` 与 `textKey` 第一项同源派生，合法项目级文本写 `""`，不引入新的 NULL。冲突更新不改变 `document_id`，仅在旧文本对象实际失效删除后重新创建身份。

### 3.4 改动 3：删除路径走索引（`db.ts:1925-1932`）

现在：

```ts
const documents = this.db.prepare("SELECT target_key FROM canvas_text_documents WHERE project_id = ?").all(id) as Array<{ target_key: string }>;
for (const { target_key } of documents) {
    const [nodeId, segmentId, field, textItemId] = JSON.parse(target_key);
    try { readText(project, { nodeId: nodeId || undefined, segmentId: segmentId || undefined, field, textItemId }); }
    catch { this.db.prepare("DELETE FROM canvas_text_documents WHERE project_id = ? AND target_key = ?").run(id, target_key); }
}
```

改为：保留现有 `!isText` 分支和逐操作执行顺序。在当前 operation 已应用之后、`editedTextTargets` 同步之前，按**当前操作**选出受影响节点，不聚合整批、不移到循环外：

```ts
const changesTextStructure = operation.type === "update_node" && (
    ["segments", "texts"].some((key) =>
        Object.hasOwn(operation.metadata as object || {}, key) ||
        (operation.metadataDelete as string[] || []).includes(key)) ||
    Object.hasOwn(operation.patch as object || {}, "type")
);
// delete_node 支持 id 或 ids 批量（见 project-ops.ts:324-325），转换与执行代码一致；操作已通过执行校验，不再另造输入规范。
let affectedNodeIds: Set<string> | undefined;
if (operation.type === "delete_node") {
    affectedNodeIds = new Set(Array.isArray(operation.ids) ? operation.ids.map(String) : [String(operation.id || "")]);
} else if (changesTextStructure) {
    const s = String(operation.id || "");
    if (s) affectedNodeIds = new Set([s]);
} else if (["delete_h3_segment", "replace_h3_segments"].includes(operation.type)) {
    const s = String(operation.nodeId || "");
    if (s) affectedNodeIds = new Set([s]);
}
if (affectedNodeIds) {
    const deleteText = this.db.prepare("DELETE FROM canvas_text_documents WHERE project_id = ? AND target_key = ?");
    // NULL 兜底行按触发清理的操作查一次，不按节点数重复查。
    const nullRows = this.db.prepare("SELECT target_key FROM canvas_text_documents WHERE project_id = ? AND node_id IS NULL").all(id) as Array<{ target_key: string }>;
    for (const affectedNodeId of affectedNodeIds) {
        const indexedRows = this.db.prepare("SELECT target_key FROM canvas_text_documents WHERE project_id = ? AND node_id = ?").all(id, affectedNodeId) as Array<{ target_key: string }>;
        for (const { target_key } of [...indexedRows, ...nullRows]) {
            const target = parseStoredTextTarget(target_key);
            // 无法解析的记录保留；不得让异常 key 中断正常编辑，也不猜测归属删除。
            if (!target || target.nodeId !== affectedNodeId) continue;
            try { readText(project, target); }
            catch { deleteText.run(id, target_key); }
        }
    }
}
```

必须保持的语义：

1. `readText` 判定目标是否仍可编辑，包括节点类型、Clip、文本项；当前实现不跨节点寻找同名 segment。索引只缩小候选范围，不替代此判定。
2. 每步应用后立即清理。同批删除再重建同 ID 节点、Clip 或文本项必须得到新 `documentId`，旧增量拒绝；批末清理会破坏这一点。
3. `update_node.metadata.segments` 当前只允许相同成员集合的完整更新，不能用它测试删 Clip；成员替换用 `replace_h3_segments`，单项删除用 `delete_h3_segment`。`metadataDelete` 和类型变更保留现有触发条件。
4. 不再顺带删除其他节点的存量孤儿；这些记录保留，不另加全项目维护清理。NULL 兜底仍有扫描成本，基准必须记录异常记录数量；不能宣称完全消除了扫描。

### 3.5 测试

优先扩展 `backend/src/canvas/collaboration.test.ts`，迁移场景使用临时文件数据库：

1. **回填一致性**：有效节点级文本存 nodeId，合法 `globalPrompt` 存 `""`，畸形 JSON、非数组及不合法 target 保持 NULL；state、documentId、target_key 原样保留。重复打开幂等，回填故障回滚且原版本未升级。
2. **删除走索引**：`EXPLAIN QUERY PLAN SELECT target_key FROM canvas_text_documents WHERE project_id=? AND node_id=?` → `SEARCH ... USING INDEX canvas_text_documents_project_node`。
3. **孤儿清理正确性**：建 3 个 node 各 1 条文本 + 1 条孤儿（node 不存在）；删 1 个 node → 只删它的 1 条，孤儿与其余保留。批量 `delete_node` 用 `ids`（无 `id`）删 2 个 node → 两个节点的文本都被清。
4. **结构清理覆盖**：`delete_h3_segment`、`replace_h3_segments`、`update_node.metadata.texts` 移除成员、`metadataDelete` 移除 `segments/texts`、`patch.type` 使 content 不可编辑；仅清失效文本，仍有效的成员身份保持。
5. **逐步身份与恢复**：节点、Clip、文本项删除后同 ID 重建（含同批）得到新身份，旧草稿增量被 `TEXT_DOCUMENT_REPLACED` 拒绝；重复 operationId 不重新执行，后续非法操作导致事务完整回滚。
6. **异常隔离**：预置异常 NULL key 和合法项目级文本后，正常删除仍成功，两类记录均保留；可解析的节点级 NULL 行按当前节点兜底清理。

### 3.6 验收

- 独立副本经现有 ops/service 删除大节点：仅删除该节点失效文本；未触及节点、项目级文本和异常行保留。记录 §0.1 前后耗时与候选行数。
- v30 副本迁移成功且幂等；覆盖迁移失败回滚、备份可读取和未知较高版本拒绝覆盖。

---

## 4. 候选 3：`applyCanvasHistoryPrune` 备份可选化 ⏸️ 暂缓（实测收益不成立）

> **暂缓依据（实测）**：`previewCanvasHistoryPrune` 当前 2.2 s、22 项目**全 blocked**、`batchCount=0`，`VACUUM INTO` 备份路径未触发——当前没有可备份的裁剪量。按 §0.1 原则保留测量结果，不实施。日后若 prune 产生实际删除量再评估。下文为原设计稿。

### 4.1 现状

`history-maintenance.ts:88-114`：apply 前无条件 `VACUUM INTO` 整库备份（93 行）。调用方仅 `backend/src/maintenance/prune-canvas-batches.ts`（**手动 CLI**，非自动触发）。

### 4.2 改动 1：函数签名（`history-maintenance.ts:88`）

```ts
export function applyCanvasHistoryPrune(db: DatabaseSync, file: string, cutoff: string, options: { createBackup?: boolean } = {}) {
    const preview = previewCanvasHistoryPrune(db, cutoff);
    if (preview.some((plan) => plan.blockedReason)) throw new Error("History validation failed; no batches were deleted");
    if (!preview.some((plan) => plan.batchCount)) return { plans: preview, removed: 0, backupFile: null };
    let backupFile: string | null = null;
    if (options.createBackup !== false) {
        backupFile = `${file}.before-batch-prune-${crypto.randomUUID()}.sqlite`;
        db.exec(`VACUUM INTO '${backupFile.replaceAll("'", "''")}'`);
        fs.chmodSync(backupFile, 0o600);
        const copy = new DatabaseSync(backupFile, { readOnly: true });
        try {
            if (copy.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok" || copy.prepare("PRAGMA foreign_key_check").all().length) throw new Error("History backup failed validation");
        } finally { copy.close(); }
    }
    // ... 其余事务逻辑不变（BEGIN IMMEDIATE 起）
```

默认 `createBackup: true` → 现有行为不变。

### 4.3 改动 2：CLI 透传（`prune-canvas-batches.ts`）

```ts
if (args.some((arg) => arg.startsWith("--") && arg !== "--apply" && arg !== "--no-backup") || positional.length > 1)
    throw new Error("Usage: prune-canvas-batches [days=30] [--apply] [--no-backup]");
const createBackup = !args.includes("--no-backup");
// ...
const result = apply ? applyCanvasHistoryPrune(db, DB_FILE, cutoff, { createBackup }) : { plans: previewCanvasHistoryPrune(db, cutoff) };
```

Usage 报错文案同步更新。

### 4.4 测试

`history-maintenance.test.ts` 增：
1. `createBackup: false` → 不产生 `.before-batch-prune-*.sqlite` 文件，`removed` 与默认路径一致。
2. 默认（不传 options）→ 备份文件生成，行为与现状一致（现有测试保持绿）。

### 4.5 验收

在相同初始内容的两个独立副本上分别跑默认备份和 `--no-backup --apply`，比较固定 cutoff 下的结果、checkpoint、剩余 batches 和回执；后者 `backupFile === null` 且无新增备份文件。保留独立原始快照，测量备份与裁剪耗时。两条路径均覆盖删除失败的事务回滚，默认路径保留备份验证失败时拒绝裁剪。用户库不执行此验收。

---

## 5. 提交拆分与门禁

每项独立提交（工作树 dirty，**禁止 `git add -A`**）：

| 提交 | 文件 | 门禁 | 状态 |
|---|---|---|---|
| 1. observability retention | `backend/src/db.ts`、`backend/src/database-upgrade.ts`、`backend/src/maintenance/prune-observability.ts`（新）、`backend/package.json`、测试文件 | Backend 编译、定向测试、副本 dry-run/apply、保留策略确认 | ✅ `7aede9f8` |
| 2. node_id 派生列 | `backend/src/db.ts`、`backend/src/database-upgrade.ts`、测试文件 | 同上 + 回填一致脚本 + `EXPLAIN QUERY PLAN` 进 PR 描述 | ⏸️ 暂缓（§3） |
| 3. prune 备份开关 | `backend/src/canvas/history-maintenance.ts`、`backend/src/maintenance/prune-canvas-batches.ts`、`history-maintenance.test.ts` | 定向测试 + 副本默认/无备份对照及失败回滚 | ⏸️ 暂缓（§4） |

统一门禁：本次差异的格式与引用检查通过；v30 一致性快照的独立副本迁移成功且幂等；报告 §0.1 的前后数据和实际限制。共享修改文件必须按 hunk 分离已有工作，不把无关改动纳入提交。

实施后，在 `backend` 目录运行以下定向命令（新测试文件创建后再执行）：

```powershell
npm run build
node --import tsx --test src/maintenance/prune-observability.test.ts
node --import tsx --test src/canvas/collaboration.test.ts src/canvas/operation-authority.test.ts
node --import tsx --test src/canvas/history-maintenance.test.ts
```

选择各项受影响套件，已有相关检查通过后不无理由扩大测试。`npm run test` 的 `scripts/test.mjs` 会发现整个 workspace 的测试，且不转发筛选参数，不能当作定向测试命令。Backend 编译会产生 dist；按实际消费路径判断是否需要加载，测试通过不代表运行服务已加载。新增迁移独立测试文件时同步补充定向命令。

业务实现完成时，按 `docs/AGENTS.md` 更新中英文 pending-test 及 CHANGELOG 的实际可测试行为；本设计修订不改变功能完成状态。

执行顺序：**只读统计及副本基准 → 确认维护策略与收益 → 1 → 2 → 3**。若测量表明优先级不同，按证据调整，不因章节顺序强制实施无收益改动。

---

## 6. 明确不做

- **每 operation 合并 snapshot 写入**：项目快照 UPDATE 在循环外，每 commit 已只写一次，因此此建议无对应改动。一次序列化及更新的成本仍需测量，不据此否定其他 snapshot 优化。
- **文档拆分/增量 snapshot**：本轮暂缓；当前容量数字不能单独证明无需优化，先测 snapshot 成本。变更 checkpoint/replay/batches 必须另行设计连续性与恢复验证。
- 前端轮询、广播、ComfyUI/H3 生成路径、MCP 传输层。

---

## 7. 实施前待量（阻塞项）— 已完成

量测已于实施前在独立副本执行，结果见 §0 实测基线：

1. **文本分布** ✅：`canvas_text_documents` 623 行（619 节点级 / 4 `globalPrompt` / 0 畸形），全项目扫描 20 次共 3.2 ms。规模不足以支撑 §3 加列改造 → 暂缓。
2. **遥测增长及诊断需求** ✅：`mcp_observability_events` 23,307 行、~1.5K 行/天。7 天保留可删约 14,340 行；DELETE 原为全表 SCAN，加索引后走 SEARCH。保留期默认 7 天（CLI 参数可调）。
3. **迁移保护** ✅：v30→v31 副本迁移成功、自动备份生成、重开幂等不重建索引；缺库与非法参数拒绝路径不创建空库。
4. **收益基准** ✅：`previewCanvasHistoryPrune` 2.2 s、22 项目全 blocked、`batchCount=0`，`VACUUM INTO` 未触发 → §4 暂缓。
