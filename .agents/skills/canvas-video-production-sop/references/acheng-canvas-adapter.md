# Acheng 与画布的执行适配

## 加载与版本

Acheng Director 本身就是 Skill，完整上游文件和模块位于项目 `.agents/skills/acheng-director`。Skill 规定创作方法；`compile_assets.py`、`compile_h3.py` 及校验脚本是把制作源稿转换成提示词产物的可执行工具，不是另一个导演 Agent 或模型。脚本版本由本机 `skill-runtimes/acheng-director/active.json` 固定；制作开始记录上游 commit、patchVersion、runtimeId、Skill version，恢复时沿用该制作记录锁定的脚本版本。版本缺失或兼容检查失败时停止，不退回旧画布流程。

导演 Skill 的源码位于项目 Git 子模块 `.agents/skills/acheng-director`，`origin` 指向 [helishou/acheng-director-skill](https://github.com/helishou/acheng-director-skill)，跟踪 `main`。新克隆使用 `--recurse-submodules`，已有克隆使用 `git submodule update --init -- .agents/skills/acheng-director` 初始化。源码可直接修改并在子模块内提交、推送到 fork；父仓库只记录子模块提交指针，不代替子模块的提交或推送。

项目命令 `npm run acheng:status` 查看源码 HEAD、未提交文件和活动运行包。`npm run acheng:update -- --local --check` 验证子模块当前已提交 HEAD；去掉 `--check` 后激活该版本。`npm run acheng:update` 验证远端 `origin/main`，成功后仅快进源码并激活运行包；存在未提交改动、领先或分叉的本地提交时拒绝覆盖，使用本地构建或自行处理分支。`--check` 不改变源码 HEAD 或活动运行包，但可获取 Git 对象和创建候选运行包。旧 `acheng:vendor` 命令等同于从当前 HEAD 本地构建，不再覆盖源码。`npm run acheng:rollback` 仅回退固定运行包，不切换源码分支、不丢弃修改。所有命令均不启动媒体生成。

Canvas 兼容层仅应用于候选运行包，不写回源码。Docker 镜像通过显式 `ACHENG_SOURCE` 使用持久卷中的可写 Git 克隆，其他校验与运行包行为一致；不因开发子模块缺失而退回隐藏源码副本。

### 编译后由程序承接

Agent 负责编译前的创作、源稿编辑、依赖与批准版本登记。`production_compile` 携带稳定 `operationId`，立即返回后台编译状态；沿同一 ID 使用 `production_get_compilation` 查询，超时不能换 ID 重提。只有 `succeeded` 才应用 `preparedId`，其余状态按分页短诊断处理；`interrupted` 已确认未完成，不自动重跑。

编译器与 Backend 的校验回执是编译结果的技术依据。Agent 默认不读取、复查、润色或重写编译正文，也不整段回读 Clip 对照正文。需要调整时修改正式源稿并重新编译，禁止直接编辑正式 Clip 的编译正文、参考或引擎身份。媒体批准与生成授权仍沿既有合同。

准备和应用编译包会自动投影引用，消费短回执的 `referenceSync`；`blocked` 表示缺少依赖、批准媒体、当前编译或存在编辑冲突，不能当作可生成。源稿使用 `sourceSection`、`targetIds` 定向读取；产物默认读取 `artifact_index`。长列表用 `pageSize`/`cursor`，单个长对象显式用 `chunkBytes`；游标过期时从新版本读取，不拼接不同版本。编译诊断与目标索引使用 `view`、`offset` 和 `pageSize`，不回传全量 audit 或正文。

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

正式提交前调用 `canvas_preflight_production` 或 `drama_preflight_production`，传所属 ID、`action: edit/publish/compile/generate` 与原正式 `request`。预检只读，返回 revision、固定引擎、已识别缺项的 `code/path/targetId/message/severity`、阻塞运行及 `nextActions`。计划稿缺项可保存；编译、发布和生成按各自阶段检查。只有故事正文、没有资产卡或视频段落时不要调用编译器；编译预检按固定版本检查资产计划、风格参考和提示词卡，并保留合法缺图草案的交付能力。

`production_compile` 和 `*_start_production_run` 在 HTTP MCP 与页面内 Agent 中自动执行同一预检。返回 `status: blocked` 表示条件检查完成、本次没有执行编译或提交媒体，不等于已经生成或得到 preparedId；按 `preflight.diagnostics` 一次补齐已识别缺项，再按 `nextActions` 回读精确对象、运行和任务。相同源稿/revision/运行状态没有变化时，不重复同一请求，不通过换 runId、幂等键或暂停绕过占用。`replayed: true` 的有效预检只允许恢复原幂等回执，不授权新生成。预检通过后正式提交仍重新检查 revision、幂等与媒体归属；网络、引擎故障或提交竞态仍作为真实失败处理，按返回的稳定代码和下一步恢复。

用 `node scripts/acheng/export-canvas.mjs production.json canvas-mapping.json <新输出目录>` 调用本次制作锁定的 Acheng 编译脚本，生成包含完整提示词产物与回执的 `director.json`。mapping 包含 assets、shotInputs、boundaries、modules 与按 targetId/label 索引的 references（nodeId/storageKey/role）；首次使用当前激活版本，恢复时传入原运行 `engine.path`。该命令只处理离线文件，不调用画布或图像/视频模型。

导出前检查源稿契约，导出目录保留 `preflight.json`；提示词长度、阻塞项与格式验收保存在产物回执诊断中。已有文件可用 `node scripts/acheng/preflight.mjs director.json edit` 检查，也可选 `publish` 或 `generate`。离线检查使用同一锁定版本的编译/校验脚本，但不证明在线 revision、模型和媒体归属，`generationReady` 保持 false。脚本使用已构建的共享包；运行前设置真实可执行的 `ACHENG_PYTHON`，不要依赖 Windows Store 的占位命令。

离线命令也接受 `{action,request,production?}` 的正式请求文件；`production` 可传 Backend 读取到的制作记录快照。操作 schema、源稿 patch 和锁定版本的脚本规则与 Backend 共用；需要在线对象、媒体或模型上下文的操作逐项标为 `unverified`，不能用离线快照替代在线提交检查。

修改导演源码后先在子模块内提交，再使用 `npm run acheng:update -- --local --check` 验证该 HEAD，使用 `npm run acheng:update -- --local` 激活。仅重建 Canvas 兼容层时沿用当前源码 HEAD；旧不可变运行版本继续保留。此操作不改制作稿、不提交生成。

source 原样保存 Acheng production 数据。sourceHash 是递归键排序、无空白、UTF-8 JSON 的 SHA-256；脚本使用项目导出工具，不能凭记忆拼哈希。artifacts 每项包含独立 prompt 字节、sha256、源哈希、参考标签/节点/storageKey/媒体哈希/职责及编译回执；draft 和 partial 不标 ready。接入包不填造 PASS，先执行本次制作锁定版本的真实离线编译与校验，再由 Backend 核对源与媒体。

Backend 已发布版本是正式源，本地 production.json 是带 revision 的工作副本。修改需稳定 operationId 和 expectedRevision；冲突回读，不覆盖他人草稿。剧本、镜头和 Clip 视图是投影，修改应进入导演源；源变化后重跑锁定版本的提示词编译/校验脚本并更新对应回执，旧产物不能作为当前版本执行依据。模型选择继承现有配置；保存草稿不生成。

assets 映射保存实际 nodeId、assetId、storageKey、sha256、version 和批准证据。每张图一项主要职责并写保留/排除范围；真实文件不存在时只能交草案。正式引用须通过真实媒体检查，不把任务成功当批准。完整资产提示词按依赖准备，H3 编译必须满足原资产门禁。

智能节点生成复用原 ID 与结果槽，保持 position/尺寸/layout；同名节点按精确 ID 操作。每次提交保存真实 taskId，超时查原任务，不重复付费提交。任务、日志、归档媒体、活动节点绑定需要对应；原结果保留。

## 导演工作台对象工作区与运行接口

导演工作台按制作对象展示「总览、故事、风格与资产、镜头与片段、生产与交付」，JSON、旧稿接入、引擎和版本恢复集中在高级与历史。七模块仍是内部职责；不要把页面标签、partial 或模块顺序解释为必须依次通过的生产关卡。首页、独立画布和单集入口引用同一 Backend 制作记录。

产品导航分为「制作」和「画布」。制作先进入剧目总览，确认全剧规划及分类图片模型、视频模型与画幅，再由用户选择分集进入固定制作画布；共享资产画布作为剧目级独立入口显示。普通画布直接使用原生节点与生成，不自动进入制作 SOP。历史独立制作链接保留显式兼容访问。每集一张制作画布，每剧目一张共享资产画布，场次只做目录与分组；首次准备画布不授权生成，已开始制作的分集和已提交任务保留原设置。

创意对话确认对象后，先保存 brief 与 `workflow.currentWork`，回读 Backend `workflow/readiness`，再通过 `site_navigate({ production: { kind, id, workId, runId? } })` 呈现正式画布目标；无节点时打开对象编辑面板。需要节点时用 `production_prepare_targets` 幂等准备 asset/frame/segment，不把准备或跟随视为生成授权。推进同一制作沿用 workId；待决定项绑定源哈希，用户答复先保存再继续，不凭聊天文字或同名节点推断导航位置。

为每项资产在源稿中保存 `canvas_scope`：全剧可复用的风格母图、主要角色、常驻场景和道具设为 `shared`；单集造型、镜头关键帧和临时构图设为 `episode`。新制作按实际复用范围决定，不按资产名称猜测。缺少此字段的旧稿沿原分集生产路径兼容。共享资产必须在共享画布自己的正式制作记录中准备、编译、生成和审核；不可在分集画布生成后直接把它当成共享资产。已有分集素材只有处于本集发布版、真实媒体哈希匹配且已批准时，才可从资产卡“接入已有审核素材”；先读取来源与共享目标版本，在确认窗口后沿 Backend 事务接入同一归档媒体，保存来源分集、原节点、原任务及审核证据，不重新生成。接入后分集调用 `production_get_shared_assets`、`production_adopt_shared_asset` 采用当前批准版本，再重新编译受影响提示词。Backend 按当前 production owner 校验归属；共享画布拒绝本集资产、关键帧和视频 Clip，分集拒绝未采用的共享资产。新批准版本持久传播到采用方；相同媒体与参考语义只更新归属时保留旧媒体有效状态，实际输入变化则保留历史并标记下游过期。在冲突时回读草稿及更新原因，再按原 adoption ID 恢复。画布权威和版本边界见画布数据契约，跟随与手动接管见画布交互约束。

早期 brief 和 partial 可保存，且不要求先创建全部画布节点。首次需求使用 `set_director_brief` 写入 `source.brief`；常见场景、风格策略、资产、Shot 与 Segment 编辑使用 `patch_director_source`，只改声明的源字段并保留其他 Acheng 字段；边界用 `set_director_boundary`，工作模式、稳定 workId、currentWork 和待决定事项用 `set_director_workflow`，资产节点映射用 `bind_director_asset`。完整模块回包仍可使用 `set_director_production`，但常见 UI 编辑不能整稿覆盖。`currentWork` 绑定源 revision/hash；用户决定卡绑定同一 workId 和源哈希，答复先保存再交回导演。

通过 `workflow/readiness` 或 MCP `*_get_workflow_readiness` 查询按目标依赖计算的缺项、待审核项、可执行范围和正式 `presentation`。无关模块的 partial 不应拦住已就绪分支。Agent 推进当前目标时更新 `workflow.currentWork` 并回读展示投影，再使用结构化 `site_navigate` 呈现工作区或实际节点/Clip；普通页面跳转保留原 `path` 入口。改过 source、提示词输入、实际参考映射或边界后，须用该制作锁定的 Acheng 编译/校验脚本重算受影响产物，再由 Backend 检查并发布；只改工作游标或内容交付/媒体生产设置不需重跑提示词编译脚本。发布只冻结正式 revision，不提交生成。

内容交付模式为自动文件批处理或逐 Segment 互动；媒体生产模式为仅提示词、逐项生成或按依赖自动生产。只有用户点击生产目标，或调用 `*_start_production_run` 时才授权媒体生成。每批使用稳定 `runId`/`idempotencyKey`，保存范围、发布版本、设置、引擎和 taskId；重复请求返回原批次。自动范围在审核后继续同一 runId 时，只扩展至当前依赖刚就绪的目标；逐项范围不扩张。`*_pause_production_run` 在当前任务边界暂停，`*_resume_production_run` 继续相同 runId；失败或退回的目标不能因恢复而重新提交，重生成须明确新开 runId。

生成成功的图片/关键帧仍是待审核。`review_director_asset` 必须绑定发布版本、项目节点、归档 storageKey、媒体摘要和审核理由；Backend 自己校验实际文件后才将资产或关键帧标为 approved/rejected。未批准的依赖只阻塞其下游目标。旧稿在兼容区原样查看，接入 Acheng 时只补本轮缺项，不能自动重做历史媒体。

### 关键帧参考核对

编写或修改关键帧前，逐镜对照完整画面描述登记出场对象，包含前景、远处和背景中明确身份的角色，以及场景、道具和风格参考。对齐 `shots.required_assets`、`shotInputs.assetIds`、关键帧资产的 `depends_on` 与编号 `asset_cards.references`；身份图只保留登记特征，参考卡明确 preserve/exclude。画面正文新增对象时重新核对，不能把未入镜的身份图缺失当作纯显示问题。程序校验登记清单的覆盖，不能可靠发现自然语言中的所有漏登角色；这一步由导演逐镜核查。

正式图片沿 `production_prepare_targets` 准备，回读 Backend 的正式图片输入投影及参考连线后再提交；缺失、过期或顺序不一致时先修正式源并重编译。不能另拼临时 references 掩盖空面板，也不能把生成结果自身或角色节点的全部服装图混入编号参考。画布增删/排序参考会回写正式源并使编译过期，已有任务继续使用自己的冻结清单。

### 图片并发调度

- 用户授权多张资产图或关键帧后，从正式 readiness 和资产依赖中找出授权范围内的 `ready` 目标，先提交这些目标，再统一跟踪结果。共同依赖同一已批准风格母图或角色图的目标可并发；风格母图、身份或服装参考尚未批准，只阻塞消费它的下游，不阻塞其他已就绪分支。任务成功不代替审核，不能为并发虚写 approved 或删去依赖。
- 当前 Backend 的单个 run 会等待一张图片结束才提交下一张，不重叠目标的不同 run 可同时推进。新图片请求为每个就绪目标建立独立、稳定的 `runId`/`idempotencyKey`，通过 `*_start_production_run` 使用单目标 `targets` 和 `scope: selected`；收到启动回执后继续提交下一个独立目标，不先轮询当前任务终态。独立运行不使用 `all_ready` 自动扩展，以免后续范围与其他运行重叠。已有运行保持原范围，不拆分、暂停或换键重提。
- 制作写入与运行启动按顺序提交，不能用同一个旧 `expectedRevision` 并发写同一制作记录。每次启动前回读当前 revision、发布版本和目标状态；携带 `workId` 时先沿同一 workId 把 `currentWork` 指向该目标，再用更新后的 revision 启动。游标展示一个当前目标，多任务进度以各自正式 run/task 记录汇总，不能把最后一个游标当全部任务。
- `mediaProductionMode: per_item` 限制每个 run 的目标数量，不代表多张图片必须逐张等待。用户明确选择逐项确认或单张试跑时才按该节奏推进；`prompt_only` 不提交媒体。保持用户授权范围和现有模式，不为实现并发改成自动全项目生产。
- 各目标保留独立回执和 taskId，提交阶段结束后统一回读运行/任务并查看已完成图片。某目标缺依赖、待审核、被占用、失败或回执未知时，只处理其原运行及受影响下游，继续推进无关就绪目标；只有全局源稿/编译版本失效等共同阻塞才停止同源后续提交。按已批准输入重算受影响提示词、发布并回读 readiness 后，启动下一批刚就绪目标。实际并发由模型渠道与执行器已有容量控制，不提高并发上限、不绕过队列、不重复付费提交。

例如：风格母图未批准时先生成母图；批准后，依赖母图的角色 A、角色 B 和场景可同时启动；角色 A 的新服装图等待角色 A 批准，角色 B 或场景不为这条服装依赖等待。

### 制作画布布局

布局位置由 Backend 持久化的整批布局计划决定，Skill 不自行计算坐标、不在节点创建后批量补排。正式目标登记后调用 `production_prepare_targets`，并读取响应顶层 `layoutReceipt` 中的 planHash、算法版本、创建/复用节点和冲突诊断。资产按用途进入资产区；剧本按正式场次顺序排列；镜头图片与提示词及场次组保持关联；共享同一 H3 节点的多个 Segment 只占一个单元。缺少参考、待审核或尚未生成的目标也预留位置，依赖状态和生成完成顺序不改变坐标。

Backend 将已有节点的真实位置与尺寸作为固定锚点，新目标只在所属区域分配空位；用户移动/调整的节点不被挪动。保存文案、审核状态或任务进度不触发布局变化；新增目标只扩展其预留位置。只有布局回执报告身份或占位冲突时，按正式目标 ID 和诊断继续处理，不按名称猜关联，也不以普通画布 ops 覆写编译位置。用户明确要求整理当前画布时，才另行按指定范围执行整理。

同目标新运行被旧 runId 占用时，先用 `*_get_production_batch` 回读精确运行及 taskId。暂停只保留原运行，不结束它，也不释放目标；不得以“暂停后换新 runId 再试”处理占用。旧运行处于 `awaiting_review` 且媒体任务成功时，先查看真实结果，沿用则完成审核，用户要求重做则用正式审核操作退回并记录原因；回读确认无在途任务且旧批次已结束后，才在已有生成授权范围内启动新 runId。在途任务保持占用，不重复提交，不自行批准媒体或扩大生成范围。

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
