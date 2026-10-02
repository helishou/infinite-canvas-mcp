# H3 执行链排查

触发：输入未生效、ComfyUI 没收到任务、完成却无媒体、取消或恢复异常。任务与媒体所有权见[数据契约](../../../rules/canvas-contracts.md)。

## 当前链路

`H3Runner → ctx.flush → ctx.ai.runCanvasGeneration → Backend CanvasGenerationService → CanvasH3Runner → ComfyUiBackend/对应引擎 → 媒体归档 → ops 回写`

MCP H3 工具同样进入 Backend 服务，不在浏览器/MCP 各自循环执行片段。当前主要源码：

- `backend/src/canvas/generation-service.ts`、`h3-runner.ts`、`h3-task-writeback.ts`
- `backend/src/comfyui/bridge.ts`
- `canvas-agent/src/plugins/minimax-h3/mcp.ts` 与共享参数/参考契约

## 输入与执行图

1. 核对本轮 projectId、nodeId、segmentId、taskId 和编译后的参考绑定顺序；从实际提交快照取证，不只看 UI 元数据。
2. 读取实际执行的工作流分支和当前安装节点的 object_info/源码。节点有同名字段、旧 widgets 槽位或设置 pack，不证明参与运行。
3. 将提示词、图片/视频/音频、模型、LoRA、尺寸与设置沿共享白名单追到最终节点输入。模型/工作流路由以真实输入数量与配置判定。
4. 素材已在 input 目录还不够；自定义节点若使用下拉校验，应能枚举命名空间子目录和本次相对路径。
5. 使用展开图时，释放/加载等副作用节点必须具有真正执行依赖；不要只在 JSON 中声明孤立节点。原生生成节点与展开图的行为以当前分支实证比较，不复用旧版差异清单。

## 观察与回写

- WS 以本 task 的 clientId 建连，提交后按精确 promptId 匹配事件；execution_success 不保证带 outputs，中间空输出不代表最终视频可用。
- 按节点合并输出并经 collectOutputMedia 确认最终媒体；缺少时查询目标 history，不扫描最近成功记录兜底。
- Backend 重启后从原 submitted 事件恢复 promptId 观察；没有原提交证据不能新跑一次后称为恢复。
- 取消跟踪父任务与子任务，核对队列删除/interrupt 作用到正确执行，不能直接从浏览器清全局队列。
- 验收同时看任务终态、媒体数量、MIME/字节可读、归档 storageKey 与活动 Clip 绑定；排查使用 API 实际路径，不猜媒体磁盘目录。

## 视频后处理与脸修

- 先区分参数打包节点与可执行节点；后处理须真实接收帧/文件并输出媒体，或由 Backend 编排独立阶段。
- 沿 UI/共享参数/任务输入/图构造检查开关与参数，防止“看起来开启、执行未开启”。
- 要保留音频时只替换画面并复用原音轨；内部使用 Audio VAE 不代表重新生成音轨符合保留要求。
- 检查输出来自后处理终点、关闭开关时原流程与缓存语义保持一致，以及分段/跟踪/贴回连续性。
- 无 ComfyUI 运行环境时可以完成代码与输入契约检查，但须明确尚未实跑。
