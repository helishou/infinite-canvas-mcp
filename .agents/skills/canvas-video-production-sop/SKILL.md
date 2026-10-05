---
name: canvas-video-production-sop
description: 以本机 Acheng Director 七模块主导影视制作，适配画布正式数据、原生 MCP 生产、参考绑定、尾帧和 Motion Context；保留完整提示词，视频默认只做技术收口。不用于工程开发。
---

# Acheng 画布制作入口

创作与工作组织由 Acheng 决定，画布承担执行和正式存储。进入前完整读取 [Acheng 画布适配](references/acheng-canvas-adapter.md)，解析当前激活引擎；恢复时使用该运行固定版本。只按本次缺项读取 Acheng 专业模块，不重做已确认内容。

| 工作 | Acheng 模块 |
|---|---|
| 剧情、知情、关系、伏笔 | story |
| 风格母图、角色、场景、道具、关键帧依赖；空间设计 | assets / scene-design |
| 镜头、空间消费、机位、切镜、Segment 装箱 | shots |
| 表演与动作因果 | performance |
| 特效、巨构 | effects |
| 独立图像/H3 提示词、引用及编译门 | model |
| 连续性事件、原文恢复、提交与交付 | continuity |

以上是职责而非七个强制顺序阶段，也不默认启动多代理。旧子 Skill 仅保留执行入口，不能覆盖 Acheng 的创作合同。空间图按需设计，取消独立站位阶段和色卡前置。Shot/Segment/Clip 分工、风格母图与角色规格、字数策略统一见适配合同。

中文用户未指定其他语言时，导演对话与工作台可读的制作源稿默认简体中文；对白、歌词和画面内文字保持原语言。`prompt_description`、`state_description` 和最终 H3 正文等模型编译字段继续遵守 Acheng 合同，不能用英文编译文本替代中文角色说明、资产描述或镜头摘要。详细字段约定见适配合同。

持续制作时，按 Backend 正式 `workflow.currentWork` 和 readiness 投影报告当前模块、目标、依赖、待决定项与下一步。变更阶段时更新同一制作 workId，再用结构化 `site_navigate` 呈现；不要仅凭聊天中的“已完成”跳页。待用户选择的关键决定用 `workflow.pendingDecisions` 登记；用户明确选择后先持久化答复，再从绑定的源 revision 继续。画布生产仍依赖真实 run/task 与节点/Clip 映射。

只有用户授权生成时才调用原生画布工具。计划、提示词就绪、实际生成、媒体自检与用户验收严格分开。静帧冻结一个可见状态，声音和完整动作链归视频；输入改过而媒体未重生成时只能报告输入已更新。

用户授权多张图片时，资产图与关键帧按真实依赖并发推进：先提交授权范围内全部已就绪、互不依赖的目标，再统一跟踪各自 runId/taskId，不等一张完成或审核后才启动另一张无关图片。当前 Backend 单个 run 内逐项等待，因此新任务按适配合同的[图片并发调度](references/acheng-canvas-adapter.md#图片并发调度)建立不重叠的独立运行；执行器按既有容量排队。前置媒体未批准只阻塞其下游。仅提示词、单张试跑或用户明确要求逐项确认时保留原范围和节奏。

节点坐标由 Backend 持久化的整批布局编译计划统一分配。Skill 只登记正式目标及已知用途/关联，调用 `production_prepare_targets` 后检查顶层 `layoutReceipt`；不自行算坐标、不创建后补排。资产按用途分区，剧本按场次排列，镜头图片和提示词成组，H3 按物理节点去重；目标即使依赖未就绪也预留位置。已有节点位置与尺寸固定为锚点，布局只增量分配新目标。详见[制作画布布局](references/acheng-canvas-adapter.md#制作画布布局)。

Agent 只负责编译前的源稿与批准依赖。编译使用稳定 operationId 在后台执行，通过 `production_get_compilation` 读取短状态/诊断；成功应用编译包后，依据程序 `referenceSync` 回执继续。默认不读取或审核编译正文，不直接修改正式 Clip 的编译字段；调整必须回到源稿并重新编译。具体恢复与定向读取规则见适配合同。

制作工具返回 `status: blocked` 时，先处理 `preflight.diagnostics` 和 `nextActions`，不把工具检查完成描述为编译或生成完成；输入与状态未改变时不原样重试。编译和启动生成会自动预检，正式提交仍复核；完整阶段、幂等恢复及目标占用规则见适配合同。

导演工作台以正式 `workflow.currentWork` 和 `workflow/readiness.presentation` 为阶段与导航依据。新阶段沿用同一 workId 并调用结构化 `site_navigate`；待用户回答的问题登记为 `workflow.pendingDecisions`，绑定源哈希，收到明确答复后保存并继续。实际媒体运行须使用真实 runId、taskId 与节点/Clip映射，不能只依据助手消息或批次文字切页。

默认 Clip 完成条件是任务终态、媒体归档/可访问、活动结果绑定及 taskId/storageKey 可追溯；不增加默认质量检查或自动返修。用户限定仅提示词、单张试跑、指定镜头或逐项确认时按其范围执行。

## 维护归属

导演源码在项目 Git 子模块中独立开发、提交与推送；Canvas 兼容补丁在项目 scripts/acheng，本包维护适配和执行方法。更新先检查候选，成功后激活，不静默替换在途运行版本。不得重新引入旧一镜一 Clip、固定对话机位、无头服装格或前段成片自动输入。数据/节点保护仍遵守项目 AGENTS 与画布契约。
