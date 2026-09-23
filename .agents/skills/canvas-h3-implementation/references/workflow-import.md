# 通用 ComfyUI 工作流导入子系统（2026-09 移植自 Python）

通用 ComfyUI 工作流 JSON 导入/配置/运行，从 Python `E:\无限画布\Infinite-Canvas` 的 workflow 模块移植到 TypeScript。

## 架构

```
E:\无限画布\Infinite-Canvas-MCP\backend\src\
├── comfyui/instances.ts  — ComfyUI 实例管理（增删校验 + JSON 持久化）
└── workflows/
    ├── store.ts      — 文件 CRUD + 路径安全 + SQLite 配置读写
    ├── executor.ts   — 参数注入 + WebSocket + /prompt + /history → collectOutputMedia + 历史写入
    └── routes.ts     — Express 端点（含实例管理）

web/src/pages/workflows/
├── index.tsx                 — 主页面（列表 + 上传 + 节点图 + 运行 + 历史）
├── workflow-graph-panel.tsx  — SVG 节点图 + 内联字段编辑浮窗
├── instances-modal.tsx       — ComfyUI 实例管理
└── types/workflow.ts         — WorkflowField/Config/FieldType 类型
```

## API 端点（注册在 `backend/src/index.ts`）

```
# 工作流 CRUD
GET  /api/workflows          — 列出（custom/ 目录下所有 .json）
GET  /api/workflows/:name    — 详情（含 JSON + config）
POST /api/workflows          — 上传（校验 class_type → 存盘）
PUT  /api/workflows/:name/config — 保存字段配置
DELETE /api/workflows/:name  — 删除（内置不可删）
POST /api/workflows/:name/run   — 注入参数 → 执行

# 实例管理
GET  /api/comfyui/instances  — 列出所有 ComfyUI 后端
PUT  /api/comfyui/instances  — 保存实例列表（校验 host:port + 去重）

# 历史记录（统一走 generation-logs，不再有独立路由）
GET  /generation-logs?projectId=workflow  — 列出工作流运行历史
DELETE /generation-logs/:id               — 删除单条历史
```

> ⚠️ `/api/workflows/history` 路由已删除。历史写入在 executor.ts 里直接调 `db.createGenerationLog({ projectId: 'workflow', ... })`。
> `registerWorkflowRoutes()` 不再接收 `db` 参数。

## 数据模型

```
workflow_configs 表:
  name (PK) | title | backend | description | operation
  fields_json | media_inputs_json | mini_cards_json | updated_at

-- 历史记录已合并到 generation_logs 表（projectId: 'workflow'）
-- 不再有独立的 workflow_history 表
```

`WorkflowField.id` 是用户输入 dict 的 key，映射到 `node_id.input_name`。

## 执行链

| 环节 | 说明 |
|------|------|
| 参数注入 | 通用 `node_id + input_name` 注入（buildParams） |
| 图片上传 | 运行时 processImageFields() 上传 dataURL 到 ComfyUI 拿文件名 |
| 提交 | 直接 POST 工作流 JSON 到 ComfyUI /prompt |
| 监听 | WebSocket + /history 双通道 |
| 收集 | collectOutputMedia 复用 |

## 统一模型按输入数量路由

一个渠道模型可以挂多个底层工作流，并用 `workflowRouting` 根据参考图数量自动选择：`0 → text`、`1 → single`、`≥2 → multi`。生产调用必须传**渠道模型名**；直接传 `custom/*.json` 会绕过路由并锁死到该底层工作流。

排查顺序：

1. 从 Backend 当前 `ai.config` 读取目标渠道模型，确认它确实含 `workflows`、`workflowRouting` 和所需场景；不要把单测里的示例配置当作运行配置。
2. 按请求的参考图数量计算场景，确认解析结果对应正确工作流；不支持场景应显式报错，不能回退到第一个工作流。
3. 打开被选工作流的 config 和 graph：只有声明为 image 或指向 `LoadImage` 的字段才会接收 `referenceNodeIds`。没有图片字段的文生图工作流会忽略画布参考，即使节点连线看起来正确。
4. 提交后回读任务：外层 `model` 应是统一渠道模型名；同时核对输出文件前缀、生成日志或执行快照，确认实际执行的是预期底层工作流。

典型四视图模型应配置为：

```json
{
  "name": "四视图",
  "capability": "image",
  "workflows": [
    "custom/图生四视图.json",
    "custom/krea2人物多角度图.json"
  ],
  "workflowRouting": {
    "text": "custom/krea2人物多角度图.json",
    "single": "custom/图生四视图.json",
    "multi": "__unsupported__"
  }
}
```

这样无参考图走文生多角度，单图走身份保持的图生四视图；不要把这两个底层路径分别当成用户可选模型再由 Agent 猜测。修改运行配置后必须通过设置接口回读精确模型对象，再用统一模型名做一次真实画布任务验证路由。

## 前端页面结构（三 Tab 版，2026-09 改）

**不再有独立的「字段配置」Tab**。字段编辑全部内联在节点浮窗中。

### 页面布局
- 左列（col-span-4）：上传区（紧凑 ~40px） + 工作流列表
- 右列（col-span-8）：节点名 + 删除按钮 + 三 Tab（节点图 / 运行 / 历史）

### 节点图 Tab（默认）
`WorkflowGraphPanel` 组件渲染 SVG 拓扑图 + 内联字段编辑：
- 拓扑分层（Kahn 算法，从左到右 = 源 → 下游）
- 滚轮缩放、拖拽平移、适应视图
- 点击节点 → 浮窗显示所有可配置输入行
- 浮窗内：复选框启用字段 → 显示名 + 类型 + min/max/step/default + 下拉选项
- `onFieldsChange(fields)` 回调实时保存配置到后端
- 有字段的节点高亮 + 显示「N 字段」

### 运行 Tab
`RunPanel` 根据 `config.fields` 渲染表单：
- text → Input.TextArea
- number/boolean/dropdown → Input/Switch/Select
- image → ImageFieldUpload（FileReader → dataURL，运行时 executor 上传 ComfyUI）
- 提交后展示结果媒体

### 历史 Tab
读 `fetchBackendGenerationLogs({ projectId: 'workflow' })`，显示状态/时间/输出缩略图。

## 图片字段（image type）

**三种输入来源**：
1. **RunPanel 直接选文件** → FileReader 转 dataURL → 存为字段值
2. **生图工作站参考图注入** → workbench 的 `references` 是 URL（`/media/xxx?token=xxx` 或 `http(s)://...`），按 image field 顺序塞进 `workflowFields`
3. **默认值** → 工作流 JSON 里 LoadImage 节点自带的 filename（如 `befdf10e-...png`）

**运行时处理**（`executor.ts` 的 `processImageFields()`）：
- `data:image` 前缀 → `uploadDataUrlToComfy()` 直接上传 ComfyUI
- `http(s)://` 前缀 → fetch 图片 → 上传 ComfyUI
- `/media/` 前缀 → **这是 backend 自己服务的路径**（端口 17370），不是 ComfyUI。必须用 `http://127.0.0.1:${process.env.PORT || 17370}${value}` fetch，再上传 ComfyUI
- 已是普通 filename（如 `xxx.png`）→ 原样透传，ComfyUI 从 input 目录读取

**关键**：前端**不需要**上传路由，dataURL/URL 透传给 executor，运行时统一处理。

## 状态持久化（localStorage）

React `useState` 在页面刷新后重置。需要持久化的 UI 状态用 localStorage：

```typescript
// 初始化从 localStorage 恢复
const [state, setState] = useState<Type>(() => {
    try {
        const saved = localStorage.getItem("storage_key");
        if (saved) return JSON.parse(saved);
    } catch { /* ignore */ }
    return [];
});

// 变化时写回
useEffect(() => {
    try { localStorage.setItem("storage_key", JSON.stringify(state)); }
    catch { /* ignore */ }
}, [state]);
```

**应用场景**：
- 工作流 `ImageFieldUpload`：key = `wf_image_${fieldId}`，存 dataURL
- 生图工作站 `references`：key = `image_workbench_references`，存 ReferenceImage[]（含 storageKey，恢复时用 `backendMediaUrl(storageKey)` 重建 dataUrl）

## 多节点字段注入

`WorkflowField.node` 可以含逗号分隔多个节点 id（如 `"152,156"`），表示同一参数需同时注入到多个节点（Flux2-Klein 的 width/height 需同时写入 `EmptyFlux2LatentImage` 和 `Flux2Scheduler`）。

**处理顺序**（在 `executor.ts` 的 `run()` 中）：
1. `buildParams()` 跳过 `node.includes(",")` 的字段
2. 单独遍历多节点字段，按 `node.split(",")` 展开，写入 `multiNodeParams`
3. `buildParams()` 结果合并 `multiNodeParams`
4. 统一 `injectParams()`

## Seed 随机化

工作流 JSON 的 seed 默认值通常为 `-1`（随机）。前端传入 `-1` 时，`executor.ts` 必须在 `processImageFields()` 之后、`buildParams()` 之前随机化：

```typescript
for (const field of config.fields || []) {
    if ((field.id === "seed" || field.id === "noise_seed") && processedValues[field.id] === -1) {
        processedValues[field.id] = Math.floor(Math.random() * 1125899906842624);
    }
}
```

`buildPrompt()` 读取 `field.isPrompt === true` 的文本字段值作为 generation_logs 的 prompt。

## 内置工作流迁移（2026-09）

Z-Image、Flux2-Klein、FlashVSR1.1 从 `bridge.ts` 硬编码迁移到 `WorkflowStore` 体系：

### 文件布局
```
DATA_DIR/workflows/
├── Z-Image.json          — 内置（根目录 = builtin）
├── Flux2-Klein.json      — 内置
└── custom/
    └── 视频修复FlashVSR1.1.json  — 内置（custom/ 子目录但 builtin=true 需手动标记）
```

### list() 扫描规则
`WorkflowStore.list()` 同时扫描：
1. `workflows/` 根目录 → `builtin: true`
2. `workflows/custom/` 子目录 → `builtin: false`

根目录优先级高于 custom（同文件名根目录先出现）。

### 字段配置创建
通过 API 批量创建（Python requests 或 curl）：
```python
requests.put(
    f'http://127.0.0.1:17370/api/workflows/{quote(name, safe="")}/config',
    params={'token': token},
    json={'title': '...', 'backend': '', 'operation': '', 'description': '...', 'fields': [...]}
)
```

### 前端路由切换
`image/index.tsx` 的 `runGenerationSlot()` 中，`z-image` / `flux2-klein` / `flashvsr-1.1` 走 `runWorkflow()` 而非 `runComfyTask()`：

```typescript
const workflowNameMap = {
    'z-image': 'Z-Image.json',
    'flux2-klein': 'Flux2-Klein.json',
    'flashvsr-1.1': 'custom/视频修复FlashVSR1.1.json',
};
const workflowName = workflowNameMap[selectedModelKey];
if (local && workflowName) {
    const detail = await fetchWorkflowDetail(workflowName);
    // 注入 prompt / image / width/height → workflowFields
    const run = await runWorkflow(workflowName, workflowFields, detail.config);
}
```

### bridge.ts 清理
迁移后 `buildWorkflow()` 中的硬编码 preset 分支不再使用。但**不要从 `PRESETS` 数组删除 `z-image`/`flux2-klein`/`flashvsr-1.1`** —— 图片节点（canvas/project.tsx）通过 `runComfyTask()` 调用 `bridge.run()` 时仍依赖这三个 preset。生图工作站（image/index.tsx）走 `runWorkflow()` 路径才不依赖 PRESETS。`export { PRESETS, buildWorkflow }` 仍保留给 H3 用。

## 关键陷阱

### 路径穿越防护
`workflowFilePath()` 必须校验最终路径落在 `DATA_DIR/workflows/` 内。

### JSX patch 孤儿块
用 `patch` 交换 JSX 布局时，若 `old_string` 同时关闭外层 wrapper，替换后会在网格外留下孤儿 JSX，Babel 报 `Adjacent JSX elements must be wrapped`。

**修复**：grep 检查类名出现次数，若重复直接 `sed -i '<start>,<end>d'` 删孤儿块。

### React ref 竞态（setView + panRef）
`setView((v) => panRef.current.ox + ...)` 在 updater 异步执行时 `panRef.current` 已被 mouseUp 置 null → 崩溃。

**修复**：updater 外捕获 ref 到局部变量 `const pan = panRef.current; if (!pan) return;`，闭包引用局部变量。

### 拓扑分层方向
`incoming[id]` 应存 id 的**上游节点**（入边），搞反后图从右到左。

正确：`incoming.get(id)!.add(v[0])`（v[0] 是 from_node，id 是 to_node）。

### 路由注册顺序
`/api/workflows/history` 必须在 `/:name` **之前**注册（已删除，但新路由注意）。

### TypeScript 同步
`WorkflowFieldType` 在 `web/src/types/workflow.ts` 和 `backend/src/db.ts` 两份定义，修改时需同步。

### 编译避坑
- 函数签名用 `type Props = {...}; function Comp(props: Props) {...}` 而非内联对象类型。
- 不再需要 `antd` 的 `Upload`/`Dragger`、`Modal`、`Settings2`、`Tree`。

### /media/ 路径归属
backend 自己服务 `/media/:storageKey`（端口 17370），不是 ComfyUI。当 executor 需要 fetch 图片再转发给 ComfyUI 时，`/media/` 开头的值必须拼到 backend 的 base URL（`http://127.0.0.1:${process.env.PORT || 17370}`），不能拼到 comfyUrl 上。

### 数据库 inspection
backend 的 node_modules 里没有 better-sqlite3。需要查 SQLite 数据时，用 Python 内置 sqlite3：
```bash
python3 -c "import sqlite3, json; conn=sqlite3.connect('C:/Users/wxy/.infinite-canvas/runtime.sqlite'); c=conn.cursor(); c.execute('SELECT ...'); print(json.dumps(c.fetchall(), ensure_ascii=False))"
```

### 生图工作站参考图注入
生图工作站的 `references` 存的是 URL（`backendMediaUrl(storageKey)` 返回的 `/media/xxx?token=xxx`），不是 dataURL。`processImageFields` 必须处理 URL 类型，否则 ComfyUI 收到非法文件名报 `prompt_outputs_failed_validation`。

### 历史 Tab 按选中工作流过滤
历史 Tab 读 `fetchBackendGenerationLogs({ projectId: 'workflow' })` 后**必须按 `selected.name` 过滤**：
```typescript
const data = await fetchBackendGenerationLogs({ projectId: "workflow", limit: 50 });
setHistoryLogs((data.logs || [])
    .filter((log) => !selected?.name || log.workflow === selected.name)
    .map((log) => ({ ... })));
```
不选任何工作流时（`selected === null`）显示全部，保持兼容。`loadHistory` 的 `useCallback` 依赖必须含 `selected?.name`，否则切换工作流后历史不刷新。

### 用户偏好
- **工作流图默认 SVG 可交互**，不是 antd Tree 或纯列表。
- **图片字段透传 ComfyUI**，不预上传。
- **字段配置内联在浮窗**，不要拆成独立 Tab + Modal。
- 改 2-3 次没修好就停手重新收集信息。

## 按任务读取的工程约束

> 下列工程细节从技能入口移至此处。仅应用与当前任务有关的条款；路径 `references/`、`scripts/` 均相对于技能根目录。证据纪律、画布 MCP 留档、用户进程保护与当前明确要求优先。

## 工作流导入子系统（2026-09）
通用 ComfyUI 工作流 JSON 导入/配置/运行，移植自 Python `E:\无限画布\Infinite-Canvas`。参见 `references/workflow-import.md`。

### ★ 「画布 2 MB」是连环解，第一轮剥大头不代表完事 —— 验证口径必须能发现下一层根因

**用户报"画布太大被截"**时，按"找最大字段、剥掉、commit、收工"做的方案是错的——这个症状每轮都有"下一层根因"：本项目实际经历过两轮：

1. **v4**：`metadata.materials`（实际大头）。修完 commit，**spillover 文件复测仍 2 MB**。
2. **v5**：`segments[i].results[].params` + `segments[i]` 上的 9 个输入快照字段。再次 commit，**再次复测**才真正降到 30 KB。

**验证口径**（每轮 migration 后必跑）：
- 用 `canvas_get_state({detail: 'full'})` 取画布，**直读 spillover 落盘文件**（`%LOCALAPPDATA%/hermes/cache/spillover/call_*.txt`），**用 stream-parse 提取每个节点的 metadata 体积并降序**，**不**只看 spillover 文件总大小。
- 总大小看起来变小了**不代表**根因字段被剥干净——可能只是大头换了一个字段，根因写法没变。**逐节点扫描 metadata 顶层 keys**，看每个 key 的体积，找出新的 top-3 才算这一轮真的"剥到位了"。
- **不要**"剥完大头就宣称 vN migration 解决问题"——必须再有证据证明"再剥一层没东西可剥"才算完。

**MCP 工具返回 spillover 文件的 stream-parse 模板**（已实现、可复用）：
- 文件是双层 JSON：外壳 `{"result": "<inner>"}`，inner 是字符串（`\"` = chr(92)+chr(34)，`\n` = chr(92)+chr(110)）。`outer = json.loads(spillover_file)` 一定能解（外壳合法），`outer["result"]` 是字符串但**已经是 decoded 后的内容**：里面的 `"` 是真 `"`（不是 `\"`），`\n` 是真换行（不是 `\n`）。**不要再 `replace('\\\"','\"')` 或 `replace('\\n','\\n')`**——会破坏结构。
- 节点数组起点：`\"nodes\": [` 之后第一个 `{`。节点数组终点：最近 `\\n  ],\\n  \\\"connections` 之前。单节点起点：`\\n    {`（4 空格 + {）。每个节点起点后 ~500 字符一定有 `id` / `type` / `title` / `position`。
- 体积分解：扫 `\\n      \"key":`（8 空格缩进 = 顶层 key），key 与下一个 key 之间 = 该字段体积。降序看 top-5。**H3 metadata 字段 indent ≥ 10 空格的是嵌套对象内部 key，要按栈深度区分**——别把 segments[i].results[j].url 算成 metadata 顶层。

**第二轮 patch 后必须 grep 验证关键字段已落盘**：本会话 v5 commit 前 patch 了 `use-canvas-store.ts` 删 `"materials"`，工具返回 success + diff。但下一轮 `git status --short` 时 `grep "materials"` 文件里仍然在。**根因**：`use-canvas-store.ts` 的整个 working tree 有 200+ 行用户的 dev diff（folder feature 等），patch 在这种大文件上偶尔"看着对、实际 no-op"——old_string 与文件现状完全一致所以返回成功但没改。**修法**：patch 后**立刻 `grep -c <关键字段> <文件>`**——比如 `grep -c '"materials"' <文件>` 应为 0。没落到 0 = patch 没生效，重 `read_file` + 重 patch。

### frontend IndexedDB sync 反向写回——每轮 migration 后必查

**`use-canvas-store.ts` 的 `hydrateCanvasProjectsFromBackend()` 后，如果本地 IndexedDB 仍有上次 hydrate 的全量快照（含 migration 已剥掉的字段），后续 `isLocalProjectNewer()` 命中 + `upsertBackendProject(project)` 会**整份 PUT 把已剥字段塞回去**。**实测代价**：v5 migration 跑过 `[migrate v5] trimmed ...` 输出成功，**但 frontend 几秒钟后把含 fat 字段的本地快照写回 backend，看 backend log 只有 migration 那行 warn**——migration 看起来成功，体积却没真的降。

**对策优先级**：
1. **跑 migration 前先关 web**（不杀 concurrently / tsx --watch）：用 `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*web*node_modules*vite*' } | Select -First 1 | Stop-Process -Id {$_.ProcessId} -Force`。**不要**用进程名宽条件（`CommandLine -like '*vite*'`）。
2. **web 侧 hydration 后清掉本地 stale 字段再 `saveToLocalStorage`**：在 `use-canvas-store.ts` 的 `hydrateCanvasProjectsFromBackend` 末尾加一段 sanitize——遍历 project.nodes，对 type 以 minimax 开头的节点 `delete node.metadata.materials` / `delete node.metadata.segments[i].results[j].params` 等已剥字段。
3. **backend `upsertCanvasProject` 检测 deprecated 字段时拒绝写入并返回 warning**——根治，但改 backend 写入路径会动到 revision/事务，影响面大，前两条工程补丁先。

**根治需要 web `localSnapshotPersistence` 与 backend authoritative state 之间有显式字段同步层**，而不是"本地新 → 整份 PUT"。本会话两轮 migration 都中了这个招，第二轮比第一轮更明显（前端 v5 后又把"未剥 v5 字段的旧 fat 段"写回去了）。

## 工作流 executor 作用域陷阱
`backend/src/workflows/executor.ts` 的 `processImageFields` 函数末尾曾有一段从 `removeEmptyImageNodes` 复制来的代码，遍历 `Object.values(result)` 访问 `.inputs`，但 `result` 是字段值 map — 空字段值为 `null` 时抛 `Cannot read properties of null (reading 'inputs')`，且引用了不在作用域的 `removed`。

**规则**：函数内遍历 `Object.values()` 访问属性前，必须加 `if (!node || typeof node !== "object") continue;` 守卫。从其他文件复制代码时，检查所有引用的变量在当前作用域可用。
