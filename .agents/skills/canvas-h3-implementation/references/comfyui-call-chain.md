# H3 插件 → ComfyUI 调用链（2026-09 更新）

插件永不直连 ComfyUI，全链路：

1. **H3Runner.run()**（浏览器插件）：读 `ctx.getNode()` 最新 metadata（不是 ctx.node 快照），取选中片段；校验素材（t2v 免素材，其他要 video/image）；引擎选择 `minimaxEngine==='runninghub' ? ctx.ai.runRunningHubH3 : ctx.ai.runLocalH3`。多片段：for 循环逐段提交，上一段 result 作 `previousVideo`（Motion Context 来源）。
2. **ctx.ai.runLocalH3**（use-plugin-host.tsx 注入）：`/health` 检查后台 → `/comfy/config` 拿 comfyUrl → fetchComfyStatus 探活 → 调 runLocalH3Task。
3. **runLocalH3Task**（web/services/api/comfyui.ts）：`syncReference` 把每个参考落地后端 runtime media（有 storageKey 直接复用，否则上传换 storageKey）→ `POST {agent}/comfy/tasks` body `{preset:'minimax-h3', input:{prompt,references,audios,video,previousVideo}, params, comfyUrl}` → 每 1.2s 轮询 `/comfy/tasks/:id` 直到终态。
4. **ComfyUIBridge**（backend/src/comfyui/bridge.ts）：`buildNanFengV10Workflow(input, params, uploadFn)` 把参数**复刻为 NanFeng V10 generate() 的 ComfyUI API prompt 图**（不是调现成接口）；素材先 `upload` 进 ComfyUI（/upload）再入图；`POST ${comfyUrl}/prompt` 拿 prompt_id。

### 工作流图执行链（关键！）

`buildNanFengV10Workflow` 的模型加载链路：

```
NanFengH3ReleaseAtStart(unet_name, clip_name, video_vae_name, audio_vae_name, reserved_vram_gb)
    │
    ├─(0) unet_name → UNETLoader.unet_name
    ├─(1) clip_name → CLIPLoader.clip_name
    │              NanFengH3ReleaseBeforeConditionLoaders.clip_name
    ├─(2) video_vae_name → VAELoader(video).vae_name
    │                   NanFengH3ReleaseBeforeConditionLoaders.video_vae_name
    └─(3) audio_vae_name → VAELoader(audio).vae_name
                        NanFengH3ReleaseBeforeConditionLoaders.audio_vae_name
```

**`NanFengH3ReleaseAtStart` 必须参与执行链**（不能只声明不连接），否则：
- 缺失日志 `VAE load device: cuda:0` / `Using MixedPrecisionOps for text encoder` / `Applying MiniMax H3 Memory Efficient Sage Attention Patch`
- 显存释放策略与 V10 不一致（实测峰值差 ~2000 MiB）
- `NanFengH3ReleaseBeforeConditionLoaders` 同理必须连接

## 结果回写机制（WS + /history 双通道 + 扫列表兜底）

Bridge 在提交 `/prompt` **之前**就建立 WebSocket 连接（`ws://.../ws?clientId=taskId`），监听 `executed` / `execution_success` 事件作为**主路径**——这些消息直接携带 outputs，无需再查 `/history`。

仅当 WS 没带回 outputs 时，才退回轮询 `${comfyUrl}/history/${promptId}`（每 1.5s）。

### 本地 H3 输入与最终媒体验收

- Canvas MCP 的本地媒体桥接可以把参考图放进 `ComfyUI/input` 的命名空间子目录，例如 `infinite-canvas-cache/output/<file>`；H3 自定义节点的素材选项必须递归枚举 `folder_paths.get_input_directory()` 下的相对路径，并统一使用 `/`，不能只用 `os.listdir(input_dir)`，否则文件虽然存在于磁盘和工作流参数中，ComfyUI 的下拉校验仍会拒绝它。
- 重启 ComfyUI 后先通过 `/object_info/NanFengH3MultiReferenceGeneratorV15` 检查 `图片1` 等选项是否包含本次实际提交的嵌套文件名；“文件在 input 目录里”不是充分证据。
- NanFeng H3 可能先发送只含 `{}` 的中间节点输出，再由 `VHS_VideoCombine` 产出 MP4。Backend Bridge 必须对每次 WS/history 输出执行 `collectOutputMedia`，只有 `media.length > 0` 才能关闭监听、标记成功并回写画布；中间输出或空媒体必须继续等待，history 兜底路径也要遵守同一条件。
- 端到端验收同时检查：任务终态、`media` 数量、`/media/<storageKey>` 返回的 MIME/字节流，以及画布 H3 节点的 `status`、`segment.status` 和 `result`。不能用 ComfyUI 的 `status_str: success` 或输出目录里出现文件替代画布回写验证。

### 为什么不能只靠 /history

ComfyUI 的 `/history` 是 **LRU 队列**（默认保留 10000 条），任务一多旧记录就被清理。`/history/{prompt_id}` 会返回：
- `undefined`（记录被清理）
- 空对象 `{}`（占位但无数据）
- 非 200 响应（如 404）

**重要**：`/history` 响应里**没有 `status.updated` 字段**！之前代码写的是 `entry?.status?.updated`，永远拿到 `undefined` → 0，导致排序无效、时间过滤永远 false。正确做法是从 `status.messages[i][1].timestamp` 取最大时间戳作为排序/过滤依据。

### 三级兜底策略

| 优先级 | 条件 | 行为 |
|--------|------|------|
| 1 | WS 收到 `executed`/`execution_success` 且带 outputs | 直接用 WS 消息的 outputs 回写（最快） |
| 2 | WS 没带回 outputs，但 `/history/{prompt_id}` 有记录 | 用 `/history` 的 outputs 回写 |
| 3 | `/history/{prompt_id}` 无记录/空对象/非 200（第 20 次） | **扫整个 `/history` 列表**，找最近有 outputs 的条目兜底 |

WS 提前断开时不再直接 throw fail，而是退回 `/history` 轮询 + 扫列表兜底。仅在 `/history` 也长期无果（结合 `/queue` 判断任务是否还在执行）后才最终 fail。

### 重启恢复（watchRecovered）

backend 重启会杀掉内存中的执行循环。`resume()` 发现 running/queued 任务时，用 events 里的 promptId 重新挂一个**纯 `/history` 观察循环**（无 WS 通道）。该循环同样有扫列表兜底逻辑（第 20 次无记录时）。

## 取消逻辑
- 已入队 → `POST /queue {delete:[promptId]}`
- 执行中 → `POST /interrupt`
- 前端：emit `minimax-h3:cancel` 事件 → `useH3RunEvents` 监听 → 调 `ctx.ai.cancelLocalH3Task` / `cancelRunningHubH3Task`

## 媒体 URL 回传
`proxyComfyMedia` 改写 ComfyUI 裸路径（相对 / Windows 路径）为后端 `/media/:storageKey` 代理，浏览器播放器只认 storageKey。

## 另一条入口（平行，别混淆）
`canvas-agent/src/plugins/minimax-h3/mcp.ts`：Agent MCP 工具 h3_list_models / h3_get_node / h3_run_clip / h3_get_task / h3_cancel_task / h3_update_clip / h3_run_all_clips。读取节点 metadata.segments 自己 collectRefs/extractParams（白名单键 H3_PARAM_KEYS），`context.comfyUi.run('minimax-h3', input, params)` 提交，轮询 comfyGetTask 并回写节点 metadata。用于 Agent 驱动，不走浏览器。

## RunningHub 引擎（legacy）
`runRunningHubH3` → `POST /runninghub/tasks`（backend/src/runtime/runninghub.ts），旧画布迁移节点用；参数透传 runninghubMode/WorkflowId/AppId/Fields/Params 等。

## 生成后脸修集成判定

给 H3 增加人脸修复前，先检查**实际执行代码**而不是字段名：

1. 查当前 ComfyUI 节点源码或 `/object_info/<ClassName>`，确认对应输入会进入 `generate()` 或 GraphBuilder；仅出现在 schema、旧工作流序列化槽或前端文案中的字段不算功能存在。
2. 沿 `H3Segment → H3_SETTINGS_KEYS → 浏览器/MCP 参数白名单 → ComfyUI workflow builder` 核对两条入口都透传；只补 UI 会造成“显示开启、提交未开启”。
3. 判断目标节点是**配置打包节点**还是可独立执行节点。打包节点只返回设置字典，不能直接接在已生成视频后；生成后处理必须有真正接收视频帧/文件并输出修复结果的执行节点，或由后端明确编排第二阶段任务。
4. 保留原音频时，让脸修只替换画面流，最终封装复用原生成音频；不要因 H3 联合 AV latent 内部需要 Audio VAE 就把音轨重新生成等同于“保留音频”。
5. 运行验证至少检查实际提交图含脸修执行节点、输出媒体来自脸修终点、关闭开关时图与旧缓存指纹保持不变；ComfyUI 未运行时只能交付静态检查，不能宣称功能已实跑。

南风 H3 的旧“小脸修复/全局修复”字段可能仅为旧工作流 widgets 序列化占位；必须以当前 Python 执行分支为准，禁止把这些字段直接映射到 UI 后宣称已实现。AIMixer Director 的 FaceRefine 节点当前是参数 pack，实际算法由 Director 内部调用；若要解耦为生成后处理，需显式包装执行入口并处理视频分段、跟踪连续性、贴回和音频复用。

## 按任务读取的工程约束

> 下列工程细节从技能入口移至此处。仅应用与当前任务有关的条款；路径 `references/`、`scripts/` 均相对于技能根目录。证据纪律、画布 MCP 留档、用户进程保护与当前明确要求优先。

## 关键陷阱：节点声明 vs 节点执行（2026-09 更新）
`buildNanFengV10Workflow` 里声明了 `NanFengHengH3ReleaseAtStart`（节点 id `nf_start`），但**只声明没连接** — 4 个标准 Loader（UNETLoader/CLIPLoader/VAELoader×2）直接用变量做输入，导致 `NanFengH3ReleaseAtStart` 虽然在图里但 ComfyUI 不执行它。

**症状**：日志里缺失 `VAE load device: cuda:0, offload device, dtype: torch.float16` / `Using MixedPrecisionOps for text encoder` / `Applying MiniMax H3 Memory Efficient Sage Attention Patch`。

**根因**：ComfyUI 节点的输入类型如果是 COMBO（如 UNETLoader 的 `unet_name`），不能直接接收另一个节点的 STRING 输出（`["nf_start", 0]` 形式）。这是 ComfyUI 引擎级的类型限制，不是连线问题。

**当前状态**：`NanFengH3ReleaseAtStart` 仍声明但不连接，回滚到直接变量 feed。MCP 与 V10 的日志和显存策略不一致。

**验证方法**：先 `curl http://127.0.0.1:8188/object_info/NanFengH3ReleaseAtStart` 看 `output_name` 确认输出端口名和顺序，再连线。

**排查线索**：用户报「日志跟 V10 不一样」「明明同一个 ComfyUI 版本日志不同」→ 检查工作流图里是否有节点声明了但输出未连接（未参与执行链）。

## V10 Python vs MCP 工作流图差异（2026-09）
详见 `references/v10-mcp-graph-diff.md`。核心差异：
- `ref_image_size`：V10 硬编码 `"max"`，MCP 默认 `"match"`
- VAE 解码：V10 用 `VAEDecode`，MCP 用 `NanFengH3TimedVideoVAEDecode`
- 第一个 LoRA：V10 全用 `LoraLoaderModelOnly`，MCP 第一个用 `LoraLoader`（改 CLIP）
- `NanFengH3ReleaseBeforeConditionLoaders`：V10 连接，MCP 未连接
- `NanFengH3NativePrefixLoraLoader`：V10 用于原生 LoRA 前缀转换，MCP 未使用
- MCP 独有的 `promptFlags` 追加（No dialogue / No subtitles）
