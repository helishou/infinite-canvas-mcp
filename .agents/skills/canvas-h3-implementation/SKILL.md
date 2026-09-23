---
name: canvas-h3-implementation
description: 修改无限画布 H3 插件、Backend 与 MCP 工程实现层；调通画布→ComfyUI 调用链、UI 状态、节点契约与服务生命周期。用于插件源码改动、构建验证、MCP 工具/节点契约排查，不承载短片生产阶段规则。
---

# Canvas H3 Implementation（工程实现层）

## 职责

本 Skill 是 Infinite-Canvas-MCP 工程的实现层约束，覆盖 H3 插件、Backend HTTP、MCP stdio 入口与画布 UI。生产阶段的规则（角色资产、镜头设计、Clip 视频）见同级 `canvas-video-production-sop/`；本 Skill 不重复承载那些阶段。

## 与 SOP 的边界

- **生产阶段（资产/站位/镜头/分镜/Clip）** → `canvas-video-production-sop/` 及对应 subskill
- **生产阶段所用的画布 MCP 调用约定** → 仍以 SOP 内嵌说明为准（`canvas_run_generation`、`h3_run_clip` 等）
- **本 Skill 仅承担**：插件源码改动、Backend 调用链、UI 状态、节点/任务数据契约、构建与服务生命周期

## 调用路径与验证

- 工程入口、`backend/dist/index.js mcp` vs `tsx --watch`、HMR 与 dist 加载时序：`references/development-verification.md`
- H3 → ComfyUI `/prompt`/`/history` 调用链、`NanFengH3*` 自定义节点图结构：`references/comfyui-call-chain.md`
- 画布 MCP 工具 / 节点 / 任务的字段契约、`canvasBinding`、`generation_logs` 回读：`references/mcp-tool-development.md`
- H3 面板 UI、布局、Hook/轮询/状态：`references/h3-ui-state.md`
- 活页面 DOM 与 computed style 验证：`references/live-page-verification.md`
- 工作流导入、字段配置迁移：`references/workflow-import.md`

## 工程铁律

- **画布操作必走画布 MCP**，不直连 ComfyUI 提交、不直写 SQLite，不用无 `canvasBinding` 的 `comfyui_run` 再补造画布记录。
- **先读取真实状态再改**：确认目标 project/node/clip、metadata 的实际层级和读取方、输入引用及运行日志。不得把未搜到当作不存在，不得把参数写入当作运行生效。
- **两次失败后停止盲修**：重新收集日志、DOM、运行参数或执行图，提出可检验的原因，再决定下一步。
- **保护用户服务和资产**：未经同意不自行启动、杀或重启 `concurrently` / `tsx --watch` / Vite / ComfyUI；不宽条件批量杀进程。已有 MCP 子进程不会热替换，需重载时先说明边界。
- **Hermes 接入本地 Canvas MCP 必须使用 Backend stdio 入口**：`mcp_servers.infinite-canvas` 配 `command: node`、`args: ["E:/无限画布/Infinite-Canvas-MCP/backend/dist/index.js", "mcp"]`。不要把 token 硬编码进 HTTP URL，也不要用 `canvas-agent/dist/server/mcp.js` 作为长期配置。
- **Backend Streamable HTTP MCP session 在进程内存中**：`tsx --watch` 替换 Backend worker 后旧客户端会收到 `No valid MCP session ID provided`。重连/重启实际承载聊天的 Hermes gateway；只重启 Desktop 或新建聊天不保证有效。
- **节点创建必须有布局兜底**：省略坐标时按当前节点边界和节点尺寸寻找不重叠位置，同一批操作也要逐个避让；显式坐标必须原样保留。
- **antd Select 配置**：UI 选择器使用 `Select(showSearch, allowClear)`，保持 `patchSelected` 等依赖引用稳定，输入允许清空，显示默认值与实际存储/提交值一致。
- **结构性 JSX 改动后**，立即读取受影响的父子边界并检查 `details`/`div` 成对闭合，再运行插件 typecheck、build、Web typecheck；构建成功不能替代对实际分区结构和交互的检查。

## V15 字段变化提醒

- 南风 V15 的旧字段「单人小脸修复 / 多人小脸修复 / 全局修复」仅保留序列化位置，当前 `h3_generator.py` 明确不读取、不执行；要做真实生成后修脸，必须接实际后处理节点。
- V10 Python vs MCP TypeScript 的工作流图差异已迁移完毕，原对照笔记归档到 Hermes `~/.hermes/skills/.archive/`（如需历史排查仍可查阅）。

## 工具脚本

- `scripts/vision_via_api.py` — 通过本地 chatgpt2api 读图（视觉判据绕路，主 vision 通道 502 时使用）
- `scripts/lab_bstar.py` — 量测 CIE-LAB 均值（b* 是色温漂移的量化判据，b*±1.5 / L*±3.0 视为同基准）
- `scripts/canvas-migration-smoke.mjs` — 画布迁移 smoke

## 提交与停止

- 提交或交付前先执行 `git status --short` 和 `git diff --check`，把当前 UI 改动与工作区已有的其他修改分开。
- 权限、依赖或用户服务重载阻塞时报告证据，不用绕过入口或破坏现场的办法"继续完成"。