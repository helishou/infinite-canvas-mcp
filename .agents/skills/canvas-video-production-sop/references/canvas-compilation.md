# 源稿编译与发布

触发：保存制作源稿、编译、发布或局部返修。先遵循[适配核心](acheng-canvas-adapter.md)。

分集与独立画布统一调用 `production_get/production_edit/production_publish`，显式传 `kind:episode/canvas` 与 `id`。通过 `set_director_production` 提交完整导演稿：schemaVersion、engine、source、sourceHash、modules、artifacts、assets、shotInputs、boundaries、workflow、unresolved、executionAuthorized。

新合同局部返修先通过 `production_get` 的 `subject_workbench`、`shot_workbench` 或 `clip_workbench` 读取一个实际目标工作包，再用一次 `production_edit` 合并修改。Subject 索引和图片绑定用 `upsert_director_subject`，解除无引用主体登记用 `delete_director_subject`；原角色登记用 `patch_director_source` 的 `character`，场景用 `environment`，道具用 `asset`。镜头摄影、动作、时长与对象使用修改 Shot，分镜图绑定用 `set_director_shot_keyframes`；连续性用 `edit_director_continuity` 修改唯一台账条目，Clip 重组用 `repartition_director_clips`。Backend 默认登记新合同真实消费者的校验、编译和同步，不再由 Agent 重复手动编译、应用。沿写回执给出的原流程身份查询状态；阻塞只读定位字段，不换 ID 重跑。

新合同镜头增删、复制、排序、拆分和合并使用 `edit_director_shot`，与本镜未保存字段修改合并为一次提交。新增镜头分配稳定 ID；复制只复用摄影与对象设计，不复制对白、事件或关键帧。排序限定当前 Clip，跨 Clip 包装调整用 `repartition_director_clips`。拆镜指定局部整数帧；对白跨切点时默认按已有声音窗分配原文片段，保留逐字内容和声音总时长；textOffsets 仅用于明确调整默认切字位置。听者反应镜头显式选择反应安排，不能把画外说话者变成可见人物。合镜有不同摄影时明确选择摄影来源，有不同主要表演节拍时先设计承接，不能静默丢弃。删除镜头同时删除本镜独占的对白与台账事件，跨镜对白保留其他镜头部分并更新原文覆盖；依赖引用在同一事务清理，历史媒体保留。不要要求用户手动移交每条记录才能删除；删除后的上下游事实矛盾由连续性检查定位，不伪造补全。镜头时长修改同步裁剪既有 Subject 出现范围，完全位于删去时段的出现条目移除；关键帧、定时动作／声音与台账事件局部锚点同步适配时长，稳定 ID 不变。声音窗保留原速度，缩短到对白所需时长以下属于创作冲突，不能用加速或删字掩盖。删除唯一镜头自动删除其空 Clip，清理引用和新相邻边界；不要求再执行另一条删除命令。合镜保留两镜输入资产并集，拆镜和复制不留下错误的结果事件关联。

图片和关键帧选择使用完整 projectId/nodeId，不用节点名称或局部 ID 猜测来源。可选择当前画布智能图片节点及已正式采用的共享来源；未采用的其他项目图片不直接绑定。共享选择保留采用资产 ID，节点引用策略沿既有历史选择规则处理。创建或绑定节点不表示已生成图片，编译不自动提交媒体请求。

旧稿未启用新合同时，沿现有 `patch_director_source`、`patch_director_continuity` 和替换入口兼容；需要单段自动刷新时在同批 ops 显式登记 `request_director_clip_refresh`。只有首次创建或用户明确整稿替换才回传完整导演稿。Backend 保留其他源稿并重算哈希，不能为局部编辑整稿回写。

`patch_director_source` 的 `scene` 修改剧本场次 `script_scenes`，`environment` 修改编译引用的 `scene_registry`，`asset` 修改 `asset_plan`，`asset_card` 修改 `asset_cards` 的提示词与七步正文。环境文字返修须定向检查登记与资产卡中实际被消费的文字，不能把修改资产计划当作已更新环境正文。

旧合同的拆镜返修可用 `replace_director_scene_storyboard` 在现有 `production_edit.ops` 中提交场次 ID、完整本场 Shots、原 Segment ID 集合及对应 shotInputs；保留场次起止帧和其他场次正文，按原剧情顺序顺延同一时间线的 story_order。连续性事件和覆盖用同批 `patch_director_continuity` 保存，边界决定沿现有操作更新。Clip-only 编译不自动包含已明确跳过的关键帧资产；显式指定关键帧目标仍按其完整合同校验。

按对象、snapshot、读取范围和 revision 复用已完整读取的内容；仅核验版本时携带 `ifRevision`，返回 `unchanged` 后继续使用原内容。不能把写回执的新 revision 当成尚未读过的数据版本，也不能把第一页当全集；续页沿原 cursor 完成，不带 ifRevision。冲突或版本改变时只补读任务涉及的章节／目标；任务状态使用 readiness 或精确 runId/taskId 查询。成功写回执已确认保存，nextRead 是缺字段时的入口，不要求保存后整稿回读；编译可直接消费已保存稿。

故事模块产物按当前激活合同写入 `source.story`，节拍由 `story.beats` 消费；分场写 `script_scenes` 并关联真实 `scene_registry`。不自创 `story_beats` 等未被工作台和校验器消费的替代字段。首次新稿保存后回读实际字段归属；模块声明 committed 不代表验证 passed，依据 verifiedStatus 和真实证据区分保存与验收。

source 原样保存 Acheng production 数据。sourceHash 是递归键排序、无空白、UTF-8 JSON 的 SHA-256；MCP 提交完整源稿对象时使用 `production_hash_source`，脚本复用项目导出工具，不另写 canonical 算法或凭记忆拼哈希。artifacts 每项包含独立 prompt 字节、sha256、源哈希、参考标签/节点/storageKey/媒体哈希/职责及编译回执；draft 和 partial 不标 ready。接入包不填造 PASS，正式在线制作由 Backend 执行当前激活版本的编译与校验；明确离线交付时才运行离线编译，不为普通返修重复跑离线和在线两套。

### 编译后由程序承接

Agent 负责编译前的创作和结构化源稿。自动刷新已登记时消费其短回执，不再另发 `production_compile` 或重复应用。明确独立编译或旧兼容流程才调用 `production_compile`，使用稳定 `operationId` 和 `production_get_compilation` 恢复原状态；只有成功后应用 `preparedId`，中断不自动重跑。

编译器与 Backend 的校验回执是编译结果的技术依据。Agent 默认不读取、复查、润色或重写编译正文，也不整段回读 Clip 对照正文。需要调整时修改正式源稿并重新编译，不手工组装正式 Clip 正文、参考编号或引擎身份。用户明确编辑 Prompt 时保留人工稿，仅用 `reverse_sync_director_prompt` 对精确编译基线和 SourceMap 做确定性回写；有歧义保留草稿与诊断，不猜测创作修改。媒体批准与生成授权仍沿既有合同。

准备和应用编译包会自动投影引用，消费短回执的 `referenceSync`；`blocked` 表示缺少依赖、批准媒体、当前编译或存在编辑冲突，不能当作可生成。源稿使用 `sourceSection`、`targetIds` 定向读取；产物默认读取 `artifact_index`。长列表用 `pageSize`/`cursor`，单个长对象显式用 `chunkBytes`；游标过期时从新版本读取，不拼接不同版本。编译诊断与目标索引使用 `view`、`offset` 和 `pageSize`，不回传全量 audit 或正文。

## 编译输入与产物

编译输入是已保存的结构化制作源稿、Shot/Segment、资产资料和实际参考绑定。只有资产时运行 `compile_assets.py`；包含视频片段时运行 `compile_h3.py`。脚本按对应 Skill 规则产出独立、完整的图像或 H3 提示词文件、索引、逐目标诊断、参考映射和哈希回执；缺少依赖的目标保留为 draft，不伪造 ready。Backend 再核对当前制作 revision、媒体归属和执行条件。

脚本不调用媒体模型。源稿、提示词、实际参考或镜头边界变化后重算受影响产物，已生成媒体不会自动重做。

## 编译受阻的定位与恢复

`production_compile` 的请求完成不代表编译成功；消费 `compilation.status`。`queued/running` 沿原 operationId 查询；`blocked/failed/interrupted` 是终态，读取首条 `blockingDiagnostic`，需要全集时分页读取 diagnostics，不继续轮询同一终态。`PROMPT_EXTERNAL_CONTEXT` 表示模型提示词含“同上／沿用前段”等外部文字依赖，不表示缺少前段视频或连续性事实。按 targetId、shotId、path 和 matchedText 定向展开原字段；origin=compiler 时修编译器，不要求导演改创作稿。

相同有效编译输入、范围、参考内容身份和 runtime 的可定位源稿独立性阻塞，可跨操作 ID 返回原阻塞回执。`reused=true` 与 `reusedFromOperationId` 表示本次没有重跑编译器；同 operationId 的 `replayed` 仍表示原命令重放。改变确实影响编译的输入后再提交，不靠换 ID 或扩大范围试错。旧回执没有定位信息时不猜字段，不把单独的 revision 或 sourceHash 变化作为问题已解决的证据。

## 批次复核与回执复用

每场或本次选定范围定稿后，集中复核时长、逐字对白、镜头与表演、声音、参考职责及连续性，再保存源稿并编译受影响目标。不在每项局部修改后重做整项目复核。连续性复核覆盖相关 timeline 的 facts、initial、events、requirements、逐剧本块 coverage 和相邻 Segment 边界；缺口返回对应字段 owner，不用批量“不变”或补造事件填平。时长与边界仍按适配核心和 Clip 参考执行。

| 变化 | 复核及编译范围 |
|---|---|
| 某段提示词源字段 | 该目标；涉及初态、尾态或声音承接时包括受影响边界及依赖目标 |
| 镜头、动作、帧窗或结尾状态 | 所属时间线中受影响镜头及依赖其状态的后续目标 |
| 资产文件、版本或引用绑定 | 实际消费该资产的目标及受影响依赖 |
| 跨场事实或剧情顺序 | 完整相关时间线及受影响跨场边界 |
| 内容及依赖未变 | 查询正式目标状态，复用仍有效的回执和产物 |

检查上下文可以包含上游和后续镜头，但不因此扩大编译输出、发布或生成范围。定稿范围内合并已识别缺项后发起一次编译；只在源稿、依赖改变或真实诊断需要时再次编译，不同时跑离线脚本和在线编译来重复获得同一产物。

复用核对哈希关联，不要求不同对象的哈希数值相等：产物登记的 sourceHash 对应其有效源稿，Clip 正文哈希及有序参考映射对应有效产物，任务冻结输入对应本轮有效目标。同时核对回执适用范围、revision、编译版本和实际参考媒体版本。sourceHash 未变不是单独的复用依据；revision 改变也不由 Agent 自行判定全部失效或手工改回执，以 Backend 的目标有效性和诊断为准。历史产物保留原编译版本，新编译请求使用当前激活版本。

未登记自动刷新的兼容流程沿“保存源稿 → 编译成功 → 应用编译包并检查 referenceSync → 预览发布影响 → 发布”推进，制作写入按 revision 顺序串行执行。消费正式短回执，不再额外逐 Clip 手工同步正文和参考；referenceSync 阻塞时按诊断修依赖。已有有效发布与同步结果直接复用。媒体提交另沿运行参考处理。

## 预检与发布

需要提前收集缺项或预览影响时调用 `production_preflight`，显式传 `kind:episode/canvas`、`id`、`action: edit/publish/compile/generate` 与原正式 `request`。已有自动预检且输入和状态未变时，不额外调用同一预检来重复证明就绪。预检只读，返回 revision、当前激活引擎、已识别缺项的 `code/path/targetId/message/severity`、阻塞运行及 `nextActions`。计划稿缺项可保存；编译、发布和生成按各自阶段检查，人工批次复核不替代这些正式检查。只有故事正文、没有资产卡或视频段落时不要调用编译器；编译预检按当前激活版本检查资产计划、风格参考和提示词卡，并保留合法缺图草案的交付能力。

`production_compile` 和 `*_start_production_run` 在 HTTP MCP 与页面内 Agent 中自动执行同一预检。返回 `status: blocked` 表示条件检查完成、本次没有执行编译或提交媒体，不等于已经生成或得到 preparedId；按 `preflight.diagnostics` 一次补齐已识别缺项，再按 `nextActions` 回读精确对象、运行和任务。相同源稿/revision/运行状态没有变化时，不重复同一请求，不通过换 runId、幂等键或暂停绕过占用。`replayed: true` 的有效预检只允许恢复原幂等回执，不授权新生成。预检通过后正式提交仍重新检查 revision、幂等与媒体归属；网络、引擎故障或提交竞态仍作为真实失败处理，按返回的稳定代码和下一步恢复。

局部返修先用 sourceSection/targetIds 读取目标与 targetStatus；占用时按原运行及 nextAction 处理。按“局部修改源稿 → 编译并检查回执 → 预览发布 → 授权生成”推进；运行恢复见[运行与恢复](canvas-production-runs.md)。
