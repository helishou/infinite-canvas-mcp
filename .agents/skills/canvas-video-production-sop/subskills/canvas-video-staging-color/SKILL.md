---
name: canvas-video-staging-color
description: 为无限画布短片建立综合色彩真值、无人空间锚、俯视站位、人物路径与 180° 轴线覆盖；用于站位与色彩基准阶段，不负责成片镜头生成。
---

# 站位与色彩基准

## 内嵌提示词规范

常规色卡、场景锚和站位图直接使用本 Skill，不要完整读取外部大规范。

- 新建站位图或参考驱动场景图使用 Neo Image 2，按“参考图标注 → 主体/空间 → PRESERVE/CONSTRAINTS → PHOTOGRAPHIC TONE → Avoid → size/quality”组织；只改已有图中的单一布局或颜色时用 Neo Nano Pro 短句，并写“其他全部保持不变”。
- 每张参考一项职责并写排除：站位参考只供位置/朝向/轴线，不供身份、材质或成片视角；角色参考只供身份和时代服装；场景参考只供空间、家具、材质与光线；提色参考只供色相、明度和饱和关系。
- 站位图采用图型 01 的核心做法：高机位斜俯或鸟瞰，按前景 → 近侧 → 远侧中景 → 最远处 → 背景逐层写 depth order，并在结尾复述；用单侧长软影帮助读取站位。它是 blocking diagram，美感服从位置、朝向、通路和轴线正确。
- 色卡采用图型 23 的核心做法：按影视功能槽位取色，不按像素面积机械聚类；用 `flat 2D vector / Figma or Adobe Illustrator / no depth / no perspective / no lighting / no photographic rendering / no paper texture` 锁定平面设计，并在 Avoid 排除纸张、桌面、景深、镜头虚化、胶片颗粒、3D、投影和实体 mockup。
- 色卡版式固定为标题/副标题、色块、每块 HEX 与功能标签三部分。HEX 真值来自文字清单，不从生成图反向采样；需要像素级准确时由 SVG/Figma/Illustrator 按 HEX 确定性绘制。
- 新建无人场景时按“空间结构 → 物件布局与材质磨损 → 光源方向与色温 → 空气环境 → 摄影质感 → 焦段与景深”组织；是否允许无参考纯文生图服从下文的项目空间锚规则，不套用外部通用规范的相反默认值。

只有需要本 Skill 未覆盖的特殊建场图型时，才在 [Neo Image 图型库](../../references/neoimage-prompt-engine-公开版.md) 中按精确标题局部查阅；不得完整读取全文。

## 色彩基准

- 色卡先于新角色、场景和分镜确定；未经批准，不进入批量生成。
- 已有获批场景图时，以这些图为色彩真值，只提取共同主色、辅色、强调色、曝光与冷暖关系，明确“只提取颜色，不复制构图、家具、人物或场景内容”。
- 有三张以上获批场景时，不再混入无关参考或纯文字想象综合色彩。用户给出精确 HEX 时逐项照用。
- 使用 Neo Image 时按图型 23；综合色卡固定为 13 色时，必须记录每个 HEX 与功能。扩散模型不能精确保色时，改用确定性 SVG/PNG，并保留场景来源连线。
- 色卡节点标明版本与来源。每个场景、站位图、无人空间锚、分镜板和关键帧 prompt 从色卡中选择适用 HEX，并把色值与功能写入正文、CONSTRAINTS 和 Avoid；不能只写“冷色”“暖色”或“低饱和”。色卡图不进入 `referenceNodeIds`。
- 场景节点承担空间与色彩真值：生成节点连接对应 `scene`，把 `colorPalette` 与 `sceneColorCardPrompt` 写入 `metadata.prompt` 和 `metadata.composerContent`；机器 ID、storage key 与内部字段不进入给模型看的提示词。

## 空间拓扑闸门

涉及屏风、门、墙、帘、柜体、廊柱等分区或遮挡时，人物入镜前完成：

1. 从获批场景图核对隔断、门窗和家具是否真实存在，不能把提示词计划当成画面事实。
2. 缺少关键结构时，先做俯视站位方案，再生成无人物空间锚。默认纯文生图，明确空间、材质、光线与 HEX，且 `referenceNodeIds` 为空；只有需要保留已批准构图/材质时才图生图。
3. 俯视图明确 `区域 A｜实体隔断｜区域 B`、摄影机、每名角色、家具、出入口、窥视缝、视线轴和可见范围；它只锁空间关系，不负责身份、材质或成片视角。
4. 记录摄影机和每名角色的物理区域、可见路径、遮挡结果与绝不能无阻挡同框的人物。
5. 空间关系严格的镜头先单镜验证，再确定性拼板；连续镜继承同一获批空间锚，只改变一个状态。

## 站位覆盖

按连续空间而不是单镜分组。人物跨区、出入门、轴线改变、隔断状态改变或互动家具改变时新建站位版本；纯道具俯拍、手部特写、单人无位移近景可继承，但必须注明继承节点和画外方位。

覆盖矩阵至少包含：

```text
空间设置 / 覆盖镜号 / 角色
区域与屏幕方位 / 朝向与视线 / 对话或行动轴
入口与出口 / 关键家具 / 摄影机候选区
站位图节点 / 色卡版本 / 确认状态
```

站位图 prompt 按“参考职责→用途与机位→空间布局→人物站位→轴线→动作连续性→色卡→约束→Avoid→输出参数”组织。用途写明 `blocking diagram / staging reference`；默认使用高机位、斜俯或鸟瞰全景，完整看见场景边界、门、墙、家具、人物全身、入口和出口，不生成成近景剧情剧照。

## 阶段内验收与完成闸门

色卡、空间锚或站位图产出后立即在本 Skill 内检查：

- 色卡核对来源场景、功能槽位、文字 HEX 真值、色相分布和平面矢量版式；精确色值以文字/SVG 为准，不从扩散图采样。
- 场景锚核对剧本依赖的门、窗、隔断、家具和通路是否真实可见，空间结构、材质、光向和时代是否正确。
- 站位图核对人物数量、物理区域、屏幕方位、朝向、视线、入口/出口、家具关系、180°轴线、遮挡和可见路径；美观不能抵消拓扑错误。
- 按覆盖矩阵逐项确认每个相关镜头都有已通过站位版本。缺项只补对应空间设置，不重做已通过设置。
- 使用 `accepted / needs-redo / waiting-user / blocked-input` 记录结果；只有 `accepted` 的色卡、场景锚和站位图可进入镜头设计。

- 色卡有版本、来源、精确功能和批准状态。
- 所有需要多人关系、移动、遮挡、门内外或家具互动的镜头都被已确认站位图覆盖。
- 场景锚、站位图、角色参考的职责互不替代。
- 空间与色彩基准的版本、节点 ID 和验收状态已写入制作目录的 `assets.md` 与 `progress.md`，尚未把站位图当成最终电影关键帧。

## 色卡制作产线（六场景 + 独立色卡）

### 适用场景

用户已确认一套场景提示词，要求把六宫格改为六张独立场景图，并为每个场景建立可复用的场景资产和色卡。

### 操作顺序

1. **先固定视觉基准**
   - 把用户认可的曝光、中间调、阴影色、材质和镜头段落原样作为 common prompt。
   - 只为每个场景替换地点、叙事状态和道具；不要叠加未经确认的"电影感"形容词或模型名。
   - 每个独立场景 prompt 必须直接可执行，不含"参考这段提示词""借鉴描述技巧"等过程说明。

2. **创建六个智能节点**
   - 每个场景使用一个 `nodeType: "config"` 且 `metadata.smart=true` 的节点。
   - 写入 `metadata.prompt` 与 `metadata.composerContent`；同时写入 `layout: "single-scene"`、`sceneCount: 1`、`count: 1`、`references: []`、`referenceNodeIds: []`、横向尺寸和 `generationTaskId`。
   - 使用稳定、场景专属的幂等键；不要把六个场景再包装成一个六宫格任务，也不要创建独立 image 结果节点。
   - 通过 `canvas_apply_ops` 批量创建，通过 `canvas_run_generation` 分别提交；立即保存每个 `directTasks[].taskId`，再以精确 task ID 调 `canvas_task_status`。

3. **验收真实媒体**
   - 六个任务都必须达到 `succeeded` 后再做色卡绑定。
   - 从任务输出/`media_files`取得真实 `storageKey`、URL、宽高、字节数和 MIME，不拼猜文件名。
   - 读回每个 config 节点，确认媒体槽已绑定且 prompt、count、references 与任务输入一致。

4. **制作色卡**
   - 优先从真实场景媒体的像素提取主色（例如缩小后量化取 5–6 个高频颜色），再按场景叙事补充少量有明确语义的强调色：雪院可补朱门/婚书朱红，偏门可补灯笼暖色，出刀书房可补刀柄银灰。
   - 色卡是确定性资产，不需要再调用图像模型；用 SVG 色块、PNG 色条或已上传图片均可。纯色块比让生图模型绘制带文字的色卡更可靠。
   - 为每个色卡同时写一段 `sceneColorCardPrompt`，说明主色、光线、材质和强调色的职责；另存 `colorPalette` 的 HEX 数组，便于下游提示词和人工核对。

5. **建立 scene 资产节点**
   - 通过 `canvas_apply_ops` 创建 `nodeType: "scene"`，不要用普通 image 节点冒充场景资产。
   - metadata 至少包含：
     ```json
     {
       "status": "success",
       "sceneAssetId": "...",
       "sceneName": "...",
       "sceneDescription": "...",
       "sceneImage": {"url": "...", "storageKey": "...", "width": 1536, "height": 1024, "bytes": 0, "mimeType": "image/png"},
       "sceneColorCard": {"url": "data:image/svg+xml;base64,...", "name": "...", "width": 1200, "height": 220, "bytes": 0, "mimeType": "image/svg+xml"},
       "sceneColorCardPrompt": "...",
       "colorPalette": ["#...", "#..."]
     }
     ```
   - `sceneImage` 必须指向真实生成媒体；`sceneColorCard` 可以是确定性的内联 SVG/已上传色卡，但要确保画布和资产 UI 能读取其 URL。
   - 从同一 MCP 会话回读所有 scene 节点，核对 scene image storage key、色卡 MIME/URL、prompt 和源场景一一对应；没有真实场景图时，不要宣称色卡资产已完成。

### 保存到资产库，再清理原始节点

- `nodeType: "scene"` 只是画布上的场景资产节点，不等于资产库中的 `kind: "scene"` 记录。用户要求"存入资产"时，先把每个 scene 节点的完整数据 upsert 到现有 `/canvas/assets` 或等价资产工具。
- 资产记录至少保留：`sceneImage`、`sceneColorCard`、`sceneColorCardPrompt`、`colorPalette`、完整 `prompt`/`composerContent`、`negativePrompt`、模型/尺寸/count/references、精确 `taskId`、媒体 `storageKey`/URL/尺寸/字节数/MIME、`sourceSceneNodeId` 和 `sceneNodeId`。
- 写入后按资产 ID逐项回读，校验 `kind: "scene"`、真实媒体 storage key、色卡 URL/MIME、taskId 和源场景关系。若剧目 ID没有在资产库注册，不要用 `dramaId` 筛选器判断资产不存在；改用精确资产 ID回读，避免合法记录被过滤掉。
- 只有 6 个资产全部回读成功且对应媒体文件存在后，才建立原始节点的精确删除白名单。通过画布 MCP 删除白名单中的原始 config 节点，不删除 scene 资产节点或其他历史/保护节点。
- 删除后必须从同一画布 MCP 会话读回精确节点 ID：白名单全部消失，6 个 scene 节点和保护节点全部仍在。禁止按标题、无连线、旧版本号或"看起来重复"模糊删除。

### 常见错误

- 用一张六宫格图切六格代替六次独立生成：这会继承网格裁切、比例和共享光线误差，除非用户明确要求切图，否则必须独立提交。
- 先生成色卡再凭想象写 HEX：色卡会脱离最终画面；应先验收真实场景媒体，再从像素和叙事强调色建立色卡。
- 只写 `sceneColorCardPrompt` 不写 `sceneColorCard`：UI 只有文字而没有可视色卡；若用户要求"做一个色卡"，应同时提供确定性的色块图。
- 把色卡连进所有生图任务：色卡是供人核对还是图像参考必须分开声明；只有用户明确要求把色卡作为图像色彩锚时，才通过参考输入连接，不要默认改变纯文生图的 `references=[]`。

色卡制作产线详见 [内嵌 § 色卡制作产线]；跨段影调对齐实测见 [references/tone-consistency-and-continuity.md](../../references/tone-consistency-and-continuity.md)。
