---
name: canvas-video-action-camera
description: Acheng 画布适配的动作题材入口；使用 performance、effects 与 shots 模块与原生画布生产能力，不维护另一套创作流程。
---

# 动作题材

按[制作主入口](../../SKILL.md)读取适配核心，使用当前激活 Acheng 的 performance、effects 与 shots 模块；已有确认稿只补本次缺项。涉及攻击、格挡、闪避、缠绕、推拉、受击、挣脱或反制时，先实际读取 `acheng-performance-action` 的 `SKILL.md`，并按 `data/module-registry.json` 读取该模块登记的全部依赖；在依赖读完前不改制作源。父入口的路由说明不能替代子 Skill 的加载。

动作因果必须写入正式 Shot 的结构化 `combat` 字段，并让 H3 画面描述与该字段一致；只改 `visual` 或编译提示词不算完成。每镜核对画内角色、方向与轴线、受力链、攻应果续和速度阶段，按 performance 模块回包合同记录 `patch/evidence/unresolved`。具体字段遵循 40-action-choreography 与 91-module-orchestration，不在本入口复制第二套动作格式。

创作按已确认剧情和 ShotSpec 补齐本次动作、视效与镜头缺项；涉及 Segment 边界时读[连续性](../../references/canvas-clip-production.md#连续性边界)。历史动作玩法不作为默认创作合同。
