# Canvas Agent 开发约定

继承[根约定](../AGENTS.md)。本目录提供 Agent 会话、共享 schema、Backend 客户端和插件 MCP 契约；Backend 消费包导出的 `dist`。

- 新增或修改 MCP 工具先读[MCP 工具契约](../.agents/rules/mcp-contracts.md)，涉及业务编辑再读[画布数据契约](../.agents/rules/canvas-contracts.md)。工程定位与验证方法见[工具开发指引](../.agents/skills/canvas-h3-implementation/references/mcp-tool-development.md)。
- schema、工具描述与共享投影在本包维护；Backend、插件和兼容入口消费同一契约，业务数据与事务仍由 Backend 负责。
- 修改公开导出检查直接消费方并重建共享产物，验证实际 HTTP MCP 与受影响兼容入口。不能跨 workspace 引用源码绕过包导出及构建边界。
- `agent-instructions.md` 是产品运行时提示词；维护工程规范不顺带修改它，也不覆盖用户工作空间的指令。
