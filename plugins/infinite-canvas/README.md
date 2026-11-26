# Infinite Canvas Plugin

让 Codex / ZCode 可以打开并操作 Infinite Canvas。

插件直连本机 Backend 的 Streamable HTTP MCP（`http://127.0.0.1:17370/mcp`）。使用前先启动本地 Backend。

## 安装

从 GitHub 一行安装，无需手动 clone 整个仓库：

macOS / Linux / Windows（PowerShell 或 CMD 通用）：

```bash
codex plugin marketplace add helishou/infinite-canvas-mcp \
  --sparse .agents/plugins \
  --sparse plugins/infinite-canvas
codex plugin add infinite-canvas@infinite-canvas-local
```

更新：

```bash
codex plugin marketplace upgrade infinite-canvas-local
```

Codex 只稀疏拉取 `.agents/plugins`（marketplace 清单）和 `plugins/infinite-canvas`（插件本体）两个目录。

### 从本地仓库安装（开发调试）

若已 clone 本仓库，可指向本地路径：

```bash
codex plugin marketplace add "$(pwd)"
codex plugin add infinite-canvas@infinite-canvas-local
```

Windows PowerShell 用 `$PWD`，CMD 用 `%cd%`。

### ZCode

- 打开 **Settings → Plugin Management → Discover**，点击右上角 **`+`** 添加 marketplace。
- 选择 **本仓库目录**（`plugins/infinite-canvas`）或本仓库根目录，即可发现 `infinite-canvas` 插件并安装。
- 或在 ZCode 界面直接以本地目录方式加载该插件目录。

安装后新建一个任务，然后输入：

```text
帮我打开并连接到 Infinite Canvas
```
