---
name: 智能出图
description: 按已写好的定妆图提示词调用 GPT Image 2 出图，并写入资产卡片。
tier: month
task: asset
author: AI搅拌手
copyright: "© 2025 AI搅拌手 · 导演大师"
license: proprietary
redistribution: forbidden
---

# GPT Image 2 出图

> **版权声明**：作者 AI搅拌手（导演大师）。本 Skill 为专有内容，未经授权禁止复制、二次分发、转售或用于其他产品。


这不是对话 Skill。客户端会把资产上的 `imagePrompt` 提交给 `/images/generations`（默认模型 `gpt-image-2`），把返回的图写入资产卡。

若提示词为空，先用对应的 image-character / image-scene / image-prop 扩写。
