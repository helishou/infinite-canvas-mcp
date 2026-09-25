# 画布数据与任务契约

触发：修改或操作画布持久数据、同步、生成、任务回写、媒体与参考。浏览器、Backend、MCP、Agent、插件均遵守；不按代码所在目录例外。

## 权威与写入

| 数据 | 权威 | 调用方可以做什么 |
|---|---|---|
| 项目、资产、生成记录、结构化业务配置 | Backend SQLite | 经现有 API/service 读取与变更 |
| 原始图片、视频、音频和文件 | Backend 媒体目录 | 按 storageKey 解析、引用、下载 |
| 待确认编辑、冲突草稿、恢复标记 | 浏览器持久 outbox | 按命令生命周期保留，不能作缓存丢弃 |
| 视口等纯视图状态、渲染副本 | 客户端 | 按现有策略缓存 |
| 光标、选区、拖动预览 presence | `/canvas/realtime` WS 内存通道 | 不写项目 JSON/SQLite，不增加 revision |

已有画布持久编辑统一走 ops。外部入口 `/canvas/projects/:id/ops` 携带稳定 operationId、expectedRevision 与 source.clientId/kind/label；Backend 内部复用 `stores.projects.applyOperations`，不必回环 HTTP。SQLite 事务完成幂等与 revision 后，广播同一份 delta。不得直接写库、整图覆盖或独立补造记录来绕过该链。

打开中的画布收到 Backend revision 后采用 Zustand 已合并的内存快照；不能另绕异步 Promise 使有效更新被 UI version 防护丢弃。

## 本地命令、并发与恢复

1. 在编辑动作入口捕获本次 before/after 的细粒度 ops，作为不可变命令独立落盘；网络发送时不能对整图快照重新求差分来猜意图。
2. 远端到达时，对队列逐条检测冲突并重放到新基线，不能覆盖未确认编辑。
3. 已发送但未确认时，先用原 operationId、原基线、原 ops 取回执；不能换 ID 重提来赌成功。
4. 确定性拒绝保留草稿并停止自动重试。同一不可变快照的确定性 400 只提交一次，记录脱敏的操作类型、目标 ID、拒绝原因，SSE/store 更新不得复活重试。
5. 冲突记录包含 conflictTargets 和 remoteProject。只有用户明确选择后，才在远端新基线上以新 ID 重提或丢弃意图；先持久化替代/丢弃标记，再清理旧记录，刷新不能复活旧命令。
6. `delete_node`、`delete_connections`、`delete_h3_segment` 的目标已不存在时返回 skipped；正常竞态 no-op 不报 400。

复制标签页会继承 sessionStorage。不能将其中的 owner 直接视为独占身份；应用及测试入口须先完成草稿会话认领，再导入读取 outbox 的 Store/编辑器。恢复其他会话前再次检查排他权限；未取得权限时保留记录、禁止自动重放，不靠经过多久推断旧窗口关闭。

## 生成任务

- 所有画布生成经 Backend 统一任务服务，来源可以是网页、MCP、Agent 或浏览器模型；调用方提交源节点和输入，Backend 在任务绑定事务中创建结果占位、槽位与连线。
- 已有结果槽重试或明确 writeBackToTarget 可以原位回写；调用方不得为了看见产物另造结果 ID、位置或状态。
- 自定义模型脚本、Backend 尚不能无头执行的浏览器渠道，先创建 `canvas-browser-script` 权威任务并绑定节点，再由窗口唯一 workerId 原子认领。
- 浏览器只返回已归档媒体 key 或文本，由 Backend 校验归属并写终态。用户脚本不得转移到 Node new Function/vm；Backend 重启后不自动重跑已认领任务，避免重复请求和扣费。
- 面板连接状态不是业务能力可用性的门槛；使用当前 Backend/Comfy 端点解析器。相似路径可能属于不同实现，先确认前缀和处理进程。
- 提交、等待和恢复以精确 taskId 为准；生成输入改变后，旧结果仍对应旧输入。请求成功、文件存在或页面显示 success 均不能代替本轮结果证据。

## H3 字段与引用

- H3 runtimeTaskId、status、进度、结果、结果历史由 Backend 独占。`diffCanvasProject` 只提交提示词、参考、布局等允许的用户编辑字段；旧页面快照不能覆盖 Backend 运行数据。
- Clip 编辑真值为 referenceBindings；Backend 在 ops 中通过 canonicalizeH3References/registerH3ReferenceAssets 规范化并登记目录，前端不另启 reference-sync/write-coordinator。
- 绑定使用 nodeId + segmentId + bindingId 定位；label、role、tags、subjectId 属于绑定上下文。同 assetId 可被不同 Clip 赋予不同语义，复制 Clip 后相同 bindingId 也须区分。
- 旧 refs/refItems 只在受保护迁移边界处理；先备份，无法完整迁移或冲突时拒绝丢弃。媒体源与 assetId 冲突不能静默覆盖。
- 参考连线与标签不证明实际生效；生成验收核对编译顺序、输入快照/日志与真实 provider/workflow 输入。
- 恢复历史输出须核对项目、节点、片段、日志和媒体，再经 Backend 支持的恢复操作。删除活动 Clip 不等于删除历史任务或归档媒体。
- SQLite created_at 的时间查询使用同格式 ISO 参数；无效时间表达式导致的空结果不能作为“没有写入”证据。

## 媒体与执行结果

- MEDIA_DIR 独立于 ComfyUI 安装目录；ComfyUI 只用执行缓存，输出归档回 Backend。迁出旧耦合目录先备份、复制并校验，再切换索引，保留原文件。
- WebP 缩略图仅为浏览器本地可丢弃渲染缓存，不进入节点、媒体记录、导出或模型参考；下载、编辑、生成、导出始终解析原 storageKey。
- ComfyUI 结果必须对应本轮精确 promptId，且最终媒体非空。禁止扫描 history 取最近成功记录补结果，时间接近不是任务身份证据。
- 取消、重启恢复与失败归档都保留父子任务关联。history/WS 无法确认输出时保留证据，不由前端猜测回填。
- 大段 prompt、参考和工作流快照放已有日志/任务数据中按需读取，不在每个节点和结果里反复复制。

## 受影响契约的验收

按改动选择重复提交、重复删除、并发窗口、远端重放、拒绝熔断、刷新恢复、任务取消/重启等场景；验证原用户意图与原数据仍可恢复。业务成功要有任务、日志、归档媒体和活动结果绑定的完整对应，不能只看单层状态。
