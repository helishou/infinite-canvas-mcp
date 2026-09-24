# MCP 工具开发参考（backend/src/mcp.ts）

## 新增工具模式

在 `registerDirectCanvasTools()` 函数末尾追加 `server.registerTool()` 调用：

```typescript
server.registerTool("tool_name", {
    description: "工具描述",
    inputSchema: z.object({ field: z.string().optional() }).shape,
}, async (rawInput: Record<string, unknown>) => {
    // 业务逻辑
    return textResult({ ok: true, ... });
});
```

## 多画布路由（activeProjectId 模式）

MCP 进程内维护 `let activeProjectId: string | null = null;`，`currentProject(db)` 优先取 activeProjectId：

```typescript
function currentProject(db: BackendDatabase) {
    const projects = db.listCanvasProjects();
    if (activeProjectId) {
        const found = projects.find((p) => p.id === activeProjectId);
        if (found) return found;
    }
    if (projects.length === 0) throw new Error("当前没有画布项目");
    return projects[0];
}
```

## 新增依赖

若新工具需要额外 npm 包（如 nanoid），在 `backend/package.json` 的 dependencies 中添加，然后 `npm install`。

## 构建与验证

1. `cd E:/无限画布/Infinite-Canvas-MCP/backend && npm run build` — 编译检查
2. 重启后端：`taskkill /F /PID <pid>` → `node dist/index.js &`
3. 测试 MCP stdio：用 Node.js spawn 子进程，通过 pipe stdio 发送 JSON-RPC 消息（**不要**用 curl 或 printf 管道，Windows 上 stdio 管道不生效）：

```javascript
const { spawn } = require('child_process');
const proc = spawn('node', ['dist/index.js', 'mcp'], { stdio: ['pipe', 'pipe', 'pipe'] });
proc.stdin.write(JSON.stringify({jsonrpc:'2.0',id:0,method:'initialize',params:{...}}) + '\n');
setTimeout(() => {
    proc.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'tool_name',arguments:{...}}}) + '\n');
}, 300);
proc.stdout.on('data', d => { /* 解析 JSON-RPC 响应 */ });
```

## 中文编码陷阱

**bash/curl 传中文 JSON 时编码会乱码**（Windows GBK 环境）。正确做法：
- 创建画布/节点时，用 Python 直接操作 SQLite 写入 UTF-8 内容，或
- 用 MCP 工具（`canvas_create_project`）传中文参数（MCP stdio 走 JSON-RPC，编码正确）
- **不要**用 curl/bash 传含中文的 JSON body

## 项目级任意文件资产

为剧目、项目或工作区增加 LUT、字体、剧本、参考文档和压缩包等非图片资产时，优先复用已有二进制媒体存储与通用资产记录，不要把文件内容塞进画布 `data_json`，也不要把 LUT 当图片节点解码。

推荐链路：

1. `POST /<scope>/:id/assets` 接受原始二进制；文件名、MIME 由请求头显式传入，并设置单文件体积上限。浏览器对 `.cube` 可能给空 MIME，必须允许回退为 `application/octet-stream`，原始扩展名和文件名仍需保留。
2. 先验证所属项目存在，再写媒体存储；随后写通用资产记录，`kind` 使用稳定类别（如 `drama-file`），`data` 保存所属 ID、`storageKey`、原始文件名、MIME、字节数和扩展名。元数据写入失败时立即删除刚写入的媒体，避免孤儿文件。
3. 列表 API 必须按所属 ID 过滤；删除 API 同时删除资产记录与对应媒体。删除所属项目时也要清理其文件资产，因为所属关系保存在资产 metadata 时不会获得数据库外键级联。
4. 前端文件输入使用 `multiple`，逐文件上传并在完成后回读列表；列表至少提供原始文件名、类型、大小、下载和删除。下载 URL 从 `storageKey` 生成，不拼磁盘路径。
5. 验证必须覆盖上传任意二进制、按项目隔离列表、下载字节与原文件完全一致、删除后列表为空且媒体读取返回 404；再用真实剧目上传一个实际 `.cube` 或 ZIP 并回读目标列表。
6. 资产类 UI 后续扩展时保留批量上传、全选/批量删除和文件夹/类别导航的位置，不要把每个文件平铺成不可管理的长列表。

## 返回 payload 大小治理（summary / full + canvas_get_node + 按需 fetch v5）

**根因不只一处 —— 第一轮剥一个字段，下一轮剥下一层，每一次"彻底解决"都只是把根因往下推了一层。** 本项目连续两轮（v4 → v5）就是这个模式的真实样例：

| 轮次 | 表象 | 真正的根因 | 解法 |
|---|---|---|---|
| v4 | `canvas_get_state` 2 MB，被 MCP 截断；**猜** `metadata.materials` 是大头 | `writeBackH3Task` 把 generation_logs.outputs 复制到 `metadata.materials` 数组 | 新增 `h3_get_node_materials` 读端；DB migration v4 启动时 `JSON.parse → delete meta.materials → JSON.stringify → UPDATE` |
| v5 | v4 migration 跑完画布**依然 2 MB**——你以为完事了，其实大头换地方了 | `writeBackH3Task` 还会把 `log.params + log.prompt + log.references` spread 到 `output.params`，然后 push 进 `segments[i].results[]`；同时 `segments[i]` 自身有 `refItems` / `characterRefs` / `characterPromptBlocks` / `sourceComfyParams` / `sourceParameters` / `sourcePrompt` / `comfyWorkflow` 等冗余输入快照；老画布每个 segment 几百 KB | DB migration v5：清 `segments[i].results[]` 里除 url/storageKey/name/segmentId/kind/mimeType/type/imageIndex 之外的所有字段；清 `segments[i]` 上的 9 个输入快照字段；`sourceRefs.image/video/audio[]` 每个元素只留 url/kind/role/imageIndex/name/segmentId。**`h3_get_node_materials` 增加 `segmentId` 可选过滤**（schema/tool/client 全部要改，不能漏 endpoint）|

**核心教训**：
- **"画布太大"的根因通常埋在 writeBack 链路里，不是"返回字段太多"。** 不要只盯着 GET 端做 lazy/streaming——治标；改 writeBack 把生成数据迁到 side table 才是治本。
- **migration 跑完之后必须用 `canvas_get_state({detail: 'full'})` 实测画布总大小，再对比"migration 前"的 spillover 文件大小**。如果变化不大，说明你剥错字段了。**第二轮一定要从 spillover 文件重新分析体积分布**，不要根据上一轮的诊断直接动手——根因很可能换了地方。
- **`x + y = z` 的加法对体积优化经常失败**。v4 migration 后你以为"materials 占 97% 解决了，画布就该 30 KB"，实际 segments 数组里的 sourcePrompt 又是几 MB；v5 migration 也一样，不能假设"剥完大头就完事"。
- 修第二轮时**继承 v4 的 store 透传 + MCP tool + REST 路由 + schema + description + backend-client 五层**，每一层都得改；漏一层就会出现"前端请求到 schema 但 server 不识别"或"tool 不出现在 tools/list"。

### 写端停摆 + read 端按需的完整链路（v5 同款扩展）

新增一个"画布 metadata 里不该承担的字段"按这套模板拆，每一步都要做：

1. **定位真正的写入路径**：不要凭"字段名 X 在某处被设置"就动手；用 `rg -n` 找到所有写入点（push、merge、assign、Object.assign），把每一个写点的 `output` 表达式展开看一次。`writeBackH3Task` 把 `output.params = log.params + log.prompt + log.references` spread 进去——这才是写入路径，光看 `nodeMetadataPatch.materials = []` 看不到真正的成因。
2. **写端停摆**：`writeBackH3Task` 不再 spread log params/prompt/references 到 output，只 push 当前生成的 url/storageKey/name。`if (log) events.publish(...)` 这种"用不到就注释掉"的清理也要顺手做掉，避免 typecheck 残留。
3. **DB migration v(N+1)**：在 `migrate()` 加 `if (currentVersion < N+1)` 分支，调一个新的 `stripXxxFromCanvasProjects()` 私有方法。**与 vN 的差异是处理位置不同**：v4 处理 `metadata` 顶层，v5 处理 `segments[i]` 嵌套层 + `segments[i].results[]` 元素级过滤。
4. **store + client + tool + REST + schema 五层全部更新**：签名加可选参数（`segmentId?: string`），每一层都加透传，不要漏；漏一层会出现"用户传了 segmentId 但被忽略"的诡异 bug。
5. **smoke test 端到端验证**：模拟"老 db 升级"场景——`new DatabaseSync` 建 schema + `INSERT INTO schema_migrations VALUES (N, ...)` + `INSERT INTO canvas_projects VALUES (..., 含老 fat 数据)` + `new BackendDatabase(dbFile)` 触发 migrate。然后 `db.db.prepare("SELECT data_json FROM canvas_projects WHERE id = ?").get(...)` 直读 SQLite 拿到 migration 后 data_json，对比体积。

### 第二轮特有的陷阱（v4 → v5 之间踩过的）

- **"patch 工具 success 不等于 on-disk 改了"会反复出现**。第一轮 v4 commit 时我 patch 了 `web/src/stores/canvas/use-canvas-store.ts` 的 `H3_BACKEND_NODE_METADATA_FIELDS` 删 `"materials"`，工具返回 success + diff。但下一轮准备 commit 时 `grep "materials"` 发现 `"materials"` 仍在文件里。**根因**：当时 `use-canvas-store.ts` 的整个 working tree 里有一大堆用户的 dev 改动（folder feature 等 200+ 行 diff），`patch` 在这种大文件上偶尔会"看着对、实际 no-op"。**修法**：patch 后**立刻 `grep -c <关键字段> <文件>` 验证**——比如删 `"materials"` 应该是 `grep -c '"materials"' <file>` = 0。没落到 0 = patch 没生效，重读 + 重 patch。
- **migration 写在 `migrate()` 的 `if (currentVersion < N+1)` 分支里，但 vN 的 `stripMaterialsFromCanvasProjects` 会同步**清 `metadata.segments[i].refItems` / `characterRefs` 等**新发现的冗余字段**——不要另起一个迁移方法，而是在同一个迁移方法里把清理范围扩大，避免 `currentVersion` 在 v4 跑过的 db 上不会再触发 v5 逻辑。**判据**：用 SQL 直接查 `SELECT MAX(version) FROM schema_migrations` 确认版本号，再 `SELECT data_json FROM canvas_projects WHERE id=?` 读 data_json 看老 fat 字段是否还在。**`db.db.prepare(...).get(...)` 拿到的 data_json 是 migration 跑完的最新结果**，不是 layers 缓存的脏数据。
- **`if (currentVersion < N+1)` 块的执行条件是 version 而非 "data_json 是否含目标字段"**。所以新 db 上来 vN+1 不会跑（version=N），但老 db 升级上来 vN+1 会跑（version=N-1 升到 N+1）。smoke test 必须**模拟老 db 场景**：`INSERT INTO schema_migrations VALUES (N-1, ...)` 再 `INSERT INTO canvas_projects VALUES (..., 含 fat data)`，然后 `new BackendDatabase(dbFile)`。**只验证 version=N+1 不够**（新 db 永不触发），必须验证"version < N+1 升级上来会触发"。

### frontend IndexedDB sync 反向写回 —— 第二轮 migration 后必须重做

**`use-canvas-store.ts` 的 `hydrateCanvasProjectsFromBackend()` 后，如果本地 IndexedDB 仍有上次 hydrate 的全量快照（含 migration 已剥掉的字段），后续 `isLocalProjectNewer()` 命中 + `upsertBackendProject(project)` 会**整份 PUT 把已剥字段塞回去**。**实测代价**：v5 migration 跑过 `[migrate v5] trimmed ...` 输出成功，**但 frontend 几秒钟后把含 fat 字段的本地快照写回 backend，看 backend log 只有 migration 那行 warn**。

**对策优先级（每轮 migration 都要重做）**：

1. **跑 migration 前先关 web**：用 `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*web*node_modules*vite*' } | Select -First 1 | Stop-Process -Id {$_.ProcessId} -Force`。**不要**用进程名宽条件（`CommandLine -like '*vite*'`），会把 `concurrently` / `tsx --watch` / 整条 dev 栈一锅端（用户会直接质问你"我服务怎么老是被杀"）。
2. **web 侧 hydration 后清掉本地 stale 字段再 `saveToLocalStorage`**：在 `use-canvas-store.ts` 的 `hydrateCanvasProjectsFromBackend` 末尾加一段 sanitize——遍历 project.nodes，对 type 以 minimax 开头的节点 `delete node.metadata.materials` / `delete node.metadata.segments[i].results[j].params` 等已剥字段。
3. **backend `upsertCanvasProject` 检测 deprecated 字段时拒绝写入并返回 warning**——根治，但改 backend 写入路径会动到 revision/事务，影响面大，前两条工程补丁先。

**根治需要 web `localSnapshotPersistence` 与 backend authoritative state 之间有显式字段同步层**，而不是"本地新 → 整份 PUT"。本会话两轮 migration 都中了这个招，第二轮比第一轮更明显（前端 v5 后又把"未剥 v5 字段的旧 fat 段"写回去了）。

## 返回 payload 大小治理（summary / full 模式 + canvas_get_node）

**默认从画布返回所有节点全 metadata 是隐性陷阱 —— H3 节点 `metadata.refs.image[]`（参考图清单）单节点就能吃掉几 MB，47 节点的项目总量 2.1MB**。MCP stdio / Hermes 工具调用链单次返回上限（实测 ~2MB 触发 spillover）一旦超过，会被 Hermes 在中间截断（约 1.79M 中段缺失），文件落盘到 `%LOCALAPPDATA%/hermes/cache/spillover/call_<id>.txt`，两端能看到节点数组的开口与收尾，但中间内容丢失，**整段 JSON 无法被标准 parser 解析**。

**症状**：
- MCP 工具返回文件里出现 `[MCP RESULT TRUNCATED - N chars omitted out of M total] ...` 标记
- 试图 `json.loads(spillover_text)` 在 char ~800000 附近抛 `Expecting value`
- 试图 `web_extract` 走前端页面绕过也一样（前端拿的是同一个 payload）
- 试图 `site_navigate` 走浏览器 view，"当前没有已连接网页"

**正确做法 — summary/full 模式 + 按需 fetch**：

1. `canvas_get_state` / `canvas_export_snapshot` 默认 `detail: "summary"`，节点只返 `{id, type, title, position, width, height}`；H3 节点的 `metadata.refs.image` / `segments` / `promptDraftText` 全部剥掉。
2. 新增 `canvas_get_node({projectId, nodeId})`：按 id 取**单节点完整 metadata**。模型先看 summary 列表挑感兴趣的节点，再针对具体 id 取详情。
3. `canvas_apply_ops` 的回写响应 `state` 同样走 summary —— 每次写操作不应吐完整大画布。
4. 旧 caller 需要完整 metadata 时显式传 `detail: "full"`（带 `_meta.totalNodes` / `truncatedNodes` 让 caller 知道自己在拿大数据）。

**实现位置**：
- `backend/src/mcp.ts` 的 `compactProject(project, detail="summary")`：`detail === "summary"` 时 `nodes.map(summarizeNode)`，只留 6 个字段；返回顶层加 `_meta` 标记。
- `summary` 模式不剥 `connections` —— 拓扑是浏览画布的必需信息，连线体积小可忽略。
- `canvas-agent/src/canvas/schemas.ts` 给 `canvas_get_state` / `canvas_export_snapshot` 加 `detail: z.enum(["summary","full"]).optional()`；新增 `canvas_get_node` schema + description（强调"先用 summary 拿 id，再按需拉详情"）。
- `toolDescriptions.canvas_get_state` 文案必须明示默认 summary，避免模型每次默认拿全量。

**契约保持**：
- 前端 `web/src` 直接调 REST `/canvas/projects/:id` 拿完整数据这条路径**不动**，只动 MCP 出口。
- 改 `compactProject` 之前先 `grep -rn compactProject(` 确认所有调用点都接受 summary（典型 2 处：`canvas_get_state`/`canvas_export_snapshot` 入口 + `applyCanvasOperations` 的回包 state）。

**诊断落盘时不要硬抗 spillover 文件**。如果上游返回已经被截，先按"首尾+截断标记"策略从 `%LOCALAPPDATA%/hermes/cache/spillover/call_<id>.txt` 流式取节点数组边界：

```python
# raw = spillover 文件全文（外壳是 {"result": "<inner>"}，inner 字符串里 \" 是 chr(92)+chr(34)，\n# \n 是 chr(92)+chr(110)，节点是双重转义 JSON）
# 步骤：
# 1. 在 raw 中定位 \"nodes\": [ 后第一个 { （首个节点起点 = first_node_open）
# 2. 在 raw 中定位 \n  ],\n  \"connections 之前（节点数组结束标志）
# 3. 扫描 [\n    {  标记下一个节点起点
# 4. 每个节点 { 之后 ~500 字符内即可拿到 id/type/title —— 这些字段在 metadata 之前的固定位置
# 5. position 字段：先找 "position": { 再找后面 "x": <num> 与 "y": <num>
# 6. metadata 内部被截断的节点只能拿到 id/type/title/position —— 不要伪造 metadata
```

**判据**：拿到完整节点数（项目诊断的 nodeCount / connectionCount 字段）+ id 列表 + 拓扑连线，就足够做"画布概览"。需要某个节点 metadata 细节时改走 `canvas_get_node` 单独取，不要从 spillover 文件里反推 metadata。

**为什么不在 frontend 解决**：前端拿到的也是后端吐的同一个 payload（HTTP 接口 `/canvas/projects/:id`），不治理后端返回大小，前端同样要面对 2MB+ JSON。前端的 lazy render / viewport culling 是渲染层、不是传输层，**两层都要做但不能互替**。

**排查线索**：画布节点数 ≥ 30、H3 视频节点 ≥ 1 时，MCP `canvas_get_state` 必被截 → 立即走 summary 模式或拆节点取详情。

## 排查线索

- 新工具不出现在 `tools/list` → 检查 registerTool 是否在 `startBackendMcpServer()` 中被调用
- 调用报 "tool call failed" → 检查 handler 是否 throw 了未捕获的异常
- 后端重启后工具仍不生效 → 确认 `npm run build` 成功且 dist/ 已更新
- 画布标题/节点标题显示乱码 → 检查写入方式，改用 MCP 工具或 Python sqlite3 直接写入
- 画布 MCP 返回体含 `[MCP RESULT TRUNCATED` → 立即切 summary，按需 `canvas_get_node` 拿单节点详情，不要硬解 spillover 文件
- 不知道某画布节点数多少 → `canvas_diagnose_project`（只读诊断，体积小）

### zod `.describe()` 必须传给 zod schema，传 `.shape` 会被 SDK 吞掉

`backend/src/mcp.ts` 注册工具时传 `inputSchema: schema.shape` 会让 MCP SDK 拿到 `ZodRawShape`（裸 `{ field: zodType }` 对象），SDK 在走 zod-to-json-schema 时**不会逐字段 walk `.describe()`**——结果是 `tools/list` 返回的 JSON Schema 里每个 property 都没有 `description` 字段，模型看不到任何字段提示，只能凭类型签名猜。

**症状**：
- `canvas_list_projects` 用着正常（顶层工具 description 还在），但 `canvas_create_text_nodes` / `canvas_apply_ops` / `canvas_move_nodes` 等**复杂 schema** 经常被错误调用——把数组套成对象、坐标用错、必填字段漏掉。
- 用 `tool_describe(canvas_create_text_nodes)` 验证：每个 property 都只有 `type`，**没有 `description`**。

**修法（两处都要改）**：
1. `backend/src/mcp.ts::registerDirectCanvasTools` 主循环里 `inputSchema: schema`（zod 对象本身），不是 `schema.shape`。
2. `backend/src/mcp.ts` 里 `h3_get_node_materials` 单独注册处同样改。
3. 顺带检查 `canvas-agent/src/server/mcp.ts::registerCanvasTool`（如果有那一层封装）。

**为什么不止改 schema.ts**：在 `schemas.ts` 里给每个字段加 `.describe(...)` 是必要的，但不充分——必须同时保证注册时传入的是 zod schema 对象而不是 `.shape`，`.describe()` 才会被序列化进 JSON Schema。改完 schema 但忘改注册 → 模型还是看不到 description → 还是会瞎猜。

**验收判据**：跑一个临时 stdio probe（spawn `node backend/dist/index.js mcp`、发 `initialize` + `tools/list`），抽样几个复杂工具的 `inputSchema.properties` 看是否有 `description` 字段。`6/6 props have description` 这种全绿才算修通。

**不适用**：`canvas_apply_ops` / `canvas_split_image` / `comfyui_*` 等 inline `z.object({...}).shape` 调用暂不动——这些 schema 本身没加 `.describe()`，传 zod 也只多绕一道转换，不影响调用准确率。

## 实战参考：H3 节点 metadata.materials 单字段膨胀

上一节是"画布总大小 > MCP 返回上限"的一般症状。本节是该症状的具体实施 —— 当根因是**单一节点的单一字段**占了画布体积的绝大多数（实测 47 节点画布里一个 H3 节点的 `metadata.materials` 占 1.9MB / 总 1.95MB）时的诊断与拆解。

### 诊断：不要 `json.loads` spillover 文件，stream-parse 节点边界

spillover 文件被截断后 `json.loads` 必失败（中段缺失）。改用边界解析：

- 外壳是 `{"result": "<inner>"}`，inner 是双重转义 JSON：`\"` 是 `chr(92)+chr(34)`、`\n` 是 `chr(92)+chr(110)`
- 用 `\n    {` 锚点定位每个节点起点（4 空格缩进）；节点数组结束于 `\n  ],\n  \"connections`
- 每个节点起点后 ~500 字符内一定能拿到 `id` / `type` / `title` —— 这些字段在 metadata 之前的固定位置
- 按顶层字段拆体积：扫描 `\\n      "key":` 模式（8 空格缩进），key 与下一个 key 之间的字符数 = 该字段体积；降序排序就看到体积大户
- 本会话里 `materials` 字段以 **1.9MB / 1.95MB = 97.4%** 占绝对大头；其内是 `[{url, kind, name, sourceSegmentId, sourcePrompt}, ...]` 数组，140 个 element，每个 `sourcePrompt` 平均 4.3KB（中文长 prompt：subject_definitions / summary / retention_analysis / detailed_description）

### 拆解步骤：复用已有表，写端停摆，读端按需，前端 fallback

根因不是"返回太大"，而是**`node.metadata` 不该承担运行历史**。每次 H3 segment 完成就 push 一份 output 到 `metadata.materials`，跟 `segments[i].results` 双写，N 段后单节点 metadata 累到 MB 级。修法是把历史迁到**已经存在但没人注意的表** —— 不要新建表，新表反而引入新的同步问题。

1. **先查 generation_logs / tasks / media_files 表是否已有等价数据**。本会话 `generation_logs.outputs_json` 已经存了 url + storageKey + mimeType + width + height + name，`generation_logs.prompt` 已经存了 sourcePrompt —— **不需要新建表**，把"画布 metadata 里的副本"删掉即可。
2. **写端停摆**：`backend/src/db.ts` 的 `writeBackH3Task` 不再 `nodeMetadataPatch.materials = [...]`，但保留 `segments[index].results` push（segments 是新 source of truth）
3. **schema migration 兜底老数据**：`migrate()` 加 `if (currentVersion < N)` 分支跑 `stripMaterialsFromCanvasProjects()`，用 `JSON.parse` 解析每个 `canvas_projects.data_json`，删 type 以 minimax 开头的节点的 `metadata.materials` 键，写回；`console.log` 输出剥除数量
4. **新增独立读 API**：`db.getH3NodeMaterials(projectId, nodeId, limit)` 从 `generation_logs` 查，按 `created_at DESC` 排序 + 按 url 去重，**不返回 sourcePrompt**（体积大、用途窄）
5. **透传到三层**：`stores/types.ts` 加 `H3NodeMaterial` type + method 签名 → `server/src/server.ts` 加 `GET /canvas/projects/:id/nodes/:nodeId/materials` REST → `backend/src/mcp.ts` 注册 `h3_get_node_materials` tool → `canvas-agent/src/canvas/schemas.ts` 加 toolName/schema/description → `canvas-agent/src/runtime/backend-client.ts` 加 `getH3NodeMaterials(projectId, nodeId, limit)` client 方法
6. **前端 H3 插件 fallback**：`H3Workbench.tsx` 的 `outputs` 计算**只从 segments 派生**，去掉 `metadata.materials`；`H3MaterialLibrary.tsx` 的 `clearUnused` / `removeOutput` 改 no-op + `console.warn`（前端不再写 metadata.materials）；`H3WorkbenchPrimitives.tsx` 的 `resetAndRequestH3Run` / `resetH3Run` 删 `materials: []` 写入；`use-canvas-store.ts` 的 `H3_BACKEND_NODE_METADATA_FIELDS` 移除 `materials`
7. **测试 fixture 同步更新**：`use-canvas-store.test.ts` 里 `makeH3Node` 调用去掉 `materials` 字段
8. **CHANGELOG.md 加迁移说明**：DB schema 改了 + 老画布升级后某个字段消失 = 用户必须知道为什么"history 不见了"

### 关键陷阱

- **新表 vs 复用旧表**：本会话的核心判断是"materials 已经在 `generation_logs` 里存过了"，所以**不新建表**。新建独立的 `h3_materials` 表反而会引入新的同步问题（哪条是 source of truth？双写时谁赢？）。
- **migration 不要在新 db 上跑**：migration 触发条件是 `currentVersion < N`。新 db 启动时 `currentVersion = 0`，会跑 v1/v2/v3/v4 全套 —— v4 的 `stripMaterialsFromCanvasProjects` 此时 `canvas_projects` 是空的，**no-op**。这是对的（老 db 升级 `currentVersion = 3` → 跑 v4 → strip 老 materials；新 db 没老 materials，无需 strip）。
- **smoke test 模拟"老 db 升级"**：直接 `new DatabaseSync(dbFile)` 建 schema + `INSERT INTO schema_migrations VALUES (3, ...)` + `INSERT INTO canvas_projects VALUES (..., 含 materials)`，然后 `new BackendDatabase(dbFile)` 触发 migrate —— 这样能验证 v4 migration 实际工作流。
- **前端不要立刻改 use-canvas-store 的 `nodeMaterials` 缓存**：H3 插件通过 plugin SDK 拿 node data，不走 web store。要让前端自动 hydrate 老 history 需要 plugin SDK 加 fetch 能力。本会话的最简方案是 **H3Workbench 直接从 segments 派生**，用户主动看老 history 才调新 tool —— 接受 history 列表暂时不全。
- **canvas-agent workspace build 是 MCP 工具注册的依赖**：`canvas-agent/src/canvas/schemas.ts` 改了 `toolNames` / `toolInputSchemas` / `toolDescriptions` 后，**必须 `npm run build --workspace canvas-agent`**，否则 backend `import @basketikun/canvas-agent/...` 还是老 dist，新 tool 不出现。判据：`grep -c <新工具名> canvas-agent/dist/canvas/schemas.js`。
- **首次 patch 缩进错位**：patch 的 old_string 必须严格匹配文件实际缩进（4 空格 vs 8 空格）。若 patch 报 "Could not find a match"，先 read_file 确认缩进再重写。

### spillover 文件的转义口径（避免下一次再从头反推）

`%LOCALAPPDATA%/hermes/cache/spillover/call_<id>.txt` 看起来"非法 JSON"是因为它被**双重序列化** + Hermes 中段插入截断标记。raw 字符与转义后的对应关系：

| raw 字节 | 含义 |
|---|---|
| `\\"` （两字节：chr(92)+chr(34)） | 内层 JSON 的字符串引号 `"` |
| `\\n` （两字节：chr(92)+chr(110)） | 内层 JSON 的字符串换行（合法的 `\n` 转义） |
| `\\\\n` （四字节） | 内层 JSON 字符串里字面的 `\n` 两个字面字符（不合法 JSON 转义，会报 `Invalid \escape`） |
| `[MCP RESULT TRUNCATED - N chars omitted out of M total] ...\\n\\n<残段>` | Hermes 在中段插入的截断标记；标记前后是真 JSON 文本但**可能字符串值未闭合** |

**解析陷阱**（已实测踩过）：
- `outer = json.loads(spillover_file)` 一定能解（外壳 `{"result": "<inner>"}` 是合法的）
- `result_str = outer["result"]` 这时是字符串，但**已经是 decoded 后的内容**：里面的 `"` 是真 `"`（不是 `\"`），`\n` 是真换行（不是 `\n`）
- 直接 `json.loads(result_str)` 在 80 万字符附近必报 `Expecting value` —— 中段被 Hermes 截断丢了
- **不能再 unescape**：`result_str` 已经 unescape 过，再 unescape 一次会把 `\"` 变成 `"`、把 `\n` 变成换行，破坏整个 JSON 结构

**正确诊断流**：
1. 读 spillover 文件为字符串 `raw`（outer format）
3. `outer = json.loads(raw)` → 取 `result_str`
4. 在 `result_str` 里**直接定位节点数组边界**，不试图解析完整 JSON：
   - 节点数组起点：`"nodes": [` 之后第一个 `{`
   - 节点数组终点：最近一个 `\n  ],\n  \"connections` 之前
   - 单节点起点：`\n    {`（4 空格 + {）
   - 单节点终点：`\n    },\n    {` 或 `\n    }\n  ]` 之前
5. 每个节点起点后 ~500 字符内一定有 `id`/`type`/`title`/`position` —— 用 `\\"` (= chr(92)+chr(34)) 锚点提取这些字段
6. **不要在 `result_str` 里再 `replace('\\"','"')` 或 `replace('\\n','\\n')`**——它已经是 decoded 后的字符串，再转义会破环

**括号配平在 prompt 字符串里会失败**：H3 节点 metadata 的 `prompt` 字段含 `\\n<Subject 2>：...` 等带 `\\\\n` 字面（双重反斜杠）的字符。写一个 `balanced_end(text, start)` 用深度计数器 + `in_str` 标志，遇 `\\"` 跳过两个字符，遇 `{`/`[` depth++、`}`/`]` depth--，depth==0 时返回 —— **在含 `\\\\n` 字面的 prompt 字符串里仍可能误算 depth**，因为 `\\\\` 不是合法的 JSON 转义，prompt 字段末尾的 `}` 会算成 JSON 结构结束。要严格分析这种嵌套结构，必须先 `result_str.replace('\\\\n', '\\n')` 把字面的 `\\\\n` 变成真换行再 parse，**前提是这部分文本里没有真正的 JSON 转义**（H3 prompt 字段是 H3 节点自己拼的，会含 `\\\\n` 字面、含 raw `\n`（已被解码为真换行）—— 这就是 raw `result_str` 里"非法 JSON 转义"的根因）。

**如果非要解析完整 metadata**：用宽容的 parser（demjson3 / 自写跳过 `\\\\X` 转义）。**判断能否安全解析**的快速检测：`raw` 里搜索 `\\\\` 序列 —— 出现一次说明 prompt 字段含字面双反斜杠，标准 `json.loads` 必失败；为 0 时可安全 `json.loads`。

**事故路径清单（已实测）**：
- 现象：`json.loads(spillover_text)` 报 `Expecting value: line N column M (char K)` 附近
- 排查：① `len(spillover_text)` 看是否接近 2MB（触发截断阈值）；② `grep -c "MCP RESULT TRUNCATED" spillover_text` 看是否真的被截；③ 看 K 附近是不是落在 `[MCP RESULT TRUNCATED` 标记附近；④ `json.loads(outer["result"])` 单独试，看报错位置是不是直接报 `Invalid \escape`（H3 prompt 字段的特征）
- **★ frontend IndexedDB sync 会把 migration 删掉的字段反向写回 backend**。`use-canvas-store.ts` 的 `hydrateCanvasProjectsFromBackend()` 后，如果本地 IndexedDB 仍有上次 hydrate 的全量快照（含 migration 已剥掉的 `metadata.materials`），后续 `isLocalProjectNewer()` 命中 + `upsertBackendProject(project)` 会**整份 PUT** 把已剥字段塞回去。实测：v4 migration 跑过后 `[migrate v4] stripped metadata.materials from 4 H3 node(s)` 输出成功，**但 25 秒后 frontend 把含 materials 的本地快照写回，2 个最大的 H3 节点 reverted**，看 backend log 只有 migration 那一行 warn。**对策优先级**：① 跑 migration 之前先 kill web（`Stop-Process -Id <web_pid> -Force`，Powershell 别用进程名宽条件，会把 `concurrently` / `tsx --watch` / `vite` 一锅端）；② 在 web 侧 hydration 后清掉 `canvas_projects` 里所有 `metadata.materials` 字段再 `saveToLocalStorage`，让本地与远端对齐；③ backend `upsertCanvasProject` 检测到 deprecated 字段时拒绝写入并返回 warning。前两条是工程补丁；根治需要 web `localSnapshotPersistence` 与 backend authoritative state 之间有显式字段同步层，而不是"本地新 → 整份 PUT"。
- **★ patch 工具返回 `success: true` 不代表 on-disk 真的改了。** 实测：在 `git stash` 之后 working tree 是 clean 的，此时 patch 一个文件，patch 工具会显示 diff（diff 是 vs HEAD 的），返回 success —— 但文件 on-disk 与 HEAD 完全一致，patch 实际是 **noop**，因为 old_string 已经在文件里。**patch 后必须立刻 grep 验证关键字段已落地**，不能只信 diff。例如删 `"materials"` 字段：`grep -c '"materials"' <file>` 必须是 0 才算成功；若仍是 1 说明 patch 没生效，需要重新 `read_file` 确认缩进再 patch。
- **★ Backend lock 文件 vs 实际进程可能错位**。`~/.infinite-canvas/backend.lock` 里的 PID 可能是僵尸（已退但 lock 没清），而真正监听 17370 的是另一个节点进程。验证 backend 状态必须 **进程 + 端口 + 日志 + schema_migrations 时间戳 四路交叉**：① `Get-CimInstance Win32_Process` 找 `node.exe` + `CommandLine 含 *backend*dist*index.js*`；② `netstat -ano | grep LISTEN | grep 17370` 看监听 PID；③ `cat ~/.infinite-canvas/backend-run.log` 看最后启动日志时间；④ `SELECT version, applied_at FROM schema_migrations` 看 migration 实际跑过没。四路都对得上才信「migration 已生效」。
- **看画布不一定要走 MCP tool**：如果 session 里 `mcp__infinite_canvas__*` 没出现（常见原因：hermes config `skills.disabled: - infinite-canvas`，或者 MCP stdio 没连接），直接 `sqlite3.connect('C:/Users/wxy/.infinite-canvas/runtime.sqlite') `canvas_projects.data_json`（手动 `json.loads`），或 `canvas_get_state` 的 spillover 落盘文件（`%LOCALAPPDATA%/hermes/cache/spillover/call_*.txt`）做 stream-parse。Backend 没有 canvas 的公开 HTTP 端口（17370 是 backend 内部服务，不是 canvas REST；canvas REST 只走 MCP stdio）；3001 是 vite dev，8000 是 chatgpt2api，17371 是 canvas-agent。要从外部查 canvas state，唯一稳定的入口是 SQLite 或 spillover 文件。


### 验收判据

- 老画布（带 materials）启动 backend → `[migrate vN] stripped metadata.materials from N H3 node(s) across M canvas project(s)` 输出
- 同一老画布的 `canvas_get_state` 返回值从 ~2.1MB 降到 ~30KB
- `h3_get_node_materials({nodeId})` 返回的 items 数量 ≥ 1（说明 generation_logs 里有数据）
- 前端 H3 工作台不报错；`H3_BACKEND_NODE_METADATA_FIELDS` 已不再含 `materials`
- 三端 `tsc --noEmit`（backend / canvas-agent / web）全绿；`npm run build` 全绿

## 按任务读取的工程约束

> 下列工程细节从技能入口移至此处。仅应用与当前任务有关的条款；路径 `references/`、`scripts/` 均相对于技能根目录。证据纪律、画布 MCP 留档、用户进程保护与当前明确要求优先。

## 扩展 MCP 工具（backend/src/mcp.ts）

### 返回 payload 大小治理（summary / full + canvas_get_node）

**不要让 `canvas_get_state` / `canvas_export_snapshot` 默认返回完整画布 metadata —— H3 节点 `metadata.refs.image[]` 单节点就能吃掉几 MB，47 节点的项目总量 2.1MB**。MCP 单次返回上限 ~2MB，超就被 Hermes 在中间截断（约 1.79M 中段缺失），文件落盘到 `%LOCALAPPDATA%/hermes/cache/spillover/call_<id>.txt`，标准 `json.loads` 必然失败。

**正确做法**：默认 `detail: "summary"`（节点只返 6 个字段：`id/type/title/position/width/height`），新增 `canvas_get_node({nodeId})` 按 id 取单节点完整 metadata；`applyCanvasOperations` 的回包 state 也走 summary。旧 caller 需要 metadata 时显式 `detail: "full"`。前端调 REST 拿全量这条路径不动。完整契约、流式 spillover 解析、判据见 `references/mcp-tool-development.md` 的「返回 payload 大小治理」节。

**排查线索**：画布节点数 ≥ 30 + H3 节点 ≥ 1 → MCP `canvas_get_state` 必被截。先 `canvas_diagnose_project`（轻量诊断）确认无 issue，再走 summary 模式列节点，按需 `canvas_get_node` 拿 H3 节点的 refs/segments。

### 注册新工具
在 `registerDirectCanvasTools()` 函数末尾追加 `server.registerTool()` 调用（zod schema + async handler + textResult）。

### 多画布路由（activeProjectId 模式）
MCP 进程内维护 `let activeProjectId: string | null = null;`，`currentProject(db)` 优先取 activeProjectId，否则取第一个 canvas project。

### 构建与验证
0. **先确认 Backend 活着**（画布 MCP 全部走它）：`netstat -ano | grep LISTEN | grep 17370`；没监听就 `node dist/index.js &`。**MCP 工具返回 `fetch failed` 只有一个含义：Backend 没跑。先查端口，不要先去改代码。**
1. `cd E:/无限画布/Infinite-Canvas-MCP/backend && npm run build` — 编译检查
2. 重启后端：`taskkill /F /PID <pid>` → `node dist/index.js &`
3. 测试 MCP stdio：用 Node.js spawn 子进程，通过 pipe stdio 发送 JSON-RPC 消息（**不要**用 curl 或 printf 管道，Windows 上 stdio 管道不生效）

#### 批量调用：用原生 MCP stdio 驱动，不要逐次 `tool_call`

一次 `canvas_generate_image` 的返回体含**整个画布 state**（实测 130–200 KB）—— 逐张跑 16 张会直接把上下文冲爆。**批量任务（切分/洗图/超分/逐段跑 H3）改成「一个 Python 进程、一次 initialize、多次 tools/call」**：

```python
# 骨架：node <backend>/dist/index.js mcp 作为子进程，stdin/stdout 行式 JSON-RPC
self.p = subprocess.Popen(["node", SERVER, "mcp"], stdin=PIPE, stdout=PIPE,
                          text=True, encoding="utf-8", bufsize=1)
self._send({"jsonrpc":"2.0","id":mid,"method":"tools/call",
            "params":{"name": name, "arguments": args}})
# 读线程把 stdout 逐行入 Queue，按 id 配对；result.content[0].text 里才是真值
```

- 先用 `initialize` + `notifications/initialized` 握手，再 `tools/list` 确认工具名在（能验证 Backend 是否活着）。
- **轮询不要走 MCP**：任务状态直接读 `~/.infinite-canvas/runtime.sqlite` 的 `tasks` 表（`status` / `result_json.media[]`），产物路径查 `media_files.file_path`。MCP 只用来提交。
- **进度必须落盘**（`wash_progress.json` 之类，每张写完就 flush），断掉能续跑，不必重做已完成的。
- 每张固定「提交 → 等终态 → 失败重试（实测 3 次足够）」；不要把整批一次性推进队列。
- **★ 轮询 H3 片段时必须比对「本轮之前」的 `resultStorageKey`，不能只看 `status === "success"`。** 实测踩过：同一 H3 节点连续跑两次 A/B，看护脚本读节点的 `resultStorageKey`，第二次启动时它已经带着**上一轮**的结果 → 脚本立刻判定「已完成」并报出旧视频，实际任务还在 running（用户那边会看到「我还没跑完你怎么说完成了」）。正确判据是**「status 终态」且「storageKey ≠ 运行前快照」**；更稳的做法是盯底层 `comfyui:minimax-h3` 子任务的 task id（`tasks` 表）而不是盯画布节点。
- **提交前先记一次 `status` / `resultStorageKey` 快照**，作为「什么算新结果」的基线；同一节点反复跑（调试、A/B）时这一步不能省。
- **★ 查「本轮任务」必须按 `created_at` 时间过滤，不能只 `ORDER BY created_at DESC LIMIT 1`。**
  实测连续三次看护脚本抓到的是**几分钟前的旧任务**（任务列表里最新一条就是上一轮），
  于是把旧产物当成新结果报给用户。提交前记下时间基准，查询加 `created_at > <基准>`；
  查不到就是**任务从未创建**（见上文两个静默跳过条件），不是「还没跑完」。

### 中文编码陷阱
**bash/curl 传中文 JSON 时编码会乱码**（Windows GBK 环境）。**不要**用 curl/bash 传含中文的 JSON body；改用 MCP 工具或 Python 直接操作 SQLite。

**⚠️ 走 MCP 也不等于中文一定安全 —— 值写进去之前和之后都要核。** 实测踩过：`canvas_create_config_node` 传 `model: "custom/zimage如梦摇光.json"`，落库变成了 `custom/zimage宕梦摇光.json`（**`如` U+5982 → `宕` U+5B95**），随后生成报 `Workflow not found`。**这个报错的第一嫌疑是「名字在传递中被改写」，不是「文件不存在」** —— 先去磁盘确认文件名真的存在，再查落库的值。

**验证与修复**：
```python
print([hex(ord(c)) for c in stored])          # 逐码点核对，肉眼看不出的替换只有它能抓到
```
用 `canvas_apply_ops` 的 `update_node` 重写该字段可以修好（实测修完落库正确），**修完必须再回读一次逐码点核对**，不要因为「这次调用成功了」就认为值对了。

**通用规则：凡是要传中文标识符（工作流名、节点标题、模型名）的字段，写完立刻回读并与期望值做全等比较**（不是 `in`、不是模糊匹配）。中文标识符是这一层唯一会静默失真的输入。

**排查线索**：报 `Workflow not found` / `找不到工作流`，而磁盘上文件明明在 → 比对落库值与文件名的码点；画布标题/节点标题显示乱码 → 检查写入方式。

### 浏览器连接问题排查
`browser_exec` 超时（420s）时，按以下顺序排查：
1. **Chrome 是否运行**：`tasklist | grep chrome`
2. **CDP 端口是否监听**：`netstat -ano | grep LISTEN | grep 9222`
3. **Chrome 是否带 `--remote-debugging-port=9222` 启动**：`wmic process where "name='chrome.exe'" get commandline | grep debug`
4. **Chrome 远程调试弹窗**：首次连接时 Chrome 会弹「Allow remote debugging?」，必须点 Allow
5. **browser-use daemon 状态**：`browser-use doctor`

**启动带调试端口的 Chrome**（关闭现有 Chrome 后）：
```bash
taskkill /F /IM chrome.exe
"C:/Program Files/Google/Chrome/Application/chrome.exe" --remote-debugging-port=9222 --user-data-dir="C:/Users/wxy/AppData/Local/Google/Chrome/User Data" --no-first-run --disable-gpu --disable-extensions
```

Hermes 配置 `browser.use_real_profile: true` 时，`browser_exec` 接管用户真实 Chrome profile，需要 Chrome 带 `--remote-debugging-port` 启动。备选：`desktop_preview` + `drive_preview` 工具操作 Hermes 内置预览窗格中的页面。

### 创建画布角色资产（正确工作流）🚨

**用户明确禁止**：创建角色资产**禁止**直接调 ComfyUI + 手写 SQLite。用户原话：
> "你不是调用画布mcp来生图啊，不是直接调comfyui再上传到画布，完全错误！"

唯一正确路径：在画布上**创建图片节点 → 填提示词 → 触发生成**，图片自动绑定到节点 `metadata.content`。

“在画布上”不等于“必须用鼠标点”：`canvas_create_node` / `canvas_create_image_prompt_flow` / `canvas_generate_image` / `canvas_apply_ops` 这些**画布 MCP 工具就是画布原生能力**，走的正是同一条链路，可以且应该用。

**真正的红线是“绕开画布直接操作底层”**，两个方向都禁止：
- ❌ 直接调 ComfyUI 生成 → 再手动上传/写库
- ❌ 用 Python sqlite3 直接改 `canvas_projects.data_json`

为什么：直接写库会**绕过画布 revision 与操作事务**（`canvas_apply_ops` 每次把 revision 递增，`canvas_get_state` 返回的 `revision` 可用于并发校验/回滚对比）；而经画布入口生成会由前端把图片回写进节点 metadata，字段永远齐全。

**验收标准：验证 UI 真的渲染了，不是数据写进去了**。写入型的 MCP 工具会回传完整新 state，看返回的节点 metadata 字段齐全即可；但“节点真能显示”必须在浏览器里确认。

### 直连图片生成与耗时诊断

直连 `gpt-image-*` 任务由画布 Backend 创建父任务和一个图片子任务，再向 provider 发起一次 HTTP 生图请求。先区分“生成慢”和“等待脚本没有退出”，再决定是否改配置。

#### 标准流程

1. 提交前记录 `projectId`、`nodeId`、稳定 `idempotencyKey`、提交时间、已有媒体 `storageKey` 和节点当前状态。
2. 只提交一次 `canvas_run_generation` / `canvas_generate_image`，保存返回的 `directTasks[].taskId`；该调用应返回任务句柄，不要在同一脚本里重复发起相同请求。
3. 用精确 `taskId` 查询 `tasks` 表或 `canvas_task_status`，轮询间隔应有上限和整体超时；判定 `queued` / `running` 为未完成，`succeeded` 为成功，`failed` / `cancelled` 为终止。数据库的成功值是 `succeeded`，不能写成只识别 `success` 的等待脚本。
4. 成功后从任务 `result_json.media[]` 和 `media_files.file_path` 读取真实媒体，再回读节点和 `generation_logs`；不要用旧 `storageKey`、文件名猜测或请求回显代替本轮结果。

#### 分层计时

- MCP 提交返回耗时：判断工具/Backend 是否阻塞。
- 父任务与子任务的 `created_at` → `updated_at`：判断画布调度与媒体落盘总耗时。
- provider `/v1/images/generations` 的开始/结束及 `duration_ms`：判断真正的上游瓶颈。
- provider 耗时接近任务总耗时：优先评估模型/渠道、输出尺寸、质量档位和提示词复杂度；不要先改 SQLite 轮询或 MCP 节点操作。
- 任务总耗时明显大于 provider 耗时：再查媒体下载、sharp 尺寸读取、节点回写、重复查询和自定义等待脚本。

#### 防止假性长耗时

- 使用 `directTasks[].taskId`，不要按“最新任务”或节点旧结果查询；连续 A/B 运行时必须用提交前快照区分新媒体。
- 等待脚本必须识别 `succeeded`，并在 `failed` / `cancelled` 时立即退出；整体超时到达后输出最后状态，不要无限轮询。
- MCP 只负责提交和最终绑定，状态查询优先直接读本地 `tasks`；不要每次轮询都请求完整画布 state。
- `count=1`、`references=[]` 已是纯文生图的低开销路径；不要为了“看得到图片”额外创建普通 `image` 节点。
- `image_poll_initial_wait_secs` / `image_poll_interval_secs` 只影响 SSE 提前结束后的回查路径。降低前先查看 `image_poll_retry`、429/5xx 和 `image_stream_*` 日志；没有这些证据时，不要把上游推理时间误判为 MCP 轮询时间。

### 图像生成的两种引擎与选择

`canvas_generate_image(model=…)` 直接传模型名即可，**两类都实测可跑**：
- `gpt-image-2`（→ direct-image）：走 `chatgpt2api`（`http://127.0.0.1:8000`，用 `CHATGPT_IMAGE_API_URL`/`CHATGPT_IMAGE_AUTH_KEY` 覆盖，详见 `backend/src/runtime/chatgpt-image.ts`）。**能吃参考图**。
- `custom/<工作流名>.json`（→ comfy-workflow）：本地 ComfyUI 纯文本/图生图。**不依赖浏览器**，纯后端+ComfyUI 即可，约 20–45s 出图。

**自定义工作流可以只传 `model` 就跑，不需要先在 UI 里配 fields**。“`fields` 为空 → 没参数可传”是错的：`fields` 只决定 UI 参数表单与 `field.node`/`field.input` 的**显式注入**；执行器会把 `prompt`/宽高直接交给工作流，且工作流自带的固定风格词仍然生效。**判断一个工作流能不能用，看 `GET /api/workflows` 的 `fields` 不够，直接跑一次实测。**

**图生图工作流的参考图由 `referenceNodeIds` 自动接上**：执行器按 `fields` 里 `type: "image"` 的字段顺序把 `referenceNodeIds` 顺序填入对应 `LoadImage` 节点（`executor.ts` 的 `processImageFields`）。所以 `custom/图生四视图.json`（node 17 `LoadImage`）直接传 `referenceNodeIds: [<chứa图的节点 id>]` 即可，无需手改工作流。

**`referenceNodeIds` 必须是画布上真实存在的节点 id**，填错报 `找不到连线起点：<id>`。要拿 id 就 dump 一次画布（`canvas_get_state`，或读 `canvas_projects.data_json` 的 `nodes[].id` —— 通过 MCP 建/生成出来的节点 id 是 uuid 后缀，**不要凭记忆拼**）。

### 实测已验证的两条角色资产链（摇光基准）

用户定下的基准引擎是 **`custom/zimage如梦摇光.json`**（写实电影感、暖光、无水印，适合真人感角色卡）：

| 步骤 | 调用 | 产物 |
|---|---|---|
| 身份图 | `canvas_generate_image(model="custom/zimage如梦摇光.json", prompt=…)` | 单人 1280×1920 **竖版**（摇光的默认宽高；现已可从 fields 改，见 references） |
| 四视图 | `canvas_generate_image(model="custom/图生四视图.json", prompt="转换为角色三视图…", referenceNodeIds=[<身份图节点>])` | 横版四格：脸近景→正面全身→侧面全身→背面全身，纯白底、无文字水印 |
| 场景图 | `canvas_generate_image(model="custom/zimage如梦摇光.json", prompt=空镜描述)` | 空间与光位基准，**必须显式传宽高取 16:9** |
| 分镜图 | `canvas_generate_image(model="gpt-image-2", prompt=单镜描述, referenceNodeIds=[场景图, 四视图A, 四视图B])` | 锁空间 + 锁脸的关键帧 |

**两个角色必须用同一引擎 + 同一套提示词结构**（发型/服装/光位/镜头词一致），否则 H3 会在角色之间产生画风漂移。摇光是**纯文生图**（`EmptyLatentImage`），吃不了参考图；要图生图必须用带 `LoadImage` 的工作流（如 `图生四视图`）。

**取成品真实路径：查 `media_files` 表，不要拼路径**。MCP 回的 `storageKey`（`image:<uuid>`）与磁盘文件名**不同名**，且媒体根目录是 `~/.infinite-canvas-root.json` 的 `mediaDir`（本机指向 ComfyUI 的 `input/infinite-canvas`），不是 `~/.infinite-canvas/runtime-media/`（那里只有 input/output 空目录）。正确做法：`SELECT file_path FROM media_files WHERE storage_key=?` 拿绝对路径。任务状态/产物查 `tasks` 表（`status`、`result_json.media[]`）。

MEDIA 发图必须用 `media_files.file_path` 的绝对路径。凭记忆拼 `storageKey` 当文件名会得到 Windows「找不到文件」弹窗。

### 画布 MCP 工具的调用方式

**建图/生成类画布工具（`canvas_generate_image` / `canvas_create_image_prompt_flow` / `canvas_create_generation_flow` / `canvas_create_node` / `canvas_apply_ops`）可以直接用 `tool_call` 调通，不需要浏览器**：它们由画布 MCP 进程经 HTTP 提交 Backend，产物由 Backend 回写节点。

需要浏览器连上的是**工作台（workbench_*）**与**纯前端页面态**那类工具（读/填生图工作台当前参数、`site_navigate`、`canvas_get_selection`）：没连网页时它们返回「当前没有已连接网页」。

**不要因为「不在浏览器里」就拒绝用画布 MCP 生成** —— 用户明确要求走 MCP，而且这是能跑的。

### 节点 metadata 标准结构（图片节点）
前端 image 节点渲染**必须**包含以下字段，否则节点不显示或报 NaN：
```typescript
{
  content: "/media/image%3A<uuid>",  // 图片 URL（不是 imageUrl）
  storageKey: "image:<uuid>",
  status: "success",
  naturalWidth: 1024, naturalHeight: 1024, bytes: 1863337, mimeType: "image/png",
}
```
标准图片节点 340×240（`NODE_DEFAULT_SIZE[CanvasNodeType.Image]`）。

**配置节点（config）另有自己的展示字段，少写就“看不见”**：
- `prompt` — 后端执行器读它生成。
- **`composerContent` — 前端 UI 真正显示/编辑的那段提示词**（展示实体）。
- `generationMode`（`image`/`video`/…）+ `status`。

只写 `prompt`（写成 `mode`/`prompt`）时后端能跑，但**用户打开画布看到的提示词框是空的**，会以为你没写。恢复或新建配置节点时必须三件套齐全；自定义工作流还要带 `customFieldValues: { <field.id>: <值> }`（`field.id` 从 `workflow_configs.fields_json` 取），否则工作流必填字段为空。**判据：拿一个已知正常的 config 节点对照 metadata 键名**，不要按工具 schema 反推。

### 删除画布节点前必须核对内容（★ 会误删真资产）

**只按「标题是不是通用名」+「有没有连线」判废是不安全的。** 实测代价：两个角色的身份图标题就是通用的「图片生成｜结果」，且生图后不再有连线 —— 两个特征都撞上，被整批当废图删掉，用户立刻发现「角色原本的形象图好像被你删了」。

删前核对（任一即可）：按 `storage_key` 查 `generation_logs`（能查到 `node_id`/`prompt`/`model` = 有来历的产物）；或看 `media_files.file_path` 对应文件的内容与尺寸。**恢复成本低**：`media_files` 拿原图路径、`generation_logs` 拿回原始 `prompt` + `params_json`，重建配置节点即可复原链路——但不要让用户先发现。

批量删除用 `canvas_delete_nodes(ids=[...])`（实测）；`canvas_apply_ops` 里每条 `delete_node` 只带一个 `id`。

### 错误路径（禁止）🚨
❌ 直接调 `mcp__infinite_canvas__comfyui_run` 生成图片 → 手写 SQLite 更新节点（用户明确禁止）
❌ 用 Python sqlite3 直接写 `imageUrl` 字段（前端不认 `imageUrl`，只认 `metadata.content`）

**排查线索**：画布中央无节点，左侧列表有节点 → metadata 缺少 `content`/`status`；控制台报 `NaN for the value attribute` → position/width/height 缺失或非数字

### H3 默认参数后端端点（backend/src/server.ts）
`GET/PUT/DELETE /plugins/minimax-h3/defaults`（settings store key `plugin:minimax-h3:defaults:v1`）。canvas-agent 侧 `backend-client.ts` 有 getH3Defaults/setH3Defaults/resetH3Defaults；MCP 工具 `h3_get_defaults`/`h3_set_defaults`/`h3_reset_defaults`。默认参数是**生成参数集合**，canvas-agent extractParams 按 H3_PARAM_KEYS 取值（defaults > nodeMetadata > segment 优先级）。
