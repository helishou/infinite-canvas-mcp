# 动作片题材玩法库

> 只在用户点名打斗 / 动作戏 / 元素对轰 / 召唤 / 长镜头 / 赛车追车时使用，入口见 `subskills/canvas-video-action-camera/SKILL.md`。
> 跨阶段通用规则（镜头逻辑、几何、表情、布料、切点、反雷同）在 `action-camera-principles.md`，不在这。
> **按小节名引用，不通读全文。**

## (a) 分支：两轴各自点名，不设默认

用户没说哪一轴就问，别替他选。两轴独立可叠加（「长镜头的元素对轰」合法）。

### 内容轴（打什么）

| 分支 | 规则要点 | 写进 `storyboard.md` |
|---|---|---|
| **徒手对打** | 每一击三段齐全：起势（重心沉、肩先转、拉到极限位置）→ 挥满（走完整条弧线）→ 过身（收势直接连成下一击起势）。力度写在身体上，不写副词 | 逐镜记三段是否齐全 |
| **元素对轰 / 技能对打** | 双方远程技能在半空对撞，两人从不用身体碰对方；技能是法阵 / 符文，**禁动物形态**；母题「谁都没吃到一击」 | 逐镜记对撞点与其变体 |
| **法术召唤** | 召唤物是「放大的本人」不是另一个物种：半透明灵体、极端仰拍、夸张透视；慢慢凝结，不是「啪」一下；消散由本体被打断触发 | 逐镜记凝结 / 打断时刻 |

### 剪辑轴（怎么剪）

| 分支 | 规则要点 |
|---|---|
| **快剪流** | 每 1–1.5s 一刀，切点落在动作中间；用「三镜头法」处理决定性一击 |
| **长镜头流** | 单镜 4–12s 不切；运镜本身是主角。Clip 按适配合同的镜头与事件安全边界装箱，本轴只改镜内运镜与节拍 |

段边界 `CONTINUE` / `CUT` / `END` 照 `prevention-by-construction.md` §三 写。

## (b) 镜头语言库

按这一镜的蒙太奇接点挑，**逐镜不同**——相邻镜的景别与机位不同，同时是防融合防线之一。

| 手法 | 什么时候用 | 英文句式 |
|---|---|---|
| 希区柯克变焦 | 大远景造压迫、空间扭曲 | `the camera dollies back while zooming in, the background stretching away` |
| 低角度仰拍 | 造压迫感与体量 | `low-angle shot looking up at the figure, dramatic sky behind them` |
| 快速摇摄 | 转场、表现能量 | `the camera whip-pans to the right, motion blur streaking across the frame` |
| 快速变焦 | 强调一个细节 | `the camera crash-zooms into the detail` |
| 跟踪 / 侧向跟拍 | 保持主体在画面里 | `the camera tracks alongside the fighter, keeping him in frame` |
| 升降镜头 | 交代战场尺度 | `the camera cranes up, revealing the full scale of the battlefield` |
| 弧形镜头 | 揭示侧面与两人关系 | `the camera arcs around the fighter, revealing his profile` |
| 夸张透视后拉 | 交代大位移与体量 | `the camera pulls back rapidly while keeping the figure centered, the space stretching open around it` |
| 第一人称 FOV | 冲刺、坠落、闪避 | `a first-person viewpoint hurtling forward, the edges of the frame warping with the speed` |
| 手持 | 默认；随动作迟滞、受击被撞一下 | `handheld, shaking with the impact` |
| 荷兰角 | 不安与失控 | `the camera tilts at a dutch angle, creating unease` |
| 运动镜头 | 空间转换的交代镜 | `the camera tilts up from the deck to the sky, following the fighters as they rise` |

**环绕不是稳定器语言**：禁 `slowly arcing` / `slow orbit`（隐性慢动作），半径与高度逐镜不同，留 1–2 镜不环绕做对比。

**动作蒙太奇 5 种**：`Cutting on Action`（默认必用）· 三镜头法（启动→爆发→结果，镜 2 必须清晰显示打中真的发生、不被身体遮挡）· 十字景框（重要元素留在画面中心）· 视觉重叠（同动作冗余帧，强调更快更狠）· 节奏性断层（只留起点与终点）。

## (c) 长镜头运镜节拍（长镜头流专用）

每镜写一条节拍序列并落时间码：几次加速、几次反向、几次贴地掠过、几次拉升。**节拍不许全程同一种**。

**四段式穿梭为标准骨架**：贴地掠过 → 拉起升空 → 穿越地形 → 回到原场地。

**三维锚点**：镜头飞出去后必须飞回那片场地，列锚点清单（地面 / 建筑 / 界线），不许无参照物的空旷滑行。**重力错位**：镜头沿光轴滚转 90° 用于翻转重力感。

**大位移的量法**：不要沿途数建筑——加速度大到镜头跟不住，人本来就该看不见。写法：整个身体拉成一道连续运动模糊 → 不到三分之一秒画面里已经没有他 → 镜头后拉，远处出现很小的人影。必须写明「是一道拉糊的线，不是叠加的重影」，否则撞残影配额。

**分离后「不动的一方」写成显式动作**：甩脱 / 击飞 / 坠落后留在空中或原地的那方，模型默认让重力接管——必须写 `stays exactly where she is, not falling` 这类显式声明。

**禁游戏视角加严**：跟随类镜头逐镜回答「这一镜自己的电影机位逻辑是什么（方位 + 高度 + 为什么是这里）」，答不上来的镜一律重选（判据见 `action-camera-principles.md` §三）。

## (d) 冲击感三件套

用户点名打击感 / 重击 / 大开大合时用；普通对打不必全套。

1. **命中单帧静止**——画面冻结而非打斗冻结（`the impact holds for a single frame`），下一拍储存的力立刻释放；全片 2–3 次；那一帧音效完全静音（静对比出冲击）。合法节点只选三个：**巨大伤害 / 差点命中 / 完美防御**。
2. **冲击的物理反馈**——不写「很痛」，写被打的东西发生了什么：

   ```text
   driving his own forearms back against his chest
   his torso folds over the fist, both feet ploughing two lines through the leaf litter
   the bamboo shivers and leaves sprinkle down from its tip
   the wind of it flattening his hair sideways
   ```

3. **镜头受击微震**——`jolting at each impact`，写进风格总纲一句，逐镜不复述。

用户点名「冲击帧 / 黑白爆闪 / impact flash」时另加一处**整幅曝光闪**（黑 → 白 → 回落），挂全片最重的一击，并逐镜加禁闪声明防模型到处加闪。

**慢动作**：只落在上面那三个合法节点，写成镜内 `speed ramp`（不切；切到慢素材 = 剪辑断点），并落时间码与倍率。隐性慢动作同样禁：长静止、缓慢推近 / 环绕、「气氛凝固」。

## (e) 招式来源可考（自查用，不写进 prompt）

每个主导动作要能对应一条可复现思路：连击因果链 · 单帧余韵 · 长镜头思维 · 中心构图+急停 · 轴心自由变 · 大开大合低张数 · 调色残影 · 环境交互。

**出处不写进分镜**，只用于查「是不是整片一招重复」。

## (f) 建议区间（不是禁令）

以下数字写进 `storyboard.md` 时**必须标注为建议**，不得写成验收门槛：

- 快剪流每 1–1.5s 一刀
- 每镜至少 3 种运镜且逐镜不同
- 招式族不重复
- 徒手每一击走满弧线三段

**冲突处理**：这些与 `prevention-by-construction.md` §四 的 H3 段内镜数预算（7 秒段 ≤3 镜、每镜 ≥2.0s）冲突时，**预算是默认路径**，按 `canvas-video-action-camera` 的「冲突处理」三步走，不静默合并或拆分镜头。
