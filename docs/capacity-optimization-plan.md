# Infinite Canvas 数据库容量优化 — 最终实施方案 v3

> 状态：方案定稿，未实施。所有删除、迁移、故障注入和文件压缩先在一致性副本验证；真实库维护及服务停止另行授权。
> 代码核验基线：`8c8ea394`，数据库 schema v31。实施前重新核对 HEAD、schema、工作树和实际运行路径，保护已有修改。
> 本方案只处理数据库记录及其回收；不删除媒体、用户 outbox、冲突草稿、制作稿或版本，不自动提交生成任务。

## 1. 最终决策

1. 用一套保留策略同时决定任务、生成日志及其关联记录能否清理；不再分别复制多段保护 SQL。
2. 按完整任务族处理父任务、子任务、日志和事件。任何成员仍有业务引用、运行或恢复依赖，都保留整个相关集合。
3. 不提供独立按日期或“终态”删除 `task_events` 的 CLI。事件仅随已确认可删除的任务通过 FK 级联删除；孤儿只报告，异常先调查。
4. 正式 `production_task_bindings` 的所有状态都受保护，包括 `submitted`、`bound`、`failed`；其清理由正式制作对象的生命周期负责，不由容量工具判断失效。
5. 统一使用一个手动 CLI：`prune-runtime-history`。旧的写入时无保护 500 条 DELETE 必须先移除，才开放清理工具。
6. 500 条保留为每项目日志的整理目标；受保护、非终态、关联任务未到期的记录可使数量超过目标。数量整理由手动 CLI 显式选择，不新增定时器或后台自动清理。
7. 在删除任务前保留轻量任务 ID 凭据，拒绝使用已清理 ID 再次提交生成；历史正文不可用必须明确返回，不能伪造完整 RuntimeTask。
8. 健康画布历史沿现有严格 prune 处理。坏历史 re-baseline 独立执行，绑定具体数据摘要并保留所有命令身份；不是对任意 blocked 原因的通用删除开关。
9. 操作回执不裁字段、不做 TTL 删除。完整压缩/去重作为后续独立事项，本轮不改读取合同。
10. 收益由副本 dry-run、实际删除和压缩后的测量确定，不承诺固定缩库比例。

## 2. 已核事实和旧快照测量

以下容量仅代表已有 730 MB v31 一致性快照，不替代实施时重新测量。

| 表 | 旧测量 | 本方案处置 |
|---|---:|---|
| `episode_production_operations` | 280.9 MB / 311 行 | 完整幂等回执，保留 |
| `tasks` | 132.1 MB / 5,662 行 | 保护引用及恢复，任务族满足清理条件才删除 |
| `canvas_operation_batches` | 124.0 MB / 71,213 行 | 健康链严格 prune；坏链显式 re-baseline |
| `generation_logs` | 35.7 MB / 3,711 行 | 与任务族一起整理，统一 TTL/数量保护 |
| `canvas_production_operations` | 28.0 MB / 50 行 | 与分集/场次操作回执同等保护 |
| `episode_production_versions` | 19.9 MB / 36 行 | 版本及恢复依据，保留 |
| `mcp_observability_events` | 13.2 MB / 8,924 行 | 已有独立维护工具，沿现有入口 |
| `task_events` | 11.0 MB / 38,940 行 | 任务恢复及决议记录，仅任务删除时级联 |

以该快照记录的 10 月 6 日为计算基点：30 天前约为 9 月 6 日，60 天前约为 8 月 7 日。不能从“五周数据”推断 30 天任务保留期没有候选；60/180 天日志 TTL 没有超期样本。新的候选条件还考虑关联关系，数量由实跑确认。

关键源码入口：

- [任务结构、存储和读取](../backend/src/db.ts)：`parentTaskId` 来源是 `params_json.parentTaskId`，没有 `parent_task_id` 列。
- [H3 父任务识别及恢复](../backend/src/canvas/h3-runner.ts)：节点顶层和 `metadata.segments[]` 均可能保存运行/父任务绑定；事件承担恢复及重复决议判断。
- [正式制作历史选用](../backend/src/drama/production.ts)：log → 成功子任务 → 父任务 binding → 归档媒体；当前制作稿读取 `*_productions`，操作回执用于完整幂等响应。
- [原生正式生成绑定](../backend/src/drama/native-generation.ts)：binding 指向父任务，日志可能指向子任务。
- [日志结果回写](../backend/src/canvas/h3-task-writeback.ts)：输入快照在日志；历史结果恢复不能只保留媒体文件。
- [历史维护](../backend/src/canvas/history-maintenance.ts)：严格回放校验、回执身份独立保留和事务内复核必须继续有效。

## 3. 统一保留策略

### 3.1 模块和输入

新增 `backend/src/maintenance/runtime-history-policy.ts`，同时服务 dry-run 和 apply；500 条逻辑也只在该模块实现。它消费当前 schema 的只读数据库快照，返回保留原因、候选关联集合和数据摘要。业务入口继续使用现有 service/store，不在 Web 或插件再造保留规则。

策略的状态白名单：

- 任务可删除状态：`succeeded`、`failed`、`cancelled`。
- 日志可删除状态：`success`、`failed`、`cancelled`。
- 未知状态、非终态、无效时间、无法解析的业务 JSON、无法解释的关联均保留；无法证明整个扫描完整时拒绝 apply。
- 列、表、schema 或策略版本不匹配时拒绝；不把“查不到字段/查询失败”当成无引用。

### 3.2 根引用

下列持久业务记录构成保留根；不以 task/log 自身的 ID 字段充当根。

| 来源 | 必须覆盖 |
|---|---|
| 画布当前状态 | 顶层 `runtimeTaskId/runtimeRunId`，Clip 的 `runtimeTaskId/parentTaskId`，历史输出与选用结果中的 task/log ID |
| 尚存在的输出节点 | 对现存节点可查回并恢复的成功日志，即使节点没有顶层 `generationLogId` 也保留；不按同名猜节点 |
| 正式制作 | episode/canvas/scene 三种 owner 的当前稿、版本、操作回执、runs、batches，含 submitted/currentWork/selectedResult 和审核来源 |
| 正式凭据 | 所有 `production_task_bindings.task_id`，不排除 submitted/failed |
| 已批准资产和共享引用 | 历史来源任务、选用结果、提升/采用记录及其持久回执 |
| 操作与恢复 | preparation、MCP 命令、画布 checkpoints/batches 的 payload、results、receipt；包含未确认或可恢复的持久记录 |
| 其他业务记录 | schema 清单覆盖其 task/log 引用；无法证明无引用的表/字段不能自动忽略 |

实现采用 schema 绑定的来源清单。业务 TEXT/JSON 按真实列读取，结构化值和对象键中的精确 task/log ID 都纳入；声明为自由文本或二进制的字段需明确其业务语义。不能用 `%id%` 模糊 LIKE 作为删除依据，也不能输出完整正文、提示词或配置。

每次更新 schema 或新增持久任务/日志引用，必须同时更新来源清单和对应保留测试。当前大表按行扫描和解析，摘要流式累计，不一次载入整库正文。保守多留可在报告中解释，不能为提高删除量忽略旧回执或版本。

### 3.3 关联传播

构建任务/日志关联图，ID 类型带前缀（`task:`、`log:`），避免不同表相同 ID 被误认为同一实体。

1. 父子任务按 `json_extract(params_json, '$.parentTaskId')` 建立关联，覆盖任意深度，不只覆盖活动子任务。
2. 日志按 `runtime_task_id` 关联实际执行任务；任务按 `params.canvasBinding.generationLogId` 关联日志。
3. H3 事件中保存的 childTaskId/taskId/generationLogId 等关联到事件所属任务；事件中的关联不能因任务终态而失效。
4. 任务 input/params/result 的持久任务或日志引用也形成关联；冻结快照中的引用保守处理。
5. 从根、非终态及异常记录传播保护。一个关联集合中的任何成员受保护，整个集合都保留。
6. 若某成员未满足所选清理政策，保留整个关联集合，不删父任务留下需要它的日志，也不删子任务留下正式绑定。

循环关联不导致递归溢出，用 visited 集合迭代遍历。丢失父任务、悬空日志等完整性异常单独报告；不借容量清理修复或掩盖异常。

示例 SQL 仅展示真实字段，不作为完整删除策略：

```sql
SELECT id, json_extract(params_json, '$.parentTaskId') AS parent_id
FROM tasks;

SELECT l.id AS log_id, t.id AS child_id,
       COALESCE(NULLIF(json_extract(t.params_json, '$.parentTaskId'), ''), t.id) AS binding_task_id
FROM generation_logs l
JOIN tasks t ON t.id = l.runtime_task_id;
```

实际保护使用图的完整父链，并保留所有相关成员，不能仅靠上面的一跳 JOIN。

### 3.4 时间和数量政策

保留年龄从终态最近更新时间计算，不用创建时间直接判断：

- task：以合法 `updated_at` 为准，且不得早于 `created_at`。
- log：取合法 `updated_at`、`finished_at`、`created_at` 的最大时间；finished_at 缺失可回退，但无效值保留并报告。
- 一次计划固定 `now`，所有 cutoff 由同一 `now` 计算；dry-run 和 apply 不重新计算 cutoff。
- 边界使用严格 `< cutoff`。时间格式和合法性先验证，避免混合时区字符串比较。

TTL 参数缺省意味着该状态未获准清理；没有隐式删除默认值。30/90/30 天任务和 60/180/60 天日志仅作为 dry-run 可比较的候选政策，apply 必须使用计划中显式记录的值。

数量整理显式选择 `existing-500`：每项目按 `created_at DESC, id DESC` 排序，只有排在第 500 条之后、终态且不受保护的日志才进入数量候选。日志满足 TTL 或数量条件后，仍须满足整个关联集合的所有任务年龄和成员条件。若无法达到 500，报告剩余数及原因，不强删被保护记录。

原 `createGenerationLog()` 的无保护自动 DELETE 从写入链移除。写入路径不增加全库扫描；数量整理与 TTL 都经手动 CLI 执行。这是明确的行为调整，实施前与保留期/API 变更一起确认；不会新增其他数量、并发、重试或超时边界。

### 3.5 事件和绑定

- `task_events` 与任务保留同生命周期，包括 submitted、h3_decision、clip_completed 等全部事件。
- 不存在“task 保留、事件按年龄清空”的路径。
- 可删除任务通过 `PRAGMA foreign_keys=ON` 级联删事件。
- 正式 binding 是根，容量工具正常情况下不应删到有 binding 的任务；FK 级联仅作完整性保障，不作为业务许可。
- 发现孤儿事件或外键违例时只读报告并拒绝 apply，先沿独立修复流程调查，不在容量工具中附带清孤儿。

## 4. 任务 ID 永久保留凭据

硬删除 tasks 会使旧 clientTaskId/idempotencyKey 再次被当作新请求。保留年龄不等于允许重复执行，必须在开放删除前实现 ID 凭据。

新增表（实施时使用下一可用 schema 版本；v31 基线下预计为 v32）：

```sql
CREATE TABLE task_history_tombstones (
    task_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    terminal_status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    terminal_at TEXT NOT NULL,
    pruned_at TEXT NOT NULL,
    policy_version INTEGER NOT NULL
);
```

凭据不保存大正文、不关联 tasks FK、不按 TTL 删除。任务族删除事务内，先写凭据再删除任务；重复维护幂等。数据库增加 INSERT 防复用保护，应用侧仍须提前检查，不能只依赖最后 SQL 报错。

在以下入口的第一个会产生副作用的动作之前检查指定 task ID：CanvasGenerationService、各可直达 dispatcher/执行器、后台正式生成和公开 task create 入口；`BackendDatabase.createTask()` 是最终防线。检查早于占位节点/槽位创建、入队、provider 提交，所有入口须有覆盖证据。

返回语义：

- tasks 仍存在：沿现有完整重放和冲突判断。
- tasks 已删除但凭据存在：返回稳定 `TASK_HISTORY_PRUNED`，含 taskId、原终态、清理时间及 `retryable:false`；不能当作不存在而新建同 ID，不能伪造完整结果。
- 指定 task ID 的读取路由返回明确历史正文不可用（HTTP 410）；Web、Agent/MCP 等消费者识别该错误并停止自动重试/自动换 ID。
- 新生成需要一个明确的新请求和新 ID；容量维护本身不授权生成。

这会改变已清理历史请求的响应，需与保留政策一起审阅确认。凭据和所有调用方门禁完成前，`prune-runtime-history --apply-plan` 不得开放。

## 5. 手动运行历史 CLI

### 5.1 接口

新增 `backend/src/maintenance/prune-runtime-history.ts`，注册一个 `prune-runtime-history` npm script。

```powershell
# 在 backend 目录；数据目录由调用方显式设为独立副本。
# 下面是候选政策示例，不是获准写入产品的默认值。
npm run prune-runtime-history -- --task-succeeded-days=30 --task-failed-days=90 --task-cancelled-days=30 --log-success-days=60 --log-failed-days=180 --log-cancelled-days=60 --write-plan=runtime-history-plan.json

# 可在同一次预览显式加 --log-count-policy=existing-500
# 审阅计划后在同一副本执行，不重新隐式生成候选。
npm run prune-runtime-history -- --apply-plan=runtime-history-plan.json
```

不注册三个彼此独立的 task/events/logs 删除脚本，不承诺自动生效。

### 5.2 参数和只读行为

- 一个共享解析器，明确支持 `--name=value`，未知/重复参数、位置参数、缺 `=`、空值、空白、负数、小数、非十进制整数、无效日期范围均拒绝。
- `--help` 只显示用法，不打开数据库。
- apply-plan 与新政策参数互斥；不能在 apply 时扩大预览范围。
- 未提供写入参数默认只读；缺库不创建，unknown/newer/older schema 拒绝，不自动迁移。
- 数据目录、DB 文件及计划文件绑定实际解析路径；备份、临时文件和目标路径验证后才写。
- 输出计划和日志只含 ID、状态、时间、原因计数、字节摘要和 digest，不泄露正文或配置。

### 5.3 计划与执行事务

计划在只读一致性事务中生成，至少保存：

- formatVersion、policyVersion、schemaVersion、schema 清单摘要；实际 DB 的规范路径。
- 固定 now、所选参数、所有 cutoffs、候选集合、候选行/关联成员摘要。
- 保留原因计数、异常、任务/日志/事件候选数、JSON 字节数估计。
- 所有影响引用判定的业务行的逻辑快照 digest，不只保存 COUNT/revision。

原始文本/JSON 以 UTF-8 字节流计算 SHA-256；表、列、主键和排序固定，字段以长度分帧；包含缺行标记。digest 不是对原始 SQLite 文件求 hash，WAL/checkpoint/VACUUM 的物理变化不能代替逻辑比较。

apply 流程：

1. 验证计划格式、schema、DB 目标和策略；零候选直接返回 no-op，不生成多余备份。
2. `VACUUM INTO` 生成 UUID 命名的一致性备份，校验 integrity、foreign_key 及备份的逻辑快照 digest；报告备份路径。
3. `BEGIN IMMEDIATE`，在当前库重读来源、重建关联和候选摘要；必须与已审阅计划、备份一致。任何有关变化都回滚并要求重新预览。
4. 精确按 ID 删除候选日志；为候选任务写 ID 凭据并删除任务，事件级联。所有状态共用一个事务。
5. 校验实际删除 ID/数量、无新增悬空引用、凭据数、保护记录摘要未变、foreign_key；失败全部回滚。
6. COMMIT 后输出逐表实际变化、备份和存储测量；不删除备份，不广播虚假的媒体/生成成功。

真实库 apply 在经过明确授权的维护窗口执行；先确认媒体任务和 Agent 当前回合/codexBusy 空闲，停止实际使用该库的写入进程及连接。副本验证不启动第二套连接用户数据的服务，也不提交收费生成。

## 6. 画布历史维护

### 6.1 健康历史

继续沿现有 `applyCanvasHistoryPrune()` 的回放与当前状态严格相等检查；不降级成 warning。健康前缀压缩保留命令身份和尚可恢复的回执。

当前函数遇任一 blocked 项目会整体拒绝，保持该行为。坏历史完成经过批准的 re-baseline 后再重新预览健康 prune，不能暗中跳过错误或宣称已解锁所有项目。

### 6.2 re-baseline 的适用范围

新增 `backend/src/maintenance/rebaseline-canvas-history.ts`。项目 ID 必须显式指定，单独的计划清楚列出损失，不自动纳入运行历史清理。

准入条件全部满足：

- 当前 data_json 可解析，project ID 正确，revision 为合法非负整数；当前 nodes/connections/Clip 身份及引用满足现行画布契约。
- checkpoint 若存在，其身份及 revision 不超过当前；不存在可在计划中显式记录并建立。
- 所有已有 batch 的 operation_id、revision/日期边界合法，无未来 revision；每个 batch 均有对应命令身份凭据，不猜 request_hash。
- 可处理原因限于已确认的历史回放不匹配、旧操作回放失败或历史链缺口/缺 checkpoint。以稳定诊断码分类，不用任意错误字符串作为许可。
- malformed JSON、当前画布身份冲突、缺命令凭据、未来 revision、未知错误和外键违例拒绝，先修数据或恢复备份。

需要在历史维护诊断中增加稳定 reasonCode；不降低现有 prune 的验证门槛。历史已坏不代表当前画布也可跳过校验。

### 6.3 精确指纹

只读计划及备份、事务内复核均读取同一份指纹：

- 当前 canvas_projects 的完整原始 data_json 与相关列；包含不改变 revision 的内容变化。
- checkpoint 的有/无标记、完整 revision 和 data_json。
- 本项目全部 batches，按 revision、operation_id 排序，涵盖 identity/base_revision/revision/source/operations/results/created_at。
- 本项目全部 canvas_command_receipts 的 operation_id/project_id/request_hash/committed_revision。
- 影响事务的 schema 和完整性状态。

用完整字段的流式 SHA-256；`previewCanvasHistoryPrune()` 摘要只供说明，不能替代指纹。不论 batchCount 是否为 0，实际行数、内容及身份都进入指纹。

### 6.4 执行

1. 只读生成指定项目计划，标记旧 revision 快照不可用的范围和命令身份仍被保留。
2. 审阅后显式 `--apply-plan=<file> --accept-history-loss`；真实库仍需单独授权维护窗口。
3. 与 §5 相同的备份校验及 BEGIN IMMEDIATE。计划、备份和事务内指纹不一致立即回滚。
4. 直接用当前经过校验的 data_json 和 revision 建/更新 checkpoint，仅删除该项目 batches。
5. 不修改 canvas_projects，不删除 canvas_command_receipts/mcp_command_receipts，也不补造 operation hash。
6. 删除后重建当前 revision 必须等于当前规范状态；旧 revision 返回 `RECEIPT_UNAVAILABLE`，原命令仍可查询 committed 身份且不能重执行。同一 operationId 不同请求继续拒绝。
7. foreign_key/integrity、数据和数量校验失败回滚；成功报告删除数、旧恢复范围及备份位置。

新 checkpoint 仅替代历史锚点，不修复当前坏数据，不丢弃 outbox 或冲突草稿。客户端随后沿已有 reset/同步路径接收完整当前状态；未确认命令核对原 committed 凭据后收口，不重新执行。

## 7. schema 和索引

不先建立没有调用方的索引。v31 基线的下一次迁移包含任务 ID 凭据、INSERT 防复用保护及实测有收益的候选查询索引。

| 项目 | 决策 |
|---|---|
| `task_history_tombstones` | 硬删除任务的前置依赖；task_id 主键足够 |
| 防 ID 复用 INSERT 保护 | 与应用门禁同时完成，覆盖事务并发 |
| `tasks(status, updated_at)` | 候选头查询明确按状态+更新时间筛选；副本 EXPLAIN/计时证明收益后纳入迁移 |
| `generation_logs(status, updated_at)` | TTL 头查询同上，finished_at 等在策略中复核 |
| `generation_logs_project_created` | 已有，数量排序复用 |
| `task_events(created_at)` | 不建立，无独立时间删除入口 |
| `episode/canvas/scene_production_operations(created_at)` | 不建立，本轮不清操作回执 |
| `tasks_status_created` | 已有，不重复建立 |

schema 迁移复用 [prepareDatabaseUpgrade](../backend/src/database-upgrade.ts) 的一致性备份和版本拒绝，事务失败可重试。实施时若版本已前进，使用下一版本并重新核验，不照抄 v32。

## 8. 文件回收和收益报告

DELETE 只释放库内页面，不能以删除 JSON 字节推算原文件必然缩小。每次报告分开测量：

- 候选行数和各列 UTF-8 字节数；后者是 payload 估计，不等于页面可回收大小。
- page_size、page_count、freelist_count；`page_count * page_size` 是分配大小，包含空闲页。
- `(page_count - freelist_count) * page_size` 是非空闲页估计，仍包含索引和页内空隙。
- 主库、WAL、SHM 和全部保留备份的实际磁盘字节。
- 压缩前后、加上备份后的净磁盘变化。

维护事务成功后，单独授权文件回收：

1. 确认实际服务/Agent/媒体空闲并关闭使用该库的连接，保留维护备份。
2. 对停写的来源 `VACUUM INTO` 新文件，验证 integrity、foreign_key、schema 和完整逻辑数据 digest。
3. 关闭维护连接，保留原库及侧文件；校验路径后通过可回滚重命名切换，不能让新库配旧 WAL/SHM，也不能对仍被打开的文件直接替换。
4. 启动授权的必要服务，核对实际消费文件、普通读取、任务/历史接口及状态恢复；失败停止必要服务并恢复原库和配套文件。
5. 保留备份，不自动删除以“实现净收益”。所需额外空间先根据备份和新文件实测尺寸评估，不新增产品大小限制。

不承诺 730 MB 降到某固定值。re-baseline 的旧测量 50–100 MB 也只是候选 payload 范围，是否能处理及最终文件收益由新计划和压缩实测决定。

## 9. 定向验收矩阵

所有数据库 fixture 使用内存或独立临时目录；CLI 子进程显式传 INFINITE_CANVAS_DATA_DIR，隔离用户 root 配置。计划探针不注入真实 Zustand Store，不写用户数据，不访问收费 provider。

| 场景 | 必须结果 |
|---|---|
| 实际 v31 schema、父子任务读取 | 使用 params_json，查询无不存在列；只读不升级 |
| 正式父任务有 bound/submitted/failed binding，成功子任务和日志超期 | 整个关联集合及事件保留 |
| 多级父子任务、循环、孤立关联、跨状态年龄 | 保护正确传播；异常拒绝或保留，遍历终止 |
| 顶层 task ID 为空但 Clip 仍绑定终态父任务 | 保留 task/log/全部恢复事件；已有恢复测试继续通过 |
| 现存节点只有 storageKey、无 generationLogId | 可供历史恢复的成功日志和任务仍保留 |
| draft/published/版本/回执/批次/共享来源任一引用 | 对应族保留，不只查当前版本 |
| 完整未引用且所有成员满足显式政策 | 任务/日志删除，事件级联，ID 凭据原子写入 |
| 一个成员较新、非终态、日期无效或状态未知 | 整族保留 |
| 501 条日志，第 501 条受保护；所有记录均保护 | 不强删；报告超过 500 及保留原因 |
| 旧 count DELETE 路径 | 写入第 501 条不会绕过策略删受保护或非终态日志；写入不扫描全库 |
| `--name=`/空白/负数/小数/重复/未知/日期溢出 | 打开库前拒绝；help 不打开库 |
| 相同 ID 清理后重发、换内容复用 ID | 拒绝 TASK_HISTORY_PRUNED，零占位/入队/provider 请求 |
| 各可直达执行器及并发 create/prune | 提前门禁+数据库防线有效；不会出现重新收费 |
| 备份后有关 task/log/root/event 同 revision 变化 | 与计划/备份指纹不符，整事务拒绝 |
| 删除途中注入 SQL 失败 | tasks/logs/events/凭据全部回滚，保护摘要不变 |
| re-baseline 当前 JSON 同 revision 改动 | 拒绝，不依赖 preview 摘要相等 |
| re-baseline batch/checkpoint/receipt 同数内容变化 | 指纹变化拒绝 |
| 缺 receipt、未来 revision、坏当前状态 | 拒绝，不以 blocked 为通行证 |
| re-baseline 正常提交 | 当前画布不变，当前 revision 可重建；旧快照不可用，但原 ID 永不重执行 |
| 压缩文件切换和回退 | 逻辑摘要一致，实际服务加载新文件，备份可恢复 |

建议新增测试：`runtime-history-policy.test.ts`、`prune-runtime-history.test.ts`、`task-history-tombstones.test.ts`、`rebaseline-canvas-history.test.ts`。入口错误映射和无副作用重放补在直接消费方已有测试中。

backend 定向命令（新增文件完成后执行，不把本清单当成已通过）：

```powershell
node --import tsx --test src/maintenance/runtime-history-policy.test.ts
node --import tsx --test src/maintenance/prune-runtime-history.test.ts
node --import tsx --test src/maintenance/task-history-tombstones.test.ts
node --import tsx --test src/maintenance/rebaseline-canvas-history.test.ts
node --import tsx --test src/canvas/history-maintenance.test.ts
```

共享错误合同、Web/Agent 或 dist 消费方受影响时读取对应 AGENTS，运行直接消费者检查并重建实际被消费的产物。测试只覆盖以上新增风险，不默认跑全仓测试/构建。

## 10. 实施顺序与交付门禁

| 顺序 | 改动 | 开放门禁 |
|---|---|---|
| 1 | 统一保留策略、只读计划/报告；写入时无保护数量删除移出 | 来源清单完整，关键族/Clip/版本/500 场景通过；数量行为调整确认后落地 |
| 2 | re-baseline 的稳定诊断、指纹和独立 CLI | 副本准入、同 revision 故障注入、备份/事务回滚及命令 ID 保留通过 |
| 3 | task ID 凭据迁移、全部生成入口门禁、API 错误消费 | 副本迁移幂等及并发/无副作用测试；API 语义确认后落地 |
| 4 | prune-runtime-history 的事务 apply | 1+3 已完成；明确保留政策；副本删除、重放和回滚验收 |
| 5 | 真实库 dry-run 和可审阅维护计划 | 只读；列出保护原因、真实候选、恢复损失及空间需求 |
| 6 | 真实库清理、压缩切换 | 用户明确授权具体计划/历史损失/服务动作；空闲维护窗口；实际加载和回退验收 |
| 后续 | 完整操作回执压缩/去重调查 | 独立方案，不裁字段，不把 published 视为不可变 |

每项按文件提交，禁止 git add -A；不合并或纳入无关工作区变更。完成实施后才更新 pending-test 和 CHANGELOG，用户确认后再归入 features。

确认项集中为具体可审阅行为：显式各状态保留期、500 从自动硬删除改为手动软目标、已清理任务返回不可重试的历史不可用错误，以及所选项目旧快照恢复范围的丢失。方案阶段不执行这些动作；实施与真实库维护分别授权，不用复制库验收代替真实库批准。

## 11. 真实库维护计划（2026-10-06 实测，只读）

基于生产库一致性快照（`VACUUM INTO`，721.9 MB，schema 32）跑
`prune-runtime-history` dry-run 的实测结果。此节只读，不写库。

### 11.1 当前库现状

| 表 | 行数 | 字节 |
|---|---:|---:|
| `tasks` | 5,662 | 138.5 MB |
| `canvas_operation_batches` | 71,227 | 130.8 MB |
| `generation_logs` | 3,711 | 37.4 MB |
| `episode_production_operations` | 311 | 280.9 MB（见 §12，receipt 另立方案） |
| `canvas_production_operations` | 50 | 28.0 MB |
| `canvas_projects` | 23 | 11.7 MB |
| `task_events` | 38,940 | 11.5 MB |
| `production_preparations` | 24 | 10.4 MB |
| `canvas_command_receipts` | 26 | 57.3 KB |
| `task_history_tombstones` | 0 | 4.1 KB（v32 已建） |

文件总占用 721.9 MB（快照）/ 770.6 MB（生产文件，含 WAL/空闲页）。

任务状态：succeeded 4,312 / failed 1,013 / cancelled 337。
日志状态：success 2,940 / failed 631 / cancelled 90 / running 42 / queued 8。

### 11.2 保留期 dry-run 候选（确认值 30/90/30 + 60/180/60）

| 项 | 数量 |
|---|---:|
| 候选任务 | **201**（succeeded 186 + cancelled 15，30~35 天） |
| 候选日志 | **0**（最早日志 9/1，未超 60/180/60 天保留期） |
| 受保护任务 | 5,461 / 5,662 |
| 完整性异常 | 86 条（任务绑定日志不存在，保守保留） |

受保护原因分布（全量 5,662 任务，可重叠）：
`referenced-by-history-batch` 2,867、`referenced-by-canvas-node` 2,791、
`protected-by-family` 1,970、`referenced-by-command-receipt` 75、
`referenced-by-production-record` 83、`has-production-binding` 4、
`referenced-by-preparation` 5、`non-terminal-status` 50。

### 11.3 诚实收益（不合并估算）

- **候选任务 201 个**：仅占 `tasks` 表的 ~3.5%（138.5 MB → 预计释放数 MB 级，非 500 MB）。
- **候选日志 0 个**：当前保留期下无超期日志，Phase 日志收益为 0。
- **DELETE 不缩小文件**：只释放空闲页；`canvas_operation_batches`（130.8 MB）和
  `episode_production_operations`（280.9 MB）不在这条清理路径内，需 re-baseline
  与 receipt 方案分别处理。
- **文件压缩**需 `VACUUM`（维护窗口执行），且 `episode_production_operations`
  的 280.9 MB 大头不在本清理范围内。

**结论**：本轮 `prune-runtime-history` 对真实库的实际收益有限（~201 任务、数 MB 级），
符合 v3「收益不明显时暂缓大动作」的原则。真正的大头是：
1. `canvas_operation_batches` 130.8 MB —— 需按项目 re-baseline（第 2 步 CLI 已就绪，22 项目全 blocked，需逐个诊断准入）。
2. `episode_production_operations` 280.9 MB —— receipt 双份/大字段，压缩/去重另立方案（§后续）。

### 11.4 第 6 步执行授权清单（未执行，待用户点头）

1. 生产库 v32 迁移已随 backend 重启自动完成（schema 32，tombstone 表已建）。
2. `prune-runtime-history --apply`：先在 §11.1 快照副本上 apply 验收（删 201 任务 + 0 日志 + 写 201 tombstone），再经授权对生产库执行。
3. re-baseline：按项目显式选择，先副本准入诊断，列出旧快照恢复损失。
4. `VACUUM` 压缩：维护窗口执行，backend 停机。
5. 每步独立提交、独立验收；不合并无关工作区变更。
