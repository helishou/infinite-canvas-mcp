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

无限画布（Infinite Canvas）是一款面向 AI 影像与短片制作的开源工作台：用画布整理创意、提示词和素材，连接自己的模型接口或 ComfyUI，再通过 H3 时间线、剧目制作页和 MCP 将剧本、资产、分镜与视频任务串起来。

本项目从 [basketikun/infinite-canvas](https://github.com/basketikun/infinite-canvas) 发展而来，独立维护画布、Backend、Canvas Agent 和影视生产能力。感谢上游项目及其贡献者。

## 现在可以做什么

| 能力 | 使用方式 |
| --- | --- |
| 无限画布 | 多项目、文本/图片/视频/音频/生成配置/组节点，连线、拖拽、缩放、小地图、撤销重做、复制粘贴与 JSON 导入导出 |
| 素材与参考 | 素材库、角色及服装参考、有序组槽位、拖入文件、图片裁剪/切图；引用原始媒体并保留生成记录 |
| 多模型生成 | 配置自己的 API 渠道或 ComfyUI 工作流，生成图片、文字、音频、视频；画布任务由 Backend 记录，支持进度、取消和结果归档 |
| 工作流管理 | 导入 ComfyUI 工作流、配置输入及参数、查看服务与模型目录；可连接独立运行的 ComfyUI |
| H3 Clip 时间线 | 多 Clip 提示词、角色/场景/道具/分镜绑定、模型/采样/尺寸/LoRA、Motion Context、一采确认与二采、历史输出与视频拼接 |
| 剧目与分集制作 | 剧目、分集和制作画布，分场剧本、镜头表、关键帧与 Clip 映射；发布修订、预览影响和局部重做 |
| Agent 与 MCP | 侧边栏 Codex 对话、画布/H3/制作工具、任务等待与脱敏诊断；外部客户端连接 Backend 的 Streamable HTTP MCP |
| 扩展与协作 | 插件 SDK 与 URL 安装、实时画布同步与 presence、待确认编辑及冲突草稿保护、可选 WebDAV 同步副本 |

源码还包含快捷查找与聚焦、批量编号重命名、SVG 导入编辑、H3 输出翻页预览，以及 Acheng 七模块导演制作与版本更新/回退。这些已实现的迭代及人工验收项见[待测清单](docs/content/docs/progress/pending-test.zh-CN.mdx)，已确认功能见[功能介绍](docs/content/docs/overview/features.zh-CN.mdx)。

H3 和导演制作是可选能力：需要相应模型、ComfyUI 自定义节点或 Acheng 引擎。基础画布编辑与素材管理无需 GPU、模型 Key 或 Codex 登录。

## 快速开始

### Docker：前端、Backend 与持久数据一起部署

需要 Docker Engine/Desktop 与 Docker Compose v2。以下命令从本仓库源码构建，不依赖维护者的电脑或上游发布镜像：

```bash
git clone --depth 1 --recurse-submodules https://github.com/helishou/infinite-canvas-mcp.git
cd infinite-canvas-mcp
cp .env.example .env
docker compose up -d --build
```

Windows PowerShell 用 `Copy-Item .env.example .env` 代替 `cp`。打开 `http://localhost:3000`，在「连接与协作」中填写后台地址 `http://localhost:3000/api` 和连接密钥。首次启动会自动生成密钥，可在自己终端执行以下命令读取；密钥不会注入网页配置：

```bash
docker compose exec backend node -e 'const fs=require("node:fs"); console.log(JSON.parse(fs.readFileSync("/data/backend/backend.json","utf8")).token)'
```

默认只绑定本机端口；同源网关代理 API、媒体、SSE、WebSocket 和 MCP。命名卷保存 SQLite、原始媒体、Agent 工作空间与可选 Codex/Acheng 状态。停止或重建容器保留该卷；删除卷会删除数据。部署到局域网/服务器时，在 `.env` 配置 `APP_BIND_ADDRESS`、`APP_PORT` 与完整 `APP_ORIGIN`，详见[Docker 部署](docs/content/docs/overview/docker.zh-CN.mdx)。

### 本地源码开发

需要 Node.js 22.5+（建议 Node 22/24 LTS）与 npm：

```bash
npm ci
npm run dev
```

访问 `http://localhost:3001`。根命令从源码构建官方插件和共享的 `canvas-agent/dist`，再启动 Backend（17370）和 Web（3001），不清理已有服务。Backend 已集成 `/agent` 和 `/mcp`；17371 只用于可选旧客户端代理，使用 `npm run dev:services`。Backend 默认不自动重启，需要时显式使用 `dev:watch`；Windows 的 `dev:local` 会清理旧服务，不能当作探活命令。

侧边栏 Codex 对话需自行安装 `@openai/codex@0.160.0` 并登录；基础画布和外部 MCP 可跳过。原生部署的监听、数据目录、密钥和来源可以通过环境变量配置，见[部署说明](docs/content/docs/overview/docker.zh-CN.mdx)与[快速开始](docs/content/docs/overview/quick-start.zh-CN.mdx)。

## 连接模型与可选制作能力

- **API 模型**：在设置中添加渠道地址、Key 与模型。渠道 Key 保存在 Backend SQLite，实际调用位置取决于执行器；自定义浏览器脚本需要网页保持打开。
- **ComfyUI**：独立安装模型、节点和工作流，再配置 Backend 能访问的服务地址。Docker 中的 `127.0.0.1` 指向容器；宿主服务可使用 `host.docker.internal`，其他机器使用其实际网络地址。
- **MiniMax H3**：模型、LoRA、VAE、TRT/DLSS 与自定义节点以自己的 ComfyUI 能力为准；本地潜变量续跑需要 Backend 能访问同一安装目录。视频工具与 Motion Context 需要 FFmpeg/FFprobe，Backend 镜像已包含它们。
- **Acheng Director**：七模块覆盖剧情、资产、表演/动作、视效、镜头、模型提示词与连续性。`.agents/skills/acheng-director` 是指向 `helishou/acheng-director-skill` 的 Git 子模块，可在该目录直接开发、提交和推送。已有克隆先运行 `git submodule update --init -- .agents/skills/acheng-director`；提交修改后运行 `npm run acheng:update -- --local` 校验并启用当前提交，`npm run acheng:update` 获取远端更新，`npm run acheng:rollback` 仅回退运行包。Docker 的对应命令和可选 Codex 镜像见部署说明。
- **插件**：Markdown、SVG、HTML、3D 全景等通过节点插件扩展，开发方式见[插件 SDK](plugins/canvas/README.md)。

## 数据与部署边界

Backend 的 SQLite 与媒体目录是业务数据的权威，WebDAV 是可选同步副本。原生部署默认使用 `~/.infinite-canvas`，也可显式指定数据/媒体目录。浏览器保存的未确认编辑与冲突草稿也是用户数据。

升级已有旧版 SQLite 前，Backend 会生成并校验迁移快照；遇到比代码更新的数据库版本会拒绝打开。快照不包含媒体和浏览器草稿，升级前仍需备份完整数据。显式切换数据目录不会自动搬迁旧资料。

项目采用共享 Backend 密钥，持有密钥的可信协作者可以访问整个后台。它目前没有独立账号、租户或按项目权限隔离；服务器部署需自行提供 HTTPS 和访问控制。仅部署静态前端（Vercel/Render 或 Docker 的 `frontend` target）仍需连接可访问的 Backend。

反馈问题、部署失败和功能建议请提交到 [Issues](https://github.com/helishou/infinite-canvas-mcp/issues)。

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
