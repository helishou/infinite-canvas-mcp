# Acheng 与画布的执行适配

本文件是制作必读核心；执行细节按[主入口](../SKILL.md)的任务索引加载，不通读全部参考。当前激活运行包中的 Acheng 主技能与模块负责创作，以下规定画布兼容差异。

## 加载与版本

Acheng Director 本身就是 Skill，完整上游文件和模块位于项目 `.agents/skills/acheng-director`。Skill 规定创作方法；`compile_assets.py`、`compile_h3.py` 及校验脚本是把制作源稿转换成提示词产物的可执行工具，不是另一个导演 Agent 或模型。开始或恢复制作、读取合同以及新发起编译或校验时，使用本机 `skill-runtimes/acheng-director/active.json` 当前激活的版本。上游通过 `npm run acheng:update` 手动更新；激活新版不自动重编项目。每次编译请求创建时记录上游 commit、patchVersion、runtimeId、Skill version，该请求的预检、编译与回执使用同一版本；版本切换只影响后续请求。历史产物保留实际编译版本，局部编译不改写无关产物或已提交任务。版本缺失或兼容检查失败时停止，不退回旧画布流程。

版本更新、子模块和离线工具见[维护参考](acheng-canvas-maintenance.md)，普通制作不执行更新命令。

## 创作权属

新制作采用 `prompt_assembly.version=2`：Shot 是摄影原子，摄影切点、时长和观看对象由结构化镜头明确设计；编译器组装 Prompt，不在单个 Shot 内暗中插入切镜。Subject、智能节点引用、台账与 Clip 分区沿当前激活导演合同。未启用新合同的旧稿保持原编译策略，不自动迁移。

story、assets、shots、performance、effects、model、continuity 按 Acheng 原合同协作。空间设计在 assets 的 scene-design 支路，shots 消费空间事实；站位图是按需资产。多资产新制作采用 STYLE_MOTHER，新四视图默认采用等高的正脸近景、正面全身、侧面全身、背面全身和空手；色卡为辅助信息，不另建强制前置阶段。旧批准资产可保留并登记适用范围，缺项只补本轮所需。

用户明确指定其他角色布局时，在完整 `asset_cards[].view_layout` 中保存 `selection: user_explicit` 和具体 `selection_reason`，由支持该选择的当前激活运行包校验。当前可显式选择1:2行高的正脸近景、右侧脸近景、无头正面服装全身、完整背面四格，或等高的生物头正面、头侧面、盘绕全身、身体中段鳞片细节四格。类型、视图、顺序、行高、同一主体与用途必须完整；缺少明确选择不按历史布局放行。不能伪造批准状态或用历史 fixture 绕过新制作校验。

### 制作内容语言

描述性源内容遵循当前激活导演入口的“制作内容语言”规则：原字段直接用中文，人和编译器共用同一份内容，不另要求中文显示副本。`prompt_description`、`state_description` 和连续性状态正文也属于原描述字段，不能在适配层另规定必须英文；最终模型请求的格式与语言由编译器处理。旧稿与确认对白保留其修改范围。

Shot 是叙事镜头，Segment 是请求，Clip 对应 Segment。本项目导演规划的每段 Clip 必须为 4–12 秒（含边界），收紧上游 4–15 秒生成窗口。按题材、对白和动作容量，沿镜头与事件安全边界装箱；保存源稿和提交编译前，逐段核对 `generation_clip_duration` 与帧窗换算秒数一致且均在范围内。超长段拆分，不足 4 秒的短尾与同场次相邻段合并或重新分配边界后再次检查所有段；不得加速对白、压缩动作或无意义填充。无法合理满足时返回具体边界问题；已有确认稿超窗时先说明受影响片段及调整方案，不静默改写或重新生成。不得自动一镜一段、强制正反打或仅允许动作镜合并。关键帧依真实锚点需要制作。

Ref2VA 最低细节要求按本机当前激活的编译脚本版本计算；新兼容版本取消正文硬上限，词数只作诊断，不截断、压缩或按词数重装箱。旧稿下次编译使用当前激活版本，历史正文与回执保留，不自动重编或生成媒体。H3 引用使用 `<Picture N>/<Subject N>`，风格母图在资产参考最后槽。上游宣传文案不是生成提示词。

## 视频启动规格

视频制作在 kickoff 阶段、进入故事拆解和提示词编写前先确认成片画幅。检查用户 brief 与正式 `settings`：若 brief 已写明比例或 `videoAspectRatio` 已有非空值，直接采用；若 `videoAspectRatioConfirmed=true` 且值为 null，表示用户明确选择“沿用画布配置”，不重复询问；只有值为空且未确认时才询问。确认后通过正式 `set_settings` 保存 `videoAspectRatio`（沿用画布时为 null）和 `videoAspectRatioConfirmed=true`，读回 revision 再继续。纯资产交付且不制作视频时不问视频画幅。成片比例只控制视频规格；角色四视图用 2:3，关键帧及其他参考按各自镜头用途定比例，不用参考卡比例决定视频画幅。

内容交付和媒体生产模式沿用正式设置；画布默认内容自动文件批处理、媒体逐项生成，不重复询问上游固定的交付方式选择题。模式不替代生成授权，运行操作见[运行与恢复](canvas-production-runs.md)。

## 画布是执行与正式存储

Acheng 的纯提示词限制适用于创作职责；用户授权实际生成时，由本适配层通过原生 Canvas MCP 提交 Backend 任务。不得绕过画布调用 ComfyUI、直接写库或先生成后补记录。按本轮 schema 使用工具，不沿用旧字段猜测。

进入制作前调用 `production_get_contract`，恢复旧稿也读取当前激活版本，`runtimeId` 已弃用且不选择执行版本；可用 `operationType` 查询单项操作。返回共享 JSON Schema、合法示例、patch 字段及本机当前激活版本的制作源稿模板。示例中的 ID、引擎标识与哈希必须替换成当前真实数据，不把示例视为发布或生成依据。

Backend draft 是正式创作编辑源，published 保留显式发布的历史版本，本地 production.json 是带 revision 的工作副本。修改需稳定 operationId 和 expectedRevision；冲突回读，不覆盖他人草稿。默认 inputBasis=canvas 的运行冻结当前有效画布输入，显式 published 才核验指定发布稿。剧本、镜头和 Clip 视图是投影，修改应进入导演源；源变化后沿编译/校验更新回执。模型继承原配置；保存、编译、审核和发布不授权生成。

已有正式稿的导演委派携带 production.kind/id/expectedRevision/scope，由 Backend 构造固定版本、依赖和专业模块的工作包。建议完整且无未决项后，主导演在原授权范围内通过 production_edit 的 ops 与 adoptions:[{taskId,artifactHash}] 原子采纳；partial、unbound 或输入过期不能登记采纳。partial 按已有交付模式沿原任务 continue；recover 只回读原已完成回合，不自动重跑或生成。

交付模式与原创作授权随工作包固定。交互或无模式记录的旧任务，continue 必须携带本轮真实用户续写意图 continuationIntent=explicit；自动模式使用 automatic，不扩大原任务要求。正式稿改换交付模式或原输入变化时拒绝沿旧工作自动推进。场次创作、共同资产审核与场次自动审核共用固定专业合同和不可变产物封套；源稿合并与审核记录分别在原事务登记 workAdoptions，含产物摘要、operationId、revision、sourceHash 和语义 opsHash。审核结果写入不表示所有质量维度已通过。

Agent 编辑正式源稿，程序负责提示词编译、校验与引用投影。编辑、编译和发布前读[源稿编译与发布](canvas-compilation.md)。开始工作或登记用户决定时读[工作台与布局](canvas-workspace.md)。

## 兼容章节入口

以下保留旧章节链接，详细规则只维护在目标文件。

### 编译后由程序承接

见[源稿编译与发布](canvas-compilation.md#编译后由程序承接)。

### Acheng 编译脚本做什么

见[编译输入与产物](canvas-compilation.md#编译输入与产物)。

## 导演工作台对象工作区与运行接口

见[工作台与布局](canvas-workspace.md)和[运行与恢复](canvas-production-runs.md)。

### 关键帧参考核对

见[图片参考核对](canvas-image-production.md#关键帧参考核对)。

### 图片并发调度

见[图片并发调度](canvas-image-production.md#图片并发调度)。

### 制作画布布局

见[制作画布布局](canvas-workspace.md#制作画布布局)。

## 生成参数与交付规格

启动画幅见本文件的视频启动规格，执行参数见[Clip 生成参数与交付规格](canvas-clip-production.md#生成参数与交付规格)。

## 连续性边界

规划或编译视频前读[连续性边界](canvas-clip-production.md#连续性边界)。

## 完成与恢复

见[运行与恢复](canvas-production-runs.md#完成与恢复)。
