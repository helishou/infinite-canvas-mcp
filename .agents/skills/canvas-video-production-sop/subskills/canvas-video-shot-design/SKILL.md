---
name: canvas-video-shot-design
description: Acheng 画布适配的镜头与 Segment 规划入口；使用 shots 模块与原生画布生产能力，不维护另一套创作流程。
---

# 镜头与 Segment 规划

按[制作主入口](../../SKILL.md)读取适配核心，使用当前激活 Acheng 的 shots 模块；已有确认稿只补本次缺项。通用执行规则沿用主入口，不在本子技能重复。

当用户要求继续剧目、但本轮镜头设计尚未完成，或明确反馈摄影、节奏、画面表现不足时，先做目标范围的完整镜头设计，再编译或提交媒体。读取当前激活的 shots 模块，并按该模块读取 20 镜头编译核心合同与适用的[摄影决策](../../../acheng-director/references/decisions/shots.md)；不能把本入口当作只处理 Segment 边界的路由，也不能以 120 可见性审计代替创作设计。

逐镜写清观看重点、可见动作的起点/转折/落点、构图层次与轴线、景别/机位、运镜或有意静止、焦点变化、起幅/落幅以及对白与动作帧窗；回看相邻镜头，设计视点、景别和运动的节奏变化，并说明每个运动为何由动作或情绪推动。对每个相邻 Shot/Clip 边界，必须调用 Acheng `shots` 模块的跨镜动作桥接检查，核对前镜尾态、后镜初态，以及姿态/位置变化是否在画内有动作过程和足够帧窗；不能只做抽象的视点、节奏复核。桥接未完成时先修 Shot 调度，再进入 120 复核和 Segment 规划。保持摄影有明确意图，不追求每镜复杂或强行制造多样性。把结果直接写入正式 shots[] 源字段；源稿设计未完成时不得开始或恢复相关目标的媒体生成。

规划 Segment 时读[Clip 规格与连续性](../../references/canvas-clip-production.md)；准备场次节点时读[工作台与布局](../../references/canvas-workspace.md#制作画布布局)。

Segment 划分完成后，逐对处理所有相邻 Clip 边界：为每一对 `from → to` 调用 `set_director_boundary`，明确填写 `tailFrame`、`motionContext` 和具体 `reason`。分段操作自动产生的关闭值或“需要显式复核”占位理由不算已评估。写入后回读 `runtime.boundaries`，确认边界数量等于 Clip 数减一、顺序与实际相邻 Clip 一致且无重复/缺失；再核对各前段的 H3 开关投影一致，最后一段无出边。判断标准沿用[Clip 规格与连续性](../../references/canvas-clip-production.md)，不因同场景或同角色自动开启续接。
