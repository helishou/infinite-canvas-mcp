# 画布插件开发

继承[根约定](../../AGENTS.md)。UI 读[画布交互约束](../../.agents/rules/canvas-ui.md)；用户编辑、参考、生成与结果读[数据契约](../../.agents/rules/canvas-contracts.md)。H3 实现任务按需使用[工程 Skill](../../.agents/skills/canvas-h3-implementation/SKILL.md)。

## SDK 与宿主边界

- 插件通过 `@infinite-canvas/plugin-sdk` 获取组件运行时、ctx、主题和宿主能力，不私接业务 Store、Backend 数据库或 ComfyUI。
- 可分发插件不要引入只在 Web 源码环境才能解析的依赖；已有宿主内置插件按其当前构建路径处理，不将特例扩散到所有插件。
- 增加 SDK 能力时同时检查 SDK 类型、Web 对应类型、宿主注入和真实调用方；不做没有调用需求的通用扩展。
- 插件不自建跨页面状态体系。组件只处理输入、布局、用户命令和展示，权威状态由 Backend ops/任务事件提供。
- 改 metadata 前分清用户编辑字段与运行字段；生成前 flush 本轮编辑，生成后不靠组件 effect 补造结果。

## H3 约束

- H3 运行提交 `ctx.ai.runCanvasGeneration`，取消走 Backend 任务入口；单段与多段具有一致的运行/取消语义。
- 参考编辑用 referenceBindings；不恢复前端 reference-sync/write-coordinator，不能以 assetId 合并不同 Clip 的语义。
- 默认参数和 layout 保存到 Backend；插件只持有内存镜像和布局本地兜底。导入导出参数不覆盖 Clip prompt/duration。
- 面板打开、刷新和 metadata 到达不应自动播放或运行，也不应清空权威失败状态；使用显式用户 trigger。
- 从 Output 恢复参数、提示词或历史输出是不同动作，不能把源 Clip 内容静默覆盖到当前 Clip；媒体恢复经 Backend 核验归属。
- UI 字段必须能追溯到共享参数契约和最终执行输入，显示默认值与实际提交保持一致。

## 构建与验证

- 改插件源码后在该插件目录 `node build.mjs`，更新可分发产物；SDK 修改同时重建受影响消费者。
- H3 既有插件分发包，也有宿主内置源码路径。Vite dev 使用 HMR；生产宿主 UI 需要 Web build，复制 `minimax-h3.js` 不能代替它。
- H3 版本唯一来源为 `canvas-agent/src/plugins/minimax-h3/version.ts`，其 build 会同步 package、lock、manifest；不手动维护互相冲突的版本。
- 布局/交互验收核对相邻区域不受串扰、缩放坐标正确、深浅主题一致；不以 bundle 构建成功代替实际界面行为。
- 多份 CSS 规则、媒体查询、容器查询先确认最终生效声明，再最小修改；不盲目把所有匹配选择器改成相同数值。
