---
name: canvas-video-production-sop
description: 使用当前激活的 Acheng Director 创作，在真实画布上保存制作源稿、编译提示词并按授权生产媒体；提供画布执行与恢复适配。不用于工程开发。
---

# Acheng 画布制作入口

开始或恢复制作先读[适配核心](references/acheng-canvas-adapter.md)，解析当前激活的 Acheng Skill，并按本次缺项加载其专业模块。创作合同、完整提示词与 partial/commit 由 Acheng 维护；画布承担正式存储和授权执行。已有确认内容直接复用，七模块不是强制顺序阶段，也不默认启动多代理。

当本轮需要角色身份图时，先在“角色与素材”工作区生成或绑定必需图片，再开始依赖这些身份的镜头制作；只阻止实际消费缺失素材的目标。用户明确要求浏览器操作时，沿制作台页面操作，不切换到 MCP 或 Director Agent 执行同一生产任务。

续做或生产 H3 分集前，按目标 Shots 的 `scene_id`/`source_scene_id` 汇总实际使用场景，并逐一核对场景图闭环：正式 `asset_plan` 与 `asset_cards`、真实成功归档的图片媒体、`director.assets` 的 storageKey/sha256、对应场景 Subject 的图片绑定、Shot 的 `subject_usages`。场景文字登记或 `type=scene` 实体节点都不算场景图；单独生成了图、但没有绑定到 Shot 的图也不会进入 H3。默认先复用有效的正式场景图；缺失时补建场景资产并在用户授权后生成，再重编并应用受影响的 Clip。只有用户明确选择纯文字环境描述时才跳过图像锚点。场景图提示词要保留正式场景登记中的空间关系与稳定固定陈设，排除人物和临时剧情道具。加入新图不会授权重生成已有视频。

新合同常规返修使用目标工作包读取和一次结构化编辑，由 Backend 自动校验、编译与同步；H3 编译前按[镜头画面、连续性与提示词可执行性复核 SOP](../../acheng-director/references/120-precompile-shot-visibility-audit.md)复核并优化目标 Shot 的正式源字段，具体操作和兼容分支仅维护在[源稿编译与发布](references/canvas-compilation.md)。不手工维护正式 Prompt，不因页面改版迁移旧稿。

所有最终 H3 编译提示词在生成前都必须经过已配置的翻译 LLM；镜头描述和指令转为英文并轻度润色，对白、歌词及明确引用的画面文字保留原语言（可含中文）。人工流程使用场次页的翻译按钮，MCP/Agent 流程使用 `production_translate_compiled_prompts`；跳过 SHA-256 缓存命中项，其余提示词按顺序每批最多 3 个请求模型，全部完成后一次写回。编译未通过或翻译未完成时不得提交对应 Clip 生成。

批量制作与返修按变化影响范围推进：[编译参考](references/canvas-compilation.md#批次复核与回执复用)规定目标级编译、复核和回执复用，[运行参考](references/canvas-production-runs.md#目标清单与失败恢复)规定依赖调度、完成判定与定点恢复。先读短状态确定缺项，批量提交已授权且 ready 的独立目标，连续组按 Clip 参考执行；不把恢复变成整项目重新创作、检查或生成。对话以画布源稿为准，只展开发生变化或报错的目标内容。

制作过程中发现问题时，立即按[问题自动记录](references/agent-problem-log.md)记入当前制作项目根目录的 `.agentproblem/问题记录.md`；返修沿原问题追加，不另建重复项。记录问题不扩大生成授权，也不替代画布中的正式制作数据。

| 当前工作 | Acheng 模块 | 本次按需读取的画布参考 |
|---|---|---|
| 剧情、关系、伏笔 | story | 保存源稿、决定或切换工作区时读[工作台与布局](references/canvas-workspace.md) |
| 角色、场景、道具、关键帧；空间设计 | assets / scene-design | 登记图片参考、共享素材或生产图片时读[图片生产](references/canvas-image-production.md)；共享归属见[工作台](references/canvas-workspace.md) |
| 镜头与 Segment 规划 | shots | 规划 Segment 时读[Clip 规格与连续性](references/canvas-clip-production.md) |
| 表演、动作、特效与巨构 | performance / effects | 涉及 Segment 边界时读[连续性](references/canvas-clip-production.md#连续性边界) |
| 编译或局部返修 | model / continuity | [镜头画面、连续性与提示词可执行性复核](../../acheng-director/references/120-precompile-shot-visibility-audit.md)、[源稿编译与发布](references/canvas-compilation.md)，视频另读 Clip 参考，图片另读图片参考 |
| 准备节点、导航、共享资产 | 当前创作模块 | [工作台与布局](references/canvas-workspace.md) |
| 提交、跟踪或恢复媒体任务 | 当前创作模块 | [运行与恢复](references/canvas-production-runs.md)，加本次图片或 Clip 参考 |
| 制作中发现问题或返修 | 当前创作模块 | [问题自动记录](references/agent-problem-log.md) |
| 更新引擎、离线导出 | 无新增创作模块 | [维护与离线工具](references/acheng-canvas-maintenance.md) |

仅提示词、单张试跑、指定片段或逐项确认沿用用户范围。生成须有用户授权；准备节点、编译和发布均不表示已生成。真实画布操作遵守[生产操作边界](../../rules/h3-production.md)，数据保护遵守[画布数据契约](../../rules/canvas-contracts.md)。

旧子 Skill 保留兼容路由。历史玩法和模板仅在用户确需该内容时按小节读取，不作为另一套创作流程或默认规格。
