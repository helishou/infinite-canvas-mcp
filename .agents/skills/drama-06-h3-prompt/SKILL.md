---
name: 视频提示词
description: 短剧06-提示词。为单镜写 MiniMax H3 视频提示词，并同时给出分镜图提示词。用于导演大师分镜详情「生成提示词」和导演包「写每镜提示词」。
tier: free
stage: 06-prompt
author: AI搅拌手
copyright: "© 2025 AI搅拌手 · 导演大师"
license: proprietary
redistribution: forbidden
---

# 短剧06 · H3 提示词

> **版权声明**：作者 AI搅拌手（导演大师）。本 Skill 为专有内容，未经授权禁止复制、二次分发、转售或用于其他产品。


把已锁定的角色 / 场景 / 分镜写成 **H3 单镜提示词**。创作单位仍是一镜一行：每镜一条 `prompt`（视频）+ 一条 `framePrompt`（分镜图）。不要把多镜合成一段。

`focusShotId` 有值时只写那一镜。

## H3 `prompt`（默认英文）

结构必须如下，字段名英文、顺序固定。单镜只有 Picture 1，钉在 0.00 秒。运镜词必须出现在 `[Shot 1]` 段落里，且与分镜的 `camera` 一致。

对白放进 `<d>[Chinese] …</d>`（或项目对白语言）。分镜 `dialogue` 若是「角色名：原句」，`<d>` 里只放冒号后的原句，不要把角色名读出来。若这一镜有 `beats`，`[Shot 1]` 按这些秒数写，不要另起一套时间。H3 正文里不要出现角色真名，用身份（the young woman / the ferryman）。`framePrompt` 才直呼角色名。

```
How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video.

integrated_multimodal_description:
[Shot 1]
  {构图与主体；环境光线；动作；运镜；对白 <d>[Chinese] …</d>}

overall_soundscape:
  {环境声与动作声，1–4 句}

non_diegetic_music:
  {1–3 句，没有则 N/A}
```

若 `linkPrev` 为 true，这一镜是上一镜同一长镜头的无缝下一段：`[Shot 1]` 必须沿着上一镜结尾的机位、运动和主体继续，不要切镜、不要换机位。成片会把上一段末尾运动钉进这一段开头。

时长必须匹配 `durationSec`。只改本集分镜，不要发明新角色。

每个 shot 的 `referenceCatalog` 已经按参考素材的设定顺序，写明每一条分别是什么。必须全部识别，严格按这份清单的顺序写入提示词，一条都不能丢，不能换序。每条图参考单独占一个 `<Subject N>`，N 与编号相同，并在同一句里写明类别：角色用 character，道具用 prop，场景用 scene，站位图用 standing，其余图用 reference。角色只锁外貌，场景只锁空间，道具只锁这件物件的外形，站位图只锁站位、朝向和画面位置。分镜里提到的物件如果已有同名道具图，必须用那张道具图的编号，不能改挂到场景图或角色图上。视频写成 `<Video N>`，音频写成 `<Audio N>`。清单里没有的编号不要虚构。视频提示词根据这份参考素材、分镜设定和用户要求来写。清单里写了补充说明的，把这句写进对应主体，用来说明这个参考素材，不要因此改编号和类别。没有补充说明就不要编造。

## `framePrompt`

中文。给图像模型出分镜图：主体、站位、动作瞬间、光线、景别中文词。直呼角色名（对应挂上的定妆图）。不要写 H3 字段名、不要写秒数。

## 输出 JSON

```json
{
  "commonPrompt": "<Character 1>: locked look from reference.\n<Scene 1>: ...",
  "shots": [
    {
      "id": "sh_xxx",
      "prompt": "How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video.\n\nintegrated_multimodal_description:\n[Shot 1]\n  ...\n\noverall_soundscape:\n  ...\n\nnon_diegetic_music:\n  N/A",
      "framePrompt": "近景，女主撑伞，灯箱冷白光照脸。",
      "negativePrompt": "",
      "promptStatus": "ready"
    }
  ]
}
```
