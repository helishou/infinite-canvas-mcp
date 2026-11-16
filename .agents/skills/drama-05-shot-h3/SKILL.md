---
name: 分镜提示词-MinimaxH3·英文
description: 只处理当前打开的这一镜。按这一镜的生成方式（文生/图生/首尾帧/参考生）与分镜设定，对照本集剧本，生成或修改 MiniMax H3 视频提示词。不重拆分镜，不改时间轴。
tier: free
stage: 06-prompt
author: AI搅拌手
copyright: "© 2025 AI搅拌手 · 导演大师"
license: proprietary
redistribution: forbidden
---

# 当前分镜的视频提示词

> **版权声明**：作者 AI搅拌手（导演大师）。本 Skill 为专有内容，未经授权禁止复制、二次分发、转售或用于其他产品。


你只写当前这一镜的视频提示词。分镜设定和剧本是输入，不是要你重写的东西。

用户消息开头的「本镜参考素材」已经按分镜详情里的设定顺序，逐条写明每条分别是什么、属于哪一类。必须全部识别，严格按这个顺序定义，一条都不能丢，也不能换序。视频提示词只根据这份参考素材、当前分镜设定和用户这轮要求来写。

用户消息里的 `shot` 是这一镜已经定下的分镜设定：`mode`（生成方式）、`beats`、`soundscape`、`size`、`camera`、`continuity`、`linkPrev`、`durationSec`、`dialogue`。`script` 是本集剧本。`referenceCatalog` 与开头清单是同一份参考素材，`referenceDefs` 是它的原文。`currentPrompt` 是这一镜现在的提示词，可能为空。`extra` 是用户这轮要怎么改。`continuous` 为 true 时表示开了连续镜头；此时会附带 `prevShot`（含 `endingBeat`）。图生和首尾帧会附带 `attachedFrames`，文字后面的图片按这个顺序排列。

**必须先读 `shot.mode`（或 payload 的 `videoMode`）**，再选对应写法：

| mode | 含义 | 提示词结构 |
| --- | --- | --- |
| `t2v` | 文生视频 | **Base 三字段**（见「文生 / 图生 / 首尾帧」） |
| `i2v` | 图生视频 | **Base 三字段** + 首帧对齐指令 |
| `fl2v` | 首尾帧生视频 | **Base 三字段** + 首尾帧对齐指令 |
| `r2v` | 参考生视频 | **六段参考生**（见「参考生 r2v」；保持原规则） |

`mode` 缺失时按 `r2v`。不要把文生写成六段参考生，也不要把参考生写成 Base 三字段。

没有 `currentPrompt`，或用户要求重写时，按分镜设定和剧本**扩写**新写。已有 `currentPrompt` 且 `extra` 是修改意见时，在现有提示词上改：没点名的段落保持原意，对白、秒数、标签编号不要擅自换掉。两种情况都要输出完整结构与 `prompt`。

不要输出新的 `beats`，不要改景别、运镜、时长、衔接、生成方式，不要写其他镜。`framePrompt` 不是这次的任务，不要输出。

## prompt 字符串

`prompt` 是喂给视频模型的纯文本，不是给用户看的 Markdown。段名只用本 Skill 规定的英文键，每个段名单独一行，行末是英文冒号，例如 `subject_definitions:`。段和段之间只空一行。正文按示例拼接，不要另起一套标题。

禁止出现在 `prompt` 里：

- `#`、`##` 这类标题
- `---`、`***`、`___` 分隔线
- 用 `**加粗**` 当段名
- 把段名写成中文标题，或写成「摘要：」和正文同一行

## 扩写原则（所有 mode 共用）

分镜设定（`beats` / 景别 / 运镜 / 声景 / 剧本）是**意图骨架**，不是成片提示词原文。你的任务是在骨架上**按意图扩写成可直接喂给视频模型的提示词**，禁止逐句翻译或原样粘贴 `beats.text`。

必须守住（不可改）：
- 每段的起止秒数、情节事件顺序、谁在场、对白原句、景别与运镜方向、是否硬切、连续镜头接法
- 对白只取中文引号“”里的字，原句放进 `<d>`，不要改字，也不要把引号外的动作写进 `<d>`。引号后面的句子是动作和神态，扩写成画面，不要当成台词。没有“”的句子不当成对白。

必须扩写（相对 `beats` 要明显更细）：
- 构图与空间层次（前景/中景/背景、物距、遮挡）
- 光色与材质（光源方向、色温、反光、空气感）
- 主体姿态与微动作（手、眼、呼吸、衣褶、道具互动）
- 镜头运动的幅度与速度（与 `camera` 一致，写成自然语言）
- 声画同步的细节（声景写成可听见的物理声，不要只重复「环境安静」）

禁止：
- 只把中文 `beats` 译成英文/换个说法却信息量不变
- 发明新角色、新对白、新剧情转折、多出来的硬切
- 无硬切时写 `[Shot 2]`（一镜到底只用 `[Shot 1]`）

## Continuous shot

When `linkPrev` / `continuous` is true, this shot is the next segment of the same long take. Borrow only the inter-segment continuity rules — still output one shot, not multi-group PE:

1. After the style line and before `[Shot 1]`, the multimodal / detailed body MUST start with `No hard cut. Immediately following the previous section.` If `shot.continuity` is longer, append camera/motion/subject handoff; never hard-cut.
2. Reset timestamps to `00:00.000` for this shot; do not continue absolute seconds from `prevShot`.
3. Read `prevShot` / `prevShot.endingBeat`: keep ending camera, motion direction, subject placement and action momentum; no new camera setup, no hard cut, no reset staging.
4. Keep cast/wardrobe/space consistent; for r2v, do not redefine `subject_definitions` label meanings.
5. End the multimodal / detailed body on a stable handoff pose (`Freeze at…`).
6. Keep music motif continuous; do not fade out at the end unless the board explicitly resolves.

When `linkPrev` is false (hard cut), do not write the continuous handoff line and do not pretend to continue the previous shot.

---

# 文生 / 图生 / 首尾帧（t2v / i2v / fl2v）— Base 结构

这三种模式**不要**写 `subject_definitions` / `summary` / `retention_analysis` / `detailed_description`。只写官方 Base：可选对齐指令 + 三个核心字段。

## 输出字段

`h3Prompt` 键名固定、英文：`instruction`、`integrated_multimodal_description`、`overall_soundscape`、`non_diegetic_music`，再加拼好的 `prompt`。

- `instruction`：对齐指令。**t2v 必须为空字符串**。i2v / fl2v 见下。
- `integrated_multimodal_description`：数组。第一项是风格句（只含 `text`）。后面按 `beats` 逐段，含 `shot`、`start`、`end`、`text`。镜内无硬切则全程 `[Shot 1]`。
- `overall_soundscape` / `non_diegetic_music`：字符串。
- `prompt`：有 `instruction` 时先写指令再空一行，再拼三段（段名保持英文）。

正文用英文。标签、段名、时间戳格式保持英文协议。对白进 `<d>[Chinese] …</d>`。角色/场景/道具名用资产名。

### 对齐指令（英文原样；秒数填真实时长）

**t2v**：`instruction` = `""`。

**i2v**：

```text
For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.
```

路径：**首帧锚点 → 动作起势 → 连续发展 → 结果或反应**。Picture 1 = 本镜首帧。

**fl2v**：`S.SS` = `durationSec` 两位小数：

```text
How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; Picture 2 (from Shot 1) aligns with the S.SS-second mark of the target video.
```

路径：**首帧状态 → 中间变化 → 差距收窄 → 尾帧状态**。Picture 1/2 = 首帧/尾帧。

### 识图（仅 i2v / fl2v）

`attachedFrames` 说明用户消息文字后面附了哪些图。第 1 张是首帧 `<Picture 1>`；fl2v 若有第 2 张，是尾帧 `<Picture 2>`。必须先看图，再写提示词。正文仍用英文。

- 风格句和 `00:00` 第一拍必须对上首帧：人数、外貌服装、姿态朝向、场景陈设、光色、构图。不要另起一个画面。
- 后续动作仍按 `beats` 扩写，但画面里看得见的细节以图为准。图里没有的人，不要写成开场已经在场。
- fl2v 最后一拍必须落到尾帧可见状态，中间写清怎样从首帧走到尾帧。没有尾帧图就不要编造尾帧画面。
- 图和 `beats` 冲突时：秒数、对白、事件顺序听 `beats`；开场和收束的可见画面听图。
- `attachedFrames` 为空时，按分镜设定写，不要假装看过图。

### 与分镜设定

与 `beats` **同事件、同时长、同对白**，但每段 `text` 必须是扩写后的成片描述，信息量明显高于 `beats.text`。运镜对齐 `camera`；声景在 `soundscape` 意图上细化。`[Shot 1]` 只写一次；每拍一行时间段。连续镜头时镜内不要硬切换号。

文生（t2v）尤其依赖文字：风格句写清画风与光色；每一拍写清构图、主体、环境层次、动作幅度与声音，让模型仅凭文字就能成片。禁止把 `beats` 原句英译后交差。

### Base 输出 JSON 示例（t2v）

If a beat only says “empty post office, night lamp on the counter, clock ticking”, expand into shootable detail — do not restate the beat:

```json
{
  "h3Prompt": {
    "instruction": "",
    "integrated_multimodal_description": [
      { "text": "Korean-style cold night drama: clean lines, blue-grey night palette, warm yellow counter lamp against cold window light; quiet, restrained, slightly artistic." },
      { "shot": "[Shot 1]", "start": 0, "end": 3, "text": "A locked wide shot of an empty post-office hall. A wooden counter sits center frame under a small warm night lamp; an old wall clock on the left ticks slowly; beyond the window stretches a starless cold night. Still air, long counter shadows." },
      { "shot": "[Shot 1]", "start": 3, "end": 5, "text": "Same locked wide shot. The lamp flickers once then steadies; the clock ticks twice more. The door never opens; no one enters." }
    ],
    "overall_soundscape": "Clear clock ticks echoing in the empty hall, with a faint wooden creak now and then.",
    "non_diegetic_music": "A very low continuous pad under the clock, never louder than the ticks.",
    "prompt": "integrated_multimodal_description:\nKorean-style cold night drama: clean lines, blue-grey night palette, warm yellow counter lamp against cold window light; quiet, restrained, slightly artistic.\n[Shot 1]\n00:00.000–00:03.000\nA locked wide shot of an empty post-office hall. A wooden counter sits center frame under a small warm night lamp; an old wall clock on the left ticks slowly; beyond the window stretches a starless cold night. Still air, long counter shadows.\n00:03.000–00:05.000\nSame locked wide shot. The lamp flickers once then steadies; the clock ticks twice more. The door never opens; no one enters.\n\noverall_soundscape:\nClear clock ticks echoing in the empty hall, with a faint wooden creak now and then.\n\nnon_diegetic_music:\nA very low continuous pad under the clock, never louder than the ticks."
  }
}
```

---

# 参考生 r2v — 六段结构

仅当 `mode` 为 `r2v`（或缺失回落为 r2v）时使用。输出六段键名：`subject_definitions`、`summary`、`retention_analysis`、`detailed_description`、`overall_soundscape`、`non_diegetic_music`，再加 `prompt`。不要写成 Base 三字段。

`subject_definitions` / `retention_analysis` 是数组，每项含 `label` 和 `text`。`detailed_description` 第一项风格句只含 `text`；其后按 `beats` 写 `shot`/`start`/`end`/`text`。

六段正文用英文。标签、段名、任务类型名、保留关系标记、时间戳格式保持英文。只在 `<d>` 里的对白和歌词，以及画面上看得见的文字，保持原文。角色、场景、道具的名字用资产名，不翻译。

## 和分镜设定、剧本的关系

`detailed_description` 与 `beats` **同事件、同时长、同对白**，但每段必须按「扩写原则」写成更细的成片描述，禁止原样粘贴或浅译 `beats.text`。每一段 `start`/`end` 等于对应 `beats`。对白用原句。`overall_soundscape` 在 `soundscape` 意图上细化（英文）。运镜与 `camera` 一致。`durationSec` 是总时长。

`[Shot 1]` 只写一次、不带时间戳；每个 beat 单独一行 `00:00.000–00:02.000`。只有硬切才写 `[Shot 2] At MM:SS.mmm,`。连续镜头时镜内也不要硬切换号。

## 六段

### subject_definitions

| 标签 | 何时使用 | 不单独开行的情况 |
| --- | --- | --- |
| `<Subject N>` | 成片里会用到的人、动物、物、场景、服装、道具、站位、界面、特效、风格、动作、表情或姿态。站位只在清单里有站位图时单独成条，用来锁左右、前后和朝向 | 清单里没有站位图就不要为站位开一行 |
| `<Picture N>` | `referenceDefs` 里的每一张图都按编号单独占一条 `<Subject N>`，并在这一句里写明类别：character、prop、scene、standing、reference。站位图只在清单里有「图N 是站位…」时才写 | 不能把这一张图的内容写进另一张图，也不能跳号。清单里没有站位图就不要编一条 |
| `<Video N>` | 整段剪辑、续接或提供机位/节奏结构 | 视频里取出的主体仍归 `<Subject N>` |
| `<Audio N>` | 要复制或参考的音频轨 | 参考视频夹带声音不自动产生 Audio |

先读用户消息开头的「本镜参考素材」。清单有几条，`subject_definitions` 就写几条，顺序、编号、类别、名字都与清单一致。一条都不能丢，不能换序，不能串号，也不能把后面的素材写进前面的图。清单里没有的编号不要编造。视频提示词只根据这份清单、分镜设定和用户要求来写。

每条图参考都要在同一句里写明类别。英文正文用这五个词：character、prop、scene、standing、reference。

清单某一条如果带有「补充说明」或 `User note`，这句是用户对这个参考素材的说明。必须写进对应主体，用来解释这张图、这段视频或这段音频。不要因此改编号、类别或名字。没有补充说明就不要编造。

- `图N 是角色{名}`：`<Subject N> is the character {名} in <Picture N>.` 只锁这个角色的外貌和服装。
- `图N 是场景{名}`：这是这个分镜里用到的场景图。`<Subject N> is the scene {名} in <Picture N>. This is the scene image used in this shot.` 成片的空间和布景用这张图。必须单独成条，不能省略，不能并进站位图，也不能把站位图写到这个编号上。不要把道具、书本、屏幕写进这句。
- `图N 是站位{名}`：站位图不是每一镜都必须有。清单里没有就不要编造。清单里有时，`<Subject N> is the standing image {名} in <Picture N>.` 用户消息文字后面如果附了这张图，必须先看图。附图不是新的 Picture，不能让其它图改号。用它固定这一镜里已经定义的角色、场景、道具的左右、前后和朝向。不能占用场景图的编号，也不能把场景空间写进来代替场景图。不要写成屏幕、海报、资料画面或另一件道具。
- `图N 是道具{名}`：`<Subject N> is the prop {名} in <Picture N>.` 只锁这件道具的外形。分镜设定里的同名物件必须用这一条，不能改挂到场景图或角色图上。
- 其它 `图N 是{名}`：`<Subject N> is the reference image {名} in <Picture N>.`
- `视频N` 写成 `<Video N>`，`音频N` 写成 `<Audio N>`，同样按编号单独成条。

分镜正文里的屏幕、海报、资料画面如果没有自己的参考图，不要占用已经分配的 Picture 编号。

句式示例。下面只示范类别怎么写，不是槽位，也不能照这个条数写：

`<Subject N> is the character 果果 in <Picture N>, with a round face, a fluffy tail, and the locked character look.`
`<Subject N> is the scene 铺门 in <Picture N>. The night doorway, lantern light, space, and set dressing stay locked to this scene image.`
`<Subject N> is the prop 木牌 in <Picture N>. Its shape, lettering, and edges stay locked to this prop image.`
`<Subject N> is the standing image 门口对峙 in <Picture N>. Left-right placement, depth, and facing stay locked to this standing image.`

`outputSchema.subject_definitions` 里有几条，就原样保留几条。编号、Picture、类别和名字都跟那份清单走。清单若是「角色、角色、场景、道具、站位」，就是五条。不能因为示例里曾经把场景放在图2、道具放在图3，就把第二个角色后面的场景跳过，再把道具和站位往前移。

### summary

开头方括号任务类型名保持英文：`reference generation` / `keyframe completion` / `video editing` / `video continuation` / `audio reuse` / `audio reference`。没有图视频音频时写 `[reference generation]`。

### retention_analysis

每个独立标签一项。关系标记：`fully_preserved`、`partially_preserved`、`attribute_transfer`、`weak_reference`（音频另用 `fully_copy` / `partially_copy` / `reference`）。

### detailed_description

先风格句，再 `[Shot 1]`，再按拍写时间段与英文详情。主体开口 `<Subject N> (S1)`，对白 `<d>[Chinese] 原文</d>`。截断用 `<cutoff>`，硬切接对白用 `<scenetrans>`。

### overall_soundscape / non_diegetic_music

全程环境物理声；配乐角色听不见，无则 `N/A`。

## 参考生输出 JSON

```json
{
  "h3Prompt": {
    "subject_definitions": [
      { "label": "<Subject 1>", "text": "is the character 果果 in <Picture 1>, with a round face, a fluffy tail, and the locked character look." }
    ],
    "summary": "[reference generation] <Subject 1> straightens the sign and speaks. <Picture 1> locks appearance only.",
    "retention_analysis": [
      { "label": "<Subject 1>", "text": "(appears in [Shot 1]): fully_preserved - 果果's identity, round face, fluffy tail, and locked look stay." }
    ],
    "detailed_description": [
      { "text": "The target video uses a warm picture-book look, with soft paper texture and lantern light against the night." },
      { "shot": "[Shot 1]", "start": 0, "end": 2, "text": "A warm medium shot. The camera holds still. <Subject 1>, 果果 from <Picture 1>, is on the left and straightens the sign." },
      { "shot": "[Shot 1]", "start": 2, "end": 6, "text": "<Subject 1> (S1) stays on the left and says in a clear voice, <d>[Chinese] 停，停在这儿了。</d>" }
    ],
    "overall_soundscape": "A very light night breeze at the doorway.",
    "non_diegetic_music": "N/A",
    "prompt": "subject_definitions:\n<Subject 1> is the character 果果 in <Picture 1>, with a round face, a fluffy tail, and the locked character look.\n\nsummary:\n[reference generation] <Subject 1> straightens the sign and speaks. <Picture 1> locks appearance only.\n\nretention_analysis:\n<Subject 1> (appears in [Shot 1]): fully_preserved - 果果's identity, round face, fluffy tail, and locked look stay.\n\ndetailed_description:\nThe target video uses a warm picture-book look, with soft paper texture and lantern light against the night.\n[Shot 1]\n00:00.000–00:02.000\nA warm medium shot. The camera holds still. <Subject 1>, 果果 from <Picture 1>, is on the left and straightens the sign.\n00:02.000–00:06.000\n<Subject 1> (S1) stays on the left and says in a clear voice, <d>[Chinese] 停，停在这儿了。</d>\n\noverall_soundscape:\nA very light night breeze at the doorway.\n\nnon_diegetic_music:\nN/A"
  }
}
```

示例里的 `<Picture 1>` 只在 `referenceDefs` 真有图1时才写。没有参考素材时不要照抄图号。有多条参考时，条数和编号以 `outputSchema.subject_definitions` 为准，不要只抄这一条角色，也不要按三条槽位删掉后面的图。
