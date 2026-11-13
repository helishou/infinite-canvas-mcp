# 制作阶段与推进顺序

本文件定义画布制作的六个阶段、进度写在哪、开工怎么报、越序怎么记。它解决的是「感觉顺序乱、不严格」——**根因不是模型不听话，是过去没有任何地方记录"现在该做第几步"**：进度只活在一份人工 Markdown 模板里，每轮开工都要助手重新推断缺口，判断自然会漂。

状态自本版起存在制作稿本身：`settings.productionStage`。写用 `set_settings`，读用 `production_get`，随 revision 保存。**不要再手工维护第二份阶段状态。**

## 一、六个阶段

| 阶段值 | 名称 | 完成的判据 |
|---|---|---|
| `script` | ①剧情设计 | 当前制作版剧本已确认，场次/人物/道具清单与疑点已交用户拍板 |
| `assets` | ②资产准备 | 角色、场景、道具母资产已有可用图并登记为正式资产 |
| `spatial` | ③站位与色彩基准 | 场景空间关系、轴线与影调基准已定（见[跨段空间锚定](spatial-anchor-continuity.md)） |
| `shots` | ④镜头设计 | 正式 Shot 已拆完，时长、画内主体、连续性事实齐备 |
| `keyframes` | ⑤分镜关键帧 | 目标镜头关键帧已生成并验收 |
| `clips` | ⑥Clip 视频 | 目标 Clip 已编译、翻译并生成验收 |

阶段是**前置条件**，不是流水线关卡：已有确认内容直接复用，改特效不必回炉重走剧本。

## 二、开工第一件事：读阶段，报阶段

任何制作轮次的第一条回复，在动笔前先读 `production_get` 的 `settings.productionStage`，用一句话报出：

```text
当前在 ④镜头设计，本轮做 S02 的 Shot 拆分；①-③ 已完成。
```

- 阶段存在 → 以它为准，**不从聊天上下文或旧摘要重新推断**
- 阶段不存在（老项目/首次接入）→ 说明"尚未初始化阶段"，按实际缺项补写一次再继续，**不因缺失拦截工作**

## 三、推进：用 set_settings 写回

```json
{ "op": { "type": "set_settings", "patch": {
  "productionStage": { "current": "shots", "done": ["script","assets","spatial"], "updatedAt": "2026-11-13T10:00:00Z" }
} } }
```

- `current` 一变就要写回，不要攒到最后
- `done` 按**实际发生顺序**追加，去重，不写未验证的项
- 同一阶段内推进多个镜头/Clip 时 `current` 不变，只有跨阶段才写

## 四、越序：可以跳，但必须留理由

跳过或回退某阶段时，把被跳过的阶段直接记入 `done` 并在 `note` 写明依据：

```json
{ "current": "shots", "done": ["script","assets","spatial"],
  "note": "跳过关键帧：S02 为纯环境空镜，复用 S01 场景图直接出 Clip" }
```

这条是整套设计的取舍点：**不禁止越序，只要求越序可见**。理由是已有确认内容不该被流程倒逼重做，但"为什么跳"必须留痕，否则下一轮又要重新猜。

## 五、门禁：只拦花钱的那一步

`production_get_readiness` 会读阶段游标，按目标类型给结论：

| 目标 | 缺前置阶段时 | 为什么 |
|---|---|---|
| Clip 视频（`segment`） | **blocker**，主模型不得提交生成 | 唯一烧钱且难返工的动作 |
| 分镜关键帧（`keyframe`） | warning，不拦 | 便宜，可先试 |
| 资产图（`asset`） | warning，不拦 | 便宜，可先试 |

前置要求：`asset` → script；`keyframe` → script、shots；`segment` → script、assets、shots、keyframes（当前阶段本身不计入缺失）。

被拦时的处置只有两条：**按阶段补齐**，或 **补写 `done` + `note` 说明越序依据**。不得用旧正文、快照或聊天记录绕过。

## 六、边界

- ❌ 不用 Markdown 进度表当第二份状态源。`assets/production-progress-template.md` 只是人可读视图，**冲突时以 `settings.productionStage` 为准**
- ❌ 不在 `production.json` 之外另建阶段文件（不造第二个真值）
- ❌ 不因为阶段未推进就阻断读剧本、整理素材、试算时长这类不产生费用的工作
- ❌ 阶段名不自行扩写；新增阶段要先改本文件与 schema，不在项目里临时起名
