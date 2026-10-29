# 快闪镜头模板（5 秒 5 镜 · 势能周期 · 迷人派生）

适用：竖屏快闪 PV 的单个独立 5 秒 Clip。默认 Ref2VA、9:16、2.0 MP、丝袜 LoRA 0.5；用户指定其他镜头数时保留其数量，但 Clip 仍为 5 秒。本模板只负责 `detailed_description` 的镜头/动作/切镜组织与迷人手法；`subject_definitions`、`summary`、`retention_analysis`、`overall_soundscape`、`non_diegetic_music` 仍按 `../../acheng-director/modules/model/h3-prompt-writing/references/ref-en.txt` 的六段式与标签规范撰写，此处不重复。

## 0. 用户固化要求（六条，每条都要在成品里找得到）

1. **Clip 固定 5 秒**，不因内容多而延长。
2. **每 Clip 5 个镜头**，每镜 1 秒，切点落整秒重音。
3. **要性擦边**：按第 2 节从角色资产图与场景氛围派生，不预设档位，不露点，不破角色身份。
4. **多机位、多角度**：同一 Clip 内 5 镜的「高度 × 角度 × 运动」三元组不得重复；整支 PV 跨段之间大机位（正俯 / 高位 / 平视 / 仰拍 / 贴地）也要轮换，不要让四段都是平视中景。机位库见 0.1。
5. **要贴合角色**：框选项、服装细节、配饰、纹身纹样只能来自角色资产图实图；写完逐个回指资产图，不得用「冷艳」「妩媚」这类通用形容词代替具体元素。资产图与旧设计描述冲突时，一律以实图为准（2026-10-29 实测：按旧设计记录写的发色/头饰/纹身位置三处全错，导致整段重写）。
6. **每镜必须有微表情**，不得从头到尾一张脸看着镜头（见第 3.1 节）。

### 0.1 机位库（同一 Clip 内不得重复组合）

| 维度 | 可选值 |
|---|---|
| 高度 | 贴地、膝高、腰高、胸高、眼高、高位俯拍、正俯拍 |
| 角度 | 正面、侧面、背身、过肩、荷兰角、仰拍、顶视 |
| 运动 | 固定、缓推、缓拉、轨道横移、跟拍后退、手持、甩镜、变焦压缩 |
| 特殊 | 镜面倒影、前景遮挡、长焦压缩、极近特写 |

自检口径：把 5 镜机位分别写成 `高度/角度/运动` 三元组，出现任意两个完全相同即回改。若某镜确实需要同机位（如连续两镜同一特写做势能递进），必须改变运动或景别，不能原样重复。

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

| 镜 | 起幅时间 | 势能动作（蓄力→释放） | 迷人手法 | 微表情（走一条递进线，逐镜不同） | 切镜释放落点 |
|---|---|---|---|---|---|
| 1 | 00:00.000 | 独立登场，建立人物与场景，镜内蓄力 | 框选身份锚点 | 无脸则略过；有脸则只给一个极克制的起手（眼尾微动 / 呼吸一顿） | 00:01 重音切 |
| 2 | 00:01.000 | 明确动作起势并释放一个小重音 | 近而不露特写 | 嘴角单侧极轻上扬，或瞳孔先收再放 | 00:02 重音切 |
| 3 | 00:02.000 | 动作将发未发，完成重心转移 | 慢放蓄势 | 眉峰下压一瞬 + 下颌微收，压住笑意 | 00:03 重音切 |
| 4 | 00:03.000 | 张力释放，机位或动作明显变化 | 近失/peekaboo | 呼吸变重 / 喉头动一下 / 咬一下下唇 / 舌尖扫过唇角 | 00:04 重音切 |
| 5 | 00:04.000 | 完成动作并收在稳定定格 | 定格收束（掌控感） | 定格在一个明确表情上：冷到底的笑、或轻蔑的抬下巴、或眼底发亮 | 00:05 片尾落幅 |

### 3.1 微表情（默认会被写成面瘫，必须专门设计）

H3 会照字面执行。只写 `she looks into the lens`、`a cold level gaze`、`contemptuous stare`，五镜就会得到五张一样的面无表情脸——用户直接判为「死妈脸」并要求重做。微表情必须**逐镜给出一个可拍的具体面部动作**，并连成一条走向线。

**写法要求**

- 一个镜只给**一个主表情动作 + 最多一个副动作**，写成英文具体动作，不用情绪形容词：
  `the corner of her mouth lifts on one side`、`her pupils contract`、`her brows draw down for a heartbeat`、`she exhales through her nose`、`she swallows, throat moving once`、`she runs her tongue once along her lower lip`、`she bites down on her lower lip and releases it`、`her eyes narrow a fraction`、`she blinks once, slowly`、`her chin lifts`、`she wets her lips before speaking`。
- **走向线**：四段之间或一段之内要有变化，常用两条线——`冷 → 轻蔑 → 危险的兴致 → 收住的冷笑`，或 `压抑 → 松一口气 → 挑衅 → 平视`。禁止五镜同强度。
- **蓄力段克制、释放段明显**：重音释放那一镜的表情变化幅度要最大，观众才看得见。
- **无脸镜要补偿**：脚踝、裙摆、伞面这类镜头写 `no face in frame`，并在相邻有脸的镜把表情推进补上，不能连着两镜没表情。
- **禁止清单**：全程一个表情；每镜都「目光锁定镜头」；用 `expressionless`、`deadpan`、`stoic` 当表情；把情绪写在 `summary` 里而 `detailed_description` 没有动作。

**自检口径**：把 5 镜的表情动作列出来，出现任意两个重复、或有一条是「无」却没有标注 `no face in frame`，即回改。

### 3.2 幅度校准：面瘫与狰狞是同一根刻度尺的两端

**2026-10-29 同一天滑档两次**，两次都是同一个原因——没定幅度：

- 第一版五镜全写 `a cold level gaze` / `her eyes flat and unimpressed` → 用户判为「**死妈脸**」。
- 补上微表情后写成 `her smile breaks wide enough to show her teeth`、`her mouth open on a short exhilarated breath`、`her brow arching a fraction`、`runs her tongue along her lower lip` → 用户判为「**表情有些狰狞了**」。

正确区间在中间，且对**冷艳型角色**尤其窄。按下面这张表取词：

| 允许（毫米级，几乎没动但确实动了） | 禁止（显狰狞或油腻） |
|---|---|
| 眼睑下沉一档、瞳孔收缩、睫毛颤一次、慢速眨一次 | 瞪眼、挑眉、眉毛下压 |
| 唇角单侧移动 1–2 毫米、下唇收回再放开 | 露齿、咧嘴笑、张嘴喘气 |
| 下颌抬起或收回一个角度、鼻息、喉头动一下 | 咬牙、舔唇、舌尖扫过下唇 |
| 眼神方向变化（扫向侧后、停一帧再回镜头） | 头部大幅甩动配合表情 |

写法上用**位移量**代替幅度形容词：`shifting a millimetre`、`curving a degree`、`lifting a fraction, no more than that`、`lowering a fraction`，比 `smile`、`grin`、`laugh` 安全得多。

**判断口径**：写完逐条自问——让一个真人做这个动作，她需要「表演」吗？需要就砍掉一半。冷艳角色的表情靠「几乎没动但确实动了」，不靠幅度取胜。爽点应该落在机位、动作、光和水上，不该压在脸上。

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
- [ ] **机位三元组不重复**：5 镜的 `高度/角度/运动` 写出来没有任意两个完全相同；跨段大机位有轮换（正俯 / 高位 / 平视 / 仰拍 / 贴地）。
- [ ] **每镜有微表情**：5 镜各一个具体面部动作，连成一条走向线，无重复；无脸镜标注 `no face in frame` 且相邻镜已补偿；没有出现 `expressionless` / `deadpan` / 只写「目光锁定镜头」这种面瘫写法。
- [ ] **幅度在校准区间**（见 3.2）：没有露齿、咧嘴、张嘴喘、挑眉、瞪眼、咬牙、舔唇；表情动作用毫米级位移表述，不需要真人「表演」才做得到。
- [ ] 四手法**至少覆盖三种**，且每个手法都能指到具体镜号：近而不露（局部框选，不平铺全身）、慢放蓄势、近失/peekaboo、定格收束。
- [ ] 框选项来自**角色资产图实图**（发色、头饰、颈线/锁骨、贴肤材质、开衩与腿、纹身位置、配饰），不是通用形容词；与旧设计描述冲突时已按实图改正。
- [ ] 慢放的介质来自**场景**（雨丝、发丝、披风布料、水雾），近失对象写清了"被什么挡住又移开"。
- [ ] 末镜是带掌控感的定格，且不承担下一段必须继承的姿态。
- [ ] 六段齐全，`subject_definitions` 里 `<Subject 1>` 引 `<Picture 1>`、`<Subject 2>` 引 `<Picture 2>`，标签在五段中含义一致。
- [ ] `detailed_description` 350–500 词，`[Shot 1]` 无时间戳，其余用 `At 00:0N.000`。

反例（2026-10-28 锁瞑首版）：只写了"帅"的动作——伞骨水珠、红瞳收光、拨伞、披风落定、定格。有切点，但**没有慢放蓄势、没有近失、没有从形象派生的框选**，等于五个空切，被迫重写重跑。

## 6. 头像面板：必须是脸部大图，且披风不能丢（2026-10-28 实测）

**左栏规格固定为脸部大图**（脸占画面主体，取景到锁骨附近）。这是设定板的设计意图，不能为了塞下披风改成三分身——用户会直接指出来。披风要在**同一张脸部大图里**解决。

头像面板连丢三次披风，原因有三个，必须同时修：

1. **取景吃掉**：写成 head-and-shoulders 时披风在肩线以下，框里没有，模型不会画。正确解法不是拉远成三分身，而是在提示词里把披风**抬到肩后向两侧展开**并超出画面左右边缘：`behind her shoulders a long, wide black cape with a deep crimson lining rises and spreads outward toward BOTH edges of the frame, so on each side of her head you see the black outer fabric with its crimson lining flaring out`。同时显式禁止拉远：`Do NOT pull back to a three-quarter or full-body shot`。
2. **清单漏项**：服装清单只列了 dress / collar / pendant / sleeve，**没列披风**。模型是照清单画的，清单里没有的不会自己补。披风必须单列一条，并加 `MUST INCLUDE` 与否定项（`do not omit it, do not shrink it into a scarf, do not swap it for a shawl`）。
3. **工作流默认裁切**：`终极资产图` 的左栏固定胸像裁切，即使提示词写了披风也可能被裁。稳定做法是**生成后合成**：用 gpt-image-2.5 单独出脸部大图面板，再用 PIL 贴进左栏。

合成三个必做项（少一项就出瑕疵）：

- **清空按真实内容边界来**：先扫描底图列亮度找左栏内容的右边界（实测 2741×1640 的设定板左栏内容到 x≈1447，不是 `0.46×W`），清空整列到该边界，否则边缘会残留原面板的碎片。
- **填同色底**：从右栏空白处采样底色填充，不要直接填纯白。
- **背景亮度补偿 + 边缘羽化**：按四角均值做增益对齐（限幅 0.92–1.18），羽化 12–14px；贴图与外框之间留出留白，别让内容顶到右栏。

脸与瞳色同理：`终极资产图` 的输出会把红瞳洗成灰瞳、把脸拉长。稳定做法是单独出面板（红瞳写死 `IRISES MUST BE CLEARLY RED — not grey, not brown`）再合成；纯靠 `终极资产图` 一次生成拿不到脸准。
