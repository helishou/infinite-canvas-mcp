# H3 生产操作边界

触发：在真实画布上制作、补段、返修、调整时间线或参考。工程源码任务不因此加载全部生产流程。生产阶段与模板按[生产 SOP](../skills/canvas-video-production-sop/SKILL.md)路由，只读取当前阶段与确实缺失的直接上游。

## 先定位真实目标

- 操作前按 projectId + nodeId + segmentId 分别核对活动时间线、任务历史与归档媒体；用户说“Clip N”时确认稳定 ID、前后相邻 Clip 与剧情镜号，不能按序号猜缺段。
- 历史里有视频不代表活动 Clip 已绑定，活动 Clip 缺失不代表历史媒体删除。按事实说明是哪一层缺失。
- 不以标题、视口不可见或没有连线认定资产无效。修改前保存目标 ID 与必要的原状态，使用画布 MCP/受支持命令，不直写 SQLite 或绕开画布提交 ComfyUI。

## 时间线与内容

- 修改优先复用原 segmentId；新增按剧情插在指定相邻 Clip 之间并读回索引，不默认追加末尾。
- 删除/替换前逐项核对稳定 ID、标题、剧情镜号、活动结果与历史任务。不能确认是本次新建的重复片段时，停止该删除动作，继续完成不依赖删除的工作。
- 已确认的剧本、逐字对白、镜头表、关键帧硬锚点与前后状态是返修依据，不能用新写一版替代丢失原文；先查原记录与制作文档。
- 用户只要求借鉴某 Clip 的提示词写法时，仅参考文字结构、动作组织、对白节奏和声景；不复制其剧情，不创建同内容 Clip，也不绑定其视频/音频或引用对应 Video/Audio 标签，除非用户明确要求复用媒体。

## 验收与继续

每次补段/返修同时核对：关键帧绑定顺序和硬锚点、提示词与对白相符、前后剧情连续、Clip 顺序、taskId/storageKey 可追溯、活动结果真实绑定。

输入改过而视频没重生成时，只能说输入已更新；旧视频仍属于旧输入。任务成功、视觉自检和用户验收是不同状态。删除活动片段不等于删除历史，恢复时不能伪称已重新绑定。

用户限定只检查、写提示词、单张试跑、逐项确认或指定片段范围时遵守边界。已有连续制作授权按 SOP 在范围内推进，不重问已确认事项；等待异常先查原 taskId，不能盲目重复付费提交。

## 共享资产引用纪律

共享资产（人物/场景/道具）进入本集画布只有一个合法载体：生产实体引用节点（`production-entity-*`，`metadata.sharedAssetReference` 指向源画布节点，`writeThrough: true`）。绑定主体图片时：

- 先查本集画布是否已有该源节点的引用节点；有就直接用，没有就跑 production sync 生成。**不要用 `canvas_import_local_images` 把共享资产的图导进来复用。**
- 导入图片节点只用于此前不存在任何资产记录的新素材。共享画布/资产库里的图一律走引用。
- `h3_bind_existing_character_groups` / 参考绑定接口只认本画布节点。现在传共享画布节点 id 会自动按 `sharedAssetReference.sourceNodeId` / `sharedAssetOrigin.sourceNodeId` 反查本集引用节点，并把连接建在引用节点上；只有查不到时才报错（提示先跑 production sync）。**任何情况下都不要复制媒体。**
- 绑定前后各读一次 `h3_get_clip_references`，比对 `referenceCount` 与 `storageKey`；数字或媒体不对就停手，不进入生成。
- 同一主体多条图片绑定只允许靠 `provides` 区分用途（身份/服装/尾部）。共享来源绑定 + 本地副本绑定且用途重叠，视为错误状态，先清理再继续。
- 收工或接手前跑一次 `production_diagnose_bindings`，看 `integrity.errorCount`：0 才算干净。它查三条不变量——`SHARED_ASSET_COPIED_LOCALLY`（画布上出现与共享资产同图的无引用副本节点）、`SUBJECT_PICTURE_DUPLICATED`（同主体两条绑定同图且用途重叠）、`DUPLICATE_REFERENCE_MEDIA`（同一 Clip 同一张图占两个 Picture 槽位；跨主体共用降级为 warning）。

### 并发编辑（多会话改同一份稿）

- 看到 Clip 刷新状态是 `queued` 且带 `CLIP_REFRESH_RETRY_SCHEDULED`，表示「异步校验期间被别的编辑改写」，系统已自动退避重排（最多 3 次，400/1200/2500ms），**不要手动重提**，按原 operationId 继续查即可。
- 只有 `failed` / `blocked` 才是要人处理的终态；`failed` + `SOURCE_CHANGED_DURING_VALIDATION` 在重排用尽后仍会出现，这时说明冲突持续存在——先停掉另一个写入方，再按原 operationId 重新触发刷新。
- 重排会换一个编译器 id（`<compileId>:rN`）重新排队，**刷新任务本身的 operationId 不变**，客户端查询身份不受影响。

