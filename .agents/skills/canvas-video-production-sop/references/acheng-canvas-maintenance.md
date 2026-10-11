# Acheng 维护与离线工具

触发：明确需要更新、激活、回滚运行包，维护导演源码或导入离线产物。普通制作只按[适配核心](acheng-canvas-adapter.md)解析当前版本。

## 源码与运行包

导演 Skill 的源码位于项目 Git 子模块 `.agents/skills/acheng-director`，`origin` 指向 [helishou/acheng-director-skill](https://github.com/helishou/acheng-director-skill)，跟踪 `main`。新克隆使用 `--recurse-submodules`，已有克隆使用 `git submodule update --init -- .agents/skills/acheng-director` 初始化。源码可直接修改并在子模块内提交、推送到 fork；父仓库只记录子模块提交指针，不代替子模块的提交或推送。

项目命令 `npm run acheng:status` 查看源码 HEAD、未提交文件和活动运行包。`npm run acheng:update -- --local --check` 验证子模块当前已提交 HEAD；去掉 `--check` 后激活该版本。`npm run acheng:update` 验证远端 `origin/main`，成功后仅快进源码并激活运行包；存在未提交改动、领先或分叉的本地提交时拒绝覆盖，使用本地构建或自行处理分支。`--check` 不改变源码 HEAD 或活动运行包，但可获取 Git 对象和创建候选运行包。旧 `acheng:vendor` 命令等同于从当前 HEAD 本地构建，不再覆盖源码。`npm run acheng:rollback` 仅回退当前激活运行包，不切换源码分支、不丢弃修改。所有命令均不启动媒体生成。

Canvas 兼容层仅应用于候选运行包，不写回源码。Docker 镜像通过显式 `ACHENG_SOURCE` 使用持久卷中的可写 Git 克隆，其他校验与运行包行为一致；不因开发子模块缺失而退回隐藏源码副本。

修改导演源码后先在子模块内提交，再使用 `npm run acheng:update -- --local --check` 验证该 HEAD，使用 `npm run acheng:update -- --local` 激活。仅重建 Canvas 兼容层时沿用当前源码 HEAD；旧不可变运行包保留用于历史追溯，不锁定制作对象。此操作不改制作稿、不提交生成。

## 离线导出与检查

用 `node scripts/acheng/export-canvas.mjs production.json canvas-mapping.json <新输出目录>` 调用本机当前激活的 Acheng 编译脚本，生成包含完整提示词产物与回执的 `director.json`。mapping 包含 assets、shotInputs、boundaries、modules 与按 targetId/label 索引的 references（nodeId/storageKey/role）；始终使用当前激活版本，mapping 中旧 `engine.path` 不再选择编译器。该命令只处理离线文件，不调用画布或图像/视频模型。

导出前检查源稿契约，导出目录保留 `preflight.json`；提示词长度、阻塞项与格式验收保存在产物回执诊断中。已有文件可用 `node scripts/acheng/preflight.mjs director.json edit` 检查，也可选 `publish` 或 `generate`。离线检查使用本次请求选定版本的编译/校验脚本，但不证明在线 revision、模型和媒体归属，`generationReady` 保持 false。脚本使用已构建的共享包；运行前设置真实可执行的 `ACHENG_PYTHON`，不要依赖 Windows Store 的占位命令。

离线命令也接受 `{action,request,production?}` 的正式请求文件；`production` 可传 Backend 读取到的制作记录快照。操作 schema、源稿 patch 和当前激活版本的脚本规则与 Backend 共用；需要在线对象、媒体或模型上下文的操作逐项标为 `unverified`，不能用离线快照替代在线提交检查。
