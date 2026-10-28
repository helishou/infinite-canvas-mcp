# MCP v3 工具迁移 / Tool migration

MCP 契约版本 3 直接移除旧名称，不保留调用别名。网页 Backend REST 路由、业务数据、运行 ID、任务 ID和操作 ID保持原有语义。

Version 3 removes the old tool names without executable aliases. Backend REST routes and stored business identities retain their semantics.

## 定向读取提效 / Efficient targeted reads

### 可选工具集与调用成本 / Optional profiles and call costs

`/mcp` 保持完整目录。新连接可选择 `/mcp?profile=canvas`、`h3`、`production` 或 `diagnostics`，显式 `profile=full` 与默认相同。工具集在初始化时固定，现有会话不能通过修改 URL 改变工具集；更换需要新连接。插件刷新保持同一选择，未知插件工具默认仅在 full 中提供。工具集选择不代替用户授权，现有客户端无需修改。

`/mcp` retains the full catalog. New connections can opt into `/mcp?profile=canvas`, `h3`, `production`, or `diagnostics`; `profile=full` matches the default. The selection is fixed at initialization, including plugin refreshes. Changing profiles requires a new connection. Unclassified plugin tools are full-only. A profile does not grant authorization, and existing clients need no changes.

`mcp_observability_report` 新增 efficiency：相同内容、相同版本的重复返回候选，确定性读取失败的相同请求重试候选，以及已终态任务的重复查询候选。分页续读、未读完正文、unchanged、运行中和待人工确认任务不会混计。完整视图给出逐工具计数。候选不能直接视为无效调用或 token 节省。

The report adds `efficiency`: repeated content/version candidates, identical deterministic read-failure retries, and repeated terminal-task queries. Pagination, incomplete bodies, unchanged responses, running tasks and confirmation waits are treated separately. Full view includes per-tool counts. Candidates are not proof of wasted calls or token savings.

累计与逐工具统计新增 UTF-8 输入/输出字节及覆盖调用数；旧历史缺少字节字段时不补造。工具级 `estimatedOutputTokens` 保留原峰值语义，并新增明确的 `estimatedMaxOutputTokens` 与 `estimatedTotalOutputTokens`。这些估值仍按字符数粗算，不是模型账单。

Aggregate and per-tool metrics add UTF-8 input/output bytes and coverage counts without inventing missing historical values. The legacy per-tool `estimatedOutputTokens` remains a peak estimate; explicit maximum and total estimates are added. Character-based estimates are not model billing usage.

### 默认精简编辑声明 / Default compact edit disclosure

新连接默认使用 `schema=compact`，可与各 profile 组合；需要原完整参数定义时使用 `/mcp?schema=full`。compact 仅影响当前工具集中提供的 `production_edit` 声明。操作名、必填字段、标量类型/枚举与请求身份保留，嵌套对象和对象数组只展示容器形状；原始完整 schema 仍在提交前校验，业务未知字段策略、幂等与回执语义不变。

New connections default to `schema=compact` with any profile. Use `/mcp?schema=full` for the original complete declaration. Compact mode only changes the disclosure of `production_edit` when that tool is present: operation names, required fields, scalar constraints and request identities remain visible; nested objects and object arrays expose container shapes. The original complete validator, unknown-field policies, idempotency and receipts still apply.

简单操作的参数已完整声明时可直接提交。复杂对象详情未知时使用 `production_get_contract(operationType)`，`patch_director_source` 可附 `includePatchFields=true`；已持有同版本合同就复用，不增加每次提交前的预检。嵌套参数被拒绝时，错误提供字段路径及对应操作的合同入口。schema 模式与 profile 一样在会话内固定，更换需要新连接。

Submit directly when the declared scalar fields fully describe the operation. Read an unfamiliar nested operation with `production_get_contract(operationType)`; source patches can request `includePatchFields=true`. Reuse known contracts without adding a preflight to every write. Nested validation errors identify the field and exact contract query. Schema mode is fixed for the session.

受控 settings 编辑中，目录及单操作声明变小，但首次查询复杂操作多一次调用；合同复用后编辑/核验的请求数和返回量相同。尚无模型端实际计费和参数正确率的对照，不据此承诺所有任务的 token 或耗时下降。

The controlled settings-edit benchmark reduces catalog size but adds one initial contract query for an unfamiliar nested operation. Reused-contract edits have the same request count and response volume. Model billing and parameter accuracy have not yet been compared; these results do not establish universal token or latency savings.

### 制作源稿字段选择 / Production source field selection

`production_get_source` 与 `production_get_version_source` 可在 sourceSection/targetIds 基础上增加 `fields`，例如 `{kind:"episode",id:"...",sourceSection:"shots",targetIds:["..."],fields:["duration_frames","camera"]}`。场次与场次历史读取使用 `view:"source"`、明确 sourceSection 和相同 fields。字段只支持顶层键，去重排序；稳定 ID 保留，未请求正文不返回。

`production_get_source` and `production_get_version_source` accept `fields` alongside sourceSection/targetIds. Scene and scene-version tools use the same selector with `view:"source"` and an explicit sourceSection. Fields select top-level keys only and are normalized as a set. Stable IDs are retained, and unrequested content is omitted.

回执通过 `partialSource:true`、`sourceFields` 与 `missingFields` 明确部分读取及缺失字段；`false`、`0`、`null` 保留。字段模式不附加画布输入、目标占用或活动返修集合。分页/分块保持原形状与完整性校验，cursor 绑定字段范围；ifRevision 只能复用相同字段/范围的已读内容。部分结果不能用于整稿替换。

Responses identify partial reads with `partialSource:true`, `sourceFields`, and `missingFields`, preserving false/zero/null. Field reads omit canvas inputs, occupancy and active-refresh collections. Existing page/chunk shapes and integrity checks remain; cursors bind the field scope. Conditional reuse requires the same fields/scope. Partial results must not replace a complete source.

省略 fields 保持旧行为。Backend 未确认已应用字段投影时返回 `SOURCE_FIELDS_UNSUPPORTED`，不会把旧 Backend 的完整源稿静默当作投影结果。该能力没有新增工具、等待或生成步骤。

Omitting fields preserves the old contract. An unconfirmed projection from an older Backend returns `SOURCE_FIELDS_UNSUPPORTED` instead of silently returning full source. This adds no tool, wait or generation step.

### 节点与 Clip 读取 / Node and Clip reads

以下参数是兼容性扩展；调用前以当前 HTTP tools/list 为准，未升级客户端继续使用原参数。

These parameters are additive. Confirm them in the current HTTP tools/list before use; existing clients keep their original behavior.

| Tool | New explicit request | Behavior / 行为 |
| --- | --- | --- |
| canvas_get_state | nodeIds + projection: summary / media / generation / full | Basic state, current media, saved configuration, or full nodes. Lightweight views omit prompts/history. 基本状态、活动媒体、保存配置或完整节点；轻量视图不返回正文/历史。 |
| canvas_get_state | includeConnections | Explicit projections omit connections by default; old requests still include related connections. 显式投影默认不带连线，旧调用仍返回相关连线。 |
| canvas_inspect | view: context | Project identity and actual selection, without a model catalog. 项目身份与真实选区，不读模型目录。 |
| h3_get_clip | segmentIds instead of segmentId | One snapshot, ordered unique saved Clip views; fields and include:runtime supported. 同快照按请求顺序去重读取保存字段/参数。 |
| h3_get_clip_runtime | view: saved | Saved parameters without preview. Omitted view or effective keeps the existing preview. 保存参数不触发预览；省略或 effective 保留旧预览。 |

Batch Clip reads reject compiled prompts, references and dynamic results; use a single segmentId with the existing targeted tools. Missing IDs are explicit. Large full reads still use the existing output limit and supported chunk/export paths.

Clip 批量读取不接受编译正文、参考或动态结果；这些内容仍用单个 segmentId 定向读取。不存在的 ID 明确返回；大正文继续沿用输出保护及既有分块/导出入口。

Use one valid H3 preview for the exact submitted scope. Production runs validate at their submission boundary. Recover unknown submissions through the original operation receipt or idempotency identity; waiting does not authorize resubmission.

H3 同范围提交复用一次有效预览；正式制作运行在提交边界校验。结果未知沿原回执或幂等身份恢复，等待不授权重新提交。

## 制作工具 / Production tools

所有统一工具显式传 `kind: episode | canvas`、`id`；不传旧 `episodeId` 或 `projectId`。场次工具保持独立。其余参数保持原样；重放复用原 operationId、版本与内容，不新建 ID。

Each unified tool requires `kind` and `id`. Replace `episodeId` with `{kind: "episode", id: ...}` or `projectId` with `{kind: "canvas", id: ...}`. Scene tools remain separate. Preserve all other arguments and existing operation, run and task identities.

| Removed episode tool | Removed canvas tool | Replacement |
|---|---|---|
| `drama_preflight_production` | `canvas_preflight_production` | `production_preflight` |
| `drama_get_production` | `canvas_get_production` | `production_get` |
| `drama_get_workflow_readiness` | `canvas_get_workflow_readiness` | `production_get_readiness` |
| `drama_start_production_run` | `canvas_start_production_run` | `production_start_run` |
| `drama_get_production_batch` | `canvas_get_production_batch` | `production_get_batch` |
| `drama_pause_production_run` | `canvas_pause_production_run` | `production_pause_run` |
| `drama_resume_production_run` | `canvas_resume_production_run` | `production_resume_run` |
| `drama_list_production_versions` | `canvas_list_production_versions` | `production_list_versions` |
| `drama_get_production_version` | `canvas_get_production_version` | `production_get_version` |
| `drama_list_production_legacy` | `canvas_list_production_legacy` | `production_list_legacy` |
| `drama_preview_production_impact` | `canvas_preview_production_impact` | `production_preview_impact` |
| `drama_edit_production` | `canvas_edit_production` | `production_edit` |
| `drama_publish_production` | `canvas_publish_production` | `production_publish` |
| `drama_restore_production` | `canvas_restore_production` | `production_restore` |
| `drama_sync_production_clips` | `canvas_sync_production_clips` | `production_sync_clips` |
| `drama_get_production_run` | `canvas_get_production_run` | `production_get_run` |
| `drama_export_production_markdown` | `canvas_export_production_markdown` | `production_export_markdown` |

```json
{"kind":"episode","id":"episode-id","view":"summary"}
```

用于 `production_get`。写操作仍需各工具规定的 operationId、expectedRevision 等；完整读取使用显式 view、定向选择、分页或分块。

Use this owner shape with `production_get`. Writes still require their declared operation and revision arguments. Request explicit views or targeted pages/chunks for complete content.

## 三个旧入口 / Three retired entry points

| Removed | Replacement | Required adaptation |
|---|---|---|
| `canvas_create_image_prompt_flow` | `canvas_create_generation_flow` | 显式 mode=image；沿用当前智能配置节点、提示词、引用顺序、位置和 autoRun 行为。 / Explicit mode=image; preserve current smart config behavior. |
| `h3_update_clip` | `h3_update_clips` | 先读取 revision；传稳定 operationId、expectedRevision 和单项 updates。不得写运行状态或结果。 / Read revision and use a stable operation ID with one update. Runtime/result fields remain forbidden. |
| `canvas_update_node_text` | `canvas_replace_text` / `canvas_apply_commands` | 先 canvas_read_text，传 documentId、expectedText；正文与标题一起改时原子提交。 / Read the document first; combine title and text changes in one transaction. |

```json
{
  "projectId":"canvas-id","nodeId":"h3-node","operationId":"unique-stable-operation",
  "expectedRevision":12,
  "updates":[{"segmentId":"clip-id","patch":{"prompt":"完整保存稿"}}]
}
```

未知响应复用同一 operationId、revision 和内容，冲突后先回读。不复用一个 ID 提交不同操作。

For an unknown response, replay the same operation ID, revision and content. Read back after conflicts; never reuse an ID for a different operation.

## 错误与历史 / Errors and history

有效 HTTP MCP 会话调用旧名称返回 JSON-RPC InvalidParams，data.code=TOOL_REMOVED，并给出替代入口。Agent /api/tools 返回 HTTP 400 与同类迁移信息。stdio 返回 SDK 标准的工具不存在错误。无效 MCP 会话仍按原协议返回会话错误。旧调用不会自动转换或执行。

Valid HTTP MCP sessions receive InvalidParams with TOOL_REMOVED migration data; Agent /api/tools returns HTTP 400. Stdio reports the SDK's standard missing-tool error. Invalid sessions retain their existing errors. Retired calls never execute automatically.

历史聊天标签和埋点保持原名称；新调用按统一名称记录，不合并或重写历史。外部脚本与已有会话中的旧调用必须迁移或重新发现工具。

Historical labels and telemetry retain their original names. External scripts and existing clients must migrate and refresh tool discovery.
