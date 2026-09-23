---
name: canvas-video-clip-production
description: 把已确认镜头与关键帧转为 MiniMax H3 等分段视频提示词和可追溯 Clip 任务，管理参考槽、动作与声音承接；用于 Clip 视频阶段，不负责静态资产建档。
---

# Clip 视频

开始前读取制作目录的文字分镜表 `storyboard.md`，按 Clip 编组确定每段覆盖的连续镜头；再从 `progress.md` 取得分镜图有序组 ID，按组的 `metadata.groupSlots` 核对实际采用的关键帧。文字镜头与图片不要求一一对应。

## 依赖技能

编写 H3 提示词时使用 `h3-prompt-writer`，遵守对应模式和 `<Picture N>` / `<Subject N>` 引用规则。运行图生视频或 H3 时使用 `generate-video` 或项目现有 H3 能力。若任务要求 Motion Context 连续分段，再使用对应的 H3 连续链能力；不要默认隐式继承。

## H3 提示词写作要求

将项目内的 [h3-prompt-enhancer](references/h3-prompt-enhancer/SKILL.md) 作为提示词工程参考，`h3-prompt-writer` 的官方格式仍是唯一格式权威。以下规则用于构思与核对 Clip 提示词：

- **先按实际输入建立 manifest**：图片、视频、音频分别按实际绑定顺序编号为 `<Picture N>`、`<Video N>`、`<Audio N>`。角色主体用独立的 `<Subject N>` 编号，并显式映射到角色来源图片；Subject 编号独立于 Picture 编号。提示词引用、参考槽与 manifest 必须一致，不推测缺失素材，不擅自重编号。
- **按 H3 模式组织提示词**：Ref2VA 使用官方六段式，普通参考图不自动写成 0 秒首帧；I2VA 从 Picture 1 的 0 秒首帧向后发展；FL2VA 锚定首尾图并描述连续路径；L2VA 收敛到末帧；T2VA 不引用图片/视频/音频标签。首尾帧对齐句、字段名和段落顺序遵守 `h3-prompt-writer` 对应模式规范。
- **时间线与切镜**：一个文字镜头一段 Clip 时写单镜时间线。经文字分镜表明确合并的多镜头 Clip，首镜 `[Shot 1]` 不写时间戳；后续 `[Shot N]` 可以写切镜时间和画面变化。镜头切分、合并和切点精度是制作策略，不是固定验收门槛；只要动作顺序、人物/道具状态和连续性成立即可。确有硬切要求时保留硬切，只有明确需要连续动作过渡时才描述跨镜运动。机位运动写清类型，必要时写幅度和速度。
- **对白原文与说话人**：按首次发声顺序分配稳定 `(S1)`、`(S2)` 等 speaker ID，并跨镜复用。每句对白用官方 `<d>[语言]原文</d>` 标签，逐字保留用户台词和标点；speaker ID 紧跟对应主体引用。画外音写清 off-screen voiceover、说话人和起止镜头/时间；对白不在声景字段重复。
- **声景分栏**：`overall_soundscape` 写环境声、物理动作声和非语言人声；`non_diegetic_music` 只写观众听到的背景音乐。全静音或无 BGM 时按官方格式写 `N/A`。
- **分镜帧过渡**：只有文字分镜表确实把多张已采用关键帧作为连续姿势路径时，才按顺序描述图间动作，并明确落到目标姿势；身份图、场景图和非分镜参考不能当作过渡端点。存在 hard cut 时保留切镜边界，不改成连续过渡。
- **具体但不编造**：把构图、人物姿态与视线、动作阶段、机位、光线、环境和声景写成可观察的画面/声音信息；不得补写用户未提供的剧情、对白或参考素材属性。
- **画面洁净约束**：需要画面洁净时，在提示词中明确写出：**禁止出现字幕、LOGO、水印、角标**，同时禁止无剧情依据的可读文字。该约束用于降低出现概率；如果成片仍出现上述元素，保留旧结果并针对当前 Clip 再抽一次。

参考 Skill 中关于本地文本模型/API 调用、输入缺失时向用户追问的 UI 包装、以及“只返回最终提示词”的交互要求不属于本生产流程；只采用与 H3 提示词内容直接相关的规则。

## Clip 设计

默认一条文字分镜生成一段 Clip。只有文字分镜表写明相邻镜头存在明显动作连续或对白/画外音必须跨镜延续，才将多镜合进一个 Clip；同场景、同人物或相似机位本身不是合并理由。一人一句的普通正反打各生成一段。

每个 Clip 开始前确认：

```text
Clip ID / 对应镜头 ID（合并时列全部镜头、依据、组内顺序和切镜时间）
总时长
模式 / 画幅 / 输出规格
参考槽顺序与 Picture/Subject 编号
首状态 → 单一路径的动作 → 末状态
下一 Clip 承接状态
逐字台词 / 说话人 / 语气 / 停顿 / 呼吸
环境声 / 动作音 / BGM 或明确无 BGM
上一段尾帧、上一段视频或 Motion Context 的使用理由
```

避免在首状态和动作链中重复同一动作，也不要在末状态再次要求完成同一动作，否则人物会做两遍。有承接依赖的 Clip 逐段生成；前段完成并检查人物、动作、声音和末状态后，再提交后段。

需要合并的多镜头 Clip 才在所选 H3 模式的时间线字段中写多个 `[Shot N]`：首镜不加时间戳，后镜写切镜时间和画面/机位变化，由 H3 在片内完成切换。是否拆成多个 Clip 由动作、对白、参考图职责和承接需要决定，不把拆分本身作为验收条件。首镜可使用已验收的入场关键帧；后镜若标记复用或不单独生成，就从已有参考和明确的文字镜头描述延续，不虚构新的 `<Picture N>`。Clip 时长只需覆盖剧情动作和对白，实际输出时长按媒体文件记录；H3 帧长量化造成的偏差不单独判失败。单镜 Clip 只描述该镜时间线，不额外要求 H3 切镜。若该段没有图片，按实际输入选择可用的 H3 模式，不为满足槽位而补画近似重复帧。

- 用户要求借鉴某个 Clip 的提示词写法时，只把该 Clip 当作文字范例，参考它的段落结构、逐镜状态、台词节奏和声景写法；除非用户明确要求复用其媒体，禁止把该 Clip 的视频或音频绑定到目标 Clip，也禁止在提示词中添加对应的 `<Video N>` / `<Audio N>`。

对话 Clip 沿用文字分镜表的单人正反打：中近景、近景或特写，视线明确指向画外对方；人物面部角度由表演与构图需要决定，不固定为三分之二侧脸。摄影机固定或极轻微推近，保持 180° 轴线。听者镜头可承接说话者画外台词。只有掌掴、递交、抓袖等必须同时看见双方的动作 Clip 才双人同框。

## H3 segment 操作门禁

用于修改或生成单个 H3 segment 的任务；不要把它当作整张画布扫描流程。

### 标准顺序

1. **定向读取**：用 `h3_get_clip(projectId, nodeId, segmentId)`，或读取同等精度的 node/segment，确认目标 segment、最近已完成来源、角色组、binding、prompt、运行态和已有结果。不要先拉取整张画布。需要插入/改序时，先另存完整 `metadata.segments` 快照并读取最新 collaboration revision；优先逐段 `update_h3_segment` 修改 `start`/`title`。`replace_h3_segments` 会以传入对象全量替换 segment，不能只传 ID；若必须使用它，要提交完整配置对象并只在确认后台会合并的前提下省略运行态字段，否则参考图、角色绑定和提示词会被清空。写后立即回读目标片段的 references、characterGroups、prompt 和时间轴。
2. **准备输入**：构造一次 `h3_prepare_clip` 请求：
   - `inheritFromSegmentId`：明确指定已完成来源；省略时由工具选择目标之前最近已完成 segment；
   - `patch`：只放本次要改的剧情、分镜、时长和提示词字段，以及用户明确要求改变的运行参数；
   - `referenceBindings`：完整的分镜/场景/道具 binding 集合；
   - `characters`：每个已有角色的 `characterNodeId`、显式 `subjectId`、当前 Clip 的 `selectedOutfitStorageKeys` 和 `voiceEnabled`。
3. **原子预检写入**：工具从已有角色节点读取完整服装目录，派生启用 binding，编译 `<Picture N>`/`<Subject N>` 和最终 payload；只有 `assertReferenceCompilation` 通过后，才在一次画布事务中更新 segment 并补已有角色节点连线。预检失败不得留下部分 patch、临时 prompt 或重复连接。
4. **核对返回 snapshot**：检查 `sourceSegmentId`、运行参数差异、编译后 prompt、参考顺序、角色节点 ID、subject ID、服装目录数/启用数以及连接；任何映射不一致都在提交前停止。
5. **提交与观测**：只用 `h3_run_clip` 提交，保存精确 `taskId`。读取 progress、error、queue 和 generation log；默认 90 秒无进度变化触发 watchdog，取消后确认任务终态为 `cancelled` 且没有输出媒体。
6. **生成后验收**：只有任务终态、generation log 的实际提交引用和最终媒体句柄都存在时才算成功；回读同一画布会话中的 segment，不把工具回显或 `succeeded` 单独当作媒体成功。

### 分段、删参考与纯道具 Clip

- **必要时再切镜头边界**：对白、抛掷和落点可以拆成多个 Clip，也可以保留在一个 segment 中；按动作可控性、参考图职责和承接需要选择，不把拆分作为验收要求。确实拆分时，每个新段显式写 `sourceShotId`、`duration`、`start`、`storyboardDurations`、`timeline`、`openingState`、`endingState`、`continuityIn` 和 `continuityOut`，相邻段的状态应能逐字段接上。
- **删参考时同步更新 prompt**：编译器会用 segment 当前 prompt 校验新 `referenceBindings`，所以不能先删 binding、再让旧 prompt 留着已删除的 `{{ref:...}}`。用一次原子片段更新同时提交语义完整的 prompt 和新的 bindings；再调用 `h3_write_storyboard_prompt` 生成规范 prompt，最后用 `h3_get_clip` 或 `canvas_validate_generation` 确认 `issues: []`。
- **纯道具段不要传空角色数组**：`h3_prepare_clip` 一旦收到 `characters` 字段，就要求其中至少有一个已有 character 节点；`characters: []` 不是清空角色组的契约。纯道具/落点镜应通过画布 MCP 的 `update_h3_segment` 原子设置 `h3CharacterGroups: {}` 和仅保留场景/分镜/道具 bindings，再写规范 prompt；验收 `characterGroups` 为空、`subjectCount` 符合镜头职责且 `issues: []`。
- **运行态与剧情字段分开写**：`status`、`progress`、`runtimeTaskId`、`result`、`resultStorageKey`、`results` 等由后台任务维护，不能用普通 `update_h3_segment`/`canvas_apply_commands` 清空或伪造。配置修复只改剧情、分镜、参考和非运行参数；活动任务先用精确 taskId 取消并回读，旧媒体保留时明确标成历史结果。

### 硬门禁

- 不要先用临时无语义 prompt 让角色绑定通过；`h3_prepare_clip` 已把剧情、引用、角色组和预检合成一个契约。
- 不要把角色名、group ID、binding ID 或节点 ID互相猜作 `subjectId`；由调用方确定稳定 subject ID，并让角色组、binding、提示词三处一致。
- 不要把当前 Clip 的启用服装列表写回角色节点完整目录；目录来自源 character 节点，启用状态只属于当前 segment。
- 缺少已有 `characterNodeId`、`characterAssetId`、预览 URL、storage key 或完整服装目录时 fail closed；禁止降级为普通图片引用或创建新角色节点。
- 只要最终参数偏离最近已验证片段，就在 snapshot 中显式列出差异；没有用户明确意图不得提交更高分辨率、更重模型或不同采样器。

## 参考与节点提交闸门

- config 节点必须在 `metadata` 顶层有 `model`，不能只写 `params.model`。
- 多个同名 config 必须按精确 `id` 操作；修改后回读 prompt 特征和长度。
- `referenceNodeIds` 不能代替真实连线。创建或更新后回读连接数量，不足时用 `canvas_connect_nodes` 补齐。
- 提交前同时确认 `metadata.model`、prompt、参考连线、槽位顺序与精确结果节点。
- `canvas_create_config_node` 使用 `id`；通用 `canvas_create_node` 默认解析返回 ID，或用 `canvas_apply_ops` 的 `add_node.id`，不得使用尚未创建的预计 ID。
- `canvas_connect_nodes` 使用 `connections: [{ fromNodeId, toNodeId, role, order }]`；`canvas_update_node` 使用 `id`。
- 保存真实 taskId，以有界等待或短轮询查询。异常时查询原任务，不重复提交以避免重复扣费。

## 生成后回读与 Clip 验收

确认任务成功、真实视频媒体存在、时长与尺寸正确、结果写回目标节点、generation log 中参考图片/视频真实传入、节点布局未改变。记录 Clip 的模式、prompt 版本、输入、taskId、storageKey、首尾状态和声音要求。

随后立即在本 Skill 内验收，不转交独立验收阶段：

- 记录实际时长、画幅、可播放性和媒体完整性；H3 帧长量化导致的时长偏差不单独判失败，除非用户明确要求严格时长，或偏差已经破坏动作、对白或承接。
- 人物身份、服装、场景和道具没有漂移；动作从正确首状态开始并停在目标末状态。
- 没有重复动作、突然跳位、错误转身、越轴、穿模或无因出现/消失。
- 若成片包含内部切镜，检查镜头顺序、人物/道具状态和连续性；不把是否按计划精确切镜或是否拆成多个 Clip 作为单独验收门槛。独立镜头仍应避免无剧情依据的额外切换。
- 对话 Clip 的人物数量、面部角度、视线和机位运动符合单人正反打方案；面部角度不受固定模板限制，双人同框只发生在所需动作镜头。
- 台词归属、口型、情绪强度、语速、停顿、呼吸、环境声、动作音和 BGM 需要人工试听确认；仅凭音轨存在、波形或元数据不能判定声音通过。人工确认前标记为 `waiting-user`。
- Clip 末状态可承接下一段，上一段尾帧、视频或 Motion Context 的实际输入可从日志确认。

使用 `accepted / needs-redo / waiting-user / blocked-upstream` 记录结论。返修只重跑当前 Clip 及必要的下游承接，不重跑已通过片段；同一问题连续失败两次后返回关键帧、镜头设计或参考输入排查。若用户要求每段先看，生成并自检一个 Clip 后标记 `waiting-user`，等待确认再继续。全部目标 Clip `accepted` 后，直接把已确认版本和素材位置汇总给用户，流程结束。

## 补救路径（历史节点恢复）

用于找回已经从画布快照删除、但生成任务和媒体仍在运行库中的图片智能节点。目标是恢复原节点语义和现有媒体，不重新生成。

### Procedure

1. **冻结范围并读取当前状态**
   - 固定目标 `projectId` 和要恢复的原节点 ID。
   - 通过 MCP `canvas_get_state` 或 `canvas_inspect` 读取当前节点，确认目标 ID 是否真的缺失；不要仅凭 UI 不显示或 SQLite 查询为空判断缺失。
   - 同一批恢复不要执行清理旧节点、重新生成或修改无关节点。

2. **只读提取历史真值**
   - 从 `generation_logs` 读取目标节点最新成功记录的完整 `prompt`、`params_json`、`outputs_json`、`references_json`、`input_counts_json` 和 `runtime_task_id`。
   - 从 `media_files` 按 `outputs_json.storageKey` 读取真实文件路径、MIME、字节数和像素尺寸；不要拼接或猜媒体文件名。
   - 先断言 `references_json == []`、参考数量为 0、`count == 1`，再决定是否按纯文生图节点恢复。
   - 旧版本恢复必须保留历史 prompt 原文；如果要修正提示词，另做明确的版本修订，不要把修订伪装成恢复。

3. **重建智能节点而不是结果图节点**
   - 用 `canvas_apply_ops` 的 `add_node`（节点已存在则用 `update_node`）写回原节点 ID，`nodeType: "config"`，并保留原标题、宽高和版本语义。
   - 至少写入：`smart: true`、`generationMode: "image"`、`prompt`、`composerContent`、`model`、`size`、`quality`、`count: 1`、布局字段、`referenceMode: "text-to-image"`、`referenceNodeIds: []`、`references: []`、成功状态、`generationTaskId`。
   - 把既有媒体放进一个成功的 `metadata.images[]` 槽，并同步顶层 `primaryImageId`、`content`、`storageKey`、`mimeType`、`naturalWidth`、`naturalHeight` 和 `bytes`。媒体句柄必须来自历史记录；不要创建普通 `image` 节点再连到 config，也不要调用 `canvas_run_generation`。

4. **处理布局而不遮挡当前结果**
   - 如果历史位置会与当前节点重叠，给恢复节点显式的避让坐标；把原始坐标另存为 `metadata.originalPosition`，这样既保留历史信息又保证恢复后在画布上可见。
   - 同批恢复多个节点时逐个检查边界，避免它们互相重叠或覆盖现有资产。不要省略坐标而依赖默认布局。

5. **同会话验收**
   - 立即在同一个 MCP 会话调用 `canvas_get_state`/`canvas_inspect`，按节点 ID精确取回结果。
   - 对每个节点断言：`type == "config"`、`metadata.smart == true`、`metadata.prompt` 和 `metadata.composerContent` 非空且相等、`metadata.images` 恰有目标媒体、storage key 与历史记录一致、`status == "success"`、`references == []`、`count == 1`。
   - 汇总只打印 ID、类型、位置、状态、taskId、storageKey、prompt 长度等短字段；脚本应程序化断言，不要凭 MCP 巨型回显肉眼判断。
   - 可用 `canvas_apply_ops` 的 `select_nodes` 选中恢复节点，但选择不是恢复成功的证据。

### Pitfalls

- **不要把任务存在误当作节点存在**：生成日志和媒体仍在，不代表画布快照保留了 config 节点；必须分别恢复节点和媒体绑定。
- **不要用独立图片节点代替智能节点**：这会让前端失去提示词/生成配置入口，也会恢复出错误的画布结构。
- **不要只写 `metadata.prompt`**：前端编辑器读取 `composerContent`，只写执行字段会让恢复节点看起来没有提示词。
- **不要按标题、无连线或旧版本号清理节点**：历史角色图和空场景结果可能使用通用标题，必须以生成日志、媒体 storage key 和实际内容建立保护白名单。
- **不要把旧版本恢复和质量优化合并**：用户要的是可追溯的历史节点时，原 prompt、参数和媒体必须保持一致；优化应另建版本或另一次明确更新。

H3 segment 操作门禁见 [内嵌 § H3 segment 操作门禁]；MCP 执行器/节点工厂等工程细节见 [references/video-production-orchestration.md](../../references/video-production-orchestration.md)。
