<p align="center">
  <img src="web/public/logo.svg" width="96" alt="infinite-canvas logo">
</p>

<h1 align="center">无限画布 MCP (Infinite Canvas MCP)</h1>

<p align="center">
  <a href="https://github.com/helishou/infinite-canvas-mcp"><img src="https://img.shields.io/github/stars/helishou/infinite-canvas-mcp?style=flat-square&logo=github" alt="GitHub stars"></a>
  <a href="https://github.com/helishou/infinite-canvas-mcp/tags"><img src="https://img.shields.io/github/v/tag/helishou/infinite-canvas-mcp?style=flat-square&label=version" alt="Version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-f97316?style=flat-square" alt="License"></a>
  <a href="https://vite.dev/"><img src="https://img.shields.io/badge/Vite-7-646cff?style=flat-square&logo=vite&logoColor=white" alt="Vite"></a>
  <a href="https://reactrouter.com/"><img src="https://img.shields.io/badge/React_Router-7-ca4245?style=flat-square&logo=reactrouter&logoColor=white" alt="React Router"></a>
</p>

<p align="center">
</p>

<p align="center">
<a href="docs/content/docs/overview/quick-start.zh-CN.mdx">快速开始</a> · <a href="docs/content/docs/overview/features.zh-CN.mdx">功能介绍</a> · <a href="docs/content/docs/overview/docker.zh-CN.mdx">Docker 部署</a> · <a href="docs/content/docs/canvas/canvas-node-manual.mdx">画布节点操作手册</a> · <a href="docs/content/docs/canvas/canvas-shortcuts.mdx">画布快捷键</a> · <a href="SECURITY.md">漏洞提交</a> · <a href="docs/content/docs/progress/todo.mdx">项目计划</a> · <a href="canvas-agent/README.md">本地 Canvas Agent</a> · <a href="plugins/canvas/README.md">画布插件 SDK</a> · <a href="plugins/infinite-canvas/README.md">Codex app 插件</a>
</p>

无限画布（Infinite Canvas）是一款面向 AI 影像与短片生产的开源工作台。它把无限画布编排、多模型生成、参考图编辑、**MiniMax H3 短片 Clip 生产**、本地 Agent 与 MCP 自动化，以及一整套短片生产 SOP 收进同一个界面和同一套后端，适合从视觉方案探索一路迭代到可交付的成片。

这是一个独立维护的无限画布与 AI 影像生产工作台。本项目从 [basketikun/infinite-canvas](https://github.com/basketikun/infinite-canvas) 发展而来，并在其画布基础上持续建设短片生产能力，包括 H3 视频节点与 Clip 时间线、剧目与分集数据模型、参考与分镜绑定、画布与 H3 MCP 工具，以及贯穿剧本、分镜、关键帧和 Clip 视频的生产 SOP。感谢上游项目及其贡献者提供的基础工作。

> [!CAUTION]
> 项目仍在持续开发中。Backend 在升级已存在的旧版 SQLite 数据库前会生成并校验迁移快照；数据库版本高于当前代码支持的版本时拒绝打开，不会尝试降级覆盖。快照不包含媒体或浏览器待确认草稿，升级前仍应备份实际数据目录、媒体目录并保留本机草稿。

## 核心能力

### 画布与生成

- 无限画布：多画布项目、节点拖拽缩放、连线、小地图、撤销重做、导入导出、复制粘贴。
- 节点类型：文本、图片、视频、音频、生成配置、组；其余（Markdown、SVG、HTML、3D 全景、便利贴等）由插件提供。
- AI 生成：画布任务统一由 Backend 创建与记录；API 渠道使用你自己的接口和密钥，本地 ComfyUI 渠道使用已配置的工作流，无需 OpenAI API Key。支持文生图、参考图编辑、文本、音频与视频，以及多渠道和自定义调用脚本。
- 有序组：把实际采用的图片按槽位编排进组，支持拖放整理、撤销重做与槽位稳定引用。
- 提示词库：内置开源提示词来源并支持自定义标准 JSON 来源，支持标签过滤、搜索与插入画布。
- “我的素材”：图片、视频、音频与文本资产的统一归档与引用。

### 本地 Agent 与 MCP 自动化

- 本地 Canvas Agent 连接画布网页与本机 Codex / Claude Code，浏览器不直接暴露浏览器状态给 Agent。
- **画布 MCP**：Agent 通过 MCP 读写画布、提交生成、等待任务终态、编排生成流、替换参考与分镜槽位。
- **H3 MCP**：视频节点时间线的结构化视频计划、Clip 顺序调整、参考/分镜绑定、运行时参数、模型与 LoRA 清单等。
- Codex app 插件：安装后自动注册 MCP 并拉起本地 Agent。
- MCP 可观测性：脱敏诊断，包括调用成功率、耗时、错误分布、恢复建议采纳率与关联任务终态。

### MiniMax H3 短片 Clip 生产

- H3 视频节点：多 Clip 时间线，每个 Clip 可独立设置提示词、模型、采样、尺寸、LoRA、TRT 视频 VAE、Motion Context 续写、DLSS 超分等。
- 参考绑定：角色节点、服装 `imageKeys`、道具/场景/站位图分职责绑定；分镜图按槽位绑定并生成对应提示词编号（`Picture N`），避免编号错位。
- 一采/二采人工确认：一采完成后进入待确认态，可确认二采、保留一采或放弃；多 Clip 串行暂停支持重启恢复。
- 本地 ComfyUI：Agent 通过 `/comfy/tasks` 调内置 `minimax-h3` 预设；开启 Motion Context 时需要本机 `ffmpeg`、`ffprobe` 与 Python Pillow（`PYTHON_PATH` 可指定）。
- 短片生产 SOP：项目级约束 + 六个生产子 Skill（剧情设计、资产准备、站位与色彩基准、镜头设计、分镜关键帧、Clip 视频），每阶段自行验收产物。固定制作目录 `{dataDir}/productions/<canvasProjectId>/` 保存剧本、文字分镜表、资产索引、进度与返修日志。

### 数据与协作

- Backend SQLite 为画布、素材、生成记录与业务配置的权威存储；媒体按 `storageKey` 归档在媒体目录。
- 浏览器持久 outbox 承载待确认编辑与冲突草稿——是用户数据，不可作缓存丢弃。
- 实时协作：presence 走 `/canvas/realtime` WS 内存通道，不写项目 JSON/SQLite。
- 插件系统：URL 动态安装/启用/更新/卸载远程节点插件，并提供 TypeScript SDK 自行开发画布节点插件。

## 快速开始

画布、素材、生成记录、渠道配置和用户配置统一以本地 Backend SQLite 为权威存储；媒体文件保存在 Backend 媒体目录。浏览器还保存未确认编辑与冲突草稿，不能把它们当缓存清理。Backend 未连接时不能确认服务端保存。

### 本地开发（Backend + Web）

```bash
git clone --depth 1 https://github.com/helishou/infinite-canvas-mcp.git
cd infinite-canvas-mcp
npm ci
npm run dev
```

启动后访问 `http://localhost:3001`。

`npm run dev` 先构建 Backend 与 Web 使用的 `canvas-agent/dist`，构建成功后启动 Backend（17370）与 Web（3001），不清理已有服务。Backend 已提供 `/agent` 与 `/mcp`，17371 只用于旧客户端兼容代理；需要它时使用 `npm run dev:services`。

Windows 专用 `npm run dev:local` 会清理 17370、17371、3001 上的旧服务，不作探活命令。单独使用根目录 `dev:backend` 或 `dev:web` 也会先构建共享包；直接运行 workspace 的 `dev` 时须自行先构建。Backend `dev` 不自动重启，需要时显式使用 `dev:watch`。

Codex CLI 是可选依赖，普通画布、MCP 与 ComfyUI 不需要下载它。需要侧边栏 Codex 对话时安装 `npm install -g @openai/codex@0.146.0` 并完成登录；运行时优先使用已安装的项目依赖，其次从 PATH 查找。安装、端口、数据备份与局域网设置见[快速开始](docs/content/docs/overview/quick-start.zh-CN.mdx)。

### Docker 运行

```bash
git clone git@github.com:helishou/infinite-canvas-mcp.git
cd infinite-canvas-mcp
docker compose up -d
```

运行后默认端口 3000，可访问 `http://localhost:3000`。
> 仓库 Dockerfile 只构建静态前端并由 nginx 提供，AI 请求由浏览器前台直连用户自己的接口。Backend、Canvas Agent、MCP 与 H3 短片生产栈位于源码层面，Docker 前端镜像不包含它们。

首次打开后连接 Backend。使用 API 模型时配置对应渠道的地址、密钥与模型；使用本地 ComfyUI 时配置服务和工作流；仅编辑画布不需要模型接口。API 密钥随渠道配置保存在本地 SQLite，并按对应执行器用于调用。

问题反馈与功能建议请通过本仓库的 [Issues](https://github.com/helishou/infinite-canvas-mcp/issues) 提交。

## 效果展示

<table width="100%">
  <tr>
    <td width="50%"><img src="https://i.ibb.co/TDFvGWDT/image.png" alt="image" border="0"></td>
    <td width="50%"><img src="https://i.ibb.co/zVwJq3YS/image.png" alt="image" border="0"></td>
  </tr>
  <tr>
    <td width="50%"><img src="https://i.ibb.co/PvY3qhhK/image.png" alt="image" border="0"></td>
    <td width="50%"><img src="https://i.ibb.co/7D04LwN/image.png" alt="image" border="0"></td>
  </tr>
  <tr>
    <td width="50%"><img src="https://i.ibb.co/bj30FtS5/5.png" alt="5" border="0"></td>
    <td width="50%"><img src="https://i.ibb.co/hxRvjw51/image.png" alt="image" border="0"></td>
  </tr>
  <tr>
    <td width="50%"><img src="https://i.ibb.co/jkWsF8q1/image.png" alt="image" border="0"></td>
    <td width="50%"><img src="https://i.ibb.co/XrnfXHx7/image.png" alt="image" border="0"></td>
  </tr>
</table>

## 参与项目

欢迎通过本仓库提交问题反馈、改进建议和代码贡献。提交前请查看现有 [Issues](https://github.com/helishou/infinite-canvas-mcp/issues) 与 [Pull Requests](https://github.com/helishou/infinite-canvas-mcp/pulls)，避免重复工作。

## 开源协议

本仓库按 [MIT License](LICENSE) 发布。该许可文件保留了上游版权声明；基于上游代码及其衍生部分的使用、分发和修改，请遵守许可条款并保留所需版权与许可声明。

## Star History

<a href="https://www.star-history.com/?repos=helishou%2Finfinite-canvas-mcp&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=helishou/infinite-canvas-mcp&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=helishou/infinite-canvas-mcp&type=date&theme=light&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=helishou/infinite-canvas-mcp&type=date&legend=top-left" />
 </picture>
</a>
