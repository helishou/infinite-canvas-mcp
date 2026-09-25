# 运行与验证

触发：构建、启动、重载、改动不生效。执行边界遵循[根约定](../../../../AGENTS.md)，不把本表变成每次全跑的清单。

## 先辨认消费者

| 修改/消费者 | 生效路径 | 必要动作 |
|---|---|---|
| Backend dev | 当前 package 的 `tsx src/index.ts`，没有默认 watch | 核对实际进程是否加载新源码，再处理必要重载 |
| Backend start 或明确的 dist 消费方 | `backend/dist` | 根目录 `npm run build --workspace backend` |
| Backend 导入 canvas-agent | 包 exports 指向 `canvas-agent/dist` | 根目录 `npm run build --workspace canvas-agent`，确认消费进程加载 |
| 普通画布插件 | 插件 bundle | 插件目录 `node build.mjs`，核对实际加载 URL |
| H3 内置 UI，Vite dev | HOST_SYSTEM_PLUGINS 引用源码 | HMR 后验证页面；按插件约定同步分发产物 |
| H3 内置 UI，静态页面 | Web 打包后的 JS | 根目录 `npm run build --workspace web` |

`web/dist` 是构建快照。H3 build 同步 `dist/plugins/minimax-h3.js` 仅更新插件文件，不能更新宿主 JS；其他插件核对 public/dist 产物。被 Git 忽略的产物仍是本地运行所需，提交源码不代表进程更新。

H3 版本来源与 SDK 构建规则见[插件约定](../../../../plugins/canvas/AGENTS.md)。默认开发命令可能变化，每次以当前 package 和实际命令行为准。

## 服务与会话

- 核对端点、完整命令行、PID、创建时间及相关日志；LISTENING、lock 文件或同名进程不能单独证明正确版本。
- `dev:local` 会清理旧服务，不作探活；不启动第二套服务或按进程名/端口批量停止。
- 已授权重载只操作未加载变更的相关服务；已有 watch 更新不要再重启。Vite 与 ComfyUI 不因 Backend 变更一起重启。
- 默认 MCP 使用常驻 Backend `/mcp`。Backend 重载使内存 session 失效，客户端重新初始化；先分清实际聊天客户端与 gateway。
- 旧 schema、旧 bundle、旧进程和业务异常是四类问题，分别取证。修改文件 mtime 强制重载也属于服务动作，不能作为绕过授权的技巧。

## 精确验证

根/workspace `npm test` 通过 `scripts/test.mjs` 枚举整个 src 测试目录，不会把附加文件名当过滤条件。只测单文件时，从能解析 tsx 的 workspace 使用 Node 的显式文件参数，例如：

```powershell
node --import tsx --test src/canvas/collaboration.test.ts
```

示例在 backend 目录运行，测试文件按改动选择。若 tsx 解析失败，参照 scripts/test.mjs 的 createRequire 解析已安装依赖，不为探针下载替代版本。含浏览器环境的测试使用项目已有 harness，不把 Node 执行结果当浏览器验收。

- 共享契约：选择直接生产者/消费者的现有测试。
- 数据与任务：用临时项目或数据库覆盖本次影响的状态转换和失败路径。
- UI：检查 JSX 边界，再按[页面验证](live-page-verification.md)检查实际交互。
- 纯指引：检查引用、作用域、重复/矛盾和差异；无需业务构建。

检查通过后仅在有新修改、失败或未消除疑点时重跑。报告构建成功、进程已加载和行为已通过时，分别给出对应证据。
