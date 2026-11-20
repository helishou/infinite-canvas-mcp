# 影策 vs 本地新制作台（drama-studio）完整差距与补全方案

> 基于两岸源码逐行核对，非推测。影策=`E:/影策本地版/app`，本地=`E:/无限画布/Infinite-Canvas-MCP`。
> 目标：从小说原文按影策正确顺序走到成片。核心诉求：**顺序必须与影策一致，不跳阶段。**

---

## 0. 影策的阶段机（标尺）

`models_drama.go:23-30` + `drama_actions.go:164`：

```
queued(0) → script(1) → prompts(2) → review(3) → video(4) → render(5) → done(6)
```

单集文案（`models_drama.go:21`）：剧本 → 撰写各剧情段完整视频提示词 →（确认）→ 按段顺序生成视频 → 合成成片。

Job 类型（`models_drama.go:51-61`）：bible / plan / cast_image / cast_extract / script / render / segment_prompt / segment_video。

---

## 1. 逐阶段对照总表

| 影策阶段 | 影策真实行为（证据） | 本地现状 | 判定 |
|---|---|---|---|
| 新建 | `/projects/new` 两阶段整页：选来源→解析正文→选章+设置→createDrama | `studio-create.tsx` 全抄阶段一 + 复用向导阶段二，落 `/drama-studio/new` | ✅ 已对齐 |
| 建集 | 选章 produce / 添加集 | 「按原文批量建集」`batchCreateEpisodes` + 章节 picker | ✅ 已对齐 |
| **script 剧本** | **一次 LLM 直出 3 段 JSON**：shots(含角色/场景/道具引用+台词+动作+景别+运镜+时长) + cast(新设定 appearance/voice) + episode(synopsis/hook/cliffhanger)。`submitScript:1760-1789` → `ScriptPrompt prompts.go:290-335` → `ParseScript/ParseScriptCast/ParseScriptEpisode:1092-1111` → `applyScriptShots:1139-1279` 即时建档 | 改编 `proposeEpisodeScript:129-168` prompt 明确「不要写镜头/对白」，只出「场N｜...」纯文本，`adaptEpisode:503-510` 只写 synopsis；镜头靠第二次「拆镜」LLM（`AdaptStoryboardPanel`） | ⚠️ 两步达成但**无角色抽取/建档** |
| **资产建档+参考图** | script 阶段即时建档角色/场景/道具（`:1181-1193` resolve），`cast_extract` 独立 LLM 补外貌（`drama_late_assets.go:41-74`），排队生图（`submitCastImage:1791`），锁定，随段视频请求发送（`prepareDramaSegment:119-301`） | 拆镜后资产库 `角色0/道具0/场景1`；`initialize_director_from_demand:4916-4957` 只建 scene；`deriveStageFromProduction:132` 见 segments 直接判 video，**界面层跳过资产** | ❌ **核心缺口** |
| **prompts 段提示词** | 每段一次 LLM 写完整视频提示词（`submitSegmentPrompt:1442-1504`），带参考图说明 header + 字符预算 `segmentPromptBudget:1514-1532` + 自动精简（最多2次），全段 ready→review | 无此阶段。`composeSegmentPrompt`（`director-pack.ts:93-105`）是机械拼稿非 LLM；studio 全目录无「让模型撰写/改写提示词」编辑器 | ❌ **核心缺口** |
| **review 放行** | `mediaHeld:622` / `needsReview:635` 门控；用户「确认，生成视频」→ `approve` 写 approved/stage=video（跨集 sample 闸门）；放行前不生成 | 「确认，生成视频」「生成本集视频」按钮 `onClick={onOpenCanvas}` **只开画布**；`reviewMode/mediaMode` 仅 localStorage，明确「不写回后端」 | ⚠️ **假按钮+假设置** |
| **video 按段生成** | 服务端队列：尾帧硬首帧 `image_to_video`（第2段起取上段尾帧，`prepareDramaSegment:141-152`），参考图/音频随请求，回写按实测时长校准，尾帧后台抽取 | 画布 H3 驱动：`POST /canvas/generation h3-run` 真出片（我已实测产出 mp4）；尾帧续接有但是**软参考** role=motion_reference（非硬首帧），由 H3 runner 顺序等待 | ✅ 出片可用 / ⚠️ 尾帧语义不等价 |
| **render 合成** | `buildDramaTimeline` → 服务端 timeline render → 写 `final_resource_id` + CAS + `final_stale` 失效 | `runVideoConcatTask` 前端拼接 → `saveAs` 下载真 mp4（已实测 5.875s h264+aac）；但**无 finalResourceId 落库、无 final_stale、无字幕轨** | ⚠️ 真 mp4 / ❌ 无持久化 |
| 下载 | `downloadResource(finalResourceId)` 独立成片下载 | 仅「下载当前片段」window.open 单段；成片只在合成瞬间 saveAs | ⚠️ 部分 |

---

## 2. 根因定位（为什么会跳阶段）

1. **`use-studio-data.ts:132`**：`if (segmentCount > 0 ...) stage = "video"` —— 有段落就判视频阶段，**完全不看 assets / prompts / review**。这是界面层"跳过资产直奔成片"的真根因。`StudioStage` 枚举本就有 `draft/script/assets/shots/video`（`stage-contract.ts:14`），只是派生逻辑错了。
2. **`initialize_director_from_demand:4916-4957`**：只从 `【场景：X】` 建 scene_registry，不建 character_registry / asset_plan / asset_cards。
3. **`proposeEpisodeScript:129-135`**：prompt 明确「不要写对白和镜头」，无法产出角色外观→无法建档→资产库空→视频无参考图。
4. **拆镜草案 `DraftShot`（`adapt-storyboard.ts:17-26`）**：只有 title/visual/camera/seconds/dialogue/speaker，**没有 characters/props/appearance**，也无结构化外貌。
5. **`assetExtractModel` / `textSkills.extract`（`studio-settings-tab.tsx:320`）**：UI 有"提取设定"模型槽，但 `backend/src` 全仓无消费方——**死配置**。

---

## 3. 补全方案（按影策顺序，分优先级）

### 原则
- **不照搬影策服务端编排**（start/release/worker/跨集 approve）。本地是画布 H3 节点驱动，这是架构差异，强行改成服务端 worker 工作量巨大且违背本地设计。
- 但**阶段语义、资产先行、提示词撰写、放行门、成片落库**这些必须对齐——这是"顺序一致"的本质。
- 全部复用现成 op/API，后端尽量零改动。

### P0 — 资产阶段（最高优先，当前最大缺口）

目标：拆镜后自动建档角色/场景/道具 → 生成参考图 → 锁定 → H3 生成带参考图。

1. **设定提取**（对应影策 cast_extract）：新增纯函数 `canvas-agent/src/drama/asset-extract.ts` 的 `buildAssetExtractPrompt` + 解析，输入本集 synopsis + 草案 speaker/scene，用 `startCanvasGeneration(mode:text)` 发一次 LLM（与拆镜同款），产 `{characters:[{name,appearance,voice}],props:[{name,appearance}],scenes:[{name,appearance}]}`。注入死配置 `assetExtractModel` / `extract` 技能。
2. **建档**：映射为 `createManualDirectorAsset`（`manual-director-assets.ts:23-92`）的 ops，一次 `editEpisodeProduction(ep, revision, ops)` 写入 asset_plan/card/registry。注意：`create_manual_director_asset` 会把 artifacts 标 stale、清 executionAuthorized，**天然强制"资产后必须重新编译发布"**——正好对的顺序。插入时机在 `writeDraft` 内「初始化后、写镜头前」，或独立入口先 init 再追加，避免 `DIRECTOR_ALREADY_INITIALIZED`（:4944）。
3. **参考图**：新建条目自动进 `studio-cast-panel.entries`，用户点「生成参考图」→ `handleGenerate:324-349` → 画布 → 采用锁定；可加「生成全部参考图」批量按钮。
4. **修 stage 派生**：`use-studio-data.ts:132` 改为「segments>0 **且** 资产阶段完成（registry 非空 + 参考图 ready/approved）才判 video」，否则停 assets/shots。这是顺序一致的界面真值来源。

### P1 — prompts 阶段（段视频提示词撰写）

1. 把影策 `segment_writer.go` 的模板 + `segmentPromptBudget` + `CleanWrittenPrompt` 移植为 canvas-agent 纯函数；按 `director.source` shots/segments 为每段写完整提示词，写回 `artifacts(kind=h3).prompt` 与 `segments[].prompt`；加 `prompt_status/override` 字段。
2. 参考图说明 header 扣字符预算（本地已有 `<Picture N>` 绑定可对接 `clip-inputs.ts`）。
3. 在 drama-studio 内做段提示词编辑弹窗（复用 H3 mention textarea 模式），支持「让模型撰写/重新撰写」。

### P2 — review 放行门（去掉假按钮）

1. 三选一：(a) 把「确认，生成视频」做成真状态——episode 级 `approved`/`media_released` 落 `director.source`，点击先写放行再开画布；(b) 至少改名「在画布生成」并去掉「等待你的确认」文案，不再伪装审阅。
2. 加生成前 gate：本段引用资产未生成/未锁定 → 拦截提示先到资产页（对应 `drama_segment_video.go:67-72`）。
3. `reviewMode/mediaMode` 要么接真门控，要么保留「仅本地偏好」明确标注（现已标，保持诚实）。

### P3 — video/render 增强

1. 尾帧续接：本地已有软参考版，若要影策等价需把尾帧做成真正首帧/首尾帧键帧（H3 侧改），优先级低。
2. 成片落库：加剧集级 `finalResourceId/final_stale`（新字段或写 director.source），`onCompose` 成功后回写 storageKey；`FinalPanel` 文案改为真实成片状态（现有「已发布 vX·成片已合成」误导——publishedVersion 是草稿发布版本，与合成视频无关，`studio-detail-panel.tsx:726-730`）。
3. 「下载成片」用落库的 finalResourceId，而非 window.open 单段。

---

## 4. 涉及文件清单

| 文件 | 改动 |
|---|---|
| `web/src/pages/drama-studio/use-studio-data.ts` | 修 stage 派生（:132）+ 新增 extractEpisodeAssets / 放行状态 |
| `web/src/pages/drama-studio/index.tsx` | 资产阶段入口、拆镜回调接建档、放行按钮接真状态 |
| `web/src/pages/drama/adapt-storyboard-panel.tsx` | writeDraft 内插入资产 ops（初始化后、写镜头前）|
| `canvas-agent/src/drama/asset-extract.ts`（新） | 设定提取 prompt + 解析纯函数 |
| `canvas-agent/src/drama/segment-writer.ts`（新，P1） | 段提示词模板 + 预算 + 清洗 |
| `web/src/pages/drama-studio/studio-cast-panel.tsx` | 批量建档/生成参考图 |
| `web/src/pages/drama-studio/studio-detail-panel.tsx` | 生成 gate + 成片状态文案 + 段提示词编辑器 |
| 后端 | P0/P1 零改动（复用 create_manual_director_asset + startCanvasGeneration）；P3 成片落库若用 director.source 也零改动 |

---

## 5. 顺序验收标准（补全后按此走）

```
小说原文 → 新建剧目 → 批量建集
  → 改编(分场文本) → 拆镜(结构化镜头)
  → 【资产：自动建档角色/场景/道具 → 生成参考图 → 锁定】 ← 当前缺，P0
  → 【prompts：每段视频提示词撰写+参考图说明】 ← 当前缺，P1
  → 【review：审阅+放行】 ← 当前假按钮，P2
  → video：H3 按段生成（带参考图、尾帧续接）
  → render：合成 mp4 + 落库 finalResourceId
  → 下载成片
```

每一步界面阶段游标与影策 StagePips 对应；未过前置阶段不允许进下一阶段。


## 七、三个编辑页落地方案（子代理完整清点 2026-11-18）

用户追问「剧目编辑、分镜编辑页、资产编辑呢」后，逐页对照影策源码 + 本地现状的结论（已交叉核对，非照搬过期清单）：

### 分镜编辑页（价值高，已落地 focus 版）
- 影策形态：`segment-dialog.tsx:120` 纯 AppModal，宽 1360px，从 `?tab=board&segment=N&shot=id` 开（无独立路由）。含 SegmentToolbar（模型/时长/画幅/撰写/复制/生成）、ReferenceBoard、SegmentPrompt、SegmentReceipt（生成依据回执）、ShotCard 列表、右侧视频 + TakeList 版本。
- 影策真值：提示词 `drama_segments.video_prompt/video_prompt_override/prompt_status`；镜头 `drama_shots(speaker,dialogue,action,shot_size,camera,transition,...)`；参考图/音色 `drama_segments.reference_cast_ids_json/reference_images_json/audio_cast_ids_json`；版本 `drama_takes(kind=video|cast|final)`。落库 API：PATCH /shots/:id、POST /segments/prompts、PATCH /segments/:index({videoPromptOverride})、POST /segments/generate、take adopt/restore。
- 本地已落地：段编辑弹窗 `data-studio-segment-editor`（studio-detail-panel.tsx），点段卡「编辑段落」开，含段导航/提示词编辑/重新撰写/复制/镜头列表/参考图缩略图/保存提示词/按集核查/画布精修。数据全来自 boardData().cards 真字段。
- 提示词写回：抽 `saveSegmentPrompt(ep,seg,text)`（use-studio-data.ts）复用画布 H3 clip.prompt 写回链路；视频真读 clip.prompt 不是 artifact.prompt。实机验证 revision 递增 + 内容变化 + 测试标记清除。
- 后续可做（排后）：①提示词「保存改写/恢复模型版」+ override 存 `segments[].prompt_override`（对应 video_prompt_override）；②镜头表单扩 speaker/dialogue/camera/transition（现 patchShot 只支持字段子集）；③段级参考/音色 op `set_segment_references`（扩 patch_director_source 白名单）；④段视频 take 列表 adopt/restore；⑤生成依据回执纯前端从 clip-inputs.ts `<Picture N>` 算，零后端。

### 剧目编辑（工作量中，价值中低，暂缓）
- 影策：草稿真值 `drama_productions.draft_json`（GET/PUT /dramas/:id/draft），「编辑草稿」=同一个 /projects/new 页 + ?draft=id，「换素材」=前端 reset 不写库，删除 = DELETE /dramas/:id + 危险确认弹窗（「小说原文、剧本、分镜与成片记录都会删除。此操作无法撤销。」）。作品列表卡更多菜单：有草稿→编辑草稿，否则→打开制作台，+删除作品。
- 本地：草稿在 IndexedDB `drama_new_draft`（localforage），无 status=draft 作品级草稿、无作品列表页（剧目用 <select> 切换）；删除已等价（manage-panel.tsx modal.confirm + deleteDramaProject），不要重做。
- 若要补：复用 production.draft JSON 承载草稿 plan，drama-production-routes 加 draft GET/PUT（仅未开工允许替换、复用 revision CAS），studio-create 加「保存为草稿」+ `?draft=id` 回填，剧目卡更多菜单加编辑草稿/打开制作台。最小方案可只做前端 + localforage。

### 资产编辑（多数已有，仅入口串联）
- C1 形象图从素材库选择：本地角色本体形象图缺此入口（声线样本有），真值 subject_registry.pictureBindings。可复用 studio-looks-panel 的 pickLibraryImage + 现有画布采用 op。工作量小、价值中。
- C2 造型：studio-looks-panel 已等价（画布节点 metadata.characterImages[] 真值，改名/换图/删除/素材库/自定义图/放大/restyle 齐全），禁止再建造型表。只需确认在「项目资产/角色」子页可达。
- C3 段参考图 Drawer + 音色开关/恢复/保存：依赖段级字段（见分镜③④）；素材库/上传组件已有，不重造。
- C4 按集核查入口：本地 studio-assets-tab audit 子视图已等价；本轮已在段编辑弹窗加「按集核查 →」，给 StudioAssetsTab 加 initialSub prop，点按钮直达 audit 子页（实机验证 bg-accent 激活）。


## 八、作品列表复用 + 分镜①②⑤ 落地（2026-11-18 第二轮）

**作品列表页（用户定：不新建，复用老项目页）**
- `/projects` 页内嵌的 DramaPage 加 `openInStudio` prop：卡片「进入剧目」直达 `/drama-studio?dramaId=...`（原来是老版 `/production`）。改在 `setActiveView`，新建流程（174-177 planning URL）不动。
- drama-studio 面包屑「影策」改为跳 `/projects`（返回剧目列表），形成双向。删除剧目沿用 manage-panel 已有 confirm，不重做。
- 实机验证：/projects 点「妖虎奇缘」卡片→/drama-studio?dramaId=...；点面包屑→/projects。

**分镜编辑①②⑤（段编辑弹窗增强）**
- ①「恢复模型版」：影策 video_prompt_override 语义——把 artifact.prompt（模型原版）写回画布 H3 clip.prompt，清掉手动改写。按钮 `data-studio-seg-restore` + handleRestorePrompt。实机验证：写测试值→点恢复→画布 prompt 回原版 2480 字、标记清除、revision 递增。
- ⑤「生成依据回执」（SegmentReceipt）：纯前端从提示词正则提取 `<Picture N>` 引用 + 参考图数量，显示「随请求发送 N 张；提示词引用 picture 1/2/3；第2段起尾帧接续」。零后端。`data-studio-seg-receipt`。
- ②「镜头字段扩 speaker/dialogue/transition」**暂缓**：查实台词/说话人真值在 `source.utterances`（ShotEditor 的 lines 来自 utterances），而 `directorPatchFields` 没有 utterance 实体、shot 白名单也没有 transition 字段。硬写 shot.dialogues 会与 utterances 真值不一致（造字段），需先加后端 utterance patch op——属于另一层面，不做假对齐。

tsc 31 基线、target 零错误。


---

## 九、遗留专项 TODO — B2 精修三入口（3D 导演台 / 动画时间轴）（2026-11-20）

**状态：未做，需单独立项。不是"补缺口"，是新建一整套前端子系统。**

- 影策真值：`web/src/components/canvas/previs/*`（viewport / gesture-transaction / actor-thumbnails / save-coordinator / diagnostics / clay-materials 等）、`lib/canvas/previs/*`（modes / view-modes / shortcuts / motion-library / mannequin / placement / motion / save / save-wiring）、`stores/canvas/use-previs-workbench-store.ts`、`types/previs.ts`。`segment-dialog.tsx:150-152` 的精修下拉三模式：`previs`（3D 导演台）/ `timeline`（动画时间轴）/ `canvas`（自由画布）。
- 模型：PrevisScene = 场景对象 + 骨骼/人偶 + 摄影机 + 关键帧轨道 + 动作片段 + 播放头插值；独立 store、独立保存协调器与诊断记录。
- 本地现状：`web/src`、`backend/src`、`canvas-agent/src` 全无 previs 场景/时间轴模型。只有泛化的「精修画布 / 在画布中精修」→ `openCanvas(projectId, segmentId)` 且不带 mode；`camera-library` 里的 `previsId` 只是 acheng 技能 001–132 检索号（非 3D 场景）；`video-reprocess` 是视频后处理重跑，非精修入口。
- 为什么不做（用户铁律）：硬补只能造空壳死按钮，没有真实 3D 数据模型与引擎支撑 =「造数据 / 近似效果」。不违反「真值源可得才补」。
- 立项范围（将来做时）：①新增 previs 场景数据模型（对象/关键帧/轨道/相机 + 序列化）；②3D viewport（放置/手势/材质/播放头插值）；③时间轴序列器；④保存协调器 + 与段视频生成的真值绑定；⑤精修三模式入口接 `segment-dialog` 等价位置。工作量：产品级（数十模块），需专项排期与验收。
- 注：本轮（2026-11-20）已补齐清单其余全部项：C 类 6 项后端业务门禁、A 类（新补 A1/A2/A6/A7，A3/A4/A5/A8/A9 经核对已存在）、B1/B3/B4/B5。B2 是唯一遗留。
