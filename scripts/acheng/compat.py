"""Local Canvas compatibility overlay. Never edit the clean upstream checkout."""
from pathlib import Path
import re
import sys

PATCH_VERSION = "canvas-1"


def replace(path, before, after):
    text = path.read_text(encoding="utf-8")
    if after in text:
        return
    if text.count(before) != 1:
        raise RuntimeError(f"Unsupported upstream contract in {path.name}: {before[:70]}")
    path.write_text(text.replace(before, after), encoding="utf-8")


def apply(root):
    root = Path(root)
    contract = root / "scripts/h3_contract.py"
    replace(contract, "REF2VA_MIN_WORDS = 2000", "REF2VA_MIN_WORDS = 2200")
    replace(contract, 'maximum = int(policy.get("ref2va_max_words", REF2VA_MAX_WORDS))',
            'maximum = int(policy.get("ref2va_max_words", REF2VA_MAX_WORDS))\n    need(maximum == REF2VA_MAX_WORDS, "Canvas Ref2VA ceiling must be 2900")')
    final = root / "scripts/h3_final_format.py"
    replace(final, "floor = max(2000, ceil(duration * 200))",
            'from h3_contract import detail_policy\n        floor = detail_policy({"shots": []}, {"generation_clip_duration": duration})["minimum_words"]')
    replace(final, '        _need(legacy or minimum >= floor, f"Ref2VA manifest minimum must be at least {floor}")',
            '        _need(legacy or floor <= minimum <= 2900, f"Ref2VA manifest minimum must be between {floor} and 2900")\n        _need(legacy or english_word_count(_section(text, "detailed_description")) <= 2900, "Ref2VA detailed_description exceeds 2900 English words")')
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
    (root / "CANVAS-COMPATIBILITY.md").write_text(
        "# Canvas compatibility overlay\n\n"
        "Upstream is retained in the clean Git checkout. Local overlay: " + PATCH_VERSION + ".\n"
        "Canvas production uses the project canvas-video-production-sop adapter. "
        "Its authorized generation/storage integration overrides prompt-only delivery in that context. "
        "H3 uses <Picture N>/<Subject N>; style references occupy the final asset slot. "
        "New Ref2VA output uses 2200–2900 English words with a shared capped duration policy. "
        "Historical legacy_fixture is for shipped examples only.\n", encoding="utf-8")


if __name__ == "__main__":
    apply(sys.argv[1])
