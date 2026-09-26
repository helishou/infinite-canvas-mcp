<p align="center">
  <img src="web/public/logo.svg" width="96" alt="infinite-canvas logo">
</p>

<h1 align="center">无限画布 (infinite-canvas)</h1>

<p align="center">
  <a href="https://linux.do/"><img src="https://img.shields.io/badge/Linux.do-Community-2b6de8?style=flat-square" alt="Linux.do"></a>
  <a href="https://render.com/deploy?repo=https://github.com/basketikun/infinite-canvas" target="_blank" rel="noopener noreferrer"><img src="https://img.shields.io/badge/Render-Deploy-46e3b7?style=flat-square&logo=render&logoColor=111111" alt="Deploy to Render"></a>
  <a href="https://github.com/basketikun/infinite-canvas"><img src="https://img.shields.io/github/stars/basketikun/infinite-canvas?style=flat-square&logo=github" alt="GitHub stars"></a>
  <a href="https://github.com/basketikun/infinite-canvas/tags"><img src="https://img.shields.io/github/v/tag/basketikun/infinite-canvas?style=flat-square&label=version" alt="Version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-f97316?style=flat-square" alt="License"></a>
  <a href="https://vite.dev/"><img src="https://img.shields.io/badge/Vite-7-646cff?style=flat-square&logo=vite&logoColor=white" alt="Vite"></a>
  <a href="https://reactrouter.com/"><img src="https://img.shields.io/badge/React_Router-7-ca4245?style=flat-square&logo=reactrouter&logoColor=white" alt="React Router"></a>
</p>

<p align="center">
<a href="https://trendshift.io/repositories/50077?utm_source=repository-badge&amp;utm_medium=badge&amp;utm_campaign=badge-repository-50077" target="_blank" rel="noopener noreferrer"><img src="https://trendshift.io/api/badge/repositories/50077" alt="basketikun%2Finfinite-canvas | Trendshift" width="250" height="55"/></a>
</p>

<p align="center">
  <a href="docs/content/docs/overview/quick-start.zh-CN.mdx">快速开始</a> · <a href="docs/content/docs/overview/features.zh-CN.mdx">功能介绍</a> · <a href="docs/content/docs/overview/docker.zh-CN.mdx">Docker 部署</a> · <a href="docs/content/docs/canvas/canvas-node-manual.mdx">画布节点操作手册</a> · <a href="docs/content/docs/canvas/canvas-shortcuts.mdx">画布快捷键</a> · <a href="SECURITY.md">漏洞提交</a> · <a href="docs/content/docs/progress/todo.mdx">待办事项</a> · <a href="canvas-agent/README.md">本地 Canvas Agent</a> · <a href="plugins/canvas/README.md">画布插件 SDK</a> · <a href="plugins/infinite-canvas/README.md">Codex app 插件</a>
</p>

无限画布（Infinite Canvas）是一款面向 AI 影像与短片生产的开源工作台。它把无限画布编排、多模型生成、参考图编辑、**MiniMax H3 短片 Clip 生产**、本地 Agent 与 MCP 自动化，以及一整套短片生产 SOP 收进同一个界面和同一套后端，适合从视觉方案探索一路迭代到可交付的成片。

本仓库是 `basketikun/infinite-canvas` 的衍生分支，在原画布能力之上增加了面向短片生产的扩展层：H3 视频节点与 Clip 时间线、剧目与分集数据模型、参考与分镜绑定、覆盖画布与 H3 的 MCP 工具面，以及把剧本 → 分镜 → 关键帧 → Clip 视频串成一条可验收流水线的生产 SOP。

> [!CAUTION]
> 项目目前处于开发阶段，不保证历史数据兼容。各种本地存储格式都可能直接调整，欢迎关注后续更新。
>
> 如果你需要稳定维护自己的分支，建议自行 fork 后独立开发。二次开发与 PR 请保留原作者信息和前端页面标识。

## 核心能力

### 画布与生成

- 无限画布：多画布项目、节点拖拽缩放、连线、小地图、撤销重做、导入导出、复制粘贴。
- 节点类型：文本、图片、视频、音频、生成配置、组；其余（Markdown、SVG、HTML、3D 全景、便利贴等）由插件提供。
- AI 生成：浏览器前台直连你自己的 OpenAI 兼容接口，支持文生图、图生图、参考图编辑、文本、音频与视频；支持多渠道、自定义调用脚本、尺寸、质量、透明背景与推理强度等参数。
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

画布、素材、生成记录、渠道配置和用户配置统一以本地 Backend SQLite 为权威存储；媒体文件保存在 Backend 媒体目录，浏览器只保留可丢弃缓存、界面状态和连接引导信息。

### 本地开发（Backend + Agent + Web 三进程）

```bash
git clone git@github.com:helishou/infinite-canvas-mcp.git
cd infinite-canvas-mcp
npm install
npm run dev:local        # Windows 下的 dev:local.bat → dev-local.ps1；或 npm run dev:services
```

启动后访问 `http://localhost:3000`。

`npm run dev:local` 会先清理 17370、17371、3001 三个端口上的旧服务，再拉起 backend(17370)、agent(17371) 与 web(3001)。`npm run dev:services` 不做清理，直接三进程并发启动。`dev` 不是 watch，也不是探活命令。

### Docker 运行

```bash
git clone git@github.com:helishou/infinite-canvas-mcp.git
cd infinite-canvas-mcp
docker compose up -d
```

运行后默认端口 3000，可访问 `http://localhost:3000`。
> 仓库 Dockerfile 只构建静态前端并由 nginx 提供，AI 请求由浏览器前台直连用户自己的接口。Backend、Canvas Agent、MCP 与 H3 短片生产栈位于源码层面，Docker 前端镜像不包含它们。

首次打开后进入右上角配置，填入自己的 OpenAI 兼容 `Base URL` 与 `API Key`，设置默认文/图/视频模型。如果默认的 OpenAI 接口调用方式与你的 API 不同，可自定义生图与视频的脚本调用。

如果你在为没有合适的生图 API 发愁，可以看看那个免费生图项目：[chatgpt2api](https://github.com/basketikun/chatgpt2api)。

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

## 联系方式

项目定制二次开发需求与生图 API 需求可联系。

邮箱：1844025705@qq.com · QQ：1844025705

## 赞助支持

本项目长期开放广告赞助合作，欢迎品牌 / 产品投放，你的支持是持续更新的动力！

有广告赞助意向请通过上方联系方式沟通。

## 社区支持

学 AI，上 L 站：[LinuxDO](https://linux.do/)

点击链接加入群聊【开源无限画布(2群)】：https://qm.qq.com/q/HRt2kUnYiG

## 开源协议

本项目使用 [MIT License](LICENSE)。任何人都可以免费使用、复制、修改、分发、再授权和商业使用本项目，也可以用于闭源产品。

## Star History

<a href="https://www.star-history.com/?repos=basketikun%2Finfinite-canvas&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=basketikun/infinite-canvas&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=basketikun/infinite-canvas&type=date&theme=light&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=basketikun/infinite-canvas&type=date&legend=top-left" />
 </picture>
</a>
