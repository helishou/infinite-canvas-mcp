# 画布存储容量优化

## 容量口径

分别报告活动数据库逻辑字节、SQLite文件及空闲页、原始媒体唯一物理文件和备份。硬链接的多个路径不等于多份物理数据，不能把目录逻辑大小相加后当作可回收量。节点拆表主要减少局部写入，不会自动压缩已有历史。

## 无损编码

[共享 JSON codec](../backend/src/json-storage.ts)只读取当前 TEXT 和 `ICBR1` Brotli BLOB。Brotli 使用 Node 内置实现、quality 4；小 JSON 保持 TEXT，常规在线大 JSON 只执行一次 Brotli 压缩，结果更小时保存为 BLOB。制作回执始终写 Brotli。TEXT 是当前小值策略，不是旧库回退路径。

最低升级基线为 schema 52。更早库或备份必须先用上一版 Backend 升到 52；新版拒绝直接打开，且不会先修改或备份不支持的库。新库直接创建当前完整 DDL，不再执行 1–51 升级链。52→53 先校验一致性备份，然后在一个事务内逐行转换旧 gzip、收敛回执，精确核对原始 JSON 文本后写版本；任意失败回滚数据与版本。已是当前编码的行校验后原字节保留。

旧 gzip 解码只在 [一次性升级模块](../backend/src/storage-format-migration.ts) 与离线重编码工具存在，业务路径不再分派旧格式，画布读写不再探测旧整图布局。已移除会重新写 gzip 的 `compress-snapshot-json` 和 `compress-production-receipts` 命令，统一使用下述 repack。独立编译作业/连续性报告的专用 `*_gzip` 列仍使用其自身当前格式，不属于此次通用 JSON 列迁移。

新生成日志和任务的大参数直接压缩。SQL JSON查询与引用保留扫描先解码，避免压缩后模型统计、旧日志去重或父子任务保护丢失。

## 维护入口

[repack-json-storage.ts](../backend/src/maintenance/repack-json-storage.ts)默认只读预览，不构造BackendDatabase，不触发迁移。仅处理固定允许表列：制作操作与准备回执、任务输入和参数、画布批次操作和结果、生成日志参数。活动画布、正式版本、媒体和其他配置保持原样。

```powershell
# 在backend目录；不加--apply只报告收益
node --import tsx src/maintenance/repack-json-storage.ts --db <database-file>
# 显式应用，验证已有一致性备份；--vacuum回收SQLite文件空闲页
node --import tsx src/maintenance/repack-json-storage.ts --db <database-file> --apply --backup <verified-backup-file> --vacuum
```

转换保留原JSON文本的精确UTF-8字节，包括空白与数字写法。先验证完整源和备份，再逐行在写锁外压缩、事务内比较原值与完整业务主键、CAS更新并解码回读核对。并发变化的行保留新值并报告，不覆盖。维护按各表真实唯一主键寻址，并验证允许列与主键布局；不依赖可能在备份回收中变化的行号。损坏或未知编码拒绝转换，不当空对象处理。

逻辑字节降低后才执行物理回收。回收前核对运行任务、Agent回合、生产代理、编译及写请求；备份独立保留。历史、版本和媒体没有被删除，已有请求身份仍能查询和重放。

## 验证与交付

测试覆盖迁移边界的 TEXT/gzip/Brotli、当前读取拒绝旧 gzip、损坏拒绝、逐字节往返、备份不匹配、主键布局拒绝、CAS竞态、回读失败回滚、重复维护、SQL查询和压缩参数的任务族保护。真实库应用之前先在副本验证，再报告文件大小、逻辑字节、行数、解码摘要和完整性结果。备份空间单列，不把保留备份计入活动库缩容收益。
