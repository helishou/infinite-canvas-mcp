---
name: canvas-video-production-sop
description: >
  在无限画布中统筹 AI 短片生产，并按当前阶段路由到剧情设计、资产准备、站位与色彩基准、镜头设计、分镜关键帧或 Clip 视频子 Skill；Clip 视频生成默认只做技术性收口，质量验收仅按用户明确要求执行。适用于短片全流程规划、接续已有项目或执行某一生产阶段；不用于项目工程开发。
---

# 无限画布短片生产总控

## 职责

本 Skill 是项目级约束与阶段索引，不承载各阶段的全部操作细节。生产流程为：

`剧情设计 →（资产准备 + 站位与色彩基准）→ 镜头设计 → 分镜关键帧 → Clip 视频`

资产准备与站位/色彩基准可并行准备，但二者都达到本项目所需的完成条件后，才进入镜头设计与生成。

## 阶段路由

先根据用户当前请求、画布现状和已验收记录判断阶段，再完整读取对应子 Skill。只加载当前阶段；仅在输入缺失时补读直接上游，不要一次读取全部子 Skill。

| 阶段 | 何时进入 | 子 Skill | 完成标志 |
|---|---|---|---|
| 剧情设计 | 只有故事、小说、剧本或需要重排段落 | [剧情设计](subskills/canvas-video-story-design/SKILL.md) | 生产简报、剧情段与连续状态已明确 |
| 资产准备 | 缺角色、场景、道具锚或参考职责不清 | [资产准备](subskills/canvas-video-asset-preparation/SKILL.md) | 本轮需要的资产与版本可被精确引用 |
| 站位与色彩基准 | 缺色卡、空间拓扑、轴线或站位覆盖 | [站位与色彩基准](subskills/canvas-video-staging-color/SKILL.md) | 色彩真值、空间锚和站位覆盖已确认 |
| 镜头设计 | 需要拆镜、设计过渡、动作与声音 | [镜头设计](subskills/canvas-video-shot-design/SKILL.md) | 镜头表和逐镜参考计划可执行 |
| 分镜关键帧 | 文字分镜表判定某镜需要新图，或需要检查、重做静态分镜图 | [分镜关键帧](subskills/canvas-video-storyboard-frames/SKILL.md) | 需要的关键帧已验收，跳过镜头有明确依据 |
| Clip 视频 | 需要编写 H3 提示词，或生成、检查、返修分段视频 | [Clip 视频](subskills/canvas-video-clip-production/SKILL.md) | 默认完成任务终态、媒体落库/可访问性及 `taskId`/`storageKey` 记录；只有用户要求质量验收时才以验收及承接作为完成条件 |

**题材叠加层**（不是阶段）：用户点名打斗 / 动作戏 / 元素对轰 / 召唤 / 长镜头 / 赛车追车时，在当前阶段之上叠加读取 [动作片题材](subskills/canvas-video-action-camera/SKILL.md)。它的触发关键词、加载顺序与冲突裁决都在那份文件里；跨阶段通用规则的真值在 `references/action-camera-principles.md`，题材玩法在 `references/action-camera-playbook.md`，**按小节名引用、不通读**。叠加层不新增阶段、不改变阶段顺序、不改变 Clip 默认只做技术性收口的口径。题材密度与 `references/prevention-by-construction.md` §四 的 H3 段内镜数预算冲突时，预算为默认路径，越界需用户显式授权并在 `storyboard.md` 记风险。

用户明确指定阶段时直接进入该阶段；不要因为总流程存在就重做已获批上游。若当前阶段的硬输入缺失，停在最早的缺失项并说明缺什么。用户只要求规划、检查、连线、写提示词或试跑一张时，不得自动跨到生成、批量运行或下一阶段。

验收不是独立阶段。每个子 Skill 必须完成本阶段所需的证据回读和状态记录；Clip 视频生成后默认只做技术性收口，不主动检查或验收媒体质量、不评分、不返修、不要求用户确认。只有用户明确要求时才执行 Clip 质量检查、返修或逐项确认。其他阶段仍按各自子 Skill 的验收要求执行；若用户要求逐项确认，自检通过后仍停在当前阶段等待用户，不能把自检自动升级为用户确认。

文字分镜表逐镜判断是否需要新关键帧，并默认一个文字分镜对应一个 H3 Clip。只有两镜存在明显动作衔接，或对白/画外音需要跨镜连续时才合并成一个 Clip；同场景、同人物、机位接近本身不足以作为合并理由。分镜图有序组只包含实际采用的图片，不要求与文字镜头一一对应。

提交多段 H3 视频前，逐一判定相邻 Clip 是否需要潜空间续写，并在 Clip 计划中记录每个边界的结论、理由与连续组范围；按 [Clip 视频](subskills/canvas-video-clip-production/SKILL.md) 的生成前续写判定执行。这个判定只依据已确认的分镜、首末状态和输入，不触发生成后画面或声音检查。

## SOP 维护路由

外部指令提到“写入 SOP Skill”“补充短片生产 SOP”或直接指向 `canvas-video-production-sop` 时，将其理解为写入本 Skill 包，不等于把内容追加到主 `SKILL.md`。先按功能归类，再写入上表对应的子 Skill：

- 单一阶段的操作方法、闸门、模板、故障经验或验收规则，只写入该阶段子 Skill。
- 同时涉及多个阶段的要求，按职责拆开分别写入对应子 Skill；主 Skill 只保留必要的路由关系、阶段先后和真正跨阶段的不变量。
- 阶段真正需要的外部规范片段直接整理进对应子 Skill，不能用“完整读取某份大规范”代替阶段说明。只有确实共用且不宜拆散的资料才放入 `references/`；引用时必须指定章节或检索标题，不得要求无差别通读全文。
- 从外部规范提取时只迁移会改变生产决策的技术规则，不迁移作者声明、水印要求、推广文案或与本 SOP 无关的固定输出前缀，除非用户明确要求保留。
- 只有新增阶段、改变阶段入口/完成条件、改变全流程状态语义，或增加跨阶段项目级硬约束时，才修改主 `SKILL.md`。
- 写入前完整读取目标子 Skill，沿用其边界和结构；若现有阶段都无法承载一个稳定、独立的功能，才新建子 Skill，并同步更新阶段索引或功能索引。

不得因为外部指令使用了“SOP Skill”这一笼统名称，就把阶段细则重新堆回主 Skill。主 Skill 保持为项目约束和索引，子 Skill 才是功能规则的权威来源。

## 项目级不变量

### 授权与状态

- 始终区分 `已规划`、`已准备`、`已生成`、`已自检`、`已验收`；任务成功不等于视觉验收，模型自检不等于用户验收。
- 用户要求“先检查”“不要运行”“只跑一张”“每张确认”或限定镜头范围时，严格停在相应闸门。
- 用户已授权连续或批量制作时，可在明确的镜头、模型、预算和验收规则内继续；扩大范围、增加成本或改变创作基准前必须重新确认。
- 同一问题连续失败两次后停止盲目重跑，回查提示词、参考职责、模型路由和实际日志。

### 画布真值与可追溯性

- 任何写入前先读取当前 MCP schema 或项目封装；不沿用旧脚本字段猜测。
- 节点、任务、媒体与 revision 以实际返回的 `nodeId`、`taskId`、`storageKey`、`revision` 为准；标题、预计 ID、请求成功或节点状态回显不能替代真实结果。
- **不要凭记忆填 ID。** `nodeId` / `segmentId` / `taskId` / `Picture N` / `binding.id` / `assetId` 一律先从本轮真实返回里取；过期会话记下的 ID 几乎必然 `NODE_NOT_FOUND` / `SEGMENT_NOT_FOUND` / `TASK_NOT_FOUND`。本轮已经回读过就复用结果，不必重复读。
- **报错后必须回读，不要猜新 ID 再撞一次。** 拿到 `CANVAS_TOOL_FAILED` 先读 `message`，再回读对应对象（`h3_get_node` / `canvas_inspect` / `canvas_task_status`），确认现状后重试一次。同一操作连续失败两次就停下来核对日志，不要第三次盲试。
- **`status` 等后台维护字段不写进 patch。** `h3_update_clip` / `h3_apply_video_plan` / `h3_prepare_clip` 传 `status` 会直接被拒（"字段 status 由后台任务维护"）；`metadata` 必须在 patch 里用独立增量字段，不能整体覆盖。配置节点须在 metadata 顶层写 `model`，否则静默跳过不建任务。
- **只读探查优先用小返回工具。** 按成本从低到高：`h3_get_node`（约 0.5 KB）→ `canvas_get_state` / `canvas_inspect`（节点目录，量级几 KB）→ `h3_get_clip_references` / `h3_get_clip_prompt`（按需单项）。已被服务端的 `TOOL_PAYLOAD_HOTSPOT` 点名的 `canvas_export_snapshot`、`assets_list` 无过滤裸调禁止使用；`canvas_get_state` 在大画布（大画布曾实测 2,231,095 字符）过期时先尝试目录模式。
- **不要在不在线的界面前调用需要网页的工具。** `site_navigate`、`workbench_image_get_config` / `workbench_image_generate`、`workbench_video_*`、`canvas_get_selection` 依赖已连接的网页会话；无头/未开页面时必然返回 `当前没有已连接网页`。改用等价的 Backend 工具（`canvas_inspect`、`canvas_list_projects`、`models_list`）。
- **工具集改版后不要沿用旧工具名。** 已从 schema 移除的工具（如 `h3_prepare_clip`）调用必然 `CANVAS_TOOL_FAILED`。调不通的工具先确认它还在当前 MCP schema 里。
- 同名节点必须按精确 ID 操作。所有提交都保存实际任务 ID，并按该 ID 有界等待或查询；等待异常时查询原任务，不重复提交。
- `referenceNodeIds`、连线和提示词中的 `Image N` 只是声明。生成后必须从 generation log 的 `references_json`、`input_counts_json` 与实际 provider/workflow 输入确认参考真的传入。`referenceNodeIds` 常失效，参考要接上就用 `canvas_connect_nodes` 补；多图 character 节点先生成 `canvas_image_input_manifest` 选图，否则多参考会互相稀释权重。
- **生图前确认所选模型支持当前输入形态。** 服务端会直接拒"模型「X」不支持单图输入"这类 400；看到这个就换模型或增减参考数，不要重试同一组合。
- `metadata.smart=true` 时，以 `metadata.generationMode` 判断当前语义类型；不能因顶层 `type: "config"` 而跳过图片节点。

### 节点与布局保护

- 智能节点重生成必须复用原节点 ID 和结果槽，采用原位写回；生成更新不得改变 `position`、`x/y`、`width/height` 或 `layout`。
- 当前视口看不到、标题相似、无连线或媒体未显示，都不足以证明节点丢失。先按精确 ID 回读类型、状态、媒体、坐标、隐藏/删除字段和操作历史。
- 删除或清理前建立保护白名单与精确作废 ID 集合；共享资产、已批准基准和其他版本不得被模糊批量删除。

### 静帧与视频职责分离

- 静态图只冻结一个可见状态；台词正文、语气、停顿、呼吸、音效、BGM 与完整动作链保留给镜头表和视频提示词。
- H3 视频提示词使用官方 `h3-prompt-writing`；视频生成使用 `generate-video` 或项目已有 H3 能力。
- 静帧阶段所需的 Neo Image 和角色/场景提示词规则已经内嵌在对应子 Skill 中，执行常规流程时不要再完整读取两份大规范。仅当用户要求现有子 Skill 未覆盖的特殊图型时，才按精确标题局部查阅 [Neo Image 图型库](references/neoimage-prompt-engine-公开版.md)；角色或场景遇到未覆盖结构时同理局部查阅 [角色资产与场景生成规范](references/角色资产与场景生成-即梦5或MJ.md)。

## 固定制作目录

每个画布项目的制作文档固定放在 `{当前 Backend dataDir}/productions/<canvasProjectId>/`。先通过 Backend 的 `GET /data-dir` 或实际运行配置取得 `dataDir`，不要从仓库位置、Skill 目录或当前终端环境猜路径。使用精确画布项目 ID 作为单级目录名，创建前确认解析后的路径仍位于 `productions` 内；项目标题只写进文件，不用作目录名。

```text
productions/<canvasProjectId>/
├── progress.md     # 阶段摘要、关键 ID、授权边界和下一步
├── rework-log.md   # 问题、返修原因、尝试次数、前后任务与验收
├── script.md       # 剧本及逐字台词
├── storyboard.md   # 文字版分镜表与镜头过渡
└── assets.md       # 角色、场景、道具、色卡和站位的引用索引
```

首次使用时，从本 Skill 的 [进度](assets/production-progress-template.md)、[返修日志](assets/rework-log-template.md)、[剧本](assets/script-template.md)、[文字分镜表](assets/storyboard-template.md) 和 [资产索引](assets/asset-register-template.md) 模板创建缺失文件；已有文件先读取，绝不按模板覆盖。没有画布项目 ID 时先记录本轮计划，待项目建立后再创建对应目录。已存在旧“短片制作进度”画布文本节点时，先读取并核对，再将可确认的状态并入 `progress.md`，保留原节点。

`script.md` 与 `storyboard.md` 分别是剧本和文字分镜表的当前版本；用户批准后若要大改，先复制为同目录的 `script.<旧版本>.md` 或 `storyboard.<旧版本>.md`，再更新固定文件名及 `progress.md` 中的版本。画布有序组只收纳分镜图，`progress.md` 记录其精确组 ID；可视分镜图顺序从该组的 `metadata.groupSlots` 回读。画布节点、任务、生成记录和媒体以 Backend 为准；`assets.md` 记录 nodeId、assetId 与 storageKey，不复制图片和视频到制作目录。

## 进度更新与恢复

1. 开始或恢复制作时先读取该项目的 `progress.md`，再读取当前阶段需要的 `script.md`、`storyboard.md` 或 `assets.md`；文字镜头计划以 `storyboard.md` 为准，可视分镜图通过记录的组 ID 和 `metadata.groupSlots` 回读，再核对任务日志。
2. 确定本轮范围后，在 `progress.md` 记录阶段状态、已验收/目标数、关键资产/画布/节点/分镜组 ID、在途 taskId、当前阶段结论和下一项可执行动作。没有真实结果的字段写“待生成/待核对”。`progress.md` 保持摘要，不逐项展开返修原因、重试次数和日志细节；具体问题与每次尝试写入 `rework-log.md`，进度文件只保留指向该日志的简短索引。
3. 每个返修问题在 `rework-log.md` 使用稳定镜头/Clip/资产 ID 建立条目，并记录问题、证据原因、改动内容、尝试次数、前后 taskId/storageKey、独立验收结论和下一动作。H3 一次 `canvas-h3-run` 父任务计一次尝试；它的 ComfyUI 子任务属于同一次尝试，不得重复计数。任务成功不等于质量验收通过。
4. 阶段产物、任务终态、验收或返修结论、用户授权范围发生变化，或本轮暂停/结束时，更新受影响的文件并回读确认。任务轮询无变化时不重复写入。
5. 恢复在途任务时先查原 taskId 的终态，不重提生成。若记录的分镜图组 ID 不存在、组不是有序组或成员顺序无法确认，先核实画布，不凭组标题或屏幕位置重建图片顺序。文字分镜表与可视分镜图不一致时保留两边，按最新用户决定核对后修正；不得静默覆盖已批准剧本或分镜内容。

阶段状态用 `未开始 / 进行中 / 待用户确认 / 需返修 / 已验收 / 受阻`。Clip 默认记录任务终态、媒体可访问性和精确 `taskId`/`storageKey`；只有用户要求质量验收时，才为逐 Clip 使用 `accepted / needs-redo / waiting-user / blocked-upstream`。关键帧目标数只统计文字分镜表中策略为“新生成”的镜头。`progress.md` 只写状态与证据索引，不复制完整 prompt、凭据、大段日志或逐条返修史；具体返修追踪统一放在 `rework-log.md`。

## 通用执行节奏

- 画布任务可拆成互不依赖的只读调查、资料准备或独立审查时，可并行委派子代理；委派说明要给出画布项目 ID、精确节点/任务范围、只读或可写权限、交付格式和停止条件。模型可按子任务难度选择较轻量的可用模型（例如 gpt-6-luna），但需由主代理统一核对结果。
- 同一画布项目内的写操作通常共享 revision，且节点、连线、视口和任务状态会互相影响；所有写操作由主代理串行安排。修改前读取目标的最新状态，提交后核对写入结果，再执行依赖它的下一步；工具本身已返回更新后的目标字段时，不重复拉取完整节点。不得让子代理并行写同一项目，也不得仅凭代理各自的成功回执假定合并安全。
- 已知 H3 `nodeId`/`segmentId` 时优先用 `h3_get_clip` 的 `include` 一次取齐本次需要的提示词、参考与运行参数；只需片段目录时用 `h3_get_node`。避免为每段反复调用 `canvas_get_state(nodeIds=[H3节点])`，也避免把同一片段的提示词、参考、运行参数拆成多次读取。互不依赖的只读查询可并行；同一画布写入仍串行。多段简单配置改动可先从一次快照准备，逐段提交成功后在末尾集中回读字段核对；若用户同时编辑目标字段，逐段重新定向读取并在冲突后重算补丁。
- 可并行准备后续操作方案，但必须等依赖的上游写入及验收完成后再提交。若操作被证明作用于彼此隔离且无共同 revision/状态依赖的独立画布项目，可分别安排写入；共享项目状态或边界不明确时按串行处理。
- 已确认且互不依赖的项目可保持 1–3 个任务在途；依赖上游结果的任务必须等待上游通过相应阶段门禁（Clip 默认只做技术性收口）。
- 等待慢任务时可准备后续 brief、prompt、参考映射和验收清单，但未满足阶段入口条件的生成不得提前提交。
- 批量操作报错按“可能部分成功”处理，逐项回读后只补缺项，不盲目整批重试。
- 任何空 notification、异常退出或信息不足，先回读画布、任务状态、generation log 和数据库，再判断失败。

## 流程结束

目标 Clip 全部完成技术性收口后，直接向用户汇总版本、顺序、实际时长、素材位置和未决技术问题；默认不做媒体质量验收。只有用户明确要求质量检查时，才汇总检查结论，并区分已验收、候选、旧版本和待返修项。这只是当前任务的结果摘要，不新增任何阶段或子 Skill。用户另行要求拼接、导出或打包时，把它作为明确的新操作处理，不自动扩展流程。
