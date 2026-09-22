---
name: canvas-video-clip-production
description: 把已确认镜头与关键帧转为 MiniMax H3 等分段视频提示词和可追溯 Clip 任务，管理参考槽、动作与声音承接；用于 Clip 视频阶段，不负责静态资产建档。
---

# Clip 视频

## 依赖技能

编写 H3 提示词时使用 `h3-prompt-writer`，遵守对应模式和 `<Picture N>` / `<Subject N>` 引用规则。运行图生视频或 H3 时使用 `generate-video` 或项目现有 H3 能力。若任务要求 Motion Context 连续分段，再使用对应的 H3 连续链能力；不要默认隐式继承。

## Clip 设计

每个 Clip 开始前确认：

```text
Clip ID / 对应镜头 / 精确时长
模式 / 画幅 / 输出规格
参考槽顺序与 Picture/Subject 编号
首状态 → 单一路径的动作 → 末状态
下一 Clip 承接状态
逐字台词 / 说话人 / 语气 / 停顿 / 呼吸
环境声 / 动作音 / BGM 或明确无 BGM
上一段尾帧、上一段视频或 Motion Context 的使用理由
```

避免在首状态和动作链中重复同一动作，也不要在末状态再次要求完成同一动作，否则人物会做两遍。有承接依赖的 Clip 逐段生成；前段完成并检查人物、动作、声音和末状态后，再提交后段。

## 参考与节点提交闸门

- config 节点必须在 `metadata` 顶层有 `model`，不能只写 `params.model`。
- 多个同名 config 必须按精确 `id` 操作；修改后回读 prompt 特征和长度。
- `referenceNodeIds` 不能代替真实连线。创建或更新后回读连接数量，不足时用 `canvas_connect_nodes` 补齐。
- 提交前同时确认 `metadata.model`、prompt、参考连线、槽位顺序与精确结果节点。
- `canvas_create_config_node` 使用 `id`；通用 `canvas_create_node` 默认解析返回 ID，或用 `canvas_apply_ops` 的 `add_node.id`，不得使用尚未创建的预计 ID。
- `canvas_connect_nodes` 使用 `connections: [{ fromNodeId, toNodeId, role, order }]`；`canvas_update_node` 使用 `id`。
- 保存真实 taskId，以有界等待或短轮询查询。异常时查询原任务，不重复提交以避免重复扣费。

## 生成后回读与 Clip 验收

确认任务成功、真实视频媒体存在、时长与尺寸正确、结果写回目标节点、generation log 中参考图片/视频真实传入、节点布局未改变。记录 Clip 的模式、prompt 版本、输入、taskId、storageKey、首尾状态和声音要求。

随后立即在本 Skill 内验收，不转交独立验收阶段：

- 实际时长、画幅、可播放性和媒体完整性符合目标。
- 人物身份、服装、场景和道具没有漂移；动作从正确首状态开始并停在目标末状态。
- 没有重复动作、突然跳位、错误转身、越轴、穿模或无因出现/消失。
- 台词归属、口型、情绪强度、语速、停顿、呼吸、环境声、动作音和 BGM 要求成立。
- Clip 末状态可承接下一段，上一段尾帧、视频或 Motion Context 的实际输入可从日志确认。

使用 `accepted / needs-redo / waiting-user / blocked-upstream` 记录结论。返修只重跑当前 Clip 及必要的下游承接，不重跑已通过片段；同一问题连续失败两次后返回关键帧、镜头设计或参考输入排查。若用户要求每段先看，生成并自检一个 Clip 后标记 `waiting-user`，等待确认再继续。全部目标 Clip `accepted` 后，直接把已确认版本和素材位置汇总给用户，流程结束。
