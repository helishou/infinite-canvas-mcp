# 快闪镜头模板（5 秒 5 镜 · 势能周期 · 迷人派生）

适用：竖屏快闪 PV 的单个独立 5 秒 Clip。默认 Ref2VA、9:16、2.0 MP、丝袜 LoRA 0.5；用户指定其他镜头数时保留其数量，但 Clip 仍为 5 秒。本模板只负责 `detailed_description` 的镜头/动作/切镜组织与迷人手法；`subject_definitions`、`summary`、`retention_analysis`、`overall_soundscape`、`non_diegetic_music` 仍按 `../../acheng-director/modules/model/h3-prompt-writing/references/ref-en.txt` 的六段式与标签规范撰写，此处不重复。

## 1. 势能周期（核心规则）

**卡拍 ≠ 有势能。** 一个切点要“爽”，它释放的必须是**已经蓄满的动能**，而不是等距掐表把动作拦腰掐断。每个 1 秒镜头是一个**势能周期**，两个阶段严格对齐音乐整秒重音：

- **蓄力（重音前 ~0.5 秒内完成）**：把张力拉到顶。可用手段——静帧定格、镜头推近、眼神锁定镜头、衣料/发丝绷紧、一个将发未发的动作、光斑/粒子收拢到主体。
- **释放（正好落在整秒重音那一帧切走）**：泄洪口。可用手段——爆发、甩镜（whip-pan）、破格（构图突变）、定格收束。

**势能只在当前 Clip 内传递**：前镜落幅为本 Clip 后镜起幅提供动作方向或视线承接，但每个 Clip 都从完整、稳定的起始状态开始，并以稳定落幅结束。默认不跨 Clip 复用姿态、动作进度、尾帧或 AV latent；只有用户本轮明确要求跨段连续时才设计和启用相应接续。

> 自检：默认 5 个一秒镜头构成 5 个蓄放周期；核对片头建立、4 个内部重音切点与 5 秒片尾收束。若某一镜只有切点、没有镜内张力，或势能蓄满却没在重音释放，就是空切，必须回改。

## 2. 迷人/擦边尺度：从形象与氛围派生（不预设档位）

迷人手法不是固定档位，而是**由角色资产图与场景氛围共同派生**。生成前先读两项输入，派生本 Clip 的框选与张力：

- **从角色形象图派生**：读气质（冷艳 / 纯欲 / 御姐 / 清冷…）、服装与露肤度、丝袜等贴身元素、辨识配饰、眼神基调 → 决定**框选什么**（颈线 / 腰胯 / 腿 / 丝袜质感 / 眼神 / 配饰特写）与**慢放蓄势的主体**。
- **从场景氛围派生**：读光色（霓虹 / 暗调 / 顶光 / 逆光…）、粒子（雨 / 烟 / 光斑…）、情绪（压迫 / 暧昧 / 冷冽…）→ 决定**慢放蓄势的介质**与**近失 / peekaboo 的暗示对象**。

迷人四手法，按派生结果取舍使用，不堆砌：

- **近而不露**：只框有张力的局部，不平铺全身；默认不露点。
- **慢放蓄势**：衣料贴附、发丝垂落、眼神扫镜头，把“将露未露”拉长到重音前。
- **近失 / peekaboo**：给一个“差点看见”的暗示，比直给更迷人。
- **定格收束**：末镜（默认 Shot 5）用带掌控感的定格完成本段收束；它不充当下一段必须继承的动作状态。

尺度上收上放跟随派生结果：气质冷艳则弱化身体、强化眼神压迫；气质纯欲则强化局部贴身与慢放。任何一镜不得为博尺度破坏角色身份一致性。

## 3. 单 Clip 5 镜结构（每镜 1 秒）

| 镜 | 起幅时间 | 势能动作（蓄力→释放） | 迷人手法 | 切镜释放落点 |
|---|---|---|---|---|
| 1 | 00:00.000 | 独立登场，建立人物与场景，镜内蓄力 | 框选身份锚点 | 00:01 重音切 |
| 2 | 00:01.000 | 明确动作起势并释放一个小重音 | 近而不露特写 | 00:02 重音切 |
| 3 | 00:02.000 | 动作将发未发，完成重心转移 | 慢放蓄势 | 00:03 重音切 |
| 4 | 00:03.000 | 张力释放，机位或动作明显变化 | 近失/peekaboo | 00:04 重音切 |
| 5 | 00:04.000 | 完成动作并收在稳定定格 | 定格收束（掌控感） | 00:05 片尾落幅 |

切点一律落整秒重音（如 120 BPM 2/4，每小节 1 秒、重音在小节首拍）。先定音乐节拍，再按整秒重音排切镜，不得后期把切点与重音错开。

## 4. 示范（虚构角色，仅作结构样例，非本项目资产）

角色：丝袜御姐，冷艳气质，黑丝 + 红唇，辨识配饰为颈链；场景：霓虹雨夜，暗调 + 青色霓虹 + 雨丝粒子，情绪压迫暧昧。派生结果——框选腿/丝袜质感与眼神，慢放介质为雨丝与发丝，近失对象为唇与颈链，定格收束为侧身回眸锁定镜头。每段独立开场，不依赖前一段的姿态。

```text
detailed_description:
<Subject 1> is a poised woman in glossy black stockings, a fitted black dress, and a thin red neck chain; cold, commanding aura; red lips. The scene is a neon-soaked rainy night, dark base with cyan neon spill and falling rain streaks.

[Shot 1] At 00:00.000, a low-angle medium shot: <Subject 1> stands as a near-silhouette in the rain, camera pushes in slowly, her gaze locked straight to lens; rain streaks gather toward her. On the beat she cuts hard.
[Shot 2] At 00:01.000, close-up on the glistening black stocking leg, water beads sliding down as she shifts her weight into a controlled step; whip-pan on the beat.
[Shot 3] At 00:02.000, medium close-up, she half-turns and lets the neck chain catch the neon; the turn reaches a clear action peak before the hard cut.
[Shot 4] At 00:03.000, extreme close-up on lips and neck chain, a near-miss tease as a neon flare crosses frame; she draws back into a complete, balanced pose.
[Shot 5] At 00:04.000, profile close-up, her gaze snaps to lens and settles into a commanding side-look; rain continues behind her as the clip ends on a stable, self-contained freeze at 00:05.000.

overall_soundscape: Wet urban night, layered rain on pavement, distant traffic hum, a low neon buzz, her slow heels clicking once.
non_diegetic_music: A dark electronic pulse at 120 BPM, 2/4, one hard accent per bar; the final bar sustains into the freeze.
```

## 5. 提交前自检（漏了就白跑）

写完 `detailed_description` 后逐条核，缺一项就回改，不要提交：

- [ ] 5 镜各是一个完整的**蓄力→释放**周期，释放点落在整秒重音（00:01 / 00:02 / 00:03 / 00:04 → 00:05 收束）。
- [ ] 四手法**至少覆盖三种**，且每个手法都能指到具体镜号：近而不露（局部框选，不平铺全身）、慢放蓄势、近失/peekaboo、定格收束。
- [ ] 框选项来自**角色资产图**（颈线/锁骨/腰胯/腿与纹身/黑纱贴肤/眼神/配饰），不是通用形容词。
- [ ] 慢放的介质来自**场景**（雨丝、发丝、披风布料、水雾），近失对象写清了"被什么挡住又移开"。
- [ ] 末镜是带掌控感的定格，且不承担下一段必须继承的姿态。
- [ ] 六段齐全，`subject_definitions` 里 `<Subject 1>` 引 `<Picture 1>`、`<Subject 2>` 引 `<Picture 2>`，标签在五段中含义一致。
- [ ] `detailed_description` 350–500 词，`[Shot 1]` 无时间戳，其余用 `At 00:0N.000`。

反例（2026-10-28 锁瞑首版）：只写了"帅"的动作——伞骨水珠、红瞳收光、拨伞、披风落定、定格。有切点，但**没有慢放蓄势、没有近失、没有从形象派生的框选**，等于五个空切，被迫重写重跑。

## 6. 头像面板为什么会丢披风（2026-10-28 实测）

给 H3 用的角色设定板，左栏头像面板连丢三次披风，原因有三个，必须同时修：

1. **取景吃掉**：写成 head-and-shoulders 胸像时，披风在肩线以下，框里根本没有，模型自然不会画。改用**三分身**（头顶到中大腿），让肩、躯干、披风两侧都进画。
2. **清单漏项**：服装清单只列了 dress / collar / pendant / sleeve，**没列披风**。模型是照清单画的，清单里没有的不会自己补。披风必须单列一条，并加 `MUST INCLUDE` 与否定项（`do not omit it, do not shrink it into a scarf, do not swap it for a shawl`）。
3. **工作流默认构图**：`终极资产图` 的左栏天生是胸像裁切，即使提示词写了披风也可能被裁掉。要么在提示词里明确要求三分身，要么**生成后用 PIL 把三分身面板合成进左栏**（去掉旧面板、填同色底、边缘羽化 12–20px 并做背景亮度补偿，否则会留下矩形接缝与残留碎块）。

脸与瞳色同理：`终极资产图` 的输出会把红瞳洗成灰瞳、把脸拉长。稳定做法是**用 gpt-image-2.5 单独出三分身头像面板**（红瞳写死 `IRISES MUST BE CLEARLY RED — not grey, not brown`），再合成进设定板；纯靠 `终极资产图` 一次生成拿不到脸准。
