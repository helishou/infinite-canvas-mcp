# 画布交互与性能

触发：修改画布外观、节点布局、坐标换算、视口、滚动或播放。Web 与插件共享这些约束；数值实现从当前源码取，本文件保留不变量和已明确的交互要求。

## 主题与视觉

- 使用 canvasThemes、useThemeStore、ctx.theme 或 ConfigProvider token，复用现有工具栏、节点面板与 Modal。
- 顶部工具栏/状态极简扁平：无边框、阴影或胶囊底，融入背景，仅轻微 hover。
- 普通操作按钮透明底、图标加文字，允许 `hover:bg-black/5 dark:hover:bg-white/10`。toolbar.activeBg 只用于选中状态，node.fill 不作按钮装饰。
- 非图片缩略项的文本/配置/音视频图标无额外灰底。不要硬编码黑白、stone/slate 色破坏深浅主题。
- 图片尺寸尊重原始比例，除非明确要求自由变形；批量展示和助手面板保持紧凑。

## 视口两条路径

实现入口：`web/src/lib/canvas/canvas-viewport.ts` 与画布 project 的 writeViewport/applyViewportLive/commitViewport。

- 高频拖动与滚轮只命令式写容器 transform，禁止逐帧 setViewport；applyViewportLive 不加节流/防抖。
- 仅在屏幕位移达到 VIEWPORT_CULL_SCREEN_MARGIN、缩放变化达到 VIEWPORT_CULL_ZOOM_RATIO，或实际视口逼近已挂载覆盖安全带时，用 startTransition 补裁剪。
- 松手、失焦、滚轮静止（当前 500ms）、聚焦动画、缩放控件、小地图、重置视图等低频结束点走 commitViewport，保持实时值和 React state 一致。
- 请求中的裁剪范围不算已挂载；过期 transition 不能覆盖较新的实时视口。
- 位移阈值、覆盖安全带和前瞻都按屏幕像素。当前 margin=300、padding=400、zoom ratio=0.35；padding 必须大于 margin，世界外扩为 padding/k，不能将屏幕位移误按世界单位判断。

新增任何视口入口同时接实时和提交路径。验证快速平移、缩小至 5%、连续缩放、松手/失焦、缩放锚点以及裁剪边缘无白洞；性能比较记录当前环境与场景，不复制历史 FPS 作为通过标准。

## H3 分区与控件

| 操作 | 允许变化 | 必须保持 |
|---|---|---|
| 拖 Output / VideoRefs 分界线 | Output、VideoRefs | preview 高度 |
| 拖 VideoRefs / preview 分界线 | VideoRefs、preview | Output 高度 |
| 超出可分配空间后拖回 | 节点自动长高/缩回 | 不出现无关分区联动 |

拖拽以该次 pointerdown 的真实快照为基线，核对连续多次拖动；不要把“单次尚可”当成允许累计误差。布局常量与求解在当前 H3 布局实现读取，不在各组件维护互相漂移的副本。

H3 Select 用 antd `size="middle"`；调整收起后的值用 styles.content/item/itemContent 或 labelRender。字号、行高配套，实际检查裁切；只改外层 selector 或下拉项不算完成。沿用 showSearch/allowClear 的现有语义，默认值、清空值与提交值一致。

## 滚动、命中与缩放

- H3Timeline 横向滚动条和 canvas-collaborative-text 的 promptLineMapExtension 竖向滚动条隐藏原生滚动条；轨道与滑块在同一容器，以事件冒泡统一分流。
- 点击轨道立即将滑块中心对齐指针，并能继续拖动；不加跳位动画，不叠加吞掉命中的“跳 Clip/区块”按钮或 DOM 标记。
- 屏幕坐标先除以 rect 尺寸与布局尺寸之比，再与内容坐标/滚动偏移比较；使用真实轨道宽度与时长，不写死 px/秒。
- ruler 如用 transform 平移，按实际实现取偏移；不能盲读恒为 0 的 scrollLeft。滚动、恢复位置、定位 Clip 要保持刻度、轨道和指针一致。
- ResizeObserver 不测量由自身回写尺寸直接决定的容器，防止反馈循环。CSS 修改检查媒体/容器查询下最终生效声明。

## 播放与副作用

用户主动播放、运行、seek 使用事件或本地 trigger，metadata 只记状态。StrictMode 的 effect 重跑不能让“首次跳过”ref 失效后自动触发。播放 timeupdate 与用户 seek 要有明确所有权，不能互相回写形成循环；持久运行状态的所有权见[数据契约](canvas-contracts.md)。

## 验证证据

在独立测试页检查主题、计算样式、elementFromPoint 命中、拖动前后相关分区尺寸与状态。真实指针操作优先；合成 PointerEvent 的 capture 失败不等于产品失败。产物哈希、HMR 消息、构建通过均不能代替交互验证。
