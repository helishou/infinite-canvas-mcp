# Canvas Agent 与共享契约

继承[根约定](../AGENTS.md)。画布读写、生成和任务相关改动先读[数据契约](../.agents/rules/canvas-contracts.md)。

## 分清三个入口

- 本文件：开发 `canvas-agent/` 的规则。
- `agent-instructions.md`：产品里操作网站/画布的 Agent 提示词，由 `src/config.ts` 的 AGENT_PROMPT 读取，并在工作空间初始化时使用。它不是工程开发规则；改它属于产品行为变更。
- Backend `/mcp`：外部 Codex/Hermes 的共享画布工具入口。不要因本包存在独立入口就把客户端改成每次启动 stdio。

修改产品提示词时核对初始化覆盖条件、既有自定义指令与进程加载时机，不靠改仓库文件宣称所有在用会话已更新，不直接覆盖用户工作空间。

## 工具和契约

- `src/canvas/schemas.ts`、operations、generation-contract、reference-contract、runtime-fields 与 Backend/Web 有共同消费者，须沿调用链同步。
- 对外 schema 描述要能在实际 tools/list 看到；工具实现通过 Backend API/service 访问业务，不另建 SQLite、媒体或执行器副本。
- 不扩大摘要接口默认返回体；完整节点、历史媒体、任务日志按需取。被截断的数据不能修补成“完整真值”。
- 工具新增、删除、参数和返回行为变化要同步相关客户端、注册入口、文档与针对性验证。
- 不用类型断言掩盖运行协议不一致，不为尚未使用的旧结构添加兼容层；真实存量数据另走受保护迁移。

## 消息与存储

- 消息归属同时使用 threadId、turnId、itemId。实时事件只补未物化 turn，历史快照权威后不得重复合并同条消息。
- 通信协议版本和消息存储版本独立管理。升级先备份，遇未知版本、损坏清单、冲突备份拒绝覆盖；不按记录数量或大小静默裁剪历史元数据。
- 恢复、重连、取消须区分原任务与新请求；保留关联 ID，避免刷新后重复提交或错归消息。
- 对 Agent 面板 SSE 连接的判断不能阻止本来可用的 Backend 媒体、拼接或生成能力。

## 布局与产物

- 建节点沿用 `src/canvas/tools.ts` 的 nextCanvasAnchor/nextCanvasFlowAnchor：有 reference 从第一个参考节点同行右侧起步，间距 96；碰撞继续向右避让。无 reference 才走全局最右与 y=0；显式坐标不重排。
- 生成结果占位由 Backend 建立；MCP 不复制结果 ID、槽位、连线和位置算法。
- Backend 从本包 exports 加载 dist。改 `src/` 后从根目录执行 `npm run build --workspace canvas-agent`，再核对消费进程；不要依赖可能被 npm 提升掉的局部 node_modules/tsc 路径。
- 构建不代替会话、schema 与消息行为验证；只运行改动相关的检查。
