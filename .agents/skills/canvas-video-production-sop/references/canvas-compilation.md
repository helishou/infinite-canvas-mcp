# 源稿编译与发布

触发：保存制作源稿、编译、发布或局部返修。先遵循[适配核心](acheng-canvas-adapter.md)。

分集与独立画布统一调用 `production_get/production_edit/production_publish`，显式传 `kind:episode/canvas` 与 `id`。通过 `set_director_production` 提交完整导演稿：schemaVersion、engine、source、sourceHash、modules、artifacts、assets、shotInputs、boundaries、workflow、unresolved、executionAuthorized。

source 原样保存 Acheng production 数据。sourceHash 是递归键排序、无空白、UTF-8 JSON 的 SHA-256；MCP 提交完整源稿对象时使用 `production_hash_source`，脚本复用项目导出工具，不另写 canonical 算法或凭记忆拼哈希。artifacts 每项包含独立 prompt 字节、sha256、源哈希、参考标签/节点/storageKey/媒体哈希/职责及编译回执；draft 和 partial 不标 ready。接入包不填造 PASS，先执行本机当前激活版本的真实离线编译与校验，再由 Backend 核对源与媒体。

### 编译后由程序承接

Agent 负责编译前的创作、源稿编辑、依赖与批准版本登记。`production_compile` 携带稳定 `operationId`，立即返回后台编译状态；沿同一 ID 使用 `production_get_compilation` 查询，超时不能换 ID 重提。只有 `succeeded` 才应用 `preparedId`，其余状态按分页短诊断处理；`interrupted` 已确认未完成，不自动重跑。

编译器与 Backend 的校验回执是编译结果的技术依据。Agent 默认不读取、复查、润色或重写编译正文，也不整段回读 Clip 对照正文。需要调整时修改正式源稿并重新编译，禁止直接编辑正式 Clip 的编译正文、参考或引擎身份。媒体批准与生成授权仍沿既有合同。

准备和应用编译包会自动投影引用，消费短回执的 `referenceSync`；`blocked` 表示缺少依赖、批准媒体、当前编译或存在编辑冲突，不能当作可生成。源稿使用 `sourceSection`、`targetIds` 定向读取；产物默认读取 `artifact_index`。长列表用 `pageSize`/`cursor`，单个长对象显式用 `chunkBytes`；游标过期时从新版本读取，不拼接不同版本。编译诊断与目标索引使用 `view`、`offset` 和 `pageSize`，不回传全量 audit 或正文。

## 编译输入与产物

编译输入是已保存的结构化制作源稿、Shot/Segment、资产资料和实际参考绑定。只有资产时运行 `compile_assets.py`；包含视频片段时运行 `compile_h3.py`。脚本按对应 Skill 规则产出独立、完整的图像或 H3 提示词文件、索引、逐目标诊断、参考映射和哈希回执；缺少依赖的目标保留为 draft，不伪造 ready。Backend 再核对当前制作 revision、媒体归属和执行条件。

脚本不调用媒体模型。源稿、提示词、实际参考或镜头边界变化后重算受影响产物，已生成媒体不会自动重做。

## 预检与发布

正式提交前调用 `production_preflight` 或 `production_preflight`，显式传 `kind:episode/canvas`、`id`、`action: edit/publish/compile/generate` 与原正式 `request`。预检只读，返回 revision、当前激活引擎、已识别缺项的 `code/path/targetId/message/severity`、阻塞运行及 `nextActions`。计划稿缺项可保存；编译、发布和生成按各自阶段检查。只有故事正文、没有资产卡或视频段落时不要调用编译器；编译预检按当前激活版本检查资产计划、风格参考和提示词卡，并保留合法缺图草案的交付能力。

`production_compile` 和 `*_start_production_run` 在 HTTP MCP 与页面内 Agent 中自动执行同一预检。返回 `status: blocked` 表示条件检查完成、本次没有执行编译或提交媒体，不等于已经生成或得到 preparedId；按 `preflight.diagnostics` 一次补齐已识别缺项，再按 `nextActions` 回读精确对象、运行和任务。相同源稿/revision/运行状态没有变化时，不重复同一请求，不通过换 runId、幂等键或暂停绕过占用。`replayed: true` 的有效预检只允许恢复原幂等回执，不授权新生成。预检通过后正式提交仍重新检查 revision、幂等与媒体归属；网络、引擎故障或提交竞态仍作为真实失败处理，按返回的稳定代码和下一步恢复。

局部返修先用 sourceSection/targetIds 读取目标与 targetStatus；占用时按原运行及 nextAction 处理。按“局部修改源稿 → 编译并检查回执 → 预览发布 → 授权生成”推进；运行恢复见[运行与恢复](canvas-production-runs.md)。
