---
name: canvas-video-production-sop
description: 使用当前激活的 Acheng Director 创作，在真实画布上保存制作源稿、编译提示词并按授权生产媒体；提供画布执行与恢复适配。不用于工程开发。
---

# Acheng 画布制作入口

开始或恢复制作先读[适配核心](references/acheng-canvas-adapter.md)，解析当前激活的 Acheng Skill，并按本次缺项加载其专业模块。创作合同、完整提示词与 partial/commit 由 Acheng 维护；画布承担正式存储和授权执行。已有确认内容直接复用，七模块不是强制顺序阶段，也不默认启动多代理。

| 当前工作 | Acheng 模块 | 本次按需读取的画布参考 |
|---|---|---|
| 剧情、关系、伏笔 | story | 保存源稿、决定或切换工作区时读[工作台与布局](references/canvas-workspace.md) |
| 角色、场景、道具、关键帧；空间设计 | assets / scene-design | 登记图片参考、共享素材或生产图片时读[图片生产](references/canvas-image-production.md)；共享归属见[工作台](references/canvas-workspace.md) |
| 镜头与 Segment 规划 | shots | 规划 Segment 时读[Clip 规格与连续性](references/canvas-clip-production.md) |
| 表演、动作、特效与巨构 | performance / effects | 涉及 Segment 边界时读[连续性](references/canvas-clip-production.md#连续性边界) |
| 编译或局部返修 | model / continuity | [源稿编译与发布](references/canvas-compilation.md)，视频另读 Clip 参考，图片另读图片参考 |
| 准备节点、导航、共享资产 | 当前创作模块 | [工作台与布局](references/canvas-workspace.md) |
| 提交、跟踪或恢复媒体任务 | 当前创作模块 | [运行与恢复](references/canvas-production-runs.md)，加本次图片或 Clip 参考 |
| 更新引擎、离线导出 | 无新增创作模块 | [维护与离线工具](references/acheng-canvas-maintenance.md) |

仅提示词、单张试跑、指定片段或逐项确认沿用用户范围。生成须有用户授权；准备节点、编译和发布均不表示已生成。真实画布操作遵守[生产操作边界](../../rules/h3-production.md)，数据保护遵守[画布数据契约](../../rules/canvas-contracts.md)。

旧子 Skill 保留兼容路由。历史玩法和模板仅在用户确需该内容时按小节读取，不作为另一套创作流程或默认规格。
