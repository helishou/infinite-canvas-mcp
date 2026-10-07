# MCP v3 工具迁移 / Tool migration

MCP 契约版本 3 直接移除旧名称，不保留调用别名。网页 Backend REST 路由、业务数据、运行 ID、任务 ID和操作 ID保持原有语义。

Version 3 removes the old tool names without executable aliases. Backend REST routes and stored business identities retain their semantics.

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
