# AGENTS.md

本文档提供本项目的 AI / 自动化开发默认约定；用户当前明确要求优先于这些默认约定，同时遵守更高优先级的系统与开发者指令。

## 基本原则

- 先读现有代码，再动手修改，优先沿用项目已有结构和写法。
- 写代码保持最少行数，能简单实现就不要引入复杂抽象。
- 标准格式、协议、解析、压缩、加密、日期等通用能力优先使用成熟稳定的库，不要手写底层实现，除非用户明确要求或项目已有实现必须沿用。
- 不要为了“兼容更多场景”写大量分支，只实现当前明确需要的功能。
- 不为尚未使用的旧结构增加兼容分支；涉及已有用户数据时，仍须遵守下文备份、迁移与禁止覆盖的要求，不能以“尚未上线”为由丢弃数据。
- 默认不执行全量语法检查、测试或构建，用户会自行验证；受影响的运行时产物重建、下文指定的画布性能验证，以及用户明确要求的验证除外，只执行相关范围。
- 不要改无关文件，不要顺手重构。
- 如果工作区已有用户改动，不要回滚，不要覆盖；只在必要范围内追加修改。

## 反复提醒沉淀

- 如果开发过程中总是遇到某个问题，或者用户反复提醒同一个注意事项，需要把该注意事项补充到本文件。
- 补充时写成明确、可执行的规则，避免只写模糊描述。
- 新规则应放到最相关的章节；找不到合适章节时放到“项目注意事项”。

## 前端规范

- 前端使用 Vite、React、React Router、TypeScript、Ant Design、Tailwind、Zustand。
- 编写 Ant Design 相关代码时，优先沿用项目当前 antd 版本与既有写法；API 不明确或使用新能力时再查对应组件官方文档，必要时从 https://ant.design/llms-full.txt 定位相关内容，不必每次通读。
- 前端请求入口统一放在 `web/src/services/api/`；业务数据与后台任务遵循现有 Backend 接口，第三方模型请求沿用现有渠道直连设计，不擅自改变前后端职责。
- 全局或跨页面状态优先放在 `web/src/stores/`。
- 已经放在全局 store 或全局 hook 中的状态/动作，组件需要时直接使用对应 store/hook，不要为了“纯组件”层层透传 props；避免一个组件传递过多参数。
- 全局组件、全局常量、全局配置等全局性质的内容不要作为 props 或参数层层传递；哪里需要就在哪里直接从对应全局入口获取。
- 多个页面重复出现的 UI 副作用动作，例如复制文本并提示、下载并提示、统一确认弹窗，优先抽成 `web/src/hooks/` 下的全局 hook；不要放进 store，除非它确实是需要共享/订阅的状态。
- 路由页面放在 `web/src/pages/`，页面布局放在 `web/src/layouts/`，路由配置放在 `web/src/router.tsx`。
- 画布页面放在 `web/src/pages/canvas/`，画布组件放在 `web/src/components/canvas/`，画布状态放在 `web/src/stores/canvas/`，画布工具函数放在 `web/src/lib/canvas/`。
- 页面按目录组织，例如 `web/src/pages/image/index.tsx`；页面里只有一个主业务组件时直接写在对应页面入口中，不要单独拆 `Manager` 组件再传一堆 props。
- 不要新增只做简单转发的组件，例如只 `return <X>{children}</X>` 或只换个名字透传 props；直接在使用处使用真实组件或把逻辑写进当前文件。
- 页面私有 hook 放在对应页面目录下，例如 `admin/assets/use-admin-assets.ts`；只有多个页面真实复用的 hook 才放到外层 `hooks/`。
- 管理后台页面私有组件放到各自页面目录的 `components/` 下，例如 `admin/assets/components/`、`admin/prompts/components/`；不要为了单页面使用放到 `admin/components/` 共享目录。
- 管理后台主题、背景、卡片阴影、表格配色等统一在 `web/src/lib/app-theme.ts`、`AppProviders` 或必要的全局 CSS 作用域中配置；页面私有组件不要自己写 `dark ? ...` 主题分支。
- Ant Design 的 Dropdown、Menu、Select、Cascader、TreeSelect 等弹层背景、悬停态和选中态颜色统一通过 `web/src/lib/app-theme.ts` 的全局 Alias Token 与组件 Token 配置；不要在业务组件内为单个弹层覆盖颜色。
- 组件优先使用函数组件和现有 hooks，不新增大型状态管理方案。
- UI 图标优先使用 `lucide-react` 或项目已经使用的 Ant Design 图标。
- 页面文案保持中文。
- 不要在组件里堆太多无关逻辑；复杂逻辑优先抽成同目录工具函数或小组件。
- 样式优先由组件自己管理；组件私有样式优先使用 Tailwind className 或少量内联 style，不要为单个组件新增大量全局 CSS。
- 全局 CSS 只放基础变量、全局重置、跨页面通用样式和少量第三方组件必要覆盖；不要在 `globals.css` 堆页面私有样式。
- 代码尽量短小直接，少拆不必要组件，少做多层 props 传递，避免为了抽象堆出更多代码。
- 业务数据以 Backend SQLite 为权威；浏览器仅持久化可丢弃缓存、纯视图状态和连接引导信息，较大缓存用 `localforage`，`localStorage` 只放极小的视图或连接配置，不保存业务列表、生成记录、图片、base64 或大 JSON。

## 画布 UI 规范

- 做 canvas 前端 UI 时必须遵循当前画布主题。
- 优先使用 `canvasThemes`、`useThemeStore` 或 Ant Design `ConfigProvider` token。
- 不要硬编码黑白、stone、slate 等颜色导致浅色/深色主题不一致。
- 新增画布按钮、弹窗、浮层时，尽量复用已有工具栏、节点面板、Modal 的视觉风格。
- 画布顶部工具栏和状态信息优先采用极简扁平风格：无边框、无阴影、无胶囊背景，融入整体背景，弱化按钮感，仅保留轻微 hover 反馈，保持简洁现代、低视觉重量。
- 左侧画布面板等列表里的节点/元素缩略图容器，非图片类型（文本、配置、视频、音频等）不要使用 `theme.node.fill`（`#e7e5df`/`#292524`）这类灰色背景，图标直接无背景展示，尽量不要给多余底色，保持干净。
- 画布内的操作按钮（如面板里的「添加」「导出」「选择」等）默认用扁平无底色样式：透明背景、仅 `hover:bg-black/5 dark:hover:bg-white/10` 轻微反馈，靠图标+文字表达，不要用 `theme.toolbar.activeBg`（`#e7e5df`/`#3a3631`）或 `theme.node.fill` 之类的灰色作为按钮填充底色。灰色 `activeBg` 只允许用于「选中态」等需要表达状态的高亮，不要当普通装饰底色。
- 图片节点尺寸逻辑要尊重原始比例，除非功能明确要求自由变形。
- 批量生成、多图展示、助手面板等画布交互要尽量简洁，不要占用过多画布空间。
- H3 节点行高手柄交互规则（用户多次强调，任何行高/拖动逻辑改动都必须遵守）：
  - 拖 Output 和 VideoRefs 的分界线时：上面的 preview 高度不变，只有 Output 和 VideoRefs（时间轴）高度变化。
  - 拖 VideoRefs 和 preview 的分界线时：下面的 Output 高度不变，只调 VideoRefs（时间轴）和 preview。
  - 空间不足时由节点自动长高/缩回兜底，不允许出现「拖 A 时 B/C 跟着变」的联动串扰。
- H3 设置区的 Ant Design Select 使用 `size="middle"`；调整“收起后显示的当前值”时必须作用到 Select 的 `styles.content/item/itemContent` 或 `labelRender`，不能只改下拉选项、外层 `.ant-select` 或 selector 边框。显式字号与行高必须配套，并实际检查文字未被边框裁切。
- H3 的两条自定义滚动条（时间轴横向 `H3Timeline`、主提示词竖向 `canvas-collaborative-text.tsx` 的 `promptLineMapExtension`）都隐藏原生滚动条，轨道与滑块在同一个容器内、靠事件冒泡统一分流「拖滑块 / 点轨道」；不要再往上叠「跳转到 Clip / 区块」的 DOM 标记或按钮（覆盖物会吞掉命中，表现为点哪都跳到某一区块，即“滚一段距离就停”）。点击轨道立即把滑块中心对齐指针并可接着拖动，禁止给点击跳位加缓动动画，必须即时到位；屏幕坐标换算要先除以 rect 宽（高）与布局宽（高）之比再比对内容宽度，不能写死 100px/秒 之类的常量，否则画布缩放后点位与内容错位。
- 画布视口（平移/缩放）性能红线：**高频视口变化不得走 React state**。拖动与滚轮期间只能命令式写容器 `transform`（`writeViewport`），仅当**屏幕位移**超过 `VIEWPORT_CULL_SCREEN_MARGIN`(300px)、缩放幅度超过 `VIEWPORT_CULL_ZOOM_RATIO`(0.35)，或**实际视口将越出已挂载渲染范围的安全带**时才用 `startTransition` 补一次裁剪重算；松手 / 失焦 / 500ms 滚轮静止 / 聚焦动画 / 缩放控件 / 小地图 / 重置视图这类低频入口必须走 `commitViewport`，保证命令式实时值与 React state 一致。请求中的裁剪范围不得当作已经挂载；过期 transition 不得覆盖更新的实时视口。禁止把平移改回逐帧 `setViewport`（实测 33fps → 回退即掉回 30 档），也禁止给 `applyViewportLive` 加节流/防抖（用户会直接感知为「不跟手」）。`web/src/lib/canvas/canvas-viewport.ts` 里的两条硬约束：①**补重算阈值、覆盖安全带与裁剪前瞻都必须按屏幕像素定义，绝不能按世界单位**——拖动的 x/y 是屏幕像素，按世界单位算会被放大 1/k 倍，缩小看全图时（k=0.05）退化成"平移 26px 就重算一次"，而每次重算都要重建全部可见节点的 element 树，直接把 5% 倍率平移压到 26fps；②**`VIEWPORT_RENDER_SCREEN_PADDING` 必须大于 `VIEWPORT_CULL_SCREEN_MARGIN`**（400 > 300，差值即补渲染提前量），改小会导致拖动时露出空白；裁剪外扩用 `viewportRenderPadding(k) = 400 / k` 随缩放反比放大，所以低倍率下会多渲染一圈节点，这是不反复重算的代价。新增任何改变视口的入口时，必须同时接上这两条路径，并补充覆盖范围和缩放锚点验证。

## 文档规范

- README 保持简洁，只放项目介绍、核心功能、快速开始和文档入口。
- `docs/index.md` 放给 AI 使用的文档索引，不要再放到 `docs/content/docs/` 内容目录里。
- 详细功能介绍写到 `docs/content/docs/overview/features.mdx`。
- 后续待办写到 `docs/content/docs/progress/todo.mdx`。
- 已实现但还需要用户测试确认的事项写到 `docs/content/docs/progress/pending-test.mdx`。
- `docs/content/docs/progress/pending-test.mdx` 用来记录这个版本实际做了哪些可测试变更；`CHANGELOG.md` 的 `Unreleased` 只保留对这些变更的版本级归纳，避免逐条照搬实现细节。
- 每次重大改动（新增/调整/删除功能、接口或工具，影响用户可感知行为）完成后，都要在 `CHANGELOG.md` 的 `Unreleased` 追加一条记录，按 `[新增]` / `[调整]` / `[修复]` / `[优化]` 前缀分类，用一句中文归纳；纯内部重构、格式化、无用户可感知影响的小改动可不记。
- 每次 todo 事项完成后，先从 `docs/content/docs/progress/todo.mdx` 移到 `docs/content/docs/progress/pending-test.mdx`，不要直接写进正式功能说明；用户确认测试通过后再更新 `docs/content/docs/overview/features.mdx`。
- 功能、待办状态或待测事项实际变化时，检查并按需更新 `docs/content/docs/progress/todo.mdx` 和 `docs/content/docs/progress/pending-test.mdx`；纯问答、审查、提交或内部说明调整无需例行读取、修改或报告“无需修改”。
- 文档不要写过期日期；除非用户明确要求记录具体时间。

## 发版本流程

- 发版本时，先把 `CHANGELOG.md` 的 `Unreleased` 变更整理成新的版本记录，并保留空的 `Unreleased` 标题。
- 按当前版本号提升一个版本，更新根目录 `VERSION`。
- 将当前未提交的代码全部提交到 Git。
- 提交完成后，给当前提交打最新版本号对应的 tag，例如 `v0.0.5`。
- 发版本流程中不要执行编译、测试或构建，除非用户明确要求。

## PR 审查与处理

- 审查 PR 时必须把“需求价值”和“实现质量”分开判断，分别给出结论；实现差不等于需求不需要，需求有价值也不等于当前代码可以合并。
- 需求价值需要单独结合项目方向、用户场景、现有能力和后续规划判断；无法从项目上下文确定是否需要时，必须询问用户，不得仅凭代码质量、作者或改动规模推断需求不需要。
- 实现质量重点检查正确性、安全性、改动范围、重复代码、无关文件、现有结构复用、可维护性、测试与文档以及与最新 `main` 的冲突。改动几十个文件、疑似 AI 批量生成、重复代码多只能作为重点复核或拒绝当前实现的信号，不能单独作为放弃需求的依据。
- 对“需求有价值但实现不合格”的 PR，优先考虑要求作者修改、提取可用思路后自行重做，或把需求保留到 issue/todo；不要直接把需求一起否定。
- 建议关闭 PR 前，必须先向用户分别说明需求价值、实现质量、可保留的思路和建议处理方式，并取得用户明确确认；批量关闭时也要让用户能看清每个 PR 的需求是否仍需保留。
- 可以先在独立分支审查、修复、测试和准备提交；任何合并进 `main` 的操作都必须先说明修复内容、测试结果、风险与冲突，并取得用户明确同意。需要 force-push PR 作者分支时也必须提前说明影响并取得同意。

## 项目注意事项

- H3 参考库自动同步必须按节点内的 `segmentId + bindingId` 保存已提交快照，不能只按 `assetId` 去重；同一素材可在不同 Clip 中具有不同名称、职责、标签和主体。排查重复写入须覆盖这些字段差异及复制 Clip 后相同 binding ID 的情况；SQLite 时间统计使用与 `created_at` 一致的 ISO 时间参数，不能把无效的 `datetime('-60 seconds')` 查询结果当作零写入证据。

- Codex、Hermes 等外部 MCP 客户端默认必须连接常驻 Backend 的 `/mcp` Streamable HTTP 端点，禁止恢复成每个会话执行 `backend/dist/index.js mcp` 的 stdio 配置；stdio 入口只保留兼容用途。共享端点中的 `activeProjectId` 等客户端上下文必须按 MCP session 隔离，插件声明轮询只能由 Backend 统一维护一份。
- 画布媒体库必须独立于 ComfyUI 安装目录。设置 ComfyUI 路径只影响任务执行缓存，不得迁移或改写 `MEDIA_DIR`；输入按需复制到 ComfyUI，输出归档回 Backend 媒体库。迁出已有耦合目录时先备份数据库、复制并校验文件，再切换索引，保留原文件。
- 画布图片 WebP 缩略图只能作为浏览器本地、可丢弃的渲染缓存：不得写入节点数据、Backend 媒体记录、导出文件或模型参考图；下载、编辑、生成和导出必须始终解析原始 `storageKey`。
- 新增或调整产品的超时、重试次数、大小限制、并发上限等行为边界前，须说明适用环节、默认值和失败处理并取得确认；用户已明确指定的值无需重复确认。一次性诊断工具的等待或输出参数不属于产品边界，但不得借此修改产品配置或扩大操作范围。
- 画布项目、“我的素材”、生成记录和结构化用户配置统一以 Backend SQLite 为权威；媒体保存在 Backend 媒体目录，浏览器只允许保留可丢弃缓存、纯视图状态和连接引导信息。WebDAV 是可选同步副本，不要误写成账号云同步。
- AI API Key 随渠道配置保存在 Backend SQLite，前端读取后直接请求 OpenAI 兼容接口；涉及安全说明时要写清楚本地 Backend 数据目录同样需要妥善保护。
- Docker 静态资源路径目前仍是待办项，文档中不要过度承诺生产部署已经完全验证。
- Agent 对话消息必须同时按 `threadId`、`turnId` 和 `itemId` 归属；实时事件只用于补充未物化的 turn，历史快照成为权威后不得重复合并同一条消息。
- Agent 通信协议版本与消息存储版本必须独立管理；消息存储格式升级时必须先备份再迁移，遇到未知版本、损坏清单或冲突备份时拒绝覆盖原文件，不得按记录数量或文件大小静默裁剪历史元数据。
- 本地启动或浏览器验收时不要关闭用户已经打开的浏览器窗口或标签页；需要自动化验证时使用独立测试页面，避免打断用户当前页面和对话状态。
- 改了构建产物的源码就必须重建产物，否则修复不会生效：
  - 改 `plugins/canvas/*/src` 后，在该插件目录执行 `node build.mjs`，重新生成 `web/public/plugins/*.js`。
  - 改 `canvas-agent/src` 后，在 `canvas-agent` 目录执行 `node node_modules/typescript/bin/tsc -p tsconfig.json`，重新生成 `dist/`（backend 通过 `node_modules/@basketikun/canvas-agent` 软链加载的是 `dist`，不是源码）。
  - 这两类产物目录都在 `.gitignore` 中，不随提交分发，**只提交源码等于没改**。
  - 改 `backend/src` 或重建 `canvas-agent/dist` 后，先确认实际启动命令、watch/热加载状态及请求命中的进程；只有当前进程未加载变更时才重启相关 backend，不重复重启已自动更新的服务。
  - `web/dist` 是 vite build 的产物快照（构建时把 `public/` 拷走）：之后只重建插件只更新 `public/`，**不会更新 `web/dist`**——页面若加载 dist 里的插件就会一直跑旧代码。minimax-h3 的 `build.mjs` 已在构建后自动同步一份到 `web/dist/plugins/`；其他插件如遇同样问题，排查时先比对 `web/public/plugins/` 与 `web/dist/plugins/` 里同名文件的修改时间和大小。
- 排查「改了代码但问题依旧」时，先做两件事再往下查：比对源码与产物的修改时间确认产物已更新；确认请求实际命中的进程与端点，不要假定同名路由是同一个实现（例如插件的媒体上传走 `/agent/runtime/media`，由 canvas-agent 处理，与 backend 的 `/runtime/media` 是两套独立实现）。
- 画布能力分两类端点，**不要把 Canvas Agent 面板的连接状态当成 backend 可用性的前置条件**：视频拼接（`/agent/video-concat/tasks` + `/agent/runtime/tasks/:id`）这类能力由总后台提供，前端必须用 `resolveBackendAgentEndpoint()`（`{backendUrl}/agent` + `getBackendTokenShared()`）或 `resolveComfyEndpoint()` 解析端点，**禁止写 `if (!useAgentStore.getState().connected || !token) throw ...`**——`connected` 是 LLM 对话面板的 SSE 状态，用户不开面板时恒为 false，会把本来可用的能力挡下（曾导致「Canvas Agent 未连接，无法运行视频拼接」，以及刷新后任务永远停在「运行中」）。新增这类调用前先实测端点前缀：`/agent/*` **只**在带前缀时存在（`POST /video-concat/tasks` → 404，`POST /agent/video-concat/tasks` → 通），而 `/comfy/*` 与 `/agent/comfy/*` 都注册了、两条都通，不要互相套用。
- canvas-agent 的 MCP 工具新建节点（`generationFlowOps` / `canvas_create_node` 等）默认位置逻辑在 `src/canvas/tools.ts:nextCanvasX` 与 `nextCanvasAnchor`：有 reference 时必须贴在 firstReference 同行右侧（间距 96、y 与 reference 对齐），无 reference 时退回画布全局最右 + y=0。**禁止把"画布全局最右"作为生成流的有 reference 情况的默认值**，否则多次连续 MCP 调用会让同一组上下游散到几屏宽之外、连线横穿整张画布。
- 画布多窗口/多设备同步：持久编辑必须在动作入口捕获本次 before/after 的细粒度 ops，立即作为不可变命令独立落盘；网络发送阶段禁止再对整图快照求差分来推导用户意图。远端到达时按队列逐条检测冲突并重放到新基线，不能覆盖未确认操作。已发送但未确认的请求必须先以原 operationId、原基线和原操作取回执；确定性拒绝须保留草稿并停止自动重试。冲突记录须包含 conflictTargets 与 remoteProject；只有用户明确选择后，才以新 ID 在远端基线上重提，或丢弃本地意图。冲突选择必须先持久化替代/丢弃标记再清理旧记录，刷新不能复活已放弃的命令。
- 画布协作写入协议：浏览器、MCP、Agent 与后台任务的持久化修改必须统一走 `/canvas/projects/:id/ops`，每批操作携带稳定的 `operationId` 和 `source.clientId/kind/label`；Backend 先在 SQLite 中做幂等去重和 revision 事务，再广播同一份 delta。打开中的画布收到 Backend revision 后必须同步采用 Zustand 已合并的内存快照，不能再绕异步 Promise 导致被 UI version 防护丢弃。光标、选区、拖动预览等 presence 只能走 `/canvas/realtime` WebSocket 内存通道，禁止写入项目 JSON、SQLite 画布快照或增加 revision。
- 图片、视频和音频生成的结果占位节点必须由 Backend 在任务绑定事务中创建；网页、MCP、Agent 和浏览器模型都只提交源节点与生成参数，禁止调用方各自复制结果节点 ID、位置、槽位或连线逻辑。已有结果槽重试和明确的 `writeBackToTarget` 原位写回除外。
- 用户自定义模型脚本不得搬到 Node Backend 用 `new Function`/`vm` 执行，避免把浏览器脚本权限扩大到本机文件和进程。自定义脚本以及 Backend 尚不能无头执行的浏览器渠道都必须先创建权威 `canvas-browser-script` 任务并绑定节点，再由浏览器以窗口唯一 workerId 原子认领；浏览器只返回已归档媒体 key 或文本，最终终态与画布结果仍由 Backend 校验绑定后回写。Backend 重启后不得自动重跑已认领任务，避免重复调用和扣费；画布组件不得因此恢复模型直连和本地结果回填分支。
- 画布增量同步里的 `delete_node`、`delete_connections` 和 `delete_h3_segment` 必须保持幂等：目标已不存在时返回 `skipped`，不能用 400 表示竞态后的正常 no-op。其余确定性 400 对同一个不可变项目快照只能提交一次，必须熔断自动重试并记录脱敏的操作类型、目标 ID 和拒绝原因；禁止在 SSE/store 更新后无限重放同一请求。
- H3 任务状态与媒体产出由 Backend 独占：前端 `diffCanvasProject` 不得提交 H3 节点/片段的 `runtimeTaskId`、运行状态、进度、结果、结果历史等字段；页面本地旧快照只能提交提示词、参考图和布局等用户编辑字段，避免后台回写被覆盖。
- 用户说借鉴某段 Clip 的提示词写作方法时，只参考文字结构、逐镜动作、对白节奏和声景写法；除非用户明确要求复用其媒体，禁止把该 Clip 的视频或音频绑定为目标 Clip 输入，也禁止在目标提示词中引用对应的 `<Video N>` / `<Audio N>`。
- 复制标签页会继承 sessionStorage，不能把其中的草稿 owner 直接当作独占窗口身份。应用与测试入口必须先完成草稿会话认领，再导入读取 outbox 的 Store/编辑器；恢复其他会话前必须再次检查排他权限。未取得排他权限时保留记录、禁止自动重放，不靠时间长短推断原窗口已关闭。
- React StrictMode dev 模式会用 useEffect 双跑 / 模拟 unmount-remount，**useRef 形式的"首次跳过"防自动播放 / 自动副作用机制在 dev 模式下会被破坏**（第一次跑把 ref 置为 false，第二次跑 skip 已失效，加上 metadata 残留值就触发了）。需要"用户真正发起才触发"的副作用（自动播放、自动提交、自动跳转等），必须用 **useState 计数器 / 本地 trigger**（如 H3 的 `playToken`），由用户交互路径显式递增，effect 依赖本地 trigger 而非 metadata 字段。metadata 只用于持久化"上一次状态"，不能兼任 trigger 角色。
