# Infinite Canvas Plugin for Hermes

让 Hermes 读取并操作 Infinite Canvas。插件把一个 Streamable HTTP MCP（`http://127.0.0.1:17370/mcp`）和两个技能接入 Hermes。使用前先启动本地 Backend。

## 一行从 GitHub 安装

```bash
hermes plugins install helishou/infinite-canvas-mcp/plugins/hermes --no-enable
hermes plugins enable infinite-canvas
```

默认disabled，需显式 `enable`。更新用：

```bash
hermes plugins update infinite-canvas
```

## 包结构

这是一个 Hermes 可移植插件包（Portable Agent Plugins v1）：

```
plugins/hermes/
├── plugin.json      # 插件描述
├── mcp.json         # infinite-canvas MCP（HTTP，指向本地 Backend）
└── skills/
    ├── canvas/SKILL.md        # 操作画布
    └── open-canvas/SKILL.md   # 打开画布
```

技能会按 `<插件名>:<技能名>` 注册，即 `infinite-canvas:canvas` 和 `infinite-canvas:open-canvas`。MCP 工具会带 `mcp__infinite-canvas__` 前缀。

## 连接前提

- 插件只负责声明 MCP，不负责启动 Backend。先按主仓库 README 启动本地 Backend（默认监听 17370）。
- MCP 只对回环地址开放，插件与 Backend 必须在本机同一用户下运行。
- 不想用插件时，也可以手动添加同一个 MCP：

```bash
hermes mcp add infinite-canvas --url http://127.0.0.1:17370/mcp
```
