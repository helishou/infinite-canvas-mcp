# 本地自定义工作流图片槽位问题交接文档

> **状态：已彻底修复（2026-09-07 终验通过）** — 见末尾「修复结论」。
> ⚠️ **真凶 = 参数顺序写反**：`run()` 调用 `processImageFields(config.fields, fieldValues, workflowJson, …)`，
> 但函数签名是 `(fields, **workflow**, **fieldValues**, …)`，于是 `fieldValues` 与 `workflowJson` 对调。
> 结果 `processImageFields` 内部把 workflow 当成 fieldValues 来读，每个图片字段都读到 `undefined` → 变 `null` →
> `injectParams` 把每个 `LoadImage.inputs.image` 删空 → `removeEmptyImageNodes` 删掉**全部** LoadImage →
> `validatePromptGraph` 对任意输入（哪怕 3 张图）都抛 `315→155`。**这才是"怎么传图都报同一个错"的唯一原因。**
> 裁剪/尺寸路由/静态校验逻辑本身从一开始就是对的，之前几轮改的是假想敌。
> ⚠️ **配套经验**：backend 线上跑的是编译产物 `backend/dist/index.js`（`npm start`=`node dist/index.js`，HTTP 独占 17370），
> 改 `backend/src/*` 后必须 `npm run build` 重编 dist 再重启（或长期改用 `tsx --watch src/index.ts`）。

## 当前问题

重新导入 `Flux2-Klein.json` 后，通过本地工作流运行图片生成，单图或少于全部图片槽位时仍可能报错：

```text
Backend POST /api/workflows/custom%2FFlux2-Klein.json/run failed
HTTP 500 ComfyUI /prompt failed: HTTP 400
```

典型错误包括：

```text
ImageScaleToTotalPixels.required_input_missing: image
Cannot read properties of null (reading 'inputs')
KeyError: '155'
Prompt has no outputs
task not found
```

## 已确认的工作流结构

当前 `Flux2-Klein.json` 的图片分支不是 `LoadImage` 直接接到业务节点，而是：

```text
LoadImage
  -> ImageScaleToTotalPixels
  -> VAEEncode
  -> ReferenceLatent
  -> ComfySwitchNode
  -> CFGGuider
  -> SamplerCustomAdvanced
  -> VAEDecode
  -> SaveImage
```

同时图片分支还参与尺寸链：

```text
LoadImage
  -> ImageScaleToTotalPixels
  -> GetImageSize
  -> Flux2Scheduler / EmptyFlux2LatentImage
```

因此只删除 `LoadImage.image` 会留下必填的 `ImageScaleToTotalPixels.image`；递归删除所有下游又可能误删采样器、解码器或最终输出节点。

## 原项目的实现方式

参考项目：

```text
E:\无限画布\Infinite-Canvas
```

关键代码在：

```text
static/js/canvas.js
static/js/smart-canvas.js
```

核心函数：

```text
rhFieldKind
rhFieldIndexes
rhBuildNodeInfoList
rhBuildWorkflowRequestExtras
rhPruneWorkflowForMissingFields
```

原项目流程：

1. 通过 `fieldType`、字段名和默认值识别 image 字段。
2. 通过 `rhFieldIndexes()` 给多个图片字段建立稳定的 0、1、2 索引。
3. 非必选且没有实际图片的字段不加入参数列表。
4. `rhPruneWorkflowForMissingFields()` 只删除该字段所在节点及直接连接。
5. 工作流本身需要设计为删除该节点后仍有有效输出路径。

原项目没有对所有下游节点做通用递归删除。

## 当前项目相关改动

主要文件：

```text
backend/src/workflows/executor.ts
backend/src/db.ts
backend/src/workflows/routes.ts
backend/src/workflows/store.ts
web/src/services/api/workflows.ts
web/src/pages/canvas/project.tsx
web/src/pages/image/index.tsx
web/src/components/workflow-custom-fields.tsx
web/src/components/canvas/canvas-image-settings-popover.tsx
```

当前已有能力：

- `WorkflowField` 增加 `required?: boolean`。
- 前端可根据 `LoadImage` 节点识别图片字段，即使字段类型被错误保存成 `number/text`。
- 多图片字段按字段顺序映射参考图。
- 图片字段不显示在普通工作流参数面板。
- 工作流任务类型为 `workflow`，画布轮询接口已允许查询该类型。
- 工作流管理支持删除节点和删除工作流。

## 当前疑似根因

`backend/src/workflows/executor.ts` 的 `removeEmptyImageNodes()` 仍然把“工作流字段级可选图片”直接映射为“删除节点级图片分支”。

对 Flux2-Klein：

- 一个空槽位可能对应一整条预处理链。
- 这条链可能被 `ComfySwitchNode`、尺寸节点和输出节点共同引用。
- 删除某个节点后，必须同步决定下游连接是删除、切换到另一条路径，还是保留一个合法的占位输入。
- 不能简单用“所有依赖该节点的节点都递归删除”的通用规则。

此外，重新导入后的配置字段可能存在以下不一致：

- `field.node` 可能包含单节点 ID，也可能包含逗号分隔的多个节点 ID。
- `field.type` 可能没有正确识别为 `image`。
- `field.default` 可能是旧文件名、数字 0 或空值。
- workflow JSON 可能包含 `null` 节点。

## 复现步骤

1. 启动 backend 和前端。
2. 在工作流管理中重新导入：

   ```text
   Flux2-Klein.json
   ```

3. 在节点图中确认有 3 个 `LoadImage` 节点。
4. 选择该本地工作流运行。
5. 分别测试 0、1、2、3 张参考图。
6. 查看 backend 日志中最终提交给 ComfyUI 的 prompt JSON。

重点核对：

- 未传入的图片字段实际对应哪个 `LoadImage` 节点。
- `291`、`271`、`294` 是否还存在。
- `157`、`152`、`156` 的尺寸链是否有效。
- `315.images` 是否仍然引用存在的 `155`。
- `ComfySwitchNode` 的 true/false 输入是否指向存在节点。

## 建议排查顺序

1. 在 `WorkflowExecutor.run()` 中打印最终 `prepared` workflow 的节点列表和所有连接引用。
2. 对每个连接 `[nodeId, slot]` 检查 `prepared[nodeId]` 是否存在且非 null。
3. 确认空图片字段是否只对应 optional 字段，不要把已传入字段加入 `missing`。
4. 参考原项目先实现“字段级裁剪”，不要先做全图递归删除。
5. 针对 Flux2-Klein 单独定义图片分支裁剪规则：
   - 空图片分支节点集合。
   - 分支切换节点。
   - 尺寸输入来源。
   - 必须保留的输出节点。
6. 在调用 ComfyUI `/prompt` 前做静态图校验：
   - 所有连接目标节点存在。
   - `SaveImage` 存在且可达。
   - 不存在 `LoadImage` 或 `ImageScaleToTotalPixels` 的空必填输入。
7. 只有 prompt 提交成功后才让前端进入任务轮询；提交阶段失败应直接返回 failed，不应继续等待远程 task。

## 重要约束

- 不要修改用户重新导入的原始 workflow JSON；只生成运行时副本。
- 不要删除最终 `SaveImage` / `PreviewImage` 输出节点。
- 不要用默认尺寸或空图片占位符掩盖工作流连接错误。
- 不要把 `task not found` 当作 ComfyUI 根因；它通常是提交失败后前端继续查询任务的二次错误。
- backend 修改后必须重启。

---

## 修复结论（2026-09-07 终验通过）

### 根因（唯一真凶 = 参数顺序写反）
`backend/src/workflows/executor.ts` 的 `run()` 调用：

```ts
// 错误：fieldValues 与 workflowJson 位置写反
await processImageFields(config.fields, fieldValues, workflowJson, url, controller.signal);
```

而函数签名是：

```ts
async function processImageFields(fields, workflow, fieldValues, comfyUrl, signal)
```

`fieldValues` 与 `workflowJson` 对调后，函数内部把「整张 workflow 图」当成 `fieldValues` 来读：
每个图片字段的 `fieldValues[field.id]` 都变成 `undefined` → `processImageFields` 把它置为 `null` →
`injectParams` 随即**删除**该 `LoadImage.inputs.image` → `removeEmptyImageNodes` 把**全部** LoadImage 视为空并删除 →
`validatePromptGraph` 对任意输入（哪怕一次传 3 张图）都抛 `节点 315 (SaveImage) 的输入 images 指向已被裁剪的节点 155`。

**这就是"怎么传图都报同一个错、重启也没用"的唯一原因。** 之前的「裁剪级联规则」几轮修改都是在打假想敌——
裁剪 / `routeSizeImage` 尺寸路由 / `validatePromptGraph` 静态校验逻辑本身从一开始就是对的，只是被参数写反这个 bug 全盘架空了。

（配套坑：线上 backend 跑的是 `backend/dist/index.js`，只改 `src` 不重编 dist，这个写反的调用也一直留在旧 dist 里。）

### 改动（只有一行是根因修复，其余为配套）
1. **【根因】`run()` 参数顺序修正**（executor.ts:445）：
   `processImageFields(config.fields, workflowJson, fieldValues, url, controller.signal)` —— 把 `workflowJson` 与 `fieldValues` 放回正确位置。
   这行一改，`processedValues` 对传入的图片返回上传后的文件名、对空槽返回 `null`，下游裁剪/路由/校验全部按预期工作。
2. **`routeSizeImage()` 智能尺寸路由**（保留）：Flux2-Klein 输出尺寸由 `GetImageSize`(157) 取自尺寸源 LoadImage(278)，默认开关下主参考 latent 也经 278 链。
   若用户只给了别的图（270/292），裁剪前把 `ImageScaleToTotalPixels`(291) 的 `image` 改接到用户实际提供的图，使**任意单图**都能拼出有效工作流。
3. **开关感知级联 + 静态校验** `removeEmptyImageNodes` / `validatePromptGraph`（保留，逻辑正确）：
   普通节点「任一连线失效即删」、`ComfySwitchNode`「仅选中分支失效才删」、`SaveImage/PreviewImage` 永保留；
   提交前校验存活节点的原始连线是否指向已删除节点，给出清晰中文错误而非 500。
4. **routes.ts**：补 `clientTaskId?` 到请求体类型，消除此前阻断 `tsc` 生成 dist 的编译错误（不修则 `npm run build` 失败、dist 不更新）。

### 验证（终验，真实图 + 真实代码 + mock ComfyUI 端到端）
- 用真实 `Flux2-Klein.json` 跑 **7 种图片组合模拟**：仅 A(270)/仅 B(278)/仅 C(292)/A+B/B+C/A+C/A+B+C 全部 `OK`（无悬空连线）；仅 0 图被清晰拦下。
- **端到端实跑**：起 mock ComfyUI（/upload/image、/prompt、/ws、/history、/view），向重建后的 backend 发「仅 1 张图（node 270）」请求 →
  `HTTP 200`，返回 `{ promptId:"mock-prompt-1", outputs:{315:{images:[…]}}, media:[…] }`，即完整跑通上传→裁剪→提交→收图全流程。
- 复现前的失败请求（带 3.2MB dataURL）现在也会走通：日志从「裁剪校验未通过 315→155」变为「上传图片」→「提交 prompt」。

### 残余约束（非 bug）
- 0 图（完全不传参考图）仍会被拦下 —— 工作流本身要求至少一张参考图，属合理约束。
- 配套经验：改 `backend/src/*` 后务必 `cd backend && npm run build` 重编 dist 并重启（或改用 `tsx --watch src/index.ts` 免重启）。

