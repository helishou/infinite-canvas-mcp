# 开发定位、构建与验证

## 按任务读取的工程约束

> 下列工程细节从技能入口移至此处。仅应用与当前任务有关的条款；路径 `references/`、`scripts/` 均相对于技能根目录。证据纪律、画布 MCP 留档、用户进程保护与当前明确要求优先。

## 代码位置
- 插件源码: `E:\无限画布\Infinite-Canvas-MCP\plugins\canvas\minimax-h3\src\`
  - `components\H3Workbench.tsx` — 节点主布局（wb-body grid、CSS 变量注入到 <style>）
  - `components\H3WorkbenchPrimitives.tsx` — 播放指针(H3PlayheadStyle)、时间尺点击区(H3RulerScrubber)、窗格拖拽手柄(H3PaneHandles)、预览器(H3PreviewPlayer)、resolveH3PaneSizes（布局快照解析）
  - `components\H3Timeline.tsx` — 时间轴（ruler + Video + Refs 轨道，`timelineWidth = max(500, total*50)`，ruler 可横向滚动，多容器 scroll 同步）
  - `components\H3Runner.tsx` — run() 执行入口（读最新 metadata → 选引擎 → ctx.ai.runLocalH3 / runRunningHubH3）
  - `components\H3ClipSettingsPanel.tsx` — Setting 面板（导入/导出/设为默认参数按钮）
  - `services\h3-defaults.ts` — 默认参数浏览器镜像（localStorage，v2 含 layout 子对象）
  - `components\H3PromptSection.tsx` / `H3CurrentClipPanel.tsx` / `H3MaterialLibrary.tsx`
  - `styles\h3.css` — 全部布局（长文件，多段重复定义互相覆盖，后段胜前段；改一个 grid 要同步改所有相关选择器）
- 宿主注入: `web\src\pages\canvas\hooks\use-plugin-host.tsx`（ctx.ai.runLocalH3 实现 + h3Defaults REST 代理 + v2 布局镜像同步 stripLayout）
- 节点 spec: `web\src\lib\canvas\node-registry.ts`（getNodeSpec 优先读 `def.defaultLayoutSize` getter 决定新节点宽高，UI 创建与 canvas-agent-ops 都走它）
- 浏览器 API: `web\src\services\api\comfyui.ts`（runLocalH3Task：syncReference 落地素材 → POST {agent}/comfy/tasks → 1.2s 轮询）
- 后端桥: `backend\src\comfyui\bridge.ts`（ComfyUIBridge：buildNanFengV10Workflow 拼 prompt 图 → upload → POST ${comfyUrl}/prompt → 1.5s 轮询 /history）
- Agent MCP 入口: `canvas-agent\src\plugins\minimax-h3\mcp.ts`（h3_run_clip 等工具，独立入口不走浏览器）

## 调研工具优先级（重要！）

**未定位代码或需要跨文件关系时，优先使用已有 CodeGraph 索引；已知文件的局部修改直接读取相关区域。** 不为小修复重复全库探索，也不自行新建索引。
- 它能直接返回完整的函数签名、类型定义、调用关系、import 链 — 相当于一次精准的 grep+read+typecheck。
- 例：查 `fetchBackendGenerationLogs` 的定义 → 拿到完整参数类型 + 8 个调用方 + 所在文件行号。
- 例：查 `generation_logs` schema → 直接看到表结构、索引、所有 CRUD 方法。
- **尤其适合跨多个文件追踪数据流**（如 workbench-logs.ts → backend-api.ts → server.ts）。

调用方式：`tool_search(['keyword'])` → 拿到 `mcp__codegraph__codegraph_explore` → `tool_describe` → `tool_call({projectPath: 'E:/无限画布/Infinite-Canvas-MCP', query: '关键词'})`。

## 构建与验证（按本次改动影响选择）

**★ 插件不走 bundle（2026-09 血泪教训）：`web/src/lib/canvas/plugin-loader.ts` 里 `HOST_SYSTEM_PLUGIN_IDS = Set(["minimax-h3"])` — activatePlugin 对该 id 直接 return，节点渲染走宿主内置组件链，吃的是 `plugins/.../minimax-h3/src/` 源码并由 Vite HMR 热更。改 bundle / public/plugins 下的文件对运行中的节点无效（grep dist 通过 ≠ 生效）。验证顺序：改 src → 活页面 HMR 自动更新 → browser_exec 接管用户页面读 DOM/computed style 实测。曾连续 5 轮只 patch 构建产物方向全错。**

按变更选择相关检查，不把下面列为每次都执行的串行清单：

1. 插件 TS/TSX 变更：在插件目录运行项目类型检查。历史错误名单只作线索，按实际错误身份/行为区分基线与新增，检查本次修改引发的跨文件回归，不能只过滤改动文件名就宣称通过。
2. 生产 bundle 交付或构建逻辑变更：在插件目录运行 `node build.mjs`；纯 dev UI 调整不为验证 HMR 重复构建无关 bundle。
3. 宿主 web 变更：使用 web 对应类型检查；已运行的 Vite 自动 HMR，不启动第二个服务。
4. CSS/交互变更：核对相关注入、样式和拖拽 metadata 的真实值，并在实际页面验证。仅在本次涉及的路径同步约束。


### ★ 两套进程读两套代码：MCP 层改动必须 `npm run build`

同一份 `backend/src/**`，两个消费方走的是**不同产物**：

| 消费方 | 跑什么 | 改动如何生效 |
|---|---|---|
| Backend HTTP（:17370） | `tsx --watch src/index.ts`（**源码**） | 存盘即热重载，无需构建 |
| MCP stdio 层 | `node backend/dist/index.js mcp`（**编译产物**） | **必须 `npm run build`** |

**这是「明明改了源码、grep 也过了、行为却没变」的头号原因。** 判据：`grep -c <新符号名> backend/dist/**/*.js` —— 命中 0 就是 dist 陈旧。改完 `backend/src/**` 里任何会被 MCP 工具层用到的东西（`mcp.ts`、`canvas/**`、`server/**`）后，**先 build 再验证**：

```bash
cd E:/无限画布/Infinite-Canvas-MCP/backend && npm run build && grep -c <新符号名> dist/canvas/*.js
```

配套的进程重载纪律见下一节（先看用户是否开着 dev 栈，再决定动不动进程）。

### MCP 产物与用户进程生命周期

先确认实际进程的完整命令行、创建时间和读取路径。用户的 `dev:local` / `tsx --watch` 链、Hermes 拉起的 MCP stdio 子进程可能同时存在，不能把一个进程的热更新能力推给另一个。

- `canvas-agent/src/**` 的修改若由编译产物消费，运行对应 workspace 构建；Backend HTTP 的 tsx watch 与 MCP stdio 的 dist 路径分开验证。
- 插件 UI 在 `HOST_SYSTEM_PLUGIN_IDS` 路径下消费 src + HMR；只有交付/验证生产 bundle 时才执行插件目录的 `node build.mjs`，不以 grep dist 代替 UI 行为验证。
- 已有 MCP 子进程/schema 不会因为另一个 tsx watch 更新而自动刷新。确认仍是旧 schema/产物后，说明需要重新加载；本机 Hermes 的 MCP schema 更新通常需要用户完全退出再启动 Hermes。
- 不自动杀、重启用户服务，不使用按项目路径或 `*dist*index.js*mcp*` 批量杀进程的命令。若用户明确授权重载，先识别具体拥有者和 PID，再操作授权的目标；不影响 concurrently、tsx watch、Vite 或 ComfyUI。
- 仅凭端口 LISTENING 或进程存在不足以证明正确版本已就绪。验证实际接口/节点行为，并区分未构建、旧进程、schema 缓存和业务失败。


### 写片段计划的入参容错（2026-09 补齐）

`h3_apply_video_plan` 的 `segments[].references` / `subjects` / `timeline` 曾经**缺省即崩**（`segment.references is not iterable` / `Cannot read properties of undefined (reading 'map')`），与 `validateVideoPlan` 的 `|| []` 容错口径不一致。已在 `video-plan.ts` 的 `normalizePlannedSegment` 与 `compileChineseH3Prompt` 补 `|| []`（注意 `compileChineseH3Prompt` 里 `subjects`/`timeline` 有两处独立引用，只补返回值那处不够）。另注意 `compileChineseH3Prompt(segment, refs = segment.references)` 的默认参数**在调用方显式传 `undefined` 时不生效**，所以函数内也要 `|| []`。

## 用户偏好

### 证据纪律（本会话被连续纠正三次，最高优先级）
- **声称「代码没有 X」之前，搜完所有可能存放位置。** 本会话我 grep 了仓库里的 `.ts/.tsx` 就断言「四视图不是模型选择」，但四视图是 `~/.infinite-canvas/workflows/custom/图生四视图.json`（运行时数据，不在仓库源码里）。用户反问「四视图就是模型选择啊」。**结论必须限定在自己实际搜过的范围，不能从「我没找到」跳到「不存在」。**
- **不要把推测说成实测。** 判断一个参数/字段「缺失」「没生效」前，先确认**读取方实际读哪一层**：本会话连续两轮误判（先说 title 是稳定 bug —— 其实复现失败；再说「MCP 参数 16/16 一致」—— 其实只查了节点级、生成时读的是 segment 级）。**写了「一致/正常」而没有覆盖所有消费层级，就是误报。**
- **修复前先验证「要修的那个源头真的存在」。** 本会话提议修 `panes` 缺失，实测发现省略 `panes` 与传空 `{}` 深度相等（不是病因），而且 Backend 默认参数里根本没有布局字段 —— 白白提出一个不存在的修复。**先跑一个最小探针证实因果，再写改动。**
- **不要自行绕过用户定的红线图快。** MCP 没有画布改名的工具，我就直接写了 SQLite 改 title。应该先问用户，而不是先动手。参数/工具的局限要主动上报，不能当“变通”的借口。
- **区分落盘与运行生效**：文件工具已确认验证写入时，不为证明写入重复整读；通过相关测试、真实消费路径或页面状态判断行为是否生效。工具报错、未验证写入或怀疑并发覆盖时再检查精确目标。

### 沟通方式
- **先给结论和证据，再讲过程。** 不要说「等等我要先确认 X」然后停下来 —— 直接查完并给出结果。
- **★ 后台任务跑完了要主动报，不要等用户来问。** 实测被直接质问「咋样了，有结果咋不报我」。长任务（生成、批处理、重跑）完成后必须立刻出结果；如果当时正在处理其他事，至少先报一句「已完成，正在核对 XX」。**不要让用户来催 —— 催一次就等于把「你有没有在盯」变成一个需要用户管理的负担。**
- **发图给用户时必须用从数据库查出的真实路径。** 凭手感拼 `storageKey` / 文件名会得到一串不存在的路径，而 MEDIA 渲染失败是静默的 —— 用户看到的是空白，不是报错。每次都 `SELECT file_path FROM media_files WHERE storage_key=?` 现查。
- **测试节点绝不能留在用户画布上。** 在**临时画布**做实验，用完立刻删并确认节点数与 `revision` 回到预期。
- **用户说“用 X 做 Y”时，先验证 X 真的能做 Y 再报告。** 不要把「一个工作流字段为空」当成「不能用」，也不要把不合适的工具硬改出近似效果。

### 技术偏好
- 讨厌凭猜改 bug：修前先看实际状态（DOM/计算链路），改 2-3 次没好就停手重新收集信息。活页面验证优先用 browser_exec 接管用户已授权的 Chrome（用户勾过 chrome://inspect 远程调试），读 computed style / elementFromPoint / 合成点击，不用让用户截图。
- **咨询透传按 `query-routing` 的任务边界执行**：保留纯咨询透传偏好；需要本会话证据、文件、工具或自己工作结果的问题留给主模型，不能因出现“决策/路由”字样就脱离实际上下文。
- **H3 配置 InputNumber 字段必须支持清空**：`onChange` 不能写 `Number(value ?? 默认值)`，否则用户删空时 antd 传 `null`，`null ?? 5` = `5`，瞬间弹回默认值。正确模式：`value={segment.x != null ? Number(segment.x) : undefined} placeholder="默认值" onChange={(value) => patch({ x: value ?? undefined })}`。
- **前端显示值必须等于实际参数值，禁止 `undefined` 与显示值不一致**：UI 用 `value={segment.x || "默认值"}` 显示默认值，但提交时 `segment.x` 仍是 `undefined` — 后端分支逻辑（如 `sageAttention === "H3专用Sage加速"`）会走到错误路径。`BASE_DEFAULT_METADATA`（node-definition.ts）和初始 segment 必须**显式包含**所有影响后端分支的字段（`sageAttention`、`textEncoder`、`videoVae`、`audioVae`、`modelName`），不能只靠 `H3Runner.tsx` 里的 `segment.x || "默认值"` fallback。新建段时 `H3Timeline.tsx` 的 `addSegment` 用 `{...inherited}` 从上一段继承。
- **`H3Runner.tsx` 里 `segment.sageAttention || "H3专用Sage加速"` 不要回退到 `"auto"`**：NanFeng V10 用 `MiniMaxH3MemoryEfficientSageAttentionPatch`（H3 专用），`"auto"` 走的是普通 `PatchSageAttentionKJ`，两者是不同的 ComfyUI 节点。默认必须跟 V10 对齐。
- **H3 下拉/选择字段必须用 antd `<Select>`**（`showSearch` + `allowClear`），不能用自定义 `<input type="search">` + `<datalist>` — 后者在 `useEffect` 依赖 `patch` 时触发 Maximum update depth exceeded 死循环。`patchSelected` 必须用 `useCallback` 包裹稳定引用。
- **H3Dropdown 已完全移除**：`ClipSettings.tsx` 里的 `H3Dropdown` 自定义组件已被整个删除，全部改用 `import { Select } from "antd"`。
- **Antd/React 19 的 Portal 可在高频画布 render 下触发 `Maximum update depth exceeded`**：若栈落到 `@rc-component/portal` 的 `setInnerContainer` effect（Vite chunk 内通常是 `getPortalContainer(getContainer)`），先检查已安装 `Portal.js` 是否仍是无 dependency array 的 `useEffect`；不要把最终落栈的 Tooltip/Select 当成业务根因。当前 npm `@rc-component/portal@2.2.0/2.2.1` 仍可能缺 `[getContainer]`，用幂等 postinstall patch 同时覆盖 ESM/CJS，并为当前 dev 实例核对**HTTP 实际提供的 chunk**（磁盘已改不代表 Vite 内存缓存已更新）。验证必须保持 Tooltip/Select Portal 打开并注入高频 mousemove/render，监听 `Runtime.exceptionThrown`；只做页面加载 smoke 不够。Vite 在 `concurrently` 下要重载时不要杀父树，可更新 `vite.config.ts` mtime 触发 Web 自身 restart，再确认 3001 返回 patched chunk。
- **Antd Select 高度与行高必须一致**：`.ant-select-selector` 容器高度必须等于行高（如 `height:48px; line-height:48px`），否则文字会被切掉一半。背景必须显式设为 `transparent`。正确模式：`min-height:48px !important; height:48px !important; padding:0 6px !important; border:0 !important; background:transparent !important; box-shadow:none !important;` + `.ant-select-selection-item { font-size:14px; line-height:48px !important; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }`
- **导出参数设置必须排除 `duration`（时长）**：`H3_SETTINGS_KEYS` 过滤时加 `&& key !== "duration"`。用户明确不要导出时长，导入后各 clip 保持各自时长不变。
- **跨文件追踪数据流/架构理解时，先用 `mcp__codegraph__codegraph_explore`**。
- 新增页面/面板时，`web/src/layouts/user-layout.tsx` L13 的 `overflow-hidden` 会截断子页面滚动。内容超出视口时改为 `overflow-auto`，但注意：canvas 画布页依赖 `overflow-hidden`，改之前确认只影响新路由页。
- 加 UI 字段前先想能否单一来源派生，别让用户手填 N 个相关字段。
- **工作流页面默认展示 SVG 节点图（可交互）**，不是 antd Tree。
- **字段配置内联在节点浮窗**，不要拆成独立 Tab + Modal。
- **图片字段透传 ComfyUI，不预上传**：前端存 dataURL → 运行时 executor 统一上传 ComfyUI 拿文件名 → 注入节点。
- React key warning 修复最小化：只给真正在数组/多 JSX 表达式里的渲染单元加命名空间 key，静态 JSX 和 `segments.map()` 构造数据（非 JSX）被 React 点名属误报，不动。
- **归因用 git 实锤**：warning/error 疑似某文件引发而「不是我改的」时，查 `git log -1 --format="%ad"` + 本会话起点时间 + `git diff HEAD --stat -- 该文件`，三证齐全再下结论。
