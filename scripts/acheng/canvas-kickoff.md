### Infinite Canvas 集成：视频制作启动确认

在本仓库的制作工作流中，凡本次交付包含视频，必须在剧情拆解、资产提示词或分镜设计前确认成片画幅。先检查当前请求和正式制作设置：用户已明确比例时直接沿用；已有非空 `settings.videoAspectRatio` 视为已确认；`settings.videoAspectRatioConfirmed=true` 且 `videoAspectRatio=null` 表示用户明确选择“沿用画布配置”；两者都没有时，在首次制作回复中询问 16:9、9:16、1:1、4:3、3:4、2:3、3:2、21:9、沿用画布配置或其他比例。若还有其他真正缺失的启动决定，将问题合并在同一轮；不得先开始创作再补问画幅。

用户确认后，通过正式 `set_settings` 保存 `{ videoAspectRatio: <比例或沿用画布时为 null>, videoAspectRatioConfirmed: true }`，回读 revision 后再继续。纯资产包且不交付视频时跳过此问题。成片画幅只约束视频生成，角色设定图、STYLE_MOTHER、场景图和关键帧按各自用途设置比例。工作台已保存的内容交付模式与媒体生产模式优先；内容交付默认自动文件批处理，媒体生产默认逐项生成，不重复询问上游旧版固定的“自动文件／逐段互动”选择题，也不再次确认已保存的选择。数据操作遵循本项目 `canvas-video-production-sop` 适配规范。

### Infinite Canvas 集成：Subject Prompt Assembly 与编译

当前 Director 源稿统一使用根字段 `version: 2`。启用 Subject Prompt Assembly 时，先登记稳定 Subject，并通过 `entityRef` 绑定角色、场景或道具的正式实体；Subject 图片绑定可指向对应素材节点或智能图片节点，始终使用真实 `sourceNode.projectId/nodeId` 与选择策略；Shot 通过 Subject 使用对象和绑定，不自编 `<Picture N>` 编号。连续性事实只写入唯一权威 `ledger`，事实所属对象由 Subject 的实体引用解析；Shot 初态、事件和尾态由局部帧与连续性重放派生。Shot 是摄影原子，时长使用整数帧；Clip 只重组相邻 Shot，不重复保存 Prompt、Subject 列表或 Picture 编号。

正式 Prompt、参考顺序与上传映射只由当前激活编译器从结构化源稿组装。Agent 只写结构字段，不在 `segments[].prompt` 或画布 Clip 中手工组装正式 Prompt。用户在画布明确编辑 Prompt 后，可要求反向同步；仅当本次编译回执提供的 SourceMap 能把全部修改唯一映射到单个 Shot 文本或对白字段时才写回，其他文本留在画布并报告歧义，不猜测修改摄影、身份、绑定或连续性。缺少 SourceMap 时保留手工 Prompt，不宣称同步完成。Canvas 工作台直接编辑唯一的 `draft.director.source`；v2 不另存 Shot/Segment 镜像。旧格式与现存 v2 双写稿只能由维护者用 `director-source-storage` 只读检查并显式迁移，不自动兼容或启动时清理。

Infinite Canvas 的正式 H3 流程在编译应用成功后，必须把当前范围内所有 ready Clip 的编译 Prompt 交给已配置的翻译 LLM，译成全英文并仅轻度润色，再写回对应 H3 Clip 后才能进入生成。保留 H3 字段名、引用标签、镜头编号、时间、数字、事实、对白含义和所有约束；不得补剧情、删减、改镜头节奏或变更引用。人工工作台使用“翻译已编译提示词（英文）”；Agent/MCP 使用 `production_translate_compiled_prompts`。只翻译编译基线仍有效且当前 Clip 正文哈希与产物相同的目标；一批目标全部通过后原子写回。翻译失败或编译未就绪时保留原提示词并停止该批生成。Backend 按源提示词 SHA-256 跨 UI 与 MCP 缓存成功译文，相同内容不重复请求；写回译文是画布 Prompt 的人工翻译投影，不回写中文导演源稿或伪造新的编译产物。源稿改变并重新编译后，只翻译新编译的目标。

Subject 图片与关键帧引用固定到 Backend 核验过的成功归档结果。`latest_success` 按持久任务顺序与批内输出顺序解析；历史浏览不能改变选择，恢复旧生成设置是独立的显式动作。编译和同步不授权图片、视频生成或发布。当前写入只接受 Director 源稿 v2；旧版源稿需要按当前合同重新整理并重新提交，不迁移改写旧源稿。

### Infinite Canvas 集成：素材节点与共享资产

角色、场景、道具登记使用正式 `production_edit`：已有实体沿 `patch_director_source` 更新，新增素材沿 `create_manual_director_asset` 一次登记资产卡、实体与 Subject。Backend 在同一事务内创建对应的角色／场景／道具节点；稳定关联为 owner + kind + entity ID，不按名称匹配，不另造可独立维护的描述副本。当前格式源稿缺节点时用 `production_prepare_targets` 的 `entity:character:<实体ID>`、`entity:scene:<实体ID>` 或 `entity:prop:<资产ID>` 补齐，读取短回执中的 revision；需要定位时用 `production_get_workbench` 的 `subject_workbench` 定向回读 `entityNodeSource` 中的真实 projectId/nodeId，保留原布局与连线。风格不随此节点接入自动创建。

图片生成节点保留参数、任务与结果历史；它与素材身份节点职责分开。图片绑定沿 Subject/Shot 正式操作维护；素材节点消费当前有效图片，智能节点遵循 `node_selection/latest_success/selected_result`。使用已归档媒体，编译与生成冻结本轮输入；不因节点接入自动批准、发布或生成。

剧目资产库是该剧目共享资产画布的目录视图。通用加入／更新复用 `assets_add/assets_upsert_batch` 的稳定 operationId、`canvasSource:{projectId,nodeId}` 与明确资产 ID，Backend 建立唯一源并原位转引用；智能生成只共享选定产物，原任务保持。引用编辑保留为本地字段修改，明确更新原资产才同步共享源，不另建同名资产。删除引用走画布 ops；删除库中源资产先用 `assets_get` 读取稳定来源，再用 `canvas_apply_commands` 删除该 sourceProjectId/sourceNodeId，有引用时按 Backend 返回的使用画布处理，不能绕过保护或删归档媒体。普通资产库沿原行为。正式制作直接选择当前共享画布节点作为来源，并在同一制作稿里保存 `asset_plan.sharedSource` 与 Subject 图片选择；该选择就是本集的共享引用，不再单独写入采用状态或选择版本副本。历史素材版本只用于追溯，不作为当前编译来源。具体工具参数以当轮 schema 为准。

### Infinite Canvas 集成：制作内容语言

制作工作台的可读描述默认使用简体中文：主体、角色、场景、道具、图片用途与保留/排除说明、镜头标题、动作、摄影理由、连续性事实名称、状态说明和事件原因。结构化源稿的 `display_summary`、`display_name`、`visual`、`state_description`、`prompt_description`、`value_descriptions` 等描述性正文也用中文，不能只留下给模型看的英文。字段键、稳定 ID、事实枚举、数值、引用标签及模型参数保持合同值；为机器枚举填写中文名称与中文说明，不用技术 ID 代替显示名称。导演源稿中的对白、歌词与画面内文字保留确认原文；正式 H3 Clip 编译后会按项目要求翻译成英文，保留语义与约束。编译器先适配 H3 官方格式；随后 Infinite Canvas 正式 H3 Clip 必须再经 LLM 翻译为全英文并轻度润色，不要求作者维护英文源稿。既有批准内容不自动改写；新增及用户明确要求修改的描述遵守中文规则。

描述性原字段直接用中文创作并供人和编译器共同消费，不另建英文正文＋中文显示副本，不要求用户补写第二份中文说明。既有 `display_*` 字段仅保留兼容，不作为新增的双语维护要求。剧情节点按具体叙事变化设计；`goal/obstacle/choice/cost/result` 必须对应本节点的具体人物、行动和变化，不得用同一套通用套话填满各节点，不能为满足结构校验而把每行对白机械变成剧情节点。未确定的剧情分析应明确列为待设计，不能伪装成已完成。

### Infinite Canvas 集成：对话输出

首次响应、阶段交付及后续对话直接围绕用户创作任务展开，不输出品牌开场横幅、能力宣传、作者推广、关注引导或固定版权与免责声明，也不将这些内容写入剧本、分镜和提示词交付文件。用户明确询问来源或许可时再按包内来源与许可文件回答。
