# AGENTS.md

本文档用于约束本项目中的 AI / 自动化开发行为。开发时优先遵循本文件，其次遵循用户当前消息。

## 基本原则

- 先读现有代码，再动手修改，优先沿用项目已有结构和写法。
- 写代码保持最少行数，能简单实现就不要引入复杂抽象。
- 标准格式、协议、解析、压缩、加密、日期等通用能力优先使用成熟稳定的库，不要手写底层实现，除非用户明确要求或项目已有实现必须沿用。
- 不要为了“兼容更多场景”写大量分支，只实现当前明确需要的功能。
- 项目尚未上线，不需要兼容旧数据；本地存储结构调整时直接按新设计修改，不写旧字段兼容或数据迁移兜底，除非用户明确要求。
- 每次写完代码，不需要检查语法，不需要执行构建，用户会自己做。
- 不要改无关文件，不要顺手重构。
- 如果工作区已有用户改动，不要回滚，不要覆盖；只在必要范围内追加修改。

## 反复提醒沉淀

- 如果开发过程中总是遇到某个问题，或者用户反复提醒同一个注意事项，需要把该注意事项补充到本文件。
- 补充时写成明确、可执行的规则，避免只写模糊描述。
- 新规则应放到最相关的章节；找不到合适章节时放到“项目注意事项”。

## 前端规范

- 前端使用 Vite、React、React Router、TypeScript、Ant Design、Tailwind、Zustand。
- 编写 Ant Design 相关代码时，参考 https://ant.design/llms-full.txt 理解组件 API、示例和设计规范，并优先结合项目当前 antd 版本与既有写法。
- 外部服务请求统一放在 `web/src/services/api/`，由浏览器前端直连，不假设存在项目后端。
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
- 前端业务数据需要浏览器本地持久化时，默认使用 `localforage`；`localStorage` 只用于极小的简单配置，不要用来保存业务列表、生成记录、图片、base64 或大 JSON。

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
- 画布视口（平移/缩放）性能红线：**高频视口变化不得走 React state**。拖动与滚轮期间只能命令式写容器 `transform`（`writeViewport`），仅当**屏幕位移**超过 `VIEWPORT_CULL_SCREEN_MARGIN`(300px) 或缩放幅度超过 `VIEWPORT_CULL_ZOOM_RATIO`(0.35) 时才用 `startTransition` 补一次裁剪重算；松手 / 聚焦动画 / 缩放控件 / 小地图 / 重置视图这类低频入口必须走 `commitViewport`，保证命令式实时值与 React state 一致。禁止把平移改回逐帧 `setViewport`（实测 33fps → 回退即掉回 30 档），也禁止给 `applyViewportLive` 加节流/防抖（用户会直接感知为「不跟手」）。`web/src/lib/canvas/canvas-viewport.ts` 里的两条硬约束：①**补重算阈值与裁剪前瞻都必须按屏幕像素定义，绝不能按世界单位**——拖动的 x/y 是屏幕像素，按世界单位算会被放大 1/k 倍，缩小看全图时（k=0.05）退化成"平移 26px 就重算一次"，而每次重算都要重建全部可见节点的 element 树，直接把 5% 倍率平移压到 26fps；②**`VIEWPORT_RENDER_SCREEN_PADDING` 必须大于 `VIEWPORT_CULL_SCREEN_MARGIN`**（400 > 300，差值即补渲染提前量），改小会导致拖动时露出空白；裁剪外扩用 `viewportRenderPadding(k) = 400 / k` 随缩放反比放大，所以低倍率下会多渲染一圈节点，这是不反复重算的代价。新增任何改变视口的入口时，必须同时接上这两条路径，并跑 `probe.mjs`（平移 FPS）与 `verify.mjs`（缩放锚点漂移应为 0.0）；方法见 skill `canvas-perf-measure`。

## 文档规范

- README 保持简洁，只放项目介绍、核心功能、快速开始和文档入口。
- `docs/index.md` 放给 AI 使用的文档索引，不要再放到 `docs/content/docs/` 内容目录里。
- 详细功能介绍写到 `docs/content/docs/overview/features.mdx`。
- 后续待办写到 `docs/content/docs/progress/todo.mdx`。
- 已实现但还需要用户测试确认的事项写到 `docs/content/docs/progress/pending-test.mdx`。
- `docs/content/docs/progress/pending-test.mdx` 用来记录这个版本实际做了哪些可测试变更；`CHANGELOG.md` 的 `Unreleased` 只保留对这些变更的版本级归纳，避免逐条照搬实现细节。
- 每次重大改动（新增/调整/删除功能、接口或工具，影响用户可感知行为）完成后，都要在 `CHANGELOG.md` 的 `Unreleased` 追加一条记录，按 `[新增]` / `[调整]` / `[修复]` / `[优化]` 前缀分类，用一句中文归纳；纯内部重构、格式化、无用户可感知影响的小改动可不记。
- 每次 todo 事项完成后，先从 `docs/content/docs/progress/todo.mdx` 移到 `docs/content/docs/progress/pending-test.mdx`，不要直接写进正式功能说明；用户确认测试通过后再更新 `docs/content/docs/overview/features.mdx`。
- 每次任务完成前，都要根据实际变更检查并更新 `docs/content/docs/progress/todo.mdx` 和 `docs/content/docs/progress/pending-test.mdx`；如果功能或待办没有变化，也要确认无需修改。
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

- Codex、Hermes 等外部 MCP 客户端默认必须连接常驻 Backend 的 `/mcp` Streamable HTTP 端点，禁止恢复成每个会话执行 `backend/dist/index.js mcp` 的 stdio 配置；stdio 入口只保留兼容用途。共享端点中的 `activeProjectId` 等客户端上下文必须按 MCP session 隔离，插件声明轮询只能由 Backend 统一维护一份。
- 画布媒体库必须独立于 ComfyUI 安装目录。设置 ComfyUI 路径只影响任务执行缓存，不得迁移或改写 `MEDIA_DIR`；输入按需复制到 ComfyUI，输出归档回 Backend 媒体库。迁出已有耦合目录时先备份数据库、复制并校验文件，再切换索引，保留原文件。
- 画布图片 WebP 缩略图只能作为浏览器本地、可丢弃的渲染缓存：不得写入节点数据、Backend 媒体记录、导出文件或模型参考图；下载、编辑、生成和导出必须始终解析原始 `storageKey`。
- 新增或调整超时、重试次数、大小限制、并发上限等会改变实际行为的边界值前，必须先向用户说明适用环节、默认值和失败后的处理方式，并取得确认；不要把经验值当成纯内部实现静默加入。
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
  - `backend` 用 `tsx src/index.ts` 启动且未开启 watch，改 `backend/src` 或重建 `canvas-agent/dist` 后都要重启 backend 才生效。
  - `web/dist` 是 vite build 的产物快照（构建时把 `public/` 拷走）：之后只重建插件只更新 `public/`，**不会更新 `web/dist`**——页面若加载 dist 里的插件就会一直跑旧代码。minimax-h3 的 `build.mjs` 已在构建后自动同步一份到 `web/dist/plugins/`；其他插件如遇同样问题，排查时先比对 `web/public/plugins/` 与 `web/dist/plugins/` 里同名文件的修改时间和大小。
- 排查「改了代码但问题依旧」时，先做两件事再往下查：比对源码与产物的修改时间确认产物已更新；确认请求实际命中的进程与端点，不要假定同名路由是同一个实现（例如插件的媒体上传走 `/agent/runtime/media`，由 canvas-agent 处理，与 backend 的 `/runtime/media` 是两套独立实现）。
- 画布能力分两类端点，**不要把 Canvas Agent 面板的连接状态当成 backend 可用性的前置条件**：视频拼接（`/agent/video-concat/tasks` + `/agent/runtime/tasks/:id`）这类能力由总后台提供，前端必须用 `resolveBackendAgentEndpoint()`（`{backendUrl}/agent` + `getBackendTokenShared()`）或 `resolveComfyEndpoint()` 解析端点，**禁止写 `if (!useAgentStore.getState().connected || !token) throw ...`**——`connected` 是 LLM 对话面板的 SSE 状态，用户不开面板时恒为 false，会把本来可用的能力挡下（曾导致「Canvas Agent 未连接，无法运行视频拼接」，以及刷新后任务永远停在「运行中」）。新增这类调用前先实测端点前缀：`/agent/*` **只**在带前缀时存在（`POST /video-concat/tasks` → 404，`POST /agent/video-concat/tasks` → 通），而 `/comfy/*` 与 `/agent/comfy/*` 都注册了、两条都通，不要互相套用。
- canvas-agent 的 MCP 工具新建节点（`generationFlowOps` / `canvas_create_node` 等）默认位置逻辑在 `src/canvas/tools.ts:nextCanvasX` 与 `nextCanvasAnchor`：有 reference 时必须贴在 firstReference 同行右侧（间距 96、y 与 reference 对齐），无 reference 时退回画布全局最右 + y=0。**禁止把"画布全局最右"作为生成流的有 reference 情况的默认值**，否则多次连续 MCP 调用会让同一组上下游散到几屏宽之外、连线横穿整张画布。
- 画布多窗口/多设备同步：在 `web/src/stores/canvas/use-canvas-store.ts` 的 `applyBackendCanvasEvent` / `syncCanvasProjects` 两条路径上，**禁止在本地有未提交 ops 时用远端项目直接覆盖本地**（会吞掉用户的合法操作）。先算 `diffCanvasProject(syncBase, local)` 拿到 pendingOps，调 `detectCanvasConflicts` 看这些 ops 在远端是否仍然合法（add/update/connect 命中冲突、delete/disconnect/set_viewport 算 no-op），有冲突必须写入 `canvasConflicts`、弹窗让用户在「保留我的 / 采用远端」二选一，无冲突才推进 syncBase + 静默接受远端。409 分支必须保留提交前的 `syncBase` 直到冲突检测完成，禁止先把 remote 写入 `syncBases` 再计算 pendingOps；否则会变成 remote 与自身比较，并把本地旧 `segments` 静默重提覆盖 MCP 写入。`canvasConflicts` 记录必须含 `conflictTargets`（具体冲突点供弹窗展示）和 `remoteProject`（供「采用远端」按钮直接覆盖）。
- 画布增量同步里的 `delete_node`、`delete_connections` 和 `delete_h3_segment` 必须保持幂等：目标已不存在时返回 `skipped`，不能用 400 表示竞态后的正常 no-op。其余确定性 400 对同一个不可变项目快照只能提交一次，必须熔断自动重试并记录脱敏的操作类型、目标 ID 和拒绝原因；禁止在 SSE/store 更新后无限重放同一请求。
- H3 任务状态与媒体产出由 Backend 独占：前端 `diffCanvasProject` 不得提交 H3 节点/片段的 `runtimeTaskId`、运行状态、进度、结果、结果历史等字段；页面本地旧快照只能提交提示词、参考图和布局等用户编辑字段，避免后台回写被覆盖。
- React StrictMode dev 模式会用 useEffect 双跑 / 模拟 unmount-remount，**useRef 形式的"首次跳过"防自动播放 / 自动副作用机制在 dev 模式下会被破坏**（第一次跑把 ref 置为 false，第二次跑 skip 已失效，加上 metadata 残留值就触发了）。需要"用户真正发起才触发"的副作用（自动播放、自动提交、自动跳转等），必须用 **useState 计数器 / 本地 trigger**（如 H3 的 `playToken`），由用户交互路径显式递增，effect 依赖本地 trigger 而非 metadata 字段。metadata 只用于持久化"上一次状态"，不能兼任 trigger 角色。
