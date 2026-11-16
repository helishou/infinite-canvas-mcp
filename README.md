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

## 依赖与部署方式

本项目按**单机工作台**部署：Web 提供界面，Backend 统一保存 SQLite、媒体、配置与任务，并提供 Agent 和 MCP。无需另装 PostgreSQL、MySQL、Redis 或 SQLite 服务。

| 场景 | 选择 |
| --- | --- |
| 本机使用，尤其已有 Windows ComfyUI / 模型环境 | 原生运行，复用现有模型服务和文件目录 |
| 想少装系统依赖，或在自己的服务器上运行 | Docker Compose，一次启动前端网关与 Backend |
| 修改源码、调试插件 | `corepack pnpm run dev`，带源码监听与空闲保护重载 |
| 只发布静态网页 | 仍须另外提供 Backend；静态站本身不保存业务数据 |

### 原生运行的必需依赖

| 依赖 | 要求与用途 |
| --- | --- |
| Node.js | 建议 **24 LTS**；兼容 **22.16.0+ 的 22.x**，不使用 23.x。Backend 使用内置 `node:sqlite` 的事务状态 API |
> **git-bash 用户注意**：Windows 上 `C:\Program Files
odejs\corepack` 与 `%APPDATA%
pm\pnpm`
> 是 POSIX sh shim，在 MSYS 环境下会把 `/c/...` 解析成 `<当前盘>:\c\...`，报
> `Cannot find module 'E:\c\Program Files
odejs
ode_modules\corepack\dist\corepack.js'`。
> 这时改用 `npm run <脚本名>`（根脚本已走 `scripts/pnpm.mjs` 启动器，不经过 shim），
> 或直接 `node scripts/pnpm.mjs --filter <包> run <脚本>`。cmd / PowerShell 下 `corepack pnpm` 不受影响。

| Corepack + pnpm | 项目固定 **pnpm 12.12.1**，统一用 `corepack pnpm`；所有 workspace 在根目录一次安装 |
| Git | 获取源码、初始化 Git 子模块；Acheng 版本管理也使用 Git |
| 浏览器 | 运行画布界面；基础编辑不需要 GPU、模型 Key 或 Codex 登录 |

Node 下限依据是 [`DatabaseSync.isTransaction`](https://nodejs.org/download/release/v22.17.0/docs/api/sqlite.html#databaseistransaction)。前端、Backend、共享 Agent 与插件 SDK 的 JavaScript 依赖均由锁文件安装，不逐包手工安装，也不混用 npm/yarn 生成另一份锁文件。

### 按功能安装的可选依赖

| 要使用的能力 | 额外准备 |
| --- | --- |
| API 文字/图片/音频/视频生成 | 可访问的模型服务、渠道地址、Key 与模型；本机无需 GPU |
| 媒体规格核验、视频裁剪/拼接、H3 Motion Context | **FFmpeg 与 FFprobe**；加入 PATH，或指定 `FFMPEG_PATH`、`FFPROBE_PATH` |
| 本地 ComfyUI / H3 生成 | 独立运行的 ComfyUI、对应自定义节点、模型和 GPU 环境；本项目不代装 CUDA 或模型 |
| Acheng 导演编译 | **Python 3.10+**、Git 与已激活的 Acheng 运行包；JSON 编译/审计使用 Python 标准库 |
| 视频镜头切分检测 | Python + [镜头检测依赖清单](backend/workers/requirements-video-shot-detection.txt)（固定 `scenedetect-headless`） |
| 图片风格迁移 worker | Python + [风格迁移依赖清单](backend/workers/requirements-style-transfer.txt)（NumPy、OpenCV headless） |
| 侧边栏 Codex 对话 | **`@openai/codex@0.160.0`**，安装后登录；基础画布与外部 MCP 不要求安装 |

已有可用 Python 或 ComfyUI 环境可以复用，按功能指定解释器，无需重装整套环境。Python 安装示例、解释器选择及 Docker 已包含的依赖见[快速开始](docs/content/docs/overview/quick-start.zh-CN.mdx#可选-python-环境)。

## 快速开始

### 方式一：本机原生运行

先安装上表的 Node.js 与 Git，并检查 Corepack：

```bash
node --version
corepack --version
```

如果系统没有 Corepack，先执行 `npm install --global corepack`，再重新打开终端。以下命令始终使用 `corepack pnpm`，无需额外启用全局 pnpm shim。

```bash
git clone --depth 1 --recurse-submodules https://github.com/helishou/infinite-canvas-mcp.git
cd infinite-canvas-mcp
corepack pnpm --version
corepack pnpm install --frozen-lockfile
corepack pnpm run dev
```

打开 **`http://localhost:3001`**。根命令先构建官方插件和共享 Agent，再启动 Backend（17370）与 Web（3001）。基础运行到这里即可；模型、Python 与 Codex 按需配置。

首次连接时，在「连接与协作」中填写 `http://127.0.0.1:17370` 与 Backend 密钥。默认数据目录的密钥可在自己的终端读取：

```bash
node -e "const p=require('node:path'),f=require('node:fs');console.log(JSON.parse(f.readFileSync(p.join(require('node:os').homedir(),'.infinite-canvas','backend.json'),'utf8')).token)"
```

如果指定了其他数据目录，请读取实际目录的 `backend.json`。不要把密钥写进 README、截图或分享日志。

**日常制作希望源码保存不触发 Backend 重载**，可在首次安装后用两个终端，均从仓库根目录运行：

```bash
# 终端 1：构建并启动稳定 Backend；先等待原 Backend 空闲并正常停止
corepack pnpm run start:backend
```

```bash
# 终端 2：启动 Web
corepack pnpm run dev:web
```

`start:backend` 消费构建产物并关闭源码监听；更新代码后需重新走启动流程。`dev` 使用源码监听并等待业务空闲才重载。默认 Backend 已集成 `/agent`、`/mcp`，不需要另外启动 17371 Agent；`dev:services` 仅在需要旧客户端代理时使用。Windows 的 `dev:local` 会清理旧服务，不作为日常探活命令。

### 方式二：Docker Compose

宿主机需要 **Docker Engine/Desktop、Compose v2 与 Git**；Node、FFmpeg、Python 等由镜像准备，不要求先装进宿主机。Compose 不包含 ComfyUI、GPU 模型或 Codex 登录状态。

```bash
git clone --depth 1 --recurse-submodules https://github.com/helishou/infinite-canvas-mcp.git
cd infinite-canvas-mcp
cp .env.example .env
docker compose up -d --build
```

PowerShell 用 `Copy-Item .env.example .env` 代替 `cp`。打开 **`http://localhost:3000`**，后台地址填写 **`http://localhost:3000/api`**。读取首次自动生成的连接密钥：

```bash
docker compose exec backend node -e 'const fs=require("node:fs"); console.log(JSON.parse(fs.readFileSync("/data/backend/backend.json","utf8")).token)'
```

默认只开放本机网页端口；同源网关代理 API、媒体、SSE、WebSocket 和 MCP。命名卷保存数据库、媒体和工作空间，容器重建保留数据。**不要用 `docker compose down --volumes` 升级，它会删除数据卷。** 局域网、宿主 ComfyUI 挂载、可选 Codex 镜像与备份步骤见[Docker 部署](docs/content/docs/overview/docker.zh-CN.mdx)。

### 启动后检查

| 运行方式 | 网页 | 健康检查 | 外部 MCP |
| --- | --- | --- | --- |
| 原生 | `http://localhost:3001` | `http://127.0.0.1:17370/health` | `http://127.0.0.1:17370/mcp` |
| Docker | `http://localhost:3000` | `http://localhost:3000/api/health` | `http://localhost:3000/api/mcp` |

健康接口应返回 JSON。外部 MCP 使用 Streamable HTTP 与同一个 Backend 的 Bearer 密钥。Docker 可用 `docker compose ps`、`docker compose logs --tail=100 backend` 排查启动；首次构建与已有大库升级应等待完成后连接。

## 连接模型与可选制作能力

- **API 模型**：在设置中添加渠道地址、Key 与模型。渠道 Key 保存在 Backend SQLite，实际调用位置取决于执行器；自定义浏览器脚本需要网页保持打开。
- **ComfyUI**：独立安装模型、节点和工作流，再配置 Backend 能访问的服务地址。Docker 中的 `127.0.0.1` 指向容器；宿主服务可使用 `host.docker.internal`，其他机器使用其实际网络地址。
- **MiniMax H3**：模型、LoRA、VAE、TRT/DLSS 与自定义节点以自己的 ComfyUI 能力为准；本地潜变量续跑需要 Backend 能访问同一安装目录。视频工具与 Motion Context 需要 FFmpeg/FFprobe，Backend 镜像已包含它们。
- **Acheng Director**：七模块覆盖剧情、资产、表演/动作、视效、镜头、模型提示词与连续性。源代码由 Git 子模块提供，首次使用按[快速开始](docs/content/docs/overview/quick-start.zh-CN.mdx#可选-python-环境)校验并激活运行包，再用 `corepack pnpm run acheng:status` 检查。运行版本默认保存在 `.canvas-runtime`，可通过 `INFINITE_CANVAS_ACHENG_HOME` 指定持久目录；运行包与 Codex 登录目录分开管理。
- **插件**：Markdown、SVG、HTML、3D 全景等通过节点插件扩展，开发方式见[插件 SDK](plugins/canvas/README.md)。

## 数据与部署边界

Backend 的 SQLite 与媒体目录是业务数据的权威，WebDAV 是可选同步副本。原生部署默认使用 `~/.infinite-canvas`，也可显式指定数据/媒体目录。浏览器保存的未确认编辑与冲突草稿也是用户数据。

升级前先等待生成任务、Agent 回合和编译结束，正常停止 Backend，并备份实际数据目录、独立媒体目录及 Acheng 运行目录。不要只复制正在写入的 `runtime.sqlite`；SQLite WAL 也可能包含已提交编辑。浏览器未确认编辑与冲突草稿需要保留。

当前存储版本为 **schema 53**，支持从 **52** 直接升级；更早的库或备份先由上一版 Backend 升到 52。支持的迁移会先生成并校验一致性快照；无法识别或比代码更新的版本拒绝打开。迁移快照不包含媒体，不能代替完整备份；已有新编辑后不能直接恢复旧备份覆盖。切换数据目录不会自动搬迁资料。详细布局与容量维护见[存储说明](docs/canvas-storage-capacity.md)。

原生启动不会自动读取根目录 `.env`；该文件供 Compose 使用。原生环境变量需在 Shell 或服务管理器里设置。只需使用默认数据目录时，无需创建 `.env`。

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

本项目主体代码按 [MIT License](LICENSE) 发布，并保留上游版权声明。随附第三方组件适用各自许可：本地风格迁移的 ImageF 算法模块使用 [PolyForm Noncommercial 1.0.0](backend/workers/style_transfer/LICENSE.txt)，附带模型另有许可；详见[来源与许可说明](backend/workers/style_transfer/VENDORING.txt)及[第三方声明](backend/workers/style_transfer/THIRD_PARTY_NOTICES.txt)。分发时须保留各组件的版权、许可和 Required Notice，不能将第三方部分一概视为 MIT。

## Star History

<a href="https://www.star-history.com/?repos=helishou%2Finfinite-canvas-mcp&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=helishou/infinite-canvas-mcp&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=helishou/infinite-canvas-mcp&type=date&theme=light&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=helishou/infinite-canvas-mcp&type=date&legend=top-left" />
 </picture>
</a>
