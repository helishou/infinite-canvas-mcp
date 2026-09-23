# 视频生产编排入口（画布 MCP）

SKILL.md「视频生产编排链路」的入口索引。**所有深度工程材料已下沉到 `canvas-h3-implementation/references/`，本文件只保留入口与判定规则**。判定不到位的，先回这里查方向，再去工程实现层查细节。

---

## 1. 执行器全表（`backend/src/canvas/executor-registry.ts`）

唯一权威入口：`modelRegistry` + `resolveCanvasExecutor()`。**新增模型只注册匹配项，不新增 MCP 工具**。

```typescript
export type CanvasExecutorId = "direct-image" | "builtin-comfy" | "comfy-workflow" | "h3" | "plugin";
```

| model / preset | mode | executor | 备注 |
|---|---|---|---|
| `gpt-image-*` | image | direct-image | 走 `chatgpt2api` :8000；多图直接读 `input.references` |
| `z-image` / `flux2-klein` | image | builtin-comfy | 本地 ComfyUI 内置工作流 |
| `custom/*.json`（或 `.json` 结尾） | image | comfy-workflow | 用户自定义工作流 |
| `minimax-h3:video` / preset `minimax-h3` | video | h3 | H3 视频执行器 |
| 有 preset 但无匹配 | — | plugin | 插件侧兜底 |

两个必须记住的分支：

- `direct-image` 声明在，但调方 `directImageSupports=false` 时会被 **skip 继续往下匹配**。
- 遍历完无匹配：有 `preset` 返回 `plugin`，否则抛错。所以「新模型」可以通过 preset 落到 plugin 执行器，不必改 registry。

## 2. 参考角色（reference role）推断入口

合法 role 集合（`canvas-agent/src/plugins/minimax-h3/video-plan.ts`，也是 `validateVideoPlan` 的白名单）：

```
character_turnaround | storyboard | scene | motion_reference | audio_reference
```

插件侧 `plugins/canvas/minimax-h3/src/types.ts` 的 `H3Ref["role"]` 多一个 `character_voice`（**仅兼容历史数据，不在白名单里，不要新写**）。

**推断规则（两处正则必须同步改）**：

- 插件：`plugins/canvas/minimax-h3/src/services/h3-refs.ts` → `inferredRole(type, title)`：`/四视图|turnaround/` → `character_turnaround`；`/分镜|storyboard/` → `storyboard`；`/场景|scene/` → `scene`。
- 宿主：`web/src/pages/canvas/project.tsx` → `canvasReferenceRole(node)`，同款正则。

`character_turnaround` 的 `subjectId` 取**该图片节点自身的 id**（两个入口都是 `node.id`），不是角色资产 id。

⚠️ `h3CharacterAssets` 读路径已被移除。找不到角色资产时按 `characterAssetId` + `metadata.characterImages` 快照去找，不要搜这个字段。

**角色资产/节点的两条拖拽路径（`h3-refs.ts`）**：

```
readH3Refs()                     // 生命周期上游节点；role 由 inferredRole 推断
  └─ if (node.type === "character") return []   // 角色节点是身份资产，不是四视图
readCharacterImagesFromDrop()    // 按 outfit 拆成多张普通 image ref，不占 role
readCharacterGroupFromDrop()     // 完整 H3CharacterGroup：outfits[] + voice{url,name,storageKey,assetId}
```

`readCharacterGroupFromDrop` 的 voice 字段做了双命名兼容：新 payload 读 `voice`/`voiceName`/`voiceStorageKey`/`voiceAssetId`，老 payload 读 `characterVoice*`。改声线相关功能时两边都要认。

## 3. 节点工厂与参数优先级（`canvas-agent/src/plugins/minimax-h3/node-factory.ts`）

```typescript
createH3NodeMetadata(stored /* Backend 保存默认 */, metadata /* 调用方显式 */, panes /* 布局快照 */)
```

展开顺序（**后写覆盖前写**）：

```
BASE_H3_NODE_METADATA → nodeLevel(只取 NODE_LEVEL_KEYS) → panes → storedParams → metadata
```

- `NODE_LEVEL_KEYS`（提到节点级、也复制进 segment）：`aspectRatio` `videoSteps` `denoise` `modelName` `minimaxBaseModel` `motionContextEnabled` `motionContextNoiseEnabled` `smartStoryboardCount` `smartStoryboardMode` `smartStoryboardSkill`。
- `storedParams` 里的 `layout` 会被删掉（布局不进节点参数）。
- 初始 segment = `BASE → storedParams → panes → metadata.segments[0]`，再补 `id`（默认 `segment-1`）/`prompt`（缺省取 `metadata.prompt`）/`duration`/`taskMode`（默认 `ref2va`）/`status`。
- `BASE_H3_NODE_METADATA` 里 `sageAttention` 固定为 `"H3专用Sage加速"`，`refImageSize` 默认 `"match"`（与 V10 的 `"max"` 不同）。

**结论性推论（实测验证过）**：新建 H3 节点落盘的是**当前 Backend 已保存默认**的参数值，所以「删掉重建」还原到的是默认快照，不是 BASE 常量。用户抱怨「重建后参数不对」时，先看 Backend 默认（`h3_get_defaults`），而不是去改 BASE。

### 节点级 vs segment 级：两层都要看

- **工厂建出来的节点两层都有**（节点级 16/16，segment 27/27）—— 这部分是正常的。
- **生成时读的是 segment**：`H3Runner.tsx` 的 `compatibleH3Settings(liveSelected, …)` 与 `loraSlots: segment.loraSlots || []` 等都只吃 segment，**没有节点级回退**。
- 所以「节点级有值」不能作为「参数正常」的证据。核对必须两层分开查。
- 导致 segment 层丢失的写入口：`h3_apply_video_plan` 整段覆盖 `segments`。
- **布局 pane 键是浏览器自愈的，不是 MCP 写的**：`minimaxPreviewH`/`minimaxTimelineH`/`minimaxRefLaneH` 由 `H3WorkbenchPrimitives.tsx` 的 `solve()` 在节点渲染时用 ResizeObserver 实测后回写（`ctx.updateMetadata`）。MCP 建的节点初始没有这几个键，**用户在浏览器里打开过才会出现**；`minimaxPromptW` 只在拖过对应手柄/存过布局快照时才有。**不要把这些缺失当成 bug 去"修"**——省略 `createH3NodeMetadata` 的 `panes` 参数与传空 `{}` 深度相等，并不是病因；Backend 默认参数里也根本没有布局字段（`h3-defaults.ts` 注释明确：布局存独立 localStorage `LAYOUT_KEY`，不进 Backend）。

## 4. 深度工程材料索引

下列细节在本文件已下沉，不再展开。需要时直接跳到工程实现层。

| 主题 | 工程实现层文件 |
|---|---|
| ComfyUI 调用链（执行图、`buildNativeNanFengV10Workflow`、参数路由、宽高 field、字幕/水印约束补强 `withNoTextConstraint`） | `canvas-h3-implementation/references/comfyui-call-chain.md` |
| MCP 工具开发（`h3_*` 工具契约、合并 vs 替换语义、`canvas_apply_ops.patch.metadata` 整体替换陷阱、静默跳过条件） | `canvas-h3-implementation/references/mcp-tool-development.md` |
| 工作流导入与渠道路由（`resolveWorkflowForModel` 优先级、`scenarioFromReferenceCount`、field 校验、运行时工作流目录） | `canvas-h3-implementation/references/workflow-import.md` |
| 整体工程口径入口 | `canvas-h3-implementation/SKILL.md` |

工程实现层 6 个 reference 总览与检索：见 `canvas-h3-implementation/SKILL.md`。

### 本文件未展开、但工程实现层有完整记录的常见问题

仅列**索引级提示**，不在此展开：

- **gpt-image-2 多图**：参考顺序即 `image[]` 顺序；`size` 只影响宽高比、服务端不保证逐像素返回所请求数字；HTTP 405 的成因是 `/v1` 被拼了两次（详见 comfyui-call-chain.md）。
- **尾帧接续（`tailFrameContinuation`）**：只有浏览器侧能触发（`H3ClipCard.tsx` UI 按钮 + `captureVideoTailFrameDataUrl` 仅浏览器环境）；MCP 跑不了。完整链路与 MCP 替代路径见 comfyui-call-chain.md。
- **多段项目的正确组织**（「一次写齐 → 逐段只跑」）：`h3_apply_video_plan` 整段覆盖 `segments`、`h3_run_clip` 不碰 segments 结构、`replaceSegments: false` 残留导致下标错位、`canvas_run_generation` 两个静默跳过条件（顶层 `metadata.model` 缺失 + `referenceNodeIds` 没真连线）。详见 mcp-tool-development.md。
- **画质类问题取证**（ComfyUI `/history` 清洗控制字符、`任务时间戳`、`越跑越慢` 根因 = 每段完整重载文本编码器、量化指标 `FIND_EDGES`/`L*`/`b*` 等）：详见 comfyui-call-chain.md。
- **节点参数优先级（实测）**：显式参数 > Clip/segment > 节点级 > Backend 保存默认 > BASE；以及"删掉节点重建"还原到的是 Backend 当前已保存默认而非 BASE 常量。

## 5. 写作任务参考

SOP 写作任务（编写提示词、设计分镜、审核镜头）的入口不在本文件，请直接使用各 subskill：

| 任务 | subskill |
|---|---|
| 分镜关键帧（关键帧生成、gpt-image-2 档位、宫格→切分→洗图） | `subskills/canvas-video-storyboard-frames/SKILL.md` + `references/shot-asset-pipeline.md` |
| 镜头设计（文字分镜表、对话正反打、参考计划） | `subskills/canvas-video-shot-design/SKILL.md` + `references/storyboard-design.md` |
| 站位与色卡（站位图、色卡制作产线、跨段影调对齐） | `subskills/canvas-video-staging-color/SKILL.md` + `references/tone-consistency-and-continuity.md` |
| Clip 视频（H3 segment 操作门禁、参考与节点提交闸门、历史节点恢复） | `subskills/canvas-video-clip-production/SKILL.md` + 末尾 reference 链接 |
| 剧情设计 → Clip 视频的一致性事前防范 | `subskills/canvas-video-story-design/SKILL.md` + `references/prevention-by-construction.md` |

---

入口到此为止。具体执行细节、调试配方、字段表、报错文案，请到 `canvas-h3-implementation/references/` 查。