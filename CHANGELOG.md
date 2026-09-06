# CHANGELOG

## Unreleased

- [新增] 工作流节点图支持将文本字段标记为「提示词」：字段配置中勾选「作为提示词」后，运行工作流时该字段值会被收集并透传为任务与生成日志的 prompt（未标记时仍回退使用工作流标题）。
- [新增] 工作流列表支持双击名称重命名：双击列表项标题进入编辑态，回车或失焦保存显示标题（仅改 config.title，底层文件名不变）；新增后端 `PUT /api/workflows/:name/title`。
- [新增] 工作流节点图自动识别 ComfyUI 节点的 COMBO/下拉输入：通过 `/object_info` 拉取原始选项列表，勾选该输入时自动创建下拉字段并预填充选项；新增后端 `GET /api/workflows/:name/combo-options`。
- [修复] COMBO 选项检测兼容 ComfyUI 新版 object_info 格式（`"COMBO"` 字符串类型 + `options` 数组，如 `ResolutionSelector.aspect_ratio`），旧版「选项数组直接作为第一元素」格式（如 `KSampler.sampler_name`）仍兼容；之前新格式的下拉框会被漏判成普通文本。
- [修复] 生图工作台调用自定义 ComfyUI 工作流时，用户输入的提示词现在会替换勾选「作为提示词」的文本节点值注入 workflow，而不只是记录到日志。
- [修复] 自定义工作流下拉框（COMBO）传值导致 ComfyUI 报 `value_not_in_list` 的 500：①前端初始化下拉字段初值时对齐到合法选项，不再沿用节点原始输入里可能非法的数字（如 `aspect_ratio: 16`）；②后端 `buildParams` 的 dropdown 分支去掉数字强制转换（之前会把 `"16"` 变成数字 `16`），改为非合法选项时回退首个选项，确保传给 ComfyUI 的一定是字符串且命中 options。
- [调整] H3 设置面板「生成模式」不再做成可折叠分区：去掉标题栏和展开交互，改为设置面板顶部常驻一行四个模式按钮（文生视频 / 图生视频 / 首尾帧 / 多参考 Ref2VA），点按即切换，各模式配色与选中态样式保留；按钮文字在面板较窄时省略号截断兜底。
- [修复] H3/Comfy 生成在 backend 重启时被误判为「Failed to fetch」而整个作废：backend dev 模式是 `tsx --watch`，源码变更会自动重启 backend（几秒），浏览器轮询循环一次 fetch 失败就放弃，但 ComfyUI 任务其实已提交且在继续跑。双端修复：①前端所有任务轮询循环（本地 H3/Comfy/RunningHub/视频拼接）对网络层瞬时失败自动重试（最多 15 次、间隔递增；HTTP 4xx/5xx 仍立即抛出）；②backend 新增懒恢复——GET `/comfy/tasks/:id` 发现遗留 running/queued 任务时，用 task_events 里 submitted 事件记录的 promptId 重新挂 /history 观察循环，任务真正跑完后照常回写结果与媒体。已实测：一次被误判失败的视频经恢复链路成功取回（NanFeng_H3_00061-audio.mp4，任务回写 succeeded）。
- [修复] 改图/生图工作台的 LLM 提示词生成（OpenAI 协议）对只支持 Chat Completions 的兼容服务（Ollama 等）调不通：原本先打新版 Responses API `/v1/responses`，仅在「网络/CORS 错误」时才回退到 `/chat/completions`；而 Ollama 返回 HTTP 400（非网络错误）导致不回退、直接报错。现把回退触发条件扩展为「网络/CORS 错误 **或** `/responses` 返回 4xx/5xx（401/403 鉴权错误除外）」，这类服务会自动降级到普遍支持的 `/chat/completions` 端点。同时在两个端点都失败时抛出带诊断信息的错误（含所用模型名与试过的路径，命中 404 时提示模型名在 Ollama 中不存在、请用 `ollama list` 核对）。
- [修复] 本地 Ollama 做改图/提示词生成的文本模型时首次请求极慢（冷启动 20~30s 重新加载模型到显存）导致像「卡死/失败」：在 `/responses` 与 `/chat/completions` 两个请求体追加 Ollama 扩展参数 `keep_alive: 300`，首次加载后模型常驻显存 5 分钟，后续请求秒回；OpenAI 官方会忽略该字段不影响。
- [修复] 改图/生图工作台的 LLM 提示词生成（OpenAI/Ollama 协议）发送带参考图的请求时，图片地址是相对路径（如 `/media/image:xxx?token=yyy`），Ollama 服务端取不到该相对地址而报 `invalid image input` / 400。现 `requestImageQuestion` 在发请求前把相对图片 URL 在浏览器侧同源拉取并转成 base64 data URL（绝对 URL / data: / blob: 则原样保留），Ollama 与 OpenAI 均能正确接收图片。实测：用 16x16 真实 PNG 转 base64 后 Ollama 正确识别内容。
- [修复] 播放指针跳转条（ruler-scrubber）横穿设置面板伸出节点外：其宽度误取刻度尺的完整轨道内容宽度（可滚动总宽，可达数千 px），且 left 少加了时间轴面板自身偏移——一条 36px 高的隐形条从时间轴一直压到设置面板上抢指针事件。现宽度钳制为时间轴可见宽度（clientWidth − 左标签 36 − 右槽 54）、left 补上时间轴偏移，并监听时间轴尺寸变化（拖 Settings 宽度手柄时跟随重算）。
- [修复] preview↔VideoRefs 分界拖拽线过长：之前横线宽度取到时间轴右边缘（列1+列2 全宽），会穿过 preview 右侧的空区一直伸到设置面板跟前；现在只与 preview 等宽（线上方实际只有 preview）。
- [优化] H3 模块拖拽手柄的悬停高亮改为居中 3px 细线：此前 7px 命中条悬停时整条高亮，竖向手柄（如设置面板宽度手柄）约一半宽度压在面板边缘里侧，看起来像一根粗线侵入设置区域。现命中区保持 7px 不变（好抓），可见高亮只画贴在边界上的居中细线（横竖向手柄各用对应方向的渐变实现）。
- [修复] 智能分镜完成后状态栏仍显示红色「失败：参考图分析完成，正在生成智能分镜…」：smart-storyboard 把进度消息误写进 `errorDetails`（生成任务的错误字段，状态栏会加「失败：」前缀展示），节点带着旧的 error 状态时红标就显示进度文案、与绿色「智能分镜已完成」并存。现进度消息改写智能分镜自己的 `smartStoryboardError` 字段，不再碰 `errorDetails`；旧节点残留的污染文案在下一次生成运行时会被正常错误流程覆盖。
- [调整] H3 节点在画布上纵向缩放时改为全模块等比缩放：此前行1(预览)/行2(时间轴)是固定 px、只有行3(Output) 吃余量，拉节点只有 Output 变。现在节点高度变化时以上一次实际视觉行高为基准等比缩放预览/时间轴（Refs 行随时间轴同比、Output 作为余量自然同比），各下限钳制（预览 130 / 时间轴 max(250,190+Refs) / Refs 60 / Output 80），装不下时回落 h3SolveRows 连续收敛；行高拖拽进行中只更新基线不回写，避免与拖动写入互相覆盖；结果写回 metadata 保持「存的值=看到的值」。
- [调整] H3 行高拖拽逻辑按方案 B 重构，严格落地两条定案规则（拖 Output↔VideoRefs 线=preview 不变、Output 与 VideoRefs 变；拖 VideoRefs↔preview 线=Output 不变、只调 VideoRefs 与 preview）：①行高布局常量（body chrome 36 / Output 保底 80 / 预览下限 130 / Refs 下限 60 / 时间轴 chrome 190）收拢为导出常量，拖拽侧与读取侧共用一套口径，消灭散在三处的互相矛盾；②新增共享求解函数 h3SolveRows（预览先让→时间轴再让的连续收敛），读取侧预算与手柄回写共用；③拖动快照不再钳制 900（曾导致超 900 的节点一抓手就跳回）快照直接取 metadata 真值；④手柄按下时先「解除挤压」——节点被画布压小过就把节点长回内容需求高度（Output 恢复 80 保底），拖动从 1:1 跟手状态开始，消除死区；⑤新增挤压归位回写：非拖动状态下检测到视觉行高 ≠ metadata 时把收敛值写回 metadata，保证「存的值=看到的值」；⑥节点自动长高上限 2000→4000，不再在极端拖动时卡住导致 Output 跌破保底。
- [修复] 删除 Output 隐藏容器查询后 Output 区域被高度预算挤到 0 高度、彻底不可见：预算收敛改为先给 Output 预留 80px 保底（可用高度 = bodyH − 36 − 80），预览/时间轴只能在剩余空间里分配——预览先让到 130、时间轴让到 max(250, 190+Refs) 下限，保证 Output 永远可见、上边缘手柄永远可抓。
- [修复] 拖预览下边缘时 VideoRefs 区域猛的回弹（用户定位为 Output 区域隐藏触发）：①h3.css 里 wb-body ≤428px 时 Output `display:none` 的容器查询与拖动行高模型冲突——节点高度跨界瞬间 Output 硬切显隐、行结构重排跳变，已删除（Output 行 minmax(0,1fr) 本就会随空间平滑压到 0，预算系统接管后该查询多余）；②H3Workbench 高度预算收敛公式不连续——挤压态 effTimelineH=avail−effPreview 会算出比 metadata 值还大的时间轴高（受 250 下限与 42% 系数来回掰），脱离挤压态又跳回 metadata 值，改为单调连续分配（预览先让到 130 → 时间轴再让到 max(250, 190+Refs) 下限），边界处恰等于 metadata 值、无跳变。连同上一条 minT 回填修复，预览分界线全程拖动平滑。
- [修复] 拖预览下边缘把时间轴压到最矮后继续下拉（节点自动长高阶段）时 VideoRefs 区域猛的回弹：预览分支在预览超过物理上限后把时间轴误回填为拖动起点的完整高度（快照 t0），改为保持下限 minT（190+Refs行高），与「预览吃增量、时间轴/Output 高度不变」的定案规则一致。
- [修复] Video 行高度拉不大的限制：Video 行 = 时间轴高 − controls/刻度尺 − Refs 行高，此前 Refs/Video 分界线往下拉到 Refs 60px 下限就停，Video 行被钉死在「时间轴高 − 132px」。现该手柄越过 Refs 下限后继续下拉会自动增高时间轴面板（Video 行持续变大、Output 让位），上限改为物理约束（Output 至少留 ~80px：bodyH−116−预览，绝对顶 2000），不再有 900 硬顶；时间轴顶到节点物理上限后继续下拉会**自动增高 H3 节点本身**（updateNode 调节点高度，Output 高度保持不变，反向拖回时节点跟着缩回），Video 行不再受初始节点高度限制；同时 Refs 行高上限从写死 420 改为随时间轴高度（timelineH − 190），时间轴拉大后 Refs 也能拉更大，读取侧与拖动侧口径一致。
- [调整] H3 行高手柄交互定为：①Output 上边缘手柄——预览高度不变，只调时间轴（行2），Output 吃/补余量；②预览下边缘手柄——Output 高度不变，预览与时间轴此消彼长（预览增多少时间轴让多少，受时间轴下限 190+refLaneH 约束）；时间轴压到下限后继续下拉会自动增高 H3 节点本身（预览吃增量、时间轴/Output 高度不变，反向拖回时节点缩回）；③Refs/Video 分界线越过 Refs 60px 下限后继续下拉会增高时间轴（Video 行变大、Output 让位）保持不变。
- [优化] 智能分镜弹窗整体 UI 缩小：Modal 宽度 620 → 460，字段容器 fontSize 13 / gap 8，所有 label/span 字号 12，Select/Switch/Input 全部 size="small"，参考图片缩略图 172×172 → 84×84、字体 22/25 → 10/18，「从画布选择」按钮 padding 6×16 → 2×10、字号 12，整体创意 TextArea rows 5 → 3。
- [优化] 智能分镜弹窗 UI 第二轮缩小：底部说明 fontSize 12 → 11、marginTop 16 → 10、lineHeight 1.6 → 1.5；参考图片缩略图 84×84 → 64×64、borderRadius 4 → 3；缩略图间距 gap 6 → 4、paddingBottom 4 → 2；加号图标 18 → 14；角标 / 关闭按钮全部缩小（width 14 → 12、fontSize 10 → 9）。
- [修复] ruler 容器高度 28px 不够，22px 字号刻度文字溢出底部被 Video 行遮挡：ruler 高度提到 36px，22px 刻度文字完整显示。
- [修复] ruler 容器宽度 > 总时长（如 20s 总时长容器 22s 宽）时，超过总时长部分没刻度：自适应——5s 间隔能塞下时用 5s，否则用 1.6s 继续铺到容器右边缘，ruler 容器 0s 到右边缘都有连续刻度。
- [优化] ruler 刻度统一为 5s 一格：之前 0-总时长用 1.6s 主刻度+0.4s 副刻度，超过总时长用 5s，前后不一致。现在 0s 到 ruler 容器右边缘全程 5s 一格主刻度。
- [优化] 「连续播放全部 Clip」按钮从时间轴左侧独立列挪到 ruler 行内左对齐，刻度和播放按钮同一行（之前分隔在两个 grid 列里）。ruler-row 内部用 flex 布局，左侧 36px 给播放按钮，右侧 ruler-ticks 容器放刻度；CSS 同步移除 timeline-controls 相关规则并调整 grid-template-columns。
- [修复] H3 节点 Clip 卡片现在能显示错误/loading/cancelled 视觉：H3Runner catch 块把 `segment.status` + `segment.errorDetails` 同步写进 segments 数组，H3ClipCard 读取后加 `is-error` / `is-loading` / `is-cancelled` className + 红底感叹号角标 + hover title 显示 errorDetails。之前 catch 块只把 status 写到 metadata 节点级、segments 数组里没 status，H3ClipCard 完全不读这个字段，导致用户感知为「Clip 卡片不更新」。
- [修复] ComfyUI WebSocket 早断后 backend 拿不到 outputs：bridge.ts 加 `socket.onerror` / `socket.onclose` handler、补 `execution_success` 事件监听（之前只听 `executed` 单节点事件），`wsExecuted=true` 但 `/history` 被清理时扫描整个 `/history` 列表找最近成功条目兜底，WS 早断时主动 fail 而不是傻等 3 分钟。
- [修复] 时间轴行高联动约束，根治行与行挤压重叠：时间轴面板高度（timelineH）此前可低至 140px，而面板内部固定需求 = controls 44 + 刻度尺 28 + Video 行 + Refs 行高（60–420），不足时 Video 行被压扁、Refs 挤成一团、刻度被裁切。现 timelineH 下限联动 refLaneH（min = 190 + refLaneH，默认 320），Refs 手柄上限同步受 timelineH 约束（max = timelineH − 190），拖动时与读取时双向钳制，历史 metadata 里的过小值自动抬升；CSS fallback 252→320、min-height 112→322。另加节点级高度预算：ResizeObserver 实测 wb-body 可用高度，行1+行2 固定 px 超预算时按「预览先让→Refs 跟让→时间轴保内部最小结构」收敛（预览下限 130、Refs 下限 60、时间轴下限 250），Output 行改为 minmax(0,1fr) 彻底让位——节点在画布上被压矮时行与行不再互相挤压裁切。
- [优化] Output 卡片随面板高度自适应放大：卡片高度此前固定 78px，拉高 Output 区域只剩更多空白。后按用户要求改为固定单行横向滚动：卡片高度实测面板可用高度自适应（clamp 78–380px，经 CSS 变量 `--h3-out-card-h` 下发），宽度=高度×2 保持 2:1，列表 grid-auto-flow:column 超出横向滚动；时间轴/Output 手柄拖动时卡片即时跟随。
- [修复] LoRA 多槽位还原与回显：①LoRA 下拉选项合并当前槽位已存的名称——catalog 在 backend 只保留 minimax/ 目录的 LoRA，自定义路径（hmmotion、MysticXXX 等）不在选项里，还原/导入后值无法回显（数据显示「4 个已启用」但下拉显示占位符）；②backend bridge 支持 loraSlots 多槽位链式注入（slot0 走 LoraLoader 带 clip、slot1+ 走 LoraLoaderModelOnly 串联），此前只注入 slot0（loraName），其余槽位被静默丢弃；无槽位时回退旧 loraName 路径。backend 需重启生效。
- [修复] Output 视频/图片双击放大预览的灯箱改用 Portal 渲染到 document.body：此前灯箱渲染在画布节点 DOM 内部，被画布 transform 缩放（viewport.k）整体缩小，画布缩得越小灯箱越小；Portal 逃出变换容器后恢复全屏 92vw/86vh 尺寸（antd Modal 的智能分镜弹窗不受影响，因其自带 body portal）。
- [修复] 恢复 Setting 采样设置里丢失的「TE 加速」开关：改版时该开关从 UI 消失，导致 TE-Speed 只能靠旧 metadata 残留值生效、新 Clip 无法开启。现按 Clip 粒度 patch `teAccel`（backend 在其为 true 时注入 TESpeedMiniMaxH3 节点），并随参数导出/导入/还原/设为默认联动。
- [修复] Output「设为当前 Clip」现在能还原参数：此前还原只靠 URL 反查时间轴上的源 Clip，源 Clip 被删除/重建/改写后反查失败，返回空补丁导致只切换预览、参数原封不动。现在①反查失败时按 segmentId 兜底；②生成落盘时（Runner 写回 / 轮询回写 / 自动分段产物）给每条 Output 材料挂一份生成时刻的参数快照，源 Clip 已不存在时用快照还原（提示词+全部可还原参数）。补齐参数表缺失的 21 个键：loraName/loraStrength、teAccel、noDub/noCaption、audioMode/audioDenoiseStrength、addSourceAsReference/promptPrimaryAudioOrdinal/strictPromptTags/referenceVideoPolicy、trimIn/trimOut、motionContext* 六项、combatLoraWeight/cinematicLoraWeight——导出/导入参数与「设为当前 Clip」共用此表，此前全部不还原。历史旧 Output 没有快照、源 Clip 也不在时间轴上时仍无法还原。
- [新增] H3 工作台每个模块都支持拖边动态调宽高：预览（下边缘调高/右边缘调宽）、Setting 右栏（左边缘调宽）、时间轴/Output（Output 上边缘：上拉 Output 增高、下拉时间轴增高）、时间轴 Refs 行（行上边缘上拉增高）。手柄位置改为 ResizeObserver 实测各模块真实边界后写入，不再用工具栏高度常量 + calc 变量链绝对定位（旧常量 58px 与工具栏实际高度不一致导致手柄漂移）；行高模型改为 行1/行2 固定 px + 行3(Output) 吃余量，并新增 `minimaxTimelineH`、启用 Refs 行高 `minimaxRefLaneH`（默认 150px），删除注入了但无消费者的 `minimaxClipPanelH`/`--minimax-clip-h` 与 `minimaxVideoTrackH`/`--minimax-video-h`。
- [修复] 节点下方面板（参考内容/提示词编辑器）不再误触发节点拖拽：面板渲染在节点容器内部，节点根元素 capture 阶段的拖拽判定先于面板自身的 stopPropagation 执行，导致点击面板里的缩略图、标题、留白等非控件区域会拖动节点。现在面板容器带 `data-canvas-node-panel` 标记，capture 拖拽判定跳过面板区域，交互完整留给面板。
- [修复] 图片节点主图（含单图节点）现在显示「下载」和「创建副本」工具栏：之前只有批量展开后的非主图卡片才显示「创建副本/设为主图」，主图卡片和单图节点只有「下载」。设为主图仅在非主图卡片上有意义，因此主图/单图节点仍不显示该项。
- [修复] ComfyUI WebSocket 早断后 backend 拿不到 outputs：bridge.ts 加 `socket.onerror` / `socket.onclose` handler、补 `execution_success` 事件监听（之前只听 `executed` 单节点事件），`wsExecuted=true` 但 `/history` 被清理时扫描整个 `/history` 列表找最近成功条目兜底，WS 早断时主动 fail 而不是傻等 3 分钟。
- [修复] H3 时间轴不再被总时长锁死：track-body / track-content / ref-content 改为 `min-width: total*50, width: 100%`，ref grid 也从百分比定位改为 px 定位，总时长 9s 时右边不再留出大段黑色空白，时间轴跟随父容器宽度拉满。
- [修复] H3 时间轴 ruler 刻度按容器实际宽度动态生成：0-总时长 1.6s 主刻度 + 0.4s 副刻度，超过总时长部分按 5s 间隔继续标记，右侧空白处也有时间刻度参考。
- [修复] H3 视频行底部那条波形装饰条由 CSS `::after`（`left:0; right:0`）改为 JSX 内联 `<div>`，只占 `total*50px` 宽，时间轴拉满后不再误铺到 refs 行视觉位置。
- [修复] H3RulerScrubber 找不到 `.minimax-ruler`（H3Timeline 的 ruler 行 class 改名为 `.minimax-ruler-row`），scrubber `origin` 永远为 null 退回到 fallback 位置；改为匹配 `.minimax-ruler-row` 后 scrubber 才能正确贴合 ruler 几何。
- [修复] 智能分镜与 H3 生成按钮状态耦合：智能分镜运行时不再覆写节点 `status` 字段（只写 `smartStoryboardStatus`），H3ClipSettingsPanel 的「生成当前 Clip」按钮 `busy` 改用 `runtimeTaskId` 存在性判断；之前智能分镜会同时让"生成当前 Clip"按钮变"取消生成"且点了也取消不了（因为它没 runtimeTaskId，H3Runner cancel 路径找不到任务），下方状态徽章也会错显"生成中…"。
- [修复] H3 节点卡在"生成中"无法回写：onTaskId 回调现在把后端 taskId 同步写进 generation log（`runtimeTaskId`），`useH3TaskPolling.recoverTask` 在 metadata 丢失 taskId 时仍能通过 log 找回；卡死的孤儿日志（无 taskId 且 `startedAt` 超过 90 秒）会被自动清空状态让用户能重新提交；H3Runner 的 catch 块同时清掉 segments 里的 `runtimeTaskId`，避免错误状态被 segments 继承继续轮询不存在的 task。
- [修复] 新建 H3 Clip 现在从当前选中 Clip 继承完整生成参数（包括完整 Sigma 序列），并插入在当前 Clip 后方。
- [修复] H3 Clip 参数编辑改为基于最新节点数据保存，避免连续输入完整 Sigma 序列后切换 Clip 被旧状态覆盖。
- [优化] H3 生成日志现在记录每个已提交 Clip 的完整参数与实际输入素材，包含完整 Sigma 序列等高级设置。
- [调整] H3 新建节点和运行时缺省降噪强度统一为 1.0，与南风 V10 默认值一致。
- [优化] H3 采样器选择支持直接输入搜索，并补充 `er_sde` 选项。
- [新增] H3 智能分镜参考图片支持打开画布素材选择器并按槽位写入图片。
- [修复] 智能分镜生成结果改为插入当前 Clip 后方，不再固定追加到时间轴末尾。
- [调整] H3 节点隐藏画布宿主自带的底部通用生成面板，避免与 H3 工作台重复显示。
- [修复] H3 时间轴播放指针改为绑定可滚动轨道内容，横向滚动标尺、Video 或 Refs 时指针同步跟随。
- [修复] 画布状态改为每次变更立即写入浏览器本地快照，避免后台进程被终止或页面关闭时丢失最近 400ms 内的画布数据。
- [修复] 本地 ComfyUI 图片生成现在持久化后台任务 ID，页面刷新后可继续轮询并把完成图片回传到画布节点。
- [修复] H3 节点刷新时从后台生成日志恢复进行中的任务，避免被误判为中断失败。
- [修复] H3 日志 `输入 refs` 改为优先取选中 Clip 的实际 refs（与提交给 ComfyUI 的 `finalReferences` 一致），仅在 Clip refs 为空时回退到画布连线的 upstream，避免日志显示多余的全局参考。
- [修复] H3 任务在 catch 分支会忽略 `cancelRequested`，把被取消的任务也记成 `failed`；现在按用户实际意图写入 `cancelled` 状态。
- [修复] H3 轮询拿到后端 `cancelled` 状态时也会被抛成"MiniMax H3 任务失败"，现在改抛 `H3RunCancelled` 识别错误，H3Runner 走 cancelled 分支。
- [修复] 智能分镜 modal 未上传图时 fallback 不再把上游 video/audio 一起带过去，submit 文案同步说明只取图片。
- [修复] 智能分镜生成的新段不再自动继承选中段的 video/audio refs（之前会把上一段生成的视频当 ref 渗到新段，并通过 ComfyUI 输出又回流到 output 列表）。
- [修复] `appendVideoMaterials` dedupe 时丢失 `segmentId` 字段，现在保留归属信息；output 面板按 segment 筛选时不再把别段视频算成"自己的"。
- [优化] 智能分镜失败时把错误信息按阶段分类（参数校验 / 模式校验 / 参考图加载 / 逐图视觉分析 / 分镜提示词生成 / 分镜解析 / AI 配置），便于定位"智能分镜生成失败"的真实根因。
- [优化] 智能分镜逐图视觉分析的参考图 fetch 显式声明 `mode: "cors"`，错误信息附带候选 URL 的 host，便于定位跨域 / CORS 失败的真实源。
- [优化] 智能分镜在 `ctx.ai.generateText` 失败时把 `error.name` / dataURL 字节数 / `ctx.ai.defaultModel("text")` 一并写入 `errorDetails`，并 `console.error` 完整栈，方便定位是 baseUrl CORS、模型不支持 vision 还是 API 配额/超时。
- [修复] text 走 OpenAI Responses API（`/responses`）时如果中转没实现或浏览器 CORS 拒绝（`Failed to fetch`），自动 fallback 到 Chat Completions（`/chat/completions`），覆盖更多第三方中转场景。

- [优化] 图片节点上传改为先显示本地临时预览，后台上传完成后再回填正式存储地址，减少选择图片后的等待感。

- [修复] 修复 H3 与画布侧边栏运行时警告：补齐动态子节点的唯一 key，并修正侧边栏设置恢复时的状态更新调用。

- [优化] H3 Prompt 的 @ 候选列表跟随光标定位，并使用项目蓝色明显区分当前选中项。

+ [调整] H3 工作台改为左侧视频预览、中部 Prompt、右侧 Setting，下方横向展示 Refs、Output 和 Status。
+ [调整] H3 工作台支持拖拽调节 Video Preview、Prompt 和 Setting 的横向宽度。
+ [修复] H3 时间轴点击 Clip 后，播放指针按实际时间轴轨道定位到片段起点。
+ [调整] H3 生成操作按钮固定在右下角，并增强按钮视觉层级。
+ [优化] H3 三栏布局限制预览区最大占比并为 Prompt 保留最小宽度，避免 Prompt 被挤压。
+ [修复] H3 Prompt/Setting 调宽手柄高度异常，改为贴合右侧栏边界的细竖向分隔线。
+ [修复] H3 生成按钮定位基准错误，改为固定在 Setting 区域右下角。
+ [修复] H3 Prompt/Setting 分割线位置未计入节点内边距和栏间距，拖拽热区改为严格对齐实际边界。
+ [修复] H3 Preview/Prompt 宽度手柄错误延伸到时间轴和 Output，限制为顶部预览区域内。
+ [调整] H3 内容区放不下 Preview、Video/Refs 与 Output 的最小高度总和时自动隐藏 Output。
+ [优化] H3 节点缩放时 Preview、Prompt、Timeline/Refs 和 Output 按可用空间动态伸缩。
+ [修复] H3 节点高度较小时 Setting 底部生成按钮被裁剪，提升 Setting 和操作区层级确保按钮可见。
+ [新增] H3 Prompt 工具条按生成模式切换南风 V10 结构，新增就地说明面板和 @ 引用候选过滤。
+ [修复] 图片节点在参考选择状态下点击上传图片后仍停留在“正在添加参考”，上传入口现在会先退出参考选择模式。
+ [修复] H3 @ 引用候选列表被 Prompt 面板底部裁剪，改为在文本框上方显示。
+ [优化] H3 @ 候选列表改为贴近 Prompt 文本框顶部显示，减少与输入位置的距离。
+ [修复] H3 隐藏 Output 后同步收缩 Setting 跨行范围并解除参数容器裁剪，避免右下角按钮消失。
+ [修复] H3 工作区固定行高覆盖节点缩放，改为按最小高度和弹性比例动态伸缩。
+ [调整] H3 工作区默认高度比例调整为 Preview : Video/Refs : Output ≈ 4 : 2 : 1。
+ [修复] H3 时间轴内部 Video/Refs 固定高度导致下方出现空白，改为填满 Timeline 可用区域。
+ [调整] H3 Video/Refs 时间轴支持同步横向滚动，并按 50px/秒固定时间占位宽度（10 秒为 500px）。
+ [修复] H3 日志在任务完成后回写实际传入的图片、视频和音频 refs 及数量，不再只显示节点上游素材汇总。
+ [修复] H3 分拆生成链改为让采样使用 ReleaseBeforeSampling 输出的 AV latent，并避免非法 STRING 到 COMBO Loader 连线。
+ [修复] H3 任务轮询和生成日志只记录本次 ComfyUI 返回的视频，不再误用后来替换的 Clip 挂载视频。
+ [修复] 本地 H3 生成、任务查询、取消和模型读取改为直连 Backend，不再强制依赖 Canvas Agent。
+ [修复] 为 H3 素材库和参数分组补齐 React 列表 key，消除工作台渲染警告。
+ [修复] 修复 Agent 设置回填在后台连接后因调用失效的 `set` 引发前端异常。
+ [调整] H3 智能分镜按图片、视频、音频槽位分别编号，并按模式过滤和传递实际参考图片。
+ [优化] H3 提示词增强对齐 Infinite-Canvas 节点，按当前模式携带片段时长、参考素材和全局提示词并生成官方结构。
+ [修复] H3 MCP 提交 ComfyUI 任务后同步回写节点与 Clip 状态，运行中、进度、结果和失败信息不再与画布脱节。
+ [修复] 锁定组同时禁止外部节点拖入，锁定组的边界不再接受新的节点。
+ [新增] 组节点工具栏增加锁定/解锁功能，锁定后组内节点不能被拖出组外。
+ [修复] 节点连线上的叉号现在可以直接断开对应连线。
+ [优化] H3 Output 的当前/全部筛选状态保存到节点配置，刷新页面后继续保持上次选择。
+ [修复] H3 Output 的“当前”筛选改为显示当前 Clip 的全部历史输出，不再只显示最近一次生成结果。
+ [修复] H3 工作台面板拖拽辅助线改为跟随实际 Assets 宽度定位，默认不再覆盖内容区域。
+ [优化] H3 当前 Clip 的 Prompt 与 Clip settings 增加可拖动分隔条，支持按需调整两侧面板宽度并记住节点设置。
+ [优化] H3 的加速 LoRA 与 Base model 下拉框支持按名称搜索，模型较多时可快速定位。
+ [修复] 普通视频节点的本地 ComfyUI 任务现在持久化任务 ID，刷新页面后会继续轮询并自动回写 FlashVSR 结果。
+ [修复] 页面刷新时保留带有运行时任务 ID 的 H3 生成状态，允许任务恢复轮询，不再误显示“生成已中断，请重新生成”。
+ [修复] 本地 ComfyUI 的 FlashVSR 视频模型不再误走云端视频 API 的 API Key 校验，改为调用本地 ComfyUI 工作流。
+ [新增] 视频节点模型新增“视频拼接”，通过本地 ffmpeg worker 按连接顺序拼接多个视频并回写为视频节点。
+ [新增] 画布图片节点支持本地 ComfyUI 生图：选择 `z-image`/`flux2-klein` 模型时直接提交本地 ComfyUI 工作流，参考图走本地媒体复用，不再误走云端 OpenAI 兼容接口。
+ [修复] 本地 ComfyUI 生图未指定种子时改用随机种子，画布批量生成多张不再因复用工作流模板固定种子而输出相同图片；显式传入 seed 时仍保持可复现。
+ [修复] 画布上游资源去重改为区分同一节点的不同媒体，H3 输出连线不再把多个时间轴 Clip 折叠成一个输入。
+ [修复] H3 输出连线改为按时间轴顺序输出所有已生成 Clip 视频，连接到下游节点时不再只传递单个 `metadata.content`。
+ [修复] H3 Prompt 区改用纵向 Flex 布局，标题、工具栏、语法提示和输入框不再因 Grid 固定行高互相挤压。
+ [修复] H3 Prompt 区语法提示改为自适应换行，增强失败信息独占一行，避免按钮、标签和输入框互相挤压覆盖。
+ [调整] H3 时间轴 Refs 九宫格改为显示所有 Clip 的参考素材，每个 Clip 独立占用与自身时间卡片一致的 3×3 区域。
+ [修复] H3 Refs 九宫格按当前 Clip 的时间起点和时长定位，并与当前 Clip 卡片保持同宽，不再铺满整个时间轴。
+ [调整] H3 时间轴 Refs 区改为当前 Clip 的三列九宫格并显示图片/视频/音频图标，移除下方重复的 Refs 横栏。
+ [修复] 禁止 H3 视频预览区域拖拽，避免拖动播放画面误创建视频节点；Output 和素材卡片的合法拖出行为保持不变。
+ [修复] 为 H3 Prompt 标题/语法说明和 Clip settings 下拉选项补齐稳定 key，消除 React 列表子节点警告。
+ [优化] 生成日志改为分页加载和虚拟滚动，长提示词/错误信息超过 5 行默认折叠，并在日志卡片中显示输入 refs。
+ [修复] H3 本地生成前增加 ComfyUI 状态检查，未启动时显示明确的“ComfyUI 未启动，请先启动 ComfyUI”，不再只显示 `fetch failed`。
+ [优化] Backend/Agent 临时断连改用警告提示，插件加载失败改为 warning 日志，避免把可自动恢复的连接问题显示成错误。
+ [修复] 修复 H3 素材、参考图和提示词引用列表的重复 key 警告，并避免内置 H3 插件被错误当作外部 Blob 插件解析。
+ [优化] 提示词详情页的封面和参考图增加可点击放大预览。
+ [修复] 修正视频工作台 Drawer 弃用属性警告，并为失效的提示词封面提供占位回退。
+ [优化] 提示词中心首次加载增加明显的加载状态，避免远程提示词源请求期间显示空白。
+ [修复] 提示词源缓存改由 Backend SQLite 持久化，刷新页面后提示词中心仍可恢复已拉取内容。
+ [调整] 移除浏览器 IndexedDB 业务存储：插件安装与私有数据改由 Backend 保存，提示词改用内存缓存，设置页不再统计浏览器数据库，同时删除旧数据迁移链路。
+ [修复] H3 时间线播放按钮改为真正连续播放所有 Clip，新增空 Clip 时不再错误显示上一段视频。
+ [新增] H3 时间线恢复 Refs 泳道，参考图片、视频和音频可按 Clip 时间段对齐查看，并可拖入指定时间段添加。
+ [修复] H3 Clip settings 的 Task mode 改为稳定的原生下拉，恢复文生、图生、首尾帧、视频编辑和参考素材等模式切换；TE speed 改为“开/关”开关。
+ [修复] H3 播放头按当前 Clip 的起止范围限制，并在视频结束时回写 Clip 边界，避免播放时间轴越过当前视频终点。
+ [修复] H3 运行当前及后续分镜时，每个成功 Clip 立即回写节点，避免后续分镜失败导致前面已完成产物丢失。
+ [调整] H3 Prompt 快捷结构按钮和语法提示移到输入框上方，减少编辑时底部操作区被遮挡的问题。
+ [调整] H3 底层工作流迁移为南风 NanFeng V10 的直接 API prompt 图：保留四种模式、完整动态选项、最多 8 个 LoRA 和高级采样/音频配置，不再执行南风 mega 节点或模板工作流。
+ [新增] 智能分镜表单增加“段间接续”开关，关闭时生成的分镜全部禁用 Motion Context，开启时按前后段结果自动衔接。
+ [调整] H3 批量运行按钮改名为“运行当前分镜及后续分镜”，明确其从当前 Clip 开始连续运行的实际行为。
+ [修复] H3 Motion Context 输出补接 `H3 Motion Context Trim`，同步裁掉前段锚定画面和音频，避免连接帧在新视频开头重复出现。
+ [调整] H3 Output 视频仅在拖到 H3 节点外的画布区域时创建视频节点，拖入 H3 工作区内部不再误创建节点。
+ [优化] H3 工作台重新整理深色编辑器视觉层级，提升字号、控件尺寸、面板间距、当前 Clip 高亮和按钮/卡片悬停反馈。
+ [修复] H3 Reset 取消生成时同步向 ComfyUI 删除排队任务并中断当前任务，避免前端显示已取消但 ComfyUI 仍继续生成。
+ [修复] H3 生成视频 400「媒体必须是 base64 data URL」复发：`canvas-agent` 的 `/runtime/media` 转发只读取 `dataUrl`、完全忽略 `storageKey`，把空字符串传给后端触发校验失败；现该端点支持以 `storageKey` 复用已有媒体（兼容 URL 编码的 `image%3A<uuid>` 形式），缺少参数时返回「缺少 dataUrl 或 storageKey」而不是笼统的 base64 报错。
+ [修复] 后端 `/data-dir` 路由因 `DATA_DIR` 未从 `./config.js` 导入而每次请求抛 `ReferenceError`，补齐导入后正常返回数据目录。
+ [修复] MCP 连接成功后同步当前画布快照到总后台，插件 MCP 工具不再因只读取持久化项目而显示“没有上下文”。
+ [调整] H3 时间线移除 Video 下方重复的 Refs 横栏，参考素材统一在当前 Clip 的 Refs 九宫格中管理。
+ [调整] H3 参考媒体改为仅通过本地 `storageKey` 复用文件，不再把本地图片转成 base64 重新上传；缺少本地媒体键时直接提示重新上传或连接素材。
+ [调整] 普通 ComfyUI 工作流的临时媒体同步也改为二进制上传到本地媒体库，再以 `storageKey` 解析本地文件路径，不再通过 base64 传输。
+ [新增] H3 补齐提示词模型增强状态、Output 全部/当前筛选与未使用输出清理、RunningHub Workflow/App 字段配置和生成任务 Reset 取消入口。
+ [调整] H3 智能分镜改为继承当前 Clip 的参考素材与参数并追加新 Clips，同时将全局提示词合并到新增 Clip。
+ [修复] H3 r2v/i2v 等运行时引用 404：运行器构造 `finalReferences`/`finalVideo`/`finalAudios`/`previousVideo` 时把 `storageKey` 透传给后端，后端媒体直接走 storageKey 复用（raw key 精确匹配）；后端 `/runtime/media` 的 storageKey 分支增加 `decodeURIComponent`，兼容从 URL 反推出的编码 key（如 `image%3A<uuid>`，媒体 key 本身含冒号）。此前只留 `url` 会解出编码 key 导致查不到或退化到 dataUrl 分支。
+ [修复] H3 串 clip 的 previousVideo 不再把已在后端的视频 base64 下载后重新上传（根因 413）：`POST /runtime/media` 支持以 storageKey 复用已有媒体，前端对已落库媒体走复用路径，避免请求体暴涨。
+ [优化] H3 当前 Clip 面板继续拆分为 `H3PromptSection` 与 `H3ClipSettingsPanel`，Prompt 快捷标签和生成参数区域不再压缩在单个超长 JSX 组件中。
+ [修复] H3 运行器拆分后补齐自动分段的默认每段时长与最大段数，避免启用源视频自动分段时引用未定义变量。
+ [优化] H3 Assets/Output 资源库抽离为 `H3MaterialLibrary`，工作台入口不再混合素材列表、删除与产物恢复逻辑。
+ [优化] H3 运行器将自动分段结果映射、生成素材收集和 Clip 合并抽离到 `h3-runner-utils`，生成组件只保留任务流程与状态回写。
+ [优化] H3 工作台顶部模型选择、智能分镜、Clip 新增、下载和参数入口抽离为 `H3WorkbenchToolbar`，主组件进一步收敛为布局编排。
+ [优化] H3 智能分镜表单字段抽离为 `SmartStoryboardFields`，弹窗组件只负责上传生命周期、提交和关闭控制。
+ [优化] 清理工作台拆分后残留的旧拖拽、清空和图标导入，避免入口组件保留无效依赖。
+ [修复] H3 运行失败时按执行瞬间读取的当前 Clip 标记错误，避免界面快速切换 Clip 后把错误状态写到旧 Clip。
+ [修复] 画布侧边栏复合资产封面只识别带 `storageKey` 的直接图片，现支持 `assetRef` 图片、`dataUrl` 图片和复合资产自身 `coverUrl`，恢复复合资产缩略图显示。
+ [修复] 复合资产旧封面 URL 失效时不再停留在破图状态，侧边栏会按候选顺序回退到子图片和后端 `storageKey` 媒体。
+ [修复] 智能分镜参考图拖拽改用专用槽位排序协议，拖动图片只交换槽位顺序，画布全局文件拖放入口会忽略该拖拽，不再误创建图片节点。
+ [优化] H3 参考素材分桶写回统一使用 `segmentRefsPatch`/`withSegmentRefs`，时间线、Clip 卡片和当前 Clip 面板共享同一份数据转换逻辑。
+ [优化] H3 运行事件采用稳定订阅并通过 ref 读取最新生成函数，避免节点 metadata 更新时反复重绑事件监听。
+ [修复] H3 运行按钮不再通过 `setTimeout` 延迟派发事件，改为由已挂载的 React 运行器同步接收当前 Clip/全部 Clip 请求，减少无意义的异步时序依赖。
+ [优化] H3 运行事件监听抽离到 `useH3RunEvents`，生成器仅负责提交与回写，工具栏/Clip settings 的触发协议独立维护。
+ [优化] H3 插件入口与开发入口共用 `node-definition.ts`，统一节点默认参数、尺寸、资源解析和工具栏配置，避免双份定义漂移。
+ [优化] 清理 H3 重构后无引用的旧 `PromptEditor` 组件，避免保留与当前内联 Prompt 编辑器重复的死代码。
+ [优化] 移除 H3 隐藏参数面板的重复 JSX，将运行事件监听器收敛为不渲染 DOM 的 `H3Runner`；节点实际参数继续由内联 Clip settings 提供。
+ [优化] H3 参数面板的本地表单状态与节点 metadata 同步逻辑抽离到 `useH3PanelState`，降低面板组件中的状态初始化和同步副作用。
+ [优化] H3 时间线与 Refs 泳道抽离为 `H3Timeline.tsx`，Clip 排布、播放头定位、参考素材拖入和分段新增不再堆在工作台入口。
+ [优化] H3 参数面板与隐藏运行器独立为 `H3Panel.tsx`，`H3Workbench.tsx` 进一步收敛为画布工作台编排组件。
+ [修复] H3 共享 UI 文件包含 JSX 却使用 `.ts` 扩展名导致 Vite esbuild 解析失败，改为 `.tsx` 后恢复插件加载。
+ [优化] H3 任务轮询与生成日志收尾抽离到独立 hook/service，工作台不再混合异步任务生命周期；下载操作改用项目现有 `file-saver`，移除插件内直接创建 `<a>` 元素的 DOM 调用。
+ [优化] H3 当前 Clip 面板抽离为 `H3CurrentClipPanel`，Refs、Prompt 和 Clip settings 不再与工作台时间线布局混合。
+ [优化] H3 单段 Clip 时间线卡片抽离为 `H3ClipCard`，排序、拖入参考素材、Motion Context、选中和删除逻辑独立维护。
+ [优化] H3 素材与 Output 卡片抽离为 `H3MaterialCard`，媒体预览、拖拽、删除及结果恢复操作不再内嵌在工作台主组件中。
+ [优化] H3 智能分镜表单抽离为 `SmartStoryboardModal`，图片槽位、模式选择和生成动作不再与工作台布局耦合。
+ [优化] H3 按钮样式收敛到共享 `components/h3-ui.ts`，避免工作台与高级设置组件重复定义交互样式。
+ [优化] H3 通用 Toggle 与按钮样式收敛到 `components/h3-ui.ts`，避免工作台和面板重复定义交互样式。
+ [优化] H3 Clip 元数据补丁、产物参数恢复和源视频切段逻辑抽离到 `services/h3-segment-utils.ts`，进一步缩小工作台主组件职责。
+ [优化] H3 参考素材读取与拖拽载荷解析抽离到 `services/h3-refs.ts`，工作台继续收敛为 React UI 编排层。
+ [修复] H3 Motion Context 截尾帧逻辑被错误绑死在「递进增噪」(motionContextNoise) 开关上：只开 Motion Context 不开增噪时，整段 previousVideo 直接喂给 9108 `MiniMaxH3MotionContext` 节点，未先截取前一段尾帧，导致下一段开头混入前段前面的帧。现改为只要 Motion Context 开启就先调 `workers/motion_context.py` 截取前一段最后 ~22 帧（新增 `--frames` 参数，取 motionContextLength 或默认 22）作为 context，递进增噪仅控制噪声强度（不开则纯截尾帧无噪），对齐旧画布 `E:\无限画布\Infinite-Canvas\main.py` 的 `build_minimax_motion_context` 行为。改 `backend/src/comfyui/bridge.ts` 的 `prepareH3MotionContext`，重启 backend 生效。
+ [优化] H3 工作台移除 `H3TransportBinder`、提示词绑定器和参考图绑定器，播放、提示词和素材交互统一回到 React 事件处理；不再通过 `querySelector/addEventListener` 扫描工作台 DOM。
+ [优化] H3 工作台移除生成流程中的 textarea DOM 反查、按钮状态 DOM 改写和视频 poster DOM 补丁，改为使用 metadata 与 React 渲染状态。
+ [修复] H3 预览播放 Clip2/Clip3 时将整条时间线的全局秒数误传给单段视频，现区分时间线时间与 Clip 内部播放时间，切换分段后从该 Clip 的 0 秒开始并正确回写全局进度。
+ [优化] H3 工作台抽离智能分镜服务、H3 图标组件和通用数据处理函数，降低 `H3Workbench.tsx` 的职责与体积，保持现有节点和生成事件兼容。
+ [新增] H3 智能分镜前端链路复刻南风的逐图看图、Skill 注入、模式契约和严格分镜解析，生成结果保留完整官方提示词与视觉分析信息。
+ [修复] H3 节点（type=`minimax-h3:video`）在画布上几乎无法拖动：其拖动完全依赖 `canvas-node.tsx` 的 `onMouseDownCapture` 分支（H3 根 div 在冒泡阶段 `stopPropagation` 挡掉了普通 body 拖拽路径），而该分支对 H3 施加了 `closest("button, input, textarea, select, video")` 全量黑名单；H3 节点内容几乎全是视频/输入框/下拉/按钮，导致任意可见区域按下都命中被排除、拖动完全不启动。现对 H3 节点将黑名单收窄为仅 `input, textarea, select`（纯文本编辑控件），视频预览、按钮、轨道空白等区域均可拖动节点，其余节点类型保持原黑名单不变。web 端改动经 Vite HMR 即时生效。
+ [修复] 紧随上一条 H3 拖动修复引入的回归：四角 `ResizeHandle` 是纯 `div`，会命中拖动分支；而在 `onMouseDownCapture` 捕获阶段触发 `handleNodeMouseDown` 后其 `event.stopPropagation()` 会掐断事件，使 `ResizeHandle` 自身的 `onMouseDown`（冒泡阶段）无法执行，导致节点缩放被拖拽劫持、缩放能力失效。现给 `ResizeHandle` 加 `data-resize-handle` 标记，并在捕获分支显式排除命中缩放手柄的 mousedown，使缩放恢复正常（该修复同时修正了所有节点类型的同类潜在劫持）。
+ [修复] 同上回归链路的延伸：连线手柄 `ConnectionHandleDot`（canvas-node.tsx:973，节点左右两侧的连线圆点）同样是纯 `div`，也会命中 `onMouseDownCapture` 的拖拽分支；捕获阶段触发 `handleNodeMouseDown` 的 `stopPropagation` 会掐断其自身冒泡阶段的 `onConnectStart`，导致"无法连线、长按变成拖拽"。现给 `ConnectionHandleDot` 加 `data-connection-handle` 标记，并在捕获分支显式排除命中连线手柄的 mousedown，使从连线手柄拉线恢复正常。
+ [修复] 导入复合资产（kind=composite）后图片显示不出来：根因是 `use-asset-store` 的 `addAsset` 一律 `nanoid()` 重新生成 id，丢弃导入资产的原始 id；而导出的复合资产子项以 `assetRef + refId` 形式存储（指向子资产的原始 id），导入后子资产 id 变更导致 `refId` 悬空，`resolveAssetRefItem` 返回 null、图片被过滤。现改为：`addAsset` 支持外部传入 `id`（默认仍自动生成，向后兼容）；`importAssetZip` 在导入时为每个资产分配新 id 并维护「旧→新」映射，对复合资产的 `assetRef.refId` 一并改写，保证跨资产引用在导入后仍然有效。另 `useResolvedCoverUrl` 现在也会解析复合资产内的 `assetRef` 子项（取被引用资产的 image/video/audio storageKey），使资产库卡片封面能显示复合资产的缩略图。
+ [修复] 后端 `/media/:storageKey` 与 `/runtime/media-file` 只读媒体端点豁免全局 token 鉴权：媒体 URL 内嵌的 token 在 backend 重启后会轮换失效，导致历史产物刷新后请求 401、视频/图片“消失”；本地单用户开发 backend 的 CORS 已 `*`，对只读媒体免 token 即可避免该问题（写入类端点仍受保护）。
+ [修复] H3 节点 Output 区"设为当前 Clip"（点击按钮与拖拽到 clip 两种路径）此前只把结果视频 URL 灌入当前 clip，不还原生成该产物所用的 prompt 与参数。现新增 `buildRestoreParamsPatch`：按产物 URL 反查源 segment（run() 落库时已保留其完整 prompt/参数），将 prompt、taskMode、duration、megapixels、videoSteps、denoise、seed、modelName、lora、teAccel、音频与 motion context 等全部生成参数一并还原，并同步 `resultStorageKey`；旧产物亦可还原，无需重跑。预构建插件产物 `web/public/plugins/minimax-h3.js` 已重建（不含 refs/参考素材，避免覆盖当前 clip 的参考输入）。
+ [修复] H3 节点"运行 H3"按钮增加 1.2s 点击防抖，避免一次点击因事件冒泡触发多次 `run()` 导致重复调用与报错刷屏；预构建插件产物 `web/public/plugins/minimax-h3.js` 已重建。
+ [修复] 前端 `comfyui.ts` 对后端返回媒体 url 直接 `new URL()` 在本地模式（相对路径/Windows 风格路径）下抛 "Failed to construct 'URL'" 的问题，改为容错代理 `proxyComfyMedia`；并修正代理目标：`/media/:storageKey` 走总后台 `/media`（开发模式经 Vite 代理同源），`runtime-file:` 走总后台 `/runtime/media-file`，只有 ComfyUI 直链才走 `/agent/comfy/media`，避免视频 URL 落到 `/agent/media/...` 导致 404 黑屏。
+ [修复] 后端 `comfyui/bridge.ts` 的 `buildWorkflow` H3 分支此前未把用户输入的 prompt 注入工作流文本节点（节点 138），导致通过插件 UI 点"运行 H3"时始终渲染工作流写死的默认 prompt；新增按 136 节点的 prompt 引用动态写入文本节点 value（兼容 value/text），与 canvas-agent 路径对齐。
+ [修复] 把资产图片拖到 H3 节点区域（非 refs 泳道）会冒泡到画布层误生成“图片节点”。根因：H3 根元素的 `onDropCapture`（capture 阶段）只在落点为 refs 泳道时才加 ref 并 `stopImmediatePropagation`，落在节点其他区域时不拦事件，drop 冒泡到画布 `handleDrop` 后生成图片节点。现于 `onDropCapture` 末尾增加兜底：凡是落在 H3 节点区域内、携带资产引用（`application/x-infinite-canvas-ref`）或文件（`Files`）的未处理 drop，一律 `preventDefault + stopImmediatePropagation` 吞掉；refs 泳道加 ref、时间轴 clip 接收 Output 等原有逻辑不变。预构建插件产物 `web/public/plugins/minimax-h3.js` 已重建。
+ [修复] 修复生图结果图开发模式下的 CORS 跨域问题：为 Vite 增加 `/media` 代理（同源转发到总后台 17370），并让 `backendMediaUrl` 在 dev 本地模式返回同源相对路径，媒体请求不再直连 127.0.0.1:17370，彻底绕开跨域 CORS；生产/远程 backend 仍走绝对 URL（依赖总后台 CORS 白名单）。
+ [修复] 重建 canvas-agent dist 并修复 `plugin-mcp.ts` 两处类型错误（缺失 `backend` 字段、`PluginMcpBackend` 缺 `replacePluginDeclarations`），使 `npm run build` 通过、Backend 可正常导入 `@basketikun/canvas-agent/runtime/agent-runtime` 启动。
+ [修复] 生图工作台结果图片改用后端媒体绝对 URL（带当前 token）显示/下载/再上传，修复开发模式下相对路径请求到 Vite 服务导致裂图的问题。
+ [优化] 前端工作台日志、画布和素材改为按 Backend 逐条读写，并接入 Backend SSE，避免 localforage 日志和全量替换造成双写或覆盖。
+ [修复] 加固 IndexedDB 一次性迁移的去重、合并、校验与清理顺序，迁移失败时保留原始数据和已存在的 Backend 数据。
+ [优化] Backend 收敛为 Agent、ComfyUI、RunningHub、FFmpeg、任务、媒体和插件 MCP 的统一运行时，standalone canvas-agent 改为兼容代理。
+ [修复] ComfyUI 生成结果和 H3 Motion Context 合并视频统一落入 Backend media_files，并通过任务 SSE 发布运行中、完成和失败状态。
+ [修复] RunningHub 与 FFmpeg 输出媒体统一登记到 Backend media_files，保留原有输出路径和远程地址兼容字段。
+ [修复] H3 MCP 全部 Clip 改为串行执行并沿用 Motion Context，任务取消只允许作用于 queued/running 状态。
+ [新增] Backend 资产新增、修改、删除和批量替换统一发布 `asset.updated` SSE 事件，供前端增量同步使用。
+ [修复] Backend 业务路由异常统一通过末端错误处理中间件返回 JSON，避免 Agent 接口收到 Express 默认错误页。
+ [修复] Backend 挂载的 ComfyUI、RunningHub、FFmpeg 与 Agent 路由也统一纳入 JSON 错误处理。
+ [优化] 画布、素材、生成日志和媒体统一由总后台 SQLite/media_files 读写，IndexedDB 仅作为一次性迁移来源，Agent 不再提供业务数据回退。
+ [修复] 修复 Store 迁移后的项目、媒体、H3 输出和生成日志恢复链路，避免旧数据被空的 Backend 副本覆盖。
+ [优化] MiniMax H3 插件浏览器端按入口、工作台、类型、常量、服务、hooks 和样式模块拆分，保持现有节点与 Agent MCP 契约不变。
+ [新增] Canvas Agent 支持插件 MCP 能力:启用 MiniMax H3 插件时在 Agent 侧动态注册 h3_* 工具(h3_list_models / h3_get_node / h3_run_clip / h3_get_task / h3_cancel_task / h3_update_clip / h3_run_all_clips),复用 ComfyUiBridge 与任务库,并经官方白名单加载。
+ [新增] 插件协议新增可选 `mcp` 声明(CanvasPluginMcp),支持浏览器启用/禁用时经 `POST /api/plugins/mcp` 通知 Agent 动态注册/注销 MCP 工具,声明持久化到 SQLite,重启后仍生效。

+ [修复] H3 节点"随机种子"下拉切不回"随机"模式：segment 派生时曾把遗留的固定种子值误判为 fixed 模式，现以用户显式选择的 noiseSeedMode 为权威，仅当从未设置时按种子值兜底。
+ [修复] H3 随机种子实际不生效：切到"随机"即生成一个真实随机种子并展示（含🎲重摇按钮），运行时统一使用 UI 上该种子（random/fixed/运行后回写三者一致），不再 random 模式永远静默生成新随机且运行前不展示任何种子值。
+ [修复] H3 运行失败却显示"已取消"：cancelRequested 只在用户点取消时置 true、仅在重置节点时清回，残留标志把后续任何运行失败（如 ComfyUI 未启动、参数错误）都误映射为"已取消"并吞掉真实错误；现 run() 作为全新运行起点进入时重置 cancelRequested，取消标志只作用于本次运行期间用户真正取消的情况。
+ [修复] H3 任务生成成功但前端一直显示"running"且视频不回传：backend ComfyUI Bridge 的 executeWorkflow 仅轮询 /history/:prompt_id，若 ComfyUI 历史记录被清理或完成状态缺失会导致任务无限 running；现增加超时兜底、status_str === "success" 完成识别，并在 /history 长期缺失时结合 /queue 判断任务是否仍在执行或已丢失，避免无限挂起。
+ [修复] H3 生成视频仅出现在 Output 区、未替换当前 Clip：useH3TaskPolling 成功路径只写 content/materials 而漏写 segment.result，导致 Clip 卡片与时间轴预览不更新；现统一调用 withSelectedResult 把生成视频写回当前选中 Clip（result/results/storageKey），Clip 卡片与时间轴即时替换。
+ [新增] H3 Output 区素材卡支持双击放大预览：新增 lightbox 浮层（视频可播放、图片可查看），并配放大按钮与关闭（点击遮罩/×/Esc）交互。
+ [优化] H3 时间轴"+"新增 Clip 后自动选中该 Clip，并把时间轴滚动到该 Clip 最右侧与其右边缘对齐（ruler/refs 同步）。
+ [修复] H3 新增 Clip 后时间轴刻度线（播放头指示线）未指向新 Clip：addSegment 此前只设 selectedSegmentId 不更新 playhead，导致蓝色播放头线/标尺三角 marker 停在旧位置；现与点击 Clip 一致，新增时把 playhead 设为新 Clip 起点并退出“全部播放”模式，刻度线即对准新 Clip。
+ [修复] H3 Refs 区域素材拖动判定不准：①从 Refs 拖出素材时靠 children 索引定位 segment/ref，但 .minimax-ref-content 首位是 playhead 竖线导致索引偏移 1，拖出的 ref 实际来自错误 Clip；现给 ref-grid 加 data-segment-id、ref-clip 加 data-ref-index，dragStart 用 dataset 稳定定位。②拖入 Refs 时按“可见区宽度”换算时间，时间轴溢出滚动后落点严重偏后，现改用 scrollLeft+鼠标可见偏移（每单位 50px）精确换算内容坐标。

+ [修复] H3 智能分镜生成失败导致"生成当前 Clip"按钮点不了：智能分镜此前与视频生成共用全局 status 字段（生成/成功/失败时都写 status），分镜 loading 会把按钮误判为忙碌变成"取消生成"，且分镜无 runtimeTaskId 导致点"取消生成"时 cancel 处理器直接 return、status 永久卡在 loading 形成死循环；现智能分镜只用专属 smartStoryboardStatus/smartStoryboardError 字段、不再碰全局 status，并让无任务的 cancel 把节点重置回可运行以救活卡死节点，分镜按钮新增失败态（红字"分镜失败·点击重试"）。
+ [修复] H3 Refs 区域拖动判定仍不准（复测）：上一轮用"时间反推 clip"定位法在边界/gap/滚动不同步时会选中错误 clip，且 find 失败静默回退到 selected；现拖入落点改为直接用光标下 DOM 元素 event.target.closest(".minimax-ref-grid") 取 data-segment-id 精确判定（时间换算仅作兜底），并支持同节点内跨 clip 拖动=移动（从来源移除避免重复）；ref-clip 的 draggable 由脆弱的命令式 useEffect 改为 JSX 声明式 draggable。

+ [修复] H3 生成成功后视频乱写到其他 Clip：异步轮询回写（useH3TaskPolling）原本用 metadata.selectedSegmentId（轮询时实时选中的 Clip）作为回写目标，用户等待生成期间切换 Clip 就会导致结果写到错误 Clip；现提交时把目标 Clip 锁定到 metadata.runtimeTargetSegmentId（onTaskId 回调写入 segment.id、run 起始写入 liveSelectedId），轮询/恢复回写一律优先使用该锁定值（刷新恢复场景额外回退到 generationLog 记录的 selectedSegmentId），且任务结束即清除该字段，杜绝残留误导。
+ [修复] H3 时间轴滚动进度不持久化：刷新后滚动条回到最左。现滚动时（rAF 节流）把 scrollLeft 写入 metadata.timelineScrollLeft，挂载时一次性恢复该位置；新增 Clip 的 pending 滚动会覆盖恢复值且不被拉回，用户手动滚动也会被持久化。
+ [修复] H3 参数（如百万像素/MP）不生效（clip8 设 0.2MP 却输出 0.9MP）：根因为 ClipSettings 的 nfChoices 用后端 catalog.nanfeng[“百万像素”] 数组**整体替换**标准档位，一旦 ComfyUI 返回的 nanfeng 配置不含该标准值（如 0.2），下拉里就根本选不到，segment 停留旧值。现改为**合并**后端发现值 + 标准档位（去重、标准值始终保留），任何标准 MP/精度/比例档位都可选中并真实下发到 ComfyUI（run 时每段按 segment.megapixels/seed/prompt 各自取值，line 189 解构未排除这些字段，参数确实透传）。

+ [修复] 浏览器持续报 `net::ERR_INCOMPLETE_CHUNKED_ENCODING` 且后台明明连着：根因为总后台 `/events` 与 agent `/agent/events` 两个 SSE 长连接被浏览器系统代理（本机 Clash 127.0.0.1:7897，netstat 见大量 CLOSE_WAIT）截断，普通短连接 API 不受影响故"后台连着"。修法：检测到本地总后台（127.0.0.1/localhost:17370）时，前端把这两个 EventSource 改为同源相对路径（`/events`、`/agent/events`），由 Vite 开发服务器代理转发到 17370（Node 端、不经浏览器代理），长连接不再被代理掐断；并在 `web/vite.config.ts` 的 server.proxy 增加 `/events`、`/agent` 两条同源代理（非 SPA 路由，不与前端冲突）。远程/非本地总后台仍走绝对地址直连。

+ [调整] H3 时间轴 Video 行每个 Clip 卡片左上角的「素材数量图标 + 数字」（回形针 + refs.length）已移除，仅保留 Clip 序号/时间区间、Motion Context 按钮与删除按钮。

+ [修复] 生成日志弹窗中「输入 refs」只显示「参考 1/参考 2」文字 Tag：原 `ReferencePreview` 仅按 `reference.type` 判定，部分日志 references 字段缺少 type/url 导致 fallback 为文字标签。现新增 `collectReferences` 从 `log.params.refs` / `log.params.refItems` 兜底读取完整参考数据，并结合 URL 扩展名/MIME 类型推断显示图片/视频/音频缩略图。

+ [修复] 拖动时间轴时 refs 轨道与 video 轨道滚动不同步：原 `registerScrollContainer` 用单一数组管理多个滚动容器，DOM 重建/卸载后旧元素残留导致同步目标错乱。现改用 rulerRef/videoTrackRef/refsTrackRef 三个独立 ref，并通过 rAF 防抖统一同步三个容器的 scrollLeft，拖动任意轨道时三者实时对齐。

+ [修复] H3 参考图尺寸 match/max 选择未完全生效：backend `comfyui/bridge.ts` 的 conditioning 分支（`MiniMaxH3ReferenceToVideo`，非 t2v/i2v/fl2v 的 reference 模式）将 `ref_image_size` 硬编码为 `"max"`，无视用户选择；主采样节点 136（rv2v/r2v 分支）已用 `params.refImageSize`，两者不一致导致选择部分失效。现改为 `String(params.refImageSize || "max")`，与节点 136 一致且不破坏未选时的默认行为（仍 max）。前端 UI 仅 `mode==="ref2va"` 渲染该下拉（i2v/fl2v 走 ImageToVideo 无此字段，合理）。

+ [修复] 总后台（backend）稳定性：①HTTP server 增加连接超时（keepAliveTimeout=30s/headersTimeout=35s/requestTimeout=120s），主动回收浏览器频繁开关产生的半关闭 socket，避免 CLOSE_WAIT 堆积至 fd 耗尽而“老是挂掉”；②新增 `uncaughtException`/`unhandledRejection` 进程级兜底，单点异常（如 SSE 断连后 EPIPE）只记日志不杀进程；③`/events` SSE 增加断连后写错误（EPIPE）保护，避免客户端断开瞬间写已关闭 socket 抛未捕获异常。
+ [优化] 总后台启动统一为 `tsx --watch src/index.ts`（原有无 watch 实例导致改源码不热重载、且多实例争抢端口），改 backend/src 后自动重载，无需手动重启。

## v0.17.0 - 2026-09-02

+ [修复] 文档站默认英文路径不再因内部语言重写产生重定向循环。
+ [优化] 文档站移动端折叠菜单新增分类切换入口，桌面端增加随滚动高亮的本页目录。
+ [优化] 画布左侧元素列表按组展示树形层级，组内节点支持展开和收起。
+ [优化] Canvas Agent 生成流程复用仅由现有节点引用构成的提示词，避免创建重复文本节点。
+ [新增] 节点输入框上方新增参考内容栏，可预览、移除或从画布连续选择参考节点；组引用会展开组内全部内容，移除任一项即断开整组。
+ [新增] 视频节点右键菜单支持截取首帧、尾帧和当前帧并生成图片节点，方便衔接连续镜头。
+ [调整] 移除文本节点右上角的生图按钮，让正文区域保持简洁完整。
+ [调整] 多次文本生成合并为单个文本节点，其他结果作为可展开切换的备选文本。
+ [新增] 组节点可作为生成输入并通过单条连线或 `@` 一次性引用组内全部有效资源。
+ [修复] 透明图片在多图备选展开时保持透明背景，不再显示白色卡片底色。
+ [修复] Canvas Agent 转发 CLI 错误日志前脱敏常见凭据，避免调试日志和浏览器事件流泄露密钥。
+ [修复] Canvas Agent 配置目录和配置文件收紧访问权限，降低本地连接 Token 被其他系统用户读取的风险。
+ [修复] Canvas Agent 自动连接凭据改用 URL fragment 传递并在读取后立即清除，避免 Token 进入服务器日志、Referer 和浏览器历史。
+ [修复] GPT Image 模型请求不再发送不受支持的 `response_format` 参数。
+ [修复] 图片接口返回临时外链时统一下载、校验并本地保存，支持取消下载，跨域无法读取时保留可显示的原链接。
+ [调整] 局部遮罩编辑改为在画布生成一张遮罩标注图，不再使用接口的 mask 参数；

## v0.16.0 - 2026-08-18

+ [新增] 提示词来源新增 Freestylefly GPT Image 2 内置来源。
+ [调整] 移除火山方舟协议及 Seedance 专用适配。
+ [调整] 画布默认使用移动工具，可直接拖动元素或空白画布，按住 Control 可临时框选节点。
+ [调整] 双击多图节点统一放大预览图片，仅通过右上角张数按钮展开或收起图片组。
+ [修复] 文本节点和生成配置新增独立的文本生成次数，默认一次且不再误用生图数量。
+ [修复] 节点缩放期间暂停渲染提示词面板，避免导入图片后立即缩放导致页面崩溃。
+ [优化] 生图、视频和音频请求遇到跨域拦截时明确提示需要通过自己的服务转发。
+ [优化] 图片工具条默认仅显示图标并移除图片、文本编辑入口，单击图片、文本或视频节点直接打开下方提示词面板。
+ [优化] 画布多图展开状态改为由用户主动控制，操作画布其他区域时不再自动收起。
+ [优化] 展开的多图子图支持双击直接放大预览，无需先设为主图。

## v0.15.1 - 2026-08-07

+ [调整] 项目开源协议更换为MIT，允许所有人免费用于开源、闭源和商业场景。

## v0.15.0 - 2026-08-07

+ [新增] 画布节点提示词支持弹窗放大编辑和实时同步。
+ [新增] 配置页新增本地存储、站点配额与对象仓库占用信息。
+ [新增] 画布多图支持失败项重试与删除、创建副本和单图下载。
+ [新增] Agent 输入框支持通过 `/` 快速选择 Skill，并通过 `@` 将画布素材按光标位置插入正文，输入及发送后均支持悬浮预览。
+ [优化] 画布新增选择与移动模式，并支持 Control 或空格临时反转工具。
+ [优化] 画布多图合并为可展开的单节点，支持实时状态、主图切换和四列布局。
+ [优化] 从左侧元素列表定位节点时，自动缩放上限调整为 100%。
+ [优化] Agent 用户消息元数据改为独立的版本化文件存储，刷新或重启后仍可恢复附件、Skill、画布引用及本地缩略图，未知存储格式不会被覆盖。
+ [修复] 关闭输入面板后保留图片与文本节点的编辑提示词。
+ [修复] 点击画布空白处时同步收起节点工具条和输入面板。
+ [修复] 空格键切换工具时不再误触当前聚焦的按钮。
+ [修复] 清理本地图片时保留工作台生成历史引用的文件。
+ [修复] 修复画布多图切换主图、重试和调整尺寸时的缩放与状态异常。
+ [修复] 统一画布多图操作按钮在不同主题下的颜色与对比度。

## v0.14.0 - 2026-08-05

+ [新增] 文档站支持英文默认与简体中文切换，正文、导航、搜索及 LLM 文档接口按语言独立展示。
+ [新增] 前端搭建中英文国际化框架，支持从右上角一键持久化切换全局导航、首页、配置中心、Ant Design 和日期组件语言。
+ [修复] 统一 Ant Design 下拉菜单与选择器在浅色、深色主题下的弹层及交互状态颜色。
+ [修复] Agent 顶栏在英文模式或可用宽度不足时自适应隐藏标签文字，避免内容被裁切。
+ [新增] Agent 支持查看、创建、编辑、删除、启停和显式调用本地 Codex Skill，并同步多标签页变更。
+ [新增] Agent 支持从当前对话或当前画布生成可编辑的 Skill 草稿，并在用户确认后保存。
+ [调整] Agent 面板连接状态、内容标签和新对话统一排版，窄面板仅隐藏文字并保留图标与数量。
+ [优化] Agent 输入区控件随面板宽度在图标与图标加文字之间自适应。
+ [修复] Agent Skill 草稿期间保持 MCP 活动画布隔离，支持停止临时生成任务，并禁止并发修改 Skill。
+ [修复] Agent 新建或恢复对话时统一同步版本化会话与 MCP 初始化状态，避免多页面竞态误触 `409`、提前发送或任务后残留初始化卡片。
+ [优化] 提示词中心缩小卡片、每行展示四张，移除“加入我的资产”按钮边框。
+ [优化] 缩小生图与视频工作台的提示词库弹窗，精简卡片。

## v0.13.0 - 2026-08-03

+ [优化] Agent 进入空白对话或点击新对话后后台预热 Codex 与 MCP。
+ [优化] Agent 排查日志改为筛选栏结构化滚动列表，支持筛选、展开详情并折叠连续重复事件。
+ [优化] Agent 日志统一使用居中的回到底部入口，向上浏览时暂停跟随并可快速返回最新内容。
+ [优化] Agent 对话将同一轮连续命令合并为按数量折叠的命令组，默认隐藏冗长命令预览。
+ [修复] MCP 初始化期间禁用 Agent 按钮与回车发送，避免首条消息提前清除服务加载状态。
+ [修复] Agent 对话代码块关闭行号后多行内容被拼接为一行的问题。
+ [修复] 统一 Agent 实时事件与线程历史的消息归属，避免多窗口或刷新后出现过程重复等问题。
+ [修复] 节点缩放期间暂停渲染跟随节点的浮层工具条高频更新导致页面崩溃。

## v0.12.1 - 2026-07-31

+ [新增] 画布右侧Agent支持按当前账号可用范围选择Codex 模型与推理强度。
+ [优化] Canvas Agent 升级至最新 Codex，启动时检查版本更新，
+ [优化] 统一通过公共日志输出 Info 以上信息，美化转发日志时间。
+ [优化] Agent高速流式回复取消逐词动画排队和当前消息离屏占位。
+ [修复] Agent首次发送消息时立即保留并展示用户内容，不再晚于思考状态。

## v0.12.0 - 2026-07-30

+ [新增] 画布 Agent 支持三档 Codex 权限，并可在对话中审批操作。
+ [新增] Canvas Agent 支持 `--debug` 日志并按日期保存。
+ [新增] Agent 新增可折叠任务进度，实时显示各步骤处理状态。
+ [调整] Agent 工具确认模式移至输入框并默认自动确认。
+ [调整] 进入画布后默认开启空白对话，历史对话改为主动恢复。
+ [修复] Agent 默认通过节点生成，明确指定时才使用 Codex 内置生图。
+ [修复] Agent 本地路径改为在文件管理器定位，不再拼接 localhost。
+ [修复] Agent 启用 Codex 思考摘要，并修复历史恢复后过程记录缺失。
+ [修复] 修复 Agent 图片预览打开后产生额外空行的问题。
+ [修复] Canvas Agent 停止任务仅中断 turn，不终止服务进程。
+ [修复] Agent 修复运行提示闪退和回复需切换标签页才显示的问题。
+ [修复] Agent 任务失败时立即结束等待，并在对话和历史中显示中文原因。
+ [修复] Agent 修复图片附件偏移，历史恢复保留缩略图且不回显内部说明。
+ [修复] 修复画布复制快捷键拦截 Agent 对话和节点详情文本复制。
+ [优化] Agent「新对话」立即清空并后台同步，不再等待创建 Codex 线程。
+ [优化] Agent「读取画布」按节点类型和连线分类展示内容概览。
+ [优化] Agent 发送后立即清空输入框并展示消息，避免内容滞留或草稿被清空。
+ [优化] Agent 动态工具卡片显示名称、状态和失败原因，替代「工具操作」。
+ [优化] Agent 面板标题、功能标签和新对话操作合并为单行顶栏。
+ [优化] Agent Markdown 代码块与外链确认弹窗改为紧凑中文样式。
+ [优化] Agent 思考摘要支持 Markdown 渲染，改善列表和代码阅读。
+ [优化] Agent 思考摘要和命令改为无边框折叠行，保留实时返回内容。
+ [优化] Agent 用户图片改为紧凑缩略图并支持单击放大。
+ [优化] Canvas Agent 的 Codex CLI 升级至 0.145.0。
+ [优化] Canvas Agent Debug 日志改为纯文本单行格式。
+ [优化] 精简 Agent HTTP 诊断日志，过滤轮询、流式重复事件和原始响应。
+ [优化] Agent 对话移除头像，工具活动紧凑展示，Token 用量支持数字动画。
+ [优化] Canvas Agent 流式回复改为增量传输，减少长对话重复渲染。
+ [优化] Agent 新增过程时间线，工具卡片改为中文摘要和可读详情。
+ [优化] Agent 长时间等待时显示阶段、时长和停止提示，避免空会话读取失败。
+ [优化] Agent 历史记录支持多选批量删除，点击记录可直接进入对话。
+ [优化] Agent 优先操作当前画布，不再无故查询列表或重复导航。
+ [优化] Canvas Agent 独立维护工作区指令，不再重复拼接提示词。
+ [优化] Canvas Agent 目录按 Agent、画布、服务和工具拆分职责。

## v0.11.0 - 2026-07-28

+ [新增] 画布文本生成新增推理强度设置，支持默认调用与自定义调用脚本读取所选档位。
+ [新增] 生图与视频工作台的参考资产区域支持直接拖动文件上传。
+ [新增] 配置与用户偏好支持通过配置文件导入和导出。
+ [新增] 模型渠道新增火山方舟协议。
+ [优化] 画布左侧元素列表新增图片放大预览操作。
+ [优化] 图片遮罩、切图与裁剪编辑支持常用快捷操作并修复高分辨率图片预览闪烁。
+ [优化] 提示词详情弹窗改为上下布局并限制显示尺寸。
+ [修复] 画布组装提示词浮层限制正文高度，长提示词改为区域内滚动查看。
+ [修复] 修复画布节点提示词过长时无法使用鼠标滚轮滚动的问题。
+ [修复] 修复画布重试时组装提示词重复以及切换类型调用模型不一致的问题。
+ [修复] 修复生成完成后再次选中画布节点时提示词不再回显的问题。

## v0.10.0 - 2026-07-25

+ [新增] 提示词来源新增BananaPromptQuicker，并支持添加自定义标准 JSON 来源。
+ [新增] Agent 新增统一状态查询，支持查看画布、生图工作台和视频工作台任务进度。
+ [调整] 内置提示词来源改为读取ImagePrompts 统一JSON 数据，不再由画布端分别解析。
+ [调整] 提示词来源配置保留卡片式交互，并展示来源数量、同步状态和上次成功时间。
+ [优化] 提示词来源支持独立缓存和更新，更新失败时保留上一次成功内容。
+ [优化] Agent 对话区分用户与 AI 消息，并优化会话切换和回到最新消息的交互。
+ [优化] 画布生成完成后保留提示词输入，并改善提示词库和资产面板的交互性能。
+ [优化] 提示词中心标题居中、搜索输入增加防抖，并采用左侧筛选、右侧内容的双栏布局。
+ [修复] 本地 Agent 完善多标签页请求隔离、结果归属、焦点回退和 Codex 会话状态同步。
+ [修复] 本地 Agent 上传的图片附件可正确创建画布图片节点并连接生成流程。
+ [修复] 画布提示词库支持跨来源搜索，插入节点时保留提示词标题。

## v0.9.0 - 2026-07-17

+ [新增] 左侧面板「资产」Tab 支持上传添加图片/视频资产、卡片悬停移除资产。
+ [新增] 左侧画布面板支持拖拽调整宽度、展开/收起(带动画),顶栏菜单左侧新增面板开关按钮。
+ [新增] 顶栏菜单新增「导出当前画布」,导出为包含全部资源的压缩包。
+ [新增] 左侧画布元素列表支持多选并批量导出选中元素为压缩包。
+ [新增] 可选的网站统计分析:支持 Google Analytics 4 与百度统计。
+ [调整] 画布节点名称默认不再显示,仅在选中/悬停/编辑时出现,画布更简洁。
+ [优化] 左侧面板「画布/资产」切换改为带滑动下划线的动画,移除非图片元素图标的灰色底色。
+ [优化] 画布节点提示词面板 `@` 引用图片时,输入框内直接显示真实缩略图。
+ [优化] 移除画布节点右上角的「图片1/文本1」资源角标,引用改在对话面板 `@` 直接选取。
+ [修复] 连接本地 Codex Agent 后,拖拽画布节点边框缩放等高频编辑导致页面崩溃。

## v0.8.2 - 2026-07-16

+ [新增] 图像设置新增「透明背景」开关,开启后生成无背景的透明图像。
+ [优化] 画布节点输入区域移除灰色底色与边框、美化样式。
+ [修复] 画布节点提示词输入框补上悬停文本光标。

## v0.8.1 - 2026-07-16

+ [新增] 插件 SDK 扩展:AI 生成能力、面板控制能力。
+ [优化] 3D 全景(1.1.0)支持上传与 AI 生成并升级查看器;
+ [优化] HTML 节点(1.2.0)迁移到统一交互开关;
+ [优化] 便利贴(1.1.0)可拖动移动、自选颜色、移除资源角标与衍生功能;
+ [优化] SVG 节点(1.1.0)透明背景融入画布、可拖动、去除默认值;
+ [优化] 画布节点渲染性能:memo 化节点回调,交互时不再全量重渲染;
+ [修复] 修复 Markdown 节点在点击/移动视角时重复渲染导致图片反复请求的问题;
+ [修复] 修复插件版本号显示不更新，插件面板新增可升级绿点提醒。

## v0.8.0 - 2026-07-15

+ [新增] 画布节点插件系统:支持通过 URL 动态安装/启用/更新/卸载远程节点插件。
+ [新增] 插件开发 SDK,可用 TypeScript 开发画布节点插件。
+ [新增] 新增 Markdown、SVG、HTML、3D 全景、便利贴等示例插件。
+ [新增] 官方插件注册表:节点插件面板可从项目仓库读取官方插件列表并一键安装。
+ [新增] 在画布右上角工具栏新增「节点插件」入口。
+ [新增] 支持自定义生图/视频接口调用方式以适配不同中转站。

## v0.7.1 - 2026-07-15

+ [修复] 修复页面白屏报错的问题。

## v0.7.0 - 2026-07-14

+ [新增] Agent 对话消息改用 streamdown 流式渲染，提升Markdown 内容展示效果。
+ [新增] Agent 新增画布、工作台、提示词库和素材等站点级工具。
+ [新增] Agent 面板改为全站常驻右侧栏，开关时同步推动顶栏和页面内容。
+ [新增] Agent 新增 `site_navigate` 工具，支持页面跳转。
+ [新增] Agent 对话运行中支持一键停止，中断当前 Codex turn。
+ [新增] 画布节点支持统一维护名称字段，默认显示在节点上方，并可直接双击名称编辑。
+ [新增] 画布新增组节点，支持节点拖入/拆出分组、拖拽高亮吸附和移动组时带动子节点。
+ [新增] 画布空白区域支持双击打开节点选择菜单，并在点击位置创建节点。
+ [调整] Codex 会话改为站点级连续线程，跨页面和跨画布保持同一上下文。
+ [调整] 移除仅前端调用 OpenAI responses 接口，统一走 MCP + 本地 Codex 链路。
+ [调整] 画布节点顶部工具条改为点击选中节点后显示，避免鼠标经过节点时频繁弹出。
+ [优化] 本地 Agent 连接说明明确区分插件 / 手动 MCP 才会增加 Codex token 消耗。
+ [优化] 优化本地 Agent 连接说明，区分 Codex 插件启动和直接运行 Agent 两种方式。
+ [修复] 修复 Gemini 格式生图时因内置比例列表触发误报导致生成失败的问题。

## v0.6.0 - 2026-07-09

+ [新增] 新增Codex App插件支持。
+ [新增] 配置与用户偏好新增独立页面和 Codex 连接配置 Tab。
+ [新增] 新增GitHub Pages 前端静态站点发布 workflow。
+ [新增] 图片切图支持等分线直接拖拽调整，并可新增、删除和重置横向 / 纵向切图线。
+ [调整] Docker 运行镜像改为 nginx 静态托管。
+ [调整] 移除网站Agent模式，专注于连接Codex Agent操作画布
+ [修复] 修复生图工作台重试成功结果刷新后丢失的问题。
+ [修复] 修复 Gemini 调用格式生图未传递尺寸比例配置的问题。
+ [修复] 修复前端 TypeScript 构建报错。
+ [修复] 修复画布生成配置切换文本/视频/音频模式时模型仍显示为生图模型的问题。
+ [修复] 兼容中转站视频任务直接返回视频 URL 且没有 `/content` 接口的情况，并优化失败原因展示。

## v0.5.0 - 2026-07-05

+ [新增] 渠道兼容Gemini格式。
+ [调整] 前端从 Next.js 迁移到 Vite，项目改为静态前端构建。
+ [调整] 移除已 404 的 EvoLinkAI 提示词来源。

## v0.4.0 - 2026-06-16

+ [新增] 新增网页版Agent Loop模式。
+ [新增] 支持Vercel一键部署。
+ [调整] 移除后端，项目定位为个人画布工具。

## v0.3.0 - 2026-06-15

+ [新增] 新增canvas-agent通过codex操作画布。

## v0.2.5 - 2026-06-08

+ [新增] 新增图片切图功能。
+ [新增] 支持webdav同步数据。
+ [修复] 修复画布文字节点错误问题。

## v0.2.4 - 2026-06-04

+ [新增] 新增图片反推提示词功能。

## v0.2.3 - 2026-06-04

+ [新增] 新增图片蒙版局部修改功能。
+ [优化] 优化配置节点@图片功能。

## v0.2.2 - 2026-06-04

+ [新增] 新增图片放大工具。
+ [优化] 优化图片工具条，增加自定义功能。
+ [修复] 修复端口冲突问题、pg/mysql未初始化问题。

## v0.2.1 - 2026-06-03

+ [新增] 新增文档站点页面。
+ [优化] 优化画布连线交互。
+ [优化] 优化模型选择用户偏好。

## v0.2.0 - 2026-06-01

+ [新增] 支持通过火山方舟AgentPlan接入。
+ [新增] 视频生成支持声音、水印及图片/视频/音频参考输入。
+ [新增] 画布新增音频节点。
+ [优化] 图片/视频素材支持 `图片1`编号注入提示词。

## v0.1.1 - 2026-05-30

+ [新增] 支持New API跳转并自动填入Base URL和API Key配置。

## v0.1.0 - 2026-05-26

+ [优化] 优化我的画布、我的素材导出功能
+ [修复] 修复画布撤销，配置节点等bug问题

## v0.0.9 - 2026-05-26

+ [新增] 新增视频创作台页面。
+ [修复] 修复图片节点size参数传递问题。

## v0.0.8 - 2026-05-24

+ [新增] 新增用户账号与算力点体系，支持账号密码注册登录、Linux.do OAuth。
+ [新增] 管理后台公开配置支持设置模型算力点、支持计费查询。
+ [新增] 画布右上角展示用户算力点余额，生成按钮会展示本次预计消耗算力点。
+ [新增] 新增视频生成节点。

## v0.0.7 - 2026-05-23

+ [新增] 管理后台提示词管理支持多选批量删除。
+ [新增] 新增定义拉取GitHub提示词源功能。
+ [新增] 新增awesome-gpt-image2-prompts提示词来源。
+ [优化] 优化模型下拉选择样式、优化生图编辑设置

## v0.0.6 - 2026-05-22

+ [新增] 管理后台支持配置模型渠道，前端当前无需鉴权即可直接使用后端渠道能力。
+ [优化] 统一整理后端错误提示、AI 代理、图片节点生成与重试、参考图缺失处理等细节。
+ [优化] 后端模型代理路径调整为 OpenAI 风格。

## v0.0.5 - 2026-05-20

+ [新增] 右上角版本号支持点击查看版本更新弹窗，展示当前版本、最新版本和按时间线整理的更新日志。
+ [新增] 设置弹窗支持配置系统提示词，AI 生图、编辑图和文本请求会自动携带。

## v0.0.4 - 2026-05-20

+ [调整] Docker 运行入口改为 Next.js 对外提供页面，`/api/*` 由 Next.js 代理到内部 Go 服务。
+ [修复] 文本复制在局域网 IP 访问时可能失败的问题。

## v0.0.3 - 2026-05-19

+ [修复] 更新 nanoid 依赖并修改 ID 生成方式，防止其他ip无法使用crypto模块导致的ID生成失败问题。

## v0.0.2 - 2026-05-19

+ [新增] 增加生图工作台功能，支持文生图、图生图、查看历史记录，并增加移动端适配。
+ [修复] 画布生成尺寸控件支持选择更多常用比例，并可直接输入自定义比例。
+ [修复] 生成配置节点恢复拖拽操作，避免面板控件拦截整块节点拖动。
+ [文档] 增加 Render 部署说明。

## v0.0.1 - 2026-05-19

+ [新增] 首次开源版本，包含无限画布能力：多画布项目、节点拖拽缩放、连线、小地图、撤销重做、导入导出。
+ [新增] AI 创作能力：支持 OpenAI 兼容接口的文生图、图生图、参考图编辑和文本问答。
+ [新增] 画布助手能力：支持围绕选中节点和上游节点对话、生图，并把结果插回画布。
+ [新增] 提示词库能力：抓取多个 GitHub 开源项目，按案例整理数百个图片提示词。
