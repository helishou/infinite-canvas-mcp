# Backend 开发约定

继承[根约定](../AGENTS.md)。凡涉及画布、任务、媒体绑定、引用或同步，先读[数据契约](../.agents/rules/canvas-contracts.md)。

## 职责与入口

- `src/server.ts` 与 `src/server/` 提供 HTTP；`src/mcp.ts` 提供共享 MCP；`src/canvas/` 管画布业务；`src/stores/` 与 `src/db.ts` 管持久化；`src/workflows/`、`src/comfyui/`、`src/runtime/` 管执行。
- 路由负责入参、鉴权和响应，业务复用既有 service/store。MCP、网页与后台任务共享逻辑，不各造一套任务、节点位置或结果回填。
- Backend 消费 `@basketikun/canvas-agent` 的导出契约。修改共享 schema/operation/reference 逻辑时检查生产者、校验、持久化、广播与读取端，不只改一个类型声明。
- 查询在存储层做项目过滤和分页，不先截断固定数量再在内存中过滤并宣称结果完整。

## 数据、媒体与执行

- SQLite 是业务权威；媒体在 Backend 媒体目录。数据目录读取实际配置，不根据仓库位置、历史本机路径或端口猜。
- 文件、目录和存储格式迁移：先备份，复制后校验，确认索引与文件一致再切换；保留原文件，不因字段冗余就直接删掉用户唯一记录。
- 通用任意文件资产复用媒体与资产记录；保留文件名/MIME/扩展名/字节数/storageKey，按所属项目隔离。清理前检查共享关系。
- ComfyUI 安装目录只承载执行缓存；设置它不得改 MEDIA_DIR。输入按需准备，输出归档回 Backend。
- AI Key 随渠道配置存 SQLite，浏览器和 Backend 均可能按执行器读取使用；日志脱敏，不把密钥放 URL 或对外宣称只驻留某一端。
- 用户自定义脚本留在浏览器沙箱，不能搬到 Node 用 new Function/vm 执行；任务创建、认领、终态和结果权限见数据契约。

## MCP 与运行现场

- 外部客户端连接常驻 Backend `/mcp` Streamable HTTP。session 上下文隔离，插件声明轮询由 Backend 统一维护；stdio 仅兼容。
- HTTP session 在进程内存中，服务重载后须让客户端重新初始化；不要误判成项目数据丢失，也不要为每个会话新建业务 Backend。
- `npm run dev --workspace backend` 当前为 tsx 源码执行而非 watch。只有实际消费 dist 时才必须重建 Backend；共享包 dist 变更也要确认已被当前进程加载。
- 端口、lock 文件和进程名都不是唯一证据；核对命令行、端点响应和相关日志，不批量清理服务。

## 改动验收

- 路由/契约变更验证受影响输入、返回值和拒绝路径；幂等提交验证重复请求不会再次执行或扣费。
- 迁移与并发场景使用临时数据库/项目，覆盖原数据保护、事务回滚、revision 和回执；不能在真实用户数据上“试一下迁移”。
- 生成链验证 taskId → 子任务/promptId → 归档媒体 → 活动节点绑定；ComfyUI success、目录里有文件或旧结果存在都不代表验收。
- 模型或工作流新增优先扩展已有执行器注册和输入契约；不要为每个模型再开专用 MCP/API。
- H3/ComfyUI 排障方法按需读[工程 Skill](../.agents/skills/canvas-h3-implementation/SKILL.md)。
