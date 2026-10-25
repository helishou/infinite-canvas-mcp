# rh-flow

独立的 RunningHub 工作流小工具：**不依赖 Infinite-Canvas，不依赖任何 npm 包**，只需要 Node 22+。
把本机 ComfyUI 的 JSON 直接推到 RunningHub，或把云端工作流拉回本地文件。

```
tools/rh-flow/
├── rh-flow.mjs   # 单文件 CLI（约 500 行，零依赖）
└── README.md
```

整目录拷到任何地方都能跑：`node rh-flow.mjs help`。

## 用法

```bash
# 推一个工作流（UI 格式或 API 格式都行）
node rh-flow.mjs push "./我的工作流.json"
node rh-flow.mjs push "./我的工作流.json" --name "云端显示名" --site cn
node rh-flow.mjs push "./我的工作流.json" --dry-run      # 只看预处理结果，不上传

# 从云端读回（API 格式 JSON）
node rh-flow.mjs pull 2106635646965211138 --api-key <OpenAPI Key> --out ./out

# 看看能不能自动找到浏览器里的登录令牌
node rh-flow.mjs token --site cn
```

### push 选项

| 选项 | 说明 |
| --- | --- |
| `--name <名字>` | 云端工作流名，默认取文件名 |
| `--site cn\|ai` | 站点，默认 `cn`（runninghub.cn） |
| `--token <JWT>` | 网页登录令牌；不给则自动从 Edge/Chrome 的 Local Storage 读 |
| `--no-tail` | 不注入 `Play Sound KJ → Save Image To Local` |
| `--keep-model-paths` | 保留模型文件名的目录前缀（默认去掉） |
| `--dry-run` | 只做本地预处理并打印结果 |

### pull 选项

| 选项 | 说明 |
| --- | --- |
| `--api-key <KEY>` | RunningHub OpenAPI Key（必填） |
| `--site cn\|ai` | 站点，默认 `cn` |
| `--out <目录>` | 输出目录，默认当前目录 |

## push 会对文件做什么

1. **格式识别**：带 `nodes`/`links` 的是 ComfyUI 编辑器格式（UI），转成 API 格式用于提交；`class_type` 的是 API 格式，直接用。
2. **模型路径去目录**：`H3\minimax_h3_video_vae.safetensors` → `minimax_h3_video_vae.safetensors`。云端模型是平铺的，带目录选不中。只动模型加载器上的模型文件名，素材路径（LoadImage 的图片名）不动。
3. **尾节点**：在最后一个输出节点后面接 `Play Sound KJ` → `Save Image To Local`（图像和视频输出都接这一条，`any_output` 是万能类型）。已有这两个节点则跳过。
4. **上传**：UI 原件优先传给平台（编辑器只认它）；只有 API 格式时也能传，但平台编辑器里看不到节点，只能走 OpenAPI 运行。

## 两个令牌不是一回事

| 用途 | 需要什么 | 从哪来 |
| --- | --- | --- |
| `push`（上传工作流） | 网页登录令牌 `Rh-Accesstoken` | 浏览器登录后，F12 → Application → Local Storage → `Rh-Accesstoken`；或让工具自动读 |
| `pull`（读回工作流） | OpenAPI Key | RunningHub 个人中心生成 |

自动读令牌会扫描 Edge/Chrome 各 profile 的 `Local Storage/leveldb`，按站点匹配（`rhtv.runninghub.cn`、`www.runninghub.ai` 这类子域也算）。
浏览器正在运行时会锁文件，读不到就复制一份或用 `--token` 手工传；LevelDB 偶尔会存下被截断的值，`token` 命令会打印长度和段数，段数不足 3 就说明缺签名，需要手工复制完整值。

## 已知限制

- **新上传的工作流是草稿**：平台要等你在网页端打开并跑一次才把节点图入库，在那之前 `pull` 读不回来（会明确报错提示）。
- **`Save Image To Local` 只吃 IMAGE**：视频输出接到它上面时，收尾节点可能在运行末尾报错（视频本身已经产出）。这是平台节点的输入声明决定的，工具只是按约定接线。
- 上传会**新建**一个云端工作流，不会覆盖已有工作流；同名多次上传 = 多份。

## 与主项目的关系

这里的预处理规则（UI→API、模型路径、尾节点）与 Infinite-Canvas 后端 `runninghub-workflow-tail.ts` / `runninghub-model-paths.ts` /
`comfyui-workflow-conversion.ts` 保持一致，但代码是**独立副本**，为的是这个目录可以单独拷走。
改规则时两边要一起改。
