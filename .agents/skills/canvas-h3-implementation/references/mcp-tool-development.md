# MCP 与工具开发

触发：工具 schema/注册、项目路由、Backend 调用与返回体。共享规则见[数据契约](../../../rules/canvas-contracts.md)，本页只说明开发路径。

## 定位链路

| 层 | 当前入口 |
|---|---|
| HTTP MCP 与 session | `backend/src/mcp.ts`：registerBackendMcpHttpRoutes、createBackendMcpInstance |
| 工具名、schema、描述 | `canvas-agent/src/canvas/schemas.ts` |
| Backend 画布注册 | registerBackendCanvasTools |
| H3 插件工具 | `canvas-agent/src/plugins/minimax-h3/mcp.ts` |
| Backend 客户端 | `canvas-agent/src/runtime/backend-client.ts` |
| 业务 | Backend service/store/ops |

默认测试和接入使用共享 `/mcp`；startBackendMcpServer 是 stdio 兼容入口，只在本次涉及兼容行为时验证它。

## 修改方法

1. 看现有工具是否已表达需求。新增模型优先更新模型注册与输入契约，不能每个模型复制一套工具。
2. 修改实际需要的 schema、注册、客户端、路由与服务；对字段检查请求、默认值、过滤、持久化、返回和最终执行的完整传递。
3. Zod schema/shape 沿用当前 SDK 与相邻入口；不要凭旧案例全局改写。以实际 tools/list 的字段描述、必填性、枚举验证。
4. 保持 session 的 activeProjectId、来源和 clientId 隔离；用户显式 projectId 优先，不能被其他客户端的活动页面覆盖。
5. 修改共享包后按[运行与验证](development-verification.md)重建并核对实际消费，不能只看源码已有新工具名。

## 查询与验收

- 用 initialize、tools/list、目标 tools/call 核对公共契约；项目上下文改动覆盖两个独立 session。
- 先摘要列节点，单节点/材料/任务详情按需读；支持分页的查询必须能遍历全量，不把第一页当全集。
- 缺少浏览器时区分纯页面态工具与 Backend 能力；Backend REST `/canvas/projects/:id` 是现有入口，不能宣称只有 SQLite 可查状态。
- 写入验证 revision、幂等回执和后续读回；批量异常按可能部分成功逐项核对，不能整批重放。
- 中文标识符使用结构化参数或 UTF-8 JSON，读回按精确值比较；编码问题不能用直接写库修补。
- 结果截断时缩小读取范围。截断文件只作部分证据，不通过手写解析/转义替换伪造完整项目。
- 耗时分开观察提交、父子任务、provider、归档和回写；稳定 taskId 是等待与恢复依据，不查询“最新任务”代替。
