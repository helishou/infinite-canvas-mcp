# ComfyUI 工作流工程

触发：工作流导入/导出、字段配置、模型按输入路由、工作流页面。遵循[Backend 约定](../../../../backend/AGENTS.md)、[Web 约定](../../../../web/AGENTS.md)，涉及画布生成再读[数据契约](../../../rules/canvas-contracts.md)。

## 当前职责

| 入口 | 职责 |
|---|---|
| `backend/src/workflows/store.ts` | 图文件、内置/自定义标记、SQLite 字段配置、导入导出 |
| `backend/src/workflows/routes.ts` | `/api/workflows`、包导入导出、配置、运行与实例路由 |
| `backend/src/workflows/executor.ts` | 输入默认值、字段注入、媒体准备、提交执行 |
| `backend/src/canvas/model-workflow.ts` 与相关目录 | 渠道模型到工作流的解析 |
| `web/src/pages/workflows/` | 列表、节点图、字段编辑、运行与历史 |
| `backend/src/comfyui/instances.ts` | 当前实例配置文件读写；不要误称现有所有配置均已迁入 SQLite |

模型与字段配置的业务权威仍在 Backend。已有文件配置迁移需另有需求与保护方案，不能借整理文档或局部修复擅自迁移。

## 导入与配置往返

- 区分裸图上传与包含 graph/config 的工作流包；修改时检查 store、路由、前端 API 和导出后再导入的真实数据。
- 保留 WorkflowField.id 与节点输入映射，显示名不能取代稳定字段 ID。多节点映射、媒体字段、prompt 标记、默认值和可选字段按现有契约传递。
- 文件名是内部调用标识，title 是显示名；UI 可去 custom/ 前缀，内部请求保留原 name。
- 内置标记来自 Store 当前规则，不能只看是否在 custom/ 下决定删除权限。安装默认工作流不覆盖用户已有文件。
- 路径安全按解析后的绝对范围校验；URL 编码/解码和大小写/中文标识必须往返一致。
- 前端字段配置沿现有 SVG 节点图与内联编辑，修改保存逻辑时检查页面恢复、状态归属与滚动容器。

## 统一模型路由

1. 从实际 Backend 渠道配置读 workflows/workflowRouting，不用测试 fixture 或历史示例冒充用户配置。
2. 按本轮参考输入数解析文生/单图/多图路线；不支持的路线显式失败，不回退第一个工作流。
3. 用户选择统一模型时提交该模型名。直接 custom/*.json 是明确选择底层工作流的路径，不能静默拿它绕过统一路由。
4. 确认所选图和字段真的接收参考媒体；连了参考节点不证明 LoadImage 或其他输入使用它。
5. 从任务输入、执行图和日志核对外层模型与最终底层工作流；只有用户授权运行时才做真实生成验证。

## 媒体和参数

- 运行时由 executor 处理 data URL、HTTP 媒体、Backend /media/ 引用及合法既有文件名；Backend /media/ 不是 ComfyUI 路由。
- 不把上传图片/base64/参考列表持久化到 localStorage。临时选择可以在内存，持久媒体使用归档 storageKey 与现有服务。
- image/video/audio 输入依据当前字段类型和契约，不能把任意字符串当图片；默认值、用户值、显式空值保持区别。
- 多节点字段逐目标注入，seed 随机化和 prompt 日志提取复用现有实现，不在前端额外随机一次。
- 记录实际执行参数用于追溯；更新 UI 展示不能冒充修改底层工作流或完成重生成。

## 验证范围

- 导入导出：临时工作流包 round-trip，检查字段、媒体映射、内置保护与失败后原文件保留。
- 路由/注入：相关 model-workflow/executor 测试覆盖本次输入数量、默认/显式值与不支持分支。
- UI：字段保存后重载读取同值；图拓扑、选择浮窗、运行/历史过滤按改动验证。
- 端到端：使用授权的临时项目，验证原任务身份、最终媒体和活动绑定，不通过直接 SQLite 或全量快照覆盖补结果。
