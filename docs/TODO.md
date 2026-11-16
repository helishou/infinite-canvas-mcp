# TODO — 待清理项

## 执行引擎 comfyui2api 是画布仓库的子仓库（2026-11-16）

引擎从画布单体里拆出来了，现在是画布仓库的 **git submodule**：

```
Infinite-Canvas-MCP/
└─ comfyui2api/        # submodule → git@github.com:helishou/comfyui2api.git (branch=main)
```

- 画布只记录提交指针，引擎自己的依赖与构建不影响画布仓库
- 引擎数据目录独立：`~/.comfyui2api`（DB `comfyui2api.sqlite` + 工作流 + 媒体 + 日志）
- 新克隆后：`git submodule update --init`，再在 `comfyui2api/` 里 `npm install && npm run build`（`dist/` 不入库）
- 起服务：`comfyui2api/start-engine.bat`（`%~dp0` 定位，搬目录不用改脚本），端口 8300

## 解耦现状（已达成）

- **画布 `backend/src` 对 `@basketikun/media-engine` 的真实 import 为 0**；契约全部落在 `backend/src/engine-contract/`（`contracts` / `duration` / `generation-settings` / `submission-outcome` / `slow-operation` / `redact-inline-media` / `dirs` / `events` / `media-tools` / `workflow-catalog` / `runninghub-proxy` / `instances` / `ui-workflow-file`）
- **双方只走 HTTP**：画布 → 引擎用 OpenAI 风格 `/v1/*` + 控制面 `/api/*`
- **工作流管理**：`engine-contract/workflow-catalog.ts` 直连引擎 `/api/workflows*`，按 `/health` 探测选渠道（ai.config 里那个指向 3900 的旧 local 渠道不能盲取）
- **本地 ComfyUI 直连已下线**：`local-comfyui`（8188）渠道删除，`/comfy/*` 只做状态代理与媒体桥；模型/预设/预设执行返回 410
- **RunningHub 走引擎**：画布只保留 `/agent/runninghub/*` 代理（`engine-contract/runninghub-proxy.ts`），已退役路径返回 410

## H3：只保留「自选视频模型」一条链路

- `CanvasH3Runner` 的 `comfy` / `runningHub` 依赖与原生执行分支已删除（`comfy.run("minimax-h3")`、`runningHub.queue.*`、潜空间种子准备）
- 每个 Clip 通过 `videoDispatcher.start({ model: 选中的视频模型 })` 出片，默认 `engine-local::H3 展开流`
- 老 Clip 的模型默认值由插件一次性迁移写回 metadata（`useH3Segments`）；不落盘会触发 `H3_UI_PARAMETER_MISMATCH`
- 三处「自选视频模型」开关改成常开不可点

## 运行位置 = 工作流参数（引擎侧，画布不感知）

| 参数 | 取值 | 行为 |
|---|---|---|
| `runTarget` | `local` | 本地 ComfyUI（默认） |
| `runTarget` | `cloud` | 走 `runningHubProfileId` 绑定的 RunningHub 档案；未绑档案直接报错，不静默回落 |
| `runningHubProfileId` | RH 档案 id | 「RunningHub」页发布本地工作流后生成 |

## 待清理

1. `backend/src/canvas/h3-runner.ts` 的原生残留：确认/二采/续写相关分支与类型（执行链已不走）
2. `plugins/canvas/minimax-h3` 旧链路残留：`H3Runner.tsx` 的原生预览轮询、`services/h3-run-control.ts` 的 reset/cancel 分支
3. 画布 web 对 `/comfy/models`、`/comfy/presets`（已 410）的调用面逐页确认
4. 引擎控制面接口（`/api/models`、`/api/workflows`）的字段说明补进 README
5. RH 云端真跑未验收：当前 `apiKey` 为空、`/api/runninghub/profiles` 为 `[]`

### 参数取舍记录

H3 走引擎「H3 展开流」后**不再支持**：Motion Context 续写、潜空间二采确认（一采/二采两段式）、DLSS 超分补帧、人脸精修、TE 加速。
可用字段：`prompt` / `reference_image_1` / `width` / `height` / `frames` / `seed` / `steps` / `sampler`。
