# 快闪镜头模板（8 秒 8 镜 · 势能周期 · 迷人派生）

适用：竖屏快闪 PV 的单个 Clip。Ref2VA、9:16、2.0 MP、丝袜 LoRA 0.5。本模板只负责 `detailed_description` 的镜头/动作/切镜组织与迷人手法；`subject_definitions`、`summary`、`retention_analysis`、`overall_soundscape`、`non_diegetic_music` 仍按 `../acheng-director/modules/model/h3-prompt-writing/references/ref-en.txt` 的六段式与标签规范撰写，此处不重复。

## 1. 势能周期（核心规则）

**卡拍 ≠ 有势能。** 一个切点要“爽”，它释放的必须是**已经蓄满的动能**，而不是等距掐表把动作拦腰掐断。每个 1 秒镜头是一个**势能周期**，两个阶段严格对齐音乐整秒重音：

- **蓄力（重音前 ~0.5 秒内完成）**：把张力拉到顶。可用手段——静帧定格、镜头推近、眼神锁定镜头、衣料/发丝绷紧、一个将发未发的动作、光斑/粒子收拢到主体。
- **释放（正好落在整秒重音那一帧切走）**：泄洪口。可用手段——爆发、甩镜（whip-pan）、破格（构图突变）、定格收束。

**势能是上一镜蓄出来给下一镜用的**：上一镜的落幅必须蓄出下一镜的起幅（同一动作/朝向/能量延续），不允许出现“蓄了却没释放”或“释放了却没蓄”的空切。Clip 1 末镜的落幅 = Clip 2 首镜的起幅，势能跨段续接，靠 Motion Context / latent 接续承载，不能靠“有两个 Clip”推断已续接。

> 自检：8 个切点 = 8 次蓄放。若某一镜只有切点、没有前镜蓄出的势能，或势能蓄满却没在重音释放，就是空切，必须回改。

## 2. 迷人/擦边尺度：从形象与氛围派生（不预设档位）

迷人手法不是固定档位，而是**由角色资产图与场景氛围共同派生**。生成前先读两项输入，派生本 Clip 的框选与张力：

- **从角色形象图派生**：读气质（冷艳 / 纯欲 / 御姐 / 清冷…）、服装与露肤度、丝袜等贴身元素、辨识配饰、眼神基调 → 决定**框选什么**（颈线 / 腰胯 / 腿 / 丝袜质感 / 眼神 / 配饰特写）与**慢放蓄势的主体**。
- **从场景氛围派生**：读光色（霓虹 / 暗调 / 顶光 / 逆光…）、粒子（雨 / 烟 / 光斑…）、情绪（压迫 / 暧昧 / 冷冽…）→ 决定**慢放蓄势的介质**与**近失 / peekaboo 的暗示对象**。

迷人四手法，按派生结果取舍使用，不堆砌：

- **近而不露**：只框有张力的局部，不平铺全身；默认不露点。
- **慢放蓄势**：衣料贴附、发丝垂落、眼神扫镜头，把“将露未露”拉长到重音前。
- **近失 / peekaboo**：给一个“差点看见”的暗示，比直给更迷人。
- **定格收束**：末镜（Shot 8）一个带掌控感的攻击性定格，把迷人钉死，作为 Clip 边界势能。

尺度上收上放跟随派生结果：气质冷艳则弱化身体、强化眼神压迫；气质纯欲则强化局部贴身与慢放。任何一镜不得为博尺度破坏角色身份一致性。

## 3. 单 Clip 8 镜结构

| 镜 | 起幅时间 | 势能动作（蓄力→释放） | 迷人手法 | 切镜释放落点 |
|---|---|---|---|---|
| 1 | 00:00.000 | 登场剪影/静帧推近，蓄力 | 框选身份锚点 | 重音硬切 |
| 2 | 00:01.000 | 承接落幅，局部蓄力 | 近而不露特写 | 甩镜 |
| 3 | 00:02.000 | 动作将发未发 | 慢放蓄势 | 重音硬切 |
| 4 | 00:03.000 | 蓄满后破格 | 近失/peekaboo | 甩镜 |
| 5 | 00:04.000 | 能量转换蓄力 | 局部贴身 | 重音硬切 |
| 6 | 00:05.000 | 蓄力升级 | 慢放蓄势 | 甩镜 |
| 7 | 00:06.000 | 张力到顶蓄满 | 近失/眼神锁定 | 重音硬切 |
| 8 | 00:07.000 | 收束蓄力→定格 | 定格收束（掌控感） | Clip 边界势能 |

切点一律落整秒重音（如 120 BPM 2/4，每小节 1 秒、重音在小节首拍）。先定音乐节拍，再按整秒重音排切镜，不得后期把切点与重音错开。

## 4. 示范（虚构角色，仅作结构样例，非本项目资产）

角色：丝袜御姐，冷艳气质，黑丝 + 红唇，辨识配饰为颈链；场景：霓虹雨夜，暗调 + 青色霓虹 + 雨丝粒子，情绪压迫暧昧。派生结果——框选腿/丝袜质感与眼神，慢放介质为雨丝与发丝，近失对象为唇与颈链，定格收束为侧身回眸锁定镜头。

```text
detailed_description:
<Subject 1> is a poised woman in glossy black stockings, a fitted black dress, and a thin red neck chain; cold, commanding aura; red lips. The scene is a neon-soaked rainy night, dark base with cyan neon spill and falling rain streaks.

[Shot 1] At 00:00.000, a low-angle medium shot: <Subject 1> stands as a near-silhouette in the rain, camera pushes in slowly, her gaze locked straight to lens; rain streaks gather toward her. On the beat she cuts hard.
[Shot 2] At 00:01.000, close-up on the glistening black stocking leg, water beads sliding down, hair falling slow; whip-pan on the beat.
[Shot 3] At 00:02.000, medium close-up, she half-turns, a gesture about to break; slow-motion of the neck chain catching neon; hard cut on the beat.
[Shot 4] At 00:03.000, extreme close-up on the lips and neck chain, a near-miss tease, neon flare breaks the frame; whip-pan on the beat.
[Shot 5] At 00:04.000, tight on the hip and stocking seam, fabric clings as she shifts weight; slow rain-streak motion; hard cut on the beat.
[Shot 6] At 00:05.000, low tracking shot up the stocking leg to the dress hem, hair and rain slow; whip-pan on the beat.
[Shot 7] At 00:06.000, profile close-up, gaze snaps to lens, tension peaks, neon spikes; hard cut on the beat.
[Shot 8] At 00:07.000, she holds a commanding side-look freeze, rain suspended, the frame locks as the clip boundary.

overall_soundscape: Wet urban night, layered rain on pavement, distant traffic hum, a low neon buzz, her slow heels clicking once.
non_diegetic_music: A dark electronic pulse at 120 BPM, 2/4, one hard accent per bar; the final bar sustains into the freeze.
```
