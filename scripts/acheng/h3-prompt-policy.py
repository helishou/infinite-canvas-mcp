"""Canvas H3 prompt policy and its reviewed upstream compiler overlay."""
from pathlib import Path
import re


def detail_policy(production, segment):
    """Use complete local facts, rather than duration, to determine prompt length.

    Explicit authored minimum/target values remain usable. The normal 350–500
    word range is guidance, not an acceptance gate or a truncation boundary.
    """
    policy = {}
    for value in (production.get("prompt_detail_policy"), segment.get("prompt_detail_policy")):
        if isinstance(value, dict):
            policy.update(value)
    if policy.get("profile") == "legacy_fixture":
        return {"profile": "legacy_fixture", "minimum_words": 0, "target_words": 0}
    minimum = int(policy.get("ref2va_min_words", 0))
    target = int(policy.get("ref2va_target_words", max(500, minimum)))
    if minimum < 0 or target < minimum:
        raise ValueError("Ref2VA explicit minimum must be nonnegative and target must be at least minimum")
    from h3_contract import _duration_seconds
    return {"profile": policy.get("profile", "concise"), "minimum_words": minimum,
            "target_words": target, "maximum_words": None,
            "recommended_words": [350, 500], "duration_seconds": _duration_seconds(production, segment),
            "complexity_addition": 0,
            "derived_minimum_words": 0, "derived_target_words": 0,
            "minimum_words_per_second": 0, "target_words_per_second": 0}


GUIDANCE = """# H3 精简生产正文

适用于本 Canvas 运行版本的 H3 编写、计划、编译和最终交付。正文按当前请求所需的可执行事实组织，取消自动最低词数和按秒扩写；短镜头的 `detailed_description` 通常为 350–500 个英文词，只作建议。复杂动作、对白或多镜可按需要增加，已有正文不自动截断。用户显式填写的 `ref2va_min_words` / `ref2va_target_words` 仍按其要求检查。

- 每个 Segment 是独立模型请求：当前出场人物的身份与服装、场景永久几何和参考职责各说明一次；同请求后续 Shot 只写新的位置、起始状态和变化。不能依赖上一个请求的隐藏上下文。
- `visual` 只写本镜实际画面与按时间发生的动作；角色/场景档案由编译器带入，避免在 visual、表演、声音和场记中重复整段档案。
- 保留动作触发、接触与后果、相机路径、时间窗、道具归属和收尾状态。只有影响画面与声音的表演事实进入正文；角色完整人生弧、未出场角色、未来剧情及其他镜头的接触不进入本镜。
- 参考职责、保留/排除范围按真实编号写清，正文中的局部参考时间窗继续保留。对白逐字不变，保留说话人、语言、发声时间和必要的口型/收音关系。
- 不输出“请完整重述每个镜头”“必须包含以下要素”等写作指令，不为凑字反复解释棉布、重力、呼吸或无关禁令。确有局部误生成风险时给出一次具体约束。
- 编写时先去重和解决矛盾，再交付完整正文；最终格式门只校验并整理载体，不删改已批准内容。六字段、真实素材、哈希、镜头切点、对白和连续性检查继续执行，缺事实仍返回阻塞/partial。字数短本身不构成失败。

本规则替代本包旧的动态密度要求及来源资料中按词数防漂移的建议。来源资料仅供研究，不作为生产字数门禁。
"""


def apply_prompt_policy(root):
    """Apply only to a new runtime candidate, never an existing verified runtime."""
    root = Path(root)
    (root / "scripts/canvas_h3_prompt_policy.py").write_bytes(Path(__file__).read_bytes())
    (root / "references/115-h3-concise-prompts.md").write_text(GUIDANCE, encoding="utf-8")

    def replace(relative, before, after):
        path = root / relative
        text = path.read_text(encoding="utf-8")
        if text.count(before) != 1:
            raise RuntimeError(f"Unsupported H3 concise overlay in {relative}: {before[:80]}")
        path.write_text(text.replace(before, after), encoding="utf-8")

    path = root / "scripts/h3_contract.py"
    text = path.read_text(encoding="utf-8")
    start, end = text.index("def detail_policy("), text.index("def clip_bounds(")
    text = text[:start] + "from canvas_h3_prompt_policy import detail_policy\n\n\n" + text[end:]
    path.write_text(text, encoding="utf-8")
    replace("scripts/orchestrator_commit.py", "REF2VA_MIN_WORDS = 2000", "REF2VA_MIN_WORDS = 0")
    replace("scripts/orchestrator_commit.py",
            "# This is the safety floor for nodes created by older plans. New plans write a\n# segment-specific h3_min_words value derived from duration and complexity.",
            "# New plans have no automatic word floor; honor an explicitly authored node minimum.")

    path = root / "scripts/audit_storyboard_quality.py"
    text = path.read_text(encoding="utf-8")
    start, end = text.index("def compile_segment("), text.index("def audit(")
    legacy_compiler = text[start:end].replace("def compile_segment(", "def _canvas_legacy_compile_segment(", 1)
    path.write_text(text, encoding="utf-8")
    replace("scripts/audit_storyboard_quality.py", "    body.insert(0, DETAIL_DIRECTIVE)\n", "")
    replace("scripts/audit_storyboard_quality.py", "    for i, s in enumerate(shots, 1):",
            "    seen_characters, seen_scenes = set(), set()\n    for i, s in enumerate(shots, 1):")
    replace("scripts/audit_storyboard_quality.py", """        # Repeat the complete visible context in every shot. A later shot in
        # the same segment must remain intelligible when copied on its own.
        context = [SHOT_DETAIL_DIRECTIVE]
        context.extend(characters[ch["id"]]["prompt_description"] for ch in s["characters"])
        context.append(scenes[s["scene_id"]]["prompt_description"])""", """        # One Segment is one model request. Define identity and permanent
        # geometry once; every shot still carries its own state and action.
        context = []
        for ch in s["characters"]:
            if ch["id"] not in seen_characters:
                context.append(characters[ch["id"]]["prompt_description"])
                seen_characters.add(ch["id"])
        if s["scene_id"] not in seen_scenes:
            context.append(scenes[s["scene_id"]]["prompt_description"])
            seen_scenes.add(s["scene_id"])""")
    replace("scripts/audit_storyboard_quality.py",
            'require(policy["minimum_words"] >= 2000, f"{seg[\'id\']}: Ref2VA minimum detail must be at least 2000 words")',
            'require(policy["minimum_words"] >= 0, f"{seg[\'id\']}: Ref2VA explicit minimum cannot be negative")')
    replace("scripts/audit_storyboard_quality.py",
            '            require(text.count(SHOT_DETAIL_DIRECTIVE) == len(seg["shot_ids"]), f"{seg[\'id\']}: every shot needs the independent-detail directive")\n', "")
    # Shipped legacy examples keep their original bytes and references. New
    # Canvas production cannot use legacy_fixture to bypass the current rules.
    path = root / "scripts/audit_storyboard_quality.py"
    text = path.read_text(encoding="utf-8")
    signature = text[text.index("def compile_segment("):].split("\n", 1)[0]
    text = text.replace(signature, signature + '\n    if detail_policy(p, seg)["profile"] == "legacy_fixture":\n        return _canvas_legacy_compile_segment(p, seg, draft=draft)', 1)
    text = text.replace("def audit(", legacy_compiler + "def audit(", 1)
    path.write_text(text, encoding="utf-8")

    # Rewrite the old instructions at their owning entry points. Original source
    # libraries and their hashes remain unchanged and are superseded explicitly.
    entry = root / "SKILL.md"
    text = entry.read_text(encoding="utf-8")
    text = text.replace("### H3 详细度、当前激活运行版本与模式锁", "### H3 精简正文、当前激活运行版本与模式锁")
    text = re.sub(r"1\. \*\*按当前激活运行版本计算详细度\*\*[^\n]*",
                  "1. **按本镜事实量写正文**：遵守[H3 精简生产正文](references/115-h3-concise-prompts.md)；取消自动词数下限和按秒扩写，短镜头正文通常为 350–500 英文词建议范围。", text)
    text = re.sub(r"4\. \*\*逐镜展开与独立性\*\*[^\n]*",
                  "4. **每段独立、段内去重**：一个 Segment 独立重建当前人物身份、场景和参考职责一次，各 Shot 写自己的位置、光线、起始状态、动作因果、镜头、声音及尾态。", text)
    text = text.replace("不得用摘要、压缩版或降低详细度来适应上限。", "编写时先去除重复和本镜无关说明，仍未完成时继续写剩余事实，不截断已批准正文。")
    entry.write_text(text, encoding="utf-8")

    model = root / "modules/model/SKILL.md"
    text = model.read_text(encoding="utf-8")
    paragraphs = text.split("\n\n")
    for index, paragraph in enumerate(paragraphs):
        if paragraph.startswith("图片使用72号独立交付合同；H3必须读"):
            paragraphs[index] = "图片使用72号独立交付合同；H3 按[精简生产正文](../../references/115-h3-concise-prompts.md)编写，并执行[最终格式门](../../references/111-h3-final-format-pass-v4.md)。每段独立带入本镜事实，段内身份与场景只定义一次；不输出写作指令，不为字数扩写。保留真实编号参考、逐字台词、局部时间窗、摄影/动作因果和连续尾态。"
        elif paragraph.startswith("每个 Segment 必须显式写"):
            paragraphs[index] = "每个 Segment 必须显式写 `mode`、`mode_lock` 和 `mode_selection_reason`；续写时未经用户授权不得切换模式。按精简正文合同保留可执行事实，H3-only 请求不自动启动 STYLE_MOTHER 或资产节点；确有未完成内容时按字段保存 partial 和游标。"
    model.write_text("\n\n".join(paragraphs), encoding="utf-8")

    compiler = root / "references/70-minimax-h3-compiler.md"
    text = compiler.read_text(encoding="utf-8")
    text, count = re.subn(r"## Ref2VA 详细度、字数极限值[^\n]*\n.*?(?=\n## )",
                          "## Ref2VA 精简正文与模式锁\n\n遵守[H3 精简生产正文](115-h3-concise-prompts.md)。取消自动字数门槛与按秒扩写，段内共用身份和永久空间只定义一次，各镜保留位置、动作因果、摄影、声音、对白和收尾状态。\n", text, count=1, flags=re.S)
    if count != 1:
        raise RuntimeError("Upstream H3 compiler guidance changed")
    text = text.replace("不得把详细正文按 350–500 词的短模板压缩。", "短镜头通常按 350–500 英文词的建议组织完整事实，长度本身不作验收门槛。")
    compiler.write_text(text, encoding="utf-8")

    for relative in ("references/72-standalone-prompt-delivery.md", "references/90-production-contract.md",
                     "references/110-goal-multi-turn-delivery-v4.md", "references/111-h3-final-format-pass-v4.md",
                     "templates/h3-prompt-package.md"):
        path = root / relative
        text = path.read_text(encoding="utf-8")
        link = "../references/115-h3-concise-prompts.md" if relative.startswith("templates/") else "115-h3-concise-prompts.md"
        concise = f"`detailed_description` 遵守[精简生产正文]({link})，取消自动词数下限和按秒扩写"
        text = re.sub(r"`detailed_description` 按(?:本段)?时长与复杂度动态计算最低词数[^。；\n]*", concise, text)
        text = text.replace("按本段时长与复杂度动态计算的 Ref2VA 密度门（默认 10 秒段最低 2,000、目标约 2,400 个英文词）", f"[Ref2VA 精简正文合同]({link})")
        text = text.replace("长度不足时返回失败或 partial，不能以 `PASS` 掩盖不足。", "字数短不构成失败，缺少可执行事实时返回阻塞或 partial。")
        text = re.sub(r"新任务按时长与复杂度动态计算最低词数[^\n]*?不足只能 partial，不能 accepted。", "取消自动字数门槛，逐项检查当前请求的可执行事实；缺事实只能 partial，不能 accepted。", text)
        text = re.sub(r"  detail: detailed_description 按时长与复杂度[^\n]*", f"  detail: 按精简正文合同编写；本段人物外观与永久空间只定义一次，各镜保留位置、动作因果、摄影、声音和尾态。", text)
        text = text.replace("  short_output: 不得用通用短模板压缩；长度不足只能 partial + current_cursor。", "  short_output: 字数短不构成失败；缺事实时 partial + current_cursor，不截断已批准正文。")
        text = text.replace("每个镜头独立写出外观、空间位置", "每段定义外观与永久空间一次，每个镜头写出空间位置")
        path.write_text(text, encoding="utf-8")
