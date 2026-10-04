"""Local Canvas compatibility overlay. Never edit the clean upstream checkout."""
from pathlib import Path
import re
import sys

PATCH_VERSION = "canvas-4"


def replace(path, before, after):
    text = path.read_text(encoding="utf-8")
    if after and after in text:
        return
    if text.count(before) != 1:
        raise RuntimeError(f"Unsupported upstream contract in {path.name}: {before[:70]}")
    path.write_text(text.replace(before, after), encoding="utf-8")


def apply(root):
    root = Path(root)
    contract = root / "scripts/h3_contract.py"
    replace(contract, "REF2VA_MIN_WORDS = 2000", "REF2VA_MIN_WORDS = 2200")
    # Preserve the existing density floor/default target; the old source field
    # is readable but is no longer a hard limit on output or an explicit target.
    replace(contract, 'maximum = int(policy.get("ref2va_max_words", REF2VA_MAX_WORDS))', 'maximum = REF2VA_MAX_WORDS')
    replace(contract, '    if target > maximum:\n        target = maximum\n', '')
    replace(contract, '    if target < minimum:\n', '    if explicit_target is None and target < minimum:\n        target = minimum + 200\n    if target < minimum:\n')
    replace(contract, '"maximum_words": maximum,', '"maximum_words": None,')
    replace(contract, '''            need(word_count <= policy.get("maximum_words", REF2VA_MAX_WORDS),
                 f"Ref2VA detailed_description is {word_count} words; exceeds maximum ceiling of {policy.get('maximum_words', REF2VA_MAX_WORDS)} words (2900 words limit)")''', '')
    final = root / "scripts/h3_final_format.py"
    replace(final, "floor = max(2000, ceil(duration * 200))",
            'from h3_contract import detail_policy\n        floor = detail_policy({"shots": []}, {"generation_clip_duration": duration})["minimum_words"]')
    # The upstream floor guard remains; no maximum guard is added.
    bridge = Path(__file__).with_name("source-contract.py")
    (root / "scripts/canvas_source_contract.py").write_bytes(bridge.read_bytes())
    import importlib.util
    spec = importlib.util.spec_from_file_location("canvas_source_contract", bridge)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    (root / "canvas-source-contract.json").write_text(__import__("json").dumps(module.contract(), ensure_ascii=False, indent=2), encoding="utf-8")
    hooks = root / "scripts/post_hooks.py"
    replace(hooks, 'card.get("recipe") in ("portrait", "dark", "fantasy", "hard_surface", "ink", "monochrome", "product", "clean_slate", "style")', 'card.get("recipe") in __import__("canvas_source_contract").RECIPES')
    style = root / "scripts/style_anchor.py"
    for field in ("preserve_scope", "exclude_scope"):
        replace(style, f'isinstance(lock.get("{field}"), list) and lock["{field}"] and all(substantive(x) for x in lock["{field}"])', f'__import__("canvas_source_contract").is_scope(lock.get("{field}"))')
    bindings = root / "scripts/reference_bindings.py"
    replace(bindings, '    issues, labels, rows = [], [], []', '    issues, labels, rows = [], [], []\n    from canvas_source_contract import validate\n    if not legacy:\n        issues.extend(item["message"] for item in validate({"segments": [segment]}, "publish") if item["severity"] == "error")')
    # Update the actual entry instructions, not a contradictory appendix alone.
    for path in [root / "SKILL.md", root / "modules/model/SKILL.md", root / "references/62-style-anchor.md"]:
        text = path.read_text(encoding="utf-8")
        text = re.sub(r"@图片([1-9]\d*)", r"<Picture \1>", text)
        text = text.replace("@图片几", "<Picture N>")
        text = text.replace("通常为 Reference image 1 或最后一个槽位", "必须为最后一个槽位")
        text = text.replace("风格母图（`<Picture 1>`）、场景图（`<Picture 2>`）、角色四视图（`<Picture 3>`）、道具图（`<Picture 4>`）", "场景图、角色四视图、道具图及最后槽位的风格母图（编号按实际输入顺序）")
        path.write_text(text, encoding="utf-8")
    entry = root / "SKILL.md"
    text = entry.read_text(encoding="utf-8")
    marker = "你是总导演及生产合同的唯一写入者。"
    if marker not in text:
        raise RuntimeError("Acheng director entry changed; review the Canvas routing hook")
    text = text.replace(marker, "涉及无限画布项目时，先读取项目提供的 `canvas-video-production-sop` 适配入口与 [本机兼容说明](CANVAS-COMPATIBILITY.md)。创作仍由本 Skill 主导；已获用户生成授权时，适配层通过原生画布 MCP 负责实际生成和正式存储。下文纯提示词交付限制不禁止该独立执行层。运行固定引擎版本，不混装另一套同名 H3 规范。\n\n" + marker, 1)
    entry.write_text(text, encoding="utf-8")
    kickoff = Path(__file__).with_name("canvas-kickoff.md").read_text(encoding="utf-8").strip()
    kickoff_heading = kickoff.splitlines()[0]
    text = entry.read_text(encoding="utf-8")
    if kickoff_heading in text:
        if kickoff not in text:
            raise RuntimeError("Canvas kickoff overlay exists with different content; review before replacing")
    else:
        marker = "你是总导演及生产合同的唯一写入者。"
        if text.count(marker) != 1:
            raise RuntimeError("Acheng director entry changed; cannot place the Canvas kickoff overlay")
        start = text.index(marker)
        paragraph_end = text.find("\n\n", start)
        end = paragraph_end if paragraph_end >= 0 else text.find("\n", start)
        if end < 0:
            raise RuntimeError("Acheng director entry has no paragraph boundary for the Canvas kickoff overlay")
        text = text[:end] + "\n\n" + kickoff + text[end:]
        entry.write_text(text, encoding="utf-8")
    for path in [root / "SKILL.md", root / "modules/model/SKILL.md", root / "references/90-production-contract.md", root / "templates/h3-prompt-package.md"]:
        text = path.read_text(encoding="utf-8")
        text = re.sub(r"极限值\s*2900\s*词硬性封顶[^；。\n]*", "正文无硬性词数上限，保留固定运行版本的最低细节要求", text)
        path.write_text(text, encoding="utf-8")
    (root / "CANVAS-COMPATIBILITY.md").write_text(
        "# Canvas compatibility overlay\n\n"
        "Upstream is retained in the clean Git checkout. Local overlay: " + PATCH_VERSION + ".\n"
        "Canvas production uses the project canvas-video-production-sop adapter. "
        "Its authorized generation/storage integration overrides prompt-only delivery in that context. "
        "Video production asks and records the final aspect ratio before creative breakdown; asset ratios stay independent. "
        "H3 uses <Picture N>/<Subject N>; style references occupy the final asset slot. "
        "New Ref2VA output retains its duration/complexity detail floor, without a hard maximum word count. "
        "Historical legacy_fixture is for shipped examples only.\n", encoding="utf-8")


if __name__ == "__main__":
    apply(sys.argv[1])
