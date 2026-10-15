# 编译器 × BCF 对接 — 待办清单

> 最后更新：2025-10-15（BCF 铁律 7 修复 + retention_analysis 英文归一化完成后记录）

## ✅ 已完成

### subject_definitions · 铁律 7（角色定义去描写）
- **位置** `scripts/acheng/canvas_subject_prompt_v2.py` 第 ~734–739 行
- character subject 且有参考图绑定时，definition 不再嵌入 registry 里的 `prompt_description` / `appearance` / `description`
- 改为图片权威声明：`name + "; appearance follows the reference images exclusively — no textual appearance descriptor overrides them."`
- 无图的 character 及 scene / asset / audio subject 保留原有描述（非角色不受铁律 7 管辖）
- 测试：`canvas_subject_prompt_v2.test.py::test_clip_compiles_...` 新增断言锁住行为 ✓

### retention_analysis · 中文占位文案 → 英文（治标）
- **已知遗留值翻译表**在 `_shot_prompt_v2` 调用前的循环里硬编码（第 ~730 行附近），处理已入库的旧绑定数据
- 映射：跟随共享主体节点当前图片 → `"character identity and costume as defined by the reference image"` 等

### 写入源头 · 中文字符串清零（治本）
| 文件 | 改动 |
|---|---|
| `backend/src/drama/shared-subject-picture.ts` L37-38 | retain/exclude → 按 kind 分场景与角色两套英文默认值 |
| `web/src/pages/drama/director-panel.tsx` L126 | `add()` handler retain→`"character identity and costume"` / exclude→`["camera pose","unrelated background"]` |
| `web/src/pages/drama/director-panel.tsx` L134 | `addCharacterImage()` retain→`"character identity as defined by the reference image"` |
| `web/src/pages/drama/director-panel.tsx` L1580 | episode 资产切换分支 retain/exclude → 英文并按 kind 分流 |

新产生的绑定直接写英文；旧的走编译时的翻译表兜底。

---

## ⬜ 待做 · 高优先级

### ① `[Shot N] …, CUT TO:` 切点字面（铁律 9 防融合第一道防线）
- **改哪里** `_shot_prompt_v2` 第 1039–1040 行 else 分支：
  ```python
  # before
  header = "[Shot " + str(shot_number) + "] At " + start_time + ", covering ... within this Clip."
  # after
  header = "[Shot " + str(shot_number) + "] At " + start_time + ", CUT TO: " + start_time + "–" + end_time + " within this Clip."
  ```
- **风险** H3 模型是否真的读到 `CUT TO:` 就不做淡入淡出？需要实测验证再确认是否有效。如果无效就只剩文字声明价值——仍然值得加（结构正确性 + 后续扩展钩子）。
- **不要同时做的事** 别把 Shot 1 的首镜也改成 `CUT FROM:`——那是另一个问题（Clip 起点从哪里切入），目前不需要。

### ② editorial_reason 从元数据字段提升为独立句
- **现状** 被 `_camera_prompt_lines()` 吞进 Angle/Lens/Movement/Path/Target/Focus 那批标签里一起输出，模型读到的权重低
- **要做的** 把 `Editorial reason for this shot and cut: {text}` 单独提成一行，紧跟在 `CUT TO:` header 之后、`Framing:` 之前
- **改法提示** `_shot_prompt_v2` line 1079-1081 那段本来就是在 parts 列表末尾 append，调整插入顺序即可
- 和 CUT TO 放一起后效果类似：`[Shot 2] At 00:04.000, CUT TO: Editorial reason: 濒死呢喃…… Framing: BSCU. Angle: 正面平视……`

### ③ 状态等式句自动生成（镜末态 = 下镜起态）
- **现有输入** `_state_start_descriptions(source, continuity, shot, subjects)` 生成的是「这个 shot 开场时各角色的状态事实」，不是跨镜头切点的等价关系
- **需要什么** 在 `_shot_prompt_v2` 开头（或 clip 级别的前奏段落）读取上一镜的 end-state facts 和本镜的 start-state facts，输出一句：
  > 「The ending frame of [Shot 1] equals the opening state of [Shot 2]: 沈砚剑尖顿停、目光落在窟窿处；红绡嘴唇乌青发抖。」
- **数据链路改造** 需要上游提供每个 shot 的 `end_state_snapshots`（现在只有 `start_frame` / `end_frame` 时间戳，没有逐帧状态快照）——这是数据结构问题，不只是模板拼接
- **建议先做轻量版**：用现存的 continuity fact 差异集（`changes_at_cut`），在每对相邻 shot 边界注入一句简短的状态对位声明，不等上游大改

### ④ 三段前奏（风格总纲 / 持续元素段 / 结构约束块）
- 最重的活：需要 UI 侧添加编辑器字段收集这些信息，或者从 `segment.style` + `summary` 推导出一个通用版本
- 最低成本方案：在 `compile_prompt_v2` 里检查有没有 `style_tone` / `persistent_elements` / `structural_constraints` 三个可选源稿字段，有就拼进去，没有就给个通用骨架：
  ```
  The entire film runs on hard cuts only — no dissolves, fades, wipes, or morphs.
  Adjacent Shots use different camera angles and frams to prevent blending.
  ```
- 推荐先做最低成本版（结构约束块只写两句禁令），风格总纲和持续元素留给用户手动补充或在后续迭代里让 LLM 辅助提取

---

## ⬜ 可延期

- 密度检测脚本（铁律 3 八拍每秒）——文戏不需要，纯武戏才跑，跟剪辑轴有关，不是固定需求
- 漫画效果线禁词自查（铁律 13）——纯校验，不改内容，可以写个 validator 但不阻塞编译
- 表情克制默认声明（铁律 14）——每稿默认加一句 `natural restrained facial expressions; cloth and hair simulation driven by actual environment`，但需要先判断这是动作片还是静默反应戏再加
