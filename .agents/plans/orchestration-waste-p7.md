# P7：编排浪费治理（调用次数、决策路径与失败语义）

状态：设计稿，未实施。本文档不含已上线声明。
范围：MCP 工具契约与执行语义。不改业务编辑、生成参数、质量授权、并发上限与数据库格式。
与既有关系：`mcp-efficiency-design.md` 的 P0–P6 处理「单次返回多大」，本文档处理「读多少次、读来干什么、失败怎么处置」。两者互补，不重复。

## 1. 问题定义：三类浪费

依据 2026-10-28 一次完整快闪 PV 的实测（同一画布 `7PH4RT1U7lkBtCFjl9o8E`，同一 MCP 会话）。

| 类型 | 实测 | 浪费形态 |
| --- | --- | --- |
| 重复读取 | 177 次调用中 67 次是纯读取校验：`h3_get_clip` 17、`canvas_get_state` 17、`canvas_task_status` 20、`canvas_image_input_manifest` 13 | 同一目标反复确认，且每次都要一轮推理 |
| 等待空转 | 16 次 `canvas_wait_tasks` 累计约 160 s/次；其中任务 47 s 完成却等满 240 s | 等待不跟随任务完成时刻返回 |
| 假失败放大 | 当晚 8 个版本，所有 `status=failed` 的 `error` 字段均为 `spawn ffprobe ENOENT`；模型一次未真失败 | 视频已生成、规格正确（复测 `passed`，1088×1920），却被判失败，触发整轮重做 |
| 编排空转 | 一次 PV 主线程无工具空档 113 分钟，占 65% | AI 在 sleep 与轮询里等，不产出决策 |

结论：**慢的主体不是生成，也不是画布或传输，而是「看不到成功」与「没有收口机制」。** 生成侧工具耗时全部在 0.01–0.12 s，不构成瓶颈。

## 2. 为什么规则没拦住

仓库已有 `native-mcp-operation-budget.md`（174 行，含合批读、一次收口、不重复查状态、不重提生成）。当晚仍然发生 67 次读取与 5 轮被误导的重跑。

原因不是规则写得不够细，而是**规则是劝告，不是约束**：执行时只看到当前一步，规则在上下文里被稀释；遇到 `failed` 时按训练惯性去改内容，而不是回头查规则。

因此本文档只收「机制」，不收「劝告」。判据：**如果一个措施不能改变工具行为或返回结构，它就不属于本文档。**

## 3. 设计原则

1. 机制优先于劝告：能让错事做不到的，才写进契约。
2. 只给现有工具加参数，不新增平行工具；唯一例外是 `canvas_next`（第 5 节），因为它承载的是「跨工具的阶段裁决」，现有工具语义无法承载。
3. 新行为全部显式 opt-in，默认行为与现在完全一致。
4. 不引入通用缓存层、自动重试、读取锁、新状态机。
5. 错误必须可执行：带 `code`、可选 `fix`，以及与「是否值得重试」有关的明确判定。

## 4. 机制一：失败语义分级（error taxonomy）

### 4.1 现状

`error` 是自由字符串。`h3-execution-contract.ts` 在探测失败时曾返回 `specification.status='mismatch'`（已于 `23255bc6` 改为 `unverified`），但上游仍只能读到一句文本。调用方无法区分「环境缺工具」与「内容不合规」，只能猜——当晚就猜成了内容问题。

### 4.2 契约

错误回执附加结构化字段，原有字符串字段保持不动：

```json
{
  "error": {
    "code": "MEDIA_TOOL_MISSING",
    "message": "ffprobe 不可用，媒体规格无法核验",
    "scope": "environment",
    "fix": { "summary": "配置 ffmpeg 目录", "file": "backend.json", "key": "mediaTools.ffmpegDir" },
    "doNotRetry": true
  }
}
```

`scope` 与处置：

| scope | 典型 code | doNotRetry | 允许的后续 |
| --- | --- | --- | --- |
| environment | MEDIA_TOOL_MISSING、BACKEND_UNREACHABLE、MODEL_FILE_MISSING | true | 按 `fix` 修配置；**不得重提生成** |
| input | INVALID_INPUT、MISSING_PROJECT、SCHEMA_MISMATCH | true | 修正参数后作为新意图提交 |
| conflict | REVISION_CONFLICT、TARGET_BUSY | false | 定向回读后重算，不换 ID |
| transient | PROVIDER_5XX、TIMEOUT、SOCKET_CLOSED | false | 沿原幂等身份恢复 |
| content | SPEC_MISMATCH、REFERENCE_UNBOUND、PROMPT_INVALID | true | 改输入后新开 runId |

### 4.3 落地

- 在 MCP 错误映射层统一构造，不在各 dispatcher 手写字符串（沿用第 7 节「内部共享构造函数」）。
- `unverified`（无法核验）不产生错误，只在结果里标注；只有 `content` 级的真实不符才阻止回写。
- 不改 HTTP 状态码语义；新字段仅附加。

### 4.4 验收

注入 ffprobe 缺失：首次失败即返回 `doNotRetry=true`，同一 run 内不出现第二次相同提交。

## 5. 机制二：阶段级唯一裁决（`canvas_next`）

### 5.1 为什么需要

67 次读取中约一半是「下一步查什么」的自我确认。AI 没有跨工具的阶段状态机，只能靠反复读取重建当前状态。第 7 节已有单工具 `suggestedAction`，但它回答的是「这个调用失败了怎么办」，不回答「整条生产现在缺什么」。

### 5.2 契约

```json
{
  "projectId": "<id>",
  "runId": "<可选；缺省按项目最近一次生产>",
  "view": "compact | full"
}
```

返回：

```json
{
  "stage": "identity | scene | clip-plan | clip-run | deliver",
  "revision": 239,
  "settled": { "identity": true, "scene": true, "clipRefs": false },
  "blockers": [
    { "code": "REFERENCE_UNBOUND", "target": "clip-1", "fix": { "tool": "h3_bind_references", "args": { } }, "doNotRetry": true }
  ],
  "nextAction": { "tool": "h3_bind_references", "args": { }, "why": "clip-1 无角色参考" },
  "humanReview": [ { "storageKey": "image:…", "reason": "角色身份锚点，必须目视" } ],
  "budget": { "reads": 2, "writes": 0, "limit": { "reads": 6 } }
}
```

约束：

- `nextAction` **只允许一个**。有多个候选时按阶段优先级取一个，其余进 `blockers`。
- `settled` 是账本：`{gate: {revision, fingerprint}}`。revision 未变则保持已确认，不重算。
- `humanReview` 只列确实需要人眼的锚点（角色资产图、场景母图、成片抽帧），不列全部产物。
- `view: compact` 不返回任何正文与历史，只有身份、计数、裁决。

### 5.3 内部聚合（一次快照）

`canvas_next` 在一次项目快照上派生全部判定，禁止在实现里循环调用 N 次完整项目读取：

| 判定 | 数据来源 | 是否必读 |
| --- | --- | --- |
| stage / revision | 项目目录 summary | 必读 |
| 角色/场景就绪 | 活动媒体身份（权威选图逻辑） | 必读 |
| 参考绑定 | Clip 已保存引用摘要 | 仅 clip 阶段 |
| 提交前置 | 复用 `h3_preview_run` 的同一计算，不重跑 | 仅提交前 |
| 任务状态 | `canvas_task_status(taskIds)` 批量 | 有在途任务时 |

### 5.4 账本边界

账本只消除「同一 revision 下的重复确认」，**不替代**并发与冲突校验。任何写入仍走现有 revision 校验；检测到并发编辑即整条 `settled` 失效。

### 5.5 不做

`canvas_next` 只给建议，不自动执行。授权与提交边界不变，不得把它做成隐式生成入口。

## 6. 机制三：重复读取短路（`ifChanged`）

### 6.1 依据

第 9.1 明确「暂不新增读取缓存服务……目标级内容哈希条件读取仅在证明无关修订造成大量重复全文后，再以现有源哈希为基础单独设计」。本次实测已满足该触发条件：同一 manifest 读 13 次、同一节点 `get_clip` 17 次、`get_state` 17 次。

第 9.2 已埋 `requestFingerprint` / `readScopeFingerprint` / `contentFingerprint` / `unchanged`，缺的只是「短路返回」这一行为。

### 6.2 契约

读取类工具新增可选 `ifChanged?: string`（上一次返回的 `contentFingerprint`）。命中时：

```json
{ "unchanged": true, "contentFingerprint": "<fp>", "revision": 239, "bytes": 0 }
```

不返回正文。未命中或未传参时，行为与现在一致，并在回执里附带 `contentFingerprint` 供下次使用。

### 6.3 适用范围

| 适用（静态内容） | 不适用（动态查询） |
| --- | --- |
| `canvas_get_state`（带 projection） | `canvas_task_status` |
| `h3_get_clip`（fields / include:runtime） | `canvas_wait_tasks` |
| `production_get_source`（fields） | 生成结果、任务历史 |
| `canvas_image_input_manifest` | `models_list`（按会话固定） |

动态查询不参与短路：任务状态按定义一直在变，返回旧值比多读一次更糟。

### 6.4 不做

- 不做服务端读取缓存（不保存正文，只比较指纹）。
- 不自动跳过：必须显式传 `ifChanged`，避免把「用户要求再确认一次」误判成重复。

## 7. 机制四：等待折叠（submit-and-collect）

### 7.1 契约

提交类工具新增 `wait?: 'none' | 'all'`，默认 `none`（与现在一致）。`wait: 'all'` 时内部轮询至本批全部目标终态，一次返回：

```json
{
  "taskIds": ["…"],
  "status": "succeeded | partial | timeout",
  "outputs": [ { "taskId": "…", "storageKey": "video:…", "width": 1088, "height": 1920, "durationMs": 5167, "specification": { "status": "passed" } } ],
  "pending": [],
  "blocked": [ { "taskId": "…", "code": "SPEC_MISMATCH" } ]
}
```

适用入口：`h3_run_all_clips`、`canvas_generate_image_batch`、`canvas_generate_image`。

### 7.2 约束

- 内部轮询事件流优先，退化为轮询时 `pollMs ≤ 10000`；不产生 N 次 `task_status` 调用。
- 不改变既有超时、并发与队列语义；超时返回 `pending` 并保留原任务，不重提。
- `partial` 时失败目标不自动重试；按第 4 节 `scope` 判定是否值得新意图。
- 产物规格来自 `media_files`（`23255bc6` 后视频归档即写入宽高与时长），不额外 probe。

### 7.3 收益

当前「提交 + 等 + 逐段查 + 再核验」至少 4 次调用、每段一轮推理；折叠后 1 次调用、1 轮推理。多段时线性变常数。

## 8. 通用性：三层归属

| 层 | 内容 | 落点 | 可推广性 |
| --- | --- | --- | --- |
| ① 通用机制 | 失败分级、阶段裁决、读取短路、等待折叠 | MCP 工具（本文档） | 任意生成任务：短剧、广告、商品图、TTS |
| ② 可复用模板 | 角色资产链、场景降级链、参考顺序门禁 | 独立 skill，供多 skill 引用 | 任意人物/场景 |
| ③ 专属内容 | 势能周期、擦边手法、六段式、发布坑 | `character-flash-pv` 等具体 skill | 不推广 |

判据：与具体角色/剧情/画风无关的进①；与人有关的进②；与作品有关的留③。

## 9. 验收

### 9.1 夹具（沿用 10.1 的 A–I，新增）

| 场景 | 操作 | 必须证明 |
| --- | --- | --- |
| J 假失败 | 注入 ffprobe 缺失后提交一次 H3 | 首次失败带 `doNotRetry=true`，同 run 无第二次提交 |
| K 重复读取 | 同目标同投影连读两次，第二次传 `ifChanged` | 第二次返回 `unchanged`，字节近 0，不夹带正文 |
| L 阶段裁决 | 一次 `canvas_next` 覆盖 A+B+E 所需信息 | 调用数 1，`nextAction` 唯一且 schema 合法 |
| M 等待折叠 | 两段 H3 以 `wait:'all'` 提交 | 一次调用返回两段产物与规格，无 `task_status` 追加 |

### 9.2 指标（对照同一份 PV 实测基线）

| 指标 | 基线 | 目标 |
| --- | --- | --- |
| 一次 PV 的 MCP 调用 | 177 | ≤ 40 |
| 其中纯读取校验 | 67 | ≤ 10 |
| 单任务等待耗时 | 240 s（空转） | ≈ 生成时长 |
| 假失败触发的重跑 | 5 轮 | 0 |
| 主线程无工具空档 | 113 min | ≤ 5 min（需 skill 侧配合，非本方案单独可达成） |

百分比只用于受控夹具验收，不新增生产大小、数量或时间上限；不把夹具结果写成真实任务实测。

## 10. 实施拆分

| 阶段 | 工作包 | 涉及位置 | 独立交付条件 |
| --- | --- | --- | --- |
| P7a | 错误分级与 doNotRetry | MCP 错误映射、各 dispatcher 的抛出点、`h3-execution-contract` 的 unverified 汇总 | 场景 J 通过，旧字符串消费方不受影响 |
| P7b | 等待折叠 | `h3_run_all_clips`、`canvas_generate_image_batch`、等待实现 | 场景 M 通过，`wait:'none'` 行为逐字段不变 |
| P7c | 重复读取短路 | 共享投影、`canvas_get_state`、`h3_get_clip`、manifest | 场景 K 通过，未传 `ifChanged` 时字节与现在一致 |
| P7d | `canvas_next` | 新工具、阶段判定、账本、`nextAction` 构造 | 场景 L 通过，`nextAction` 全部通过目标 schema 校验 |

顺序建议 P7a → P7b → P7c → P7d。P7a 单独就能消灭「假失败重跑」，是性价比最高的一项。

## 11. 风险与不做

- 不做通用读取缓存、自动重试、隐式生成、新状态机、DB 迁移。
- `canvas_next` 的账本不替代并发校验；并发编辑必须让 `settled` 失效。
- 短路不能用于任务状态与结果——旧结果比多读一次更危险。
- 每阶段都必须保留旧基线，不能用「简单夹具 vs 历史峰值」充当降幅证明。

## 12. 回退

全部参数 opt-in，不传即现状。新增字段（`contentFingerprint`、`error.scope`）是附加信息，旧消费方忽略即可。回退不清理埋点、不改媒体与任务记录。
