# 画布 MCP 调用清晰度与成本优化方案

状态：P0、P1a、P1b、P1c、P2 已实现并通过定向验收；P3 按用户明确要求将 schema=compact 推广为新连接默认，schema=full 保留完整声明；P4 增加源稿顶层字段读取并完成受控验收。范围：工具契约、读取投影、调用指引、恢复建议和可观测性；业务编辑、生成授权、媒体归属与幂等语义继续沿用现有权威入口。

默认推广的源码、共享产物及隔离 HTTP/stdio 测试已完成；本轮现场仍有两个 H3 任务运行，常驻进程的默认 schema 仍为 full。开发重载器的空闲保护会延后加载，任务结束后应重新初始化连接并以实际 tools/list 和 runtime.schemaMode 确认，不能把源码和构建通过写成现场已生效。

P5 收口：此前列出的 5 项旧测试失败已按当前合同修正，另外修复可定位源稿阻断与无产物诊断并存时的回执复用。扩展编译测试中的旧节点绑定断言已改为明确传入编译实际使用的选项，并保留默认严格校验及当前引用拒绝路径。生产读取/合同 41 项、HTTP MCP 40 项、编译回归 23 项通过。临时数据库的编辑、编译、应用、读回链路通过，但编译器为受控测试替身，尚不能作为真实运行服务或真实项目端到端验收。

当前固定夹具结果：同一角色节点原完整读取 126,704 字节，media 投影 657 字节，均为一次 MCP 调用；10 个已知 Clip 的配置读取、原子写入与核验共 3 次业务调用，完整 MCP 返回合计 13,405 字节。属于临时数据、受控夹具结果，不代表历史真实生产任务的实测降幅。常驻 Backend 已通过实际 tools/list 确认新 schema，并通过 context/summary 只读现场调用；无手动重启或真实媒体生成。

验证记录：相关测试 73 项通过，共享包与 H3 插件构建、Backend 类型检查通过。扩展 mcp-http 回归的旧制作格式编译夹具和超长目录标题旧预期仍失败，使用 HEAD 版 mcp.ts 配合当前依赖复现，不归为本次新增失败；没有通过放宽业务校验或取消标题摘要处理这些基线问题。

第二批受控测量：full 156 项/212,601 字节；canvas 77 项/88,197 字节；h3 76 项/125,118 字节；production 105 项/148,020 字节；diagnostics 51 项/46,878 字节。首次 tools/list 加同一媒体读取均为 2 次调用，返回总量分别为 213,013、88,609、125,530、148,432、47,290 字节；同会话复用后均为 1 次读取/412 字节。该基准不计初始化握手，且不代表模型实际计费；并行测试的单次时间不作为提速承诺。第二批相关测试 33 项通过，覆盖工具集刷新/隔离、旧 Backend 投影兼容、读取指纹与聚合、字节/估值语义及操作回执。

第二批现场验收：常驻服务的五种工具集数量与字节数均与受控目录一致，报告 runtime.profile 与连接选择一致，efficiency 已可读取。对真实画布执行目录读取及两次同范围 summary 查询，新增指纹覆盖 3 次读取并识别 1 条同版本重复候选；只读操作没有提交媒体或更改用户连接配置。P3 尚无模型实际加载/计费及参数正确率的对照证据，继续保留完整操作 schema。

## 1. 问题与证据

本方案依据本次会话读取的实际 HTTP `tools/list`、MCP 聚合埋点和当前源码。数字是本次采样基线，不是产品常量；实施时用同一夹具重新采样。

| 证据 | 本次结果 | 解释边界 |
| --- | --- | --- |
| HTTP 工具目录 | 156 项，序列化后 211,231 UTF-8 字节 | 客户端可能延迟发现，不代表每轮都注入全部定义 |
| 参数 schema | 合计 153,258 字节 | 约占目录 73%，仅缩短描述收益有限 |
| production_edit 定义 | 48,395 字节 | 大量操作分支与嵌套源稿合同占用目录 |
| 埋点日期 2026-10-27 | 625 次完成、28 次失败、8,817,903 输出字符 | 包含历史加载版本和不同任务，不能作为当前版本的受控实验 |
| 当日 canvas_get_state | 61 次，平均约 101,343 输出字符 | 估算累计约占当日输出七成；尚不能把所有大返回归因于默认目录 |
| 相邻同名调用 | h3_get_clip 55 对、production_get_source 39 对 | 可能是不同目标或分页，不能直接认定浪费 |
| 埋点日期 2026-10-28 的审查前样本 | 7 次完成 | 样本不足以评价改善幅度 |

当前已经具备：目录摘要、正文分页/分块、部分条件读取、批量写入、操作回执、精确任务 ID、有界等待及任务事件流。优化从这些能力的使用路径入手。

## 2. 设计决策

1. 保持 Backend 业务权威和单一编辑源；新增参数优先落到现有工具。
2. 先降低完成同一任务的总返回量与总调用数，再评价单个响应。
3. 轻量读取只返回明确声明的投影；完整内容保留受支持的读取路径。
4. 正式源稿改动进入 production_edit；画布技术配置或明确人工 Prompt 编辑走其现有入口。不能为省调用直接修改派生结果。
5. 不新增通用自然语言路由器、隐式自动生成、业务缓存层、锁或审批状态。
6. 本轮设计不调整产品超时、重试、输出上限、生成并发上限。下文百分比是固定夹具的验收目标，不是运行限制。
7. 所有新参数、精简目录和接口示例在实施前均为提案，不能用于当前已部署工具。

## 3. 先统一“何时调用哪个工具”

### 3.1 标准路径

| 用户意图 | 主入口与步骤 | 可省掉的操作 |
| --- | --- | --- |
| 已知节点，查看基本信息或媒体 | canvas_get_state 的显式轻量投影 | inspect、整图、完整 metadata |
| 不知道 H3 Clip ID | h3_get_node 一次取得稳定 ID | 为每个 Clip 重新列时间线 |
| 看 Clip 已保存字段 | h3_get_clip(fields) | 编译正文、预览、完整节点 |
| 看 Clip 已保存参数 | h3_get_clip(include:runtime) | 生成预览 |
| 检查 H3 实际运行输入 | h3_preview_run，与提交相同范围/参数 | 再跑同输入的 canvas_validate_generation |
| 修改正式 Shot/对白/连续性 | 定向源稿读取 → production_edit 的局部操作及必要 refresh → 原 operationId 查询编译结果 | 重读整稿、重新 hash_source、手工覆写派生 Prompt |
| 修改多个独立 Clip 的画布配置 | 批量定向读取 → h3_update_clips → 批量定向核验 | N 次单段提交及逐段重查时间线 |
| 提交正式制作运行 | production_start_run 在权威边界检查当前输入 | 例行 production_preflight 和全局质量检查 |
| 已提交媒体任务 | canvas_wait_tasks 等待本轮 taskIds | 在多个任务查询入口之间切换 |
| 提交结果未知 | 原 operationId 回执或原幂等请求恢复 | 更换 ID 再提交 |

普通源稿编辑成功不等于编译、应用或媒体生成成功；各阶段仍按实际回执报告。

### 3.2 指引归属

- `.agents/rules/mcp-contracts.md` 保留跨入口不变量。
- `native-mcp-operation-budget.md` 维护标准调用路径，并按具体提交入口区分预览要求。
- `canvas-agent/agent-instructions.md` 只引用当前路径并保留必要的运行期简述，不复制整套流程。
- 工具 description 只写适用场景、默认返回、必要前置条件和替代入口；完整示例与长说明按需读取。

删除跨域“一律四步检查”的绝对要求，改成入口表：production_start_run 自带权威校验；H3 运行使用其现有 planHash 预览；图片清单要求沿图片契约。已取得且仍适用的目录、合同和输入检查结果直接复用。

## 4. 节点读取投影

### 4.1 扩展现有 canvas_get_state

新增可选参数：

```ts
projection?: 'summary' | 'media' | 'generation' | 'full';
includeConnections?: boolean;
```

projection 仅与 nodeIds 配合使用；不向 index/graph 目录混入节点正文。第一版不引入任意 metadata 路径和通用 JSONPath。

| 投影 | 内容 | 明确排除 |
| --- | --- | --- |
| summary | 身份、标题、节点类型、与该节点相关的简短状态 | prompt、模型目录、参考正文、任务历史 |
| media | summary 加当前权威活动媒体的 storageKey、媒体类型、已有尺寸等元数据及来源身份 | base64、历史结果集合、生成输入快照 |
| generation | summary 加当前节点已保存的模型/模式及声明支持的配置 | Prompt 正文、参考集合、编译结果、预览 |
| full | 当前完整节点数据 | 不隐式扩展整个项目或历史库 |

角色、场景、道具的活动图必须从既有权威选图逻辑派生，不能统一读取可能过期的顶层 storageKey。对不支持某投影的节点返回明确 unsupported/missing 信息，不能猜测字段。

兼容矩阵：

| 请求 | 返回行为 |
| --- | --- |
| 没有 nodeIds，没有新参数 | 保持现有 index/graph 分页 |
| 有 nodeIds，没有新参数 | 保持旧完整节点与相关连线行为 |
| 有 nodeIds，显式 projection | 使用新投影，includeConnections 默认 false |
| 仅显式 includeConnections | 节点沿旧语义，连线按显式值返回 |
| 无 nodeIds 却传 projection/includeConnections | 返回字段级输入错误，指向支持的组合 |

新投影回执增加 `projection`、`requestedCount`、`returnedCount`、`missingNodeIds`。保留现有版本、身份与计数，不为统一外观包裹第二份数据。

提案示例，当前部署尚不支持：

```json
{
  "projectId": "<project-id>",
  "nodeIds": ["<node-id>"],
  "projection": "media",
  "includeConnections": false
}
```

超限沿用当前上限。新显式 full 不以摘要冒充完整结果：返回已有超限错误与可执行的专用正文/导出入口。旧 metadataTruncated 行为为兼容保留。分页和分块仍需读完，不静默遗漏。

### 4.2 Backend 到 MCP 的实现位置

共享 schema 与投影属于 canvas-agent；Backend 项目读取 API 显式接收新投影，仅在请求该投影时使用，网页未传参行为保持原样。

优先扩展现有 `/canvas/projects/:id` 的 nodes 读取和选择性快照，不另建节点查询服务。Backend 到 MCP 也只传必要数据。若底层 JSON 存储仍须解析局部快照，如实记录成本，不能把响应变小称为数据库读取已等比例下降。

相关源码：

- `canvas-agent/src/canvas/schemas.ts`
- `canvas-agent/src/canvas/state-summary.ts`
- `canvas-agent/src/runtime/backend-client.ts` 及实际读取客户端
- `backend/src/mcp.ts`
- `backend/src/server.ts` 的项目读取分支和对应 store/DB 查询
- Agent 兼容读取入口

### 4.3 inspect 轻量模式

新增 `view: 'context' | 'full'`，不传保持现有 full；新标准路径使用 context。

context 只包含选定项目、revision、真实选区和必要计数；能力目录通过现有 models_list 按需读取。选区不从前 nodeLimit 条节点筛选，独立按选区 ID 读取。

full 暂时兼容原有 referenceCandidates、generationTargets 和 capabilities。后续是否改变默认值，要根据直接消费者与受控测量另行决定。

## 5. H3 读取收口

### 5.1 分清保存值与预览值

推荐常规入口为 h3_get_clip：保存正文使用 fields，保存参数使用 include:runtime，编译后的引用使用 include:references。

现有 h3_get_clip_runtime 会额外调用 previewH3Generation。扩展它的 `view: 'saved' | 'effective'`：不传保持旧 effective；显式 saved 只读保存值。描述明确两者成本和语义。新调用路径优先使用 h3_get_clip(include:runtime)，减少专用入口选择。

effective 返回现有预览身份；只有范围、参数和依赖符合提交要求时才能复用。不能把单 Clip runtime 查询得到的预览当成多个 Clip 的运行计划。

### 5.2 一次读取多个 Clip

扩展 h3_get_clip，segmentId 与 segmentIds 二选一。单项返回保持原状，多项返回 items 与 missingSegmentIds；重复 ID 去重并保持首次请求顺序。

第一版批量范围为已保存摘要、fields 和 include:runtime，不做批量编译全文及动态历史结果。批量传 include:prompt/references/result 时返回精确的不支持组合和已有单段入口，避免把 N 份大正文合成一次溢出。

读取同一项目/节点的一个一致快照再投影全部目标；不能在 MCP 内循环 N 次完整项目请求。必要时扩展既有 H3 上下文读取参数，复用依赖解析。正常目录与批量返回沿用输出保护；超限给出可复制的分组读取建议，不新增数量上限。

### 5.3 编译输出

include:prompt 当前会带来 semantic/compiled 内容。需要编译正文时优先已有 h3_get_clip_prompt(view:compiled) 的分块读取；只改保存正文时用 fields:prompt。

暂不重做全部 Prompt 返回结构；先用清晰描述和现有参数消除双份正文。是否增加新的编译正文选择参数，依据后续实测决定。

## 6. 生产稿与任务路径

production_get_source 已有 sourceSection、targetIds 和分块；第一阶段调整调用指引，普通局部编辑直接使用已有局部操作与服务端哈希计算。

production_edit 的编译同步回执保留 owner、operationId、目标状态和 production_get_compilation 读取入口。该入口已经能汇总一次编辑登记的多个返修目标，调用方不逐目标重复查询。

任务查询首选 canvas_task_status 精确 taskId，等待用 canvas_wait_tasks。h3_get_task、comfyui_get_task 和 generation_get_status 保留各自的兼容/诊断/历史输入用途，描述写清差异，不强行合并不同任务身份。

等待已是事件流优先，继续复用；本轮不新增另一套 watch 工具，也不调整等待默认时间。compile operation 不是媒体 taskId，不能交给 canvas_wait_tasks；它继续通过 production_get_compilation 查询 queued/running，终态 blocked/failed 停止相同输入轮询。

对编译状态查询的事件等待扩展列为后续候选：只有埋点证明其轮询成本明显时，再设计现有查询工具的有界等待，不预先增设队列或状态机。

## 7. 错误恢复必须可执行

复用现有 suggestedAction/nextRead/next 字段，不为统一命名复制三份建议。内部共享构造函数返回一个主要下一步，附简短原因。

| 情况 | 下一步 |
| --- | --- |
| 制作产物 target 不存在 | production_get_artifact_index，复制原 kind/id 和有效 snapshot |
| Clip 不存在 | h3_get_node，复制精确 projectId/nodeId |
| 制作字段实际冲突 | 定向读取原 owner 的受影响对象；缺少对象定位时才退到制作摘要 |
| 节点不存在 | 原项目目录或精确对象读取，不默认扩大到模型目录与整图 |
| 提交超时/结果未知 | 原 operationId 回执；生成沿原幂等身份恢复 |
| 被任务占用 | 原 taskId 的等待/查询入口 |
| 输出超限 | 返回该工具实际支持的投影、分块或分页参数 |
| 当前工具集不含建议工具 | 返回目录/profile 的配置说明，不反复建议不可用工具 |

缺少必要身份时返回 missingContext 与需要的字段，不能构造空字符串或编造 ID。修复当前 artifactTargetMissing 分支把 projectId 传给要求 kind/id 的工具的问题。

schema 错误包括字段路径、允许枚举/必要字段和一条最小修正提示，不回显整份输入、完整合同或媒体正文。所有可构造的 suggestedAction 在相关测试中用目标工具 schema 校验；不在每次实际调用增加一轮网络预检。

幂等恢复与业务失败分开：确定未执行的输入错误修正后提交新意图；结果未知先恢复原操作。不能将两者统一描述为“换 ID 再试”。

## 8. 工具目录与大 schema

### 8.1 先改描述和推荐路径

所有工具 description 使用相同顺序：适用任务 → 默认返回 → 必需的前置条件/副作用 → 详情/替代入口。只有确实有歧义的工具写替代入口，避免每条描述堆全部工具名。

生产长操作说明继续由 production_get_contract(operationType) 提供。description 不重复完整操作清单和大型示例；保留用户必须知道的权限与提交边界。

### 8.2 可选精简工具集

已增加显式 session 工具集选择，连接形式为 `/mcp?profile=h3`；客户端通过其支持的 MCP URL 配置选择。

提供 profile：full、canvas、h3、production、diagnostics。不传仍为 full。profile 在 session 初始化时固定，后续请求使用同一 session，不能被另一个客户端或页面切换。

每个 profile 包含其任务闭包：业务工具、必要目录/读取、回执恢复和任务等待。正式源稿关联的操作必须包含其 production 编辑依赖。不能仅按名称前缀过滤。

分类只在共享工具元数据维护一份，Backend 与插件注册消费同一选择策略；插件热刷新也执行该策略。未分类第三方插件默认在 full 提供，显式 profile 中不自动暴露未知工具，也不能因刷新泄漏额外目录。

工具集选择只决定会话提供的能力集合，不替代授权。各 profile 仍访问相同 Backend、相同事务与回执，不新建业务实例。不注册的工具返回明确不可用原因；所有恢复建议验证目录闭包。

无需在对话中增加“切模式”的必经步骤。已有客户端可按需发现时先复用其能力；profile 是安装/连接配置选项。客户端不支持时保留 full。

### 8.3 production_edit 精简 schema 实验

先测量：完整定义被客户端实际加载几次、任务是否用到整稿操作、首次合同发现会增加多少往返。目录 47 KiB 不是足够的单独决策依据。

实验阶段先以 opt-in 方式验证：顶层身份、operationId、expectedRevision 和 ops[].type 保持明确 schema，操作体细节通过精确 operationType 合同获取；Backend 继续使用完整校验，未知字段沿 canonical 契约处理，不合法操作仍拒绝。

完整 schema 模式和 REST 不变。简化声明必须明确指向详细合同，不能声称工具目录已包含所有约束。禁止创建第二份手写业务 validator；公开精简外壳从现有合同与操作元数据派生，未知字段继续沿所属 canonical schema 的既有策略处理，不在精简容器中提前剥离。

原方案提出在冷启动和复用两组成本均下降且正确率不退化时推广。现用户明确要求全部新连接默认使用 compact，因此已实施；当前仍没有模型端 token/正确率对照，首次陌生操作会增加合同读取。需要完整声明时可使用 schema=full。

精简声明已成为新连接默认，不改变 profile 工具成员，也不增加工具。声明从 canonical operation schema 逐字段派生，保留操作名、外层必填字段、标量约束、原始数组界限和请求身份；复杂对象只声明容器，不剥离其嵌套输入。提交沿原 production_edit 完整解析及 Backend 事务，嵌套错误给出精确 operationType 的合同入口。schema 模式固定到会话；原 operationId 可跨模式恢复原回执。

第三批受控 settings 编辑：production_edit 定义从 48,395 降至 17,873 字节，production 工具集从 148,020 降至 117,498 字节。首次含目录发现、复杂操作合同查询（仅 compact）、编辑及核验：full 为 3 次/149,395 字节，compact 为 4 次/121,183 字节；合同已读后的编辑及核验均为 2 次/1,364 字节。字节下降伴随首次额外查询，复用阶段无请求量或返回量下降；用户已明确决定推广，不推断模型计费或参数正确率改善。

合同枚举测试还发现 request_director_shot_refresh 缺少 shotIds 示例，导致对应单操作与完整合同查询失败。补齐该合法示例后，全部操作示例均可按原完整合同解析，且精简声明往返后的最终校验值与原模式相同。环境/资产卡缺失对象的既有断言失败已用 HEAD 版 production-validation.ts 配合当前 canonical 合同复现，未借此修改源稿 patch 语义。

第三批现场只读验收：production + compact 的实际目录为 117,498 字节，production_edit 为 17,873 字节。单操作合同读取成功，set_settings 为 2,543 字节、patch_director_source（含字段白名单）为 5,405 字节、set_director_production 为 19,124 字节、request_director_shot_refresh 为 1,023 字节。未在真实制作稿上提交实验编辑；实际写入与跨模式回执重放仅在临时数据库夹具验收。

第三批验证：19 项定向测试通过，包含 5 项新增实验测试；共享包构建和 Backend 类型检查通过。扩展合同测试当时为 21 通过、1 项上述既有环境/资产卡断言失败，已在 P5 收口。完整与精简模式的实际 runtime.schemaMode、目录成员、定义字节数已分别核对；当时默认模式未改变，现已按用户明确要求改为 compact。

## 9. 版本复用与埋点

### 9.1 第一阶段复用现有机制

沿用现有 ifRevision，但只能复用相同对象、snapshot、投影、字段和筛选范围的完整已读结果。分页中途、查询范围改变、只持有写回执 revision 时都不能据此跳过内容。

H3 结果和任务状态属于动态查询，不以源稿或画布 revision 命中为由返回旧状态。合同复用以工具 schema/引擎身份变化为边界；不能跨重载后无条件复用旧合同。

暂不新增读取缓存服务、每目标数据库版本或 readToken。目标级内容哈希条件读取仅在证明无关修订造成大量重复全文后，再以现有源哈希为基础单独设计。

### 9.2 在现有可观测性中增加字段

优先扩展当前 inputSummary/outputSummary JSON，不为优化指标新增业务表或改历史存储格式。

| 字段 | 用途 |
| --- | --- |
| requestFingerprint | 归一化工具、目标、范围、投影、分页及条件参数后的脱敏指纹 |
| readScopeFingerprint | 去除 cursor/条件命中细节后的读取语义范围，用于跨次比较 |
| contentFingerprint | 优先复用源稿、产物或投影已有内容哈希；不存在时记录读取版本与范围，暂不作内容完全相同的判定 |
| outputBytes / inputBytes | UTF-8 字节，与现有字符数并列 |
| returnedItems / unchanged / projection | 区分批量、条件命中和完整读取 |
| schemaHash / profile | 区分不同工具定义与会话工具集 |
| recoveryCode / suggestedTool | 判断建议后的实际恢复路径 |

指纹只归一化身份与允许列表中的非敏感查询参数，正文身份复用已有内容哈希，不记录原文、完整参数或凭证。没有内容哈希时只能报告同范围、同读取版本的重复候选。动态 task/result 查询另列，不参与静态重复读取判定。

分类规则：

- 同目标、同语义范围、相同内容指纹的非分页全文再次返回：标记重复返回候选，不阻止用户读取。
- cursor 不同、投影/目标不同、内容变化：合法新读取。
- 相同确定性错误后相同请求再次执行且没有输入修正：失败重试候选。
- 同任务在终态后继续查终态：单独报告，区分用户明确刷新。
- 原幂等身份的恢复查询/重放：恢复行为，不计为错误重复提交。

这些指标是线索；在没有用户意图标记时不能把“重复返回候选”直接叫作“无效调用”。

### 9.3 token 口径

保留历史字符、字节与原估值，新增明确命名的累计/均值/峰值字段。当前工具级 estimatedOutputTokens 来自峰值，应在展示和新字段中明确 max 语义，旧字段兼容保留。

真实模型 usage 可获得时单独记录输入、输出及缓存口径；无法获得时仅报告字节和粗估，不把 chars/4 当计费结果。tools/list 字节、MCP 内容字节和模型实际上下文三种成本分开。

## 10. 验收方法

### 10.1 固定任务夹具

使用临时项目/数据库与可控执行器，不在真实制作稿上修改来压测，不提交收费生成。

| 场景 | 操作 | 必须证明 |
| --- | --- | --- |
| A 节点信息 | 大 metadata 节点读取 summary/media/generation | 无正文、历史和整图夹带，媒体身份正确 |
| B Clip 参数 | 已知一个 Clip 读取保存参数 | 不调用编译器或生成预览 |
| C 多 Clip 改配置 | 10 个已知 Clip 读 → 一次批量写 → 批量核验 | 保留无关字段，N 个 Clip 不变成 N 次完整项目读取 |
| D 正式 Shot 编辑 | 只改一个 Shot 的非对白字段并请求局部 refresh | 源稿唯一权威；无整稿 hash/替换；关联编译按原操作汇总 |
| E 参考/预览 | 同范围核验并提交模拟 H3 运行 | 合法 planHash 可用，输入变化拒绝过期计划，无重复预检 |
| F 等待 | 多个任务由运行到终态及人工确认 | 精确任务归属、事件等待、无重复提交 |
| G 恢复 | 响应丢失、目标缺失、冲突、输出超限 | 建议 schema 合法，回执重放不重复执行 |
| H 目录 | full 与候选 profile，包含插件刷新 | 能力闭包完整，session 隔离，无工具泄漏 |
| I 大正文 | 多页、多块、中文 UTF-8 和历史读取 | 无重复遗漏，重组摘要一致，旧 cursor 按契约拒绝 |

### 10.2 指标与设计目标

每个任务记录：逻辑 MCP 调用数、网络往返、tools/list 字节、输入/输出 UTF-8 字节、模型准备耗时、服务耗时和端到端耗时。并行调用仍计 N 次调用，批量接口计 1 次；不混淆轮次和次数。

设计验收目标：

- 场景 A 的新轻量路径相对旧 full，输出至少减少 80%，且不增加查询调用。
- 场景 C 在身份、schema 和授权已就绪时，用 3 次逻辑业务调用完成读/写/核验；未知提交结果的恢复调用单列。
- B 的保存值路径：编译与 preview 调用数均为 0。
- E 对同一有效范围无额外同义预检；不能靠删除权威提交校验达到目标。
- 恢复夹具的所有机器可执行建议均通过目标 schema 校验。
- 代表性编辑/检查混合任务，总输出字节争取减少 60%，业务调用数争取减少 30%；以相同最终结果为前提，未达成时报告差距，不改夹具掩盖。
- schema 实验独立比较冷启动与复用成本，任务成功率和可恢复性不下降。

百分比只用于基准验收，不新增生产大小/数量/时间边界。每项都保留旧基线，不能用旧历史峰值对比新的简单夹具。

## 11. 实施拆分

| 阶段 | 工作包 | 涉及位置 | 进入下一阶段的条件 |
| --- | --- | --- | --- |
| P0 | 基准采集、统一路径、修复 recovery 参数与 H3 runtime 描述 | MCP 错误映射、工具描述、运行指令、操作预算、相关测试 | 同任务基线可重放，建议参数合法，指引不再要求同输入多次预检 |
| P1a | 节点投影和 inspect context | schema、共享投影、Backend 读取、客户端、兼容入口 | HTTP/Agent 同契约，活动媒体正确，旧请求行为不变 |
| P1b | H3 saved 语义、批量 Clip 读取、标准路径接入 | H3 schema/插件、上下文读取、测试与操作指引 | B/C 正确且达到调用预算；不改变生成输入 |
| P1c | 字节/指纹/投影埋点及报告口径 | 现有 MCP observability、聚合与报告测试 | 能区分分页/新目标/重复返回候选，敏感内容不落日志 |
| P2 | 可选 profile 与客户端实测 | session 初始化、共享目录元数据、插件注册策略 | profile 闭包与 session 隔离通过，实际上下文成本下降 |
| P3 | 精简 production_edit schema 实验 | 当前合同派生、profile 注册、contract 查询 | 冷/热任务端到端成本均下降，正确率不退化 |

每个阶段独立可交付，不把 P2/P3 作为 P0/P1 上线前置。P0 与 P1 的业务改动完成后，再更新对应中英文用户迁移/待测文档和 CHANGELOG；设计稿不表示功能已可用。

相关现有测试优先复用：backend 的 mcp-http、mcp-pruning、mcp-observability、mcp-command-receipts、mcp-wait-cancellation、server/mcp-payload-contracts，以及 canvas-agent 的 production-read 和 H3 MCP 测试。新增测试覆盖真实失败场景，不仅验证对象是否长成实现的样子。

共享源码重建 dist 后，验证真实 HTTP tools/list 和 tools/call，再核对 Agent/插件直接消费者。确认加载进程与忙碌状态后才安排必要重载；构建完成不能报告为运行验收通过。

## 12. 兼容与回退

- P1 参数全部显式 opt-in，旧请求继续原语义。新客户端先确认新 schema，再发送参数。
- profile 默认 full；不支持配置的客户端保持 full。业务数据和回执不依赖 profile。
- 新旧读取共享同一业务数据与事务；回退只改变注册/投影选择，不迁移或清理画布数据。
- 精简 schema 只在实验 profile 注册；回退到完整 schema 不改变原 operationId、内容身份或幂等记录。
- 回退不删除新增埋点与旧基准，不改变既有媒体、草稿或任务。
- 本方案不引入 DB 格式迁移；如果实现中发现确实需要迁移，先单独设计备份与兼容路径。

推荐第一批落地 P0 + P1a + P1b；P1c 随相应接口补齐最小指标。完成固定任务比较后再决定 P2/P3 的收益是否成立。

## 13. P4：制作源稿字段读取

历史采样中 production_get_source 有 69 次调用、平均约 10,665 输出字符；已知 targetIds 仍返回完整对象。该证据只说明存在成本热点，不将所有正文读取视为浪费。本阶段在现有工具上添加 fields，不增加工具或超时/重试边界。

- 当前与历史源稿工具、场次及场次历史的 source 视图共享同一投影；字段只选顶层键，去重排序，并保留稳定 ID。
- partialSource、sourceFields、missingFields 明确部分结果和字段缺失。false/0/null 保留；部分结果不能作为整稿替换输入。
- cursor 绑定 fields 与分页范围；分块摘要覆盖投影后的完整对象，历史读取继续绑定冻结版本。ifRevision 只复用相同字段/范围的已读内容。
- 显式 fields 路径不读取/附加画布输入、占用状态和活动返修集合，也不遍历无关产物目录；省略参数保持旧契约。
- Backend 未确认投影时拒绝把完整结果返回给模型；HTTP MCP 与 Agent 兼容入口均使用同一回执检查，不静默降级到全稿。
- 读取观测修正历史版本的 snapshot 包装解析，避免把未读完的历史首分页计为完整重复读取。

真实 HTTP 固定夹具查询同一 Shot 的摄影与时长：完整模式 160,634 字节，字段模式 645 字节，均为一次调用；含一次目录发现为 374,825 对 214,836 字节。字段路径额外画布运行读取次数为 0。该受控结果不代表全部源稿任务或模型计费降幅。

P4 验收完成：19 项定向测试通过，共享包构建、Backend 类型检查和差异/编码检查通过。常驻服务的当前、历史、场次、场次历史工具均已声明 fields。真实已保存分集只读查询一条 Shot 的 id/duration_frames，返回 partialSource=true，实际键为 id/timeline_id/duration_frames；不含 canvasInputs、targetStatus 或 clipRefreshes，完整 MCP 回执 1,236 字节。没有保存制作稿或生成媒体。

扩展 production-read 原测试中两项失败（完整读取对象引用相等、旧版 published 格式读取）已用 HEAD 版 production-read.ts 配合当前依赖复现，未通过放宽格式保护或改变旧契约处理这些基线问题。
