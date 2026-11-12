# 画布存储优化：节点拆表与验证

## 设计与兼容边界

活动画布从单一 JSON 拆成项目头、`canvas_nodes` 和 `canvas_connections`，于 schema 51 引入，当前格式为 schema 53。`canvas_projects` 保留主键、时间和开放项目字段；节点、连线按 ordinal 保留原数组顺序。referenceCatalog 留在项目头；H3 Segments 留在所属节点中。对外 CanvasProject 与 ops 输入输出形状不变。

浏览器继续保存 `{project, base, queueVersion:2}`。缺失完整基线时 project 是离线恢复种子，不能因服务端拆表删掉。媒体文件、storageKey、正式制作数据与已发布版本不做本轮迁移。

## 模块与代码位置

| 模块 | 实现入口 | 责任 |
|---|---|---|
| 存储层 | [canvas-project-storage.ts](../backend/src/stores/canvas-project-storage.ts) | 原始项目组装、一致读取、节点/连线局部写入；写入要求调用者事务 |
| 升级 | [storage-format-migration.ts](../backend/src/storage-format-migration.ts)、[database-schema.ts](../backend/src/database-schema.ts) | 52→53 原子格式收敛；新库直接创建最终结构 |
| 权威接入 | [db.ts](../backend/src/db.ts) | 创建、ops、摘要、索引、选区、H3上下文与版本读取 |
| 共享资产 | [drama-asset-library.ts](../backend/src/canvas/drama-asset-library.ts)、[canvas-asset-attribution.ts](../backend/src/canvas/canvas-asset-attribution.ts) | 原始读取与消费者查询覆盖新节点、连线布局 |
| 历史维护 | [history-maintenance.ts](../backend/src/canvas/history-maintenance.ts)、[rebalance-canvas-history.ts](../backend/src/maintenance/rebalance-canvas-history.ts) | 完整快照比较、历史回放与指纹；拒绝旧布局计划 |
| 保留策略 | [runtime-history-policy.ts](../backend/src/maintenance/runtime-history-policy.ts) | 扫描拆出字段中的任务/日志引用，不修改保留政策 |
| 诊断与基准 | [audit-canvas-storage.ts](../backend/src/maintenance/audit-canvas-storage.ts)、[canvas-storage-benchmark.ts](../backend/src/maintenance/canvas-storage-benchmark.ts) | 只读容量报告与独立临时库合成对照 |

## 数据与事务

- canvas_nodes 主键为 project_id + node_id，完整 node_json 保留未知插件字段。
- canvas_connections 主键为 project_id + ordinal，完整 connection_json 不新增连接 ID 唯一约束。
- node_count / connection_count 为事务内维护的摘要；presence 字段区分缺省数组与空数组。
- ops 继续在一笔事务中保存变化行、项目 revision、操作批次和幂等回执；外层制作事务复用 SAVEPOINT。
- 未变化节点和连线不 UPDATE。第一版仍遍历节点以判断持久值变化，不保证消除全部随画布规模增长的 CPU 开销。
- 历史 checkpoint 仍是完整画布，历史批次通过 json-storage 读取当前 TEXT/Brotli；恢复旧 revision 不读取当前节点代替旧快照。
- 历史压缩编码在主提交后、第二个写事务开始前计算。失败保留合法明文，不把成功提交报告成失败。

## 迁移、部署与恢复

升级入口先创建并验证一致性备份；52 以下库先由上一版升级。52→53 在单个事务中转换旧编码、逐行回读核对并登记版本。非法 JSON、头 ID 不匹配、非法数组及重复/无效节点 ID 拒绝迁移，不能静默修复或丢弃。

部署前核对实际 Backend 进程、媒体任务、Agent 当前回合、生产代理与编译忙碌状态。先验证备份副本，再加载真实迁移。旧 Backend 必须拒绝新版本库。切换后没有新写入时可以恢复备份；有新写入时保留最新库向前修复，不用旧备份覆盖新编辑。

本轮不执行任务/历史/媒体删除或 VACUUM，不把逻辑容量、文件容量和磁盘回收混为同一收益。

## 验证

新增存储与迁移测试检查未知字段、数组 presence、顺序、局部写入、事务回滚、异常结构和读取事务释放。[集成测试](../backend/src/canvas/project-storage-integration.test.ts)检查真实旧版本文件的备份/迁移/重开、单节点更新、journal失败原子回滚、嵌套事务及不依赖整图加载的定向查询。

合成基准使用固定种子、200/1000/5000 节点、普通与H3数据分布，预热5次、采样30次；时间不作为不稳定的CI硬阈值。报告须标明合成存储基准与真实业务耗时的差别，不能承诺固定提速比例。

实施记录与实际运行证据由最终交付报告提供；源码、构建、服务加载、真实库迁移和浏览器人工验收分别记录。

## 在线热路径

完整读取仍逐条验证JSON与节点身份，并按ordinal恢复顺序。查询直接使用存储行字段别名，项目头和计数同次读取，避免额外元数据查询和两次数组映射。新解码图由当前读取独占，展示投影不再深拷贝整图；外部新建/导入入口仍保持默认深拷贝。

ops在一笔事务内复用已解析快照作为编辑图，细粒度持久化继续使用独立的原始JSON字符串前像。保留提交后的确认读取、共享资产投影和历史revision回放，不引入跨请求画布缓存。不完整的分表布局仍拒绝读取，不能静默遗漏节点或连线。


## 当前格式收敛

新版最低升级基线为 schema 52，新库直接创建完整 schema 53；1–51 的业务升级链不随日常 Backend 携带。旧备份先由上一版升到 52。52→53 备份验证后原子转换通用 JSON 列中的旧 gzip 和旧制作回执，逐行核对原文；失败回滚，成功后正常存储层只支持分表及当前 TEXT/Brotli。小 JSON 的 TEXT 策略、未知字段、presence、历史版本和请求身份保持。旧格式解码仅在一次性迁移和只读/显式维护工具边界。
