# Acheng 与画布的执行适配

## 加载与版本

Acheng Director 本身就是 Skill，完整上游文件和模块位于项目 `.agents/skills/acheng-director`。Skill 规定创作方法；`compile_assets.py`、`compile_h3.py` 及校验脚本是把制作源稿转换成提示词产物的可执行工具，不是另一个导演 Agent 或模型。脚本版本由本机 `skill-runtimes/acheng-director/active.json` 固定；制作开始记录上游 commit、patchVersion、runtimeId、Skill version，恢复时沿用该制作记录锁定的脚本版本。版本缺失或兼容检查失败时停止，不退回旧画布流程。

项目命令 `npm run acheng:status` 查看活动运行时和仓库上游副本；`npm run acheng:update -- --check` 检查候选而不修改文件；`npm run acheng:update` 验证后更新固定运行时与仓库副本；`npm run acheng:vendor` 将当前已固定提交同步到仓库；`npm run acheng:rollback` 同时回退运行时和仓库副本。同步不会启动媒体生成；若检测到仓库副本的本地改动则拒绝覆盖。

### Acheng 编译脚本做什么

编译输入是已保存的结构化制作源稿、Shot/Segment、资产资料和实际参考绑定。只有资产时运行 `compile_assets.py`；包含视频片段时运行 `compile_h3.py`。脚本按对应 Skill 规则产出独立、完整的图像或 H3 提示词文件、索引、逐目标诊断、参考映射和哈希回执；缺少依赖的目标保留为 draft，不伪造 ready。Backend 再核对当前制作 revision、媒体归属和执行条件。

这里的“编译”不是编译程序代码，也不是让 AI 重写整份导演稿；它把既有制作源稿转换成可检查、可提交的提示词产物。脚本不调用图像或视频模型、不产生媒体、不消耗生成额度。源稿、提示词、实际参考或镜头边界变化时，才用这次制作锁定的脚本版本重算受影响的产物和回执；已生成媒体不会因此自动重做。

## 创作权属

story、assets、shots、performance、effects、model、continuity 按 Acheng 原合同协作。空间设计在 assets 的 scene-design 支路，shots 消费空间事实；站位图是按需资产。多资产新制作采用 STYLE_MOTHER，新四视图采用正脸近景、正面全身、侧面全身、背面全身和空手；色卡为辅助信息，不另建强制前置阶段。旧批准资产可保留并登记适用范围，缺项只补本轮所需。

### 制作内容语言

中文用户未指定其他语言时，Agent 对话、问题与说明，以及导演工作台可读的制作源稿使用简体中文：`story` 与 `script_scenes` 的非对白内容、角色/场景/资产显示名称和说明、Shot 标题与中文 `display_summary`、阻塞原因及审核说明。对应地填写 `character_registry[].name`/`appearance`、`scene_registry[].name`、`asset_plan[].asset_name`/`description` 等显示字段。对白、歌词和画面内文字逐字保留原语言。`prompt_description`、`state_description` 与最终 H3 正文属于编译字段，按固定 Acheng/模型合同使用英文；不得把它们作为唯一的中文界面说明。已有确认稿不自动翻译，局部修改只按用户指定范围更新。

Shot 是叙事镜头，Segment 是请求，Clip 对应 Segment。按题材、对白和动作容量规划，沿已有镜头边界装箱至 4–15 秒。不得自动一镜一段、强制正反打或仅允许动作镜合并。关键帧依真实锚点需要制作。

保留 Acheng 的内容完整性、模块检查、partial/commit、风格及版本规则。Ref2VA 最低细节要求按本次制作锁定的编译脚本版本计算；新兼容版本取消正文硬上限，词数只作诊断，不截断、压缩或按词数重装箱。旧稿沿用原脚本版本；显式升级后重新生成提示词产物与校验回执。H3 引用使用 `<Picture N>/<Subject N>`，风格母图在资产参考最后槽。上游宣传文案不是生成提示词。

## 画布是执行与正式存储

Acheng 的纯提示词限制适用于创作职责；用户授权实际生成时，由本适配层通过原生 Canvas MCP 提交 Backend 任务。不得绕过画布调用 ComfyUI、直接写库或先生成后补记录。按本轮 schema 使用工具，不沿用旧字段猜测。

分集调用 `drama_get_production/drama_edit_production/drama_publish_production`；独立画布调用对应 `canvas_*_production`。通过 `set_director_production` 提交完整导演稿：schemaVersion、engine、source、sourceHash、modules、artifacts、assets、shotInputs、boundaries、workflow、unresolved、executionAuthorized。

进入制作前调用 `production_get_contract`，恢复旧稿时传原 `runtimeId`；可用 `operationType` 查询单项操作。返回共享 JSON Schema、合法示例、patch 字段及本机锁定版本的制作源稿模板。示例中的 ID、引擎标识与哈希必须替换成当前真实数据，不把示例视为发布或生成依据。

正式提交前调用 `canvas_preflight_production` 或 `drama_preflight_production`，传所属 ID、`action: edit/publish/generate` 与原正式 `request`。预检只读，返回 revision、引擎与 `code/path/targetId/message/severity`。计划稿缺项可保存；发布和生成按各自条件检查。预检通过后仍以正式提交的 revision、幂等与媒体校验为准。

用 `node scripts/acheng/export-canvas.mjs production.json canvas-mapping.json <新输出目录>` 调用本次制作锁定的 Acheng 编译脚本，生成包含完整提示词产物与回执的 `director.json`。mapping 包含 assets、shotInputs、boundaries、modules 与按 targetId/label 索引的 references（nodeId/storageKey/role）；首次使用当前激活版本，恢复时传入原运行 `engine.path`。该命令只处理离线文件，不调用画布或图像/视频模型。

导出前检查源稿契约，导出目录保留 `preflight.json`；提示词长度、阻塞项与格式验收保存在产物回执诊断中。已有文件可用 `node scripts/acheng/preflight.mjs director.json edit` 检查，也可选 `publish` 或 `generate`。离线检查使用同一锁定版本的编译/校验脚本，但不证明在线 revision、模型和媒体归属，`generationReady` 保持 false。脚本使用已构建的共享包；运行前设置真实可执行的 `ACHENG_PYTHON`，不要依赖 Windows Store 的占位命令。

离线命令也接受 `{action,request,production?}` 的正式请求文件；`production` 可传 Backend 读取到的制作记录快照。操作 schema、源稿 patch 和锁定版本的脚本规则与 Backend 共用；需要在线对象、媒体或模型上下文的操作逐项标为 `unverified`，不能用离线快照替代在线提交检查。

仅重建本地兼容层时使用 `npm run acheng:update -- --local --check` 验证候选，再用 `npm run acheng:update -- --local` 激活；保留同一上游 commit 和旧不可变运行版本。此操作不改制作稿、不提交生成。

source 原样保存 Acheng production 数据。sourceHash 是递归键排序、无空白、UTF-8 JSON 的 SHA-256；脚本使用项目导出工具，不能凭记忆拼哈希。artifacts 每项包含独立 prompt 字节、sha256、源哈希、参考标签/节点/storageKey/媒体哈希/职责及编译回执；draft 和 partial 不标 ready。接入包不填造 PASS，先执行本次制作锁定版本的真实离线编译与校验，再由 Backend 核对源与媒体。

Backend 已发布版本是正式源，本地 production.json 是带 revision 的工作副本。修改需稳定 operationId 和 expectedRevision；冲突回读，不覆盖他人草稿。剧本、镜头和 Clip 视图是投影，修改应进入导演源；源变化后重跑锁定版本的提示词编译/校验脚本并更新对应回执，旧产物不能作为当前版本执行依据。模型选择继承现有配置；保存草稿不生成。

assets 映射保存实际 nodeId、assetId、storageKey、sha256、version 和批准证据。每张图一项主要职责并写保留/排除范围；真实文件不存在时只能交草案。正式引用须通过真实媒体检查，不把任务成功当批准。完整资产提示词按依赖准备，H3 编译必须满足原资产门禁。

智能节点生成复用原 ID 与结果槽，保持 position/尺寸/layout；同名节点按精确 ID 操作。每次提交保存真实 taskId，超时查原任务，不重复付费提交。任务、日志、归档媒体、活动节点绑定需要对应；原结果保留。

## 导演工作台对象工作区与运行接口

导演工作台按制作对象展示「总览、故事、风格与资产、镜头与片段、生产与交付」，JSON、旧稿接入、引擎和版本恢复集中在高级与历史。七模块仍是内部职责；不要把页面标签、partial 或模块顺序解释为必须依次通过的生产关卡。首页、独立画布和单集入口引用同一 Backend 制作记录。

产品导航只有一个「制作」入口，创意入口也放在这里；分别浏览独立画布与剧目分集。进入具体制作对象默认打开固定画布：每集一个制作画布，每个剧目一个共享资产画布，场次只做集内目录和分组。导演对话由右下角气泡展开，目录与对象编辑按需打开；交互约束统一见 `.agents/rules/canvas-ui.md`。故事、资产、镜头、生产与历史仍使用原 Backend 制作记录。已有绑定不改绑；首次进入未绑定对象调用 `production_ensure_canvas`，需要识别画布归属时调用 `production_get_canvas_context`。历史 `/director` 与分集制作地址保留为画布兼容入口，恢复原草稿与回执。

创意对话确认对象后，先保存 brief 与 `workflow.currentWork`，回读 Backend `workflow/readiness`，再通过 `site_navigate({ production: { kind, id, workId, runId? } })` 呈现正式画布目标；无节点时打开对象编辑面板。需要节点时用 `production_prepare_targets` 幂等准备 asset/frame/segment，不把准备或跟随视为生成授权。推进同一制作沿用 workId；待决定项绑定源哈希，用户答复先保存再继续，不凭聊天文字或同名节点推断导航位置。

跨集共享素材在资产画布经真实媒体审核后登记批准版本；分集调用 `production_get_shared_assets`、`production_adopt_shared_asset` 采用。Backend 对新批准版本持久传播并重新编译校验，保留历史与在途任务输入；发生冲突先回读草稿和更新原因，用户核对后用 `production_retry_shared_update` 恢复。输入变化的旧媒体不自动重做。画布权威和版本边界见画布数据契约，跟随与手动接管见画布交互约束。

早期 brief 和 partial 可保存，且不要求先创建全部画布节点。首次需求使用 `set_director_brief` 写入 `source.brief`；常见场景、风格策略、资产、Shot 与 Segment 编辑使用 `patch_director_source`，只改声明的源字段并保留其他 Acheng 字段；边界用 `set_director_boundary`，工作模式、稳定 workId、currentWork 和待决定事项用 `set_director_workflow`，资产节点映射用 `bind_director_asset`。完整模块回包仍可使用 `set_director_production`，但常见 UI 编辑不能整稿覆盖。`currentWork` 绑定源 revision/hash；用户决定卡绑定同一 workId 和源哈希，答复先保存再交回导演。

通过 `workflow/readiness` 或 MCP `*_get_workflow_readiness` 查询按目标依赖计算的缺项、待审核项、可执行范围和正式 `presentation`。无关模块的 partial 不应拦住已就绪分支。Agent 推进当前目标时更新 `workflow.currentWork` 并回读展示投影，再使用结构化 `site_navigate` 呈现工作区或实际节点/Clip；普通页面跳转保留原 `path` 入口。改过 source、提示词输入、实际参考映射或边界后，须用该制作锁定的 Acheng 编译/校验脚本重算受影响产物，再由 Backend 检查并发布；只改工作游标或内容交付/媒体生产设置不需重跑提示词编译脚本。发布只冻结正式 revision，不提交生成。

内容交付模式为自动文件批处理或逐 Segment 互动；媒体生产模式为仅提示词、逐项生成或按依赖自动生产。只有用户点击生产目标，或调用 `*_start_production_run` 时才授权媒体生成。每批使用稳定 `runId`/`idempotencyKey`，保存范围、发布版本、设置、引擎和 taskId；重复请求返回原批次。自动范围在审核后继续同一 runId 时，只扩展至当前依赖刚就绪的目标；逐项范围不扩张。`*_pause_production_run` 在当前任务边界暂停，`*_resume_production_run` 继续相同 runId；失败或退回的目标不能因恢复而重新提交，重生成须明确新开 runId。

生成成功的图片/关键帧仍是待审核。`review_director_asset` 必须绑定发布版本、项目节点、归档 storageKey、媒体摘要和审核理由；Backend 自己校验实际文件后才将资产或关键帧标为 approved/rejected。未批准的依赖只阻塞其下游目标。旧稿在兼容区原样查看，接入 Acheng 时只补本轮缺项，不能自动重做历史媒体。

## 生成参数与交付规格

视频制作在 kickoff 阶段、进入故事拆解和提示词编写前先确认成片画幅。检查用户 brief 与正式 `settings`：若 brief 已写明比例或 `videoAspectRatio` 已有非空值，直接采用；若 `videoAspectRatioConfirmed=true` 且值为 null，表示用户明确选择“沿用画布配置”，不重复询问；只有值为空且未确认时才询问。确认后通过正式 `set_settings` 保存 `videoAspectRatio`（沿用画布时为 null）和 `videoAspectRatioConfirmed=true`，读回 revision 再继续。纯资产交付且不制作视频时不问视频画幅。成片比例只控制视频规格；角色四视图用 2:3，关键帧及其他参考按各自镜头用途定比例，不用参考卡比例决定视频画幅。

用户要求沿用默认参数时，H3 Clip 采用 h3ParameterPolicy=defaults，仅按制作稿指定画幅、时长、模式和连续性边界；模型、VAE、LoRA、采样、分辨率与放大消费 Backend 保存默认值。用户明确调整生成参数时采用 overrides。新节点须加载保存默认值；同步正文和参考不覆盖已有用户配置。每次新运行冻结默认快照，途中修改默认值不改变原批次。

通过 h3_preview_run 或 canvas_validate_generation 核对生效值、来源、预计一采/二采尺寸、正式画幅和参考映射。使用与提交一致的范围与参数，提交携带 expectedPlanHash 和稳定 idempotencyKey；过期预检回读后重新准备，未知提交结果先恢复原幂等键。不擅自换模型、关闭 LoRA/放大、降规格或关闭确认开关来通过检查。

正式镜头 ID、分镜轨顺序/时长、真实节点与 storageKey 必须一致；同图复用保留不同镜头身份。身份参考只继承脸、发型和指定服装，分镜帧只锚定其指定镜头的入镜构图/状态；真实画面与用途需实际查看。修改引用编号时保留完整导演源与逐字对白，用锁定脚本重算相关提示词和回执后再发布，禁止用摘要替代。Backend 核对源稿与正文哈希，并检查镜头覆盖的正式对白是否进入本段。

工作流预计尺寸和归档媒体实测尺寸分别记录，一采和二采按各自规格核对。规格错误或无法测量时保留原媒体与任务，标记失败并停止剩余提交，不替换旧活动成片、不自动返修。参数就绪、已提交、技术收口和用户验收分别报告。

## 连续性边界

对每一对相邻 Segment 写 from、to、tailFrame、motionContext、reason。两项独立决定，不能因同人物/同场景自动开启。

- 尾帧参考：前段开关传给下一段，从成片提取尾帧，追加在原图片最后，保留原编号；传递姿态、持物、位置与动作进度，下一段可换机位。不能把动作重置。
- Motion Context：前段开关传递 AV latent 与音频上下文；按连续组首尾提交，使用 runFromCurrent、skipCompleted=false 和 endSegmentId 限定范围。MP4 不等于可续写 latent；缺 latent 时先明确组首重渲范围。
- 不再使用 previousVideoAsReference，不自动把前段 MP4 当模型输入。用户明确提供的普通视频参考不在此禁用范围。

维持身份、服装或道具可使用专用资产。硬切与时间地点跳转按实际叙事断链；不兼容的尺寸/模型不能强行续写。

## 完成与恢复

保留 prompt-only 与授权执行的区别，自动/逐步模式沿用用户选择，不重复问。图片与关键帧需要实际查看并记录证据；待用户确认不假写 approved。Clip 默认只核对 taskId、终态、媒体可访问性与结果回写，不主动评分、试听、返修或重抽。

恢复先读取 Backend 修订、导演模块游标、本次制作锁定的 Skill/编译脚本版本及原 taskId。提示词产物就绪、媒体已生成、技术自检和用户验收分别记录。局部修改只使依赖项失效，不重算无关目标，也不重做整项目；禁止以摘要替代完整对白、镜头或提示词。
