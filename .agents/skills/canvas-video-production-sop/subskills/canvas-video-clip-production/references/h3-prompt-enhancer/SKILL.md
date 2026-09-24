---
name: h3-prompt-enhancer
slug: h3-prompt-enhancer
displayName: "H3 提示词增强器"
description: "将简短的 H3 视频提示词或创作意图，结合参考素材与官方 MiniMax H3 提示词写作规范，重写为可直接用于生成的生产级官方结构提示词。支持 ref2va / i2va / fl2va / t2va 四种模式，含可选的分镜姿势过渡分析。"
description_zh: "将简短的 H3 视频提示词或创作意图，结合参考素材与官方 MiniMax H3 提示词写作规范，重写为生产级官方结构提示词（ref2va/i2va/fl2va/t2va）。"
version: 1.0.0
category: prompt-engineering
platforms:
  - windows
  - macos
  - linux
tags:
  - minimax-h3
  - video-prompt
  - prompt-enhancer
  - storyboard
  - prompt-engineering
requires_api_key: false
agent_created: true
---

# H3 提示词增强器（h3-prompt-enhancer v1.0.0）

> 把"一句话意图 / 粗糙提示词 + 参考素材"重写成符合 MiniMax H3 官方格式、可直接喂给生成器的生产级提示词。
> 本 skill 是 Infinite-Canvas-MCP 项目中 H3 节点「增强提示词」按钮（`H3PromptSection.tsx` 的 `enhancePrompt`）的能力抽取版，剥离了 UI / SDK 状态机耦合，保留全部提示词工程知识。

---

## 何时使用

- 用户给出一段 H3 视频的**简短提示词或创作意图**，希望重写成符合官方结构的生产级提示词。
- 用户有**参考素材**（图片 / 视频 / 音频），希望提示词正确引用它们（`<Picture N>` / `<Video N>` / `<Audio N>` / `<Subject N>`）。
- 用户需要 **ref2va / i2va / fl2va / t2va** 任一种模式的官方格式。
- 用户有多张**分镜关键帧**，希望把它们排成连续姿势帧序列再增强。

---

## 输入约定（向用户索取，缺失则用合理默认）

1. **原始提示词或创作意图文本**（必需）。
2. **模式**：`ref2va`（多参参考）/ `i2va`（图生视频）/ `fl2va`（首尾帧）/ `t2va`（文生视频）。默认 `ref2va`。
3. **片段时长**（秒），默认 `5`。
4. **可选参考素材清单**：每条素材给出
   - 类型：`image` / `video` / `audio`
   - 名称
   - 角色 `role`（如 `character_identity` / `scene` / `storyboard` / `prop` / `style` / `other`）
   - 关联主体 `subjectId`（若是角色身份/定妆图）
   - 是否 `storyboard` 分镜帧及其顺序（如 图1=起始姿势、图2=目标姿势）
5. **可选全局提示词** `globalPrompt`。
6. **可选分镜过渡模式**：仅当素材含 ≥2 张 storyboard 分镜图时启用（把分镜图排成连续姿势帧序列）。

---

## 执行流程（核心算法，对应原 `enhancePrompt`）

### 步骤 0 — 选并读取官方参考（权威来源）

| 模式 | 读取资产 | 结构 |
|------|----------|------|
| `ref2va` | `references/ref-en.txt` | 六段：subject_definitions / summary / retention_analysis / detailed_description / overall_soundscape / non_diegetic_music |
| `i2va` / `fl2va` / `t2va` | `references/base-en.txt` | 三段：integrated_multimodal_description / overall_soundscape / non_diegetic_music |

把所选 `.txt` **全文**作为 system prompt 的「官方权威参考」段落注入（它是格式权威，不可偏离）。

### 步骤 1 — 构建参考清单 manifest

按**类型分别编号**：`image → Picture 1..N`，`video → Video 1..N`，`audio → Audio 1..N`。

每行格式：

```text
<类型> <序号>: <名称>; role: <role>; [storyboard characters: <角色名列表>]; [; maps to <Subject N> (cite this Picture in that definition)]
```

- **角色映射**：若该素材是角色身份/定妆图（`role` 含 `character_` 或属于某 character group），分配一个 `Subject` 序号，并在行尾注明 `; maps to <Subject N>`。
- **这是格式权威**：`Subject` 序号**独立于** `Picture` 序号，绝不可按 preceding Pictures 数来给 Subject 编号。

### 步骤 2 — 模式结构与对齐规则

- **ref2va**：六段结构（见上）；参考素材只作身份/外观/场景/道具/风格/动作参考，**不锁定任何图片为 0.00 秒首帧**，不得轮播/拼贴/从参考图原始构图起步。
- **i2va**：三段；首句对齐 `Picture 1` 到 `0.00` 秒，动作从首帧状态向后连续发展。
- **fl2va**：三段；首句对齐 `Picture 1 → 0.00 秒`、`Picture 2 → 结束时刻`；必须描述从首帧到尾帧的连续路径。
- **t2va**：三段；**不得写任何** `Picture` / `Video` / `Audio` 引用或对齐句。

### 步骤 3（可选）— 分镜姿势过渡分析

当且仅当素材含 **≥2 张 storyboard 分镜图** 且用户**未显式 hard cut** 时启用：

1. 按 storyboard 顺序，逐对 `(图k → 图k+1)` 用视觉分析模型提取连续过渡动作（肢体如何运动、重心如何转移、身体朝向/视线/姿态如何变化），拼成「过渡计划」。
   - 提示词示例：`下面是连续分镜姿势序列中的两张 storyboard 分镜帧：图${k}（起始姿势）与图${k+1}（目标姿势）。只提取从图${k}到图${k+1}的连续过渡动作：主体肢体如何运动、重心如何转移、身体朝向/视线/姿态如何变化，用若干可执行的自然语言短句描述（不重复身份、服装、外观，只写动作与姿态变化）。只返回过渡动作正文。`
   - system：`你是 H3 分镜姿势过渡分析器。严格按图序对比两张关键帧，只输出从前者到后者的连续动作描述，不编造图中未出现的变化。`
2. 拼 `transitionInstruction`：
   - 只有标记为 `storyboard` 的参考图才是本段分镜帧序列（图1=起始姿势，图N=目标姿势）；角色转面图、身份图、风格图不是过渡帧。
   - 从图1的姿势出发，依次经过每一对相邻分镜帧（图k→图k+1）的连续动作，最终收尾于图N的姿势；不得瞬移或重置。
   - 末句必须明确落到图N的目标姿势（如「此人缓缓蹲下成蹲姿」）。
   - 若未生成过渡计划，则只依据各镜自己的分镜图与正文描述。

> 若用户**已显式 hard cut**（prompt 中出现 `hard cut` / `the shot cuts to` / `[Transition: cut]` / `硬切`），则**严格保留该切镜边界**，不要改写成跨镜连续运动，跳过过渡分析。

### 步骤 4 — 拼 system prompt（按顺序拼接下列部分）

1. `You are the official MiniMax H3 video prompt writer.`
2. `Follow the embedded official H3 prompt-writing reference exactly; it is the format authority.`
3. `Subject numbers are independent of Picture numbers. Character mappings in the reference manifest are authoritative: use each mapped <Subject N> exactly and cite its source <Picture N> in subject_definitions. Never number a Subject by counting preceding Pictures.`
4. **[官方参考全文]**（步骤 0 读入的 txt）
5. `The selected mode is <MODE> and the selected clip duration is <X.XX> seconds.`
6. **[结构规则]**（步骤 2 的结构段）
7. **[对齐规则]**（步骤 2 的对齐段）
8. `Rewrite the user intent into one production-ready prompt. Preserve characters, actions, dialogue, visible text, reference numbering, and hard constraints; never invent facts.`
9. `Make every requested visual detail explicit: composition, subject appearance, pose, gaze, action phases, camera type/amplitude/speed, lighting, materials, continuity, environment, and sound.`
10. `Use the exact official field names, section order, reference tags, timestamp conventions, dialogue tags, and language rules. Preserve each <Subject N>, <Picture N>, <Video N>, and <Audio N> tag exactly; do not renumber them.`
11. `Assign a stable speaker id (S1, S2, …) to every subject who speaks or delivers dialogue in detailed_description, in order of first appearance; write it immediately after the subject reference, e.g. '<Subject 1> (S1) says:'. Every spoken line must carry its speaker id — never drop it.`
12. `Keep exact user dialogue and visible text unchanged. Do not repeat dialogue in overall_soundscape or non_diegetic_music.`
13. `Return only the final prompt, without Markdown fences, explanations, or prefaces.`
14. **[若有 transitionInstruction]** 追加：`Storyboard image reference transition instruction:\n<transitionInstruction>`

### 步骤 5 — 拼 user prompt

依次拼接（空项跳过）：

1. 用户原始提示词（trim）
2. 全局提示词 `globalPrompt`（trim）
3. `Reference manifest (fixed numbering; do not reorder):\n<manifest>`（步骤 1 产出）
4. `[若有过渡计划]` `Transition plan (fixed image order; do not reorder):\n<transitionPlan>`（步骤 3 产出）

### 步骤 6 — 调用生成

用你的**文本生成能力**，参数：`system = 步骤4`，`user = 步骤5`，`references = 素材`（如有可访问 URL）。

- 若模型返回**空** → 提示「模型未返回内容，增强被跳过（请检查文本模型配置或重试）」，**保留原文**，不覆写。
- 若**失败** → 返回错误原因，保留原文。

### 步骤 7 — 输出

直接给出增强后的提示词（生产级官方结构）。可附一句说明引用了哪些素材 / 哪种模式。最终提示词正文**不要用 Markdown 代码块包裹**（与官方格式一致），解释性文字可放在外层。

---

## 关键约束（务必遵守，否则生成器会拒收/错乱）

- `Subject` 序号 ≠ `Picture` 序号；角色映射以 manifest 为准。
- 保留用户已有的 **hard cut / 切镜边界**；不要改写成跨镜连续运动。
- 不得瞬移、越轴、左右互换、重置动作或跳过动作。
- 严格保留 `<Subject N>` / `<Picture N>` / `<Video N>` / `<Audio N>` 标签与编号，**不重编号**。
- 每段对话 / 可见文字**一字不改**；speaker id 必须紧跟在主体引用之后。
- 只返回最终提示词，不要解释 / 前言 / 代码块。

---

## 资产（自包含副本）

- `references/base-en.txt` — MiniMax H3 **Video Prompt Writing Guide**（T2VA / I2VA / FL2VA / L2VA 基础结构，对应 i2va/fl2va/t2va）
- `references/ref-en.txt` — **Full-Reference Mode Rewrite Output Format Guide**（ref2va 六段结构）

> **来源**：Infinite-Canvas-MCP 项目 `plugins/canvas/minimax-h3/src/storyboard-assets/references/`。
> 当原项目更新这两份官方参考时，请同步更新本 skill 的 `references/` 副本，否则增强结果会与最新生成器格式脱节。

---

## 与原 H3 节点实现的差异（供维护者参考）

| 维度 | 原 H3 节点 `enhancePrompt` | 本 skill |
|------|---------------------------|----------|
| 触发 | React 按钮 | WorkBuddy 对话中加载后按本指令执行 |
| 状态 | `ctx.view.h3PromptJobs` + `ctx.textSuggestions` 落库/采纳/回滚 | 直接产出文本，采纳由用户复制 |
| 素材来源 | `refsForSegment(segment)` 从节点 metadata 取 | 用户显式提供 manifest |
| AI 调用 | `ctx.ai.generateText`（可配置 minimaxLlmModel） | 当前对话的模型自身 |
| 分镜过渡 | `analyzeStoryboardTransitions` 逐对视觉分析 | 步骤 3，依赖多模态视觉能力 |

提示词工程知识（system prompt 体系、模式分支、manifest 规则、改写指令）两者**完全一致**，本 skill 即其可执行副本。
