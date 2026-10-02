# 面部表演与微表情（Clip 视频阶段）

用于 H3 Clip 提示词中的人物面部表演、情绪强度和笑容控制。目标：避免"AI frozen-face"、露齿大笑、假笑、眼神锁死镜头和面部 morphing。

来源与可信度：整理自 Hailuo AI 官方知识库（Prompting & Workflow / Physics & Realism / Social & Formats 栏目，2026-07 更新）四篇 facial micro-expression 指南，以及 MiniMax H3 官方提示词规范和 README 示例。**这些文章是 Hailuo 自家创作团队的 workflow 经验，不是 H3 的官方提示词规范，也没有第三方对照实验**；其中量化结论（4-6 秒稳定性、3 次重摇、形容词降低 30-40% reset）均来自他们自述的内部测试，跨模型迁移时只作方向参考，不要当验收阈值。官方 H3 格式规范 `h3-prompt-writing` 始终是格式唯一权威，本文件只管表演内容，不改字段名和结构。

同一批文章里与本文件直接相关的还有 `control-eye-contact-ai-video-brand-hooks`、`directing-micro-expressions-cinematic-ai-close-ups`、`director-mode-ai-character-emotions`、`prompting-ai-actors-conflict-subtext`、`mastering-ai-reaction-shots`、`prompting-subtle-motion-ai-video`、`ai-video-motion-intensity-control`。完整清单与检索方法见 [官方知识库索引](hailuo-kb-index.md)。

## 0. 先诊断根因，再改提示词

按顺序排除，不要一上来就加禁令：

1. **参考帧表情不对**：图像会把情绪基线锁死。分镜帧/角色卡如果本身在露齿大笑或表情夸张，文字写多少"不要笑"都会被拖回该基线。→ 换中性基线参考帧，或把该表情单独拆 Clip。
2. **单段塞了多个情绪转折**：转折超过两个就容易 morphing（五官融化/重置）。→ 拆 Clip，或只保留一个转折。
3. **段太长**：面部结构漂移随时间指数上升。面部特写优先 4-6 秒，10 秒镜拆成两个 5 秒反应镜再在剪辑里接。
4. **提示词膨胀**：禁令越多越糟，见下。

## 1. 减法原则（核心）

- **副词优先于动词**：`smile` / `laugh` / `look` / `talk` 是高能量动词，会直接调用训练数据里的峰值表情模板（露齿、对称、幅度大）。改用状态类词：
  - 不写 `smiling` → 写 `faintly amused`、`a glimmer of a smile`、`a soft, welcoming expression`
  - 不写 `looking` → 写 `a lingering gaze`、`attentive eyes`、`gentle eye contact`
  - 不写 `talking` → 写 `softly articulated`、`subtle lip movements`
- **负向禁令是反效果**：连续堆叠 `no teeth` / `no smile` / `never opens mouth` 会造成 prompt bloat——注意力被冲突指令打乱，反而产生"crying and laughing"式的混合怪相。只在需要硬边界时保留一条最关键的排除（如 `no subtitles, no watermark, no extra text`），表情靠正向描述控制。
- **一次只给 1-2 个面部信号**（Hailuo: Primary + Secondary Rule）。同时指挥眉/眼/鼻/颏/唇/笑会互相矛盾。选一个主情绪 + 一个次级微表情，其余交给呼吸、体态、视线。
- **不要逐块肌肉点名**（frontalis、corrugator、nasalis 之类），官方明确说这会产生 noise 和面部扭曲。只用可观察的外观描述。
- **转折用连接词**：`gradually shifts into` / `evolves from` 代替 `and` / `同时`。不要用 `simultaneously`。
- **加 `slow`**：转折太快会像 glitch；`slow` 让模型分配足够帧给肌肉运动。
- **表情不超 1 秒定格**：任何单一表情停留不超过一秒，否则读作"摆拍"。

## 2. 笑容的写法

真人笑的可信度来自眼周参与，不来自嘴。AU12（嘴角上扬）单独出现而无 AU6（眼轮匝肌收缩）就是"面具脸"，观众立刻判假。

- 优先写眼：`lower eyelids lift slightly`、`gentle eye-narrowing`、`a soft glint of recognition`、`the gaze steadies and warms`
- 嘴角只给一个极轻的次级信号：`a slight corner-of-mouth twitch`、`the faintest softening at the corners of her mouth`、`lips softly together`
- 想让笑落地，用官方 README 的时序写法：先说完话，话音刚落嘴唇合上，**then** 表情才起。官方示例原文：`Exactly as his voice stops, her lips meet in a relaxed, peaceful smile, and her jaw ceases speaking motion.`
- 闭嘴控制：写 `closed lips` / `lips softly together` 这类正向短语；Hailuo 的 "Mouth-Breather" 条目明确说持续微张的嘴需要用 `closed lips` 或下颌线明确的参考图来压。不要同时要求"说话"和"嘴唇闭合"——两者冲突，模型会让说话优先。想全程闭嘴就把台词改成画外音（官方语法：`says in an off-screen voiceover` + `while her lips remain completely closed`）。
- 露齿笑根本没法治。`smile` 一旦出现，露齿是默认结果；"闭嘴笑"只能靠不写 smile + 眼部主导 + 话音后再起。

## 3. 眼神与视线

- **锁死镜头是恐怖谷的主要来源**。第一人称 POV 尤其严重：角色直视摄影机时，观众同时是主角和被看对象，视角关系崩掉。规则：角色看向画外的你，不看镜头；给具体落点（`looks at the Rover's collar rather than the eyes`、`gaze drops to the flower then returns`），不要写 `looks at camera`。
- `steady gaze` / `gentle eye contact` 压住 "Eye-Dart"（快速眼动 = 提示词运动强度过高）。
- 眨眼自然不规则；不要定时或密集。
- 情绪落点后给一个留白动作（低头看台阶、呼气、视线移开），比"抬眼看人微笑"自然。

## 4. 遮蔽恐怖谷的检查项

在用户授权质量检查时逐项核对，缺一项即为不可用：

- 眼-口同步：AU6 与 AU12 的时间是否对齐（只动嘴不动眼 = 假）
- 视线：有没有直视镜头；瞳孔是否抖动
- 面部网格：下颌线、耳朵在运动中有无重影/融化
- 阴影稳定性：面部阴影是否跟着特征走，有没有"漂浮"
- 皮肤纹理：毛孔和细纹在整段内是否连续
- 呼吸/吞咽：非语言人声是否可见

## 5. 情绪转折的节拍模板

单转折用四段式，一段 Clip 只跑一次：

```
基线：面部沉静，目光平稳，肩部放松，嘴唇自然闭合。
触发：她听到画外回应 / 视线落在某物上，短暂停顿。
反应：眼神先变化（主），嘴角一侧极轻地动（次），伴随一次浅呼吸。
平复：缓慢呼气，回归沉静，目光里仍留一点余韵。
```

台词按播放顺序写在触发点两侧；对白进行中只允许"无声反应"（listener 动作），回应台词放在反应之后的停顿里。口型同步要求与情绪反应分开写，不要在同一句里既要求说话又要求表情转变。

## 6. Pitfalls

- **把禁令当解决方案**：反复追加否定约束是本工作流最常见的失败模式，只会越来越糟。
- **在笑的同时要求闭嘴说话**：不可执行，模型必然让说话赢。要么错开时间，要么改画外音。
- **参考帧是极端表情**：用大笑/皱眉帧当主参考，锁死后几乎无法微调。专业做法是维护"表情库"，按 neutral-positive / neutral-pensive 等基线分类存中性图。
- **角色特写做 10 秒**：面部 morphing 概率显著上升。拆段，尾帧/末帧作为下一段参考。
- **每镜换光线措辞**：`soft window light` 改成 `overcast window light` 就可能改变阴影深度、断掉连续性。把光线写成固定的 Global Lighting Block，逐字复制到每段。
- **换 seed 当作调参手段**：换 seed 是筛选，不是控制；先把参考帧和动作链改对再摇。
- **把 Hailuo 的量化结论当 H3 的验收标准**：那些数字来自 Hailuo 自家 I2V/S2V 引擎的内部测试，H3 上的表现需要自己实测确认。
