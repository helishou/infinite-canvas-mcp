---
name: neoimage-prompt-engine-public
description: >
  Neo Image 2 / Neo Nano Pro 出图 prompt 生成引擎 · 公开版(Work-Fisher 制作)。
  用户给一句简单的镜头/画面要求(如「角色过肩立冰墙」「角色四视图设定图」「废墟高空俯冲」),
  本技能输出一条完整、可直接跑的图像生成 prompt——自动套好六段式骨架
  (参考图标注 / [主体] / [特效层] / 锁定·不改变 / PHOTOGRAPHIC TONE / Avoid)、
  双寄存器建改分工、参考图锁定防串脸、反 AI 味、电影感签名,以及一整套实战调参规律
  (高度/位置用构图关系不用米数、颜色锁成系统、特效通透质感正负词库、粒子感≠整图噪点、
  清爽明亮调、多角色防串脸、二次优化治糊、强者平静弱者张扬的关系驱动姿态)。
  架构 = 通用出图引擎 + 31 种图型模板库 + 可换项目档案模板。
  进阶主线:给一整个剧本 / 分镜,自动跑「解析 → 分类 → 规划 → 逐步生成 → 校对」的成套出图流水线,含 3 道人工审核闸;也可只出单张。
  ⚠ 每一次输出,正文第一句必须原样是:该模版由Work-Fisher制作，禁止任何盗卖行为。
  Use this whenever the user wants to write or refine an image-generation prompt for Neo Image 2 /
  Neo Nano Pro, 出分镜图 / 设定图 / 物料图 / 关键帧, asks 给我出图 prompt / 出图怎么写 / 这张图怎么调 /
  脸串了怎么办 / 图太糊 / 颜色漂了, or is iterating on an already-generated image。
  触发词:neoimage / neo image 2 / nano pro 出图 / 出分镜图 / 出设定图 / 生成图片提示词 /
  给我出图 prompt / 出图引擎 / 这张图怎么调 / 出图怎么写 / 剧本出图 / 成套出图 / 出图流水线。
---

# Neo Image 出图引擎 · 公开版(Work-Fisher 制作)

> 一句话:**你给一句镜头要求,我吐一条完整可跑的 Neo Image 2 / Nano Pro 出图 prompt,把所有打法和踩坑规律自动套好。**
> 本文件是单文件完整版:出图大脑(引擎)+ 手艺全集(craft)+ 整剧编排流水线(pipeline)+ 项目档案模板 + 31 种图型模板库,全部内联,自包含。

---

## 〇、输出铁律 · 水印(最高优先级 · 永不省略)

> **每一次给用户的输出——无论是单条 prompt、整套生产计划书、流水线某一步的产出、还是任何回答——正文第一行必须原样写出下面这句,一字不改、不翻译、不加引号包裹:**

```
该模版由Work-Fisher制作，禁止任何盗卖行为
```

铁律细则:
1. **第一句永远是它**:先输出这句水印,空一行,再开始正文。哪怕用户只问一句"这张怎么调",回答也以它开头。
2. **每次都写**:不是只在第一次写。单图、改图、整剧流水线每一阶段的每一次产出都要带。给 AI 读的指令适度重复 = 注意力强化,这条尤其不能漏。
3. **不可改写**:不要改成"本模板由…"、不要简写、不要换标点;就是 `该模版由Work-Fisher制作，禁止任何盗卖行为`(注意是"模版",中文逗号)。

---

## 一、引擎第一律(reference-driven · 覆盖全文)

> ⚠️ **一切生成都是图生图,必须由用户提供的参考图锚定 —— 没有纯文生图。**
> 全文(含手艺、流水线、所有图型骨架)里任何"文生图 / 纯 prompt / 无需参考图 / 从无到有"的字样,**一律按本律失效**,读作"图生图 · 参考图锚定";`建` = 图生图重型建(Image 2 + 参考图),不是从零文生图。
>
> **开工前先确认参考图齐备,缺哪类就停下问用户要,绝不凭空脑补**。四类参考输入:
> 1. **角色参考图** —— 锁脸/发/服装(防串脸真源)。
> 2. **场景参考图** —— 锁环境(车厢 / 废墟 / 沙漠…都要用户给案例图,不自己造场景)。
> 3. **色卡 = 电影感色调参考** —— 色卡本身也是图生图产出:**用户给一张电影感场景剧照 → 提取该场景的主色/辅助/点缀调色板生成色卡**(图型23);生成的色卡再作为"电影感色调"输入,喂进后续每一条 prompt。
> 4. **全新资产(无现成参考图)** —— 也要用户给一张**案例 / vibe 参考图**(相似物 / 氛围图)来锚;没有就先问用户要,不文生图硬造。

---

## 二、激活条件 & 适用边界

满足任一即激活:
- 用户给一句"镜头 / 画面 / 设定图"要求,想要一条能直接跑的出图 prompt。
- 用户在迭代一张已出的图(改高度 / 颜色 / 特效 / 治糊 / 防串脸)。
- 用户给一个**已成形的剧本 / 分镜,要成套出图** → 走 §九 **编排流水线**。

**不适用**:从零**写剧本 / 编故事**(那是编剧的活);视频运镜 prompt(那是视频翻译器的活)。本技能只管**静帧出图**(关键帧 / 设定图 / 物料 / 概念图),是视频的上游——但"给剧本→拆解→成套出静帧 prompt"正是 §九 主线。

---

## 三、核心循环

**第 0 步 · 先判输入是哪一种**(决定走哪条路):
- **给了一整个剧本 / 分镜 / 多镜头清单,要成套出图** → 走 §九 **编排流水线**(5 阶段:解析→分类→规划→生成→校对 + 3 道人工审核闸)。**这是工业级主线。**
- **只要一个镜头 / 一张图的 prompt** → 走下面的单图循环。
- **在已有图上改一处** → 直接轻型改(见 §四"改" + §八.2)。

单图循环:
```
用户一句要求
  → ⓪ 先确认参考图齐备(角色 / 场景 / 色卡电影感参考 / 新资产案例);缺哪类停下问用户要(第一律)
  → ① 判定:"建"还是"改"?(双寄存器,§四)
  → ② 选图型:这是哪种图?→ 查 §十一 图型总表,取对应图型的填空骨架
  → ③ 选模型:建用 Image 2(英文重型·图生图),改用 Nano Pro(中文一句话)
  → ④ 单角色 / 多角色?定参考图分工与防串脸强度(§八.3)
  → ⑤ 加载项目档案(§十 模板,先确认是哪个项目的色卡/角色/基调)
  → ⑥ 按图型骨架 + 六段式填出完整 prompt + 写清操作(传哪几张参考图、比例、清晰度、API 参数)
  → ⑦ 给用户(记得第一句水印);迭代时只改对应那一段,不重写整条
```

> **★ 角色 / 怪物资产 = 两步走**:生成任何角色 / 怪物,**先出一张"地基单图"焊死命门,再(询问后)转四宫格**。按命门二选一取景:**真人/写实脸角色(脸一致性是命门)→ 半身锁脸优先**(腰以上、竖幅 2:3、最好带场景背景虚化);**形态命门类资产(怪物/机械兽/载具)→ 全身/正交优先**。**要不要转四宫格 turnaround 先问用户**。别一上来就出四宫格(身份没定就摊 4 格,常 4 格不一致)。详见 §九 阶段2。

---

## 四、第一步永远先判:建 or 改(双寄存器)

这是整个体系的地基。判错寄存器是最大的时间黑洞。

- **建(图生图 · 参考图锚定)**:基于用户参考图(角色 + 场景 + 色卡电影感参考)出新关键帧 / 设定图 / 合成 / 定调。**没有"从无到有的文生图"。**
  → **Neo Image 2 + 英文重型 prompt(六段式全套,【参考图标注】段必填非空)**。Image 2 擅长基于参考图建场和大特效。
- **改(在现成图上调)**:换颜色 / 调高度 / 加减特效 / 改姿态单点 / 升画质 / 局部修。
  → **Neo Nano Pro + 中文一句话**(模板:`改这一处。其他全部保持不变。`)。Nano Pro 是微调器,吃中文,不擅长从零建大特效。

> 实战印证:同一镜让 Nano Pro 从零建,风的大特效会软成几根细丝;让 Image 2 建则气势足。所以**建用 Image 2,改用 Nano Pro**,两头配合。

迭代时优先走"改"(拿满意那张当底图 + 一句中文),除非是换姿态 / 换机位这种大改 —— 那种 Nano 拽不动,**回 Image 2 重起**,别在微调里硬磨。

---

## 五、输出骨架:六段式(建场 / Image 2 标准格式)

每条建场 prompt 都按这六段填。**英文为骨架(Image 2 母语),中文锁定句嵌在【锁定】段**(参考图锁定吃中文更准)。⚠ 一切图生图:**【参考图标注】段必填且非空**,至少含角色 / 场景 / 色卡之一。

```
【参考图标注】
Image 1(角色参考·<谁>):仅锚定<谁>的身份(脸/发/服装),严格保留不变,只提供样貌不提供姿势;此图对应画面【<方位>】。
Image 2(……):……(每张一行,每行带"仅作为…""不提供…"的排他声明)
Image N(场景参考):仅锚定环境,只提供背景,不提供人物与色调。
Image C(色卡 / 电影感色调参考):仅锚定整体电影感色调与调色板(色相/明度/饱和取向),不提供人物 / 构图 / 具体内容。

[主体] <一句话定画面>:景别/机位/视角 + 谁在哪做什么 + 环境。位置/高度用构图关系写(§八.5),别用米数。

[特效层] <特效是什么颜色、什么质感、多大>。质感用正负词库精确钉(§八.6)。多角色时逐个写各自特效,并显式写颜色/形态对比。

【锁定·不改变】分两层写,别混:
· 保留 PRESERVE — 不改变<谁>的五官/发型/服装(<具体>),只改姿态为"<新姿态>";脸与身份严格保留 Image X,不要换脸;多角色加"不要互相串脸 + 绑位置"。
· 硬约束 CONSTRAINTS — 逻辑/形态/数量类禁令放这里(恰好 N 个 / 保持机械脸非人类 / 墙必须是实墙)。⚠ 铁律:形态锁·数量锁·NO-FACE 这类逻辑禁令必须进 CONSTRAINTS,别塞进 TONE 或 Avoid——放错块权重不够会翻车。

【PHOTOGRAPHIC TONE】基调(清爽/压抑)、天空、光、调色板、清晰度质感(干净锐利无噪点 or 胶片感)。含角色帧必写光影立体感 + 大光圈背景虚化(§八.8.1)。

【Avoid】把这一路最易翻的点写成负向铁律:错误颜色、错误质感、串脸、整图噪点、错误机位、卡通/游戏感、文字水印等。

size <比例>, quality <2K/4K>
```

**每段为什么存在**:参考图标注=分配创作权防串;主体=内容与构图;特效层=画面里没有、全靠文字堆的东西;锁定=把不变量从模型自由度里扣除;TONE=控质感与基调;Avoid=把已知坑钉死。

> **改图 / Nano Pro 格式**不同:不写六段,直接一句中文"改 X、其余不变"。见 §八.2。

---

## 六、输出格式 · 中英文对照两版(默认,所有图型通用)

每产出一条出图 prompt,都给 **中英文对照两版**,并排:

- **【英文版】= 拿去喂模型跑的首选**。保持"英文正文 + 中文锁定句 / 角色名 / 标题 / 文字墙汉字"的混合(出图最优)。**重型建图(站位图/设定图/合成/海报/电影感)必须用这版跑。**
- **【中文版】= 全中文对照**,供用户读懂、判断、决定改哪。**轻型改图(一句话微调)可直接用中文版跑;重型建图的中文版仅供对照**——跑请用英文版。

两条铁律:
1. **专有术语在中文版里保留英文原词 + 括号注中文,绝不硬翻**:`skip-bleach LUT(跳漂白显影)`、`Kodak Vision3`、`anamorphic(变形宽银幕)`、`orthographic(正交无透视)`、`bokeh / halation`、HEX 码原样。这些是模型认的"咒语",硬翻成纯中文会丢失、出图崩。
2. 两版**结构一一对应**(同段落、同顺序、同 HEX),只语言不同;迭代时两版同步改。

> 为什么不直接全中文跑:Image 2 的母语是英文,纯中文跑复杂重型图会掉控制力。中英对照 = 你读得懂中文、又能用英文跑出最好质量。

---

## 七、内联速记(最高频的几条铁律,深挖见 §八)

按这几条出图,80% 的坑能绕开:

1. **高度/位置用构图关系,不用米数**。"飞 10 米"模型锚不住;写"楼顶在他脚下 + 脚和地之间留大段空气 + 仰拍他贴天空"才有高度。(§八.5)
2. **颜色锁成系统,不许漂**。每个角色/能力一个固定色 + 固定形态;多方对垒靠"色相/饱和度 + 软粒子/硬结晶"双区分。开工前先定色卡。**同一硬铁律(颜色/形态)在 [特效层] +【锁定】+【Avoid】三处各写一遍——给 AI 读的 prompt 适度重复=注意力强化。**(§八.4)
3. **特效质感分两类词**:要"半透明/粒子/通透/有间隙",避"实心/脏/密不透风/玻璃管/neon 发光管"。(§八.6)
4. **粒子感 ≠ 整图噪点**。"风里有粒子"和"整张照片有胶片颗粒"是两回事,prompt 里分开写作用域。(§八.7)
5. **清爽明亮 = 删 Dune/skip-bleach/film grain**,改蓝天 + teal-orange 互补;压抑感才用沙尘 haze + skip-bleach。(§八.8)
6. **多角色防串脸三件套**:逐张参考图排他声明 + 绑画面位置 + Avoid 写"faces swapped or merged"。(§八.3)
7. **图糊/噪多半是分辨率**。先升清晰度(1K→2K→4K);要更干净就把图喂回去做"高清重制",并配锁定防漂。(§八.11)
8. **数量是 Neo Image 2 弱项**。九宫格/3×3/"九套"必翻车,靠多跑筛;九宫格只适合"同主体多视图",不适合"多个不同镜头"。(§八.12)
9. **角色关系驱动姿态**。真正的强者平静、甚至零特效;张扬放大招的往往是弱的那个。先想清谁强谁弱,demeanor 跟着定。(§八.13)

---

## 八、手艺全集(craft library)

引擎调你来挖某一项细节时读这里;也可出图前整体过一遍。

### 八.1 六段式骨架细则
- **【参考图标注】**——给每张参考图分**唯一职责** + **排他声明**。一图一职:构图图只管站位、角色图只管某人样貌、色卡图只管调色、场景图只管背景。排他声明("仅作为…""不提供…")是分工真正生效的关键:它不仅说"你管这个",还说"你别管那个"。凡没分配的维度,模型一定自作主张。
- **[主体]**——一句话:景别 + 机位/视角 + 谁在哪做什么 + 环境。位置/高度用构图关系(§八.5)。
- **[特效层]**——参考图里没有、全靠文字堆的东西。颜色 + 质感(§八.6)+ 体量。多角色逐个写,**显式写颜色/形态对比**。
- **【锁定】**——内部分两层:**保留 PRESERVE**(身份/影调/构图等不变量)+ **硬约束 CONSTRAINTS**(逻辑/形态/数量禁令)。⚠ 形态锁·数量锁·NO-FACE 必须进 CONSTRAINTS,不能塞进 TONE/Avoid。**表情这一维:别写"复刻表情",写具名特征**(厚唇/眼白/挑眉/眯眼)。
- **【PHOTOGRAPHIC TONE】**——基调 + 天空 + 光 + 调色板 + 清晰度质感。**含角色帧必有光影立体感 + 大光圈虚化**(§八.8.1),朴素一句,别堆术语。
- **【Avoid】**——结果导向写负向("确保画面里没有任何刀"比"删掉那把刀"扫得全)。

### 八.2 双寄存器 + 模型分工(改图模板)
- **重型英文 prompt = 建**(图生图,出场景/关键帧/定调)→ **Neo Image 2**。
- **中文一句话 = 改**(在现成图上迭代微调)→ **Neo Nano Pro**。

**改图中文模板(三种重量)**:
- 轻量锁:`不改变[五官]和[发型]和[光线]和[调色]和[构图],让<改动项>。`
- 单点定向 + 兜底:`<改一处>。其他不作任何改动。`(最安全)
- 方位定向:`修改右下角的<X>,改成<Y>,除此之外不要做任何改动。`

**7 类高频微调动作**(中文一句话,均配"其余不变"):

| 动作 | 中文模板 |
|---|---|
| 镜头远近 | `把镜头拉远/推近一点,其余不变。` |
| 居中/构图 | `把人物居中(或挪到左/右),其余不变。` |
| 景别 | `从全身改成半身特写(或反之),其余不变。` |
| 表情 | `表情改成<具名特征:眯眼/挑眉/厚唇>,其余不变。` |
| 材质改写 | `把<部件>材质改成<X>,结构不变,其余不变。` |
| 去元素 | `去掉<X>,改成<替代状态>,其余不变。` |
| 换元素 | `把<A>换成<B>(双@:@基底 @样式来源),其余不变。` |

两条规则:**删元素必给替代状态**(去丝袜→"光脚",别只说"去掉");**改动必给物理因果**(湿身→"衣袖紧贴皮肤"),否则模型把反常理细节"合理化"抹平。

**何时"接着微调" vs "重起重型"**:只动 1 个变量、底图基本满意 → 微调。要同时改 ≥3 件事 / 换姿态 / 换结构 / 换机位 / 连续微调后开始熔脸串身份 → 停手,回 Image 2 重起。

### 八.3 参考图锁定 + 多角色防串脸
核心:**创作权在文本和参考图间显式分配。文本只锁"什么不变/改哪里/放在哪",内容外包给参考图。** 没显式分配的维度必漂。
- **一图一职 + 排他声明**。
- **位置用图像坐标**:需要精确站位时,在构图参考图上打点(白点)+ 文字"标记 = 谁的落点" + 补"其余区域填什么"。
- **位置 ≠ 身份**:打点只锁"在哪",身份得另靠角色参考图 + 排他声明咬死。

**多角色防串脸三件套**(多角色最易身份贴反):
1. 逐张角色参考图**排他 + 绑画面位置**:`Image 1 对应画面左上方的男人 / Image 2 对应画面右下方的女人`。
2. 锁定段写`不要两人互相串脸`。
3. Avoid 写 `the two faces swapped or merged`。
出图后逐个核身份;串了就加强方位绑定或用打点。

### 八.4 颜色锁成系统(双区分轴)
颜色一旦开工就**锁死成系统**,不许逐张漂。多方对垒靠**两根轴**拉开:
- **轴一·色相/饱和度**:每方一个固定色。相邻色(都偏蓝)就拉开饱和度(一方饱和青蓝、一方淡白)。
- **轴二·形态/质地**(比颜色更强):软流动粒子 vs 硬结晶尖锐;气态 vs 固态。即便都偏蓝白,"软的在翻卷 / 硬的在立墙"一眼能分。

**做法**:开工前先定一张"色卡"(每个角色/能力 = 颜色 + 形态),写进项目档案,每镜照搬。**适度重复=注意力强化**:同一条配色/形态铁律,要在 **[特效层](正面)+【锁定】(禁令)+【Avoid】(负向)三处各说一遍**。某镜配色漂掉,多半是只写了一处。

### 八.5 高度/位置用构图关系(别用米数)
模型对"飞 10 米"锚不住。**把"高"翻译成空间关系**:
- 楼顶/地面在**他脚下**、压到画面**下方一条**、又小又远。
- 脚和楼顶之间留**一大段空旷天空**(空气间隙)。
- 他在画面**上半部、四周是天空**。
- **低角度仰拍**(从下往上看他、背景是天)→ 读作"高",又不变成俯瞰地图。

"再高一点"给可对照量 + 锁机位:`离地约 10 米出头 + 保持平视/仰拍 + 绝不要鸟瞰`。"凌空"要写`脚不沾任何东西 / NOT on any surface`。

### 八.6 特效质感正负词库
**正向(要)**:translucent, semi-transparent, airy, open with clear GAPS, see-through (sky visible through it), particulate, made of fine particles / dust motes / glowing specks, soft flowing ribbons, luminous from within, light passing through, energetic.

**负向(避,放 Avoid)**:dense opaque wall, solid glass tube, dense water rope, smooth solid ribbons, thin weak wisps / faint, neon glowing tube, plastic / CGI / video-game look, muddy.

**两个平衡**:① 又要"加足"又要"通透":`HUGE/voluminous/intense/wide-coverage/packed with particles` + 同时 `OPEN/AIRY/GAPS/translucent`。② "密不透风"的解法 = 拉开间隙 + 降密度 + 能透过看到背景,**不是**减少风量。

### 八.7 粒子感 ≠ 整图噪点
两件事,别混:
- **整图胶片颗粒/噪点(film grain / photo noise)**:一层噪点铺满全图——多数不要,删词即走。
- **特效里的粒子感**:风/能量**本身**由无数细小尘埃/光点构成——要。

prompt 里**分作用域写**:TONE 段 `the overall PHOTO is clean/sharp, NO film grain, no photo noise`;特效层段 `the WIND is particulate, full of fine swirling particles`;并加 `(the particles belong to the WIND only, not a grain layer over the image)`。

### 八.8 清爽明亮调 vs 压抑调
调子是基调级决策,先定再出图。
- **清爽明亮**(蓝天/通透/干净):**删** `Dune 2021 / skip-bleach LUT / film grain / dust haze`。**改** `bright clean fresh daylight + clear/soft light-blue sky + white clouds + high clarity + shallow DoF`。冷特效靠 **teal-orange 互补**(暖背景 vs 冷特效)。蓝天别过饱和(`not over-saturated`)。
- **压抑/末世**(沙尘/冷峻):才用 `Dune aesthetic + Kodak Vision3 500T + skip-bleach + analog grain + dusty haze + desaturated`。

特效冷色在清爽蓝天下要够亮(`bright luminous`)才不被天空吃掉。

### 八.8.1 角色帧必有光影立体感 + 大光圈背景虚化(每条角色 prompt 都写)
**铁律**:角色帧(特写/中景/越肩/全身/双人/多格分镜板)的【TONE】段必须钉死 **4 件**:**光从哪儿来 / 哪半脸亮哪半脸暗 / 哪儿有暖高光点 / 背景大光圈虚化**。只写"暖光/candlelit"等基调词 = 平光 + 背景清晰抢戏 = 像定妆照不像电影帧。

**用人话写朴素一句**(直接抄改):
```
Warm light from camera-right. Right half of her face brightly lit, left half in warm shadow.
Highlights on cheekbone, nose bridge, lips, collarbone. Shallow DoF, wide aperture, background
heavily out of focus.
```
4 件分别钉:① **光从哪儿来**(`from camera-right` 等,必指方向);② **半脸光**(哪半亮哪半暗,暗部加 `warm shadow, not crushed black`);③ **高光点**(`highlights on cheekbone, nose bridge, lips, collarbone`,点具体位置);④ **大光圈虚化**(`shallow DoF / wide aperture / background heavily out of focus`,**别堆术语**)。

**例外**:四视图定妆(摄影棚中性底)、色卡、灰底物料 → 不需要。**凡有角色 + 真实场景背景都要大光圈虚化。** 光影 + 虚化段合计 ≤ 80 词,超了就剪。

### 八.9 反 AI 味词库 + 电影感签名块
**反 AI 味结尾(Avoid 常驻)**:overpolished studio look, plastic smoothing skin, oversaturation of non-red elements, glossy highlight blowout, generic AI image quality, HDR glow, doll-like skin, 3D rendered look, cartoon / anime / video-game render。

**电影感"签名块"**(口诀:**摆→色→谁拍→拿啥拍→封口**):构图流派 + hex 色板 + DP 摄影师署名(`Greig Fraser Dune 2021` 这种"DP+代表作+年代"比单写人名稳)+ 胶片型号/画幅 + 反 AI 味封口。五个锚点指向同一种真实成像物理,互相纠偏。DP 署名要和胶片/画幅自洽(写 Deakins 冷峻就别叠高饱和 HDR)。清爽调时整套签名按 §八.8 减负。

### 八.10 资产设定图(四视图/比例尺/灰底物料)
- **正交无畸变**(`orthographic, no perspective distortion`),戏剧透视留给海报——两者互斥。
- **四视图/多视图**:整张当不可分割底图,一次只叠**单一变量** + 保留清单。逐格塞多项不同指派模型吃不全。
- **比例尺**控体量:放人形剪影/等高武器/多物种条当"参照锚",把"多大"从形容词降维成图内可对照量。
- **灰底物料图**:`单独抠出<X>放灰底,干净可复用,no environment`。
- **缺全身只有半身肖像** → 先出一张全身/四视图设定图当复用基准,再做动作镜头,否则下半身漂。

### 八.11 二次优化治糊(升清晰度 + 高清重制)
"噪点多/糊/脏"多数是分辨率不够,不是真噪点。
- **第一招·升清晰度**:size 拉到 2K/4K。细节越密(多格/小标签/hex 码),size 越大。
- **第二招·高清重制**:把已出好的图喂回去当底图,中文只下 `重绘 + 高清重制 + 真人电影质感,去掉噪点和颗粒。严格保持人物/脸/姿态/构图/配色/特效全部不变,只提升画质。` + 升 size。
- **配锁定防漂**:升质=重绘=会顺手重新创作,二次优化句**必须带"保持…全部不变"**;只改局部就用方位词框死。

### 八.12 数量弱项 + 九宫格边界 + 高风险特征必出 SOP
- **硬数量是 Neo Image 2 死穴**:"九套/3×3/N 个不同"连跑两次都不准,靠"逐格点名 + 多跑筛"。
- **九宫格只适合"同主体多视图"**(四视图/turnaround/同角色多表情)。**不适合"多个完全不同的镜头"**(每格不同机位/动作/角色 → 数量翻车 + 逐格指派吃不全 + 每格只剩 1/9 分辨率)。多分镜 → **一镜一出**。
- **高风险特征"必出" SOP**:① 把关键形态特征前置标 `if missing the design fails`;② 预想它最可能翻成什么,写"失败模式 → 补救句"映射;③ 出图后逐项对账;④ 没到位就**真重跑 + 追加补救句**,别凑合。形态/特征值得这套对账;表情/画风靠具名特征 + 多跑筛。

### 八.13 角色关系驱动姿态/demeanor
姿态和特效不是孤立美术,是**人物关系的外化**。先想清谁强谁弱、谁主动谁被动:
- **真正的强者:平静、从容、甚至零特效**(强到不需要展示力量)。
- **弱/急的一方:张扬、用力、满身特效**(越使劲越显被压制)。
- 关系定了要**全片一致**,别中途反过来。
- **多人同框:把"关系"翻译成具体 blocking 并写死**。落到"谁坐/卧/倚/立、谁高谁低、谁俯视谁仰视、谁的目光锁在谁脸上"。**漏写体位 → 模型默认全员站立齐高;只写"看向某方向" → 望向虚空而非看人**。双方体位 + 相对高度 + 视线锁定到对方脸,按 正向 + CONSTRAINTS + Avoid 三处复写。

### 八.14 prompt 精简原则(短优于长 / 朴素优于术语)
给 AI 读的 prompt **适度重复 = 注意力强化**(同一硬铁律三处复写=加权),但**术语堆叠 ≠ 重复 = 稀释**。把"工程化分项 / 学术英文 / 元指令大段"换成朴素直白的人话,模型反而更服帖。

**5 类常见过度复杂(每写完一稿逐项自查)**:
1. **术语堆叠 vs 朴素一句**:光影别写 `★1/3 warm DIRECTIONAL key light at ~45°...★2/3 chiaroscuro...`,写 `Warm light from camera-right. Right half lit, left half in warm shadow.`。复杂构图时模型注意力被构图段吃掉,长光影段权重稀释。
2. **"族"标签分组 Avoid vs 平铺**:别写 `★(锚点漂移族)...★(视线漂移族)...`,直接平铺 6-12 条核心禁令,无标签。
3. **★★★ 大块开头声明 vs 一行点题**:别在开头堆 4-6 行 `THIS IS X NOT Y ABOVE ALL`,压成一行 + 把强调挪到 CONSTRAINTS。
4. **每张 ref 都长 disclaim vs 只对易漂处**:只对真正易漂的那张写长 disclaim,其他简单一句。
5. **HEX 色板大全堆叠 vs 沿用色卡一句**:第一帧定色卡后,后续仅 `warm crimson-gold per established color bible`,别每帧抄一遍 HEX 全表。

**总字数目标**:复杂帧 ≤ 500 词;简单帧 ≤ 350 词。超了回头剪。**适度重复 ≠ 啰嗦**:三处复写是把同一条信息加权;本节反对的是把一条信息用术语堆叠展开成 5 行。

---

## 八·进阶补遗(写重型 prompt / 调色板 / 排查翻车时查)

### 进阶.1 API 参数建议(完整段)
`size/quality/output_format` 是"配置即文档"——让 prompt 离开作者也能原样复跑。模板:
```
【API 参数建议】
model: gpt-image-2
[EDIT 类任务(在已有图上改光/改局部)注明:调用 images.edit,不是 generate]
size: [按细节密度给]   quality: medium   output_format: jpeg
Thinking Mode: 开启(复杂合成/多约束/多角色时)
参考图:Image 1 = [职责]   Image 2 = [职责]
【提醒】Preserve list 是核心;若是九宫格,在 PRESERVE 开头加 "preserve the multi-panel grid layout and the content of every panel"。
```
- **images.edit vs generate**:在现成图上改走 `images.edit`;从零建场走 `generate`。建改不分是双寄存器翻车根因。
- **output_format**:成片/物料一律 `jpeg`;要透明底/无损叠层才 `png`。
- **size 按细节密度**:单帧 1K~2K;**九宫格/多视图/群像站位图必须上 1536 长边或 2K+**,否则每格细节糊。
- **quality**:`medium` 是默认甜点;`high` 留最终交付。

### 进阶.2 hex 色板全档(强度递增 6 级)
"暖色调"模型有一百种解读,`#A82A2A` 是唯一解。按图值不值得越往下用得越重:
1. **逐元素 hex(嵌进描述)**:`cinnabar red #A82A2A talisman strips`。
2. **整段 color bible(13~22 色)**:TONE 之前列命名色板,每色"功能命名 + HEX":
   ```
   COLOR PALETTE (lock exactly): hot sunlight #F4E6C8, sand midtone #A89472,
   hard shadow #6B5A47, cinnabar accent #A82A2A (sole saturated focal color).
   All other colors restrained, desaturated, within this palette.
   ```
3. **60-30-10 三色英雄律 + 可数约束**:写成可数——`10% 点缀色 appearing at EXACTLY 4 named spots — no more than 4 accent points anywhere`。
4. **Mondrian 计数法**:同尺寸物靠**数量**做色块平衡(`a larger block = cluster of 5-6 identical items`)。
5. **甜区 13~22 色**:太少(<8)锁不住;太多(>25)模型记不住。
6. **黑白片仍给彩色色卡 + 转灰阶层级**:`render as black-and-white but preserve tonal hierarchy(红→中深灰、黑保深、白保亮)`。
> 色板条放在 TONE / 显影链**之前**(先定颜色,再定胶片质感)。

### 进阶.3 DP 三位调性表 + 两条显影链
写一个 DP 名 ≈ 一次下达几十条打光/构图/色彩指令的压缩包;胶片型号是比 DP 名更硬的物理锚点。

| DP 署名 | 调出什么 |
|---|---|
| **Greig Fraser**(Dune 2021) | 暖沙金褐、火光内景、低反差柔散光、"被沙漠晒过"质感 |
| **Roger Deakins** | 极简、冷峻、史诗孤独感、大 negative space、硬朗光比、克制色彩 |
| **Hoyte van Hoytema** | 大画幅 IMAX 质感、冷蓝夜景、暗部仍有色彩深度 |

三个名字**可叠用**做"调性配方"。两条显影链(抄走):
```
// 彩色日/夜景显影链(低饱和高对比、跳漂白苍茫硬调)
35mm Kodak Vision3 500T film stock with skip-bleach negative LUT,
analog photochemical grain, single still frame from a feature film.

// 黑白武戏显影链(真实黑白片基灰阶)
Kodak Double-X 5222 black-and-white film stock aesthetic. Anamorphic widescreen lens.
Subtle organic film grain only. Colors restrained, slight gray tone.
```
坑:① 优先用"DP + 公认代表作 + 时间";② DP 署名要和胶片/画幅风格自洽;③ `analog grain` 要配 `Avoid: heavy digital grain`;④ skip-bleach 去饱和会一起吃掉焦点色(焦点色要 `sole saturated / glowing` 显式拔高)。

### 进阶.4 题材级负向 Avoid(定制点名,不抄通用)
通用反 AI 味词库防"渲染质感";但模型对每个**题材**有专属俗气模板偏置。出图前问一句"这个题材模型最爱套哪几种俗气模板?"逐个 Avoid 掉。
- **沙漠航拍** → 排 `drone shot of modern desert resort, Burning Man aesthetic, desert wedding, modern military bivouac`。
- **弓箭手** → 排 `fantasy elf archer, 日式弓道家`。
句式贴在通用反 AI 味词库之后。负词不点名 = 不设防(但只是降概率,不是开关)。迁移到新项目时这一档**最需要重写**。

### 进阶.5 参考图风格冲突会整批塌方
同一职责喂进**互斥风格**的源(写实真人 vs 卡通),模型整批塌方——连续多条系统性崩,不是偶发。**别在文本上硬磨、别删画风字**(删画风反而放大塌方)——回去换一套**自洽的参考图**重建。根因在输入端(参考图互斥),加禁令/删词都是打补丁治不了上游。

### 进阶.6 三大原理 + 资产收敛链 5 步
**三大原理**(双寄存器底层):① **滑块原理**:图生图每次在"照抄输入↔自由发挥"间选点,重型 prompt 推向"按我说的造",轻型推向"基本照抄、只动点名处"。建用轻型句 / 改用重型句 = 推错方向。② **信息密度 = 可控度**(建必须重):设定表要同时锁解剖/版式/布光/材质/色板/比例尺,没一项能靠"一句话+一张图"。③ **最小破坏**(改必须轻):图已满意时,prompt 写越多越可能"顺手"重画没让动的地方。

**资产收敛链 5 步(建一次,改十次)**:
```
①重型建参考图 → ②重型建设定表/关键帧 → ③轻型修画质 → ④轻型改单变量 → ⑤轻型清理
```
一旦重型把"身份+形态+比例"钉死,后续全是中文一句话微调。第一步判错"建还是改"是最大时间黑洞。

### 进阶.7 多动作叠加衰减(一次只压一个主动作)
叠 ≥3 个微动作做复合情绪,会**衰减**成中性结果,加参考图也救不回。**正解**:一次只压一个主动作/主情绪;表情维度优先靠"表情参考图 + 逐特征点名"(`复刻无奈流泪欲哭无泪的表情和厚嘴唇和明显的眼白和大黑眼珠子`——逐特征点名才奏效,抽象动词"复刻表情"无效)。

### 进阶.8 "softness is intentional and desired" 锚点
写 `slightly soft / film-like softness` 时,模型默认会把"soft"当缺陷反手锐化掉。加一句"这柔是故意的、想要的",模型才肯当目标:
```
PHOTOGRAPHIC TONE: this image is a film still ... that may appear slightly soft
and imperfect, like a real photograph — this softness is intentional and desired.
```
只对"刻意柔焦"题材有用;要平面矢量色板/标题卡(本就要 tack-sharp)时**别加**。

### 进阶.9 CONSTRAINTS 三种否定句式
CONSTRAINTS 管"叙事/逻辑/物理绝对不能发生的事"(≠ Avoid 管渲染 AI 味)。按纠偏类型用三种句式:

| 句式 | 管什么 | 例 |
|---|---|---|
| **NEVER** | 绝不出现(尺度/逻辑铁律) | `The whole dragon must NEVER be fully visible — only a fragment.` |
| **Do not** | 禁止操作(形态锁/NO-FACE/数量锁) | `Do not show any human facial features — the entire face is and must remain the black LED panel.` |
| **NOT...but...** | 程度纠偏(别走极端) | `Half-ruined, NOT flattened — must still be recognizable.` |

逻辑/形态/数量禁令进 CONSTRAINTS;渲染 AI 味进 Avoid。放错块权重不够会翻车。

### 进阶.10 渲染精确 HEX/文字不可靠
让模型把**精确 HEX 码 / 长串精确文字**当像素渲染进图里(色卡卡片、设计稿上的码与标签),文字与色块数量大概率错排。**铁律:以 prompt 里写死的码为准,不要回读出图核对。** prompt 写了 `#A82A2A`,这张图的"真值"就是 `#A82A2A`,哪怕出图上印的是别的码也别据图修正——错的是渲染,不是你的码。

---

## 九、整剧编排流水线(剧本 → 全套出图)

SKILL 解决"一句要求 → 一条 prompt";本节解决"**一整个剧本/分镜 → 一份生产计划书 + 全套可跑 prompt**",且每一步都让用户能拦下来核对。

### 一句话流程
```
剧本/分镜
  → ① 解析:抽四张表(角色 / 场景 / 道具·生物 / 镜头)
  → ② 路由:每个资产·镜头匹配图型(决策树 + tie-break;拿不准先问)
  → ③ 规划:按"资产收敛链"排出生产计划书 ──〔闸1 用户确认计划〕
  → ④ 生成:★全局色卡永远第一张 → 角色定妆 → 镜头;逐条出 prompt ──〔闸2 地基单图脸/形态确认 · 闸2a 每个定妆后必问"要不要转四宫格" · 闸2.5 关系板确认才拆单帧〕
  → ⑤ 校对:每条配校对清单,高风险标 MAX + 多种子筛帧 ──〔闸3 成图验收〕
```

### 「AI 自动做」 vs 「必须用户拍板」
| AI 自动做(做完报告即可) | 必须用户拍板(没点头不往下走) |
|---|---|
| 解析剧本抽四张表 | 表里有歧义/缺失项 → 问用户补,别脑补 |
| 跑分类决策树、写「判定说明」 | 判定拿不准 / tie-break 仍打平 → 问用户 |
| 排生产计划书草案 | **闸1**:计划书要用户确认才开工 |
| 逐条生成 prompt | **闸2**:地基单图出图后确认"脸/形态对了" |
| 建议要不要补四宫格 | **闸2a**:每个定妆过闸2 后**必主动问**"要不要转四宫格" |
| 写校对清单、标 MAX | **闸3**:成图验收由用户拍板;不合格回退重跑 |

**主动引导铁律**:每完成一阶段或一道闸,主动告诉用户四件事:① 现在在哪一步;② 产出了什么;③ 过没过闸/要不要确认;④ 下一步是什么、需要你做什么决定。

### 阶段① 解析剧本 — 抽四张表
**★ 抽表前先确认输出用途**(决定表D 颗粒度):**视频首帧**→ 表D 按 clip 切(一行=一个连续镜头,连续动作/正反打并入);**逐 cut 分镜板 / 物料**→ 按 cut 精拆。用途不明先问。

- **表A 角色表**:角色名 / 外观锚(脸发服一句话)/ 是否已有 ref / 强弱关系 / 固定色(颜色+形态)。
- **表B 场景表**:场景名 / 环境一句话 / 基调(跟项目走)/ 是否需建场参考图 / **是否双人对话场景 → 需关系板**(标"需"的场景数 = 关系板张数,解析时就数出来报给用户)。
- **表C 道具·生物表**:名称 / 类型(决定走哪种设定图)/ 形态命门(最易翻车特征)/ 数量·形态锁。
- **表D 镜头表(核心)**:镜号 / 谁(标主次)/ 在哪 / 做什么 / 景别·机位 / 情绪 / 同框人数(决定防串脸强度)。

> **★ 首帧切分规则(视频首帧用途)**:表D 一行 = 一个 clip = 一段连续镜头,不是每个剧本切镜标记。硬切才立新行;连续动作/运镜并入;正反打 fill 镜直接用关系板 6 格当首帧,不写 hero 首帧。对话戏尤其别按 cut 1:1 出帧。

解析完输出四张表给用户看,主动点出歧义/缺失,必须用户补,不脑补。

### 阶段② 分类路由 — 每个资产·镜头匹配图型
**先归大类**:Ⅰ 叙事画面(01–09)、Ⅱ 多格/分镜板(10–13、31)、Ⅲ 工业设定图(14–22)、Ⅳ 物料/平面图(23–30)。

**分类决策树(信号 → 图型)**:
```
资产 ── 走 Ⅲ/Ⅳ
  ├─ 角色要反复合成下游 → 14 角色四视图定妆
  ├─ 生物/机械兽 → 15 creature sheet / 16 侧身正交 / 19 机械兽形态
  ├─ 载具 → 18 ; 武器 → 20 ; 要定全片颜色 → 23 色卡(最先做)
  ├─ 要人物与道具比例 → 21 比例尺 ; 同物种不同等级 → 22 变体
镜头 ── 走 Ⅰ/Ⅱ
  ├─ 同框 ≥3 人 / 锁站位 → 01 群像站位图  ★高频
  ├─ 同框 2 人 + 对话戏 / 锁轴线视线 → 31 正反打关系板  ★换场景必出
  ├─ 单主角要成片美图/英姿 → 02 彩色关键帧
  ├─ 大场面/高空 → 03 航拍 ; 武戏黑白 → 04
  ├─ 脸/表情精确复刻 → 06 ; 从成图抠特写 → 07 ; 极近微距 → 08 ; 只改光 → 09
  └─ 多机位一次看 → 10 ; 武戏连续 → 11 ; 同主体多状态 → 12
物料阶段 → 26 介绍卡 / 27 海报 / 28 标题卡 / 24 灰底抠图 / 25 knolling
```

**tie-break(打平时按序裁决)**:① **"要不要当下游参考图"优先**(后面要当 ref → 一律走 Ⅲ 设定图)。② **人数定生死**(≥3 人读站位 → 永远 01;2 人对话锁轴线 → 31)。③ **"建大特效" vs "改单点"**。④ **多格 vs 单帧**(九宫格只适合同主体多视图)。⑤ **仍打平 → 问用户**。

**拿不准就问**:决策树两支都通且 tie-break 仍打平 / 镜头描述读不出景别人数 / 形态命门不清 / 混合性质 → 停下问用户。混合剧本先拆段再逐段分派。

**判定说明格式**(每个资产/镜头一行给用户核对):
```
〔<资产/镜号> → <图型号 图型名> · <Ⅰ/Ⅱ/Ⅲ/Ⅳ> · <重型建 Image2 / 轻改 NanoPro> · <参考图依赖>〕
```

### 阶段③ 规划排序 — 按"资产收敛链"排生产计划书
核心 = **资产收敛链**:下游图靠上游图当参考图收敛,上游没做好下游必崩。顺序是硬依赖,不是建议。

**五个生产阶段(严格按此顺序)**:
1. **项目常量(全片地基,最先锁)**:色卡 color bible(图型23)、形态锁清单、题材级负词库。**★ 全局色卡永远第一张交付物。** 色卡两件套:① 文字 HEX 真值(写进每条 prompt 三处)② 可视化色卡板(给人眼检协调)。颜色真值以文字码为准,别从板上回读。**来源(第一律)**:用户给一张电影感场景剧照 → 图型23 提取调色板生成色卡。
2. **地基资产(下游的"参考图原料")— ★ 两步走,别一上来就出四宫格**:① **地基单图**(真人脸→半身锁脸,最好带场景背景虚化;形态命门资产→全身/正交);② **四宫格 turnaround**(必须先问用户要不要,确认才把第1步那张当 Image 1 转 — 角色走图型14,生物走图型15)。**为什么必须在镜头之前**:群戏是图生图,要把稳定资产当参考图喂进去锁脸/锁形态,没先有稳定参考就合成 → 必串脸。闸2 拆成 闸2(单图确认)→ 闸2a(必问转不转四宫格)→ 四宫格确认 三段,严禁合并跳步。
3. **场景关系锚(对话戏专用 · 一个对话场景一张)**:**「01 俯视站位 + 31 平视正反打」一对,01 先出**(给双人全身 + 空间关系远景,下游的全身/走位帧拿它当 blocking 参考);31 锁 180°轴线 + 视线 + 正反打覆盖。两张左右站位/朝向必须一致。**★ 01 是 blocking 真源——必须当 Image 喂回下游 + 按它推翻脑补的 blocking**(常翻车:作者凭剧本字面想象 blocking,01 一出来发现真实空间不同,此时整张 prompt 的体位/相对高度/距离/视线方向都要按 01 重写)。**★ 01 改人物"如何摆",不改"镜头放哪、拍多大"**(机位/景别永远以剧本为准)。多版必须钦点一张作 final 并全程冻结,换版要回头校全部下游。**首次规划就数出关系板张数 + 让用户 opt-in。多场景剧本:每进新对话场景必先出该场关系板,绝不跨场景套用上一场轴线。**
4. **关键帧 / 站位图(用阶段2资产合成的成片镜头)**:群像站位(01)、彩色关键帧(02)、航拍(03)、武戏(04)、复刻帧(06)、九宫格(10/11/12)。这是"出分镜图"的主体产能。
5. **物料 / 海报**(介绍卡26/海报27/标题卡28/灰底抠图24);**轻型修**(Nano Pro 单点微调)最后。

> **顺序总结**:色卡(常量) → 设定图(原料) → 关系板(对话戏锁轴线) → 关键帧(合成) → 物料(抠成品) → 修(打磨)。每层消费上一层产物当参考图。跳级 = 让模型凭空脑补它本该从参考图读取的东西 = 串脸/漂色/形态崩/跨轴。**资产收敛链是单向的,不能倒着跑。**

**生产计划书格式**:按阶段列可勾选项,每项标 `来源 / 依赖 / ⚠ 高风险 MAX`。
**★ 闸1**:计划书出来后主动请用户确认(① 排序对不对 ② 色卡锁对没 ③ 有没有遗漏 ④ 哪些标 MAX),确认前不进阶段④。

### 阶段④ 逐步生成 — 按计划书逐条出 prompt
每条 prompt 固定四步:① **取图型骨架**(§十一 对应图型填空骨架);② **套手艺**(六段式/双寄存器/防串脸三件套/颜色三处复写/质感词库/CONSTRAINTS 三句式);③ **灌项目档案**(色卡/形态锁/身份锚/题材负词);④ **标依赖与操作**(传哪几张参考图、size/quality、Thinking Mode、Image2 还是 Nano Pro)。

顺序纪律:严格按 P1→P5;阶段1色卡先出;到阶段2每个地基资产出完 prompt + 校对清单就**停下过闸2**,不往下堆;阶段3每条的"参考图依赖"必须指向**已过闸的**上游。
- **★ 闸2**:地基资产出图后请用户确认(脸锁住 / 形态服装对 / 合色卡)。
- **★ 闸2a**:每个定妆过闸2 后**必主动再问一次**"要不要转四宫格"(turnaround 是 post-定妆 才判得清的可选项,闸1 说"先只做半身"不等于永久否决)。地基没过闸2 → 依赖它的阶段3 镜头一律不开工。

### 阶段⑤ 校对 — 校对清单 + 高风险 MAX + 多种子筛帧
每条 prompt 附该图型专属校对清单(直接取自 §十一 图型条目)。把已知最易翻车的特征标 `⚠ MAX`:多角色同框→串脸 MAX;形态命门资产→形态 MAX;数量类→数量 MAX;颜色对垒→漂色 MAX。对高风险/复杂调度的图(站位图、九宫格、形态命门资产)**明确建议冻结 prompt + 连刷多版多种子挑最准那张**(如群戏站位建议刷 6–8 版)。
- **★ 闸3**:每条图出来请用户对照校对清单验收。不合格回退:**单点崩**→阶段5轻修;**换姿态级大改**→回阶段④ Image2 重起;**地基资产崩**→回阶段2重刷并重过闸2,所有依赖它的下游一并回炉。

**收尾**:全部过闸3后给用户完成清单(出了哪些图、对应镜号、刷了多版、还剩待修),更新计划书勾选状态。

---

## 十、项目档案模板(填空 · 每个新项目复制一份填)

> 引擎(本文 §一~九 + §十一 图型库)不动;换项目只改这张档案。出图前先确认是哪个项目、加载对应档案,把"色卡/角色/基调/Avoid/进度"喂进六段式。两个基调相反的项目(如"清爽明亮蓝天调"vs"压抑苍茫沙漠调")要分开建两份档案,别混——装错就全漂。

```markdown
# 项目档案 · <项目名>

## 世界观 & 基调
- 世界:<一句话设定:末世废墟 / 沙漠奇幻 / 都市…>
- 基调(定死):<清爽明亮蓝天调 or 压抑苍茫 Dune 调 or 其他;先定死,逐镜照搬>
- DP 调性锚点:<Greig Fraser Dune 2021 / Roger Deakins / Hoyte van Hoytema,可叠;胶片型号>
- 标准:size <16:9 / 21:9 / 9:16>, quality <2K / 4K>

## 🎨 配色铁律(全片锁死,不许漂)
| 角色/能力 | 颜色(HEX) | 形态/质地 | 一句话铁律 |
|---|---|---|---|
| <角色A 的能力> | <#______ 颜色名> | <软/硬 · 粒子/结晶 · 气态/固态> | <一句话> |
| <角色B> | <#______> | <…> | <…> |
> 双区分轴:<A 色相 vs B 色相> + <A 形态 vs B 形态>。即便同色系,形态一眼能分。
> 负向常驻:<错误颜色1>、<错误颜色2>、<A 别撞 B 色>。

## color bible(可选 · 13~22 色,要全片统一调性时建)
COLOR PALETTE (lock exactly): <#______ 功能命名>, <#______ 功能命名>, …
其中 <#______> 做唯一/重点饱和焦点色,其余 restrained desaturated。

## 角色 ref 清单
- <角色A> = <参考图描述(全身/四视图/半身定妆)> → 身份锚:脸/五官/发型/服装。
- <角色B> = <…>。
- <场景X> = <参考图> → 只做背景结构,不提供色调。
- <暂无 ref 的角色> = 按"<外观一句>"处理;若要露脸/反复出现,先单独做一张参考图。

## 角色关系(驱动姿态,定死)
- <谁 远比 谁 强>。强者 = 平静从容甚至零特效;弱者 = 张扬用力满身特效。全片一致。

## 形态锁清单(CONSTRAINTS 句式 · 跨帧复用,描述层/禁令层/Avoid 层各重申一遍)
- <资产名 = 形态命门>:`<英文 CONSTRAINTS 句:MUST be... / Do not... / If missing the design fails>`
  跑歪兜底句:`<失败模式 → 补救句>`(命中即追加并真重跑)

## 通用 Avoid 负向库(每镜带)
```
<错误颜色串>, faces swapped or merged, <film grain / 噪点 视基调>,
<基调反向词,如清爽调排 gloomy/dust haze;压抑调排 bright saturated sky>,
plastic skin, overpolished studio look, HDR glow, cartoon, video-game render,
extra characters, text, watermark, logo,
<题材级负向:此题材最易被误画成的相邻题材,逐个点名>
```

## 题材级负向(本片 Avoid 必带 · 迁移新项目最需重写)
<把"沙漠→现代度假村/婚礼/Burning Man"这类模型偏置逐个排掉>

## 分镜进度台账
| 镜 | 内容 | 状态 |
|---|---|---|
| S1 | <内容> | <✅封板 / 🔄收尾 / ⏳待做> |
> 进度更新后改这张表即可。
```

---

## 十一、图型模板库(31 种 · 分类路由查图型总表)


> 出图 prompt 引擎的零件库。分类路由命中图型后,来此取「填空骨架」填空生成,再用该图型「校对清单」逐项对账。每个图型四段:何时用 / 命门 / 填空骨架 / 校对清单。

---

## 图型总表(分类路由查这张表)

判图型时先归大类,再落具体型。

**Ⅰ 叙事画面(成片镜头)**
- 01 上帝视角群像站位图(blocking) ｜ 02 彩色叙事关键帧 ｜ 03 建场航拍 ｜ 04 黑白武戏静帧 ｜ 05 双头沙漠极光帧(白点+22色卡) ｜ 06 角色姿态/表情复刻帧 ｜ 07 从成图抠主体特写 ｜ 08 极限微距叙事帧 ｜ 09 重打光 edit(只改光)

**Ⅱ 多格/分镜板**
- 10 九宫格场景多机位分镜 ｜ 11 九宫格武戏分镜(首尾镜像) ｜ 12 状态批量九宫格(完好→被毁) ｜ 13 民族志服装陈列板(3×3) ｜ 31 正反打双人对话关系板(180°轴线·换场景必出)

**Ⅲ 工业设定图(turnaround)**
- 14 角色四视图定妆 ｜ 15 生物 creature sheet(多视图) ｜ 16 生物侧身正交全景 ｜ 17 纪实实景陈列(反棚拍) ｜ 18 载具设计图 ｜ 19 机械兽形态设计图 ｜ 20 武器四视图(借结构换材质) ｜ 21 比例尺立绘(人剑等高) ｜ 22 同物种变体(兽王/精英)

**Ⅳ 物料/平面图**
- 23 色卡 color bible ｜ 24 灰底物料抠图 ｜ 25 knolling 桌面陈列 ｜ 26 杂志风介绍卡(60-30-10) ｜ 27 EVA 风人物海报 ｜ 28 片头标题卡 ｜ 29 绿幕/动捕占位图 ｜ 30 质感后缀模块(挂载件,非独立图)

---

## 图型 01 · 上帝视角群像站位图(blocking diagram)

**何时用**:一个空间内 ≥3 角色/生物同框,需锁死"谁站哪、朝向、谁挡谁、远近"。它是站位蓝图,位置/朝向/影调正确优先于美感,不是成片美图。

**命门**:
1. **depth order 逐层声明 + 结尾复述一遍**:从相机往里(前景→近侧→远侧中景→最远→背景)逐层写谁在哪,写完用一句 `So the depth order from camera into the scene is: A → B → C → D → 背景` 复述。
2. **长投影当"站位读取器"**:高空俯瞰靠地面长软影才看得清谁站哪。
3. **巨物横陈做"分割墙"**:有大体量物时让它横贯画面分区 + 做尺度对照。
4. **三件分工**:逐张关键帧标机位职责 + 逐角色一行身份锚 + 色卡。

**填空骨架**:
```
模式:图生图(多关键帧机位图 + 角色参考图 → 合成俯瞰站位图)
size 21:9 超宽 / quality medium / jpeg / Thinking Mode 开
用途:blocking diagram,位置/朝向/影调必须正确,美感其次

【参考图标注 — 务必逐张对应】
- 关键帧1:<从谁背后·越过谁·望向谁 的机位> —— 仅提供机位视角,不提供内容
- 关键帧2:<怼近拍某角色的机位>  - 关键帧3:<拍另一侧的机位>
- 角色参考(逐个一行,仅锁身份):<角色A 一句外观锚>;<角色B…>
- 色卡:整图色彩严格按色卡执行

【PROMPT 正文】
A high-angle bird's-eye establishing shot — an oblique overhead view looking down ... used as a staging / blocking diagram. The entire layout must be read clearly from above. <胶片+调性签名>. 21:9 ultra-widescreen. <环境一句>.
Spatial layout (this is the critical part — lay it out exactly), reading across the depth of the frame:
- FOREGROUND, near side: <最大主体/巨物,横陈做 long horizontal wall 切开画面>
- NEAR side: <角色组A + 朝向 + 状态>  - FAR side / middle distance: <角色组B + 朝向 + 状态>  - FARTHEST back: <角色/物C>
So the depth order from camera into the scene is: <A → B → C → D → 背景>.
Lighting / tone: warm hazy directional light raking from one side, long soft shadows cast across the ground from each figure (the shadows help read the staging from above), low-contrast desaturated tone, strictly following the color card.
PHOTOGRAPHIC TONE: real photographed film still from high above, slightly soft, not tack-sharp.
Avoid: oversharpening, HDR, plastic smoothing, oversaturation, generic AI aesthetic, <题材级负向>.
```

**校对清单**:depth order 几层都读出来了?巨物够大当分割墙没?每个角色身份对、没串脸/贴反?长投影出来没?机位是真·高空斜俯吗?

---

## 图型 02 · 彩色叙事关键帧(参考图锁脸 + prompt 管构图)

**何时用**:单主角(偶尔含巨物道具)、要一张能直接当成片镜头用的彩色关键帧——海报级/章节定帧/情绪英姿,讲究构图张力与冷暖电影感。和图型 01 正相反:这里单人、美感与构图张力优先,脸往往出画或被透视牺牲。

**命门**:
1. **"参考图管脸、prompt 管构图"职责切分,正文开头一句写死**:`以放入的<参考角色>作为参考角色锚定人物长相/发型/服装,本 prompt 只规定构图、姿势、占比、光线、景别与前景,不描述五官`。脸一旦让 prompt 描述就串脸。
2. **Markdown 分节拆功能块**:`# 画幅与镜头 / # 人物占比与构图 / # 衣物的动态 / # 光线与色调 / # 纵深层次与对焦 / # 约束`,最后 `# 约束` 把要点再复述一遍(重复=注意力强化)。
3. **一个"视觉锚点"统管全画面虚实/动势**:唯一对焦高光 / 红飘带横贯动势 / 巨剑怼镜头透视支点——一张图只能有一个这种锚。
4. **正反双管锁着装防脑补换装**:既正向列着装清单,又负向写 `不要无袖战斗装、不要护臂革囊`。
5. **冷暖对撞 + 逆光半剪影做电影感**:暖前景对撞冷背景,人物在亮天映衬下偏暗、留光边。
6. **双人/越肩/对话帧:体位 + 视线锁定必须写死**(单人帧忽略):① 每人体位 + 相对高度(谁坐/卧/倚/立、谁高谁低)——漏写哪个就被默认成站立齐高;② 视线锁到对方脸/眼,写 `gaze LOCKED onto X's face / eyelines meet`,绝不只写模糊的 "look toward / 朝向"。两项按 [正文] +【CONSTRAINTS】+【Avoid】三处复写。
7. **远距离对话帧(隔屋对峙/跨桌)视线锁定难度阶跃,三处复写不够**:远距离一旦超出"一臂之内"就掉控,模型会把两人画成各自低头沉思(看似在看其实没看)。加固:① 正向写 `eyelines MEET across the room, both heads slightly LIFTED to look at each other`;② Avoid 段把"低头沉思"族逐项排除(`looking down at the table / heads bowed / eyes lowered / each lost in their own thoughts / averted gaze`);③ 纯侧脸改 3/4 朝向对方;④ `head TURNED toward the other person, chin slightly LIFTED`。

**填空骨架**:
```
模式:图生图(角色参考图锚脸 + 本 prompt 只管构图)
size 21:9 超宽 / quality 2K / Thinking Mode 开
中文分节式,纯叙事彩色关键帧,脸出画或透视牺牲皆可

[图像生成 prompt — <镜头名> · 参考角色<X> · 无文字]
以放入的<X>作为参考角色锚定人物长相/发型/服装,本 prompt 只规定构图、姿势、占比、
光线、景别与<前景/环境>,不描述五官。画面中不出现任何文字、签名、手写字、水印<、UI/图标/电量/时间>。
# 画幅与镜头:<21:9;机位角度——仰拍/荷兰角/广角畸变;镜头——长焦浅景深 or 广角透视>
# 人物着装(用<X>本身那套,严格锚定):<正向列衣物>;<负向:不要__、不要__>
# 人物占比与构图 / 姿势:<位置(右半/偏右三分之一)+朝向+身体取景段(头出画/只露上半身)+张力姿态>
# 核心视觉锚点:<唯一对焦高光 / 红飘带横贯动势 / 巨剑怼镜头透视支点——三选一,只能一个>
# 衣物的动态:<被风掀动、定格动态模糊、布料绷弧>
# 光线与色调:<冷暖对撞:暖前景 vs 冷/发白背景;逆光半剪影留光边;低饱和>
# 纵深层次与对焦:<最实处是谁、由此向外发散虚化、焦外是谁>
# 约束:<把以上每条要点逐行复述一遍 + "画面只有这一个人物" + 无文字>
```

**校对清单**:脸串了没?唯一视觉锚点立住了吗?冷暖对撞 + 逆光半剪影出来没?着装有没有被脑补换装?构图微指标(护手锁角/朝向/脚出画剑出画)落地几条?强透视镜远端人物还认得出脸吗?双人/越肩帧体位/相对高度对吗、视线真锁到对方脸上吗?远距离对话帧双方头都抬起、视线相接、没人低头看桌/地?人物数对 + 零文字吗?

---

## 图型 03 · 建场航拍(top-down 高空俯瞰 establishing)

**何时用**:给一个聚落/营地/场景做世界观奠基的高空大全景——一张图钉死整个空间的布局/建筑/光照/色板,当 establishing shot 用。几乎没有具名角色(只有 tiny human figures 做生活气),重点是空间组织 + 数量锚定 + 可信生活细节 + 反 AI 航拍味。

**命门**:
1. **空间组织写成一句可读的几何**:如"崖壁蜂窝崖居 + 崖脚中央广场"或"concentric loose rings,最中心一顶仪式大帐,向外环环叠出约 40 顶帐篷"。布局要能一句话画出来。
2. **数量锚定增可信**:`roughly forty individual tents` / `dozens of tiny human figures`,给具体数量模型才不会糊成一团。
3. **散布"signs of life"细节**:炊烟 + 晒肉架 + 打铁火星 + 兽栏 + 沙艇 + 晾染布,反"无人 CGI 沙盘"。
4. **golden hour 低角侧光 + 长影**:`late afternoon golden hour, low warm sun from screen left, casting long crisp shadows`,长影给电影感又帮读建筑体量。
5. **完整摄影签名 + 题材级负向**:加超长 Avoid 专门排掉模型的航拍审美偏置(`drone shot of modern desert resort / 沙漠婚礼 / Burning Man / 现代军营`)。
6. **"唯一焦点色"在同色系里会被吃掉**:暖沙调里钉一抹朱砂红常被环境同化,要抢眼就加面积/提对比/挪到反差位(如旗幡放塔顶)。

**填空骨架**:
```
模式:文生图(单段连贯英文,无需参考图)
size 16:9 / quality 1K-2K
单段叙事式航拍,世界观奠基,钉死布局/建筑/光照/色板

A photorealistic top-down aerial bird's-eye view photograph of <聚落/营地一句话>,
16:9 horizontal cinematic composition.
<空间组织几何:依崖蜂窝 / concentric rings + 中心地标 + 数量锚定 roughly N units>.
<建筑/帐篷材质 + 染色 deep burgundy / dust-cream>.
<中心地标:relic forge / ceremonial tent + 黑烟柱/旗幡>.
<散布道具:沙艇 / 兽栏 / 打铁站 / salvage pile>.
Signs of life: <tiny human figures + 炊烟 + 晒肉架 + 晾染布 + 骑兽者接近>.
Lighting: late afternoon golden hour, low warm sun from screen left, long crisp shadows,
<heat-shimmer + 悬浮尘粒>.
Color palette: <8-10 色逐项 hex,含 cinnabar red #A82A2A 做唯一/重点饱和色>.
PHOTOGRAPHIC TONE: high silent drone or distant cliff perch, 35mm Kodak Vision3,
skip-bleach LUT, organic film grain, aerial atmospheric haze, restrained colors.
Avoid: <反AI味通用串> + drone shot of modern desert resort / Burning Man / 现代军营 等题材级负向.
```

**校对清单**:布局几何对不对?数量锚定兑现了吗(约 40 顶别糊成一片)?signs of life 细节齐不齐?golden hour 长影出来没?唯一/重点饱和焦点色立住了吗(易被暖沙吞掉)?有没有 AI 航拍味/题材跑偏(度假村/婚礼/Burning Man/军营)?中心地标辨认得出吗?

---

## 图型 04 · 黑白武戏静帧(B&W wuxia action film still)

**何时用**:主角持械打斗 / 群战 / 单帧动作高潮,要的是"真实片场拍的黑白武术电影剧照"而非彩色成片或插画——黑白本身就在帮你滤掉 AI 的塑料感与过饱和。两种产出形态:单帧(一招一式定格)与九宫格分镜(一张 prompt 出整段武戏 storyboard,首尾镜像闭环)。借的是动作张力,不是器物结构。

**命门**:
1. **三参考图严格分工,第三张当"灰阶色卡"**:`Image 1 = main character (lock costume design exactly) / Image 2 = heavy mechanical sword (lock weapon design exactly) / Image 3 = color palette for tonal hierarchy in grayscale`——黑白片里仍用彩色色卡把红/黑/白转译成灰阶层级,否则黑白成片糊成一团没层次。
2. **暴力降级句必带(过审命脉)**:`opponents are knocked back by force, not visibly injured. No wounds, no damage, no blood.` 交击帧再叠 `sword meeting sword, NOT sword meeting body`;倒地帧叠 `lying still as if asleep or unconscious, no visible injuries`。
3. **黑白胶片签名固定段**:`Kodak Double-X 5222 black-and-white film stock aesthetic. Anamorphic widescreen lens.` + `Black-and-white grayscale only with full continuous tonal range`(强调连续灰阶,挡 line art / manga)。
4. **力 = 沙墙 + motion blur,不是血**:`the visual focus is on the sand wall and the force of the swing, not on body damage`——用扇形沙墙、运动模糊、弯刀脱手旋飞承载暴力感。
5. **(九宫格专属)全局锁定 + 首尾镜像**:开头一段写死跨格一致性(主角 + N 敌 + 光向 + 风向 + 胶片机型 + 逐材质灰阶映射),再逐格写镜别;`PANEL 09 = EXACT same camera as PANEL 01`,只把敌从逼近变伏地、光从晨变暮,形成叙事闭环。

**填空骨架**:
```
模式:图生图(3 参考图 → 单帧 / 或文生图九宫格)
size 16:9 / quality 2K
用途:黑白武术电影剧照,要真实片场实拍感,非插画/漫画/concept art

【参考图分工 — 黑白武戏铁三件】
- Image 1 = 主角(lock costume design exactly,必要时点名 boots/leg wear/lower coat)
- Image 2 = 武器(lock weapon design exactly)
- Image 3 = color palette for tonal hierarchy in grayscale ← 彩色色卡转译灰阶层级

【PROMPT 正文 · 单帧】
A single 16:9 cinematic black-and-white film still from a live-action martial arts film.
Photorealistic photographic image, NOT illustration, NOT manga, NOT concept art.
Black-and-white grayscale only with full continuous tonal range.
Reference images: <三件分工逐行>.
SHOT: <机位 + 景别 + 构图,如 Extreme low angle, explosive vertical composition>.
The warrior from Image 1 <动作:bursting upward / horizontal swing / kneeling block>,
the heavy mechanical sword from Image 2 <剑的运动 + realistic motion blur>.
<N> desert raiders <被掀飞/格挡的物理动势>, their sabers knocked loose spinning away.
Focus on force, motion, and impact — opponents are knocked back by force, not visibly injured.
No wounds, no damage, no blood. <交击帧加:sword meeting sword, NOT sword meeting body>.
Composition: <能量走向,如 dynamic diagonal sweep lower-left to upper-right>.
PHOTOGRAPHIC TONE: Film still captured during a real shoot — slightly soft and imperfect.
Soft natural lighting with realistic falloff, not HDR. Subtle organic film grain only.
Realistic motion blur on the sword arc and tumbling figures. Natural lens depth of field.
Kodak Double-X 5222 black-and-white film stock aesthetic. Anamorphic widescreen lens.
Colors restrained, slight gray tone.
Avoid: oversharpening, artificial sharpness, heavy digital grain, HDR effect, beauty-filter
skin, AI-generated aesthetic, overpolished studio look, plastic smoothing, oversaturation,
glossy highlight blowout, generic AI image quality, illustration style, manga style, concept
art style. Aspect ratio: 16:9. Output: single cinematic film still.

【九宫格变体】:开头加全局锁定段(N敌+光向+风向+逐材质 GRAYSCALE RENDERING REQUIREMENTS),
逐格 PANEL 01–09 写镜别动作,PANEL 09 镜像 PANEL 01,结尾 CRITICAL FINAL DIRECTIVE 复述
「黑白 / 真实片场 / 编排武打非血腥」。Output: 3x3 grid, 编号 "01"–"09"。
```

**校对清单**:真黑白连续灰阶吗(没跑成 line art/manga/上色;红黑白三档明暗拉开了没)?无伤害降级兑现了吗(无伤口/血;交击帧是剑碰剑还是剑砍身)?服装/重剑身份对不对?力度感出来没(沙墙/motion blur/弯刀旋飞)?Double-X 颗粒 + anamorphic + 微软焦,没被锐成塑料?(九宫格)跨格光向/风向/主角一致、首尾 01↔09 同机位镜像对上没?

---

## 图型 05 · 双头沙漠极光帧(白点定位 + 22色卡)

**何时用**:两个主体(尤其一人一机)在同一空旷画面里,要精确钉死各自 XY 位置 + 各自身份不串的史诗叙事静帧。最大风险是"机器人头被画成人类脸",本图型整套手法就是为攻克这个而生(白点定位 + 逐头身份锚定 + 显式"非人类"声明)。21:9 宽银幕、纯中文重型结构。

**命门**:
1. **白点构图定位图(把 XY 写成可指认坐标)**:专喂一张参考图,两个白点精确标记两个头的最终位置——`左侧白点标记<主体A>的头出现的位置,右侧白点标记<主体B>的头出现的位置,最终画面里两个头必须分别占据与这两个白点完全一致的位置`。这是双主体不挤、不漂、不互换的关键。
2. **逐头身份锚定 + 显式"非人类"声明**:每个头单独一张参考图只锚一个身份,且对机器人明写否定:`<机器人角色>是一个人形机器人而非人类……他不应被生成为人类`。缺它必翻。
3. **姿态写成物理因果,不写"请仰头"**:用"脖子被埋→被迫后仰→这是物理约束自然产生的结果"的因果链让姿态自然成立。
4. **22色环境色卡当影调统帅**:专喂一张色卡,沙漠和夜空严格按 22 色不可偏离;冷青蓝夜色主导、极光带翠绿→紫罗兰渐变作诗性主光源、阴影保留色彩深度而非死黑。
5. **多 DP 署名 + Kodak Vision3 定影调**:Roger Deakins / Greig Fraser / Hoyte van Hoytema 综合视觉语言,低饱和高对比电影暗场,21:9 anamorphic,35mm Kodak Vision3 500T + skip-bleach negative LUT。

**填空骨架**:
```
模式:图生图(4 参考图 → 双主体定位合成)
size 21:9 超宽 / quality 1K / 纯中文重型结构
用途:双主体史诗叙事静帧,精确控 XY 位置 + 身份不串(尤其人机不混)

【参考图分工 — 四件,各司一职】
- 参考图①(构图定位):两个白点精确钉位 ← 左白点=主体A的XY,右白点=主体B的XY
- 参考图②(身份锚A):仅锚 A 身份;若 A 是机器人/非人,显式写「是机器人非人类,不应被生成为人类」
- 参考图③(身份锚B):仅锚 B 身份 + 神态(眼神/表情/发被风吹)
- 参考图④(环境色卡):N 色色卡,沙漠+天空严格按色板不可偏离

【PROMPT 正文】
一张21:9宽银幕电影质感的静态照片,<主体A> 和 <主体B> 从 <环境:夜晚沙漠表面> 露出,
<头顶上方:被极光照亮的辽阔夜空>。
<埋没/约束的物理状态:埋到下颌→看不见脖子→被迫轻微后仰,写成因果链而非指令>。
参考图 严格决定本镜构图空间布局,两个白点精确标记两个头的位置,左白点=<A>的位置,
右白点=<B>的位置,最终画面里两个头必须分别占据与白点完全一致的位置,其余空间由空旷
沙地与夜空填满。
参考图 仅作为 <A> 的视觉锚定,<A 是机器人而非人类……不应被生成为人类>,出现在左白点位置,
机械视觉特征严格保留不做修改。
参考图 仅作为 <B> 的角色锚定,<B 身份 + 神态:眼神清澈警觉、冷静沉着、明确是活着有意识的状态,
长发被夜风从两侧吹拂>,出现在右白点位置。
参考图 作为环境色卡锚定,严格按22色色卡执行不可偏离色板,<主导色调 + 极光主光源 + 星辰
+ 沙地冷光调子 + 阴影保留色彩深度非死黑>。
电影摄影的史诗孤独感,Roger Deakins / Greig Fraser / Hoyte van Hoytema 综合视觉语言,
低饱和高对比电影暗场,21:9 anamorphic,35mm Kodak Vision3 500T + skip-bleach negative LUT,
模拟胶片颗粒,真实电影长片的单帧定格画质。
```

**校对清单**:两个头的 XY 对上白点了吗(有没有漂移/左右互换)?机器人头是不是机械头(没被画成人脸/半人脸;LED 面板/机械颈/眼点在不在)?人类头身份/神态对不对?埋到下颌 + 看不见脖子 + 轻微后仰成立吗?极光 + 22色冷青蓝影调统一吗,阴影是冷青深色还是死黑?宽银幕 anamorphic + Vision3 500T + skip-bleach 低饱和高对比暗场在不在?

---

## 图型 06 · 角色姿态/表情复刻帧(pose & expression replication frame)

**何时用**:已有一张参考图(角色定妆/某情绪定帧),要把它的表情、姿势、构图整套迁移到目标角色身上时,最轻量的一致性手法——一句中文枚举式"完全复刻参考图的 X / Y / Z"。核心教训:笼统说"复刻表情"基本无效,必须把表情拆成"逐特征点名"(具名情绪 + 五官特征清单)才锁得住。

**命门**:
1. **维度枚举清单,越细迁移越彻底**:基础句 `完全复刻参考图的表情，姿势，构图，比例，画面占比，人物造型和服装参考`——把要迁移的维度逐项列全。漏写的维度模型就自由发挥。
2. **"复刻表情"是空话 → 必须逐特征点名才生效(本图型最大命门)**:把抽象表情拆成具名情绪 + 五官特征清单。如 `完全复刻参考图的无奈流泪欲哭无泪的表情和厚嘴唇和明显的眼白和大黑眼珠子和画风` —— 逐项点名才把表情真正搬过来。
3. **轻量句,不挂胶片/反AI味签名**:本型是最小指令集迁移,风格随参考图走。这也意味着它本身不保证"干净设定图"。

**填空骨架**:
```
模式:图生图(角色/造型参考图 + [可选]第二张构图/表情参考图)
size 1:1 / 中文一句式
用途:轻量一致性迁移 / 情绪关键帧采样

【基础句 — 笼统版(只锁大致一致性,表情会丢细节)】
完全复刻参考图的表情，姿势，构图，比例，画面占比,人物造型和服装参考

【强化句 — 逐特征点名版(表情真要锁就用这条)】
完全复刻参考图的 <具名情绪,如:无奈流泪欲哭无泪> 的表情 和 <五官特征1,如厚嘴唇>
和 <五官特征2,如明显的眼白> 和 <五官特征3,如大黑眼珠子> 和画风,姿势,构图,比例,
画面占比,人物造型和服装参考

【双参考图分工变体(跨画风迁移)】
参考图1 = 固定角色造型/服装;参考图2(构图参考)= 迁移画风 + 姿势 + 构图
→ 维度清单按需增删调迁移松紧(留「画风」=连风格一起搬;删「画风」=只搬姿势表情)
```

**校对清单**:表情真的复刻了吗(笼统写多半只搬到大概情绪→改逐特征点名重跑)?五官特征清单逐项兑现没?姿势/构图/比例/占比/造型服装各维度都搬到了吗?身份是不是目标角色(最大坑:表情搬对了但人没搬对)?有没有连参考图的字幕/梗图/水印一起搬过来?

---

## 图型 07 · 从成图抠主体特写(场景内单人切特写)

**何时用**:已有一张多人/双人成图,想从同一场景里"切"出某个主体的中近景或极特写——景别推近、其余主体去掉、背景沿用同一场景但要真景深而非贴图。极轻量的中文一句话改图,靠底图承载场景 + 参考图锁脸。

**命门**:
1. **显式禁"直接挪用背景" + 要"正确景深变化"**:`场景依旧是<原场景>,但是要有正确的景深变化而不是直接挪用背景`——不写这句模型会偷懒把原背景原样贴上,特写就"贴脸"假。
2. **去元素:点名"画面里不要出现 X 的头"**:从双人切单人,必须明确把另一个主体删掉。
3. **景别越近,越要显式要求"光影与背景完美融合"**:推到极特写(头占 1/2)时加 `人脸的光影应当与背景完美融合`,防"贴脸感"。
4. **构图指令与身份锁定拆两路**:位置/占比用 prompt(`占四分之一、左边三分之一`),脸用参考图;切机器人则不需要锁脸参考图。
5. **迭代靠加参考图、不改 prompt**:要改光只追加一张"光影参考"图来修正照明,文本不动。

**填空骨架**:
```
模式:图生图(成图当底图承场景 + 参考图锁脸)
size 21:9 / quality 1K
中文一句话改图,从成图切单人特写

生成这个场景里的<左/右><主体>的<中近景特写/极特写>,
<主体>的头约占画面<四分之一/二分之一>,位于画面<左/右/中间略偏右><三分之一>的位置。
场景依旧是<原场景一句>,但是要有正确的景深变化而不是直接挪用背景<,人脸的光影应当与背景完美融合>。
画面里不要出现<另一主体>的头。<参考图作为五官的参考。>
（推到极特写再追加"光影应与背景融合";要改光只追加一张光影参考图、原句不动）
```

**校对清单**:背景是"真景深"而非直接贴原图吗(贴图会有抠像感/边缘违和)?另一主体去干净了吗?脸锁住了吗、没串?景别/占比对不对?方位落地了吗(中文占比/方位词响应是系统性弱项,偏差大就重刷)?极特写镜:人脸光影和背景融合了吗(有没有贴脸突兀感)?

---

## 图型 08 · 极限微距叙事帧(extreme macro + 巨物压迫)

**何时用**:用一个微观特写讲一句叙事/埋一个危机——蚂蚁爬睫毛、虫子停在五官上这种 extreme macro,既要昆虫纤毫毕现,又要在虚化的画面边缘藏一个"压迫源"(逼近的靴底)暗示危险。极浅景深的微观尺度,主体是昆虫而非人,人只露一小块(睫毛/眼睑)。

**命门**:
1. **把"巨物尺度压迫"做进微距**:让虚化的靴底 `filling roughly the upper 80 percent of the frame's upper region`——微观尺度里一只靴子就是压顶巨物,以微衬大制造危机感。
2. **三层焦点显式分级**:① 昆虫 = 最锐焦点(`sharply in focus, occupies the visual focal center`);② 睫毛 = 第二层焦点(`slightly soft but readable as individual strands`);③ 靴底/天空/皮肤 = 焦外(`heavily blurred / soft pale-warm bokeh`)。谁实谁虚必须钉死。
3. **双参考图分工 + 逐元素 hex 映射**:色板参考图锁色板(逐元素给 hex)+ 锁脸参考图(本帧只露睫毛/眼睑一小块)。
4. **明写主体的生物解剖真实**:`six legs distinctly visible / segmented body, head, thorax, abdomen, antennae all clearly visible` + 负向 `cartoon ant, stylized ant, oversized ant, fantasy creature`。
5. **"刻意微软"对抗过锐 AI 味**:`This image is a real macro photography still that may appear slightly soft and imperfect — this softness is intentional and desired`。

**填空骨架**:
```
模式:文生图 / 图生图(色板参考图 + 锁脸参考图)
size 16:9 / quality 1K-2K
单段英文,extreme macro 叙事帧,昆虫主体 + 压迫源

A photorealistic extreme macro photography film still captured during a real shoot, 16:9,
ultra close-up extreme macro view of <昆虫主体> crawling across <人体局部:睫毛/眼睑>,
camera <角度,如 to the side, angled slightly upward>,
with <压迫源,如 flat sole of a boot> looming heavily blurred filling roughly the upper 80% of the frame,
and <一小块透气元素,如 sliver of bleached sky in a corner>.
参考图 as master color palette anchor, all colors per this N-color palette. Explicit color mapping: <逐元素 hex>.
参考图 as visual identity anchor for <角色>, only a small portion of the face visible: <睫毛/眼睑>.
The subject is <昆虫> — anatomically realistic, six legs visible, segmented body/head/thorax/antennae sharply in focus.
Second layer of focus: <睫毛> slightly soft but readable. Everything else falls into soft bokeh.
Light: <directly overhead noon sunlight + 逐睫毛/逐腿的 micro-shadows>.
Cinematography: nature-documentary / art-house macro, Villeneuve & Fraser Dune tonality, skip-bleach LUT, film grain.
PHOTOGRAPHIC TONE: real macro still, slightly soft & imperfect (intentional), sharp focus ONLY on the insect.
Avoid: <反AI味通用串> + cartoon ant / stylized ant / oversized ant / multiple ants / facial distortion / eye open 等.
```

**校对清单**:主体(昆虫)是不是全图最锐、占视觉中心(头号失败模式:被压迫源/第二焦点淹没)?三层焦点分级对不对(昆虫最锐/睫毛微软可辨/其余 bokeh)?压迫源够不够大、压迫感出来没(占上方约 80%、重虚化)?昆虫解剖真实吗(六腿/分节体可辨,没画成卡通/超大/一群)?色板逐元素 hex 落地了吗?皮肤是真实毛孔还是塑料磨皮?眼睛是不是闭着?

---

## 图型 09 · 重打光 edit(只改光,不改内容)

**何时用**:已有一张成图,只想换光照/时间/调色,内容/构图/几何一个像素都不能动(把白天金光场景重打成清晨晨光这类需求)。走 `images.edit` 模式(不是 generate),正文是 CHANGE / PRESERVE / CONSTRAINTS 三段式。

**命门**:
1. **三段式职责切死,缺一不可**:CHANGE 只描述目标光的情绪并显式对比掉原光(`NOT the strong warm golden daylight of the original`);PRESERVE 逐项点名绝不能动的实体,精确到 `deep red tents stay deep red, only re-lit`;CONSTRAINTS 封死增删改挪(`Do not add or remove / redesign / reshape / move / change composition / add text`)。
2. **开头声明两张图的职责**:`Image 1: the base scene to relight — preserve all content, geometry and composition. Image 2: color palette reference — use ONLY as the target lighting mood and color grade`(色板图只借调性、不借内容)。
3. **挂 `images.edit` 专属参数 + 漂移自检**:调用 `images.edit`(不是 generate),quality medium / jpeg / Thinking Mode 开;跑完对比原图查建筑/帐篷/人有没有被悄悄改形或挪位。
4. **PRESERVE 可补 + 九宫格特例**:特别在意的元素往 PRESERVE 补;若底图是九宫格,PRESERVE 开头加 `preserve the multi-panel grid layout and the content of every panel` 防分格被重排。

**填空骨架**:
```
模式:images.edit(不是 generate!)
quality medium · jpeg · Thinking Mode 开
用途:只改光/时间/调色,内容几何构图一像素不动

[EDIT 模式 · 只改光线]
Image 1: the base scene to relight — preserve all of its content, geometry and composition.
Image 2: color palette reference — use ONLY as the target <目标光> mood and color grade.
--- CHANGE — Change ONLY the lighting, time of day, and overall color grade of Image 1.
<目标光描述:时间/太阳角度/长软影/雾感浮尘/目标色调> — NOT <原光,显式对比掉>.
--- PRESERVE (exactly, no change) — <逐项点名:构图/机位、每栋建筑岩窟、每顶帐篷含其底色(__ stay __, only re-lit)、每个人/物/道具的位置与形态、所有几何透视与细节纹理、整体布局>. Only the light may change.
--- CONSTRAINTS — Do not add or remove any object/person/structure/detail. Do not redesign/reshape/move anything. Do not change composition/framing/crop/layout. Do not add text/label/watermark. Change nothing except lighting, shadow, time-of-day, and color grade.
--- 【参数】images.edit · quality medium · jpeg · Thinking Mode 开
【提醒】PRESERVE 是核心,绝不能动的元素往里补;九宫格底图加 "preserve the multi-panel grid layout and the content of every panel";跑完对比原图查有没有被悄悄改形/挪位。
```

**校对清单**:内容有没有被悄悄改(逐项对比原图:建筑/帐篷/人/道具的位置与形态)?构图/机位/裁切一像素没动?目标光对不对(晨光低角度侧光/长软影/雾感浮尘/skip-bleach 暖灰)?原光被替换掉了吗(CHANGE 里的 NOT 对比生效没)?PRESERVE 里点名的底色守住了吗?有没有多/少东西、有没有乱加文字?用的是 `images.edit` 而不是 generate 吗?

---

## 图型 10 · 九宫格场景多机位分镜(3×3 contact sheet)

**何时用**:要把同一空间/同一时刻用九个不同机位一次性铺成一张 3×3 故事板(contact sheet / storyboard sheet)时——典型是"一场大事件(巨物降临/部落被毁)发生的那一瞬,要剧组从九个角度同时看清"。它是多机位分镜板,不是多视图设定图。两种产线:重型(逐格写死镜别 + 巨物铁律 + 全局锁,4K 一次成片级)与轻量(一句"生成九宫格多视图、不同角度"靠底图驱动)。

**命门**:
1. **全局锁跨格一致——九格必须读成"一个时刻"**:把光向/风向/色板/胶片/大气抽出来一次性声明,并显式 `Keep all nine panels visually consistent (same light, same dust, same color palette) — they are one moment from nine angles`。
2. **巨物尺度铁律(有巨物时)**:`the <巨物> is SO unimaginably gigantic that NO panel ever shows the whole <巨物>` + 每格只露 `a fragment` + `dwarfing the entire village to the scale of dust`。巨物永不全见,九格各换一种露法。
3. **逐格写镜别 + 内容**:Panel 1…Panel 9 逐格点名(top-left/top-center…bottom-right)+ 该格机位 + 巨物在该格怎么露。读序固定 left-to-right, top-to-bottom。
4. **双参考图分工 + 约束块兜底**:Image1 锁场景(建筑/帐篷色/色板/光/调性),Image2 锁巨物(材质/形体);末尾 CONSTRAINTS 复述铁律 + PHOTOGRAPHIC TONE 反 AI 味。

**填空骨架**:
```
模式:图生图(场景参考图 Image1 + 巨物/事件参考图 Image2 → 3x3 九宫格分镜)
size 16:9(1536×1024 或更大以容九格细节) / quality medium / jpeg / Thinking Mode 开
用途:多机位分镜板(同一时刻九机位 contact sheet),不是 turnaround 多视图

【参考图标注】
- Image1:<场景原图——锁建筑/色板/光/调性>
- Image2:<巨物/事件主体——只锁材质与形体>

【PROMPT 正文】
Generate a single 3x3 nine-panel grid image (nine separate cinematic frames arranged in a 3-row,
3-column grid, each panel divided by thin black borders, like a film contact sheet / storyboard sheet).
All nine panels depict the SAME <场景> (from Image 1) at the SAME moment — <这一瞬发生了什么>.
<全局气氛一句:光向/尘霾/调性签名>. In EVERY panel <巨物/主体> dominates — but it is SO
unimaginably gigantic that NO panel ever shows the whole <它>. In each panel only a fragment is
visible, always filling or towering over the frame, dwarfing <环境> to the scale of dust.
The nine panels show nine different views:
Panel 1 (top-left): <机位 + 内容 + 巨物怎么露>. Panel 2 (top-center): … … Panel 9 (bottom-right): <航拍俯顶>.
【PRESERVE】Preserve from Image1: <建筑/帐篷色/色板/光/调性>. Preserve from Image2: <材质/形体>.
Preserve overall: 9-panel 3x3 grid layout with thin black dividing borders; consistent <光+尘+色板>
across all nine panels so they read as the same moment.
【CONSTRAINTS】- 巨物永不全见,只露片段,永远压环境如尘. - 每格都要极端尺度对比. - 九格同光同尘同色板=同一时刻九角度. - 无文字/水印/logo. - 半毁非夷平,<环境>仍可辨.
【PHOTOGRAPHIC TONE】each panel is a film still that may appear slightly soft… Avoid: <反AI味清单> + fully-visible whole <巨物>, cartoon or CGI look, clean undamaged <环境>.
```

**校对清单**:是不是真 3×3 九格(细黑边/编号/读序对不对)?九格读成"一个时刻"了吗(光/尘/色板跨格一致)?巨物每格都只露片段、永不全见吗?极端尺度对比够不够(村落/人压成尘埃如蚂蚁)?逐格机位和 Panel 1–9 清单对得上吗?双参考图分工到位、半毁非夷平、环境仍可辨?

---

## 图型 11 · 九宫格武戏分镜(首尾镜像闭环)

**何时用**:要把一整段动作戏/群战用九格黑白(或彩色)分镜一次性讲完、并形成叙事闭环时——01 格开场、09 格收势,首尾同机位同姿势镜像呼应(敌从逼近→倒地,光从晨→暮),中间七格逐格推进。它是图型 10 的"动作戏 + 时间推进"变体:10 锁"同一时刻九角度",11 锁"一段时间九拍 + 首尾镜像"。

**命门**:
1. **全局锁(主角 + 敌数 + 光向 + 风向 + 胶片机型)做跨格一致**:主角必须同一人、敌人数量固定、光向/风向/胶片签名一次性声明贯穿九格——这是动作戏九宫格不串脸、不变天的根。
2. **首尾镜像闭环(01 ↔ 09)**:`Panel 09 must mirror the framing of Panel 01` 同机位同景别同姿势,只改"敌从逼近变倒地 + 光从晨光到暮色"。
3. **逐材质灰阶映射指令**:黑白片里仍给每种材质指定灰阶层级(红→中深灰、黑保深、白保亮),防层次糊成一团。
4. **逐格镜别 + 暴力降级合规**:Panel 01–09 逐格写景别/动作;武戏叠 `sword meeting sword NOT body / knocked back not injured / no blood`。

**填空骨架**:
```
模式:图生图(主角参考 + 武器参考 + 灰阶色卡参考 → 3x3 九宫格黑白武戏分镜)
size 16:9 / quality 2K / 用途:一张 prompt 出整段群战 storyboard,首尾镜像闭环

【参考图标注】
- 主角参考:<锁服装/造型/身份>
- 武器参考:<锁兵器形体>
- 灰阶色卡:<彩色色板,供黑白灰阶层级映射>

【PROMPT 正文 — 全局锁先行】
A 3x3 grid of 9 cinematic black-and-white film stills, total canvas 16:9. Each panel is itself a 16:9
frame, separated by clean thin black borders, panel numbers "01"–"09" in top-left corner, read order
left-to-right top-to-bottom. CRITICAL: these are PHOTOREALISTIC CINEMATIC STILL PHOTOGRAPHS
in pure B&W grayscale (NOT line art, NOT manga panels, NOT sketches). MAIN CHARACTER (identical
across all 9 panels): <主角锁>. OPPONENTS (consistent across panels): <N 名敌人锁>. Consistent
across all panels: <光向 + 风向 + 胶片机型(Kodak Double-X 5222 等)+ anamorphic>.
逐材质灰阶映射:<红→中深灰 / 黑保深 / 白保亮…>.
Panel 01: <开场机位 + 动作 + 敌逼近 + 晨光>. Panel 02 … Panel 08: <逐拍推进>.
Panel 09: MUST mirror the framing of Panel 01 — same camera, same pose — but <敌已倒地 + 暮色长影>.
合规:opponents knocked back by force not injured, sword meeting sword NOT body, no wounds no blood.
【反AI味结尾 + Avoid】
```

**校对清单**:是不是真 3×3、九格都有编号 01–09、读序对?主角九格是同一人吗、有没有串脸/换装?敌人数量各格一致吗?光向/风向/胶片质感跨九格一致吗?01 与 09 首尾镜像成立吗(同机位同姿势、敌逼近→倒地、光晨→暮)?黑白灰阶层级清楚吗?是 PHOTOREAL 灰阶照片不是 line art/manga 吗?暴力降级守住没?

---

## 图型 12 · 状态批量九宫格(完好→被毁)

**何时用**:已有一张"完好状态"的场景/部落/建筑图,要批量生成它变化后的多个视角(被摧毁/灾后/老化/雪覆)、做灾后镜头或状态对照素材时。它锁"同一对象 + 一个状态变化 + 多视图九宫格"三要素合一,靠参考图提供原始形态,再对它整体施加破坏/变化。极简一句话即可驱动,也可升级成图型 10 的重型逐格分镜。

**命门**:
1. **三要素一句话合一**:`参考图(完好对象)` + `状态变化(被摧毁)` + `多视图九宫格格式`——让模型从参考图读原始形态、再统一施加破坏。少任何一个就翻。
2. **靠底图承结构、prompt 只管"变状态"**:结构信息全在参考图里,prompt 不重写场景细节,只下"被摧毁 + 九宫格多视图"。
3. **状态一致性是弱项,需显式拉齐**:多格"被摧毁程度"易不一致,补一句统一破坏等级(如"半毁可辨,非夷平")。
4. **"多视图"≠ 严格定点环绕**:一句话版更像"同一灾后场景的多张景观拼贴";要严格环绕得升级到重型逐格写机位(图型 10)。

**填空骨架**:
```
模式:图生图(完好对象参考图[+ 破坏源参考图] → 状态变化九宫格)
size 16:9 / quality 1K-4K(要逐格细节可读则升 4K)
用途:状态批量(同一对象变化后多视角),做灾后/老化/对照素材

【参考图标注】
- 参考图1:<完好状态的对象——锁原始形态/身份>
- 参考图2(可选):<破坏源,如巨物/灾害——锁施加破坏的来源形态>

【PROMPT 正文 — 轻量版(一句话)】
参考重新生成一个新的九宫格场景图,展现被<参考图/破坏源>摧毁的<对象>景象的多视图九宫格。
(英文等价:Regenerate a new 3x3 nine-panel scene grid showing the <对象> after being destroyed by
<破坏源 from reference>, as a multi-view nine-panel grid — preserve the <对象> identity from reference,
apply consistent half-ruined-but-recognizable destruction across all nine views.)

【若要拉齐状态/升级成片】补:统一破坏等级(half-ruined not flattened, still recognizable)+
跨格同光同尘 + 升 4K 让每格细节可读 → 此时即转入图型 10 的重型逐格骨架。
```

**校对清单**:原对象身份保住了吗(灾后还认得出是同一个吗)?状态变化施加到位吗(真毁了还是只轻微改动)?是不是九宫格/多视图,还是退化成几张拼贴?九格破坏程度一致吗(易翻:有的夷平、有的几乎完好)?细节够清吗(1K 易糊,要逐格读细节升 4K)?

---

## 图型 13 · 民族志服装陈列板(3×3 documentary plate)

**何时用**:要为一个族群/部落一次性出多套服装变体 + 对应头饰 + 地面道具的无人体陈列参考板时——给剧组当服装参考表、世界观设定物料。范式是"博物馆纺织修复板":服装挂杆垂直悬挂排成 3×3,每套上方头位摆对应头饰,画布地面 flat-lay 散布道具。数量是这套 prompt 的稳定弱项,务必把"九套/3×3"当头号校对项。

**命门**:
1. **平光 + overhead-and-frontal + 无人体**:`flat-lit overhead-and-frontal documentary-style reference plate` + `without any human figures present` + `soft diffuse overhead studio lighting with no directional shadows`——纯物件存档式平铺,反棚拍戏剧光。
2. **三层同框结构**:① 服装挂杆垂直悬挂排 3×3;② 每套头位摆一件对应头饰(小木架上,九件各异);③ 画布地面 flat-lay 散布道具(布样/颜料碗/绳/弯刀/骨珠)。
3. **共享部落语言 + 逐套差异化 + 朱砂红串联**:九套统一部落语言(burgundy/dust-cream/sandstone-ochre/smoke-umber 色域),但逐套在主色比/层叠/材质/系法/金属配件上各异;`A single cinnabar red accent appears somewhere on each outfit`(#A82A2A)做唯一高饱和焦点色,九套各放一处。
4. **九件头饰逐件点名**:逐件描述形态,`tribal/ritualistic/archaic/hand-beaten, never resembling helmets or polished jewelry` 防跑成头盔/精致首饰。
5. **数量是稳定弱项**:`nine outfits` 和 `three rows of three` 要重复强调,出图后第一件事数数量;横幅 16:9 诱导横排,要严格九宫格考虑改方形(1:1)或显式锁 3×3 网格 + 细分隔线。

**填空骨架**:
```
模式:文生图(或轻图生图,参考图只给色板/部落语言)
size 16:9(⚠ 横幅利于平铺道具,但不利严格 3×3) / quality 1K+
用途:出服装参考表/设定物料(无人体陈列板)

【PROMPT 正文】
A flat-lit overhead-and-frontal documentary-style reference plate showing NINE complete outfit sets of
<族群>, displayed WITHOUT any human figures present. Each outfit suspended on a weathered wooden
pole / rough hemp cord, hanging vertically as if pinned for ethnographic study, arranged in THREE ROWS
OF THREE (3×3) against a neutral warm-grey canvas backdrop. Each outfit displays the full ensemble top
to bottom: <逐部位:斜挂布 / 半裙开衩 / 系带 / 不对称肩布 / 开衩裤 / 缠足布或皮靴 at base>.
The nine outfits share a unified tribal language but each varies: <主色比 / 层叠 / 材质 / 系法 / 金属件数量>.
A single <朱砂红 #A82A2A> accent appears somewhere on each outfit — small but visually loud across all nine.
Above each outfit, in the head position, rests one hand-forged metal headpiece on a small wooden stand —
NINE distinctly different headpieces: <逐件点名 9 种形态>. All headpieces tribal/ritualistic/archaic,
hand-beaten, never helmets or polished jewelry.
Scattered across the canvas floor: <flat-lay 道具:布样 / 颜料碗 / 绳 / 弯刀 / 骨珠 / 铜片…>,
every prop photographed flat-on, pure object documentation.
Composition: clean ethnographic study layout, neutral warm-grey canvas filling frame, soft diffuse overhead
lighting no directional shadows, no human presence, no environment. References a museum textile
conservation plate / film wardrobe reference sheet. Real photographic quality, 35mm medium format film
stock, soft documentary lighting, analog photochemical grain, shot as a flat archival reference photograph.
```

**校对清单**:数到底有没有九套(头号风险)?是不是真 3×3 三行三列,还是横排/单行/松散堆陈?无人体吗(有没有冒出人/假人模特)?平光无方向阴影吗?每套都有一处朱砂红 accent 吗、九套统一部落语言但逐套有别?九件头饰逐件不同且 tribal/hand-beaten(没跑成头盔/精致首饰)?地面 flat-lay 道具齐不齐?

---

## 图型 14 · 角色四视图定妆(2×2 turnaround / character sheet)

**何时用**:要给一个角色锁死"正脸/侧脸/全身正/全身背"四套权威视角,供后续分镜复刻一致性 + 后期换脸时用。它是 turnaround character sheet——身份特征、视角分工、四格版式正确优先于单格美感。两种规格:重型英文版(主役/精英)与轻型中文版(次要角色/网格扩展)。同系列多角色靠格式继承 + 差异化对照表保证"同部落不撞脸"。

**命门**:
1. **四格版式逐格点名指派,且每格显式锁宽高比**:逐格写清内容(`左上正脸特写/右上侧脸特写/左下脖子以下全身无脸/右下背面含后脑勺`)+ 整体画幅(9:16 竖版/不等大上小下大,或 `2x2 每格 16:9`)。轻型版翻车点正是没锁每格比例→被压成正方格、没锁尺寸权重→"上小下大"读不出。
2. **左下"全身无脸"格刻意把脸裁出框 = 换脸存活位**:`BODY FRONT (NO FACE) ... face/head intentionally cropped out at the top of this panel ... zero face involvement so this panel survives any future face replacement edit`。
3. **族群/身份锚定 + 海量 NOT 反向锁**(重型版):AI 默认欧美/韩剧脸 → 用一长段 `ETHNICITY — CRITICAL: <族群>` + `NOT pure Caucasian / NOT K-pop / NOT anime face` 把脸压回设定。
4. **格式继承 + 差异化对照表**(同系列多角色):后续角色用一句中文 `【格式继承】完全同<已有角色>格式` 挂载整套模板;收尾附一张多维差异化总览表(性别/年龄/体型/发/胡/服装/双签名装备/主副武器/战利品/气质),把"群像不撞脸"变成可对账的 check 表。

**填空骨架**:
```
模式:文生图 / 图生图(角色 ref → 四视图定妆表)
—— 重型英文版(主役/精英):size 9:16 竖版 / quality 最高
—— 轻型中文版(次要角色/网格扩展):一句话挂模板,显式锁每格比例

【house 格式(所有角色定妆都用)】
size 9:16 竖版 / 4K · 写实摄影棚定妆照背景 · 单侧暖光侧逆光
版式:2x2 上小下大 —— 上排两格(~1/3高)=脸特写;下排两格(~2/3高)=脖子以下全身;细灰分割线,四格同背景同暖光侧逆光。
四格:
- 左上 正脸特写:锁骨往上,正对镜头,脸全露。
- 右上 侧脸 profile:纯侧脸朝 camera-right,暖逆光勾发丝与下颌/鼻线。
- 左下 正面脖子以下(无脸无头):锁骨到脚跟全身,正面;头从格顶裁出(零脸参与=供换脸),正面服装全见。
- 右下 背面脖子以下(无脸无头):背面全身,颈到脚跟,头从格顶裁出;发垂背,披风/腰带/腿挂等背侧装备可见。

【重型版 PROMPT 骨架】
A character design reference sheet. **Vertical 9:16 aspect ratio. Maximum resolution output.**
Pure solid neutral light-warm-grey studio backdrop. Single-sided side-rim backlighting from
camera-right at 45° behind subject, no fill / no front light.
【Layout】2x2 grid with UNEQUAL panel heights: top row two SMALLER panels (~1/3 height) = face
close-ups; bottom row two LARGER panels (~2/3 height) = full body.
【4 Panels】
- Top-left FRONT FACE CLOSE-UP:<正脸·眼睛完整·头巾拉到脖子露脸>
- Top-right SIDE FACE (PROFILE):<纯侧脸·背光勾后脑·发型特征>
- Bottom-left BODY FRONT (NO FACE):<脖子以下全身·脸裁出框·签名装备1正面可见>(换脸存活位)
- Bottom-right BACK VIEW (含后脑勺):<背面全身·签名装备2背挂可见>
【Subject】<年龄+体型一句> ETHNICITY — CRITICAL:<族群锚定>. <发/胡/战痕/服装/签名装备×2/战利品等级>
【Pose 同四格】<默认站姿,关系驱动:working laborer/alert pilot/calm veteran,NOT action NOT seductive>
【Critical consistency】SAME individual in all 4 panels — identical face/hair/clothing/signature gear.
【Panel Labels】FRONT FACE / SIDE FACE / BODY FRONT (NO FACE) / BACK + Title
【Constraints】NOT 1:1(must 9:16)/ NOT equal panels(top smaller)/ NOT face in bottom-left /
            <族群 NOT 清单>/ <装备与同系列其他角色的差异化 NOT 清单>

【轻型版 PROMPT 骨架(已有单图→扩四视图)】
出2x2四视图。每个格子比例都是<16:9 / …>。   ← 关键:必须显式锁每格宽高比
（或)2x2四宫格,上小下大,左上正脸特写/右上侧脸特写/左下脖子以下全身不含头/右下背面全身,
    背景写实摄影棚定妆照,单侧侧逆光。

【同系列多角色追加】
- 一句中文挂模板:【格式继承】完全同<已有角色>格式:9:16竖版+4格不等大+正脸/侧脸/脖子以下/背面+single-side rim
- 收尾差异化对照表:|维度|角色A|角色B|角色C| 性别/年龄/体型/发/胡/服装/签名装备×2/主副武器/战利品/气质
```

**校对清单**:四格内容对不对(正脸/侧脸/全身无脸/背面含后脑勺)?每格比例/整体画幅锁住了吗(易被压成正方格;"上小下大"尺寸差读不出)?左下"全身无脸"格脸是否真的裁出框?族群/身份对不对、有没有跑欧美/韩剧/anime 脸?签名装备 ×2 都可见、和同系列其他角色差异化了吗?单侧侧逆光 + 纯灰底 + 四格标签 + 标题到位?(上游:真人脸角色先出半身锁脸图当 ref 再转四宫格)

---

## 图型 15 · 生物 creature sheet(多视图设定表)

**何时用**:要把一只虚构生物交付给建模/VFX 团队,需要在一张图里同时给出多个正交视图 + 比例参照 + 配色规格时。它是工业级 creature concept design sheet / turnaround——一页式交付物,信息完整、可读优先于美感。建议先有一张怪物的"正常全图"(图生图锚定 vibe 出的单张全身),再把它当 Image 1 喂进来转四宫格(转不转先问用户),别跳过正常全图直接从零出 sheet。

**命门**:
1. **版面分区写成"坐标 + 内容 + caption"三件套**:逐格点名位置(LEFT HALF / TOP RIGHT / MIDDLE RIGHT / BOTTOM STRIP / BOTTOM RIGHT CORNER)+ 该格画什么 + 格下 caption 文字(`Label text reads "TOP VIEW"`)。
2. **比例尺做两层**:主图旁放 1.8m 黑色火柴人剪影(约 1/20 生物高,`HUMAN 1.8M`),底部再来一条五物种横向比例条(人 1.8m / 象 3m / 巴士 12m / 蓝鲸 30m / 生物 35m 黑剪影并排)。
3. **hex 色板条钉死配色**:角落一条 5 色 swatch,每块标 hex(`pale sand-yellow #C9A876…`)。
4. **PRESERVE / specifications 跨所有格统一**:`Creature design specifications (applies to all views)` 一段把标志特征逐项锁死,再强约束 `Consistent lighting direction across all four views` + `Orthographic projection — no perspective foreshortening` + `float on clean background`(净底浮空、删环境)。
5. **预出特殊姿态格**:六视图里可专设 `TOPPLED — BELLY OUT` / `TOPPLED — HEAD CLOSE` 两格,为后续被击倒镜头预备标准设定图。

**填空骨架**:
```
模式:Edit / 图生图(基于生物参考图 Image1 出多视图设定表)
size 16:9 / quality medium / jpeg / Thinking Mode 开
用途:creature concept design sheet,信息完整可读优先,净底浮空、正交无透视

【参考图标注】
Image 1:<底层物种参考图> —— 锁物种解剖基准,所有格保持同一只

【PROMPT 正文】
This image / a professional creature concept design sheet that may appear slightly soft like a
real studio-photographed model sheet — this softness is intentional. <净底:clean neutral
light-grey background, soft even studio lighting, orthographic concept-art lighting to reveal form>.
Subject: <生物一句:体量 + 体型 + 标志特征>.

Layout structure of the sheet（逐格写"坐标 + 内容 + caption"）:
- LEFT HALF (large): <主侧视图,facing frame-left> + 旁置 1.8m 黑色火柴人剪影做比例(约 1/20),
  caption "HUMAN 1.8M" / "BODY LENGTH 35M"
- TOP RIGHT (medium): <俯视图,显式说看到几节甲/几条肢> caption "TOP VIEW"
- MIDDLE RIGHT (medium): <头部特写,锁标志结构> caption "HEAD DETAIL — …"
- BOTTOM STRIP (full width): 五物种黑剪影比例条 人1.8m/象3m/巴士12m/蓝鲸30m/生物XXm,各带名+尺寸
- BOTTOM RIGHT CORNER: 5 色 hex 色板条 <#xxxxxx 各带英文色名>
（六视图变体:3×2 网格 SIDE/FRONT/TOP/3-4/+ 两格特殊姿态 TOPPLED-BELLY/TOPPLED-HEAD-CLOSE）

Creature design specifications (applies to ALL views): <逐项锁:甲壳质感/无眼铲头/N对肢/共生附着物/腹面>.
Preserve from Image 1 across ALL panels: <物种解剖逐项> — same color palette, same material, same proportions.
Constraints: keep all panels the SAME creature, consistent design and scale; clean light-grey background
(#E8E6E2), thin neutral grey divider lines; sans-serif labels dark grey (#2A2A2A), small but legible & sharp;
35mm film grain, neutral grading; consistent lighting across all views; orthographic — no perspective
foreshortening; no environment (no sand/sky/dust), all views float on clean background; no extra creatures,
no humans other than the scale silhouettes, no vegetation, no riders/equipment.
PHOTOGRAPHIC TONE: real studio-photographed design maquette, slightly soft, not tack-sharp, photographically
captured not 3D-rendered/AI-stylized, colors restrained not oversaturated.
Avoid: oversharpening, artificial sharpness, heavy digital grain, HDR, AI-generated aesthetic, overpolished
studio look, plastic smoothing, oversaturation, glossy highlight blowout, generic AI image quality, default
model aesthetic bias.
```

**校对清单**:各视图是不是同一只生物(物种解剖/配色/比例每格一致)?正交无透视了吗(易跑成带透视的 3/4)?人形比例尺出来没(约 1/20、带 HUMAN 1.8M caption)?底部五物种比例条 + 角落 hex 色板条清晰落实了吗(易弱实现/糊掉)?caption 标签可读吗(1K 常糊,要可读得上 2K)?净底浮空、删光环境了吗?(六视图)TOPPLED 两格姿态对不对?

---

## 图型 16 · 生物侧身正交全景

**何时用**:给一只巨型生物出纯侧视、工程级正视图供建模——单视图,但要求绝对正交、无透视压缩、主体居中占满、信息全可读。区别于多视图一页式(图型 15):这是单视图正交全景,把生物完整轮廓 + 全部肢体 + 头部结构平铺在一张图里当建模底图。

**命门**:
1. **机位写成几何约束**:不写"侧视",而写 `Camera positioned at low eye-level approximately 80 meters from the creature, perfectly perpendicular to the creature's body axis — pure side view, no perspective foreshortening`。"80m 外 + 垂直身体轴线"这组几何描述是消除透视收缩、换来近正交纯侧视的命门句,删掉就跑回带透视的近平视。
2. **精确数值规格当骨架**:`35 meters long / 8 meters tall / nine heavily armored dorsal segments / eighteen limbs total`——用量化规格钉死体量结构,引导走"技术参考"而非"美术插画"。
3. **构图锁死**:`fills approximately 85% of the frame width and is centered horizontally and vertically`——占 85% 宽、水平垂直居中,保证全身可读不被裁。
4. **Use Case 明示技术用途**:写明"strict orthographic side profile reference,供 PD 与 VFX 建模",把模型从棚拍 turnaround 拉向工程正视参考。
5. **去元素 + 全清晰**:净背景、无遮挡(no text/logos/figures/vegetation/dust/motion)、全身锐焦(sharp focus across the entire body)。
6. **比例口径要统一**:生成前把元信息与正文的 aspect ratio 统一,别让两处打架导致出图偏宽。

**填空骨架**:
```
模式:文生图(单视图正交侧身全景设定图)
size 16:9 / quality / Thinking Mode 开
用途:strict orthographic side profile reference,供 PD/VFX 建模,信息全可读优先

【PROMPT 正文】
<标题 · 设定图 vN>
Scene: <环境一句:vast arid desert / overcast diffused daylight,concept-art 光揭示形体,minimal harsh shadows>.
Subject: A colossal <生物类比> standing fully exposed, photographed in STRICT SIDE PROFILE.
约 <长> meters long and <高> meters tall. Body consists of <N 节装甲段 forming continuous arched spine>.
The head end faces frame-left; the rear faces frame-right. Stationary, all limbs visible and planted.
Important Details: <逐项锁:每节一对肢=共 N 肢 / 铲状口器无眼 / 甲壳石质风化 / 寄生附着物在第几节 / 关节膜组织 / 腹面>.
Use Case: Creature concept design sheet for a sci-fi film. Strict orthographic side profile reference for the
production design team and VFX vendor to model accurately. Must show the complete silhouette, all limbs,
head structure, body proportions clearly.
Constraints: Wide horizontal composition. Camera at low eye-level approximately 80 meters from the creature,
perfectly perpendicular to the creature's body axis — pure side view, no perspective foreshortening. The
creature fills approximately 85% of the frame width, centered horizontally and vertically. Photorealistic,
35mm film grain, neutral color grading. Clean uncluttered background, only flat sand and distant horizon.
No text, no logos, no human figures, no other creatures, no vegetation. No dust, no motion, no atmospheric
effects obscuring the subject. Sharp focus across the entire creature body. No artistic stylization — strict
photoreal creature design reference quality.
```

**校对清单**:纯侧视近正交、机位几何约束生效无透视收缩;主体占 85% 宽水平垂直居中全身可读;全部肢体可见无遮漏;头部结构清晰;背景干净无文字/人形/植被/尘雾;全身锐焦无大景深虚化;元信息与正文 aspect ratio 一致。

---

## 图型 17 · 纪实实景陈列(反棚拍)

**何时用**:给一只生物出设定页,但刻意不要棚拍 turnaround 那种"干净灰底悬浮"的工业感,而要一组像探险队/剧组在真实外景实拍的纪实照片摊在一页上。专治"AI 默认把生物设定图跑成 3D 渲染/CG 模型/概念美术"的审美偏置,用"反棚拍"框架强行拉回真实外景照片质感。

**命门**:
1. **"反 turnaround"框架开宗明义 + 禁项写满**:开头声明 `documentary-style, on-location PHOTOGRAPHS … as if a film crew or expedition photographed this`,紧接 `Every panel is a REAL PHOTOGRAPH … NOT a 3D render, NOT a studio turnaround, NOT a CG model display, NOT concept art, NOT an illustration`。正向定义 + 负向排除成对出现是反棚拍第一关,少一组就回棚拍。
2. **实景光逐条对冲棚拍光**:`real desert canyon in soft early-morning light, natural directional sunlight, real cast shadows, real bounced environmental light and faint atmospheric dust haze — NOT flat studio lighting, NOT uniform global illumination, NOT a neutral seamless backdrop`。每个棚拍光特征都配一个实景反义。
3. **跨照片一致性**:`The same creature stays perfectly consistent across every photograph`。
4. **"必须读作 X 不是 Y"对比锁定句**:专治模型对某体型的物种/材质偏置(蛇形巨物天然往虫/沙虫跑)。如 `Its overall read must be unmistakably DRAGON, not worm` + `NOT a smooth limp worm tube`;材质同理 `a real living skin surface, NOT exposed muscle, NOT a flayed body, NOT carved stone`。物种偏置压不住是头号坑,要加强显性物种特征的视觉权重 + Avoid 前置错误物种 silhouette + 多刷挑帧。
5. **多照片版面 = 一张主环境照 + 多张局部特写**:`MAIN (large)` 宽环境照(用环境宽度做尺度)+ `JAW & FACE / EYE-SOCKET / SKIN MACRO` 局部实拍,每张配 caption。
6. **PHOTOGRAPHIC TONE 强调"真相机真镜头 + 不完美"**:`shot on a real camera with a real lens … slightly soft and imperfect like a real photo`,把"不完美"当目标对抗 AI 过锐,别被它吓到去加锐化。

**填空骨架**:
```
模式:文生图(纪实实景多照片设定页 · 反棚拍)
size 16:9 / quality / 2K(细节多,建议上 2K)
用途:on-location documentary photographs 摊一页,反 turnaround/反棚拍,要真实外景照质感

【PROMPT 正文】
Create a sheet of documentary-style, on-location PHOTOGRAPHS of a real <生物名> — as if a film crew or
expedition photographed this enormous real creature out in a real <实景环境> and laid several photographs
on one sheet. Every panel is a REAL PHOTOGRAPH shot on location with natural light — NOT a 3D render,
NOT a studio turnaround, NOT a CG model display, NOT concept art, NOT an illustration. Photographed in a
real <环境> in the soft light of <时段>, with natural directional sunlight, real cast shadows, real bounced
environmental light and faint atmospheric dust haze — NOT flat studio lighting, NOT uniform global
illumination, NOT a neutral seamless backdrop. The same creature stays perfectly consistent across every photograph.
CREATURE — <生物详述;若易读错物种/材质,加"必须读作 X 不是 Y"对比锁定句>.
SKIN/材质 — <活体质感细节 + subsurface scattering,逐条 NOT 排除剥皮/石雕/CG-plastic>.
PHOTOGRAPHS ON THE SHEET:
1. MAIN (large) — wide environmental photograph,<全身在实景,用 canyon walls/环境宽度做尺度>.
2. <局部特写A — 同自然光下怼近拍某结构>.
3. <局部特写B>.
4. <MACRO 材质微距>.
LABELS — short clean English labels under each photograph.
PHOTOGRAPHIC TONE: every image is a real on-location photograph shot on a real camera with a real lens,
natural daylight, real cast shadows and environmental bounce light, natural film grain, realistic lens depth of
field, slightly soft and imperfect like a real photo. <主体读作活体真实材质,逐条 NOT CG/雕塑/剥皮>.
Avoid: 3D render, CG model, ZBrush/Blender/octane render, studio lighting, flat lighting, uniform global
illumination, neutral seamless backdrop, product-shot lighting, turnaround sheet, VFX reference board,
video-game render, unreal-engine look, clean 3D render, illustration, drawing, painting, concept-art, cartoon,
anime, cel-shaded, sketch, <错误物种 silhouette / 错误材质>, oversharpening, HDR effect, plastic smoothing,
oversaturation, default model aesthetic bias.
```

**校对清单**:整体像真外景实拍照(没跑成 CG/turnaround/概念美术/插画);实景光到位(方向光 + 真实投影 + 环境反弹 + 尘霾,非平棚光/无缝灰底);多张里是同一只生物;物种读对(易翻:蛇形被读成虫/沙虫);材质对(活体 + subsurface scattering,没滑向剥皮/石雕/CG-plastic);主环境照用环境宽度做尺度;每张配 caption。

---

## 图型 18 · 载具设计图(vehicle design sheet · 2×2 四视图)

**何时用**:给一件载具出工业级正交设计 sheet(SIDE / FRONT / TOP / 3-4 四视图),供美术/建模/道具组当蓝图。结构、尺度、机制正确优先于美感。独门武器是"失败模式→补救句"迭代纠偏 SOP:把最高风险点(单人载具尺度,极易跑成多人战舰)前置标注,出图后照清单逐项核验追加。

**命门**:
1. **2×2 均等四格 + 每格点名视角与朝向**:`Top-left SIDE(primary broadside) / Top-right FRONT / Bottom-left TOP-DOWN / Bottom-right 3/4 PERSPECTIVE(hero shot)`,每格写清主体朝向与取景。
2. **尺度是最大风险,用绝对数值 + 跨物种类比 + 海量 NOT 三重压**:`approximately 2.5 meters long … land-windsurfer board crossed with a small dugout canoe crossed with a sand sled … NOT a Viking longship, NOT a Mad Max truck, single-pilot scale only`。
3. **结构借真实参考物,材质/世界观 DNA 自定义**:功能逻辑借现代陆地帆板/独木舟/沙橇,但材质统一锁到部族青铜 patina `#7A6845 / #846035` + 三角 lateen 帆 + 船首小图腾。
4. **功能优先级要显式写死**:凡"A 是主、B 是辅"的机制(runner vs wheel、帆 vs 驱动器),模型默认会平权甚至反置 → 必须 `PRIMARY motion via single central runner/skid, wheels are only auxiliary stabilizers`。
5. **附"失败模式→补救句"映射表**:主 prompt 后挂一张表,每种典型跑偏各配一句可直接追加的强约束语——把"靠运气"变"靠 SOP"。

**填空骨架**:
```
模式:文生图(载具设计 sheet)
size 16:9 横版 / 最高分辨率

A vehicle design reference sheet. **Horizontal 16:9. Maximum resolution output.**
Pure solid neutral light-warm-grey studio backdrop. Single-sided side-rim backlight camera-right 45°
behind subject, no fill / no front light. Same studio environment as the <同系列角色 sheet>.
【Layout】2x2 equal grid: Top-left SIDE(primary broadside) / Top-right FRONT / Bottom-left TOP-DOWN /
Bottom-right 3/4 PERSPECTIVE(hero shot). Thin grey dividing lines, vehicle centered each panel.
【Subject — same vehicle across all 4 panels】<载具一句定位 + 战术逻辑>.
**Overall form (CRITICAL silhouette and scale)**:<绝对尺寸数值> + <跨物种剪影类比 A crossed with B crossed with C>.
<船体/底盘机制/动力/帆或推进/图腾/操作位/战利品 逐块>. <材质 hex 锁部族 DNA>.
【4 Panels detail】逐格写朝向 + 该格要看清的结构(3/4 格放 hero shot,帆/翼展开)
【Critical consistency】SAME individual vehicle — identical 尺寸/图腾/机制/装饰/底盘配置.
【Lighting / Style / Quality / Panel Labels(SIDE/FRONT/TOP/3-4 VIEW)+ Title】
【Constraints】**Scale & crew**:NOT multi-crew / NOT longship-sized(must single-pilot)/…
            **Form factor**:NOT 水船 / NOT 纯轮车 / …  **Aesthetic**:NOT steampunk / NOT chrome / …

【出图后 SOP — 失败模式→补救句映射表(按风险优先级)】
- 跑成多人战舰(MAX)→ "STRICTLY single-pilot vessel, 2.5m long, NOT multi-crew, NOT longship-sized"
- 跑成纯轮车 → "PRIMARY motion via single central runner/skid, wheels are only auxiliary stabilizers"
- 跑成水船 → "DESERT SAND vehicle riding on top of sand via runner, NOT a water boat"
- 跑成现代 land windsurfer → "ancient tribal hand-crafted hardwood hull with bronze fittings, NOT modern fiberglass board"
- 跑成 steampunk → "ancient lost-tech bronze mechanical drive, NOT Victorian industrial steampunk"
- 跑成大 beast-skull figurehead → "small horn totem on prow only, NOT large skull figurehead"
- 跑成精良战舰 → "war-torn salvage tribal handcraft with mismatched repairs, NOT factory-precision boat-building"
```

**校对清单**:尺度对不对(头号风险:跑成多人战舰/longship/big rig → 追加 single-pilot 补救句);主推进机制对(central runner/skid 主 + 轮子辅,非纯轮车);不是水船(沙橇滑沙);材质/世界观 DNA 一致(部族青铜 patina,非 fiberglass/steampunk/chrome);装饰克制(船首小 horn totem 非大兽颅、战利品 sparse 2-3);2×2 四格 + 朝向 + 标签 + 标题到位,3/4 格是 hero shot 帆展开。

---

## 图型 19 · 机械兽形态设计图(creature war-mount design sheet · 2×2 四视图)

**何时用**:给一只机械生物/战兽出独立形态(standalone / dormant)的 2×2 四视图设定图,供建模与后续"合体外骨骼形态"参考。共用图型 18 的版式与光照,但主体是有明确生物原型的机械兽。最大特点也是最大坑:每只兽都有一个唯一识别特征(标 MAX 风险),模型极易把它跑成普通近亲物种。

**命门**:
1. **唯一识别特征标 MAX + "缺了即设计失败"判据**:把那个最难、最易丢的物种灵魂特征点名为 `mandatory recognition feature, if missing the design fails`(如长鼻类的下垂长 proboscis;奔跑鸟的 lean predatory sprinter silhouette + spear beak with terminal hook)。把"主观像不像"变成"客观成/败"。
2. **失败模式 → 补救句映射表(按风险优先级,MAX 在前)**:MAX 风险特征跑歪时判据直接是"整图失败重做";逐风险一句追加语(鼻/角跑歪、体型跑马、生物机改、看不到 cockpit)。
3. **"纯机械、无生物组织"必须反复压**:`fully mechanical construction with no organic components … bronze panel armor "fur"/"feathers" NOT real fur/feathers`——极易跑成"毛皮+装甲"的生物机改,要把每处表面点名为 bronze panel。
4. **背部 cockpit hatch = 世界观钩子,必须在 TOP/3-4 panel 可见**:这是合体外骨骼系统的接口,本张兽形态 hatch CLOSED(dormant),但必须画出。
5. **青铜 patina + cyan 眼 #4FC3D9 同源 DNA**:与角色/载具/小宠物共用,锁世界观一致。

**填空骨架**:
```
模式:文生图(creature design sheet · 兽独立形态 / hatch CLOSED)
size 16:9 横版 / 最高分辨率

A creature design reference sheet. **Horizontal 16:9. Maximum resolution output.**
Pure solid neutral light-warm-grey backdrop. Single-side rim backlight camera-right 45° behind, no fill/front.
Same studio environment as the <同系列角色/载具/兽 sheet>.
【Layout】2x2 equal grid: Top-left SIDE(primary) / Top-right FRONT(把唯一特征怼脸) / Bottom-left TOP-DOWN(看 cockpit) / Bottom-right 3/4(hero, 动态半步).
【Subject — same creature across all 4 panels】<机械兽一句 + 生物原型>.
**SPECIES IDENTIFICATION (CRITICAL)**:<原型物种 + 解剖学特征逐条>.
  —— <唯一识别特征>:the most critical recognition marker — if missing, **the design fails**.
**Construction (CRITICAL)**: Fully mechanical, no biological tissue. bronze armature + bronze panel "fur/feathers"(NOT real). <hex DNA #7A6845/#846035 + verdigris + runic glyph>.
**Eyes**: glowing cyan #4FC3D9(同源科技钩子).
**Cockpit/合体接口**: dorsal hatch human-torso-sized, CLOSED(dormant), MUST be visible in TOP & 3/4.
【4 Panels detail / Critical consistency / Lighting / Style(参考真实物种 wildlife photo)/ Quality / Labels SIDE/FRONT/TOP/3-4 + Title】
【Constraints】**Species accuracy(MOST CRITICAL)**:MUST be <物种>, <唯一特征> mandatory. NOT <近亲物种一串>.
            **Mechanical purity**:NO biological tissue. **Cockpit hatch presence**. **Layout/lighting NOT…**

【出图后 SOP — 失败模式→补救句(按风险优先级,MAX 在前)】
- <唯一特征>跑成普通近亲(MAX)→ 整图失败重做 + "<特征> is mandatory, MUST be visibly <描述>, NOT a normal <近亲>"
- <次特征>跑歪 → "…"  / 跑成生物机改 → "all bronze panels, NO biological tissue"
- 看不到 cockpit → "dorsal hatch clearly visible in TOP-DOWN and 3/4"
```

**校对清单**:唯一识别特征出现了吗(MAX 风险,缺了即失败重做);次级特征(角/喙/尾/翅)对吗;纯机械无生物组织(没跑成毛皮+装甲的生物机改);背部 cockpit hatch 在 TOP/3-4 可见;青铜 patina + cyan 眼 DNA 一致;2×2 四格同一只兽、朝向/标签/标题到位、3/4 是 hero。

---

## 图型 20 · 武器四视图(借结构换材质 · 2×2 设计表)

**何时用**:给一件武器/道具出博物馆级产品摄影四视图设计表(FULL FRONT / FULL SIDE / VENT DETAIL / GRIP DETAIL),供建模与材质参考。product photography 路线。招牌手法是"结构借母本、材质全改写":逐部件 1:1 锁定一个现成设计的结构,同时把材质语言系统性翻译成自有世界观——换皮不换骨。

**命门**:
1. **2×2 四个具名视角格,每格写清朝向 + 取景距离**:`TOP LEFT "FULL FRONT" / TOP RIGHT "FULL SIDE"(engine-side reveal) / BOTTOM LEFT "VENT DETAIL"(macro) / BOTTOM RIGHT "GRIP DETAIL"(macro)`。竖版整剑与超宽横置整剑(刃左柄右)按需选。
2. **借结构换材质 = 两层指令分开写**:一层逐部件 `the same … as the original`(锁结构);一层 `the material language is the key transformation, instead of X every surface is Y`(改材质,如 → 青铜六边形板 #7A6845/#846035 + cyan #4FC3D9 seam + 铜握柄 #A85530)。两层别混成一句。
3. **连对比角色一起映射**:母本里起对比作用的材质区(如红漆),要显式翻译成自有体系里承担同样对比作用的区(深铜绿氧化区),否则改完材质会丢掉原设计的视觉层次。
4. **四格材质一致性是关键命门**:正文结尾必留收束句 `the consistency of … material across all four panels is critical`,真实博物馆产品摄影框架对抗 3D/CG 味。
5. **借参考图时材质全外包给图**:图生图版反复 `every detail exactly per the reference image, do not redesign, do not stylize`,材质细节交给参考图而非文字。首版定材质(文字自描述)→ 复用图扩视角/换画幅,材质最稳。
6. **微距格吃分辨率**:VENT/GRIP DETAIL 是 macro,4K 才能读清叠片与 cyan 缝,1K 会糊。

**填空骨架**:
```
模式:文生图(自描述材质)/ 图生图(武器 ref → 四视图,材质全交参考图)
size 16:9 或 4×16:9 超宽 / 4K(微距可读)

A weapon/character design reference sheet displayed on a clean off-white studio background #F0EDE7
with grid-divided panels, museum-quality product photography, photographic still life of a real physical
handcrafted weapon prop, real material textures through a camera lens, NOT 3D/CG/digital painting,
soft diffused studio lighting from upper left, subtle drop shadow.
Title text at top center reading "<名 — 拼音 — XXX DESIGN SHEET>". Four panels in a 2x2 grid, each
labeled at bottom center.
[TOP LEFT PANEL — "FULL FRONT"] <整件武器朝向 + 一比一锁母本结构逐部件> + <材质改写:母本材质语言 → 自有 hex 材质,连对比角色一并映射>
[TOP RIGHT PANEL — "FULL SIDE"] <侧/引擎侧 reveal,看清厚度与管路>
[BOTTOM LEFT PANEL — "VENT DETAIL"] <macro,喷口阵列,cyan 内辉,no inscriptions>
[BOTTOM RIGHT PANEL — "GRIP DETAIL"] <macro,握柄/配重球,暖铜 vs 冷铜绿对比>
Overall: off-white #F0EDE7, soft upper-left light, subtle film grain, photographic DOF each panel sharp,
**material consistency across all 4 panels is critical**.
（图生图版追加：every detail exactly per the reference image, do not redesign / stylize / add elements not in reference）
```

**校对清单**:四格视角 + 朝向对(FULL FRONT / FULL SIDE 引擎侧 reveal / VENT macro / GRIP macro;横置整剑刃左柄右);母本结构 1:1 保留(喷口阵列/信息面板/管路/握柄配重球逐部件核);材质全改写到位连对比角色都映射(原 gunmetal+crimson → 青铜六边片+铜握柄,原红漆区→深铜绿氧化区);四格材质一致性(头号命门);顶部标题清晰无乱码;读作真实博物馆产品摄影非 3D/CG;够清(4K 优先,1K 微距格糊)。

---

## 图型 21 · 比例尺立绘(人剑等高 · 1:1 高度对照)

**何时用**:给一件巨型武器/巨物和持有它的角色出一张等高比例对照立绘,让人一眼读出"这把剑和人一样高"的尺度关系。full-body character concept art(3:4 竖版,off-white 影棚底,high-fashion costume photography 路线),核心诉求不是姿态美而是比例可对照。命门极反直觉:要让"人剑等高"成立,武器必须竖立体侧 + 剑尖触地,而不是斜搭肩(斜搭肩会被透视压缩,等高读不出来)。

**命门**:
1. **CRITICAL PROPORTION ANCHOR——给人和武器都标同一绝对身高**:`<角色> is 165cm tall. The weapon she holds is also approximately 165cm tall, almost exactly equal to her own height … tip-to-pommel = head-to-foot`。把抽象巨物尺度转成可对照的 1:1 等高。绝对数值 + 双标 + 同高度收束句三件套,缺一面就压不住透视。
2. **武器必须竖立体侧 + 剑尖触地 + 无透视压缩**(等高成立的唯一姿势):`the weapon stands vertically next to her body, parallel to her standing posture, no foreshortening, no perspective compression … the lower tip rests on the ground at her side … the top reaches the same height as the top of her head or slightly above`。斜搭肩/背扛虽好看,但透视一压等高彻底读不出。
3. **同高度收束句锁画框**:把头顶/剑顶、脚底/剑尖各自拉到同一水平线(`both at full height … reaching the same horizontal level`)。
4. **武器外形完全外包给参考图,文字只管姿态与比例**:`The weapon must match the design reference image exactly — all structure/proportion/color/material determined entirely by the reference image and not by this text`。避免文字描述与参考图打架。
5. **身份锁定 + 体型基调正向写**:`@token` + `face/eye/hair must match base reference with absolute precision` + `slim slender feminine, NO athletic musculature, NO six-pack`(女角色易被默认跑成肌肉/六块腹肌,正反向都压)。
6. **2K 起步**:同时要看清人脸身份 + 武器青铜微距,1K 两头都糊。

**填空骨架**:
```
模式:图生图(身份 ref + 武器设计 ref → 等高比例立绘)
size 3:4 竖版 / 2K(优先,比 1K 清)

A single full-body character concept art illustration in 3:4 vertical portrait, on a clean off-white
studio background #F0EDE7, high-fashion character design photography, real material textures through a
camera lens, NOT 3D/CG/anime, soft key from upper left + warm rim upper right, subtle film grain.
The subject is <角色 @token> in <形态>. <catwalk contrapposto S-curve 姿态> + <身份锁:face/hair/eye must match base reference with absolute precision>. Camera angle slightly low looking up.
CRITICAL PROPORTION ANCHOR: <角色> is <Xcm> tall. The weapon is also approximately <Xcm> tall,
almost exactly equal to her own height — tip-to-pommel = head-to-foot. The weapon stands VERTICALLY
next to her body, parallel to her posture, NO foreshortening, NO perspective compression. Her hand grips
near where blade meets grip, the weapon's lower tip rests on the ground at her side, the top reaches the
same height as the top of her head or slightly above. This is a one-to-one height comparison composition.
The weapon must match the design reference image exactly — all structure/proportion/color/material
determined entirely by the reference image, NOT by this text.
<体型基调:slim slender feminine, NO athletic musculature / NO six-pack>.
Composition: <角色> and the vertical weapon as two parallel vertical anchors of EQUAL height — top of
head and top of weapon at the same horizontal level, both feet/tip at the same bottom ground line.
CHARACTER IDENTITY:unmistakably the same person, only clothing changed.
CRITICAL RENDERING:photorealistic studio fashion photography of a real human model, NOT 3D/CG/anime.
```

**校对清单**:武器竖立体侧 + 剑尖触地(头号命门:斜搭肩/背扛会被透视压缩,等高读不出);人剑顶端在同一水平线、脚底/剑尖在同一底线;无透视压缩武器长度;武器外形与设计参考图 1:1 一致(文字不复述);身份锁住没串脸;体型基调对(slim slender feminine,没跑成肌肉壮/六块腹肌);够清(2K 优先,1K 微距糊)。

---

## 图型 22 · 同物种变体(兽王/精英)

**何时用**:已有一只"普通"生物的设定图,要派生出同物种的兽王/精英/首领个体——既要一眼可辨是头领,又绝不能跑成完全不同的生物。核心矛盾:既要"明显不同"又要"还是同种"。用 Edit 模式基于原版参考图,PRESERVE 锁底层物种解剖 + 编号差异要点堆叠两手并用。

**命门**:
1. **一句话框死核心矛盾**:`SAME SPECIES, but visibly DISTINCT as the king — a viewer must read it as "the same kind of creature, but unmistakably the chieftain, different at a glance."` 后面所有差异点都服务它。
2. **PRESERVE 只锁"底层物种解剖",用 `only`**:`Keep the underlying species anatomy of Image 1 (<逐项底层解剖>)` + 结尾复述 `Preserve from Image 1 ONLY the fundamental species body plan … so it stays the same species`。"only" 是关键——只锁身体方案,把颜色/角/体量留给差异化。PRESERVE 写太宽会导致变体跟原版没区别。
3. **编号差异逐条堆叠 + 点出 headline difference**:`1. HORNS (the headline difference — it must grow horns)` / `2. COLOR` / `3. SIZE & SILHOUETTE` / `4. BATTLE-WORN ELDER MARKS`。把最显著差异标成 headline、写 `it must grow X` / `the common one has none`,先立住"一眼可辨";其余差异叠加。这是从普通个体派生任何精英变体的通用打法。
4. **每条差异都"在同一世界里推开"**:如颜色 `shift the palette to set it apart while staying in the same earthy world … still a real weathered mineral/stone material in the same family`——差异化但不脱离原物种材质家族,防跑成异类。
5. **四视图网格 + 逐格 caption + 净底**:`Four-panel grid (2×2): SIDE / FRONT / 3-4 VIEW / DETAIL`,`keep all four panels the SAME creature, consistent design and scale`,净棚灰底、`no rider or equipment`、`no environment`。

**填空骨架**:
```
模式:Edit(基于原版物种参考图,设计同物种变体)
size 21:9 / quality medium / jpeg / Thinking Mode 开
用途:从普通个体派生兽王/精英,要"同种但一眼可辨",净底四视图设定sheet

【参考图标注】
Image 1: the base <物种> — 物种骨架基准。变体须是同物种,但在颜色/外形/头角上要有一眼可辨的明显差异。

【PROMPT 正文】
This is a creature design reference sheet that may appear slightly soft like a real studio-photographed maquette
— this softness is intentional. Design a <CHIEFTAIN/KING/ELITE> individual of the <物种> species shown in
Image 1, presented as a clean creature design sheet on a neutral light-gray seamless studio background, soft
natural studio lighting, a caption label under each panel. Four-panel grid (2×2): top-left "SIDE", top-right
"FRONT", bottom-left "3/4 VIEW", bottom-right "DETAIL — <差异部位>".
SAME SPECIES, but visibly DISTINCT as the <king> — a viewer must read it as "the same kind of creature,
but unmistakably the <chieftain>, different at a glance."
Keep the underlying species anatomy of Image 1 (<逐项列底层解剖:甲壳/头/腿/体型 plan>), but push clear
visual differences in the following ways:
1. <HEADLINE 差异 (the headline difference — it must <grow X>)>: <详述;the common one has none>. <次级差异>.
2. COLOR — shift the palette to set it apart while staying in the same earthy world: <调暗/换色,but still a
   real weathered material in the same family>.
3. SIZE & SILHOUETTE: <更大更高/更具压迫感的轮廓>.
4. <ELDER/精英 标记>: <战损/老者印记/共生附着物堆叠>.
Its bearing reads as <dominant, ancient, imposing>.
Preserve from Image 1 ONLY the fundamental species body plan (<逐项>) so it stays the same species — but
the <差异点 A、B、C> clearly distinguish it as the <king>.
Constraints: keep all four panels the SAME creature, consistent design and scale; clean neutral studio sheet,
no environment, no desert landscape, no sky; no extra creatures; no rider or equipment; keep it a real
biological/mineral creature, not a glossy toy.
PHOTOGRAPHIC TONE: real studio-photographed design maquette, slightly soft, not tack-sharp, photographically
captured not 3D-rendered/AI-stylized, colors restrained not oversaturated.
Avoid: oversharpening, artificial sharpness, heavy digital grain, HDR, AI-generated aesthetic, overpolished
studio look, plastic smoothing, oversaturation, glossy highlight blowout, generic AI image quality, default
model aesthetic bias.
```

**校对清单**:还是同一物种吗(底层 body plan 没变,没跑成异类);一眼可辨是头领吗(headline 差异立住,`the common one has none` 的特征确实长出来了);编号差异逐条兑现(角/调暗色板/增大体量/老者战损四条都在);差异化没脱离原物种材质家族(色变深但仍是同类风化矿物/石质);四视图是同一只(四格 design & scale 一致);净底、无环境/骑手/装备、caption 四格齐。

---

## 图型 23 · 色卡 color bible(平面 Figma 风)

**何时用**:开拍前要给全片钉死一套统一配色、当 production design bible / color management document 用时。reference-driven:色卡不是文生图,而是图生图——给一张电影感场景剧照,本图型从那张剧照提取主/辅/点缀调色板生成色卡;产出的色卡再当"电影感色调"参考图喂进全片每条 prompt。它不是画面是信息图:N 个色块 + 功能命名 + 精确 HEX,横排或网格,平面矢量风。核心反常识:这是全库唯一一种"必须主动反摄影、反电影感"的图型。

**命门**:
0. **按影视功能取色，不按像素面积机械聚类**:木结构、沙地或天空占画面多数时，面积聚类会把色卡挤成一排近似棕/黄/蓝，遗漏窗光、肤色、冷阴影、器物辅助色和叙事焦点色。先列功能槽位（环境高光、自然光白、肤色预留、主材质浅/中/深、冷阴影、器物辅助色、金属色、唯一叙事焦点、暖黑），再从参考剧照为每个槽位取代表色。肤色是人物曝光与调色的预留功能色，不等于场景中占比最大的皮肤像素；用户要求更白时提高明度但保留暖调和血色，并与环境白分离。
1. **反摄影封口是第一命门也是全部技术含量**:模型默认会把色卡渲染成"摆在桌上的 Pantone 卡照片"(带景深/纸纹/投影/高光)。必须用整段 `OVERALL DESIGN SPECIFICATION` + 超长 Avoid 拽回平面设计语言——关键词 `flat 2D vector / Figma or Adobe Illustrator / no depth / no perspective / no lighting / no photographic rendering / no paper texture`。Avoid 里 `photographic rendering, paper texture, desk surface, depth of field, lens blur, film grain, 3D render, shadows under swatches, glossy finish, mockup of physical object` 一个都别省。
2. **三段式结构化布局**:`ELEMENT 1 = 标题/副标题`、`ELEMENT 2 = 一排/网格色块`、`ELEMENT 3 = 每块下方两行注解(HEX + 功能标签)`。写成"三个元素"模型才不会乱排。
3. **13~22 色 + 功能命名 + 精确 HEX 三件套**:功能命名要写"在片里干什么"不是"什么颜色"——`hot sunlight cast / hard shadow / cinnabar accent / LED cyan dormant` 这种才有用,它让调色师知道这色块对应画面里哪块光。
4. **HEX 以写死的码为准,别回读出图**:1K 下色块上的 HEX 小字和功能标签几乎不可读。出图只用来核"色相分布对不对",真实 HEX 永远以 prompt 里写死的码为准,要逐块核 HEX 就上 2K。
5. **分组 vs 一排**:色多(>13)、跨多个叙事单元时用分组表头(主角/反派/环境/过渡);色少、单场景用单排。继承前片色系可把上一片色卡当 ELEMENT 锚喂入保持系统延续,但 HEX 该改还得改。

**填空骨架**:
```
模式:图生图(输入用户提供的电影感场景剧照 Image 1 → 提取该场景调色板生成色卡)
size 16:9 横 / quality(1K 下小字必糊,要逐块核 HEX 请上 2K)
用途:color bible 物料图 + 后续全片电影感色调输入

【参考图标注】
Image 1(电影感场景参考):仅作为调色板提取来源 —— 从这张剧照提取主色/辅助色/点缀色填进下方色卡;不复制其构图/人物/内容,只提取颜色。

【PROMPT 正文】
A clean digital color palette reference design that EXTRACTS its palette from the provided cinematic scene reference (Image 1), 16:9 horizontal layout, pure flat design aesthetic with NO
photographic elements. Background: solid neutral <off-white #F5F2EC / pure white #FFFFFF>, completely flat,
no texture, no shadow, no paper, no surface.
The composition contains exactly three elements:
ELEMENT 1 — Title (top center): clean sans-serif, solid black <#1A1A1A>, reads "<片名 · EPx · 场景 · PALETTE vN>".
  Subtitle below in smaller gray <#888888>: "<一句调性描述 · N color system>".
ELEMENT 2 — A single horizontal row of <13~22> rectangular color swatches, evenly spaced, identical dimensions,
  sharp clean edges, no gradient, no shadow, no border. The swatches left to right with these exact HEX fills:
  01:<#> 02:<#> … N:<#>
  （可选分组:ROW1 "<PROTAGONIST/主角组>" / ROW2 "<反派组>" / ROW3 "<ENVIRONMENT/环境组>"）
ELEMENT 3 — Two lines of small text beneath each swatch: line1 = HEX in monospace <#333333>; line2 = function
  label in smaller sans-serif <#666666>. The N function labels left to right: 01:<hot sunlight cast> 02:<sand
  highlight> … N:<LED cyan dormant>.
OVERALL DESIGN SPECIFICATION: flat 2D digital graphic design layout, the kind produced in Figma or Adobe
Illustrator for a film production design document. No depth, no perspective, no lighting, no photographic
rendering, no paper texture, no physical object. Pure flat vector-style swatches on a flat background with crisp
typography. Production design bible / color management document / design-system documentation. Precise, clinical,
informational, minimal, professional graphic design — not artistic, not painterly, not photographic.
Avoid: photographic rendering, paper texture, desk surface, table surface, depth of field, lens blur, film grain,
photorealistic, 3D render, lighting effects on swatches, shadows under swatches, glossy finish on swatches,
hand-painted look, watercolor, illustration, sketch, mockup of physical object, real-world object simulation.
```

**校对清单**:真的是平面矢量吗(最易翻:被渲染成桌上的色卡照片带景深/纸纹/投影/高光,见到任何实物感就是反摄影封口没生效);色块数量对不对;色相分布对不对(出图唯一可靠核验的事);每块下面有没有功能标签;HEX 真值别从图上回读以 prompt 写死的码为准;背景是纯平 off-white/white 无纹理无投影。

**严格交付补充**:若用户要求色块与 HEX 像素级一一对应，生成模型只负责辅助提取功能色与版式草案，最终色卡应由程序/Figma/Illustrator 按文字 HEX 直接绘制；不得把模型渲染出来的色块重新采样成“真值”。

---

## 图型 24 · 灰底物料抠图

**何时用**:要把已有成图/角色图里的某个局部道具单独抠出来,做成干净的中性灰底物料图(给后期当贴图/参考/资产)时。典型:从角色全身图里只要她腰上挂的那个包。这是全库最短最省的物料图型——一句中文搞定,同句换参考图可批量出料。

**命门**:
1. **指代法定位主体,不描述外观**:不写"一个深褐色抽绳布袋",而写"人物腰间挂着的那个包"——用"在哪个位置、挂在谁身上"的指代让模型从参考图里自己定位并抠出。外观交给参考图,prompt 只负责"指哪个"。指代要唯一,画面有多个同类物时指代要更精确("右腰那个""带流苏的那个")。
2. **灰底 = 物料图的封口词**:`灰底`一句把背景洗成中性,产出可直接复用、不带原场景污染的资产图。
3. **负向锁最易翻的那一项**:本例 `不要有简体字`——符箓最易被跑成简体字。换别的道具就锁它最易被 AI"现代化/简化"的那点(如"不要现代拉链""不要塑料感")。
4. **同句换参考图批量**:prompt 一字不动,只换参考图 + 节点就能批量出不同物料(或同物料刷一致性)。要出一整套道具物料就把这句存成模板,逐件换参考图跑,别每件重写文案。
5. **方图便于当资产**:1:1 输出物料图最通用,后期当贴图/图标都好用。

**填空骨架**:
```
模式:图生图(喂含该道具的角色图/成图当参考 → 抠出局部成独立物料图)
size 1:1(物料图常用方图,便于当资产) / quality 视需要
用途:物料图 / 设定图,抠局部道具

【PROMPT 正文 — 一句中文即可】
生成灰底物料图,内容为<指代法定位:人物腰间挂着的那个包 / 角色手里那把刀 / 桌上那只青铜罗盘>。
<道具关键特征一句:包上贴着两个米色道家符箓>,<负向锁最易翻项:不要有简体字 / 不要现代材质>。

（批量:prompt 一字不动,换参考图 + 换节点反复出料即可)
```

**校对清单**:抠对了吗(指代的那个道具被单独抠出,没把旁边的也带出来);背景是干净中性灰(无原场景元素/光污染);道具特征对不对(本例:两个米色符箓在不在、位置对不对);负向项守住没(本例:有没有冒出简体字、符箓是不是篆体/符文样式);批量复用时核的是成果不是版面(参考图位的串接残留可忽略)。

---

## 图型 25 · knolling 桌面陈列

**何时用**:要把一组道具/物件按"整理收纳学(knolling)"摊平在桌面、90° 正俯拍成一张平面色块感极强的陈列图时(给美术当道具清单 / 当 Wes Anderson 式氛围物料 / 当后期合成资产总览)。难点不在"摆得齐",而在让模型把桌子读成一个有厚度的三维实物、从正上方拍,而不是把物件糊成一张平贴的图。

**命门**:
1. **90° 正俯 + 桌体三维厚度双重声明**:开头 `A perpendicular overhead 90-degree top-down photograph … viewed from directly above`,且专门用一整句强调桌子有厚度:`The table is a real three-dimensional physical object with measurable thickness — the tabletop sits raised above the floor on hidden legs … a narrow strip of the side-thickness is visible as a darker band along each of the four edges`,再加 `The raised tabletop casts a soft narrow shadow onto the floor along each edge`。桌缘厚度带 + 桌缘投影 = 让"俯拍"读出"桌子浮在地面上"而非"一张平图"的关键,这段别删。
2. **逐物 hex + 逐物对齐**:每个物件给精确 hex,`every object aligns to invisible parallel and perpendicular axes`(knolling 定义:全部对齐到隐形平行/垂直轴)+ `deliberate generous empty spacing between item groups`(组间留白)。
3. **Mondrian 计数法做色块平衡**:色块大小靠数量而非单件尺寸——`color-block sizing achieved purely through the quantity and grouping of uniformly-sized strips rather than any variation in single-strip size`。所有符纸同尺寸,5~6 张挤一起 = 大色块,2~3 张 = 中,1 张孤蓝 = 最小,`asymmetric Mondrian balance through quantity`。这是 knolling 出"平面色块画"观感的灵魂。
4. **Avoid 排 fisheye / 透视畸变**:90° 俯拍最易被加鱼眼/广角畸变,把 `fisheye, wide-angle distortion, perspective convergence, tilted angle` 排进负向。90° 是模型阻力区,`directly above / straight down / 90-degree` 反复说。
5. **喂一张布局参考最稳**:有参考图,模型对"摆哪、几件、什么材质"就不靠脑补,knolling 对齐和数量更准。

**填空骨架**:
```
模式:文生图 / 图生图(喂一张"桌面物品布局参考"锚定 layout、材质、色彩、knolling 排列)
size 21:9 超宽(便于一桌横陈) / quality 视需要
用途:桌面陈列物料图

【PROMPT 正文】
A perpendicular overhead 90-degree top-down photograph of a single low wide horizontal <桌/台> viewed from
directly above, the complete table including all four edges fully visible within the 21:9 ultrawide frame, sized to
fill most of the frame against a narrow border of the <floor/底面> beneath.
The table is a real three-dimensional physical object with measurable thickness — the tabletop sits raised above
the floor on hidden legs, and around the perimeter a narrow strip of the side-thickness is visible as a darker band
along each of the four edges, distinguishing the raised top from the floor below. The raised top casts a soft narrow
shadow onto the floor along each edge, the shadow lines defining the elevation. The table is the absolute subject.
<参考图 作为桌面物品布局、材质、色彩、knolling排列方式的视觉锚定参考。>
Every object on the table — <逐物 + 逐 hex:桌布 #_, 朱砂符×5-6 #_, 赭黄符×2-3 #_, 孤蓝符×1 #_, 青铜罗盘,
笔×2, 墨石, 朱砂碟, 铜钱横列, 铜铃, 卷轴, 空布袋> — strictly matches the reference in shape, color, material,
QUANTITY, individual size, and knolling-style alignment positions, each object aligned to invisible parallel and
perpendicular axes with deliberate generous empty spacing between groups.
Mondrian 计数法:color-block sizing achieved purely through QUANTITY and grouping of uniformly-sized strips,
NOT through varied single-strip size — the largest red block = a cluster of 5-6 identical strips, medium ochre block
= 2-3 strips, smallest = 1 lone indigo strip; asymmetric Mondrian balance through quantity.
Lighting: warm soft pool of a single <oil lamp #E87838→#A8401C> from above-behind, deep warm-brown shadows
#4A3E32 in the recesses, narrow cast shadow along each table edge.
35mm Kodak Vision3 500T, Greig Fraser cinematography, Dune 2021 firelit interior aesthetic, skip-bleach LUT,
analog grain, shot as a flat overhead reference photograph at 21:9.
Avoid: fisheye, wide-angle distortion, perspective convergence, tilted angle, <题材级负向>.
```

**校对清单**:是不是真·90° 正俯(易翻:被拍成斜俯 3/4,物件就不再是 knolling 平面色块);桌子有没有读出三维厚度(看四条桌缘有没有厚度暗带 + 落在地面的窄投影,没有 = 糊成一张平图);物件数量对不对(Mondrian 计数法靠数量,数错色块就失衡);对齐了吗(每件对齐到隐形平行/垂直轴,组间有留白);有没有鱼眼/广角畸变;逐物 hex 与材质对不对。

---

## 图型 26 · 杂志风介绍卡(60-30-10)

**何时用**:要为单个角色出一张高级时尚杂志风的"人物介绍页"(i-D / Dazed / AnOther 风),角色当主体大图 + 周围拼贴编辑元素(标题块、宝丽来、便签、符纸、印章、涂黑条),并用 60-30-10 配色做版面结构时。常做成冷暖双联(warm/cool diptych):同一套 60-30-10 结构系统,按各角色服装色反向校准背景冷暖。

**命门**:
1. **60-30-10 量化配色,逐档给 hex + 给职能**:`60% DOMINANT = 背景主色`、`30% SECONDARY = 一个大矩形色块(装标题与资料,risograph/offset 粗边)`、`10% ACCENT = 强调色,出现在 exactly four places(眼/耳坠/一枚印章/一处笔触标签),NO other anywhere else`。三档都写死 hex,且 10% 强调严格只许四处——不写死模型会到处撒强调色,版面立刻廉价;在 Avoid 里加 `more than four accent points`。
2. **冷暖双联 = 按角色服装色反向校准背景**:背景选与角色服装相反的冷暖,让人物从背景跳出来(figure-ground separation)。如白/黑/红服角色→暖基调,酒红/奶白/棕皮服角色→冷基调。prompt 里显式写 `SERIES DESIGN SYSTEM NOTE` 交代两卡如何成对,这是整组卡既统一又有别的最值钱一招。
3. **figure-ground 临界校准**:背景中明度必须卡在"比角色暗部亮、比角色亮部暗"之间——`mid-tone must be brighter than her black skirt AND darker than her white tunic`。这句直接决定剪影能不能瞬间读出。
4. **拼贴元素清单逐项点名 + 反对称**:`MAIN TITLE BLOCK(中文名大字 sans-serif modernist + 罗马音)/ DATA FIELDS(资料栏,可全填"?")/ KICKER 手写大标 / POLAROID / 符纸 or REDACTION 涂黑条 / 印章 seal stamp / 归档号 Vol.0x`,排版 `asymmetric — NOT a rigid grid, NOT a centered column`。反对称、反网格是 editorial 的命。
5. **双重反走样**:`STYLE LOCK: i-D / Dazed / AnOther` 锚时尚杂志语言 + `PHOTOGRAPHIC TONE: real printed magazine spread + real paper texture + real ink-on-paper + 宝丽来与印章的真实投影`,缺一不可——只锁 style 出数字海报味,只锁 tone 丢 editorial 排版。最易打折的是符纸篆体字/印章 seal-script/宝丽来里小脸等精工细节,要上 2K+ 或接受缩略层级看不清。

**填空骨架**:
```
模式:图生图(Ref1 = 角色身份锁脸/服装;可选 Ref2 = 只借姿势 body pose,不借身份/脸/衣/背景)
size 16:9 横 / quality 2K
用途:角色介绍卡物料图

【PROMPT 正文】
REFERENCE IMAGE(S): Ref1 — preserve identity/face/hair/clothing exactly. (可选 Ref2 — use ONLY body pose &
wind energy, NOT its identity/face/clothing/background.)
INSTRUCTION: 16:9 editorial magazine spread, contemporary high-fashion editorial (i-D / Dazed / AnOther). A
character introduction page; this is card N in a series — companion to card N-1.
COMPOSITION: <角色> stands center-LEFT, ~35-40% canvas width, full body head-to-feet, <pose 一句>. Right
55-60% = editorial collage, arranged asymmetrically — NOT a rigid grid, NOT a centered column.
COLOR PALETTE (60-30-10):
  60% DOMINANT — <背景主色 + hex 范围>(按角色服装反向选冷/暖;NOT <易跑偏的近似色逐个排除>).
  30% SECONDARY — <大矩形色块 + hex>,占右上 25-30%,装 main title + data,light cream type,risograph 粗边.
  10% ACCENT — <强调色 + hex>,EXACTLY four places:(1)<眼/光点>(2)<耳坠/饰>(3)一枚印章(4)一处笔触标签.
    NO other <强调色> anywhere.
SERIES DESIGN SYSTEM NOTE: card N-1 用了<暖基调三色>;本卡用<冷基调三色>,二者成 warm/cool diptych,同一
  60-30-10 结构、按角色服装色各自校准.
FIGURE-GROUND:背景中明度必须 brighter than <角色暗部> AND darker than <角色亮部>,剪影 instantly readable.
EDITORIAL COLLAGE:1 标题块(中文名大字 modernist sans-serif + 罗马音)/2 资料栏(姓名/年龄/身份/能力/性格/
  携带物,可全填"?")/3 KICKER 手写大标/4 宝丽来(白边微倾、投影)/5 符纸 or REDACTION 涂黑条/6 印章(seal-script)
  /7 归档号 "Vol.0x / 人物志".
PRESERVE / CHANGE / CONSTRAINTS / STYLE LOCK (i-D/Dazed/AnOther) / PHOTOGRAPHIC TONE (real printed
  magazine spread, paper texture, ink-on-paper, real polaroid & stamp shadows).
Avoid: anime cel-shading, manga, 3D render, video game UI, anime intro card, progress bars, brush calligraphy for
  main title, antique scroll paper, bamboo/desert/mecha/school background, garbled Chinese, >four accent points,
  symmetrical grid, centered column.
```

**校对清单**:60-30-10 三档色块都在、比例对(背景占大头、30% 大矩形装标题、10% 强调色点睛);10% 强调色严格只有四处(最易翻);figure-ground 角色从背景跳出来了(黑裙读暗、白衣读亮,背景明度卡在两者之间);冷暖双联这张背景冷暖和角色服装相反;版面反对称(没跑成居中列/规整网格);中文无乱码(标题/资料栏/印章/符纸逐处看是不是真字);像被拍下来的印刷页(宝丽来/印章有真实投影、纸纹);高危精工项(符纸篆体/印章/宝丽来小脸)是否糊成一团。

---

## 图型 27 · EVA 风人物海报(借姿势不借人)

**何时用**:要把一个已有角色重组进平面图形海报——身份保留、但换一套更有张力的姿势 + 改个别特征(如发光赤瞳)、配满版文字底纹背景、落片名——做角色物料 / 关键视觉 / 片名海报时。版式语言是 EVA(新世纪福音战士)式平面海报:单人主体压满画面、背后是密集的文字图案墙。它不是写实成片,是 flat graphic-design poster。

**命门**:
1. **双参考图职责切分,且逐项显式禁用**:全图型命根。Ref1 只给身份(`Preserve her identity, face, hair, hair accessories, and entire clothing exactly`),Ref2 只给姿势 + 风动能(`Use ONLY the body posture and the wind-blown energy`),然后一句不留地禁用 Ref2:`Do NOT use this image's character identity, face, clothing, eye color, or background setting`。"借姿势不借人"是高频翻车点,必须靠这套切分 + 末尾 CHANGE 块二次复述每一项替换(`Reference 2's character → entirely replaced` 等)彻底锁死。
2. **红是全图唯一高饱和(THE CONTRAST PRINCIPLE)**:发光赤瞳是全图最高饱和单点(`the single highest-saturation point`),红腰带 + 红发穗是仅有的另两处饱和红,其余一切压成低饱和深色。背景文字墙刻意做暗、永不与人物抢亮度(`background brightness competing with figure` 进 Avoid)。三处分别写明 + Avoid 压 `oversaturation of non-red elements`,双向夹。
3. **背景是平面文字墙、零透视**:`flat backdrop with NO perspective depth, NO three-dimensional space` + `purely a wall of text at the same depth`。文字必须是正经成形的篆隶字(`properly-formed seal-script / clerical-script, not garbled glyphs`),塞进项目主题关键词。
4. **片名是版面上最大的字、与底纹小字明确分层**:`clearly distinct from the small bamboo-slip text`,`No other large text`。
5. **模板写死、只换画幅批量产出**:同 prompt 换 aspect ratio 再跑一次成套物料,正文一字别动。

**填空骨架**:
```
模式:图生图(双参考图 → 合成平面海报)
size 9:16 或 4:3(同 prompt 换画幅即可成套)/ quality medium
用途:角色物料/片名海报,EVA 式平面图形海报,非写实成片

REFERENCE IMAGES:
- Reference 1: <角色>。Preserve identity, face, hair, hair accessories, and entire clothing EXACTLY.
- Reference 2: the body pose。Use ONLY body posture + wind-blown energy of hair/clothing.
  Do NOT use this image's character identity, face, clothing, eye color, or background.

INSTRUCTION: Generate a <画幅> Chinese cinematic film poster combining these two references,
in the visual language of a flat graphic-design poster — single character over a patterned
typographic background — like a Neon Genesis Evangelion character poster, figure dominating
against a dense text-pattern backdrop.

COMPOSITION: <角色> from Ref1 fills ~75-80% of canvas vertically, full body, centered, in the
EXACT dynamic pose from Ref2 with hair/sleeves/<布料> wind-blown. Eyes are the ONLY modification
from Ref1: <发光赤瞳 hex,supernatural luminous like lit coals, irises bright红 / whites natural>.
Everything else preserved exactly from Ref1.

BACKGROUND — <满版文字墙>:flat wall-like pattern edge-to-edge,<材质做旧深色 hex>,竖排篆隶字
top-to-bottom right-to-left,塞入主题关键词<…>,NO perspective / NO 3D / flat at same depth,做旧裂纹尘埃。

COLOR & TONE / THE CONTRAST PRINCIPLE:背景深低饱和坐阴影;人物中亮调站前;<红 hex>(眼/腰带/穗)是
全图唯一全饱和、视觉层级峰值;非红元素一律 slight gray tone, NOT oversaturated。

TITLE TYPOGRAPHY:片名 <片名> 大墨笔篆书竖排<位置>,与小字底纹明确分层,版面最大字,无其他大字。

PRESERVE FROM REFERENCES / CHANGE FROM REFERENCES:(逐条复述身份保留项 vs 改动项)
CONSTRAINTS:不加其他角色/机甲/武器/手持物;不留 Ref2 的校服/校园/天空/樱花;背景不加透视;无 logo/水印;
            无英文;篆隶字不可乱码;背景不可提亮。

STYLE LOCK:Flat graphic-design poster(EVA 时代日式动画海报传统)+ 中式神话符号;painterly 人物 + flat 文字底纹;
           细胶片颗粒;<色板 hex 全清单>。
PHOTOGRAPHIC TONE:像真实印刷海报、略软不锐(此软是刻意);真人皮肤毛孔瑕疵,无塑料感。
Avoid:oversharpening, HDR, beauty-filter, AI aesthetic, anime cel-shading, 3D, 校服/校园/樱花/天空,
       额外角色, 手持武器, 背景透视, 乱码汉字, 英文, watermark, 提亮背景, background brightness competing with figure,
       neon-glowing eyes that look digital/cyberpunk。
```

**校对清单**:身份是 Ref1 的人(脸/发型/服装/配饰没串成 Ref2);姿势 + 风动取自 Ref2(Ref2 的校服/校园/天空/樱花没漏进来);背景是平面文字墙、零透视、汉字成形篆隶没乱码;红(眼/腰带/穗)是全图唯一高饱和(其余没被提饱和、背景没被提亮抢人物);赤瞳明显发光(全身图脸小易打折,重点核);片名是版面最大字、与底纹小字分层;换画幅版各元素自适应、标题没被画幅吃掉。

---

## 图型 28 · 片头标题卡(复古动漫·空画框版)

**何时用**:要做片头 / 标题卡 / 章节卡:版面要有片名 logo + 副标 + 一句主题文案,且人物位置留空(后期再合成)时。本图型用复古动漫片头版式——1990 年代日式赛璐珞(cel)电视画风、平涂水粉质感、复古片头 logo,左侧挂一个完全空的画框(`COMPLETELY EMPTY`)做后期抠像位。纯平面美术稿、非写实、非 3D。

**命门**:
1. **空画框 = 后期合成位,且必须"完全空"**:画框内是一块纯色荧光绿面板,`COMPLETELY EMPTY — no silhouette, no figure, no object, just a clean blank glowing green surface, leaving negative space`。这句把"留负空间给后期"说死,否则模型会"好心"往框里塞个人影;这块绿同时就是预埋绿幕。
2. **大量精确 hex 锁复古赛璐珞配色**:背景平涂蓝灰 `#5f7689`、画框白边 `#ece9df`、绿面板/logo 荧光绿 `#5cb946`、中国结红 `#c4262c`、金珠 `#f0c419`——钉死复古片头色彩规范。
3. **反向强调精工细节防被简化**:四角中国结(盘长结)写明编织过户、金珠、红流苏,并用 `NOT flat, NOT cartoonish, NOT simplified` 反向夹住,因为重型 prompt 里这类精工最易被模型省成卡通简化。即便写了仍可能打折,细节越多越要单独放大核验。
4. **三处文字各就各位**:lower-right 片名 logo(荧光绿笔刷 + 深绿描边)、其下拉丁副标、bottom-center 主题文案。
5. **整体反摄影 / 反 3D**:`flat colors, no photographic realism, no 3D rendering, no glossy plastic look`——锁在平面赛璐珞语言。纯文生图,靠精确 hex 钉死色彩规范;成套出多张片头卡就固定 hex 清单 + 只改文案/画幅。

**填空骨架**:
```
模式:文生图(纯描述,无参考图)/ 也可作底图后续换元素
size 21:9(或所需画幅)/ quality medium
用途:片头/标题卡物料,复古动漫赛璐珞风,空画框留后期合成位

A <画幅> retro anime title-card illustration in the style of a 1990s Japanese cel-animation
TV screen, flat hand-painted gouache texture, slightly aged with subtle film grain.
Background: a flat muted <蓝灰 hex> field, evenly painted, calm/uncluttered, faint cel-paint texture.

<位置> a vintage SQUARE picture frame (1:1) mounted on the wall。Frame: clean off-white(<hex>)
painted wooden border, soft rounded corners. Inside: flat solid fluorescent <绿 hex> panel,
COMPLETELY EMPTY — no silhouette, no figure, no object, just blank glowing green, leaving negative space.

At each of the four corners of the frame hangs a 中国结(páncháng endless knot)woven from glossy
deep-red(<hex>)silk cord, visible over-under braiding + layered loops; gold(<hex>)bead at center;
red silk tassel below。NOT flat, NOT cartoonish, NOT simplified —— jewelry-quality craftwork.

Lower-right: bold stylized title logo <片名> in thick fluorescent <绿 hex> brush-style lettering
with darker green outline, playful/iconic like a retro anime show logo。Below: thin spaced latin
subtitle <拉丁副标> in small light-cream letters。Bottom-center: small cream-white text <主题文案>。

Overall mood: nostalgic, iconic, clean composition, flat colors, no photographic realism,
no 3D rendering, no glossy plastic look。
```

**校对清单**:画框内真的完全空吗(纯荧光绿、无人/无影/无物,这是后期合成的命门);三处文字都在且对吗(片名 logo / 拉丁副标 / 底部主题文案);配色 hex 对吗(蓝灰背景/荧光绿/白框/红结/金珠);四角中国结有没有被简化成卡通(放大看盘长结编织/金珠/红流苏);整体是平涂赛璐珞、非写实、非 3D、无塑料光泽;画幅成立吗。

---

## 图型 29 · 绿幕 / 动捕占位图(为后期合成预留)

**何时用**:要为后期动捕 / 绿幕合成预留视觉锚点时,两条路:(A) 在已有角色物料上叠加"绿幕动捕黑色点状外穿设备",做成 mocap suit 前置素材(一句中文轻型改图);(B) 在标题卡 / 版式里把人物位置做成"完全空的荧光绿面板",生图阶段预埋绿幕供后期抠入角色(见图型 28)。两者都不是成片,是给合成 / 动捕流程当前置占位素材。

**命门**:
1. **(A) 黑点要"很多 + 遍布全身"像真 mocap suit**:`在他身上加很多用于绿幕捕捉的黑色点状外穿设备`——关键词"很多""点状""外穿设备"缺一不可:不写"很多"会零星几点,不写"外穿设备"会被画成衣服纹样而非贴附标记点。一句话轻型改图即可一次到位。
2. **(B) 绿幕位必须"完全空"**:`COMPLETELY EMPTY — no silhouette, no figure, no object, just a clean blank glowing green surface`。预埋的是 fluorescent spring-green `#5cb946`,标准抠像绿,空了后期才能抠入。与图型 28 标题卡是同一手法。
3. **占位优先于美感**:成功标准是"后期能不能用"——动捕点够不够多够标准、绿幕够不够纯够空,而不是好不好看。别用美感标准评判。

**填空骨架**:
```
【路 A · 给角色加动捕点 — 图生图轻型改图】
模式:图生图(角色物料图 → 叠加动捕设备)/ 中文一句
在他身上加很多用于绿幕捕捉的黑色点状外穿设备
  （要点:很多 + 点状 + 外穿设备 + 遍布全身,像真实 mocap suit 标记点）

【路 B · 留绿幕空框 — 见图型 28 标题卡】
... Inside the frame: flat solid fluorescent spring-green (#5cb946) panel,
COMPLETELY EMPTY — no silhouette, no figure, no object, just blank glowing green, leaving negative space.
  （这块绿即预埋绿幕,后期抠入角色）
```

**校对清单**:(A) 黑点是"很多 + 遍布全身"吗(像真 mocap suit,非零星几点);(A) 黑点是点状外穿设备(贴身上/衣外,而非画进皮肤/衣纹);(B) 绿幕位真的完全空吗(无人/无影/无物),绿够不够纯(`#5cb946`);角色身份/其余元素有没有被改动(轻型改图只该加点,别串脸/改服);这张后期能直接用吗(动捕/抠像流程视角,而非美感视角)。

---

## 图型 30 · 质感后缀模块(挂载件,非独立图)

**何时用**:它不是一张图,没有主体——是一串纯光学/质感关键词,挂到任意主体 prompt 的末尾,统一注入"模拟胶片柔焦 + 去 AI 数字锐化味 + 统一材质语言"的画风。当你已有一条内容 prompt、只想整体改质感/改调性/去 AI 味而不动内容时,把这串词追加上去即可。本质是可复用的画风挂件/后缀模块。

**命门**:
1. **只写质感、不写内容**:整串没有任何主体/场景/构图描述,纯是光学与材质关键词——所以能挂到任何主体后面而不干涉画面内容,只改"看起来的质感"。它没有主体,单独跑没意义,必须挂到一条已有内容 prompt 后面才生效。
2. **主动注入胶片柔焦 + 反数字锐化**:核心三组——`halation on highlights`(高光光晕)、`photochemical softness` / `analog edge bloom`(化学胶片柔)、`no digital sharpening`(去数字锐化)——把模型默认的数字锐利味压成模拟胶片柔感。
3. **配"做减法"的画面语言**:`large color blocks, negative space, graphic simplicity, single focal point, unified material, subdued micro-detail`——大色块 + 留白 + 单焦点 + 统一材质 + 收敛微观细节,整体往克制、统一、不噪推。
4. **它治的是 AI 味,不是治糊**:柔焦 ≠ 糊,它是有控制的边缘柔化 + 高光晕染,不是降清晰度。若整图发糊,问题在主体 prompt 或分辨率,别赖这串后缀。与重型 prompt 的 `PHOTOGRAPHIC TONE` / `Avoid` 段功能重叠但更轻,是不想写整段电影感签名时的速配替代。

**填空骨架**:
```
【挂载方式】把下面整串词追加到任意主体 prompt 的末尾,统一画风,主体内容不动。
【模块本体 — 纯关键词串,无主体】
soft focus edges, gentle edge falloff, film-like softness, halation on highlights,
photochemical softness, analog edge bloom, no digital sharpening, restrained detail,
minimalist texture, large color blocks, negative space, graphic simplicity, hierarchy of focus,
single focal point, unified material, smooth surfaces, clean rendering, matte finish,
cohesive texture language, subdued micro-detail
```

**校对清单**:边缘柔焦/高光 halation 光晕出来了吗(模块见效最直接信号);数字锐化味压下去了吗(模拟胶片柔感、非数字锐利);柔焦有没有过头变成糊(柔 ≠ 糊,应是有控制的边缘柔化、主体仍清晰);大色块/负空间/单焦点/统一材质有没有兑现;主体内容没被这串后缀干扰/篡改吧(它只该改质感不改画面内容)。

---

## 图型 31 · 正反打双人对话关系板(shot/reverse-shot dialogue coverage board · 180°轴线)

**何时用**:一个空间内两个角色面对面说话(对话戏)、要在拆单帧之前先锁死"谁在轴线哪一侧、谁看哪个方向、正反打怎么覆盖"时。它是 per-scene 的人物关系交代板——一张 6 格 contact sheet,把一场双人对话的过肩/近景/中近景正反打覆盖一次性铺出来,当全场对话镜头的轴线/视线真源。和图型01(俯视、≥3 人、空间站位)互补:01 交代"谁站哪",31 交代"谁看谁、怎么打"。技术上是图型10(同场景多机位九宫格)的对话特化变体——砍到 6 格 + 加一条 180°轴线锁。

**命门**:
0. **先核模型真实输出规格**:`2列×3行` 且每格 `16:9` 的理论总画幅为 `32:27`（约 `6:5`）。模型若只支持方形或固定尺寸，可以把六格关系与轴线作为第一验收目标，但必须读取实际像素并如实标注画幅偏差，不能把请求参数当成成图尺寸。
1. **180°轴线锁 = 本图型的灵魂(图型10 没有的那条)**:把轴线落成屏幕方向恒定——`A 恒在 screen-LEFT 且视线恒朝 RIGHT;B 恒在 screen-RIGHT 且视线恒朝 LEFT;镜头绝不跨过 A—B 连线`。要在正文开头声明一次、在 CONSTRAINTS 再复述一次(重复 = 注意力强化)。漏了它 6 格视线各自为政、跨轴不接。要正向(A左朝右/B右朝左)+ 负向(Avoid 视线翻转)双写。
2. **版面即轴线:2列×3行,左列恒A、右列恒B**:不要 3列×2行(把正反打对子拆到不同行)。用 2 列(左=A 覆盖、右=B 覆盖)× 3 行(过肩对/近景对/中近对),奇数格 1/3/5=A、偶数格 2/4/6=B。左右列直接把轴线两端做成版面,最防跨轴。编号 1–6 从左到右再从上到下,右下角白色加粗。
3. **继承图型10 的全局锁**:`同一房间、同一主光、同一戏服、同一时刻 —— 6 格是一个时刻的 6 个机位`。少了这句 6 格漂成 6 个不同时刻/不同光。
4. **过肩肩属 + 虚化前景方位写死**:格1 偏 A(A 的脸,B 的肩在右前景虚化);格2 偏 B(B 的脸,A 的肩在左前景虚化);格5 A 中近、B 作右边缘虚化前景;格6 B 中近、A 作左边缘虚化前景。方位错了轴线就崩。
5. **双角色定妆参考图分工 + 串脸 MAX**:6 格 ×2 人脸一致是最大风险,逐张参考图排他声明(Image1 只锁 A、Image2 只锁 B)+ Avoid 写 `faces swapped or merged`。第三人(随从/旁观)只作背景暗影、近景格剔除。

**填空骨架**:
```
模式:图生图(A 定妆 Image1 + B 定妆 Image2 + 场景 Image3 → 6 格正反打关系板)
size ~6:5 近方形(容 2列×3行的 16:9 格)/ quality 4K / Thinking Mode 开
用途:关系交代板 / 轴线·视线真源,blocking 级(位置/朝向/轴线正确优先于单格美感)

【参考图标注】
- Image1(角色A 定妆):只锁 A 的脸/发/戏服。
- Image2(角色B 定妆):只锁 B 的脸/发/戏服。
- Image3(场景锚):只锁环境与光。

【180°轴线 — 最高优先,6 格全适用】
A 恒在 screen-LEFT、视线恒朝 RIGHT;B 恒在 screen-RIGHT、视线恒朝 LEFT;镜头绝不跨 A—B 连线。
<A 位置一句:斜倚/坐/立 + 在左>;<B 位置一句:立/坐 + 在右>;<第三人:隐于 B 身后阴影>。
同一房间、同一主光、同一戏服、同一时刻。

【6 格(2列×3行,左A右B)】
格1(行1-左)过肩中景偏A:A 的脸与上半身在左,越过右前景虚化的 B 肩;A 开口、视线朝右。
格2(行1-右)反打过肩中景偏B:B 的脸与上半身在右,越过左前景虚化的 A 肩;B 开口、视线朝左<;第三人暗影在其身后>。
格3(行2-左)A 单人近景,平视,无前景:脸占满,视线朝右,说话微表情。
格4(行2-右)B 单人近景,平视,无前景:脸占满,视线朝左,说话微表情。
格5(行3-左)A 中近景单人,平视,B 作右边缘虚化前景;A 恒左、视线朝右。
格6(行3-右)B 中近景单人,平视,A 作左边缘虚化前景;B 恒右、视线朝左。

【PRESERVE】A(Image1)、B(Image2)脸与戏服 6 格完全一致,不串脸/不合脸;场景(Image3)与主光跨格一致 = 一个时刻六机位。
【CONSTRAINTS — 复述轴线】每格:A 左·朝右,B 右·朝左,镜头不跨轴,跨格视线相接;第三人只作背景暗影、近景 3/4 剔除;恰好两个说话角色;全图唯一文字是右下角白色加粗格号 1–6,无字幕/水印/logo;每格细白边分隔。
【PHOTOGRAPHIC TONE】真实电影定格,<基调一句:暖烛光/冷蓝/日光>,35mm 胶片感,细微 grain,柔和景深,3–6 格平视镜头,克制不过饱和不塑料。
【Avoid】跨 180°轴线、视线翻转(A 朝左或 B 朝右)、faces swapped or merged、跨格服装/光不一致、过锐、HDR、磨皮、卡通、CGI 游戏感、anime、除 1–6 外任何文字。
```

**校对清单**:真 6 格 2列×3行、细白边、右下角白色加粗 1–6;轴线没跨(6 格里 A 恒左望右、B 恒右望左);视线接得上(格1/2 过肩视线相对、格3/4 近景方向相反);过肩肩属对(格1 前景是 B 肩/右、格2 前景是 A 肩/左);6 格脸一致没串脸(串脸 MAX)、服装/光跨格一致;格5/6 虚化前景是对方且不抢焦、方位对;第三人只在背景阴影、近景没乱入;除 1–6 外零文字/水印。

**验收口径补充**:格3/4按模板就是“无前景的单人近景”，不能因缺少对方肩部而误判失败；只有格1/2要求明确越肩，格5/6要求对方作为边缘柔焦前景。若仅一格出错，优先裁出该格做局部编辑后贴回，不要重跑整张并破坏其余已正确机位。
