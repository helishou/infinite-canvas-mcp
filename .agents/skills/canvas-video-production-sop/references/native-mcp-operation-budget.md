# 原生 MCP 操作预算

## 一、适用与优先级

用于画布生产操作提速，不改变剧情、生成参数、质量检查授权或并发保护。
原生入口门禁优先于旧文档中的脚本建议和整图快照建议。
本地脚本只允许离线准备、测量和媒体处理，不调用画布服务。

## 二、标准执行批次

1. 集中读取本轮实际需要的 schema；本轮已确认且未变化就复用。
2. ID 未知先一次 h3_get_node；已知则直接定向读 Clip。
3. h3_get_clip 用 include 一次读取本次需要的 prompt/references/runtime。
   多个独立 Clip 读取在同一轮通过 parallel 调度，不串行拆成 N 轮。
4. 用读取结果离线准备所有 patch；完整 prompt 不用摘要或占位符代替。
5. 同一 Clip 的关联字段合到一次写入。共享项目跨 Clip 写入串行。
   同一 H3 节点的多个已有 Clip 配置，实时 schema 提供 h3_update_clips 时，
   按 §六合为一次原子批量提交；不是并行调用 N 次单段写入。
   未注册或语义不适用时用已注册单段工具串行，不切换脚本客户端。
6. 简单配置修改结束后集中定向回读。复杂引用变更、活动任务、并发编辑、
   CAS 冲突或部分成功时立即定向回读受影响目标，再重算后续操作。
7. 任务等待用精确 taskId、有界等待；未结束时查原任务，不重提生成。

## 三、不必要操作

普通改字段不扫描源码，不重新定位同一个工作目录，不重复加载整套规范。
只读查询失败先核对 schema、参数、精确目标，不能立即升级为代码修改。
已有明确目标不调用无过滤 canvas_export_snapshot 或素材全库列表。
canvas_get_state 默认目录与 nodeIds 定向完整 metadata 不是同一种返回成本。
有 spillover 时本地处理已保存结果，不重请求远端相同全量报告。

## 四、核验不得削弱

小回执的 updatedFields 只证明操作范围，不证明字段值与期望一致。
结束前回读所有目标实际字段、引用身份及历史/本轮结果来源。
核对创建节点时比较完整节点 ID 目录即可，不为此载入全图 prompt/媒体。
不要并行写共享 revision；不靠永久缓存跳过并发核对。
角色组仍走专用验证工具，不能用通用 op 手拼派生 binding 逃避验证。
用户未要求质量检查时只做技术性收口，不默认看片、评分和返修。

## 五、固定复测

使用六个已存在、空闲、无引用变更的测试 Clip，各改一组关联配置，不生成。
记录 schema 发现轮、初始读取轮、六次串行写、末尾核验轮及实际错误。
目标是去掉冗余轮次，不保证固定墙钟秒数，不把等待生成算成写入延迟。
至少三次同模型复测；测量分别列工具时间、轮间间隔、输出大小和未匹配回执。

## 六、H3 已有 Clip 原子批量配置

- 先通过本轮 `tool_describe` 确认 `h3_update_clips` 的注册及 schema。源码声明、插件版本、独立 stdio 探针都不能代替当前 Hermes 的 HTTP 工具可用性。
- 同一 `projectId`、同一 H3 `nodeId` 下的已有 Clip 用 `updates: [{segmentId, patch}, ...]`，每批 1–100 项、不允许重复 `segmentId`；单段关联字段合在一个非空 patch 中。不能用它创建 Clip、启动生成或修改角色组及后台运行/结果字段。
- 已读取 revision 时传 `expectedRevision`。即使省略，服务端仍在整批预检后按其读取的 revision 严格提交一次事务；不自动 rebase。任一目标无效、引用编译失败、活动任务/任务绑定或版本冲突，整批拒绝。节点级参数投影按输入顺序逐字段最后写入生效。
- 返回 `atomic`、`revision`、`count` 和按输入顺序排列的 `items`，不返回整图。`values` 是提交后读取的短值；长文本/对象使用 `fieldSummaries`，其 `sha256` 对 **JSON.stringify(value)** 的 UTF-8 字节计算，`bytes` 是该序列化值的字节数。完整字段需要时仍定向回读，不拿 `updatedFields` 当值核验。
- 明确的整批预检/事务拒绝与未知网络结果分开：拒绝后核对 revision 和目标字段再重算；超时、断连或回执不完整时不能假定没有提交，先定向回读，不整批盲重跑。
- 不为上线工具自动重启 Backend。须有本轮授权并重新确认没有 queued/running/awaiting_confirmation 任务；有任务则停止重载，不取消、不改状态。HTTP Backend 加载新声明后，仍需验证 Hermes 当前目录能发现工具；不可临时改成 stdio/脚本生产入口。

以下仅为参数形状示例，ID 和 revision 必须替换成本轮真实读取值，不直接发送：

```json
{
  "projectId": "<当前项目ID>",
  "nodeId": "<当前H3节点ID>",
  "expectedRevision": 9,
  "updates": [
    {"segmentId": "<当前Clip-ID-1>", "patch": {"title": "片段一", "duration": 7}},
    {"segmentId": "<当前Clip-ID-2>", "patch": {"title": "片段二", "duration": 7}}
  ]
}
```
