---
name: canvas-video-shot-design
description: Acheng 画布适配的镜头与 Segment 规划入口；使用 shots 模块与原生画布生产能力，不维护另一套创作流程。
---

# 镜头与 Segment 规划

按[制作主入口](../../SKILL.md)读取适配核心，使用当前激活 Acheng 的 shots 模块；已有确认稿只补本次缺项。通用执行规则沿用主入口，不在本子技能重复。

规划 Segment 时读[Clip 规格与连续性](../../references/canvas-clip-production.md)；准备场次节点时读[工作台与布局](../../references/canvas-workspace.md#制作画布布局)。

Segment 划分完成后，逐对处理所有相邻 Clip 边界：为每一对 `from → to` 调用 `set_director_boundary`，明确填写 `tailFrame`、`motionContext` 和具体 `reason`。分段操作自动产生的关闭值或“需要显式复核”占位理由不算已评估。写入后回读 `runtime.boundaries`，确认边界数量等于 Clip 数减一、顺序与实际相邻 Clip 一致且无重复/缺失；再核对各前段的 H3 开关投影一致，最后一段无出边。判断标准沿用[Clip 规格与连续性](../../references/canvas-clip-production.md)，不因同场景或同角色自动开启续接。
