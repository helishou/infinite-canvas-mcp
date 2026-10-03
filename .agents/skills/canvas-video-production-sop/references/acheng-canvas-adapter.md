# Acheng 与画布的执行适配

## 加载与版本

先读取本机 Codex home 下 `skill-runtimes/acheng-director/active.json`（未配置 CODEX_HOME 时为用户 `.codex`）。使用 `active.path` 下的 SKILL 与对应模块，不从下载目录、干净源码或另一份 H3 同名 Skill 混装。运行开始记录 commit、patchVersion、runtimeId、version；恢复沿用原运行版本。缺失版本或兼容检查失败时报告，不能退回旧画布制作方法。

项目命令 `npm run acheng:status` 查看状态；`npm run acheng:update -- --check` 检查候选；`npm run acheng:update` 验证后激活；`npm run acheng:rollback` 回退。更新只管理引擎，不启动生成、不修改项目。

## 创作权属

story、assets、shots、performance、effects、model、continuity 按 Acheng 原合同协作。空间设计在 assets 的 scene-design 支路，shots 消费空间事实；站位图是按需资产。多资产新制作采用 STYLE_MOTHER，新四视图采用正脸近景、正面全身、侧面全身、背面全身和空手；色卡为辅助信息，不另建强制前置阶段。旧批准资产可保留并登记适用范围，缺项只补本轮所需。

Shot 是叙事镜头，Segment 是请求，Clip 对应 Segment。按题材、对白和动作容量规划，沿已有镜头边界装箱至 4–15 秒。不得自动一镜一段、强制正反打或仅允许动作镜合并。关键帧依真实锚点需要制作。

保留 Acheng 的内容完整性、模块检查、partial/commit、风格及版本规则。Ref2VA 新正文 2200–2900 英文词；H3 引用使用 `<Picture N>/<Subject N>`，风格母图在资产参考最后槽。上游宣传文案不是生成提示词。

## 画布是执行与正式存储

Acheng 的纯提示词限制适用于创作职责；用户授权实际生成时，由本适配层通过原生 Canvas MCP 提交 Backend 任务。不得绕过画布调用 ComfyUI、直接写库或先生成后补记录。按本轮 schema 使用工具，不沿用旧字段猜测。

分集调用 `drama_get_production/drama_edit_production/drama_publish_production`；独立画布调用对应 `canvas_*_production`。通过 `set_director_production` 提交完整导演稿：schemaVersion、engine、source、sourceHash、modules、artifacts、assets、shotInputs、boundaries、workflow、unresolved、executionAuthorized。

用 `node scripts/acheng/export-canvas.mjs production.json canvas-mapping.json <新输出目录>` 执行固定引擎的真实编译并产生 director.json。mapping 包含 assets、shotInputs、boundaries、modules 与按 targetId/label 索引的 references（nodeId/storageKey/role）；首次使用当前激活版本，恢复传入原运行 engine.path。该命令只处理离线文件，不调用画布或模型。

source 原样保存 Acheng production 数据。sourceHash 是递归键排序、无空白、UTF-8 JSON 的 SHA-256；脚本使用项目导出工具，不能凭记忆拼哈希。artifacts 每项包含独立 prompt 字节、sha256、源哈希、参考标签/节点/storageKey/媒体哈希/职责及编译回执；draft 和 partial 不标 ready。接入包不填造 PASS，先执行固定运行版本的真实离线检查，再由 Backend 核对源与媒体。

Backend 已发布版本是正式源，本地 production.json 是带 revision 的工作副本。修改需稳定 operationId 和 expectedRevision；冲突回读，不覆盖他人草稿。剧本、镜头和 Clip 视图是投影，修改应进入导演源并重新编译。更新源后使旧产物过期。模型选择继承现有配置；保存草稿不生成。

assets 映射保存实际 nodeId、assetId、storageKey、sha256、version 和批准证据。每张图一项主要职责并写保留/排除范围；真实文件不存在时只能交草案。正式引用须通过真实媒体检查，不把任务成功当批准。完整资产提示词按依赖准备，H3 编译必须满足原资产门禁。

智能节点生成复用原 ID 与结果槽，保持 position/尺寸/layout；同名节点按精确 ID 操作。每次提交保存真实 taskId，超时查原任务，不重复付费提交。任务、日志、归档媒体、活动节点绑定需要对应；原结果保留。

## 连续性边界

对每一对相邻 Segment 写 from、to、tailFrame、motionContext、reason。两项独立决定，不能因同人物/同场景自动开启。

- 尾帧参考：前段开关传给下一段，从成片提取尾帧，追加在原图片最后，保留原编号；传递姿态、持物、位置与动作进度，下一段可换机位。不能把动作重置。
- Motion Context：前段开关传递 AV latent 与音频上下文；按连续组首尾提交，使用 runFromCurrent、skipCompleted=false 和 endSegmentId 限定范围。MP4 不等于可续写 latent；缺 latent 时先明确组首重渲范围。
- 不再使用 previousVideoAsReference，不自动把前段 MP4 当模型输入。用户明确提供的普通视频参考不在此禁用范围。

维持身份、服装或道具可使用专用资产。硬切与时间地点跳转按实际叙事断链；不兼容的尺寸/模型不能强行续写。

## 完成与恢复

保留 prompt-only 与授权执行的区别，自动/逐步模式沿用用户选择，不重复问。图片与关键帧需要实际查看并记录证据；待用户确认不假写 approved。Clip 默认只核对 taskId、终态、媒体可访问性与结果回写，不主动评分、试听、返修或重抽。

恢复先读取 Backend 修订、导演模块游标、固定引擎版本及原 taskId。编译就绪、已生成、已自检、用户验收分别记录。局部修改只使依赖项失效，不重做整项目；禁止以摘要替代完整对白、镜头或提示词。
