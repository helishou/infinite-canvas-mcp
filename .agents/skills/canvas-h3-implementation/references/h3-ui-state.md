# H3 UI、状态与交互排障

## 按任务读取的工程约束

> 下列工程细节从技能入口移至此处。仅应用与当前任务有关的条款；路径 `references/`、`scripts/` 均相对于技能根目录。证据纪律、画布 MCP 留档、用户进程保护与当前明确要求优先。

## 布局现状（2026-09 三列版，用户按设计稿敲定）
- `minimax-wb-body`: 列 = preview(可拖宽 280~1400,默认960) | current-panel(中) | prompt-side Setting(可拖宽 220~900,默认480,跨3行)
- 行 = preview(可拖高 130~2000,默认220) | timeline(可拖高 250~2000,默认320；内部含 Refs 行 60~900,默认150) | library/Output(1fr 弹性保底80)
- 行常量口径唯一在 `H3WorkbenchPrimitives.tsx`：H3_BODY_CHROME=36 / H3_OUTPUT_MIN=80 / H3_PREVIEW_MIN=130 / H3_REF_MIN=60 / H3_TIMELINE_CHROME=190 / H3_NODE_MAX=4000；H3_PANE_BOUNDS、H3_PANE_DEFAULTS、h3SolveRows 同文件。H3Workbench.tsx 读侧用同样的数字自行 clamp（220/960/480/320/150 默认值），改 clamp 时要双侧同步。

## 「设为默认参数」= 生成参数 + 布局快照（2026-09，注意并行重构后的存储模型）

⚠️ 本功能开发期间仓库发生了并行重构（h3-defaults.ts 被改成内存缓存设计），最终形态以磁盘为准：**生成参数 = Backend 权威 + 页面内内存缓存**；**布局快照 = 独立 localStorage key**。不要按「localStorage 存生成参数」的旧思路改。

`H3ClipSettingsPanel` 的「设为默认参数」保存两样：
1. **生成参数**（exportH3Settings(selected).settings，H3_SETTINGS_KEYS，不含 prompt/duration）→ `ctx.h3Defaults.set` 写后端（PUT /plugins/minimax-h3/defaults，权威）
2. **布局快照** `{ width, height, panes }`（节点宽高 + minimaxPreviewH/PreviewW/PromptW/TimelineH/RefLaneH 五个模块区域宽高，`resolveH3PaneSizes(metadata)` 按 bounds 钳制后取值）→ `writeDefaultParams({...settings, layout})`：内存缓存 + **写独立 key `minimax-h3-default-layout`（LAYOUT_KEY）**，跨刷新/重启保留；layout **不进后端**（后端集合是生成参数，canvas-agent extractParams 按 H3_PARAM_KEYS 取值）

恢复路径（h3-defaults.ts）：
- `readDefaultParams()`：内存缓存优先（`cachedPayload`）→ 旧 localStorage key（Host 一次性迁移遗留）→ 剥掉 layout 返回。页面刷新后缓存空、依赖 Host 启动时用 `window.dispatchEvent(new CustomEvent("minimax-h3-defaults-updated", {detail}))` 把后端参数灌进缓存（模块顶层注册监听）。
- `readDefaultLayout()`：内存缓存里的 layout 优先 → 否则读 LAYOUT_KEY；panes 逐项过滤（只认 5 个合法键、有限正数），width/height 同理，全坏返回 {}。
- 新建节点**宽高**：`node-definition.ts` 挂 `defaultLayoutSize` getter → `web/src/lib/canvas/node-registry.ts` getNodeSpec 优先读它，缺省回退 defaultSize(1960×1080)。所有创建路径经 getNodeSpec。
- 新建节点**模块区域**：`defaultMetadata` getter 把 `layout.panes` 先铺进根 + 初始 segment（注意：真实 BASE_DEFAULT_METADATA.segments[0] 不含 minimax* 键，未存的 pane 不会被 BASE 覆盖）。

坑：
- `writeDefaultParams` 无 layout 时**不动 LAYOUT_KEY**（避免清掉旧布局快照）；clearDefaultParams 两处 key 都清。
- Node 24 自带原生 localStorage 全局，单测里 `globalThis.localStorage = stub` 赋值会被静默忽略（sloppy mode）→ 必须 `Object.defineProperty(globalThis, 'localStorage', {value: stub, configurable: true})`。单测模式：`npx tsc src/services/h3-defaults.ts --module commonjs --outDir $TMP` 后 CJS require + defineProperty 打桩 + require.cache 失效模拟页面刷新。
- agent 侧（canvas-agent 进程）无 localStorage + 无窗口事件 → 只吃后端生成参数，布局只有浏览器新建节点享受。设计预期。

## 关键陷阱：时间轴 50px/秒 刻度 + 滚动同步

### Ruler 横向滚动同步（必看）
Ruler（刻度尺+箭头 marker）位于 grid-row:1，Video/Refs 轨道位于 grid-row:2 的 `.minimax-tracks-scroll` 容器里。**滚动 tracks-scroll 时 ruler 默认不跟着动**，导致三角箭头和 Video/Refs 里的蓝色指针线错位。
- **解法**：在 ruler 内容层加一个 ref 引用的 wrapper div（`<div ref={rulerInnerRef} style={{ width: trackWidth }}>`），onScroll 时设 `rulerInnerRef.current.style.transform = 'translateX(-${scrollLeft}px)'`，让刻度/箭头反向平移与轨道对齐。
- **同步点有三处**：① `onScroll` handler ② 刷新恢复滚动位置（`useLayoutEffect` 读 `metadata.timelineScrollLeft`）③ 自动滚动到指定 clip（`scrollTimelineToSegment`）。漏掉任一处都会出现滚动后错位。
- **scrubber 点击位置计算必须读 transform 而非 scrollLeft**：ruler 通过 translateX 视觉平移而非真滚动，`rulerEl.scrollLeft` 恒为 0。点击时用正则解析 `rulerInner.style.transform?.match(/translateX\(([-\d.]+)px\)/)[1]` 取绝对值作为已滚动偏移，加上 `(clientX-rect.left)/scale` 才是内容坐标。
- 轨道内容按 50px/秒 铺且可横向滚动。叠加层（指针线、点击 seek）必须同像素刻度：`left = 52px + (playhead/total)*timelineWidth`；点击 = `(clientX - trackLeft + ruler.scrollLeft)/50`。
- **画布节点带 zoom transform（实测 ~0.282）**：`getBoundingClientRect()` 给的是屏幕 px，`offsetLeft/offsetTop/offsetWidth` 才是本地 CSS px。点击换算要 `(clientX-rect.left)/rect.width*offsetWidth`；定位建议优先 offset*，rect 量出来的值要再除以 scale。
- **点击 seek 会被视频回写拉回去**：`H3PreviewPlayer` 的 `onTimeUpdate` 每 250ms 用 `currentTime` 覆盖 `metadata.playhead`（>0.2s 才写）。scrub 时 metadata 设 `h3Scrubbing:true`，onTimeUpdate 开头 guard 跳过，pointerup/cancel 清 false。
- **禁止往 H3PreviewPlayer 加「playhead → media.currentTime」follow effect**：commit 后 effect 强制 seek 视频 → seeked 报回 timeupdate → 回写 playhead → 新 commit → 无限循环，React 直接抛 Maximum update depth exceeded 白屏。视频暂停时 seek 自会同步，guard 已够。
- **合成 PointerEvent 测试坑**：`setPointerCapture` 对 dispatch 的假 event（无活动指针）抛 NotFoundError，会把后面的 apply() 截断。防御：try/catch 包住 capture/release。
- 颜色用 `var(--h3-active,#3b82f6)`（项目蓝），指针不要写死白色。
- scrubber 的 top/left/width/height 用 offset*（本地 px）实测 ruler，ResizeObserver 跟踪。

## 拖动手柄节点自动增高（H3WorkbenchPrimitives.tsx）
- previewH / timelineH / refLaneH 三手柄拖过物理上限时节点跟着长高；拖回时节点必须缩回（单调映射）。公式：`nextH = nodeH + max(0, min(desired − capT0, 2000 − capT0))`，**每次 pointermove 都计算**，守卫用 `bodyH && nodeH`。只在 `desired > capT0` 才调用 updateNode 会导致只长不缩（曾因此修一轮）。
- previewH 手柄 `newP > maxP0`（预览顶到物理上限）时 newT 应取 `t0`（原时间轴高），不是 `minT` —— 否则时间轴被压到下限后预览还在涨，视觉上时间轴跳变。
- `drag.current` 在 pointerdown 时一次性捕获 `nodeH` 快照，整个拖拽中不变。连续拖拽时第一次已拉高 DOM 但快照仍是旧值，第二次会重复加高 —— 快速拖拽累积偏差，但单次短拖影响可接受，暂不处理。

## Output 卡片尺寸跳变（ResizeObserver + CSS 变量死循环）
`H3MaterialLibrary.tsx` 的 Output 卡片高度自适应：`ResizeObserver` 测量容器高度 → 算出 `cardH` → 设 `--h3-out-card-h` CSS 变量 → 容器 grid 用这个变量定高 → 容器高度变化又触发 ResizeObserver → 无限循环。

**根因**：测量的是 `listRef` 自身（grid 容器），而 `listRef` 高度由 `--h3-out-card-h` 决定，形成 `cardH → CSS → 容器高度 → RO → cardH` 的死循环。

**修复**：改测父容器（`.minimax-library`）的可用高度，断开循环链。再减去头部高度（~28px）避免卡片溢出。

```typescript
// 错：测 listRef 自身 → 死循环
ro.observe(el);  // el = listRef.current
// 对：测父容器
const parent = listRef.current?.parentElement;
ro.observe(parent);
```

## 插件内联工具函数陷阱（getCaretPoint）
`H3PromptSection.tsx` 里用了 `getCaretPoint()`（textarea 光标位置测量），但插件 **不能直接 import 宿主 web 的函数**（`web/src/components/canvas/canvas-resource-mention-textarea.tsx` 是宿主文件，不在插件目录里）。

**症状**：`ReferenceError: getCaretPoint is not defined at updateMentionPosition`。

**修复**：在插件内联一份 `getCaretPoint` 实现（含 `MIRROR_STYLE_PROPS` 常量）。插件是自包含的 —— 所有用到的工具函数要么从 `@infinite-canvas/plugin-sdk` 导入，要么在插件 src 内部定义。

## 运行/取消按钮状态耦合
H3 工作台的「生成当前 Clip」和「运行当前及后续」两个按钮都走 `requestH3Run()`，但**只有单段按钮有取消逻辑**时，多段运行无法中断。

**正确模式**：两个按钮的 `onClick` 都先检查 `busy` 状态，若正在运行则 emit `minimax-h3:cancel` 事件（`H3Runner.tsx` 的 `useH3RunEvents` 监听并调用 `ctx.ai.cancelLocalH3Task` / `cancelRunningHubH3Task`）。

```typescript
// 单段
<button onClick={() => {
    if (busy) { ctx.emit("minimax-h3:cancel", { nodeId: ctx.node.id }); return; }
    requestH3Run(ctx);
}}>生成当前 Clip</button>

// 多段（同样有取消能力）
<button onClick={() => {
    if (busy) { ctx.emit("minimax-h3:cancel", { nodeId: ctx.node.id }); return; }
    requestH3Run(ctx, true);
}}>运行当前及后续</button>
```

**按钮样式同步**：`busy` 时两个按钮都切换为 `minimax-reset`（红/警告色）+ 文案改为「取消生成」/「取消运行」+ 图标切换为 close。

**排查线索**：用户报「运行当前及后续没法取消」→ 检查多段按钮是否也走 `busy` 判断 + emit cancel 事件。

## useH3TaskPolling 恢复逻辑误把旧日志当新结果（2026-09 血泪教训，同月二次复发）
`useH3TaskPolling.ts` 的 `recoverTask()` 在 `runtimeTaskId` 为空时会查 generation logs 自救，找最近的成功日志回写结果。

**Bug（首次）**：没过滤时间，把**上一次成功运行的日志**当成了当前运行的结果。
- 表现：用户点"生成"后，节点直接显示"已完成"（ComfyUI 什么任务都没收到）
- 根因：第二次运行时 `runInFlightRef` 还在但 `runtimeTaskId` 还没写入，polling hook 挂载时查到上一次的成功日志
- 修复：用 `metadata.runStartedAt` 过滤日志，只考虑当前运行开始之后创建的（容忍 2 秒时钟偏差）

**Bug（二次复发）**：即使加了 `runStartedAt` 过滤，仍会误把旧日志当新结果。
- 根因：`requestH3Run`（H3WorkbenchPrimitives.tsx）设 `status: "queued"` 并清空 `runtimeTaskId`，但**没重置 `runStartedAt`**（残留上次旧值）。`useH3TaskPolling` effect 守卫含 `"queued"` → 立刻触发 → `recoverTask` 用旧 `runStartedAt` 过滤 → 上次成功日志通过过滤 → 直接回写成功
- 修复（双重保险）：
  1. effect 守卫从 `["loading", "queued"]` 改为只在 `"loading"` 时触发（`requestH3Run` 设 `queued` 后 `run()` 执行前是危险窗口，`runStartedAt` 是旧值）
  2. `requestH3Run` 必须重置 `runStartedAt: 0`，消除残留旧值

```typescript
// useH3TaskPolling.ts — 守卫
if (String(metadata.status) !== "loading") return;

// H3WorkbenchPrimitives.tsx — requestH3Run
ctx.updateMetadata({
    // ...
    status: "queued",
    runStartedAt: 0,  // ← 必须重置
});
```

**排查线索**：用户报「点生成直接显示已完成」「ComfyUI 那边没收到东西」→ 检查 effect 守卫是否含 `"queued"`，以及 `requestH3Run` 是否重置了 `runStartedAt`。

## React Hooks 顺序与 TDZ

**规则**：`useMemo` A 依赖 `useMemo` B 的结果时，B 必须在 A 之前声明。React 按顺序调用 hooks，A 求值时 B 还未初始化 → TDZ 报错 `Cannot access 'X' before initialization`。

**解法**：将依赖内联（如直接遍历 `connections` + 查 `nodeById`），或将两个 useMemo 合并为一个。

`bridge.ts` 的 `executeWorkflow()` 通过 WebSocket 监听 `executed` 事件作为主路径（消息直接携带 outputs，无需查 /history），但两个原因会导致结果回写失败：

1. **WebSocket 提前断开**：代理超时、负载高、防火墙等原因导致 WS 在 `executed` 之前就关闭。原代码直接 throw fail，但任务本身可能已完成，结果在 `/history` 或 `/output` 里。
2. **`/history` 是 LRU 队列**：默认保留 10000 条，任务一多旧记录就被清理。`/history/{prompt_id}` 返回空对象 `{}` 或 undefined，原代码计数器不递增或长期空转。

**修复模式**：
- WS 断开不再直接 fail，退回 `/history` 轮询
- `/history/{prompt_id}` 无记录或空对象时，第 20 次主动扫 `/history` 列表找最近成功条目兜底（不要求 WS 已关闭）
- `/history/{prompt_id}` 返回非 200 时同样递增计数器并兜底
- `watchRecovered`（重启恢复，无 WS 通道）也加同样的扫描兜底
- **空对象 `{}` 与 undefined 同等对待**：`/history/{prompt_id}` 返回 `{}` 时也要递增 missingHistoryCount，否则计数器不递增导致无限空转

**扫描 /history 列表兜底必须加 `startedAt` 过滤（2026-09 血泪教训）**：
扫 `/history` 列表找最近成功条目时，**必须过滤掉本次任务开始之前的旧条目**（`c.updated >= startedAt - 5000`）。否则会把**上一次成功的历史记录当成当前任务的结果**：
- 前端回写旧视频，本次实际生成的视频丢失
- 日志显示「扫描列表找到条目 prompt_id=xxx（目标 yyy）」但 xxx 和 yyy 不是同一个任务

四个扫描兜底分支（WS 断开 + history 无记录 + history 非 200 + watchRecovered）都**必须**加此过滤。

**ComfyUI `/history` 没有 `status.updated` 字段（2026-09 发现）**：
之前代码写的是 `entry?.status?.updated`，永远拿到 `undefined` → `Number(undefined ?? 0)` = **0**，导致排序无效、时间过滤永远 false。正确做法是从 `status.messages[i][1].timestamp` 取最大时间戳作为 `updated`：

```typescript
const msgs: Array<[string, Record<string, unknown>]> = Array.isArray(entry?.status?.messages)
    ? entry.status.messages as Array<[string, Record<string, unknown>]> : [];
const ts = msgs.reduce((max: number, [, data]) => {
    const t = Number((data as Record<string, unknown>)?.timestamp ?? 0);
    return t > max ? t : max;
}, 0);
```

**排查线索**：用户报「ComfyUI 跑完了但前端收不到结果」「任务状态一直 running 不结束」→ 检查 WS 是否提前断开、`/history` 是否被 LRU 清理。日志里「扫描列表找到条目 prompt_id=xxx（目标 yyy）」xxx ≠ yyy → 旧条目被误认为新结果。

## useState 与函数命名冲突（showFlash vs flash）
`H3ClipCard.tsx` 里 `const [flash, setFlash] = useState(...)` 与内部函数 `const flash = (kind, text) => {...}` 同名 — esbuild 报 `The symbol "flash" has already been declared`。

**规则**：useState 的 state 变量名避免与内部函数同名。把函数名改为 `showFlash`、`doFlash` 等。

## 智能分镜 / Output「设为当前 Clip」数据流陷阱
- RESTORABLE_PARAM_KEYS（h3-segment-utils.ts）**含 prompt**；H3_SETTINGS_KEYS 才排除 prompt+duration。buildRestoreParamsPatch 若用默认 keys（含 prompt），Output 面板「设为当前 Clip」(H3MaterialLibrary onRestore) 会把**源视频段的 prompt 灌进当前选中 clip**。恢复参数必须传 H3_SETTINGS_KEYS。
- **参数快照随 Output 走**：每条 Output 材料（H3Ref）应挂一份生成时刻的 `params: restorableParams(segment)`。buildRestoreParamsPatch 三级 fallback：① URL 反查源 Clip（参数最新）→ ② segmentId 反查（URL 变形/改写时兜底）→ ③ 材料自带 params（源 Clip 已被删除/重建时兜底）。生成材料时同步写 params，不要等用户点「设为当前 Clip」再回溯。
- `restorableParams` 已改成泛型函数 `<K extends string>(record, keys): Pick<H3Segment, K & keyof H3Segment>`，传入 keys 若含 H3Segment 不存在的字段会编译报错，防止静默类型破坏。
- 智能分镜成功后原代码 `selectedSegmentId: created[0]?.id` 会**强制跳选新第一段** → UI 上 Prompt 面板显示第一段提示词。应保持 `selected?.id`。
- SmartStoryboardFields「整体创意」Input.TextArea 曾直接双向绑定 node 级 `metadata.prompt`，用户在 modal 输入创意会**静默覆盖全局 prompt**，污染所有无独立 prompt 的段。应绑独立字段（smartStoryboardIdea）。
- 排查用户报「clip 提示词被换」时先 dump runtime.sqlite：`~/.infinite-canvas/runtime.sqlite` 表 canvas_projects(data_json 含 nodes[].metadata.segments 全量)、tasks(params_json)、generation_logs(每次 run 的 prompt/segment_id)。段 id 时间戳可还原操作时序。
- **⚠️ `generation_logs.segment_id` 是脏字段，不能拿它对段与提示词。** 实测：标着 `S03` 的记录里装的是 S04 的提示词，按 id 取回会直接串段。**对齐一律按 `prompt` 内容里的镜头目标行/标题做**（如「别这样」与摊开的票），不要信 `segment_id`。
- **被 apply 覆盖掉的旧提示词通常还能找回，别急着重写一版**（原文含逐字台词，是硬约束）。恢复顺序：① 按内容标题从 `generation_logs.prompt` 捞每段每次跑的原文；② 翻早前 MCP 调用的回显落盘（`%LOCALAPPDATA%/hermes/cache/spillover/*.txt`）与 temp 留档 JSON。

## 元数据错误状态持久化陷阱（刷新/重启后永久挂账）

**规则**：往节点 metadata 写 `status: "error"` 或 `xxxStatus: "error"` 时，必须同时设计**清除路径**，否则刷新/重启后 metadata 原样从 SQLite 加载，错误提示永远挂着、用户无法消除。

**修复模式**：在**打开相关 modal / 面板**时，如果检测到残留的 error 状态，自动清掉。用户主动点开 = 已知晓上次失败，给个干净界面。

```typescript
// SmartStoryboardModal.tsx — 打开时清除残留 error
useEffect(() => {
  if (open && String(metadata.smartStoryboardStatus || "") === "error") {
    ctx.updateMetadata({ smartStoryboardStatus: "", smartStoryboardError: "" });
  }
}, [open]);
```

**排查线索**：用户报「智能分镜失败后一直提示，刷新重启都还在」→ 检查是否有 `useEffect([open])` 清除路径。

## smart-storyboard 模型选择陷阱
`smart-storyboard.ts` 的 `generateSmartStoryboard()` 调用 `ctx.ai.generateText()` 做逐图视觉分析和分镜正文生成时，**必须传 `model` 参数**，否则回落到 `ctx.ai.defaultModel("text")`（系统全局默认 text 模型），忽略用户在 H3 工作台顶部选择的模型。

```typescript
const llmModel = String(
    ctx.node.metadata?.minimaxLlmModel ||
    ctx.node.metadata?.llmModel ||
    ctx.ai.defaultModel("text") ||
    ""
);
result = await ctx.ai.generateText(prompt, { references, system, model: llmModel });
```

**排查线索**：用户报「智能分镜调用的模型不是我选的」→ 检查 `generateText` 调用是否传了 `model`。

## h3.css 的多层 grid 规则
同一选择器在文件里出现多次，**后段覆盖前段**。改 grid 尺寸时 grep 全文件看有几处同名声明，一并改：`grep -nE "\.minimax-wb-body \{|\.minimax-canvas-workbench .minimax-wb-body" src/styles/h3.css`。会同时看到容器查询响应式（`@container`/media）覆盖桌面版，调整要按从上到下顺序记：谁最后定义谁生效。

## live-page 验证配方（实测快、必走）
src 改了、HMR 推了、用户看不到变化时，先用 `browser_exec` 接管用户已授权的 Chrome（操作流程见 `references/live-page-verification.md`），读 computed style / elementFromPoint / 合成 PointerEvent 在用户那台画布页面直接验证。**不再靠用户截图**。

## 工作流列表显示名 vs 内部名
`WorkflowStore.list()` 返回的 `name` 是文件名。前端显示时**去掉 `custom/` 前缀**（列表项 + 详情标题）；内部调用（PUT config、POST run）仍用原始 `name`（含 `custom/`）。

## 工作流重命名（双击标题）
- 仅自定义工作流（`builtin: false`）可改名，内置工作流禁用双击
- 双击 → 进入编辑模式（Input 替换标题）→ Enter 或失焦 → `PUT /api/workflows/:name/config` 写 `title` 字段（**不是**改文件名）
- 显示优先级：`config.title || name.replace(/^custom\//, "")`

## 渠道协议：openai-chat（/v1/chat/completions 直连）
`ApiCallFormat` 新增 `openai-chat` 类型，用于接只支持 `/v1/chat/completions` 的中转/本地模型（Ollama、部分代理），跳过 `/v1/responses` 直接调 Chat Completions。

| 协议 | 文本调用 | 图片生成 | 音频 | 视频 |
|------|---------|---------|------|------|
| `openai` | Responses API → fallback Chat Completions | `/images/generations` | `/audio/speech` | `/videos` |
| `openai-chat` | Chat Completions 直连 | `/images/generations` | ❌ | ❌ |
| `gemini` | Gemini API | ❌（走 generateContent） | ❌ | ❌ |

**前端下拉**：渠道编辑器协议三选一（OpenAI / OpenAI Chat / Gemini）。
**后端路由**：`requestImageQuestion()` 对 `openai-chat` 直接调 `requestChatCompletionsStreaming()`，不尝试 `requestStreamingResponse()`。
